// GET /media/waveform/<id>?token=…: the peaks the timeline draws for a media item's sound (D54).
// Same token as the WebSocket; only media of the open project, looked up by id. The first request
// decodes the sound with ffmpeg (mono, 8 kHz, 16-bit, streamed: nothing big is held in memory),
// keeps the loudest sample of every 1/RATE s, and writes `<project>/.cache/waveforms/<id>--<key>.json`
// (key: a hash of the file's path, size and modification time, like the posters), so a changed or
// relinked file gets new peaks and the next request is a file read. Requests for the same file
// share one decode; at most two decodes run at once.
//
// Why ffmpeg and not the Rust helper (D42): ffmpeg is already required (posters, export, D44) and
// decodes every codec a camera, phone or screen recorder writes, while a pure-Rust decoder covers
// fewer and would be a second decode path export doesn't share.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { WAVEFORM_PATH, type Waveform } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../app/config.ts";
import { pcmArgs } from "../analysis/analysisRunner.ts";
import { posterKey } from "./media.ts";
import { Projects } from "../project/projects.ts";
import { which } from "../app/setup.ts";
import { withoutApiKey } from "../app/shellEnv.ts";
import { presentedToken, tokensMatch } from "../app/auth.ts";

/** Peaks per second. */
export const RATE = 100;
const SAMPLE_RATE = 8000;
const PER_PEAK = SAMPLE_RATE / RATE;
const DECODE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DECODES = 2;

export const waveformDir = (projectDir: string) => join(projectDir, ".cache", "waveforms");

const MEDIA_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
// The renderer is a file:// page (an opaque origin) fetching from 127.0.0.1: the token in the URL
// is what protects the route, so any origin may read the answer.
const CORS = { "access-control-allow-origin": "*" };
const notFound = (why = "Not found") => HttpServerResponse.text(why, { status: 404, headers: CORS });

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

/** Keeps the loudest |sample| of every PER_PEAK samples of s16le mono, as 0–255. */
export class PeakMeter {
  private readonly peaks: Array<number> = [];
  private max = 0;
  private count = 0;
  private carry: number | undefined;
  private samples = 0;

  push(chunk: Buffer) {
    let i = 0;
    if (this.carry !== undefined && chunk.length > 0) {
      this.sample((this.carry | (chunk[0]! << 8)) << 16 >> 16);
      this.carry = undefined;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.sample(chunk.readInt16LE(i));
    if (i < chunk.length) this.carry = chunk[i]!;
  }

  private sample(v: number) {
    const a = v < 0 ? -v : v;
    if (a > this.max) this.max = a;
    this.samples++;
    if (++this.count === PER_PEAK) this.flush();
  }

  private flush() {
    this.peaks.push(Math.min(255, Math.round((this.max / 32768) * 255)));
    this.max = 0;
    this.count = 0;
  }

  finish(): Waveform {
    if (this.count > 0) this.flush();
    return { version: 1, rate: RATE, seconds: this.samples / SAMPLE_RATE, peaks: Buffer.from(this.peaks).toString("base64") };
  }
}

// ffmpeg children still running, killed if the server goes away mid-decode.
const running = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});

/** What a decode gave: peaks, "none" (the file has no audio stream), or "failed" (try again later). */
type Decoded = { readonly kind: "ok"; readonly waveform: Waveform } | { readonly kind: "none" } | { readonly kind: "failed" };

/** Seconds of sound a decode that stopped with an error must have reached for its peaks to be kept (a damaged tail). */
const PARTIAL_MIN_S = 1;

/** Decode the first audio stream of `path` into peaks. */
function decodePeaks(ffmpeg: string, path: string): Promise<Decoded> {
  return new Promise((resolvePeaks) => {
    const meter = new PeakMeter();
    const child = spawn(ffmpeg, ["-v", "error", "-nostdin", ...pcmArgs(path, SAMPLE_RATE)], {
      env: withoutApiKey(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, DECODE_TIMEOUT_MS);
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => {
      if (stderr.length < 4096) stderr += d.toString();
    });
    child.stdout!.on("data", (d: Buffer) => meter.push(d));
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      const waveform = meter.finish();
      if (code === 0 && waveform.seconds > 0) return resolvePeaks({ kind: "ok", waveform });
      if (code === 0 || /matches no streams|does not contain any stream/i.test(stderr)) return resolvePeaks({ kind: "none" });
      // Stopped with an error after a good stretch (a damaged end): keep what was decoded.
      if (!timedOut && waveform.seconds >= PARTIAL_MIN_S) return resolvePeaks({ kind: "ok", waveform });
      resolvePeaks({ kind: "failed" });
    };
    child.once("error", () => done(null));
    child.once("close", (code) => done(code));
  });
}

/** A cache file of `id`'s (and not of an id that merely starts the same way). */
export const isWaveformFileOf = (file: string, id: string) => file.startsWith(`${id}--`) && /^[0-9a-f]{12}\.json$/.test(file.slice(id.length + 2));

/** At most `max` holders at once; a release hands its slot straight to the next waiter (no window for an extra one). */
export function makeLimiter(max: number) {
  let held = 0;
  const queue: Array<() => void> = [];
  return {
    slot: async () => {
      if (held < max) {
        held++;
        return;
      }
      await new Promise<void>((r) => queue.push(r));
    },
    release: () => {
      const next = queue.shift();
      if (next) next();
      else held--;
    },
    held: () => held,
  };
}

/** The answer for one request: the peaks (and whether they were read or decoded), "none", or "failed". */
type Generated = { readonly kind: "ok"; readonly bytes: Buffer; readonly from: "cache" | "decode" } | { readonly kind: "none" } | { readonly kind: "failed"; readonly why: string };

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    // One decode per cache file, however many requests ask for it.
    const inFlight = new Map<string, Promise<Generated>>();
    const { slot, release } = makeLimiter(MAX_DECODES);

    const generate = async (dir: string, id: string, path: string, key: string): Promise<Generated> => {
      const folder = waveformDir(dir);
      const file = join(folder, `${id}--${key}.json`);
      try {
        // A file that isn't inside the cache folder (a symlink pointing out) is never read.
        const real = await realpath(file);
        if (real.startsWith((await realpath(folder)) + sep)) return { kind: "ok", bytes: await readFile(real), from: "cache" };
      } catch {}
      await config.shellReady;
      const ffmpeg = await which("ffmpeg", process.env.PATH ?? "");
      if (!ffmpeg) return { kind: "failed", why: "ffmpeg isn't installed" };
      await slot();
      let decoded: Decoded;
      try {
        decoded = await decodePeaks(ffmpeg, path);
      } finally {
        release();
      }
      if (decoded.kind === "none") return decoded;
      if (decoded.kind === "failed") return { kind: "failed", why: "the sound couldn't be decoded" };
      const bytes = Buffer.from(JSON.stringify(decoded.waveform));
      // The peaks are good even if caching them fails (a read-only or full disk): answer anyway.
      try {
        await mkdir(folder, { recursive: true });
        // Written aside and renamed, so a reader never sees half a file; older peaks for this id go.
        const tmp = `${file}.tmp-${process.pid}`;
        await writeFile(tmp, bytes);
        await rename(tmp, file);
        const files = await readdir(folder).catch(() => [] as Array<string>);
        await Promise.all(files.filter((f) => isWaveformFileOf(f, id) && f !== `${id}--${key}.json`).map((f) => rm(join(folder, f), { force: true })));
      } catch {}
      return { kind: "ok", bytes, from: "decode" };
    };

    return HttpRouter.add(
      "GET",
      `${WAVEFORM_PATH}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url) || !tokensMatch(presentedToken(request.headers, url.value), config.token)) {
          return HttpServerResponse.text("Unauthorized", { status: 401, headers: CORS });
        }
        const id = decode(url.value.pathname.slice(WAVEFORM_PATH.length + 1));
        const open = yield* projects.current;
        if (!open || !id || !MEDIA_ID.test(id)) return notFound();
        const media = ((open.project as { media?: ReadonlyArray<{ id: string; kind?: string; path: string; probe?: { hasAudio?: boolean } }> }).media ?? []).find((m) => m.id === id);
        if (!media || typeof media.path !== "string") return notFound();
        if (media.kind === "image" || (media.kind === "video" && media.probe?.hasAudio === false)) return notFound("No sound");
        const path = isAbsolute(media.path) ? media.path : resolve(open.dir, media.path);
        const dir = open.dir;
        const result = yield* Effect.promise(async (): Promise<Generated | undefined> => {
          const key = await posterKey(path);
          if (!key) return undefined;
          const name = `${dir}\0${id}--${key}`;
          let job = inFlight.get(name);
          if (!job) {
            job = generate(dir, id, path, key)
              .catch((): Generated => ({ kind: "failed", why: "the peaks couldn't be made" }))
              .finally(() => inFlight.delete(name));
            inFlight.set(name, job);
          }
          return job;
        });
        // 404 means there is nothing to draw (the renderer stops asking); 503 that it may work later.
        if (!result) return notFound();
        if (result.kind === "none") return notFound("No sound");
        if (result.kind === "failed") return HttpServerResponse.text(`Waveform unavailable: ${result.why}`, { status: 503, headers: { ...CORS, "retry-after": "30" } });
        return HttpServerResponse.uint8Array(result.bytes, { contentType: "application/json", headers: { ...CORS, "cache-control": "no-store", "x-uncut-waveform": result.from } });
      }),
    );
  }),
);
