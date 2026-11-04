// D328: the open project's clip vision results for the preview: reconciled with its clips' effects
// on every change (`sync`), made one at a time in the background with progress ("Removing
// background 40%"), paused while an export runs (it makes what it needs itself). Mattes no clip
// reads any more are removed, unless an export or a frame session holds them or one is being made.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ProxyState } from "@uncut/contracts";
import type { Project } from "@uncut/core";

import { analysisDir } from "../queue/cache.ts";
import {
  type ClipVisionRequest,
  type ClipVisionResult,
  type ClipVisionTarget,
  clipVisionTargets,
  ensureClipVision,
  makePreview,
  previewOf,
  VisionStopped,
  visionBusy,
  visionPinned,
} from "./clipVision.ts";
import { VisionFailure, type VisionAnalysis } from "./vision.ts";

export interface VisionQueueOptions {
  readonly vision: VisionAnalysis;
  readonly ffmpeg: () => Promise<string | undefined>;
  readonly exportBusy: () => boolean;
  readonly onChange: (states: ReadonlyArray<ProxyState>) => void;
}

type Run = { readonly target: ClipVisionTarget; readonly controller: AbortController };

interface TrackJob extends Run {
  readonly item: string;
  readonly clip: string;
  readonly resolve: (result: ClipVisionResult) => void;
  readonly reject: (error: Error) => void;
}

const stateOf = (
  t: ClipVisionRequest & Pick<ClipVisionTarget, "media">,
  patch: Partial<ProxyState>,
  on: { readonly item?: string; readonly target?: string } = {},
): ProxyState => ({
  mediaId: t.media.id,
  phase: "queued",
  progress: 0,
  vision: { output: t.output, ...(t.mode ? { mode: t.mode } : {}), start: t.start, end: t.end, ...on },
  ...patch,
});

const itemIn = (project: Project | undefined, id: string) => project?.tracks.some((t) => t.items.some((i) => i.id === id)) ?? false;

export class VisionQueue {
  private states = new Map<string, ProxyState>();
  private results = new Map<string, ClipVisionResult>();
  private targets: Array<ClipVisionTarget> = [];
  private running: Run | undefined;
  private dir: string | undefined;
  private closed = false;
  private syncing = Promise.resolve();
  private readonly options: VisionQueueOptions;
  private refusedWhy = new Map<string, string>();
  private readonly tracks = new Map<string, TrackJob>();

  constructor(options: VisionQueueOptions) {
    this.options = options;
  }

  list(): ReadonlyArray<ProxyState> {
    return [...this.states.values()];
  }

  /** A made result's file the preview may read, by media id and name (<key>.mp4: a matte's preview copy; <key>.json: its info or the faces). */
  fileFor(mediaId: string, name: string): string | undefined {
    const m = /^((?:matte|faces)-[0-9a-f]{24})\.(mp4|json)$/.exec(name);
    if (!m) return undefined;
    const result = [...this.results.entries()].find(([id, r]) => id.startsWith(`${mediaId}|`) && r.key === m[1])?.[1];
    if (!result) return undefined;
    if (result.output === "matte") return m[2] === "mp4" ? previewOf(result.video) : result.video.replace(/\.mkv$/, ".json");
    return m[2] === "json" ? result.file : undefined;
  }

  sync(dir: string | undefined, project: Project | undefined): Promise<void> {
    this.syncing = this.syncing.then(() => this.reconcile(dir, project)).catch(() => {});
    return this.syncing;
  }

  shutdown() {
    this.closed = true;
    this.running?.controller.abort();
    for (const item of [...this.tracks.keys()]) this.cancelTrack(item);
  }

  track(target: ClipVisionTarget, on: { readonly item: string; readonly clip: string }, signal?: AbortSignal): Promise<ClipVisionResult> {
    if (this.tracks.has(on.item)) return Promise.reject(new VisionFailure("invalid", "This item is being tracked already: cancel that first."));
    if (signal?.aborted) return Promise.reject(new VisionStopped());
    const done = new Promise<ClipVisionResult>((resolve, reject) => {
      const job: TrackJob = { target, controller: new AbortController(), ...on, resolve, reject };
      this.tracks.set(on.item, job);
      this.states.set(target.id, stateOf(target, {}, { item: on.item, target: on.clip }));
    });
    const cancel = () => this.cancelTrack(on.item);
    signal?.addEventListener("abort", cancel, { once: true });
    this.publish();
    this.pump();
    return done.finally(() => signal?.removeEventListener("abort", cancel));
  }

  cancelTrack(item: string, why: Error = new VisionStopped()) {
    const job = this.tracks.get(item);
    if (!job) return;
    if (this.running === job) {
      job.controller.abort(why);
      return;
    }
    this.endTrack(job);
    job.reject(why);
  }

  private endTrack(job: TrackJob) {
    this.tracks.delete(job.item);
    this.states.delete(job.target.id);
    this.publish();
  }

  /** Waits until nothing is queued or running (tests). */
  async idle(): Promise<void> {
    await this.syncing;
    while (this.running || this.queued().length) await new Promise((r) => setTimeout(r, 50));
  }

  pump() {
    if (this.closed || this.running || this.options.exportBusy()) return;
    const run = this.nextRun();
    if (!run) return;
    this.running = run;
    void this.make(run).finally(() => {
      if (this.running === run) this.running = undefined;
      this.pump();
    });
  }

  private queued = () => this.targets.filter((t) => this.states.get(t.id)?.phase === "queued");

  private nextRun(): Run | undefined {
    const job = [...this.tracks.values()].find((j) => this.states.get(j.target.id)?.phase === "queued");
    if (job) return job;
    const target = this.queued()[0];
    return target ? { target, controller: new AbortController() } : undefined;
  }

  private stopGoneTracks(dir: string | undefined, project: Project | undefined) {
    for (const job of [...this.tracks.values()]) {
      if (job.target.dir === dir && itemIn(project, job.item) && itemIn(project, job.clip)) continue;
      this.cancelTrack(job.item, new VisionFailure("invalid", "The item or the clip went while it was being tracked, so nothing changed."));
    }
  }

  private async reconcile(dir: string | undefined, project: Project | undefined) {
    const { targets, refused } = dir && project ? await clipVisionTargets(project, dir) : { targets: [], refused: [] };
    this.stopGoneTracks(dir, project);
    if (dir !== this.dir) {
      this.states.clear();
      this.results.clear();
    }
    this.dir = dir;
    this.targets = targets;
    const next = new Map<string, ProxyState>();
    for (const t of targets) {
      const was = this.states.get(t.id);
      next.set(t.id, was && !this.refusedWhy.has(t.id) ? was : stateOf(t, {}));
    }
    this.refusedWhy = new Map(refused.map((r) => [r.id, r.reason]));
    for (const r of refused) next.set(r.id, stateOf(r, { phase: "failed", error: r.reason }));
    for (const job of this.tracks.values()) {
      const state = this.states.get(job.target.id);
      if (state) next.set(job.target.id, state);
    }
    if (this.running && !next.has(this.running.target.id)) this.running.controller.abort();
    this.states = next;
    for (const id of [...this.results.keys()]) if (!next.has(id)) this.results.delete(id);
    if (dir) await this.removeUnused(dir);
    this.publish();
    this.pump();
  }

  /** Mattes (and their info and preview copies) of this project no clip reads now; never one being made or held. */
  private async removeUnused(dir: string) {
    if (this.running || visionBusy() || this.options.exportBusy()) return;
    const wanted = new Set([...this.results.values()].flatMap((r) => (r.output === "matte" ? [r.video] : [])));
    if (this.targets.some((t) => t.output === "matte" && !this.results.has(t.id))) return;
    const root = analysisDir(dir);
    const prints = await readdir(root).catch(() => [] as Array<string>);
    for (const fp of prints) {
      const folder = join(root, fp, "vision");
      const names = await readdir(folder).catch(() => [] as Array<string>);
      for (const name of names) {
        const m = /^(matte-[0-9a-f]{24})\.(mkv|json|preview\.mp4)$/.exec(name);
        if (!m) continue;
        const video = join(folder, `${m[1]}.mkv`);
        const files = [video, video.replace(/\.mkv$/, ".json"), previewOf(video)];
        if (wanted.has(video) || files.some(visionPinned) || visionBusy() || this.options.exportBusy()) continue;
        await rm(join(folder, name), { force: true });
      }
    }
  }

  private publish() {
    const waiting = this.options.exportBusy();
    this.options.onChange([...this.states.values()].map((s) => (s.phase === "queued" && waiting ? { ...s, waiting: "export" as const } : s)));
  }

  private set(id: string, patch: Partial<ProxyState>) {
    const s = this.states.get(id);
    if (!s) return;
    this.states.set(id, { ...s, ...patch });
    this.publish();
  }

  /** The matte's H.264 copy the preview plays; failing it fails only the preview. */
  private async preview(video: string, signal: AbortSignal) {
    const bin = await this.options.ffmpeg();
    if (!bin) throw new Error("ffmpeg isn't installed, and the preview needs it to show the matte (brew install ffmpeg).");
    await makePreview(bin, video, signal);
  }

  private async makeTrack(job: TrackJob) {
    const { target, controller } = job;
    try {
      const result = await ensureClipVision(this.options.vision, target, {
        signal: controller.signal,
        onProgress: (f) => this.set(target.id, { progress: Math.min(0.99, f) }),
      });
      this.endTrack(job);
      job.resolve(result);
    } catch (error) {
      this.endTrack(job);
      job.reject(controller.signal.aborted ? (controller.signal.reason as Error) : (error as Error));
    }
  }

  private async make(run: Run) {
    const { target, controller } = run;
    this.set(target.id, { phase: "running", progress: 0 });
    if ("item" in run) return this.makeTrack(run as TrackJob);
    try {
      const result = await ensureClipVision(this.options.vision, target, {
        signal: controller.signal,
        onProgress: (f) => this.set(target.id, { progress: Math.min(0.95, f * (target.output === "matte" ? 0.95 : 1)) }),
      });
      if (!this.states.has(target.id)) return;
      this.results.set(target.id, result);
      if (result.output === "matte")
        await this.preview(result.video, controller.signal).catch((error: unknown) => {
          throw new Error(`The matte is made, but its preview couldn't be: ${(error as Error).message}`);
        });
      this.set(target.id, { phase: "done", progress: 1, key: result.key });
    } catch (error) {
      if (controller.signal.aborted || error instanceof VisionStopped) this.set(target.id, { phase: "queued", progress: 0 });
      else this.set(target.id, { phase: "failed", error: (error as Error).message });
    }
  }
}
