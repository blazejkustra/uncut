// Speech models for local transcription (D68): whisper.cpp's ggml files, downloaded on demand
// (the Setup row's Download button, or the first transcript the agent asks for), never at start,
// into <data dir>/models (~/Library/Application Support/Uncut/models). A download goes to
// <file>.part, is checked against the catalog's size and SHA-256 while it streams, then renamed
// into place, so a model file that exists is a whole one. Cancel removes the .part; a download cut
// off by the network, paused (no transcript waits for it any more) or stopped by quitting keeps it,
// and the next one resumes it with a Range request (If-Range on the ETag/Last-Modified it got).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Cancelled } from "./analysisRunner.ts";

export interface ModelInfo {
  readonly id: string;
  readonly file: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly multilingual: boolean;
  /** Offered in the Setup row's picker (the English-only ones are for tests). */
  readonly offered: boolean;
}

// Sizes and SHA-256 (the LFS object ids) from huggingface.co/api/models/ggerganov/whisper.cpp,
// 2026-10-12. ggml-org/whisper.cpp answered 401 then; ggerganov/whisper.cpp serves the files.
export const MODELS: ReadonlyArray<ModelInfo> = [
  {
    id: "large-v3-turbo-q5_0",
    file: "ggml-large-v3-turbo-q5_0.bin",
    name: "Large v3 Turbo",
    bytes: 574041195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    multilingual: true,
    offered: true,
  },
  {
    id: "small",
    file: "ggml-small.bin",
    name: "Small",
    bytes: 487601967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    multilingual: true,
    offered: true,
  },
  {
    id: "base",
    file: "ggml-base.bin",
    name: "Base",
    bytes: 147951465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    multilingual: true,
    offered: true,
  },
  {
    id: "base.en",
    file: "ggml-base.en.bin",
    name: "Base (English only)",
    bytes: 147964211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    multilingual: false,
    offered: false,
  },
  {
    id: "tiny.en",
    file: "ggml-tiny.en.bin",
    name: "Tiny (English only)",
    bytes: 77704715,
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    multilingual: false,
    offered: false,
  },
];
/** Multilingual (Polish too) and the best of the three on offer, ~550 MB. */
export const DEFAULT_MODEL = "large-v3-turbo-q5_0";
export const DEFAULT_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
/** A download that receives nothing for this long is given up (it can resume later). */
const STALL_MS = 60_000;

export const modelInfo = (id: string) => MODELS.find((m) => m.id === id);
export const modelsDir = (dataDir: string) => join(dataDir, "models");

/** An abort with this reason keeps the .part (paused, project closed, quitting); any other abort is a cancel and removes it. */
export class Paused extends Error {
  constructor() {
    super("paused");
  }
}
const keepsPart = (signal: AbortSignal) => signal.reason instanceof Paused;

// ---- one download ----

export interface DownloadOptions {
  readonly url: string;
  /** The final file; the bytes go to `${dest}.part` until they're checked. */
  readonly dest: string;
  /** Expected size and SHA-256 (hex); checked when known. */
  readonly bytes?: number | undefined;
  readonly sha256?: string | undefined;
  readonly signal: AbortSignal;
  readonly onProgress?: (received: number, total: number | undefined) => void;
  readonly stallMs?: number | undefined;
}

const hashFile = (path: string, hash: ReturnType<typeof createHash>) =>
  new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise());
    stream.on("error", reject);
  });

const sizeOf = (path: string) =>
  stat(path).then(
    (s) => s.size,
    () => 0,
  );

/** A file that can't be the model (too big, wrong checksum): its .part is removed. */
class Mismatch extends Error {}
/** The .part isn't the start of what the server has now: start again from 0. */
class Restart extends Error {}

/** What the server said about the file, kept next to the .part to resume against the same file. */
interface PartMeta {
  readonly url: string;
  readonly etag?: string;
  readonly lastModified?: string;
}
const readMeta = async (path: string): Promise<PartMeta | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PartMeta;
  } catch {
    return undefined;
  }
};

/** A file system failure as a sentence (the disk, permissions), or undefined for anything else. */
const fsSentence = (error: unknown, dir: string) => {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case "ENOSPC":
    case "EDQUOT":
      return "The disk is full. Free some space for the speech model, then try again.";
    case "EACCES":
    case "EPERM":
      return `Uncut isn't allowed to write in ${dir}.`;
    case "EROFS":
      return `${dir} is read-only.`;
    default:
      return undefined;
  }
};

/**
 * Downloads `url` to `dest` atomically: into `${dest}.part` (resumed with a Range request when a
 * .part is there), size and SHA-256 checked, then renamed. Rejects with Cancelled when `signal`
 * aborts: a cancel removes the .part, an abort whose reason is Paused keeps it. A network failure
 * keeps it too; a size or checksum mismatch, or a full disk, removes it.
 */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  try {
    return await downloadOnce(options);
  } catch (error) {
    if (error instanceof Restart) return downloadOnce(options);
    throw error;
  }
}

async function downloadOnce(options: DownloadOptions): Promise<void> {
  const { url, dest, bytes, sha256, signal } = options;
  const part = `${dest}.part`;
  const metaPath = `${dest}.part.json`;
  const dropPart = () => Promise.all([rm(part, { force: true }), rm(metaPath, { force: true })]).catch(() => {});
  // The caller's abort, or a stall: either aborts the request. Listened to before anything is
  // awaited, so an abort can't slip in between.
  const controller = new AbortController();
  let stalled = false;
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ((stalled = true), controller.abort()), options.stallMs ?? STALL_MS);
  };
  const check = () => {
    if (signal.aborted) throw new Cancelled();
  };
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    check();
    await mkdir(dirname(dest), { recursive: true });
    check();
    let have = await sizeOf(part);
    const meta = have > 0 ? await readMeta(metaPath) : undefined;
    if ((bytes !== undefined && have >= bytes) || (have > 0 && meta?.url !== undefined && meta.url !== url)) {
      // Too big to be the start of this file, whole but never checked, or from elsewhere: start over.
      await dropPart();
      have = 0;
    }
    check();
    armStall();
    const headers: Record<string, string> = {};
    if (have > 0) {
      headers.range = `bytes=${have}-`;
      // Only resume against the same file: the server answers 200 (the whole file) if it changed.
      const validator = meta?.etag && !meta.etag.startsWith("W/") ? meta.etag : meta?.lastModified;
      if (validator) headers["if-range"] = validator;
    }
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
    } catch (error) {
      check();
      throw new Error(`Couldn't reach the model server${stalled ? " (no answer)" : ""}: ${(error as Error).message}`);
    }
    if (response.status === 416 && have > 0) {
      // The server has nothing past what's here: the .part isn't a start of this file.
      await response.body?.cancel().catch(() => {});
      await dropPart();
      throw new Restart();
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`The model server answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`);
    }
    let resumed = false;
    if (response.status === 206) {
      // Only a range starting exactly where the .part ends continues it.
      const start = Number(/^bytes\s+(\d+)-/i.exec(response.headers.get("content-range") ?? "")?.[1]);
      if (have === 0 || start !== have) {
        await response.body.cancel().catch(() => {});
        await dropPart();
        throw new Restart();
      }
      resumed = true;
    }
    if (!resumed) {
      have = 0;
      const etag = response.headers.get("etag") ?? undefined;
      const lastModified = response.headers.get("last-modified") ?? undefined;
      await writeFile(metaPath, JSON.stringify({ url, ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) } satisfies PartMeta));
    }
    const length = Number(response.headers.get("content-length"));
    const total = bytes ?? (Number.isFinite(length) && length > 0 ? have + length : undefined);
    const hash = createHash("sha256");
    if (resumed) await hashFile(part, hash);
    check();
    file = await open(part, resumed ? "a" : "w");
    let received = have;
    options.onProgress?.(received, total);
    const reader = response.body.getReader();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        check();
        throw new Error(
          `The download stopped${stalled ? ": nothing arrived for a minute" : `: ${(error as Error).message}`}. It resumes where it stopped next time.`,
        );
      }
      if (chunk.done) break;
      armStall();
      await file.write(chunk.value);
      hash.update(chunk.value);
      received += chunk.value.byteLength;
      if (total !== undefined && received > total) throw new Mismatch(`The download is bigger than the model should be (${total} bytes).`);
      options.onProgress?.(received, total);
    }
    await file.sync();
    await file.close();
    file = undefined;
    check();
    if (total !== undefined && received !== total)
      throw new Error(`The download stopped at ${received} of ${total} bytes. It resumes where it stopped next time.`);
    if (sha256 && hash.digest("hex") !== sha256.toLowerCase()) throw new Mismatch("The downloaded model is damaged (its checksum doesn't match). Try again.");
    await rename(part, dest);
    await rm(metaPath, { force: true }).catch(() => {});
  } catch (error) {
    await file?.close().catch(() => {});
    if (signal.aborted) {
      // A cancel leaves nothing; a pause (detach, project closed, quit) keeps the .part to resume.
      if (!keepsPart(signal)) await dropPart();
      throw new Cancelled();
    }
    if (error instanceof Mismatch) await dropPart();
    if (error instanceof Restart || error instanceof Mismatch) throw error;
    const sentence = fsSentence(error, dirname(dest));
    if (sentence) {
      if (/disk is full/.test(sentence)) await dropPart();
      throw new Error(sentence);
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
    signal.removeEventListener("abort", onAbort);
  }
}

// ---- the store ----

export interface ModelDownload {
  readonly model: string;
  readonly phase: "downloading" | "done" | "failed" | "cancelled";
  readonly received: number;
  readonly total?: number;
  readonly error?: string;
}

export interface ModelsState {
  readonly selected: string;
  readonly dir: string;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly bytes: number;
    readonly multilingual: boolean;
    readonly offered: boolean;
    readonly installed: boolean;
  }>;
  readonly downloads: ReadonlyArray<ModelDownload>;
}

interface Running {
  readonly controller: AbortController;
  done: Promise<string>;
  /** Started from the Setup row: it runs to the end unless cancelled there. */
  pinned: boolean;
  waiters: number;
}

export interface StoreOptions {
  readonly dir: string;
  readonly selected: string;
  /** Another server (tests, a mirror): files come from `${baseUrl}/<file>`, checked against the size it sends, not the catalog's. */
  readonly baseUrl?: string | undefined;
  readonly onChange?: (state: ModelsState) => void;
  readonly onSelect?: (id: string) => void;
  readonly stallMs?: number;
}

/**
 * The models on this Mac and their downloads. One download per model at a time: asking again
 * joins it. A download the agent's transcript started pauses (keeping its .part) when no
 * transcript waits for it any more; one started from the Setup row runs until it's done or
 * cancelled there. A cancelled download is gone at once: asking again starts a new one, after
 * the old one has cleaned up.
 */
export class ModelStore {
  private readonly options: StoreOptions;
  private selected: string;
  private installed = new Set<string>();
  private downloads: ReadonlyArray<ModelDownload> = [];
  private readonly running = new Map<string, Running>();
  /** Downloads that were stopped and haven't finished cleaning up: a new one for the model waits for it. */
  private readonly settling = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(options: StoreOptions) {
    this.options = options;
    this.selected = modelInfo(options.selected) ? options.selected : DEFAULT_MODEL;
  }

  get dir() {
    return this.options.dir;
  }
  selectedModel = () => this.selected;
  path = (id: string) => join(this.options.dir, modelInfo(id)?.file ?? `${id}.bin`);

  state(): ModelsState {
    return {
      selected: this.selected,
      dir: this.options.dir,
      models: MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        bytes: m.bytes,
        multilingual: m.multilingual,
        offered: m.offered,
        installed: this.installed.has(m.id),
      })),
      downloads: this.downloads,
    };
  }

  private emit() {
    this.options.onChange?.(this.state());
  }

  /** Looks at which model files are there (a file is only ever renamed into place whole). */
  async refresh() {
    const next = new Set<string>();
    for (const m of MODELS) if ((await sizeOf(this.path(m.id))) > 0) next.add(m.id);
    const changed = next.size !== this.installed.size || [...next].some((id) => !this.installed.has(id));
    this.installed = next;
    if (changed) this.emit();
  }

  async isInstalled(id: string) {
    const there = (await sizeOf(this.path(id))) > 0;
    if (there !== this.installed.has(id)) {
      if (there) this.installed.add(id);
      else this.installed.delete(id);
      this.emit();
    }
    return there;
  }

  select(id: string) {
    if (!modelInfo(id))
      throw new Error(
        `There's no model "${id}". Choose one of ${MODELS.filter((m) => m.offered)
          .map((m) => m.id)
          .join(", ")}.`,
      );
    if (id === this.selected) return;
    this.selected = id;
    this.options.onSelect?.(id);
    this.emit();
  }

  private setDownload(d: ModelDownload) {
    this.downloads = [...this.downloads.filter((x) => x.model !== d.model), d];
    this.emit();
  }

  private start(id: string): Running {
    const info = modelInfo(id)!;
    const controller = new AbortController();
    const base = this.options.baseUrl ?? DEFAULT_MODEL_URL;
    const catalog = this.options.baseUrl === undefined;
    let last = 0;
    const r: Running = { controller, done: Promise.resolve(""), pinned: false, waiters: 0 };
    this.running.set(id, r);
    /** Still the model's current download (not one that was cancelled or replaced). */
    const current = () => this.running.get(id) === r;
    this.setDownload({ model: id, phase: "downloading", received: 0, total: info.bytes });
    // A stopped download of this model may still be removing its .part: wait for it first.
    const before = this.settling.get(id) ?? Promise.resolve();
    r.done = before
      .then(() =>
        downloadFile({
          url: `${base.replace(/\/+$/, "")}/${info.file}`,
          dest: this.path(id),
          bytes: catalog ? info.bytes : undefined,
          sha256: catalog ? info.sha256 : undefined,
          signal: controller.signal,
          stallMs: this.options.stallMs,
          onProgress: (received, total) => {
            const now = Date.now();
            if (!current() || (now - last < 200 && received !== total)) return;
            last = now;
            this.setDownload({ model: id, phase: "downloading", received, ...(total !== undefined ? { total } : {}) });
          },
        }),
      )
      .then(
        async () => {
          if (current()) this.running.delete(id);
          this.installed.add(id);
          const size = await sizeOf(this.path(id));
          this.setDownload({ model: id, phase: "done", received: size, total: size });
          return this.path(id);
        },
        (error: Error) => {
          const mine = current();
          if (mine) this.running.delete(id);
          // A newer download of this model reports for itself.
          if (mine || !this.running.has(id)) {
            const d = this.downloads.find((x) => x.model === id);
            if (error instanceof Cancelled)
              this.setDownload({ model: id, phase: "cancelled", received: 0, ...(d?.total !== undefined ? { total: d.total } : {}) });
            else
              this.setDownload({
                model: id,
                phase: "failed",
                received: d?.received ?? 0,
                ...(d?.total !== undefined ? { total: d.total } : {}),
                error: error.message,
              });
          }
          throw error;
        },
      );
    // Nobody may be listening (a pinned download): don't let a failure go unhandled.
    r.done.catch(() => {});
    return r;
  }

  /** Stops a download: it's no longer this model's download, and a new ask starts afresh once it has cleaned up. */
  private stop(id: string, r: Running, reason?: Paused) {
    if (this.running.get(id) === r) this.running.delete(id);
    const settled = r.done.then(
      () => {},
      () => {},
    );
    this.settling.set(id, settled);
    void settled.then(() => {
      if (this.settling.get(id) === settled) this.settling.delete(id);
    });
    r.controller.abort(reason);
  }

  /** The Setup row's Download: starts (or joins) it; it runs until done or cancelled. */
  download(id: string) {
    if (!modelInfo(id)) throw new Error(`There's no model "${id}".`);
    if (this.closed) return;
    if (this.installed.has(id) && !this.running.has(id)) return;
    const r = this.running.get(id) ?? this.start(id);
    r.pinned = true;
  }

  /** Cancels a running download: the .part is removed. */
  cancel(id?: string) {
    for (const [model, r] of [...this.running]) if (id === undefined || id === model) this.stop(model, r);
  }

  /**
   * The model's path, downloading it first if needed (joins a running download). `signal`
   * detaches this waiter; a download nobody waits for any more (and not started from Setup)
   * pauses, keeping its .part for the next ask.
   */
  async ensure(id: string, options: { readonly signal: AbortSignal; readonly onProgress?: (fraction: number) => void }): Promise<string> {
    const info = modelInfo(id);
    if (!info) throw new Error(`There's no model "${id}".`);
    if (!this.running.has(id) && (await this.isInstalled(id))) return this.path(id);
    if (this.closed || options.signal.aborted) throw new Cancelled();
    const r = this.running.get(id) ?? this.start(id);
    r.waiters++;
    const report = () => {
      const d = this.downloads.find((x) => x.model === id);
      if (d?.total && this.running.get(id) === r) options.onProgress?.(Math.min(1, d.received / d.total));
    };
    const timer = setInterval(report, 250);
    let detach: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      detach = () => reject(new Cancelled());
      options.signal.addEventListener("abort", detach, { once: true });
    });
    aborted.catch(() => {});
    // Aborted while this was being set up: the listener came too late to hear it.
    if (options.signal.aborted) detach();
    try {
      return await Promise.race([r.done, aborted]);
    } finally {
      clearInterval(timer);
      options.signal.removeEventListener("abort", detach);
      r.waiters--;
      if (r.waiters === 0 && !r.pinned && this.running.get(id) === r) this.stop(id, r, new Paused());
    }
  }

  /** The server is stopping: downloads stop, keeping their .part to resume next time. */
  shutdown() {
    this.closed = true;
    for (const [model, r] of [...this.running]) this.stop(model, r, new Paused());
  }
}
