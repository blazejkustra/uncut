// D311: the preview's playback engine. A <video> per clip only starts seeking and decoding when the
// playhead reaches its cut, so dense cuts stalled, froze on the last frame or drifted. Here the
// preview demuxes the files itself (mediabunny, play/source.ts) and decodes with WebCodecs ahead of
// the playhead: every clip on screen and the next ones within LOOKAHEAD_S on any track get a lane
// (play/lane.ts), a decoder filling a short queue from the keyframe before the clip's frame, so the
// next clip's first frames are there before its cut. The compositor draws the frame the playback
// clock asks for (the clock stays the source of truth: nothing follows a late decoder) into the
// clip's play canvas, which the GPU compositor and the DOM path take like any picture.
// - At most MAX_LANES decoders, and lanes for clips still to come only while the queues' frames fit
//   in PLAY_BUDGET bytes. Frames are ImageBitmaps no bigger than the clip shows on screen (and the
//   scrub cache's size), the VideoFrame closed at once; a lane not asked for in a render is closed.
// - A file the engine can't take (play/source.ts) keeps the <video> path, as do looped clips and
//   speeds past 4×. Shuttling (J/L) and scrubbing stay on the scrub cache and the <video>; paused,
//   the frames at the playhead are decoded once it rests so playback starts at once.
// - Sound: a clip whose file the engine can draw is heard through the mix's own <audio> (audio.ts),
//   kept to the same clock, so its sound never hands over at a play or a cut and its <video> never
//   decodes while playing.
import { Lane, type Decoded } from "./lane.ts";
import { PlaySource } from "./source.ts";

export const MAX_LANES = 16;
export const PLAY_BUDGET = 320 * 1024 * 1024;
/** How far ahead (s of timeline) upcoming clips get a lane. */
export const LOOKAHEAD_S = 2.5;
/** Frames a lane keeps ahead for a clip on screen, and for one still to come. */
const SHOWN_FRAMES = 6;
const AHEAD_FRAMES = 2;
/** Lanes of clips still to come that decode their lead-in (keyframe to first frame) at once, the soonest first. */
const PRIMING = 4;
/** A clip shown this many times bigger than its lane's frames (a zoom) starts a new lane. */
const RESHARPEN = 1.5;
/** A clip on screen this far (s) past its lane's newest frame starts a new lane there. */
const RESTART_S = 0.5;

export interface LaneWant {
  /** The clip's item id. */
  readonly key: string;
  readonly url: string;
  /** Seconds into the file: the frame wanted first, and the clip's last. */
  readonly from: number;
  readonly until: number;
  /** The long side (device px) the clip shows at, at most. */
  readonly side: number;
  readonly shown: boolean;
}

export class PlayEngine {
  private readonly sources = new Map<string, PlaySource>();
  private readonly lanes = new Map<string, Lane>();
  private wanted = new Set<string>();
  private shown = new Set<string>();
  // The bytes this render's lanes may hold at most.
  private planned = 0;
  private scratch: OffscreenCanvas | undefined;
  private readonly changed: () => void;
  readonly counts = { lanes: 0, restarts: 0, refused: 0, peakBytes: 0 };

  constructor(changed: () => void) {
    this.changed = changed;
  }

  /** The file's source, opened on first use. */
  source(url: string): PlaySource {
    let s = this.sources.get(url);
    if (!s) {
      s = new PlaySource(url, this.changed);
      this.sources.set(url, s);
    }
    return s;
  }

  /** Only these files' sources stay open. */
  keepSources(urls: ReadonlySet<string>) {
    for (const [url, s] of [...this.sources]) {
      if (urls.has(url)) continue;
      for (const [key, lane] of [...this.lanes]) if (lane.source === s) this.closeLane(key);
      s.dispose();
      this.sources.delete(url);
    }
  }

  begin() {
    this.wanted = new Set();
    this.shown = new Set();
    this.planned = 0;
  }

  /** Have a lane for a clip (asked in order of need: clips on screen first, then by start); false when there's none for it. */
  want(w: LaneWant): boolean {
    const source = this.sources.get(w.url);
    if (source?.state !== "ready") return false;
    const capacity = this.capacity(source, w);
    const lane = this.lanes.get(w.key);
    const bytes = (lane?.most ?? capacity + 2) * source.frameBytes(lane?.side ?? w.side);
    const full = this.wanted.size >= MAX_LANES || (!w.shown && this.planned + bytes > PLAY_BUDGET);
    if (full && !this.wanted.has(w.key)) {
      this.counts.refused++;
      return false;
    }
    this.wanted.add(w.key);
    this.planned += bytes;
    if (w.shown) this.shown.add(w.key);
    if (lane && this.fits(lane, source, w)) {
      lane.setCapacity(capacity);
      return true;
    }
    if (lane) {
      this.closeLane(w.key);
      this.counts.restarts++;
    }
    this.scratch ??= new OffscreenCanvas(1, 1);
    this.lanes.set(w.key, new Lane(source, w, capacity, this.scratch));
    this.counts.lanes++;
    return true;
  }

  /** The decoded frame of a clip's lane shown at t, if it has come. */
  frame(key: string, t: number): (Decoded & { readonly lane: number }) | undefined {
    const lane = this.lanes.get(key);
    const f = lane?.frameAt(t);
    return f && { ...f, lane: lane!.id };
  }

  /**
   * After a render's wants: lanes not asked for are closed. Decoders share the hardware, so of the
   * clips still to come only the PRIMING soonest without a frame yet decode; the rest wait their turn.
   */
  end() {
    for (const key of [...this.lanes.keys()]) if (!this.wanted.has(key)) this.closeLane(key);
    let priming = 0;
    let bytes = 0;
    for (const key of this.wanted) {
      const lane = this.lanes.get(key)!;
      bytes += lane.bytes;
      const waiting = !this.shown.has(key) && lane.held === 0 && lane.state === "running";
      lane.setAllowed(!waiting || priming++ < PRIMING);
    }
    this.counts.peakBytes = Math.max(this.counts.peakBytes, bytes);
  }

  stats() {
    const lanes = [...this.lanes.values()];
    return {
      ...this.counts,
      open: lanes.length,
      frames: lanes.reduce((n, l) => n + l.held, 0),
      bytes: lanes.reduce((n, l) => n + l.bytes, 0),
      each: [...this.lanes].map(([key, l]) => ({ key, ...l.describe() })),
      sources: [...this.sources.values()].map((s) => ({ url: s.url.replace(/[?&]token=[^&]*/, ""), state: s.state, reason: s.reason })),
    };
  }

  dispose() {
    for (const key of [...this.lanes.keys()]) this.closeLane(key);
    for (const s of this.sources.values()) s.dispose();
    this.sources.clear();
  }

  private fits(lane: Lane, source: PlaySource, w: LaneWant) {
    return (
      lane.source === source &&
      lane.state !== "failed" &&
      Math.abs(lane.until - w.until) < 1e-3 &&
      lane.side * RESHARPEN >= w.side &&
      lane.covers(w.from, RESTART_S)
    );
  }

  private capacity(source: PlaySource, w: LaneWant) {
    if (!w.shown) return AHEAD_FRAMES;
    const fit = Math.floor(PLAY_BUDGET / MAX_LANES / Math.max(1, source.frameBytes(w.side)));
    return Math.max(AHEAD_FRAMES, Math.min(SHOWN_FRAMES, fit));
  }

  private closeLane(key: string) {
    this.lanes.get(key)?.close();
    this.lanes.delete(key);
  }
}
