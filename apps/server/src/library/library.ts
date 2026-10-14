// The online sound library (D134): searches Openverse (no key) or Freesound (the user's key), keeps
// recent results (so the same search never goes out twice in a while, and previews and adds only
// ever fetch URLs a search returned), counts requests against Openverse's anonymous limits (20 a
// minute, 200 a day, per IP: Uncut stops before them and reads the limits Openverse reports), and
// downloads a hit into the project's media/ folder with its credits.
//
// Network: every request goes through guardedFetch (tests can only reach this machine) to the
// fixed https hosts, or UNCUT_OPENVERSE_BASE / UNCUT_FREESOUND_BASE in test runs. Nothing is
// fetched until the user (or the agent) searches. A preview is streamed through, never written.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { LibraryError, type LibraryLimit, type LibrarySearchResult, type LibraryState } from "@uncut/contracts";
import { creditOf, hitKey, limitSentence, parseHitKey, sfxCredit, sfxSound, type LibraryCredit, type LibraryHit, type LibraryQuery, type LibrarySource } from "@uncut/core/library";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../app/config.ts";
import { Keys } from "../generate/keys.ts";
import { allowBaseOverrides, guardedFetch, isTestRun } from "../generate/providers.ts";
import { getOnce, retryOnReset } from "./net.ts";
import { MediaCore } from "../media/mediaCore.ts";
import { runProbe } from "../media/probe.ts";
import { which } from "../app/setup.ts";
import { withoutApiKey } from "../app/shellEnv.ts";
import { copyBundledFile, serialisedFor } from "../media/music.ts";
import { freesoundDetailUrl, freesoundHit, freesoundUrl, openverseDetailUrl, openverseHit, openverseUrl, PAGE_SIZE } from "./sources.ts";

/** Openverse's anonymous limits (its x-ratelimit headers say the same). */
export const OPENVERSE_PER_MINUTE = 20;
export const OPENVERSE_PER_DAY = 200;
/** Freesound's documented API limits. */
export const FREESOUND_PER_MINUTE = 60;
export const FREESOUND_PER_DAY = 2000;
/** How long a search's results are reused. */
export const CACHE_MS = 30 * 60 * 1000;
const MAX_CACHED_SEARCHES = 200;
const MAX_KNOWN_HITS = 4000;
/** The largest file an add downloads. */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_QUERY = 200;
/** An API reply must come within this. */
export const API_MS = 30_000;
/** A whole download or preview must finish within this. */
export const TOTAL_MS = 5 * 60_000;
/** The most a preview streams. */
export const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
const SOURCE_NAME: Record<LibrarySource, string> = { openverse: "Openverse", freesound: "Freesound" };

/** Requests per minute and per day: what's been sent, and when a source said stop. */
export class Limiter {
  private sent: Array<number> = [];
  private blocked: LibraryLimit | undefined;
  private readonly perMinute: number;
  private readonly perDay: number;
  private readonly now: () => number;
  constructor(perMinute: number, perDay: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.perDay = perDay;
    this.now = now;
  }
  /** The limit in force now, if any (without counting a request). */
  limit(): LibraryLimit | undefined {
    const t = this.now();
    if (this.blocked && Date.parse(this.blocked.until) > t) return this.blocked;
    this.blocked = undefined;
    this.sent = this.sent.filter((s) => t - s < 24 * 3600 * 1000);
    if (this.sent.length >= this.perDay) return { scope: "day", until: new Date(this.sent[0]! + 24 * 3600 * 1000).toISOString() };
    const minute = this.sent.filter((s) => t - s < 60 * 1000);
    if (minute.length >= this.perMinute) return { scope: "minute", until: new Date(minute[0]! + 60 * 1000).toISOString() };
    return undefined;
  }
  /** Counts a request about to go out, or says why it can't. */
  take(): LibraryLimit | undefined {
    const limit = this.limit();
    if (!limit) this.sent.push(this.now());
    return limit;
  }
  /** What the source reported: requests left this minute / today (0 blocks), or a 429's Retry-After. */
  report(left: { readonly minute?: number | undefined; readonly day?: number | undefined; readonly retryAfter?: number | undefined; readonly refused?: boolean }) {
    const t = this.now();
    if (left.day === 0 || (left.refused && left.minute !== 0 && left.day !== undefined && left.day <= 0)) {
      const midnight = new Date(t);
      midnight.setUTCHours(24, 0, 0, 0);
      this.blocked = { scope: "day", until: midnight.toISOString() };
    } else if (left.minute === 0 || left.refused) {
      const wait = left.retryAfter && left.retryAfter > 0 ? Math.min(left.retryAfter, 24 * 3600) * 1000 : 60 * 1000;
      this.blocked = { scope: wait > 3600 * 1000 ? "day" : "minute", until: new Date(t + wait).toISOString() };
    }
  }
}

export interface LibraryOptions {
  readonly sfxDir: string;
  /** The Freesound key, read right before a request (undefined: none stored). */
  readonly freesoundKey: () => Promise<string | undefined>;
  /** A downloaded file's length in seconds (the media core / ffprobe). */
  readonly probeSeconds: (path: string) => Promise<number | undefined>;
  readonly now?: () => number;
  /** How long a whole download or preview may take (default TOTAL_MS; tests shorten it). */
  readonly totalMs?: number;
}

export interface Added {
  readonly path: string;
  readonly seconds: number;
  readonly name: string;
  readonly source: LibraryCredit;
}

const fail = (reason: LibraryError["reason"], message: string) => new LibraryError({ reason, message });
const num = (v: string | null) => (v !== null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** A file name from the title and creator: "deep-whoosh-1-kinoton". */
export function fileStem(hit: Pick<LibraryHit, "title" | "creator">) {
  const slug = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\.(wav|mp3|aiff?|flac|ogg|m4a)$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const stem = [slug(hit.title).slice(0, 48), slug(hit.creator).slice(0, 24)].filter(Boolean).join("-");
  return stem.replace(/-+$/, "") || "sound";
}

const EXTENSIONS = new Set(["mp3", "ogg", "oga", "wav", "flac", "m4a", "aac", "aif", "aiff", "opus"]);
/** The file's extension: the reply's type, else the URL's, else mp3. */
export function extensionOf(hit: Pick<LibraryHit, "filetype">, url: string) {
  if (hit.filetype && EXTENSIONS.has(hit.filetype)) return hit.filetype;
  const fromUrl = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  return fromUrl && EXTENSIONS.has(fromUrl) ? fromUrl : "mp3";
}

export function soundLibrary(options: LibraryOptions) {
  const now = options.now ?? Date.now;
  const limiters: Record<LibrarySource, Limiter> = { openverse: new Limiter(OPENVERSE_PER_MINUTE, OPENVERSE_PER_DAY, now), freesound: new Limiter(FREESOUND_PER_MINUTE, FREESOUND_PER_DAY, now) };
  const cache = new Map<string, { readonly at: number; readonly result: LibrarySearchResult }>();
  const known = new Map<string, { readonly hit: LibraryHit; readonly fileUrl: string }>();
  let lastLeft: Partial<Record<LibrarySource, { minute?: number; day?: number }>> = {};

  const remember = (entries: ReadonlyArray<{ hit: LibraryHit; fileUrl: string }>) => {
    for (const e of entries) {
      known.delete(hitKey(e.hit));
      known.set(hitKey(e.hit), e);
    }
    while (known.size > MAX_KNOWN_HITS) known.delete(known.keys().next().value!);
  };

  /** One API GET as JSON, counted against the source's limit; the key (Freesound) only in its header. */
  async function getJson(source: LibrarySource, url: string, signal?: AbortSignal): Promise<{ json: unknown } | { limit: LibraryLimit }> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "Uncut (https://github.com/blazejkustra/uncut)" };
    let key: string | undefined;
    if (source === "freesound") {
      key = await options.freesoundKey();
      if (!key) throw fail("no-key", "Add your Freesound key in Settings to search Freesound.");
      headers.authorization = `Token ${key}`;
    }
    const redact = (s: string) => (key ? s.split(key).join("[key]") : s);
    const limit = limiters[source].take();
    if (limit) return { limit };
    let res: Response;
    try {
      const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(API_MS)]) : AbortSignal.timeout(API_MS);
      res = await retryOnReset(() => guardedFetch(url, { headers, redirect: "error", signal: bounded }), bounded);
    } catch (error) {
      throw fail("network", `Couldn't reach ${SOURCE_NAME[source]}: ${redact((error as Error).message)}`);
    }
    if (source === "openverse") {
      const minute = num(res.headers.get("x-ratelimit-available-anon_burst"));
      const day = num(res.headers.get("x-ratelimit-available-anon_sustained"));
      lastLeft = { ...lastLeft, openverse: { ...(minute !== undefined ? { minute } : {}), ...(day !== undefined ? { day } : {}) } };
      limiters.openverse.report({ minute, day, retryAfter: num(res.headers.get("retry-after")), refused: res.status === 429 });
    } else if (res.status === 429) limiters.freesound.report({ retryAfter: num(res.headers.get("retry-after")), refused: true });
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      return { limit: limiters[source].limit() ?? { scope: "minute", until: new Date(now() + 60 * 1000).toISOString() } };
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw fail("refused", source === "freesound" ? "Freesound didn't accept your key. Check it in Settings." : `${SOURCE_NAME[source]} refused the search (${res.status}).`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw fail("refused", `${SOURCE_NAME[source]} answered ${res.status}.`);
    }
    const body = await res.text();
    if (body.length > MAX_JSON_BYTES) throw fail("refused", `${SOURCE_NAME[source]}'s reply is too large.`);
    try {
      return { json: JSON.parse(body) };
    } catch {
      throw fail("refused", `${SOURCE_NAME[source]} answered with something that isn't JSON.`);
    }
  }

  async function sources(): Promise<Array<LibrarySource>> {
    return (await options.freesoundKey().catch(() => undefined)) ? ["openverse", "freesound"] : ["openverse"];
  }

  async function search(raw: LibraryQuery): Promise<LibrarySearchResult> {
    const source: LibrarySource = raw.source ?? "openverse";
    const query = raw.query.replace(/\s+/g, " ").trim();
    if (!query) throw fail("bad-request", "Type what to search for.");
    if (query.length > MAX_QUERY) throw fail("bad-request", `Searches are at most ${MAX_QUERY} characters.`);
    const q: LibraryQuery = { ...raw, query, source, page: Math.min(50, Math.max(1, Math.floor(raw.page ?? 1))) };
    const cacheKey = JSON.stringify([source, q.kind, query.toLowerCase(), q.license ?? "", q.length ?? "", q.kind === "music" && q.songs ? 1 : 0, q.page]);
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.at < CACHE_MS) return { ...hit.result, cached: true, ...(limiters[source].limit() ? { limit: limiters[source].limit()! } : {}) };
    const url = source === "openverse" ? openverseUrl(q) : freesoundUrl(q);
    const reply = await getJson(source, url);
    if ("limit" in reply) return { hits: [], total: 0, page: q.page!, pages: 0, source, cached: false, limit: reply.limit };
    const body = (reply.json ?? {}) as { results?: unknown; result_count?: unknown; page_count?: unknown; count?: unknown };
    const rows = Array.isArray(body.results) ? (body.results as Array<Record<string, unknown>>) : [];
    const parsed = rows.map((r) => (source === "openverse" ? openverseHit(r) : freesoundHit(r))).filter((e): e is NonNullable<typeof e> => !!e);
    remember(parsed);
    const total = typeof body.result_count === "number" ? body.result_count : typeof body.count === "number" ? body.count : parsed.length;
    const pages = typeof body.page_count === "number" ? body.page_count : Math.ceil(total / PAGE_SIZE);
    const left = lastLeft[source];
    const result: LibrarySearchResult = { hits: parsed.map((e) => e.hit), total, page: q.page!, pages, source, cached: false, ...(left && (left.minute !== undefined || left.day !== undefined) ? { left } : {}) };
    cache.set(cacheKey, { at: now(), result });
    while (cache.size > MAX_CACHED_SEARCHES) cache.delete(cache.keys().next().value!);
    return result;
  }

  /** A hit by its key: from a recent search, else asked for by id (one request). */
  async function lookup(key: string, signal?: AbortSignal): Promise<{ hit: LibraryHit; fileUrl: string }> {
    const known1 = known.get(key);
    if (known1) return known1;
    const parsed = parseHitKey(key);
    if (!parsed) throw fail("bad-request", `"${key}" isn't a library id (openverse:<id>, freesound:<id> or sfx:<id>).`);
    const reply = await getJson(parsed.source, parsed.source === "openverse" ? openverseDetailUrl(parsed.id) : freesoundDetailUrl(parsed.id), signal);
    if ("limit" in reply) throw fail("limit", limitSentence(parsed.source, reply.limit, now()));
    const row = (reply.json ?? {}) as Record<string, unknown>;
    const entry = parsed.source === "openverse" ? openverseHit(row) : freesoundHit(row);
    if (!entry || entry.hit.id !== parsed.id) throw fail("refused", `${SOURCE_NAME[parsed.source]} has no CC0 or CC BY sound ${parsed.id}.`);
    remember([entry]);
    return entry;
  }

  /** The preview of a recent hit, fetched from its file URL (a Range header passed on, so it can seek). */
  async function preview(key: string, range: string | undefined, signal: AbortSignal): Promise<Response | undefined> {
    const entry = known.get(key);
    if (!entry) return undefined;
    const res = await getFollowing(entry.fileUrl, range ? { range } : {}, AbortSignal.any([signal, AbortSignal.timeout(options.totalMs ?? TOTAL_MS)]));
    // Only sound comes through (a page or an error document doesn't).
    if (res.ok && !isAudioType(res.headers.get("content-type"), true)) {
      await res.body?.cancel().catch(() => {});
      return new Response(null, { status: 415 });
    }
    return res;
  }

  /** Downloads a hit (or copies a bundled sound effect) into `<projectDir>/media/`. */
  async function add(id: string, projectDir: string, outer: AbortSignal = new AbortController().signal): Promise<Added> {
    // A download that trickles can't hold the project's copy lock for ever.
    const signal = AbortSignal.any([outer, AbortSignal.timeout(options.totalMs ?? TOTAL_MS)]);
    if (id.startsWith("sfx:")) {
      const s = sfxSound(id.slice(4));
      if (!s) throw fail("bad-request", `There's no bundled sound "${id.slice(4)}".`);
      const copied = await copyBundledFile(options.sfxDir, projectDir, s.file);
      if ("problem" in copied) throw fail("io", copied.problem);
      return { path: copied.path, seconds: s.seconds, name: s.title, source: sfxCredit(s) };
    }
    const { hit, fileUrl } = await lookup(id, signal);
    return serialisedFor(projectDir, () => download(hit, fileUrl, projectDir, signal, outer));
  }

  async function download(hit: LibraryHit, fileUrl: string, projectDir: string, signal: AbortSignal, outer: AbortSignal): Promise<Added> {
    const folder = join(projectDir, "media");
    let real: string;
    try {
      await mkdir(folder, { recursive: true });
      real = await realpath(folder);
      if (!real.startsWith(`${await realpath(projectDir)}${sep}`)) throw fail("io", "The project's media folder points outside the project, so nothing was downloaded.");
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      throw fail("io", `Couldn't make the project's media folder: ${(error as Error).message}`);
    }
    const res = await getFollowing(fileUrl, {}, signal).catch((error: Error) => {
      throw fail("network", `Couldn't download the sound: ${signal.aborted && !outer.aborted ? "it took too long" : error.message}`);
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw fail("refused", `The sound's file couldn't be downloaded (${res.status}).`);
    }
    if (!isAudioType(res.headers.get("content-type"), false)) {
      await res.body.cancel().catch(() => {});
      throw fail("refused", `The sound's address sent ${res.headers.get("content-type")?.split(";")[0] ?? "something"}, not a sound.`);
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) {
      await res.body.cancel().catch(() => {});
      throw fail("refused", "The sound's file is over 200 MB.");
    }
    const ext = extensionOf(hit, fileUrl);
    // Hidden and unique, but with the sound's extension: the media core probes by it.
    const part = join(real, `.${fileStem(hit)}.${randomUUID()}.part.${ext}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _e, done) {
        bytes += chunk.length;
        hash.update(chunk);
        done(bytes > MAX_DOWNLOAD_BYTES ? new Error("The sound's file is over 200 MB.") : null, chunk);
      },
    });
    try {
      try {
        await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), meter, createWriteStream(part, { flags: "wx" }), { signal });
      } catch (error) {
        throw fail("network", `The download stopped: ${signal.aborted && !outer.aborted ? "it took too long" : (error as Error).message}`);
      }
      if (bytes === 0) throw fail("refused", "The sound's file was empty.");
      const sha256 = hash.digest("hex");
      // It must read as a sound (the API's length isn't trusted for a file that doesn't).
      const seconds = await options.probeSeconds(part).catch(() => undefined);
      if (!seconds || !(seconds > 0)) throw fail("refused", "The downloaded file isn't a sound Uncut can read.");
      const stem = fileStem(hit);
      for (let n = 1; n < 100; n++) {
        const name = n === 1 ? `${stem}.${ext}` : `${stem}-${n}.${ext}`;
        const target = join(real, name);
        try {
          await link(part, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw fail("io", `Couldn't save the sound into the project: ${(error as Error).message}`);
          // The same file already there (added before, then undone): reuse it.
          if ((await stat(target)).size === bytes && createHash("sha256").update(await readFile(target)).digest("hex") === sha256) return done(`media/${name}`);
          continue;
        }
        return done(`media/${name}`);
      }
      throw fail("io", `The project's media folder already holds 99 files named like ${stem}.${ext}.`);
      function done(path: string): Added {
        return { path, seconds: Math.round(seconds! * 1000) / 1000, name: hit.title, source: creditOf(hit, { fileUrl, sha256, downloaded: new Date(now()).toISOString() }) };
      }
    } finally {
      await rm(part, { force: true });
    }
  }

  async function state(): Promise<LibraryState> {
    const limit = limiters.openverse.limit();
    return { sources: await sources(), ...(limit ? { limit } : {}) };
  }

  return { search, add, preview, state, lookup, limiters };
}

/** GET following redirects by hand (at most 5), each hop https (or a loopback stub in tests), through guardedFetch. */
export async function getFollowing(start: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let url = new URL(start);
  for (let hop = 0; ; hop++) {
    const at = url;
    // Every hop checked (net.ts: https, public addresses only, the checked address connected to).
    const res = await retryOnReset(() => getOnce(at, { "user-agent": "Uncut (https://github.com/blazejkustra/uncut)", ...headers }, signal), signal);
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!location || hop >= 5) throw new Error("too many redirects");
    url = new URL(location, url);
  }
}

/** A content type a sound may come as: audio/*, Ogg, and (downloads only) a generic binary or none. Never a page, JSON or text. */
export function isAudioType(raw: string | null, strict: boolean): boolean {
  const type = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  if (/^audio\//.test(type) || type === "application/ogg") return true;
  return !strict && (type === "" || type === "application/octet-stream" || type === "binary/octet-stream");
}

export { limitSentence };

export type SoundLibrary = ReturnType<typeof soundLibrary>;

export interface LibraryShape {
  readonly state: Effect.Effect<LibraryState>;
  readonly search: (query: LibraryQuery) => Effect.Effect<LibrarySearchResult, LibraryError>;
  readonly add: (id: string, projectDir: string, signal?: AbortSignal) => Effect.Effect<Added, LibraryError>;
  readonly preview: SoundLibrary["preview"];
}

export class Library extends Context.Service<Library, LibraryShape>()("uncut/Library") {}

const asLibraryError = (error: unknown) => (error instanceof LibraryError ? error : fail("network", (error as Error)?.message ?? String(error)));

export const layer = Layer.effect(
  Library,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const keys = yield* Keys;
    const mediaCore = yield* MediaCore;
    allowBaseOverrides(isTestRun(process.env, config.keysFd));
    const lib = soundLibrary({
      sfxDir: config.sfxDir,
      freesoundKey: () => Effect.runPromise(keys.get("freesound").pipe(Effect.catch(() => Effect.succeed(undefined)))),
      probeSeconds: async (path) => {
        const [outcome] = await Effect.runPromise(mediaCore.probeMany([path]).pipe(Effect.catch(() => Effect.succeed([]))));
        if (outcome?.ok && outcome.info.kind === "audio" && outcome.info.durationSeconds && outcome.info.durationSeconds > 0) return outcome.info.durationSeconds;
        // Formats the media core doesn't read (mp3): ffprobe, as the import does. It must find an audio stream.
        await config.shellReady;
        const bin = await which("ffprobe", process.env.PATH ?? "");
        if (!bin) return undefined;
        const r = await runProbe(bin, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type:format=duration", "-of", "json", path], { timeoutMs: 15000, env: withoutApiKey(process.env) });
        if (r.kind !== "done" || r.code !== 0) return undefined;
        try {
          const j = JSON.parse(r.stdout) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
          const d = Number(j.format?.duration);
          return j.streams?.some((x) => x.codec_type === "audio") && d > 0 ? d : undefined;
        } catch {
          return undefined;
        }
      },
    });
    return Library.of({
      state: Effect.promise(() => lib.state()),
      search: (q) => Effect.tryPromise({ try: () => lib.search(q), catch: asLibraryError }),
      add: (id, dir, signal) => Effect.tryPromise({ try: () => lib.add(id, dir, signal), catch: asLibraryError }),
      preview: lib.preview,
    });
  }),
);
