// Vision results in the analysis cache (D66, D325): <project>/.cache/analysis/<fingerprint>/vision/,
// one file per request, named by a key of the content, the request and the module that answers it.
// A matte is <kind>-<key>.mkv with its info (<kind>-<key>.json) written last, so a matte without
// its info doesn't count.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { type MatteInfo, type MatteMode, type VisionOutput, parseMatteInfo } from "@uncut/contracts";

import { analysisDir } from "../queue/cache.ts";

/** Bumped when the cache's layout or a result's meaning changes, so older files are redone. */
export const VISION_CACHE_VERSION = 1;

export const visionDir = (projectDir: string, fp: string) => join(analysisDir(projectDir), fp, "vision");

export interface VisionRequest {
  readonly output: VisionOutput;
  readonly start: number;
  readonly end: number;
  readonly mode?: MatteMode | undefined;
  readonly box?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined;
  readonly module: { readonly id: string; readonly version: string };
}

const micro = (v: number) => Math.round(v * 1e6) / 1e6;

/** The request's cache key: content, output, range (to the microsecond), mode or box, and the module's id and version. */
export function visionKey(fp: string, request: VisionRequest): string {
  const box = request.box && [request.box.x, request.box.y, request.box.w, request.box.h].map(micro);
  const parts = [
    VISION_CACHE_VERSION,
    fp,
    request.output,
    micro(request.start),
    micro(request.end),
    request.mode ?? null,
    box ?? null,
    request.module.id,
    request.module.version,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

export const visionFiles = (projectDir: string, fp: string, request: VisionRequest) => {
  const base = join(visionDir(projectDir, fp), `${request.output}-${visionKey(fp, request)}`);
  return { video: `${base}.mkv`, json: `${base}.json` };
};

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** A cached matte: its info checks out and its video is there. */
export async function readCachedMatte(files: { readonly video: string; readonly json: string }): Promise<MatteInfo | undefined> {
  const raw = await readJson(files.json);
  if (raw === undefined) return undefined;
  const parsed = parseMatteInfo(raw);
  if (!("value" in parsed)) return undefined;
  const video = await stat(files.video).catch(() => undefined);
  return video?.isFile() && video.size > 0 ? parsed.value : undefined;
}

/** A cached JSON result that still parses as its contract says. */
export async function readCachedJson<T>(path: string, parse: (raw: unknown) => { readonly value: T } | { readonly problem: string }): Promise<T | undefined> {
  const raw = await readJson(path);
  if (raw === undefined) return undefined;
  const parsed = parse(raw);
  return "value" in parsed ? parsed.value : undefined;
}

const covers = (r: { readonly start: number; readonly end: number }, start: number, end: number) => r.start <= start + 1e-6 && r.end >= end - 1e-6;
const sameModule = (a: unknown, b: VisionRequest["module"]) =>
  !!a && typeof a === "object" && (a as { id?: unknown }).id === b.id && (a as { version?: unknown }).version === b.version;

/**
 * D328: a cached result of the same output, mode and module whose range covers [start, end) (a
 * clip trimmed shorter, or another clip of the same stretch of the media), so it isn't made again.
 * Faces results carry the module that made them (written beside the contract's fields).
 */
export async function findCovering<T>(
  projectDir: string,
  fp: string,
  request: VisionRequest,
  parse: (raw: unknown) => { readonly value: T } | { readonly problem: string },
): Promise<{ readonly files: { readonly video: string; readonly json: string }; readonly value: T } | undefined> {
  const dir = visionDir(projectDir, fp);
  const names = await readdir(dir).catch(() => [] as Array<string>);
  for (const name of names.filter((n) => n.startsWith(`${request.output}-`) && n.endsWith(".json")).sort()) {
    const json = join(dir, name);
    const raw = await readJson(json);
    if (!raw || typeof raw !== "object") continue;
    const module = (raw as { module?: unknown }).module;
    if (!sameModule(module, request.module)) continue;
    if (request.mode !== undefined && (raw as { mode?: unknown }).mode !== request.mode) continue;
    const parsed = parse(raw);
    if (!("value" in parsed) || !covers(parsed.value as { start: number; end: number }, request.start, request.end)) continue;
    const files = { video: json.replace(/\.json$/, ".mkv"), json };
    if (request.output === "matte" && !(await readCachedMatte(files))) continue;
    return { files, value: parsed.value };
  }
  return undefined;
}
