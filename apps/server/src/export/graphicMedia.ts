// The pictures of a project's media that graphics draw (D290, core graphicMedia.ts): one source for
// the preview's route, the export and render_frames, so all three get the same bytes.
// - A video: the frame on its own grid at t (core graphicMediaFrame), decoded from the original by
//   ffmpeg at the size asked (core graphicMediaSize: at most GRAPHIC_MEDIA_MAX_EDGE long), as an
//   uncompressed 24-bit BMP (nothing to encode here, quick to decode in Chromium, exact). A decoder
//   stays open per file and size and reads forward, so a graphic drawing consecutive frames (the
//   export, playback) costs one decode per frame, not one seek; a jump back or far ahead starts a
//   new one at that frame. Untagged files get the colours the export gives their clips.
//   The frame for t is picked by timestamp as a clip's is (plan/video.ts sourceFramePick: the last
//   frame that starts at or before t): on a constant-rate file that's frame floor(t × fps); a
//   variable-rate one (its r_frame_rate and avg_frame_rate differ) has its frames' times read once
//   with ffprobe, and the frame is found among them, so a fresh seek and a run read on agree.
//   Requests for one file and size take turns (one queue each); at most DECODERS decoders are open,
//   and only an idle one is ever stopped for another (a busy one is waited for), so many graphics
//   or sizes at once queue rather than evict each other. Nothing starts once the source is closed.
// - An image: decoded once at that size as a PNG (its alpha kept). An SVG is sent as it is.
// Pictures are kept in a small cache (by bytes), so the same frame asked again (another graphic,
// a re-render, the preview after the export) isn't decoded twice.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";

import { graphicMediaFrame, graphicMediaSize, type GraphicMediaRequest, type Media } from "@uncut/core";
import { withoutApiKey } from "../app/shellEnv.ts";
import { localInputs } from "../media/localInputs.ts";
import { run } from "./exporter/ffmpeg.ts";
import { untaggedFilter } from "./plan/video.ts";

export interface GraphicMediaPicture {
  readonly bytes: Buffer;
  readonly type: "image/bmp" | "image/png" | "image/svg+xml";
  readonly width: number;
  readonly height: number;
  /** A video's frame index (for tests and the cache). */
  readonly frame?: number;
}

export interface GraphicMediaSource {
  /** The picture a graphic asked for; rejects with a sentence for the graphic (unknown id, audio, unreadable file). */
  readonly picture: (req: GraphicMediaRequest) => Promise<GraphicMediaPicture>;
  /**
   * The same, written to a file for the rasteriser: a new file each time (in a folder of its own),
   * which the reader removes once it has read it (apps/desktop renderMedia.ts); close() removes the rest.
   */
  readonly file: (req: GraphicMediaRequest) => Promise<{ readonly file: string; readonly type: string }>;
  /** Stops every decoder and removes its files. */
  readonly close: () => void;
  /** How many decoders were started (tests: consecutive frames reuse one). */
  readonly starts: () => number;
}

interface VideoInfo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames?: number;
  /** Untagged colour (exportPlan untaggedFilter): its height, else undefined. */
  readonly untagged?: number;
  /** A variable-rate file: each frame's start (s from the file's start, ascending), from ffprobe. */
  readonly times?: ReadonlyArray<number>;
}

/** How late a frame may start and still be the one at t (s): sourceFramePick's 0.0001. */
const PICK_SLACK = 0.0001;

/** The frame on screen at t (s of the media): by its frames' times when it's variable-rate, else on its grid (core graphicMediaFrame). */
export function frameAt(info: Pick<VideoInfo, "fps" | "frames" | "times">, t: number): number {
  const times = info.times;
  if (!times?.length) return graphicMediaFrame(t, info.fps, info.frames);
  // The last frame starting at or before t (the first when t is before it).
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t + PICK_SLACK) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where to seek so that ffmpeg's exact seek gives frame n first: half a frame before it. */
const seekTo = (info: VideoInfo, n: number) => (info.times?.length ? (info.times[n - 1]! + info.times[n]!) / 2 : (n - 0.5) / info.fps);

/** A 24-bit top-down BMP of `raw` (bgr24 rows, no padding). */
export function bmpOf(raw: Buffer, width: number, height: number): Buffer {
  const row = width * 3;
  const stride = (row + 3) & ~3;
  const out = Buffer.alloc(54 + stride * height);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(-height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * height, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  if (stride === row) raw.copy(out, 54, 0, row * height);
  else for (let y = 0; y < height; y++) raw.copy(out, 54 + y * stride, y * row, (y + 1) * row);
  return out;
}

const rate = (s: string | undefined) => {
  const [a, b] = (s ?? "").split("/").map(Number);
  const v = b ? a! / b : a!;
  return Number.isFinite(v) && v > 0 && v < 1000 ? v : undefined;
};

/** A video's upright size, frame rate, frame count and colour tags, from ffprobe. */
async function probeVideo(bin: string, path: string): Promise<VideoInfo> {
  const ffprobe = join(dirname(bin), "ffprobe");
  const r = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,color_space:stream_side_data=rotation:stream_tags=rotate:format=duration,start_time", "-of", "json", path], undefined);
  type Stream = { width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; nb_frames?: string; duration?: string; color_space?: string; side_data_list?: Array<{ rotation?: number }>; tags?: { rotate?: string } };
  let parsed: { streams?: Array<Stream>; format?: { duration?: string; start_time?: string } } = {};
  try {
    parsed = JSON.parse(r.stdout);
  } catch {}
  const s = parsed.streams?.[0];
  if (r.code !== 0 || !s?.width || !s.height) throw new Error("its video couldn't be read");
  const rotation = Number(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0);
  const turned = Math.abs(rotation) % 180 === 90;
  const fps = rate(s.avg_frame_rate) ?? rate(s.r_frame_rate) ?? 30;
  const duration = Number(s.duration ?? parsed.format?.duration);
  const counted = Number(s.nb_frames);
  const frames = Number.isInteger(counted) && counted > 0 ? counted : Number.isFinite(duration) && duration > 0 ? Math.max(1, Math.round(duration * fps)) : undefined;
  const base = { width: turned ? s.height : s.width, height: turned ? s.width : s.height, fps, ...(frames ? { frames } : {}), ...(!s.color_space || s.color_space === "unknown" ? { untagged: s.height } : {}) };
  // Variable rate (its nominal and average rates differ): the frames' own times.
  const nominal = rate(s.r_frame_rate);
  const average = rate(s.avg_frame_rate);
  if (!nominal || !average || Math.abs(nominal - average) <= 1e-3 * nominal) return base;
  const times = await frameTimes(ffprobe, path, Number(parsed.format?.start_time) || 0);
  return times.length ? { ...base, frames: times.length, times } : base;
}

/** A video's frames' start times (s from the file's start, as ffmpeg's -ss counts), ascending: its packets' pts without decoding. */
async function frameTimes(ffprobe: string, path: string, start: number): Promise<Array<number>> {
  const r = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path], undefined);
  if (r.code !== 0) return [];
  const times: Array<number> = [];
  for (const line of r.stdout.split("\n")) {
    const [pts, flags = ""] = line.trim().split(",");
    const t = Number(pts);
    // A packet the demuxer drops (an edit list's discard flag) is never shown.
    if (pts && Number.isFinite(t) && !flags.includes("D")) times.push(t - start);
  }
  return times.sort((a, b) => a - b);
}

/** One open decoder of a file at one size: frame `next` comes next on its stdout. */
interface Decoder {
  readonly child: ChildProcess;
  next: number;
  last?: { readonly n: number; readonly raw: Buffer };
  readonly read: () => Promise<Buffer | undefined>;
  idle?: NodeJS.Timeout;
}

/** Reads exactly `size` bytes at a time from a stream (undefined at its end). */
function frameReader(stream: NodeJS.ReadableStream, size: number) {
  const chunks: Array<Buffer> = [];
  let have = 0;
  let ended = false;
  let wake: (() => void) | undefined;
  stream.on("data", (d: Buffer) => {
    chunks.push(d);
    have += d.length;
    if (have >= size) stream.pause();
    wake?.();
  });
  stream.on("end", () => {
    ended = true;
    wake?.();
  });
  stream.on("error", () => {
    ended = true;
    wake?.();
  });
  return async (): Promise<Buffer | undefined> => {
    while (have < size && !ended) {
      stream.resume();
      await new Promise<void>((r) => (wake = r));
      wake = undefined;
    }
    if (have < size) return undefined;
    const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    chunks.length = 0;
    if (all.length > size) chunks.push(all.subarray(size));
    have = all.length - size;
    return all.subarray(0, size);
  };
}

const IMAGE_TYPES: Readonly<Record<string, GraphicMediaPicture["type"]>> = { ".svg": "image/svg+xml" };
/** How far ahead a decoder reads on rather than seeking again (seconds of the media). */
const READ_AHEAD_S = 3;
const DECODERS = 4;
const IDLE_MS = 20_000;
const CACHE_BYTES = 192 * 1024 * 1024;

/**
 * The source of media pictures for graphics. `media` gives the project's media as they are now
 * (the preview's project changes), `mediaPath` where each one's file is; `videotoolbox` decodes on
 * the Mac's media engine (ffmpeg caps.videotoolboxDecode).
 */
export function graphicMediaSource(opts: { readonly bin: string; readonly media: () => ReadonlyArray<Media>; readonly mediaPath: (m: Media) => string; readonly videotoolbox?: boolean }): GraphicMediaSource {
  const infos = new Map<string, Promise<VideoInfo>>();
  const decoders = new Map<string, Decoder>();
  // One queue per file and size: its requests take turns, so only one ever reads or restarts its decoder.
  const queues = new Map<string, { tail: Promise<void>; users: number }>();
  // Requests waiting for a decoder to go idle (every open one busy).
  const waiting: Array<() => void> = [];
  const cache = new Map<string, Promise<GraphicMediaPicture>>();
  const sizes = new Map<string, number>();
  // The last frame asked of each file at each size (for reading ahead).
  const lastAsked = new Map<string, number>();
  let cached = 0;
  let started = 0;
  let closed = false;
  let folder: string | undefined;
  let written = 0;
  const closedError = () => new Error("closed");

  const remember = (key: string, picture: Promise<GraphicMediaPicture>) => {
    cache.set(key, picture);
    picture.then(
      (p) => {
        if (!cache.has(key)) return;
        sizes.set(key, p.bytes.length);
        cached += p.bytes.length;
        // Oldest first (Map order is insertion; a hit moves its entry to the end).
        for (const [k] of cache) {
          if (cached <= CACHE_BYTES || k === key) break;
          cached -= sizes.get(k) ?? 0;
          sizes.delete(k);
          cache.delete(k);
        }
      },
      () => cache.delete(key),
    );
    return picture;
  };

  const wake = () => {
    for (const go of waiting.splice(0)) go();
  };

  const stop = (key: string) => {
    const d = decoders.get(key);
    if (!d) return;
    decoders.delete(key);
    clearTimeout(d.idle);
    d.child.stdout?.removeAllListeners("data");
    d.child.kill("SIGKILL");
    wake();
  };

  /** Run `job` in `key`'s queue, after the requests before it. */
  const inTurn = <T>(key: string, job: () => Promise<T>): Promise<T> => {
    let q = queues.get(key);
    if (!q) queues.set(key, (q = { tail: Promise.resolve(), users: 0 }));
    const queue = q;
    queue.users++;
    const done = queue.tail.then(job);
    queue.tail = done.then(
      () => {},
      () => {},
    ).then(() => {
      if (--queue.users > 0) return;
      queues.delete(key);
      wake();
    });
    return done;
  };

  /** Room for one more decoder: the least recently used idle one stopped, else wait until one is idle. Never a busy one. */
  const room = async () => {
    while (decoders.size >= DECODERS) {
      if (closed) throw closedError();
      const idle = [...decoders.keys()].find((k) => !queues.has(k));
      if (idle !== undefined) return stop(idle);
      await new Promise<void>((go) => waiting.push(go));
    }
  };

  const startDecoder = (key: string, path: string, info: VideoInfo, width: number, height: number, from: number): Decoder => {
    // Seek half a frame early: ffmpeg's exact seek gives the first frame at or after it, frame `from`.
    const seek = from > 0 ? ["-ss", seekTo(info, from).toFixed(6)] : [];
    const args = [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      ...(opts.videotoolbox ? ["-hwaccel", "videotoolbox"] : []),
      ...seek,
      "-i",
      path,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-fps_mode",
      "passthrough",
      "-vf",
      `${untaggedFilter(info.untagged)}scale=w=${width}:h=${height}:flags=bicubic,format=bgr24`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgr24",
      "pipe:1",
    ];
    const child = spawn(opts.bin, localInputs(opts.bin, args), { env: withoutApiKey(process.env), stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", () => {});
    started++;
    const d: Decoder = { child, next: from, read: frameReader(child.stdout!, width * height * 3) };
    decoders.set(key, d);
    return d;
  };

  /**
   * Frame n of a video at width × height, raw bgr24: read on from its open decoder when it's just
   * ahead, else from a new one; undefined past the stream's real end. A read-ahead never starts a decoder.
   */
  const videoFrame = (path: string, info: VideoInfo, width: number, height: number, n: number, readAhead = false): Promise<{ raw: Buffer; n: number }> => {
    const key = `${path}|${width}x${height}`;
    return inTurn(key, async () => {
      if (closed) throw closedError();
      let d = decoders.get(key);
      if (d && d.last?.n === n) return { raw: d.last.raw, n };
      const ahead = Math.max(30, Math.ceil(READ_AHEAD_S * info.fps));
      if (!d || n < d.next || n - d.next > ahead) {
        if (readAhead) throw new Error("superseded");
        stop(key);
        await room();
        if (closed) throw closedError();
        d = startDecoder(key, path, info, width, height, n);
      } else {
        // Most recently used goes to the end.
        decoders.delete(key);
        decoders.set(key, d);
      }
      const decoder = d;
      clearTimeout(decoder.idle);
      while (decoder.next <= n) {
        const raw = await decoder.read();
        if (!raw) break;
        decoder.last = { n: decoder.next, raw: Buffer.from(raw) };
        decoder.next++;
      }
      // Only close() stops a decoder while its queue is busy.
      if (decoders.get(key) !== decoder) throw closedError();
      if (decoder.last && decoder.last.n <= n) {
        decoder.idle = setTimeout(() => decoders.get(key) === decoder && !queues.has(key) && stop(key), IDLE_MS);
        decoder.idle.unref?.();
        return { raw: decoder.last.raw, n: decoder.last.n };
      }
      // Nothing at or before n (a seek past the stream's real end).
      stop(key);
      return undefined;
    }).then((got) => {
      if (got) return got;
      if (readAhead) throw new Error("past the end");
      // The last frame, from a little earlier.
      const back = Math.max(0, n - Math.ceil(info.fps));
      if (n > 0) return videoFrame(path, { ...info, frames: Math.max(1, back) }, width, height, back);
      throw new Error("its video has no frames ffmpeg can read");
    });
  };

  const imagePicture = async (path: string, ask: GraphicMediaRequest): Promise<GraphicMediaPicture> => {
    const type = IMAGE_TYPES[extname(path).toLowerCase()];
    if (type) return { bytes: await readFile(path), type, width: 0, height: 0 };
    const info = await probeVideo(opts.bin, path);
    const { width, height } = graphicMediaSize(info.width, info.height, ask);
    const r = await new Promise<{ code: number | null; out: Buffer }>((resolve, reject) => {
      const child = spawn(opts.bin, localInputs(opts.bin, ["-hide_banner", "-nostdin", "-v", "error", "-i", path, "-frames:v", "1", "-vf", `scale=w=${width}:h=${height}:flags=bicubic,format=rgba`, "-c:v", "png", "-f", "image2pipe", "pipe:1"]), { env: withoutApiKey(process.env), stdio: ["ignore", "pipe", "ignore"] });
      const parts: Array<Buffer> = [];
      child.stdout.on("data", (d: Buffer) => parts.push(d));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, out: Buffer.concat(parts) }));
    });
    if (r.code !== 0 || !r.out.length) throw new Error("the image couldn't be read");
    return { bytes: r.out, type: "image/png", width, height };
  };

  const picture = (req: GraphicMediaRequest): Promise<GraphicMediaPicture> => {
    if (closed) return Promise.reject(new Error("closed"));
    const media = opts.media().find((m) => m.id === req.id);
    if (!media) return Promise.reject(new Error(`there's no media ${req.id} in this project (project_read lists the media and their ids)`));
    if (media.kind === "audio") return Promise.reject(new Error(`${media.name} is a sound, not a picture`));
    const path = opts.mediaPath(media);
    const named = (p: Promise<GraphicMediaPicture>) => p.catch((error: Error) => Promise.reject(new Error(`${media.name}: ${error.message}`)));
    if (media.kind === "image") {
      const key = `${path}|${req.w ?? 0}x${req.h ?? 0}`;
      return named(cache.get(key) ?? remember(key, imagePicture(path, req)));
    }
    return named(
      (async () => {
        let info = infos.get(path);
        if (!info) {
          info = probeVideo(opts.bin, path);
          infos.set(path, info);
          info.catch(() => infos.delete(path));
        }
        const v = await info;
        const { width, height } = graphicMediaSize(v.width, v.height, req);
        const n = frameAt(v, req.t);
        const decode = (k: number, ahead = false) => videoFrame(path, v, width, height, k, ahead).then(({ raw, n: shown }) => ({ bytes: bmpOf(raw, width, height), type: "image/bmp" as const, width, height, frame: shown }));
        const frameKey = (k: number) => `${path}|${width}x${height}|${k}`;
        const key = frameKey(n);
        let got = cache.get(key);
        if (got) {
          cache.delete(key);
          cache.set(key, got);
        } else got = remember(key, decode(n));
        // The next frame the graphic will likely ask for (the stride of its last two asks: the
        // export steps through its frames), decoded while this one is drawn.
        const run = `${path}|${width}x${height}`;
        const stride = n - (lastAsked.get(run) ?? n - 1);
        lastAsked.set(run, n);
        const ahead = n + (stride >= 1 && stride <= Math.ceil(v.fps) ? stride : 1);
        if (!v.frames || ahead < v.frames)
          got.then(
            () => {
              // Only by reading on: a read-ahead never starts a decoder (a cache hit far back would).
              const d = decoders.get(run);
              const reads = !!d && ahead >= d.next && ahead - d.next <= Math.max(30, Math.ceil(READ_AHEAD_S * v.fps));
              // Not while a request waits for a decoder to go idle (this one would keep it busy).
              if (!closed && reads && !waiting.length && !cache.has(frameKey(ahead))) remember(frameKey(ahead), decode(ahead, true)).catch(() => {});
            },
            () => {},
          );
        return got;
      })(),
    );
  };

  return {
    picture,
    file: async (req) => {
      const p = await picture(req);
      // Asked before close, answered after: no new folder.
      if (closed) throw closedError();
      folder ??= mkdtempSync(join(tmpdir(), "uncut-graphic-media-"));
      // A new file each time: the reader removes it once read, so none is rewritten while it's read.
      const file = join(folder, `m${written++}${p.type === "image/bmp" ? ".bmp" : p.type === "image/png" ? ".png" : ".svg"}`);
      await writeFile(file, p.bytes);
      return { file, type: p.type };
    },
    close: () => {
      closed = true;
      for (const key of [...decoders.keys()]) stop(key);
      wake();
      cache.clear();
      if (folder) rmSync(folder, { recursive: true, force: true });
    },
    starts: () => started,
  };
}
