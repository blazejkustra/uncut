// Keeps the footage index up to date. A scan is cheap and needs no consent: it records which clips
// each recent project holds and takes in the transcripts already cached. Transcribing what's left
// is a background run for the open project, through the analysis queue (one whisper at a time,
// waits for exports). The user starts it, and from then on new media of that project joins by
// itself until they cancel. A run resumes clip by clip: a clip's transcript is cached when it ends.
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AnalysisJob, FootageHit, FootageStatus } from "@uncut/contracts";

import { fingerprint, readCached, targetOf, type AnalysisTarget } from "../analysis/analysis.ts";
import type { Requested } from "../analysis/analysis.ts";
import type { TranscriptResult } from "../analysis/transcription.ts";
import { entryId, originOf } from "../media/mediaIndex.ts";
import { FootageStore, speechPassages, type ClipKind, type Place, type StoreHit, type VisualNote } from "./footageStore.ts";

const SCAN_DELAY_MS = 500;
const KINDS = new Set(["video", "image", "audio"]);

interface MediaRow {
  readonly id: string;
  readonly kind: string;
  readonly path: string;
  readonly name: string;
  readonly probe?: { readonly frames?: number; readonly hasAudio?: boolean };
}
export interface ProjectMedia {
  readonly dir: string;
  readonly name: string;
  readonly fps: number;
  readonly media: ReadonlyArray<MediaRow>;
}
interface Clip {
  readonly fingerprint: string;
  readonly name: string;
  readonly target: AnalysisTarget;
}

export interface IndexerDeps {
  readonly store: FootageStore;
  /** The open project, if any. */
  readonly open: () => ProjectMedia | undefined;
  readonly recentDirs: () => Promise<ReadonlyArray<{ readonly dir: string; readonly name: string }>>;
  readonly request: (target: AnalysisTarget) => Promise<Requested>;
  readonly cancelJob: (jobId: string) => void;
  readonly onStatus: (status: FootageStatus) => void;
  readonly afterPrune?: () => Promise<void>;
  readonly delayMs?: number;
}

/** The indexable media of a project document (not the bundled library's sounds). */
export function projectMedia(doc: unknown, dir: string, name: string): ProjectMedia {
  const project = (doc ?? {}) as { name?: unknown; canvas?: { fps?: unknown }; media?: unknown };
  const fps = typeof project.canvas?.fps === "number" && project.canvas.fps > 0 ? project.canvas.fps : 30;
  const rows = (Array.isArray(project.media) ? project.media : []) as ReadonlyArray<MediaRow & { source?: unknown }>;
  const media = rows.filter((m) => typeof m?.id === "string" && typeof m.path === "string" && KINDS.has(m.kind) && originOf(m.source) !== undefined);
  return { dir, name: typeof project.name === "string" && project.name.trim() ? project.name.trim() : name, fps, media };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function readProject(dir: string, name: string) {
  try {
    return projectMedia(JSON.parse(await readFile(join(dir, "project.json"), "utf8")), dir, name);
  } catch {
    return undefined;
  }
}

async function transcriptWords(dir: string, fp: string) {
  const cached = (await readCached(dir, fp, "transcript")) as TranscriptResult | undefined;
  return cached && speechPassages(cached.words ?? []);
}

export class FootageIndexer {
  private readonly deps: IndexerDeps;
  private readonly store: FootageStore;
  private clips: ReadonlyArray<Clip> = [];
  private readonly failed = new Map<string, string>();
  private readonly changedMedia = new Set<string>();
  private readonly seenJobs = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private running = false;
  private stopRequested = false;
  private current: Clip | undefined;
  private jobId: string | undefined;
  private jobProgress = 0;
  private waiting: FootageStatus["waiting"];
  private revision = 0;
  private mediaSignature = "";

  constructor(deps: IndexerDeps) {
    this.deps = deps;
    this.store = deps.store;
  }

  status(): FootageStatus {
    const open = this.deps.open();
    const counts = this.store.counts(open?.dir);
    const error = [...this.failed.values()].at(-1);
    return {
      phase: this.running ? "running" : "idle",
      ...counts,
      failed: this.failed.size,
      progress: counts.clips ? Math.min(1, (counts.indexed + this.jobProgress) / counts.clips) : 0,
      ...(this.current ? { current: this.current.name } : {}),
      ...(this.waiting ? { waiting: this.waiting } : {}),
      ...(error ? { error } : {}),
      revision: this.revision,
    };
  }

  private publish(changedResults = false) {
    if (changedResults) this.revision++;
    if (!this.closed) this.deps.onStatus(this.status());
  }

  /** A scan soon; several requests make one. */
  schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.queue = this.queue.then(() => this.scan()).catch((error) => console.error(`[uncut] the footage scan stopped: ${(error as Error).message}`));
    }, this.deps.delayMs ?? SCAN_DELAY_MS);
  }

  /** The open project changed: only new or removed media and another project mean a scan. */
  projectChanged() {
    const open = this.deps.open();
    const signature = `${open?.dir}\0${open?.media.map((m) => `${m.id}\0${m.path}`).join("\0")}`;
    if (signature === this.mediaSignature) return;
    this.mediaSignature = signature;
    this.schedule();
  }

  /** Follows the job of the run, and takes in transcripts made outside it (the agent's, the Transcript tab's). */
  onJobs(jobs: ReadonlyArray<AnalysisJob>) {
    const mine = jobs.find((job) => job.id === this.jobId);
    if (mine) {
      this.jobProgress = mine.stage === "model" ? 0 : mine.progress;
      this.waiting = mine.stage === "model" ? "model" : mine.waiting;
      this.publish();
    }
    for (const job of jobs) {
      if (job.analyzer !== "transcript" || job.phase !== "done" || this.seenJobs.has(job.id)) continue;
      this.seenJobs.add(job.id);
      if (job.id === this.jobId) continue;
      for (const mediaId of job.mediaIds) this.changedMedia.add(`${job.projectDir}\0${mediaId}`);
      this.schedule();
    }
  }

  /** Starts transcribing what's left of the open project, and keeps that up for its new media. */
  start() {
    const open = this.deps.open();
    if (!open) return;
    this.store.setAuto(open.dir, true);
    this.failed.clear();
    this.schedule();
  }

  /** Stops the run; what's indexed stays, and the project joins again only when asked. */
  cancel() {
    const open = this.deps.open();
    if (open) this.store.setAuto(open.dir, false);
    this.stopRequested = true;
    if (this.jobId) this.deps.cancelJob(this.jobId);
  }

  private async clipOf(project: ProjectMedia, media: MediaRow): Promise<(Clip & { place: Place }) | undefined> {
    const target = targetOf(project.dir, media, project.fps);
    const file = await stat(target.path).catch(() => undefined);
    if (!file?.isFile()) return undefined;
    const stamp = `${file.size}:${file.mtimeMs}`;
    const fp = this.store.knownFingerprint(project.dir, media.id, target.path, stamp) ?? (await fingerprint(target.path).catch(() => undefined));
    if (!fp) return undefined;
    const place: Place = {
      dir: project.dir,
      project: project.name,
      mediaId: media.id,
      fingerprint: fp,
      path: target.path,
      stamp,
      name: media.name,
      kind: media.kind as ClipKind,
    };
    return { fingerprint: fp, name: media.name, target, place };
  }

  /** Records a project's clips and takes in their cached transcripts. */
  private async syncProject(project: ProjectMedia) {
    const found = await Promise.all(project.media.map((media) => this.clipOf(project, media)));
    const clips = found.filter((clip) => clip !== undefined);
    this.store.setPlaces(
      project.dir,
      clips.map((clip) => clip.place),
    );
    for (const clip of clips) {
      const changed = this.changedMedia.delete(`${project.dir}\0${clip.target.mediaId}`);
      if (clip.place.kind === "image" || (this.store.isIndexed(clip.fingerprint) && !changed)) continue;
      const passages = await transcriptWords(project.dir, clip.fingerprint);
      if (passages) this.store.putSpeech(clip.fingerprint, passages);
    }
    return clips.filter((clip) => clip.place.kind !== "image");
  }

  private async pruneGone() {
    const dirs = this.store.projectDirs();
    const present = await Promise.all(dirs.map(exists));
    this.store.prune(dirs.filter((_, i) => !present[i]));
    await this.deps.afterPrune?.();
  }

  private async scan() {
    if (this.closed) return;
    const open = this.deps.open();
    for (const recent of await this.deps.recentDirs()) {
      const project = recent.dir === open?.dir ? undefined : await readProject(recent.dir, recent.name);
      if (project) await this.syncProject(project);
    }
    this.clips = open ? await this.syncProject(open) : [];
    await this.pruneGone();
    this.publish(true);
    if (open && !this.running && this.store.isAuto(open.dir) && this.nextClip()) void this.run(open.dir);
  }

  private nextClip() {
    return this.clips.find((clip) => !this.store.isIndexed(clip.fingerprint) && !this.failed.has(clip.fingerprint));
  }

  private async indexClip(clip: Clip) {
    this.current = clip;
    this.jobProgress = 0;
    this.publish();
    const requested = await this.deps.request(clip.target);
    this.jobId = requested.job?.id;
    const outcome = await requested.done;
    this.jobId = undefined;
    this.jobProgress = 0;
    this.waiting = undefined;
    if (outcome.state === "done") {
      this.store.putSpeech(clip.fingerprint, speechPassages((outcome.result as TranscriptResult).words ?? []));
      this.publish(true);
    } else if (outcome.state === "failed") {
      this.failed.set(clip.fingerprint, outcome.error);
      this.publish();
    }
    return outcome.state !== "cancelled";
  }

  private async run(dir: string) {
    this.running = true;
    this.stopRequested = false;
    let go = true;
    for (let clip = this.nextClip(); clip && go; clip = this.nextClip()) {
      go = !this.stopRequested && this.deps.open()?.dir === dir && (await this.indexClip(clip));
    }
    this.running = false;
    this.current = undefined;
    this.publish();
    if (this.deps.open()?.dir !== dir) this.schedule();
  }

  async search(options: { readonly query: string; readonly thisProject: boolean; readonly limit: number }): Promise<ReadonlyArray<FootageHit>> {
    const open = this.deps.open()?.dir;
    const found = this.store.search({ query: options.query, limit: options.limit, ...(options.thisProject ? { dir: open } : {}) });
    const hits = await Promise.all(found.map((hit) => this.shownHit(hit, open)));
    return hits.filter((hit) => hit !== undefined);
  }

  private async shownHit(hit: StoreHit, open: string | undefined): Promise<FootageHit | undefined> {
    const { places, ...moment } = hit;
    const usable = await Promise.all(places.map((place) => exists(place.path)));
    const present = places.filter((_, i) => usable[i]);
    const here = present.find((place) => place.dir === open);
    const place = here ?? present[0];
    if (!place) return undefined;
    return {
      ...moment,
      path: place.path,
      name: place.name,
      kind: place.kind,
      project: { dir: place.dir, name: place.project },
      ...(here ? { media: here.mediaId } : {}),
      recent: entryId(place.path),
    };
  }

  /** Stores what's on screen in a file; it's searchable at once. The scan first: a clip without a place isn't found, and its notes would be pruned. */
  async describe(path: string, notes: ReadonlyArray<VisualNote>) {
    const fp = await fingerprint(path);
    this.schedule();
    await this.settled();
    this.store.putNotes(fp, notes);
    this.publish(true);
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.queue;
  }

  /** Waits for the scans asked for so far. */
  async settled() {
    while (this.timer) await new Promise((done) => setTimeout(done, 5));
    await this.queue;
  }
}
