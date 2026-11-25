// The offline voice's files (plugins/reverb-tts): Reverb's weights, its codec, its tokenizer and
// the preset voices, downloaded on first use into <data dir>/models/reverb, each like a speech
// model (whisperModels.ts downloadFile: a .part checked against its size and SHA-256, then renamed,
// resumed next time). One download at a time, joined by whoever asks while it runs; it pauses
// (keeping its .part) when nobody waits for it any more: the generation or clone was cancelled.
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { MODEL_FILES, PRESET_VOICES, presetVoiceUrl } from "../../../../plugins/reverb-tts/reverb.ts";
import { Cancelled } from "../analysis/analysisRunner.ts";
import { downloadFile, modelsDir, Paused } from "../analysis/whisperModels.ts";

export interface ReverbPaths {
  readonly model: string;
  readonly codec: string;
  readonly tokenizer: string;
}

interface Entry {
  readonly url: string;
  readonly dest: string;
  readonly bytes: number;
  readonly sha256?: string | undefined;
}

export const reverbDir = (dataDir: string) => join(modelsDir(dataDir), "reverb");
export const TOTAL_BYTES = [...MODEL_FILES, ...PRESET_VOICES].reduce((n, f) => n + f.bytes, 0);

const sizeOf = (path: string) =>
  stat(path).then(
    (s) => s.size,
    () => 0,
  );

interface Running {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly progress: { received: number; readonly total: number };
  waiters: number;
}

export class ReverbFiles {
  readonly dir: string;
  private readonly baseUrl: string | undefined;
  private running: Running | undefined;

  /** `baseUrl` (tests, a mirror): every file from `${baseUrl}/<its name>`, not checked against the catalog. */
  constructor(dir: string, baseUrl?: string) {
    this.dir = dir;
    this.baseUrl = baseUrl;
  }

  paths(): ReverbPaths {
    const of = (id: string) => join(this.dir, MODEL_FILES.find((f) => f.id === id)!.file);
    return { model: of("model"), codec: of("codec"), tokenizer: of("tokenizer") };
  }

  presetPath = (id: string) => join(this.dir, "voices", `${id}.json`);

  private entries(): ReadonlyArray<Entry> {
    const from = (url: string, name: string) => (this.baseUrl ? `${this.baseUrl.replace(/\/+$/, "")}/${name}` : url);
    const checked = this.baseUrl === undefined;
    return [
      ...MODEL_FILES.map((f) => ({ url: from(f.url, f.file), dest: join(this.dir, f.file), bytes: f.bytes, sha256: checked ? f.sha256 : undefined })),
      ...PRESET_VOICES.map((v) => ({ url: from(presetVoiceUrl(v.id), `${v.id}.json`), dest: this.presetPath(v.id), bytes: v.bytes })),
    ];
  }

  private async missing() {
    const out: Array<Entry> = [];
    for (const e of this.entries()) if ((await sizeOf(e.dest)) === 0) out.push(e);
    return out;
  }

  async installed() {
    return (await this.missing()).length === 0;
  }

  private async downloadAll(missing: ReadonlyArray<Entry>, signal: AbortSignal, progress: Running["progress"]) {
    let before = 0;
    for (const e of missing) {
      await downloadFile({
        url: e.url,
        dest: e.dest,
        bytes: this.baseUrl === undefined ? e.bytes : undefined,
        sha256: e.sha256,
        signal,
        onProgress: (received) => (progress.received = before + received),
      });
      before += e.bytes;
    }
  }

  private start(missing: ReadonlyArray<Entry>): Running {
    const controller = new AbortController();
    const progress = { received: 0, total: missing.reduce((n, e) => n + e.bytes, 0) };
    const done = this.downloadAll(missing, controller.signal, progress).finally(() => {
      if (this.running?.done === done) this.running = undefined;
    });
    done.catch(() => {});
    this.running = { controller, done, progress, waiters: 0 };
    return this.running;
  }

  /**
   * The files' paths, downloading what's missing first (joining a running download). `signal`
   * detaches this caller; with nobody left waiting the download pauses, keeping its .part.
   */
  async ensure(options: { readonly signal: AbortSignal; readonly onProgress?: (received: number, total: number) => void }): Promise<ReverbPaths> {
    if (!this.running) {
      const missing = await this.missing();
      if (!missing.length) return this.paths();
    }
    if (options.signal.aborted) throw new Cancelled();
    const r = this.running ?? this.start(await this.missing());
    r.waiters++;
    const timer = setInterval(() => options.onProgress?.(r.progress.received, r.progress.total), 250);
    const detached = new Promise<never>((_, reject) => options.signal.addEventListener("abort", () => reject(new Cancelled()), { once: true }));
    detached.catch(() => {});
    try {
      await Promise.race([r.done, detached]);
      return this.paths();
    } finally {
      clearInterval(timer);
      r.waiters--;
      if (r.waiters === 0 && this.running === r) {
        this.running = undefined;
        r.controller.abort(new Paused());
      }
    }
  }

  /** The server is stopping: the download pauses, keeping its .part. */
  shutdown() {
    const r = this.running;
    this.running = undefined;
    r?.controller.abort(new Paused());
  }
}
