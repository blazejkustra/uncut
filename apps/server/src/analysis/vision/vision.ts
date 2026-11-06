// On-device vision (D325): mattes, faces and tracks for a source range of a media file, answered by
// whichever analyzer plugin declares the output and runs on this system (providers.ts), cached by
// content in the analysis cache (visionCache.ts). The editor sees only the contracts' shapes.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type FacesResult,
  type MatteInfo,
  type MatteMode,
  type TrackResult,
  type VisionOutput,
  parseFaces,
  parseMatteInfo,
  parseTrack,
} from "@uncut/contracts";

import { writeAtomic } from "../../project/atomicWrite.ts";
import { Cancelled } from "../analysisRunner.ts";
import { fingerprint } from "../queue/cache.ts";
import { type Platform, type VisionCandidate, pickProvider, platformOf } from "./providers.ts";
import type { StabiliseInput, StabiliseOptions } from "./stabiliseMatte.ts";
import { MATTE_RESULT_VERSION, type VisionRequest, findCovering, readCachedJson, readCachedMatte, visionFiles } from "./visionCache.ts";

export interface VisionCallResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly isError?: boolean;
  readonly structured?: unknown;
}

export interface VisionDeps {
  /** The allowed analyzer plugins, bundled first. */
  readonly candidates: () => Promise<ReadonlyArray<VisionCandidate>>;
  /** Calls a plugin's tool for Uncut itself (the plugin host's callPlugin). */
  readonly call: (
    pluginId: string,
    tool: string,
    args: Record<string, unknown>,
    options: { readonly signal: AbortSignal; readonly onProgress: (progress: number, total: number | undefined) => void },
  ) => Promise<VisionCallResult>;
  /** The ffmpeg binary (undefined: not installed). */
  readonly ffmpeg: () => Promise<string | undefined>;
  readonly platform?: Platform | undefined;
  /** Makes the module's matte steady before it's kept (D332: stabiliseMatte); without it the module's matte is kept as it is. */
  readonly stabilise?: ((input: StabiliseInput, options: StabiliseOptions) => Promise<void>) | undefined;
}

/** A media file of the open project. */
export interface VisionTarget {
  readonly dir: string;
  readonly path: string;
}

export interface VisionOptions {
  readonly signal: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
}

export interface MatteRange {
  readonly start: number;
  readonly end: number;
  readonly mode: MatteMode;
}

export interface TrackRequest {
  readonly at: number;
  readonly end: number;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

interface JsonAsk<T> {
  readonly output: "faces" | "track";
  readonly start: number;
  readonly end: number;
  readonly box?: VisionRequest["box"];
  readonly parse: (raw: unknown) => { readonly value: T } | { readonly problem: string };
  readonly args: Record<string, unknown>;
}

/** The share of a matte's progress the module's run takes when Uncut then makes it steady. */
const MODULE_SHARE = 0.8;

/** A refusal or failure in one sentence (no provider, a bad range, the module's own error). */
export class VisionFailure extends Error {
  readonly reason: "no-provider" | "invalid" | "failed";
  constructor(reason: "no-provider" | "invalid" | "failed", message: string) {
    super(message);
    this.reason = reason;
  }
}

const textOf = (result: VisionCallResult) =>
  result.content
    .map((c) => c.text ?? "")
    .join(" ")
    .trim();

const checkRange = (start: number, end: number) => {
  if (!(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start))
    throw new VisionFailure("invalid", `The range ${start} to ${end} s is empty.`);
};

const readJsonFile = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

const unit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;

export class VisionAnalysis {
  private readonly deps: VisionDeps;

  constructor(deps: VisionDeps) {
    this.deps = deps;
  }

  /** The module that answers `output` here, or a VisionFailure saying there's none. */
  async provider(output: VisionOutput): Promise<VisionCandidate> {
    const picked = pickProvider(await this.deps.candidates(), output, this.deps.platform ?? platformOf());
    if ("refused" in picked) throw new VisionFailure("no-provider", picked.refused);
    return picked.provider;
  }

  /** A grey matte of the range (white = keep): the cached one, or made now. */
  async matte(
    target: VisionTarget,
    range: MatteRange,
    options: VisionOptions,
  ): Promise<{ readonly video: string; readonly info: MatteInfo; readonly cached: boolean }> {
    checkRange(range.start, range.end);
    const provider = await this.provider("matte");
    const fp = await fingerprint(target.path);
    const request = this.request("matte", range.start, range.end, await this.moduleOf(provider, options.signal), { mode: range.mode });
    const files = visionFiles(target.dir, fp, request);
    const cached = await readCachedMatte(files);
    if (cached) return { video: files.video, info: cached, cached: true };
    const covering = await findCovering(target.dir, fp, request, parseMatteInfo);
    if (covering) return { video: covering.files.video, info: covering.value, cached: true };
    const ffmpeg = await this.deps.ffmpeg();
    if (!ffmpeg) throw new VisionFailure("failed", "ffmpeg isn't installed, and Uncut needs it to write the matte (brew install ffmpeg).");
    const part = await this.partFor(files.video);
    const steady = await this.partFor(files.video);
    const stabilise = this.deps.stabilise;
    const share = stabilise ? MODULE_SHARE : 1;
    let made = false;
    try {
      const answer = (await this.callTool(
        provider,
        "matte",
        { media: target.path, start: range.start, end: range.end, mode: range.mode, out: part, ffmpeg },
        { ...options, onProgress: (f) => options.onProgress?.(share * f) },
      )) as Record<string, unknown> | undefined;
      const { width, height, fps, frames, times } = answer ?? {};
      const parsed = parseMatteInfo({
        format: "uncut.matte/1",
        mode: range.mode,
        start: range.start,
        end: range.end,
        fps,
        width,
        height,
        frames,
        times,
        module: request.module,
      });
      if ("problem" in parsed) throw new VisionFailure("failed", `${provider.name} answered a matte Uncut can't use: ${parsed.problem}`);
      if (stabilise) await this.makeSteady(stabilise, { ffmpeg, source: target.path, matte: part, out: steady, info: parsed.value }, options);
      await this.stillSame(target.path, fp);
      await rename(stabilise ? steady : part, files.video);
      await writeAtomic(files.json, `${JSON.stringify({ ...parsed.value, result: MATTE_RESULT_VERSION })}\n`);
      made = true;
      return { video: files.video, info: parsed.value, cached: false };
    } finally {
      await this.dropPart(steady, made);
      await this.dropPart(part, made);
    }
  }

  private async makeSteady(stabilise: NonNullable<VisionDeps["stabilise"]>, input: StabiliseInput, { signal, onProgress }: VisionOptions) {
    try {
      await stabilise(input, { signal, onProgress: (f) => onProgress?.(MODULE_SHARE + (1 - MODULE_SHARE) * f) });
    } catch (error) {
      if (signal.aborted) throw new Cancelled();
      throw new VisionFailure("failed", `Uncut couldn't make the matte steady: ${(error as Error).message}`);
    }
  }

  /** Face boxes per frame of the range, with ids that stay with a face. */
  async faces(
    target: VisionTarget,
    range: { readonly start: number; readonly end: number },
    options: VisionOptions,
  ): Promise<{ readonly result: FacesResult; readonly cached: boolean; readonly file: string }> {
    checkRange(range.start, range.end);
    return this.json(target, { output: "faces", start: range.start, end: range.end, parse: parseFaces, args: { media: target.path, ...range } }, options);
  }

  /** One object followed from `box` at `at` until the range ends or it's lost. */
  async track(
    target: VisionTarget,
    request: TrackRequest,
    options: VisionOptions,
  ): Promise<{ readonly result: TrackResult; readonly cached: boolean; readonly file: string }> {
    checkRange(request.at, request.end);
    const { x, y, w, h } = request.box;
    if (!(unit(x) && unit(y) && w > 0 && h > 0 && x + w <= 1.000001 && y + h <= 1.000001))
      throw new VisionFailure("invalid", "The box must be inside the picture: x, y, w and h from 0 to 1, from the top left.");
    const args = { media: target.path, at: request.at, end: request.end, box: request.box };
    return this.json(target, { output: "track", start: request.at, end: request.end, box: request.box, parse: parseTrack, args }, options);
  }

  private request(
    output: VisionOutput,
    start: number,
    end: number,
    module: VisionRequest["module"],
    extra: Pick<VisionRequest, "mode" | "box">,
  ): VisionRequest {
    return { output, start, end, ...extra, module };
  }

  /** The module's id and version; a module that reports its own runtime's version (the `version` tool) has it added, so a new helper redoes old results. */
  private async moduleOf(provider: VisionCandidate, signal: AbortSignal): Promise<VisionRequest["module"]> {
    const answer = await this.deps.call(provider.id, "version", {}, { signal, onProgress: () => {} });
    if (signal.aborted) throw new Cancelled();
    const helper = (answer.structured as { helper?: unknown } | undefined)?.helper;
    return { id: provider.id, version: !answer.isError && typeof helper === "string" && helper ? `${provider.version}+${helper}` : provider.version };
  }

  /** A fresh .part path beside `file`, its folder made. */
  private async partFor(file: string) {
    await mkdir(dirname(file), { recursive: true });
    return `${file}.${randomBytes(4).toString("hex")}.part`;
  }

  /** Removes the .part, and on a failure the vision and fingerprint folders too when that left them empty. */
  private async dropPart(part: string, made: boolean) {
    await rm(part, { force: true });
    if (made) return;
    const folder = dirname(part);
    await rmdir(folder).catch(() => {});
    await rmdir(dirname(folder)).catch(() => {});
  }

  private async json<T>(
    target: VisionTarget,
    ask: JsonAsk<T>,
    options: VisionOptions,
  ): Promise<{ readonly result: T; readonly cached: boolean; readonly file: string }> {
    const { output, start, end, box, parse, args } = ask;
    const provider = await this.provider(output);
    const fp = await fingerprint(target.path);
    const request = this.request(output, start, end, await this.moduleOf(provider, options.signal), { box });
    const files = visionFiles(target.dir, fp, request);
    const cached = await readCachedJson(files.json, parse);
    if (cached) return { result: cached, cached: true, file: files.json };
    if (output === "faces") {
      const covering = await findCovering(target.dir, fp, request, parse);
      if (covering) return { result: covering.value, cached: true, file: covering.files.json };
    }
    const part = await this.partFor(files.json);
    let made = false;
    try {
      await this.callTool(provider, output, { ...args, out: part }, options);
      const parsed = parse(await readJsonFile(part));
      if ("problem" in parsed) throw new VisionFailure("failed", `${provider.name} answered ${output} Uncut can't use: ${parsed.problem}`);
      await this.stillSame(target.path, fp);
      await writeAtomic(files.json, `${JSON.stringify({ ...parsed.value, module: request.module })}\n`);
      made = true;
      return { result: parsed.value, cached: false, file: files.json };
    } finally {
      await this.dropPart(part, made);
    }
  }

  private async callTool(
    provider: VisionCandidate,
    tool: VisionOutput,
    args: Record<string, unknown>,
    { signal, onProgress }: VisionOptions,
  ): Promise<unknown> {
    if (signal.aborted) throw new Cancelled();
    const result = await this.deps.call(provider.id, tool, args, {
      signal,
      onProgress: (progress, total) => onProgress?.(Math.min(1, Math.max(0, progress / (total || 100)))),
    });
    if (signal.aborted) throw new Cancelled();
    if (result.isError) throw new VisionFailure("failed", textOf(result) || `${provider.name} couldn't do it.`);
    return result.structured;
  }

  private async stillSame(path: string, fp: string) {
    if ((await fingerprint(path).catch(() => undefined)) !== fp) throw new VisionFailure("failed", `${path} changed while it was analysed. Ask again.`);
  }
}
