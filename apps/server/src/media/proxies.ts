// D212: automatic preview proxies (issue #12). Footage that is heavy to seek in Chromium (4K, HEVC,
// or long-GOP above 30 Mb/s) gets a small short-GOP H.264 copy in <project>/.cache/proxies/,
// named like the posters (<media id>--<key of path, size, mtime>.mp4), so a changed or relinked
// file never shows an old proxy. The preview plays the proxy when there is one (the renderer's
// "Use proxies for preview" setting); export, render_frames and analysis always read the original.
// One proxy is made at a time, in the background, never while an export is queued or running.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { ProjectSnapshot, ProxyState } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../app/config.ts";
import { which } from "../app/setup.ts";
import { withoutApiKey } from "../app/shellEnv.ts";
import { Exporter } from "../export/exporter.ts";
import { Projects } from "../project/projects.ts";
import { posterKey } from "./media.ts";
import { runProbe } from "./probe.ts";

export const proxyDir = (projectDir: string) => join(projectDir, ".cache", "proxies");
export const proxyName = (id: string, key: string) => `${id}--${key}.mp4`;
const PROXY_FILE = /^(.+)--([0-9a-f]{12})\.mp4$/;

/** The proxy's longer side (px). */
export const PROXY_SIZE = 1280;
/** Keyframe every this many frames: a seek decodes at most this many. */
export const PROXY_GOP = 10;
/** Above this (bits per second), long-GOP footage gets a proxy whatever its size. */
export const HEAVY_BITRATE = 30e6;
/** Codecs whose frames lean on others (a seek decodes from the last keyframe). */
const LONG_GOP = new Set(["h264", "hevc", "mpeg2video", "mpeg4", "vp8", "vp9", "av1"]);

export interface VideoFacts {
  readonly codec?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** The whole file's bits per second. */
  readonly bitrate?: number | undefined;
}

/** D212: whether footage gets a proxy: 4K (a shorter side of 1800 px or more, or 3200 wide), HEVC, or long-GOP above 30 Mb/s. */
export function needsProxy(facts: VideoFacts): boolean {
  const w = facts.width ?? 0;
  const h = facts.height ?? 0;
  if (Math.min(w, h) >= 1800 || Math.max(w, h) >= 3200) return true;
  if (facts.codec === "hevc") return true;
  return facts.codec !== undefined && LONG_GOP.has(facts.codec) && (facts.bitrate ?? 0) > HEAVY_BITRATE;
}

/** ffmpeg's arguments for a proxy: the first picture and sound, the longer side at PROXY_SIZE (never upscaled), short GOP, no B-frames. */
export function proxyArgs(input: string, output: string, encoder: "hardware" | "software"): Array<string> {
  const video =
    encoder === "hardware"
      ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-profile:v", "high", "-q:v", "50"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-tune", "fastdecode"];
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
    ...(encoder === "hardware" ? ["-hwaccel", "videotoolbox"] : []),
    "-protocol_whitelist", "file,pipe",
    "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `scale=w=${PROXY_SIZE}:h=${PROXY_SIZE}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
    ...video,
    "-g", String(PROXY_GOP), "-bf", "0",
    // The same timing as the original, frame for frame (the preview seeks it by the source's time).
    "-fps_mode", "passthrough",
    "-c:a", "aac", "-b:a", "160k",
    "-tag:v", "avc1", "-movflags", "+faststart",
    "-f", "mp4", output,
  ];
}

/** What ffprobe says about a file's picture (undefined when it can't be read). */
export async function videoFacts(ffprobe: string, path: string): Promise<(VideoFacts & { readonly seconds?: number }) | undefined> {
  const r = await runProbe(ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height:format=bit_rate,duration", "-of", "json", path], { timeoutMs: 15000, env: withoutApiKey(process.env) });
  if (r.kind !== "done" || r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout) as { streams?: Array<{ codec_name?: string; width?: number; height?: number }>; format?: { bit_rate?: string; duration?: string } };
    const s = j.streams?.[0];
    if (!s) return undefined;
    const seconds = Number(j.format?.duration);
    return { codec: s.codec_name, width: s.width, height: s.height, bitrate: Number(j.format?.bit_rate) || undefined, ...(Number.isFinite(seconds) ? { seconds } : {}) };
  } catch {
    return undefined;
  }
}

interface Task {
  readonly dir: string;
  readonly id: string;
  readonly path: string;
  readonly key: string;
  readonly seconds: number;
}

export interface ProxyQueueOptions {
  readonly ffmpeg: () => Promise<string | undefined>;
  readonly ffprobe: () => Promise<string | undefined>;
  /** Whether an export is queued or running (read when a proxy would start). */
  readonly exportBusy: () => boolean;
  readonly onChange: (states: ReadonlyArray<ProxyState>) => void;
  /** Whether this ffmpeg lists h264_videotoolbox (asked once). */
  readonly hardware?: () => Promise<boolean>;
}

type Media = { readonly id: string; readonly kind?: string; readonly path: string };

/**
 * The proxies of the open project: reconciled with its media on every change (`sync`), made one at
 * a time. A media item's state: done (its proxy is on disk for the file as it is now), queued,
 * running (with progress), failed, or absent (no proxy needed).
 */
export class ProxyQueue {
  private states = new Map<string, ProxyState>();
  private tasks: Array<Task> = [];
  private running: { task: Task; child?: ChildProcess; cancelled: boolean } | undefined;
  private dir: string | undefined;
  private exportBusy = false;
  private closed = false;
  private seen = new Map<string, boolean>();
  private syncing = Promise.resolve();
  private hardware: Promise<boolean> | undefined;
  private media: ReadonlyArray<Media> = [];

  private readonly options: ProxyQueueOptions;

  constructor(options: ProxyQueueOptions) {
    this.options = options;
  }

  /**
   * The proxy file for a media id, when done and still made from the file as it is now (a file
   * changed in place since makes it stale: none is given and the project is checked again).
   */
  async proxyFor(id: string): Promise<string | undefined> {
    const s = this.states.get(id);
    const dir = this.dir;
    if (s?.phase !== "done" || !s.key || !dir) return undefined;
    const m = this.media.find((x) => x.id === id);
    if (!m) return undefined;
    if ((await posterKey(isAbsolute(m.path) ? m.path : resolve(dir, m.path))) !== s.key) {
      void this.sync(dir, this.media);
      return undefined;
    }
    return join(proxyDir(dir), proxyName(id, s.key));
  }

  list(): ReadonlyArray<ProxyState> {
    return [...this.states.values()];
  }

  /** The open project changed (or closed): reconcile its video media with the proxies folder. */
  sync(dir: string | undefined, media: ReadonlyArray<Media>): Promise<void> {
    this.syncing = this.syncing.then(() => this.reconcile(dir, media)).catch(() => {});
    return this.syncing;
  }

  setExportBusy(busy: boolean) {
    this.exportBusy = busy;
    this.publish();
    this.pump();
  }

  shutdown() {
    this.closed = true;
    this.tasks = [];
    this.stopRunning();
  }

  /** Waits until nothing is queued or running (tests). */
  async idle(): Promise<void> {
    await this.syncing;
    while (this.running || (this.tasks.length && !this.busy())) await new Promise((r) => setTimeout(r, 50));
  }

  private busy = () => this.exportBusy || this.options.exportBusy();

  private stopRunning() {
    if (!this.running) return;
    this.running.cancelled = true;
    this.running.child?.kill("SIGKILL");
  }

  private async reconcile(dir: string | undefined, media: ReadonlyArray<Media>) {
    this.media = media;
    if (dir !== this.dir) {
      // Another project (or none): its waiting and running proxies go.
      this.tasks = [];
      this.stopRunning();
      this.states.clear();
      this.seen.clear();
      this.dir = dir;
    }
    if (!dir) return this.publish();
    const ffprobe = await this.options.ffprobe();
    const folder = proxyDir(dir);
    const files = await readdir(folder).catch(() => [] as Array<string>);
    const next = new Map<string, ProxyState>();
    const keep = new Set<string>();
    for (const m of media) {
      if (m.kind !== "video" || typeof m.path !== "string") continue;
      const path = isAbsolute(m.path) ? m.path : resolve(dir, m.path);
      const key = await posterKey(path);
      if (!key) continue;
      const name = proxyName(m.id, key);
      if (files.includes(name)) {
        keep.add(name);
        next.set(m.id, { mediaId: m.id, phase: "done", key });
        continue;
      }
      const was = this.states.get(m.id);
      if (was && was.key === key && was.phase !== "done") {
        next.set(m.id, was);
        continue;
      }
      // Whether this file needs one is asked once per file as it is now.
      const seenKey = `${m.id}|${key}`;
      let needed = this.seen.get(seenKey);
      let seconds = 0;
      if (needed === undefined) {
        const facts = ffprobe ? await videoFacts(ffprobe, path) : undefined;
        needed = !!facts && needsProxy(facts);
        seconds = facts?.seconds ?? 0;
        this.seen.set(seenKey, needed);
      }
      if (!needed) continue;
      next.set(m.id, { mediaId: m.id, phase: "queued", key, progress: 0 });
      this.tasks = this.tasks.filter((t) => t.id !== m.id);
      if (this.running?.task.id === m.id && this.running.task.key !== key) this.stopRunning();
      if (this.running?.task.id !== m.id) this.tasks.push({ dir, id: m.id, path, key, seconds });
    }
    // A media item that's gone, or whose file changed: its old proxy goes (and its queued task).
    const ids = new Set(next.keys());
    this.tasks = this.tasks.filter((t) => ids.has(t.id) && next.get(t.id)?.key === t.key);
    if (this.running && next.get(this.running.task.id)?.key !== this.running.task.key) this.stopRunning();
    await Promise.all(
      files
        .filter((f) => {
          const m = PROXY_FILE.exec(f);
          return m && media.some((x) => x.id === m[1]) && !keep.has(f);
        })
        .map((f) => rm(join(folder, f), { force: true })),
    );
    this.states = next;
    this.publish();
    this.pump();
  }

  private publish() {
    const waiting = this.busy();
    this.options.onChange([...this.states.values()].map((s) => (s.phase === "queued" && waiting ? { ...s, waiting: "export" as const } : s)));
  }

  private set(id: string, patch: Partial<ProxyState>) {
    const s = this.states.get(id);
    if (!s) return;
    this.states.set(id, { ...s, ...patch });
    this.publish();
  }

  private pump() {
    if (this.closed || this.running || this.busy() || !this.tasks.length) return;
    const task = this.tasks.shift()!;
    const run: { task: Task; child?: ChildProcess; cancelled: boolean } = { task, cancelled: false };
    this.running = run;
    void this.make(run).finally(() => {
      if (this.running === run) this.running = undefined;
      this.pump();
    });
  }

  private async make(run: { task: Task; child?: ChildProcess; cancelled: boolean }) {
    const { task } = run;
    this.set(task.id, { phase: "running", progress: 0 });
    const ffmpeg = await this.options.ffmpeg();
    if (!ffmpeg) return this.set(task.id, { phase: "failed", error: "ffmpeg isn't installed." });
    this.hardware ??= this.options.hardware?.() ?? Promise.resolve(false);
    const folder = proxyDir(task.dir);
    await mkdir(folder, { recursive: true }).catch(() => {});
    const out = join(folder, proxyName(task.id, task.key));
    const part = `${out}.part`;
    const attempt = (encoder: "hardware" | "software") =>
      new Promise<boolean>((resolveRun) => {
        if (run.cancelled) return resolveRun(false);
        const child = spawn(ffmpeg, proxyArgs(task.path, part, encoder), { stdio: ["ignore", "pipe", "pipe"], env: withoutApiKey(process.env) });
        run.child = child;
        let last = 0;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          const m = /out_time_us=(\d+)/.exec(chunk);
          if (!m || !task.seconds) return;
          const now = Date.now();
          if (now - last < 250) return;
          last = now;
          this.set(task.id, { progress: Math.min(0.99, Number(m[1]) / 1e6 / task.seconds) });
        });
        child.stderr.resume();
        child.on("error", () => resolveRun(false));
        child.on("close", (code) => resolveRun(code === 0 && !run.cancelled));
      });
    let ok = (await this.hardware) ? await attempt("hardware") : false;
    // VideoToolbox can refuse (no session free, an older Mac): libx264 then.
    if (!ok && !run.cancelled) ok = await attempt("software");
    if (ok && !run.cancelled) {
      // The original may have changed while the proxy was made: then it's not this file's proxy.
      const now = await posterKey(task.path);
      ok = now === task.key && (await rename(part, out).then(() => true, () => false));
    }
    if (!ok) await rm(part, { force: true }).catch(() => {});
    if (run.cancelled || this.dir !== task.dir || this.states.get(task.id)?.key !== task.key) return;
    this.set(task.id, ok ? { phase: "done", progress: 1 } : { phase: "failed", error: "ffmpeg couldn't make a proxy of this file." });
  }
}

export interface ProxiesShape {
  /** The open project's proxies now and on every change. */
  readonly states: Stream.Stream<ReadonlyArray<ProxyState>>;
  /** The proxy file of a media item of the open project, when it is made. */
  readonly proxyFor: (id: string) => Effect.Effect<string | undefined>;
}

export class Proxies extends Context.Service<Proxies, ProxiesShape>()("uncut/Proxies") {}

const EXPORT_BUSY = new Set(["queued", "preparing", "rendering"]);

/** UNCUT_PROXIES=off: none are made (the test helpers start with it, so other tests see no extra ffmpeg runs). */
export const proxiesOff = () => process.env.UNCUT_PROXIES === "off";

export const layer = Layer.effect(
  Proxies,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const exporter = yield* Exporter;
    const ref = yield* SubscriptionRef.make<ReadonlyArray<ProxyState>>([]);
    const tool = (name: string) => async () => {
      await config.shellReady;
      return which(name, process.env.PATH ?? "");
    };
    const ffmpeg = tool("ffmpeg");
    const queue = new ProxyQueue({
      ffmpeg,
      ffprobe: tool("ffprobe"),
      exportBusy: exporter.busy,
      onChange: (states) => Effect.runSync(SubscriptionRef.set(ref, states)),
      hardware: async () => {
        const bin = await ffmpeg();
        if (!bin) return false;
        const r = await runProbe(bin, ["-hide_banner", "-encoders"], { timeoutMs: 10000, env: withoutApiKey(process.env), maxBytes: 1024 * 1024 });
        return r.kind === "done" && /\bh264_videotoolbox\b/.test(r.stdout);
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => queue.shutdown()));
    // Exports come first (D55): no proxy starts while one is queued or running.
    yield* Effect.forkScoped(Stream.runForEach(exporter.jobs, (jobs) => Effect.sync(() => queue.setExportBusy(jobs.some((j) => EXPORT_BUSY.has(j.phase))))));
    if (!proxiesOff()) {
      // Every change of the open project (an import, a relink, an edit) reconciles its proxies:
      // a stat per video, ffprobe once per file as it is.
      yield* Effect.forkScoped(
        Stream.runForEach(projects.changes, (snapshot: ProjectSnapshot | null) =>
          Effect.promise(() => queue.sync(snapshot?.dir, ((snapshot?.project as { media?: ReadonlyArray<Media> } | undefined)?.media ?? []).filter((m) => m.kind === "video"))),
        ),
      );
    }
    return Proxies.of({ states: SubscriptionRef.changes(ref), proxyFor: (id) => Effect.promise(() => queue.proxyFor(id)) });
  }),
);
