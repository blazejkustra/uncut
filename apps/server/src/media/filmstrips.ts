// GET /media/filmstrip/<id>?token=…: a video's filmstrip for the timeline (issue #53). The first
// request runs ffmpeg once over the file (its preview proxy when there is one, D212: the same
// frames at a fraction of the decode), keeps a frame every `interval` s, scales it to
// FILMSTRIP_TILE_H px high and lays the frames out in one JPEG sprite; it's written to
// `<project>/.cache/filmstrips/<id>--<key>.jpg` with its layout beside it (`.json`), keyed like the
// posters and waveforms by the original file's path, size and modification time, so a changed or
// relinked file gets a new strip and the next request is a file read. Requests for the same file
// share one run; one runs at a time. Same token and answers as the waveform route (waveforms.ts).
// Heavy originals (what D212 would proxy: 4K, HEVC, high-bitrate long-GOP) decode keyframes only,
// with VideoToolbox on macOS (a 5 min 4K HEVC drone clip in ~6 s, not minutes); while such a file's
// proxy is being made the strip waits for it (503, retry). A run is killed when its project closes
// (another opens), when the server stops and when the process exits.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { FILMSTRIP_PATH, FILMSTRIP_TILE_H, type FilmstripLayout } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../app/config.ts";
import { posterKey } from "./media.ts";
import { Projects } from "../project/projects.ts";
import { needsProxy, Proxies, videoFacts } from "./proxies.ts";
import { which } from "../app/setup.ts";
import { withoutApiKey } from "../app/shellEnv.ts";
import { presentedToken, tokensMatch } from "../app/auth.ts";
import { localInputs } from "./localInputs.ts";
import { makeLimiter } from "./waveforms.ts";

/** Tiles per row of the sprite. */
export const COLS = 10;
/** At most this many tiles: longer media gets a longer interval (a 2 h file isn't a 7200-tile sprite). */
export const MAX_TILES = 1000;
/** The shortest interval (s): a short clip zoomed in still gets a new frame every half second. */
export const MIN_INTERVAL = 0.5;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RUNS = 1;

export const filmstripDir = (projectDir: string) => join(projectDir, ".cache", "filmstrips");
export const LAYOUT_HEADER = "x-uncut-filmstrip-layout";

const MEDIA_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
// The renderer is a file:// page fetching from 127.0.0.1: the token protects the route, and it
// reads the layout header, so that is exposed too.
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": `${LAYOUT_HEADER}, x-uncut-filmstrip` };
const notFound = (why = "Not found") => HttpServerResponse.text(why, { status: 404, headers: CORS });

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

/** Seconds between tiles for media `seconds` long: MIN_INTERVAL, or longer (in half seconds) to stay within MAX_TILES. */
export function intervalFor(seconds: number): number {
  return Math.max(MIN_INTERVAL, Math.ceil((seconds / MAX_TILES) * 2) / 2);
}

/** The tiles and rows a strip of media `seconds` long has. */
export function tilesFor(seconds: number) {
  const interval = intervalFor(seconds);
  const count = Math.max(1, Math.min(MAX_TILES, Math.ceil(seconds / interval)));
  return { interval, count, cols: COLS, rows: Math.ceil(count / COLS) };
}

/** ffmpeg's arguments (before localInputs): the first picture, a frame every `interval` s, scaled and tiled into one JPEG. */
export function filmstripArgs(input: string, output: string, seconds: number, { keyframesOnly = false, hardware = false } = {}): Array<string> {
  const { interval, cols, rows } = tilesFor(seconds);
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error",
    ...(hardware ? ["-hwaccel", "videotoolbox"] : []),
    // A proxy has a keyframe every 10 frames (D212): decoding only those is near enough and much faster.
    ...(keyframesOnly ? ["-skip_frame", "nokey"] : []),
    "-an", "-sn", "-dn",
    "-i", input,
    "-map", "0:v:0",
    "-vf", `fps=1/${interval},scale=-2:${FILMSTRIP_TILE_H}:flags=bilinear,tile=${cols}x${rows}`,
    "-frames:v", "1", "-update", "1", "-q:v", "5",
    "-f", "image2", output,
  ];
}

/** A JPEG's width and height, from its start-of-frame marker. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    }
    i += 2 + length;
  }
  return undefined;
}

/** The layout of a sprite made by filmstripArgs for media `seconds` long, from the sprite's size. */
export function layoutOf(bytes: Uint8Array, seconds: number): FilmstripLayout | undefined {
  const size = jpegSize(bytes);
  const { interval, count, cols, rows } = tilesFor(seconds);
  if (!size || size.width % cols !== 0 || size.height % rows !== 0) return undefined;
  return { version: 1, interval, count, cols, rows, tileWidth: size.width / cols, tileHeight: size.height / rows, seconds };
}

// ffmpeg children still running, killed if the server goes away mid-run.
const running = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});

export interface SpriteOptions {
  readonly keyframesOnly?: boolean;
  readonly hardware?: boolean;
  /** Aborting kills the run (its project closed, the server is stopping). */
  readonly signal?: AbortSignal | undefined;
}

/** Runs ffmpeg to make the sprite at `output` (written aside and renamed). Whether it worked. */
export function makeSprite(ffmpeg: string, input: string, output: string, seconds: number, options: SpriteOptions = {}): Promise<boolean> {
  const tmp = `${output}.tmp-${process.pid}.jpg`;
  if (options.signal?.aborted) return Promise.resolve(false);
  return new Promise((done) => {
    const child = spawn(ffmpeg, localInputs(ffmpeg, filmstripArgs(input, tmp, seconds, options)), { env: withoutApiKey(process.env), stdio: ["ignore", "ignore", "ignore"] });
    running.add(child);
    const kill = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, RUN_TIMEOUT_MS);
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      running.delete(child);
      if (code !== 0) return void rm(tmp, { force: true }).then(() => done(false));
      rename(tmp, output).then(
        () => done(true),
        () => rm(tmp, { force: true }).then(() => done(false)),
      );
    };
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

/** A cache file of `id`'s (and not of an id that merely starts the same way). */
export const isFilmstripFileOf = (file: string, id: string) => file.startsWith(`${id}--`) && /^[0-9a-f]{12}\.(jpg|json)$/.test(file.slice(id.length + 2));

/** The answer for one request: the sprite and its layout (read or made), or "failed". */
export type Generated = { readonly kind: "ok"; readonly bytes: Buffer; readonly layout: FilmstripLayout; readonly from: "cache" | "decode" } | { readonly kind: "failed"; readonly why: string };

export interface Source {
  /** The original file (its key names the cache files). */
  readonly path: string;
  readonly key: string;
  /** What ffmpeg reads: the proxy when there is one, else the original. */
  readonly input: string;
  readonly proxy: boolean;
  /** The media's length (s), when the project knows it. */
  readonly seconds: number | undefined;
}

/** The cached strip of `id` made from the file with `key`, when it's there and whole. */
export async function readCached(folder: string, id: string, key: string): Promise<Generated | undefined> {
  try {
    const real = await realpath(folder);
    const jpg = await realpath(join(folder, `${id}--${key}.jpg`));
    const json = await realpath(join(folder, `${id}--${key}.json`));
    // A file that isn't inside the cache folder (a symlink pointing out) is never read.
    if (!jpg.startsWith(real + sep) || !json.startsWith(real + sep)) return undefined;
    const layout = JSON.parse(await readFile(json, "utf8")) as FilmstripLayout;
    if (layout?.version !== 1) return undefined;
    return { kind: "ok", bytes: await readFile(jpg), layout, from: "cache" };
  } catch {
    return undefined;
  }
}

export interface Tools {
  readonly ffmpeg: () => Promise<string | undefined>;
  readonly ffprobe: () => Promise<string | undefined>;
  readonly slot?: () => Promise<void>;
  readonly release?: () => void;
  /** Whether to ask for VideoToolbox decoding (macOS); a run that fails with it is tried without. */
  readonly hardware?: boolean;
  readonly signal?: AbortSignal | undefined;
}

/** Makes (or reads) the strip of `id` into `folder`. `tools` finds ffmpeg and ffprobe. */
export async function generate(folder: string, id: string, source: Source, tools: Tools): Promise<Generated> {
  const cached = await readCached(folder, id, source.key);
  if (cached) return cached;
  const ffmpeg = await tools.ffmpeg();
  if (!ffmpeg) return { kind: "failed", why: "ffmpeg isn't installed" };
  let seconds = source.seconds;
  // An original: is it heavy to decode (what D212 proxies)? Then keyframes only.
  let heavy = false;
  if (!source.proxy || !seconds || !Number.isFinite(seconds) || seconds <= 0) {
    const ffprobe = await tools.ffprobe();
    const facts = ffprobe ? await videoFacts(ffprobe, source.input) : undefined;
    heavy = !source.proxy && facts !== undefined && needsProxy(facts);
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) seconds = facts?.seconds;
  }
  if (!seconds || seconds <= 0) return { kind: "failed", why: "the video's length isn't known" };
  await mkdir(folder, { recursive: true }).catch(() => {});
  const jpg = join(folder, `${id}--${source.key}.jpg`);
  await tools.slot?.();
  let made = false;
  try {
    const run = (input: string, keyframesOnly: boolean) => async () => {
      if (tools.hardware && (await makeSprite(ffmpeg, input, jpg, seconds, { keyframesOnly, hardware: true, signal: tools.signal }))) return true;
      return makeSprite(ffmpeg, input, jpg, seconds, { keyframesOnly, signal: tools.signal });
    };
    // A proxy (short GOP) decodes keyframes only; one that went away mid-run falls back to the original.
    const attempts = source.proxy ? [run(source.input, true), run(source.path, heavy)] : [run(source.input, heavy)];
    for (const attempt of attempts) {
      if (tools.signal?.aborted) break;
      if ((made = await attempt())) break;
    }
  } finally {
    tools.release?.();
  }
  if (!made) return { kind: "failed", why: tools.signal?.aborted ? "the project closed" : "the video couldn't be decoded" };
  const bytes = await readFile(jpg).catch(() => undefined);
  const layout = bytes && layoutOf(bytes, seconds);
  if (!bytes || !layout) {
    await rm(jpg, { force: true });
    return { kind: "failed", why: "the strip came out wrong" };
  }
  // The strip is good even if caching its layout fails (a read-only or full disk): answer anyway.
  try {
    const json = join(folder, `${id}--${source.key}.json`);
    const tmp = `${json}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(layout));
    await rename(tmp, json);
    const files = await readdir(folder).catch(() => [] as Array<string>);
    await Promise.all(files.filter((f) => isFilmstripFileOf(f, id) && !f.startsWith(`${id}--${source.key}.`)).map((f) => rm(join(folder, f), { force: true })));
  } catch {}
  return { kind: "ok", bytes, layout, from: "decode" };
}

interface MediaEntry {
  readonly id: string;
  readonly kind?: string;
  readonly path: string;
  readonly probe?: { readonly frames?: number; readonly fps?: number };
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const proxies = yield* Proxies;
    const inFlight = new Map<string, Promise<Generated>>();
    const { slot, release } = makeLimiter(MAX_RUNS);
    const tool = (name: string) => async () => {
      await config.shellReady;
      return which(name, process.env.PATH ?? "");
    };
    const tools = { ffmpeg: tool("ffmpeg"), ffprobe: tool("ffprobe") };
    const hardware = process.platform === "darwin";
    // One abort per open project: closing it (or opening another) kills its runs; so does stopping.
    const aborts = new Map<string, AbortController>();
    const abortFor = (dir: string) => {
      let a = aborts.get(dir);
      if (!a) aborts.set(dir, (a = new AbortController()));
      return a.signal;
    };
    const abortAllBut = (keep: string | undefined) => {
      for (const [dir, a] of aborts) {
        if (dir === keep) continue;
        a.abort();
        aborts.delete(dir);
      }
    };
    yield* Effect.forkScoped(Stream.runForEach(projects.changes, (snapshot) => Effect.sync(() => abortAllBut(snapshot?.dir))));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        abortAllBut(undefined);
        for (const child of running) child.kill("SIGKILL");
      }),
    );
    // D212: which media have a proxy on the way (their strip waits for it).
    let proxyStates: ReadonlyArray<{ readonly mediaId: string; readonly phase: string }> = [];
    yield* Effect.forkScoped(Stream.runForEach(proxies.states, (states) => Effect.sync(() => void (proxyStates = states))));

    return HttpRouter.add(
      "GET",
      `${FILMSTRIP_PATH}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url) || !tokensMatch(presentedToken(request.headers, url.value), config.token)) {
          return HttpServerResponse.text("Unauthorized", { status: 401, headers: CORS });
        }
        const id = decode(url.value.pathname.slice(FILMSTRIP_PATH.length + 1));
        const open = yield* projects.current;
        if (!open || !id || !MEDIA_ID.test(id)) return notFound();
        const media = ((open.project as { media?: ReadonlyArray<MediaEntry> }).media ?? []).find((m) => m.id === id);
        if (!media || typeof media.path !== "string") return notFound();
        // Stills keep their one poster.
        if (media.kind !== "video") return notFound("Not a video");
        const path = isAbsolute(media.path) ? media.path : resolve(open.dir, media.path);
        const dir = open.dir;
        const proxy = yield* proxies.proxyFor(id);
        // Its proxy is being made: wait for it rather than decode the heavy original now.
        if (!proxy && proxyStates.some((p) => p.mediaId === id && (p.phase === "queued" || p.phase === "running"))) {
          return HttpServerResponse.text("Filmstrip unavailable: waiting for the preview proxy", { status: 503, headers: { ...CORS, "retry-after": "10" } });
        }
        const probe = media.probe;
        const seconds = probe?.frames && probe.fps ? probe.frames / probe.fps : undefined;
        const result = yield* Effect.promise(async (): Promise<Generated | undefined> => {
          const key = await posterKey(path);
          if (!key) return undefined;
          const name = `${dir}\0${id}--${key}`;
          let job = inFlight.get(name);
          if (!job) {
            job = generate(filmstripDir(dir), id, { path, key, input: proxy ?? path, proxy: proxy !== undefined, seconds }, { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, slot, release, hardware, signal: abortFor(dir) })
              .catch((): Generated => ({ kind: "failed", why: "the strip couldn't be made" }))
              .finally(() => inFlight.delete(name));
            inFlight.set(name, job);
          }
          return job;
        });
        // 404: nothing to draw (the renderer keeps the poster); 503: it may work later.
        if (!result) return notFound();
        if (result.kind === "failed") return HttpServerResponse.text(`Filmstrip unavailable: ${result.why}`, { status: 503, headers: { ...CORS, "retry-after": "30" } });
        return HttpServerResponse.uint8Array(result.bytes, {
          contentType: "image/jpeg",
          headers: { ...CORS, "cache-control": "no-store", "x-uncut-filmstrip": result.from, [LAYOUT_HEADER]: JSON.stringify(result.layout) },
        });
      }),
    );
  }),
);
