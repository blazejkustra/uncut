// D311 playback engine (play/engine.ts): one lane decodes one clip's stretch of a file, from the
// keyframe before `from` up to `until`, into a short queue of upright ImageBitmaps in presentation
// order. Frames before `from` (the GOP's lead-in) and after `until` are closed without a copy. The
// queue holds at most `capacity` frames, counting the ones it keeps that are still in the decoder:
// the lane waits for the playhead to take one before it decodes on, so a clip that hasn't started
// yet holds only its first frames.
import type { EncodedPacket } from "mediabunny";
import { frameBitmap, isHdr } from "../frameBitmap.ts";
import type { PlaySource } from "./source.ts";

/** Chunks waiting in the decoder at most. */
const MAX_QUEUED = 6;
/** Packets fed past `until`, so frames shown before it but decoded after it (B-frames) come out. */
const PAST_S = 0.25;
/**
 * Frames to keep that may be in the decoder beyond the queue's room: a decoder holds frames back
 * until it has seen the ones shown before them (B-frames). One that waits longer than STALL_MS for
 * more input with nothing else to do gets one more, up to MAX_REORDER.
 */
const REORDER = 2;
const MAX_REORDER = 16;
const STALL_MS = 60;
const EPS = 1e-4;

export interface Decoded {
  /** Seconds into the file it's shown from, and until. */
  readonly ts: number;
  readonly end: number;
  readonly bitmap: ImageBitmap;
  readonly bytes: number;
}

let laneSeq = 0;

export class Lane {
  readonly id = ++laneSeq;
  readonly source: PlaySource;
  readonly from: number;
  readonly until: number;
  /** The long side its frames are kept at, at most. */
  readonly side: number;
  capacity: number;
  state: "running" | "done" | "failed" = "running";
  /** The newest frame's time, or `from` before the first. */
  newest: number;
  /** The earliest time it can still show (frames before it were let go). */
  private since: number;
  private readonly frames: Array<Decoded> = [];
  private readonly decoder: VideoDecoder;
  private readonly scratch: OffscreenCanvas;
  private closed = false;
  private allowed = true;
  private wake: (() => void) | undefined;
  // Timestamps (µs) of fed chunks whose frames it keeps and hasn't had yet.
  private readonly pending = new Set<number>();
  private reorder = REORDER;

  constructor(source: PlaySource, span: { from: number; until: number; side: number }, capacity: number, scratch: OffscreenCanvas) {
    this.source = source;
    this.from = span.from;
    this.until = span.until;
    this.side = span.side;
    this.capacity = capacity;
    this.newest = span.from;
    this.since = span.from;
    this.scratch = scratch;
    this.decoder = new VideoDecoder({ output: (frame) => this.output(frame), error: (e) => this.fault(e) });
    this.decoder.addEventListener("dequeue", () => this.resume());
    this.decoder.configure(source.config!);
    void this.run().catch((error: unknown) => this.fault(error));
  }

  /** The most frames it may hold at once. */
  get most() {
    return this.capacity + this.reorder;
  }

  /** Bytes of the frames it holds. */
  get bytes() {
    return this.frames.reduce((sum, f) => sum + f.bytes, 0);
  }

  get held() {
    return this.frames.length;
  }

  /** What it's doing (for diagnosis). */
  describe() {
    return {
      state: this.state,
      held: this.frames.length,
      pending: this.pending.size,
      reorder: this.reorder,
      allowed: this.allowed,
      newest: this.newest,
      queued: this.decoder.decodeQueueSize,
    };
  }

  /** The frame shown at t (the last one starting at or before it); the ones before it are let go. */
  frameAt(t: number): Decoded | undefined {
    let i = this.frames.length - 1;
    while (i >= 0 && this.frames[i]!.ts > t + EPS) i--;
    if (i < 0) return undefined;
    for (const old of this.frames.splice(0, i)) old.bitmap.close();
    if (i > 0) this.since = this.frames[0]!.ts;
    this.resume();
    return this.frames[0];
  }

  /** Whether this lane can still bring the frame at t without starting over. */
  covers(t: number, slack: number) {
    if (t < this.since - EPS) return false;
    if (this.state === "done") return true;
    return t <= this.newest + slack;
  }

  setCapacity(capacity: number) {
    if (capacity === this.capacity) return;
    this.capacity = capacity;
    this.resume();
  }

  /** Whether it may decode now (the engine lets the clips needed soonest go first). */
  setAllowed(allowed: boolean) {
    if (allowed === this.allowed) return;
    this.allowed = allowed;
    this.resume();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.decoder.state !== "closed") this.decoder.close();
    for (const f of this.frames.splice(0)) f.bitmap.close();
    this.resume();
  }

  private resume() {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private hasRoom() {
    return this.allowed && this.decoder.decodeQueueSize < MAX_QUEUED && this.frames.length + this.pending.size < this.most;
  }

  private async whenRoom() {
    while (!this.closed && !this.hasRoom()) {
      const woken = await this.nap(STALL_MS);
      if (!woken && this.heldBack() && this.reorder < MAX_REORDER) this.reorder++;
    }
  }

  /** Waits for a wake-up, at most `ms`; false when the time ran out. */
  private nap(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve(false);
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  /** The decoder sits on frames to keep, waiting for input the queue's room won't let it have. */
  private heldBack() {
    return this.allowed && this.decoder.decodeQueueSize === 0 && this.frames.length < this.capacity && this.pending.size > 0;
  }

  /** Whether a frame at ts (s) lasting `duration` is one this lane keeps. */
  private keeps(ts: number, duration: number) {
    return ts + (duration || this.source.frameS) > this.from + EPS && ts <= this.until + EPS;
  }

  private async firstPacket(): Promise<EncodedPacket | null> {
    const sink = this.source.sink!;
    return (await sink.getKeyPacket(this.from, { verifyKeyPackets: true })) ?? (await sink.getFirstPacket());
  }

  private async run() {
    const sink = this.source.sink;
    const start = sink && (await this.firstPacket());
    if (!sink || !start || this.closed) return this.finish();
    for await (const packet of sink.packets(start)) {
      if (packet.timestamp > this.until + PAST_S) break;
      await this.whenRoom();
      if (this.closed) return;
      const chunk = packet.toEncodedVideoChunk();
      if (this.keeps(packet.timestamp, packet.duration)) this.pending.add(chunk.timestamp);
      this.decoder.decode(chunk);
    }
    if (this.closed) return;
    await this.decoder.flush();
    this.finish();
  }

  private finish() {
    if (!this.closed && this.state === "running") this.state = "done";
  }

  private output(frame: VideoFrame) {
    this.pending.delete(frame.timestamp);
    try {
      if (this.closed) return;
      if (isHdr(frame)) return this.source.fail(`HDR (${String(frame.colorSpace?.transfer)})`);
      const ts = frame.timestamp / 1e6;
      const end = ts + (frame.duration ? frame.duration / 1e6 : this.source.frameS);
      if (!this.keeps(ts, end - ts)) return;
      const { bitmap, w, h } = frameBitmap(frame, this.source.rotation, this.scratch, this.side);
      this.frames.push({ ts, end, bitmap, bytes: w * h * 4 });
      this.newest = ts;
    } finally {
      frame.close();
      this.resume();
    }
  }

  private fault(error: unknown) {
    if (this.closed) return;
    const message = String((error as Error)?.message ?? error);
    this.state = "failed";
    this.close();
    this.source.fail(`decoder: ${message}`);
  }
}
