// D221: the scrub frame cache (issue #12 item 3). While the preview is paused or shuttling (J/L at
// another speed), a clip's exact frames come from here instead of a <video> seek: WebCodecs decodes
// the frames around the playhead ahead of time (from the file the <video> plays, proxy or original,
// fetched with byte ranges from the same token-gated route), and the preview draws the cached one
// into a canvas over the hidden <video>. Playback at 1× stays on <video> (its clock and the mix).
//
// - The sample table comes from core's mp4index (MP4/MOV, H.264/HEVC, one edit). Anything else
//   (WebM, fragmented, a codec WebCodecs refuses here, HDR transfer) keeps the <video> path.
// - The frame shown at t is the one <video> shows: the last sample presented at or before t.
// - Frames are kept as ImageBitmaps (the decoder's VideoFrame closed at once, so the decoder never
//   runs out of buffers), at most SCRUB_MAX_SIDE on the long side, in one LRU of ≤ the budget
//   (300 MB by default) over every source, evicted oldest first and closed.
// - Keys are a source (the URL the <video> plays, which changes with a relinked file or a new proxy)
//   and a sample: edits (trim, speed, effects) never invalidate a frame, they only ask for another.
//   A file changed in place (another size or modification time on any range read) drops its frames.
import { keyframeOf, readMp4Index, sampleAt, type Mp4Index, type StreamColour } from "@uncut/core/mp4index";

/** Longest side of a cached frame (a 4K original is kept at 1920 wide; proxies are 1280). */
export const SCRUB_MAX_SIDE = 1920;
/** Default byte budget of the whole cache. */
export const SCRUB_BUDGET = 300 * 1024 * 1024;
/** Largest byte range read at once while decoding a long GOP. */
const READ_SPAN = 2 * 1024 * 1024;

/** An LRU of closable values with a byte budget (pure: unit-tested in node). */
export class FrameLru<V> {
  private readonly entries = new Map<string, { value: V; bytes: number; close: () => void }>();
  bytes = 0;
  budget: number;
  constructor(budget: number) {
    this.budget = budget;
  }

  get size() {
    return this.entries.size;
  }
  has(key: string) {
    return this.entries.has(key);
  }
  /** The value, made the most recently used. */
  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }
  /** Adds a value; the oldest go (closed) until the budget holds. One bigger than the budget is closed at once. */
  put(key: string, value: V, bytes: number, close: () => void): boolean {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.bytes;
      old.close();
    }
    if (bytes > this.budget) {
      close();
      return false;
    }
    this.entries.set(key, { value, bytes, close });
    this.bytes += bytes;
    this.trim();
    return true;
  }
  setBudget(budget: number) {
    this.budget = budget;
    this.trim();
  }
  private trim() {
    for (const [k, e] of this.entries) {
      if (this.bytes <= this.budget) break;
      this.entries.delete(k);
      this.bytes -= e.bytes;
      e.close();
    }
  }
  /** Drops (and closes) every entry whose key matches. */
  dropWhere(match: (key: string) => boolean) {
    for (const [k, e] of [...this.entries]) {
      if (!match(k)) continue;
      this.entries.delete(k);
      this.bytes -= e.bytes;
      e.close();
    }
  }
  clear() {
    this.dropWhere(() => true);
  }
}

/** The frame size a cache entry is kept at: the display size, the long side capped. */
export function cachedSize(width: number, height: number, max = SCRUB_MAX_SIDE) {
  const k = Math.min(1, max / Math.max(width, height, 1));
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) };
}

/**
 * The samples worth having around presentation rank `r` (of `count`), nearest first in the
 * direction of travel: ahead of a forward scrub, behind a backward one, both ways when still.
 */
export function windowRanks(r: number, count: number, dir: -1 | 0 | 1, span: number): Array<number> {
  const out: Array<number> = [r];
  const ahead = dir === 0 ? Math.ceil(span / 2) : span;
  const behind = dir === 0 ? Math.ceil(span / 2) : 2;
  const fwd = dir >= 0 ? ahead : behind;
  const back = dir >= 0 ? behind : ahead;
  for (let i = 1; i <= Math.max(fwd, back); i++) {
    if (dir >= 0) {
      if (i <= fwd && r + i < count) out.push(r + i);
      if (i <= back && r - i >= 0) out.push(r - i);
    } else {
      if (i <= back && r - i >= 0) out.push(r - i);
      if (i <= fwd && r + i < count) out.push(r + i);
    }
  }
  return out;
}

const PRIMARIES: Record<number, VideoColorPrimaries> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020" as VideoColorPrimaries, 12: "smpte432" as VideoColorPrimaries };
const TRANSFER: Record<number, VideoTransferCharacteristics> = { 1: "bt709", 6: "smpte170m", 13: "iec61966-2-1", 8: "linear" as VideoTransferCharacteristics, 16: "pq" as VideoTransferCharacteristics, 18: "hlg" as VideoTransferCharacteristics };
const MATRIX: Record<number, VideoMatrixCoefficients> = { 0: "rgb", 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020-ncl" as VideoMatrixCoefficients };

/**
 * The colour space to decode with, so frames look as the <video> shows them: the footage's own
 * description, with what it leaves unspecified read the way Chromium's <video> reads it (BT.601
 * below 720 lines, BT.709 from there, limited range) instead of WebCodecs' BT.709 default. Undefined (WebCodecs' own
 * reading) when the description is unknown or uses a code WebCodecs can't name.
 */
export function decoderColour(c: StreamColour | undefined, height: number): VideoColorSpaceInit | undefined {
  if (!c) return undefined;
  const pick = <T>(table: Record<number, T>, v: number | undefined, fallback: T) => (v === undefined ? fallback : table[v]);
  // Chromium's <video> guesses from the size: BT.601 below 720 lines, BT.709 from there (measured).
  const matrix = pick(MATRIX, c.matrix, (height < 720 ? "smpte170m" : "bt709") as VideoMatrixCoefficients);
  const primaries = pick(PRIMARIES, c.primaries, matrix === "bt709" ? "bt709" : ("smpte170m" as VideoColorPrimaries));
  const transfer = pick(TRANSFER, c.transfer, (height < 720 ? "smpte170m" : "bt709") as VideoTransferCharacteristics);
  if (!matrix || !primaries || !transfer) return undefined;
  return { matrix, primaries, transfer, fullRange: c.fullRange ?? false };
}

/**
 * Whether macOS lifts this footage's mid-tones when it shows the <video> (tone.ts): measured for
 * the BT.709 transfer (tagged, or untagged from 720 lines up), not for BT.601's (untagged SD).
 */
export function liftsTone(c: StreamColour | undefined, height: number): boolean {
  return (c?.transfer ?? (height < 720 ? 6 : 1)) === 1;
}

/** Whether a range response still describes the file the index was made from. */
export function sameFile(known: { size: number; modified: string | undefined }, contentRange: string | null, modified: string | null) {
  const total = Number(/\/(\d+)\s*$/.exec(contentRange ?? "")?.[1]);
  if (Number.isFinite(total) && total !== known.size) return false;
  return !(known.modified && modified && modified !== known.modified);
}

/** What one source's decode is doing. */
interface Job {
  readonly gen: number;
  /** The keyframe it decodes from and the last sample (decode order) it feeds. */
  readonly from: number;
  readonly upTo: number;
  /** Samples it keeps (the rest are decoded only as references). */
  readonly wanted: Set<number>;
  /** The furthest sample fed so far. */
  fed: number;
}

let sourceSeq = 0;

/** One file's index and decoder. */
class ScrubSource {
  readonly id = ++sourceSeq;
  state: "loading" | "ready" | "broken" = "loading";
  /** The decoded frames' colour space, as WebCodecs reports it (for diagnosis). */
  colour = "";
  /** What the stream says and what the decoder was configured with (for diagnosis). */
  colourIn = "";
  /** Whether the <video> of this file is shown with its mid-tones lifted (tone.ts). */
  lift = false;
  /** Why it isn't used (for diagnosis). */
  reason = "";
  index: Mp4Index | undefined;
  private file = { size: 0, modified: undefined as string | undefined };
  private decoder: VideoDecoder | undefined;
  private config: VideoDecoderConfig | undefined;
  private job: Job | undefined;
  private gen = 0;
  private target: { sample: number; dir: -1 | 0 | 1 } | undefined;
  private readonly byTimestamp = new Map<number, number>();
  // A target that wasn't cached when asked: when, for the miss timings in stats().
  private missAt: { sample: number; at: number } | undefined;
  private scratch: OffscreenCanvas | undefined;
  private size = { w: 0, h: 0 };
  // Samples tried and not output (a leading picture that needs the GOP before): decoded from an earlier keyframe next time.
  private readonly earlier = new Set<number>();

  readonly url: string;
  private readonly cache: ScrubCache;
  // Samples that never came out even from the keyframe before: left to the <video>.
  private readonly hopeless = new Set<number>();

  constructor(url: string, cache: ScrubCache) {
    this.url = url;
    this.cache = cache;
    void this.init();
  }

  private key(sample: number) {
    return `${this.id}|${sample}`;
  }

  private fail(reason: string) {
    this.state = "broken";
    this.reason = reason;
    this.close();
    this.cache.changed();
  }

  /** Bytes [offset, offset + length) of the file, checked against the file the index came from. */
  private async read(offset: number, length: number): Promise<Uint8Array> {
    const r = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (this.state !== "loading" && !sameFile(this.file, r.headers.get("content-range"), r.headers.get("last-modified"))) {
      this.cache.forget(this);
      throw new Error("the file changed");
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    return r.status === 200 ? bytes.subarray(offset, offset + length) : bytes;
  }

  private async init() {
    try {
      if (typeof VideoDecoder === "undefined") return this.fail("no WebCodecs");
      const head = await fetch(this.url, { headers: { Range: "bytes=0-15" } });
      const size = Number(/\/(\d+)\s*$/.exec(head.headers.get("content-range") ?? "")?.[1] ?? head.headers.get("content-length"));
      await head.arrayBuffer().catch(() => {});
      if (!head.ok || !Number.isFinite(size) || size <= 0) return this.fail(`no size (HTTP ${head.status})`);
      this.file = { size, modified: head.headers.get("last-modified") ?? undefined };
      const index = await readMp4Index((o, l) => this.read(o, l), size);
      if (!index) return this.fail("not an indexable MP4/MOV with H.264 or HEVC");
      const colorSpace = decoderColour(index.colour, index.codedHeight);
      this.lift = liftsTone(index.colour, index.codedHeight);
      this.colourIn = JSON.stringify({ stream: index.colour ?? "unknown", config: colorSpace ?? "webcodecs" });
      const config: VideoDecoderConfig = { codec: index.codec, description: index.description, codedWidth: index.codedWidth, codedHeight: index.codedHeight, optimizeForLatency: true, ...(colorSpace ? { colorSpace } : {}) };
      const support = await VideoDecoder.isConfigSupported(config).catch(() => undefined);
      if (!support?.supported) return this.fail(`${index.codec} isn't decodable here`);
      if (this.state === "broken") return;
      this.index = index;
      this.config = config;
      for (let i = 0; i < index.pts.length; i++) this.byTimestamp.set(Math.round(index.pts[i]! * 1e6), i);
      this.state = "ready";
      this.cache.changed();
      this.pump();
    } catch (error) {
      this.fail(String((error as Error).message ?? error));
    }
  }

  /** Light enough (≤ 1080p) that a <video> seek may race the cache on a miss. */
  get light() {
    return !!this.index && this.index.codedWidth * this.index.codedHeight <= 1920 * 1088;
  }

  /** The sample shown at t (seconds into the file), if indexed. */
  sampleAt(t: number) {
    return this.index ? sampleAt(this.index, t) : undefined;
  }

  /** The cached frame shown at t, if there is one. */
  frame(t: number): { bitmap: ImageBitmap; sample: number; pts: number } | undefined {
    if (this.state !== "ready" || !this.index) return undefined;
    const sample = sampleAt(this.index, t);
    const bitmap = this.cache.lru.get(this.key(sample));
    return bitmap ? { bitmap, sample, pts: this.index.pts[sample]! } : undefined;
  }

  /** Have the frame at t (and the window around it, in the direction of travel) decoded. */
  want(t: number, dir: -1 | 0 | 1) {
    if (this.state !== "ready" || !this.index) return;
    const sample = sampleAt(this.index, t);
    if (this.target?.sample === sample && this.target.dir === dir) return;
    this.target = { sample, dir };
    if (!this.cache.lru.has(this.key(sample))) this.missAt = { sample, at: performance.now() };
    this.pump();
  }

  /** How many frames around the playhead to keep, from the frame size and the budget. */
  private span() {
    const guess = cachedSize(this.index!.codedWidth, this.index!.codedHeight);
    const bytes = Math.max(1, (this.size.w * this.size.h || guess.w * guess.h) * 4);
    return Math.max(2, Math.min(30, Math.floor((this.cache.lru.budget * 0.5) / Math.max(1, this.cache.active()) / bytes)));
  }

  /** Starts (or keeps) the decode that brings the next missing frame of the window. */
  private pump() {
    const index = this.index;
    if (this.state !== "ready" || !index || !this.target) return;
    const { sample, dir } = this.target;
    const ranks = windowRanks(index.rank[sample]!, index.order.length, dir, this.span());
    const window = ranks.map((r) => index.order[r]!);
    const missing = window.filter((s) => !this.hopeless.has(s) && !this.cache.lru.has(this.key(s)));
    const job = this.job;
    if (!missing.length) return;
    const first = missing[0]!;
    const gopOf = (s: number) => (this.earlier.has(s) ? keyframeOf(index, Math.max(0, keyframeOf(index, s) - 1)) : keyframeOf(index, s));
    if (job) {
      // The running decode still brings the first missing frame: let it.
      if (job.wanted.has(first) && gopOf(first) === job.from && first <= job.upTo) return;
      // Otherwise, start over where it's needed (dropping what's queued).
      this.abort();
    }
    const from = gopOf(first);
    let nextKey = keyframeOf(index, first) + 1;
    while (nextKey < index.key.length && !index.key[nextKey]) nextKey++;
    // The playhead's own frame first and alone (converting the window's other frames would delay it); the window next.
    const inGop = first === sample ? [first] : missing.filter((s) => s >= from && s < nextKey);
    const upTo = Math.max(...inGop);
    void this.decode({ gen: ++this.gen, from, upTo, wanted: new Set(inGop), fed: from - 1 });
  }

  private abort() {
    this.job = undefined;
    this.gen++;
    if (this.decoder && this.decoder.state === "configured") this.decoder.reset();
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state !== "closed") {
      if (this.decoder.state === "unconfigured") this.decoder.configure(this.config!);
      return this.decoder;
    }
    const decoder = new VideoDecoder({
      output: (frame) => this.output(frame),
      error: (e) => {
        // A decode error on this file: the <video> path takes over for it.
        if (this.decoder === decoder) this.fail(`decoder: ${e.message}`);
      },
    });
    decoder.configure(this.config!);
    this.decoder = decoder;
    return decoder;
  }

  private async decode(job: Job) {
    const index = this.index!;
    this.job = job;
    try {
      const decoder = this.ensureDecoder();
      // Batches of samples read with one range request each; the next batch is read while this one decodes.
      const batches: Array<{ first: number; last: number; start: number; end: number }> = [];
      for (let s = job.from; s <= job.upTo; ) {
        const start = index.offsets[s]!;
        let end = start + index.sizes[s]!;
        let last = s;
        while (last + 1 <= job.upTo) {
          const lo = Math.min(start, index.offsets[last + 1]!);
          const hi = Math.max(end, index.offsets[last + 1]! + index.sizes[last + 1]!);
          if (hi - lo > READ_SPAN || lo < start) break;
          end = hi;
          last++;
        }
        batches.push({ first: s, last, start, end });
        s = last + 1;
      }
      const readBatch = (b: (typeof batches)[number]) => this.read(b.start, b.end - b.start);
      let next = readBatch(batches[0]!);
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b]!;
        const bytes = await next;
        if (job.gen !== this.gen) return;
        if (b + 1 < batches.length) {
          next = readBatch(batches[b + 1]!);
          next.catch(() => {});
        }
        for (let i = batch.first; i <= batch.last; i++) {
          while (decoder.decodeQueueSize > 16) {
            await new Promise((r) => decoder.addEventListener("dequeue", r, { once: true }));
            if (job.gen !== this.gen) return;
          }
          const at = index.offsets[i]! - batch.start;
          decoder.decode(new EncodedVideoChunk({ type: index.key[i] ? "key" : "delta", timestamp: Math.round(index.pts[i]! * 1e6), duration: Math.round(index.durations[i]! * 1e6), data: bytes.subarray(at, at + index.sizes[i]!) }));
          job.fed = i;
        }
      }
      await decoder.flush();
      if (job.gen !== this.gen) return;
      // A wanted frame that never came out (a leading picture of an open GOP): next time from the keyframe before.
      for (const w of job.wanted) {
        if (this.cache.lru.has(this.key(w))) continue;
        if (!this.earlier.has(w) && job.from > 0) this.earlier.add(w);
        else this.hopeless.add(w);
      }
      this.job = undefined;
      this.pump();
    } catch (error) {
      if (job.gen !== this.gen) return; // aborted (reset rejects the flush)
      this.job = undefined;
      if ((error as Error).name === "AbortError") return;
      this.fail(String((error as Error).message ?? error));
    }
  }

  private output(frame: VideoFrame) {
    const sample = this.byTimestamp.get(frame.timestamp);
    const job = this.job;
    try {
      if (sample === undefined || !job || !job.wanted.has(sample)) return;
      // HDR footage would be tone-mapped differently from the <video>: leave it to the <video>.
      const transfer = frame.colorSpace?.transfer as string | null | undefined;
      if (transfer === "pq" || transfer === "hlg") {
        queueMicrotask(() => this.fail(`HDR (${transfer})`));
        return;
      }
      if (!this.colour) this.colour = JSON.stringify(frame.colorSpace?.toJSON?.() ?? {});
      const turn = this.index!.rotation;
      const dw = turn % 180 ? frame.displayHeight : frame.displayWidth;
      const dh = turn % 180 ? frame.displayWidth : frame.displayHeight;
      const { w, h } = cachedSize(dw, dh);
      this.size = { w, h };
      if (!this.scratch) this.scratch = new OffscreenCanvas(w, h);
      if (this.scratch.width !== w) this.scratch.width = w;
      if (this.scratch.height !== h) this.scratch.height = h;
      const ctx = this.scratch.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (turn) {
        ctx.translate(w / 2, h / 2);
        ctx.rotate((turn * Math.PI) / 180);
        const [rw, rh] = turn % 180 ? [h, w] : [w, h];
        ctx.drawImage(frame, -rw / 2, -rh / 2, rw, rh);
      } else ctx.drawImage(frame, 0, 0, w, h);
      const bitmap = this.scratch.transferToImageBitmap();
      this.cache.lru.put(this.key(sample), bitmap, w * h * 4, () => bitmap.close());
      // The playhead's frame is drawn now, not on the next animation frame.
      if (this.target?.sample === sample) this.cache.changed(true);
      else this.cache.changed();
      if (this.missAt?.sample === sample) {
        this.cache.misses.push(performance.now() - this.missAt.at);
        if (this.cache.misses.length > 100) this.cache.misses.shift();
        this.missAt = undefined;
      }
    } finally {
      frame.close();
    }
  }

  close() {
    this.gen++;
    this.job = undefined;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
  }

  /** Its frames out of the cache. */
  drop() {
    this.close();
    const prefix = `${this.id}|`;
    this.cache.lru.dropWhere((k) => k.startsWith(prefix));
  }
}

const BUDGET_KEY = "uncut.preview.scrubCacheMB";
const budgetSetting = () => {
  try {
    const mb = Number(globalThis.localStorage?.getItem(BUDGET_KEY));
    return mb > 0 ? mb * 1024 * 1024 : SCRUB_BUDGET;
  } catch {
    return SCRUB_BUDGET;
  }
};

/** Every source the preview scrubs, and the one LRU their frames share. */
export class ScrubCache {
  readonly lru = new FrameLru<ImageBitmap>(budgetSetting());
  private readonly sources = new Map<string, ScrubSource>();
  /** The last decode times of frames that weren't cached when asked (ms, from want() to the frame). */
  readonly misses: Array<number> = [];
  /** Tests: keep the canvas up at rest (the <video> otherwise takes over once it has caught up). */
  keep = false;
  private used = new Set<string>();
  private scheduled = 0;

  private readonly onFrame: () => void;

  constructor(onFrame: () => void) {
    this.onFrame = onFrame;
    (globalThis as { __uncutScrub?: unknown }).__uncutScrub = { stats: () => this.stats(), setBudget: (bytes: number) => this.lru.setBudget(bytes), keep: (on: boolean) => {
        this.keep = on;
        this.changed();
      },
    };
  }

  stats() {
    return {
      bytes: this.lru.bytes,
      budget: this.lru.budget,
      frames: this.lru.size,
      misses: [...this.misses],
      sources: [...this.sources.values()].map((s) => ({ url: s.url.replace(/[?&]token=[^&]*/, ""), state: s.state, reason: s.reason, colour: s.colour, colourIn: s.colourIn })),
    };
  }

  /** Sources being scrubbed now (they share the window budget). */
  active() {
    return Math.max(1, this.used.size);
  }

  /** The source of a URL if there is one, without asking for it. */
  peek(url: string): ScrubSource | undefined {
    return this.sources.get(url);
  }

  /** The source of a URL (made on first use; a broken one stays broken: the <video> plays it). */
  source(url: string): ScrubSource {
    this.used.add(url);
    let s = this.sources.get(url);
    if (!s) {
      s = new ScrubSource(url, this);
      this.sources.set(url, s);
    }
    return s;
  }

  /** A source whose file changed in place: its frames go and the next use starts it over. */
  forget(s: ScrubSource) {
    if (this.sources.get(s.url) === s) this.sources.delete(s.url);
    s.drop();
    this.changed();
  }

  /**
   * After a render: sources no clip used stop decoding; a media item now played from another URL
   * (relinked, a new proxy, proxies turned on or off) drops the old one's frames.
   */
  sweep() {
    const usedIds = new Map<string, string>();
    for (const u of this.used) usedIds.set(mediaIdOf(u), u);
    for (const [url, s] of [...this.sources]) {
      if (this.used.has(url)) continue;
      const now = usedIds.get(mediaIdOf(url));
      if (now !== undefined && now !== url) {
        this.sources.delete(url);
        s.drop();
      } else s.close();
    }
    this.used = new Set();
  }

  /** A new frame (or a source's state): one render on the next animation frame, or `now` for the playhead's frame. */
  changed(now = false) {
    if (now) {
      cancelAnimationFrame(this.scheduled);
      this.scheduled = 0;
      // After the decoder's callback returns (the render may start the next decode).
      queueMicrotask(this.onFrame);
      return;
    }
    if (this.scheduled) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      this.onFrame();
    });
  }

  /** Every source and frame dropped (the setting turned off). */
  clear() {
    for (const s of this.sources.values()) s.drop();
    this.sources.clear();
    this.lru.clear();
  }

  destroy() {
    cancelAnimationFrame(this.scheduled);
    for (const s of this.sources.values()) s.drop();
    this.sources.clear();
    this.lru.clear();
  }
}

/** The media route and id of a media URL (/media/file/<id> or /media/proxy/<id>), its tag and token left out. */
export function mediaIdOf(url: string) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split("/").pop() ?? "");
  } catch {
    return url;
  }
}
