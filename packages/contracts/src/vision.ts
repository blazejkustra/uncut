import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// ---- on-device vision (D325) ----
//
// What an analyzer plugin that declares these outputs answers, whatever runs it (Apple Vision on a
// Mac, another runtime elsewhere). The editor depends only on this file.
//
// Every result covers a source range [start, end) of one media file, in the media's own seconds.
// Its frames are the source frames that show during that range: the last frame starting at or
// before start (+0.0001 s), then every frame starting before end, in order. `times` (or each
// frame's `t`) is the source time a frame starts at; the frame for a moment t is the last one
// starting at or before t + 0.0001 s (D38, D290's sourceFramePick rule), so variable frame rate
// footage maps exactly.

/** The vision outputs an analyzer can declare (module.schema.json analyzer.outputs). */
export const VISION_OUTPUTS = ["matte", "faces", "track"] as const;
export const VisionOutput = Schema.Literals(VISION_OUTPUTS);
export type VisionOutput = typeof VisionOutput.Type;

/** person: people only; subject: the salient foreground (people, pets, objects). */
export const MATTE_MODES = ["person", "subject"] as const;
export const MatteMode = Schema.Literals(MATTE_MODES);
export type MatteMode = typeof MatteMode.Type;

/** How far either side of a frame's start a moment still picks it. */
export const FRAME_EPSILON_S = 0.0001;

const Range = {
  /** The media's own seconds. */
  start: Schema.Number,
  end: Schema.Number,
  /** The source's nominal frame rate (informational: `times` is exact). */
  fps: Schema.Number,
  /** The picture's display size (rotation applied), in pixels. */
  width: Schema.Number,
  height: Schema.Number,
};

/**
 * A matte: an FFV1 .mkv of 8-bit grey frames (pix_fmt gray, white = keep), one per source frame of
 * the range, at the source's display size. The .mkv's own timestamps are a constant `fps` grid
 * from 0; frame i is the source frame starting at times[i]. This sidecar sits beside the .mkv.
 */
export const MatteInfo = Schema.Struct({
  format: Schema.Literal("uncut.matte/1"),
  mode: MatteMode,
  ...Range,
  frames: Schema.Number,
  times: Schema.Array(Schema.Number),
  /** The analyzer that made it (plugin id and version). */
  module: Schema.Struct({ id: Schema.String, version: Schema.String }),
});
export type MatteInfo = typeof MatteInfo.Type;

/** A box in the picture, normalised 0 to 1, origin top left. */
const Box = { x: Schema.Number, y: Schema.Number, w: Schema.Number, h: Schema.Number };

export const FaceBox = Schema.Struct({
  ...Box,
  /** Stable while the same face stays in view; a face that leaves and comes back may get a new id. */
  id: Schema.Number,
  confidence: Schema.Number,
});
export type FaceBox = typeof FaceBox.Type;

export const FacesResult = Schema.Struct({
  ...Range,
  frames: Schema.Array(Schema.Struct({ t: Schema.Number, faces: Schema.Array(FaceBox) })),
});
export type FacesResult = typeof FacesResult.Type;

/** One frame of a tracked object: its box, or `lost: true` on the frame where the tracker let go (the last one). */
export const TrackFrame = Schema.Struct({
  t: Schema.Number,
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  w: Schema.optional(Schema.Number),
  h: Schema.optional(Schema.Number),
  confidence: Schema.optional(Schema.Number),
  lost: Schema.optional(Schema.Boolean),
});
export type TrackFrame = typeof TrackFrame.Type;

/** An object followed from `start` (its first frame is the box asked for) until the range ends or it's lost. */
export const TrackResult = Schema.Struct({
  ...Range,
  frames: Schema.Array(TrackFrame),
});
export type TrackResult = typeof TrackResult.Type;

export class VisionError extends Schema.TaggedError<VisionError>()("VisionError", {
  // no-provider: no installed, allowed analyzer declares the output for this system.
  reason: Schema.Literals(["no-provider", "invalid", "failed"]),
  message: Schema.String,
}) {}

// ---- checks beyond the shapes ----

const unit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
type BoxLike = { readonly x?: number | undefined; readonly y?: number | undefined; readonly w?: number | undefined; readonly h?: number | undefined };
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** A box cut to the picture (trackers report boxes reaching past its edges); undefined when nothing finite is left inside. */
export function clipBox(b: BoxLike): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined {
  const { x, y, w, h } = b;
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v)) || w! <= 0 || h! <= 0) return undefined;
  const left = Math.max(0, x!);
  const top = Math.max(0, y!);
  const right = Math.min(1, x! + w!);
  const bottom = Math.min(1, y! + h!);
  if (right - left <= 0 || bottom - top <= 0) return undefined;
  return { x: round4(left), y: round4(top), w: round4(right - left), h: round4(bottom - top) };
}
const increasing = (times: ReadonlyArray<number>) => times.every((t, i) => Number.isFinite(t) && (i === 0 || t > times[i - 1]!));
const rangeProblem = (r: { start: number; end: number; fps: number; width: number; height: number }) => {
  if (!(Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start)) return "its range is empty or not finite";
  if (!(r.fps > 0)) return "its frame rate isn't positive";
  if (!(Number.isInteger(r.width) && Number.isInteger(r.height) && r.width > 0 && r.height > 0)) return "its size isn't whole pixels";
  return undefined;
};

const clippedFace = (face: FaceBox): FaceBox | undefined => {
  const box = clipBox(face);
  return box && { ...face, ...box };
};

const clippedTrackFrame = (frame: TrackFrame): TrackFrame | undefined => {
  const box = clipBox(frame);
  return box && { ...frame, ...box };
};

type Checked<T> = { readonly value: T } | { readonly problem: string };

const decodeMatteInfo = Schema.decodeUnknownOption(MatteInfo);
const decodeFaces = Schema.decodeUnknownOption(FacesResult);
const decodeTrack = Schema.decodeUnknownOption(TrackResult);

/** A matte sidecar, checked: the shape, frames == times, times rising, whole-pixel size. */
export function parseMatteInfo(raw: unknown): Checked<MatteInfo> {
  const info = decodeMatteInfo(raw);
  if (Option.isNone(info)) return { problem: "The matte's info doesn't match uncut.matte/1." };
  const value = info.value;
  const range = rangeProblem(value);
  if (range) return { problem: `The matte's info is wrong: ${range}.` };
  if (!(Number.isInteger(value.frames) && value.frames > 0 && value.frames === value.times.length))
    return { problem: `The matte says ${value.frames} frames but lists ${value.times.length} times.` };
  if (!increasing(value.times)) return { problem: "The matte's frame times don't rise." };
  return { value };
}

/** A faces result, checked: the shape, whole ids, times rising; boxes cut to the picture. */
export function parseFaces(raw: unknown): Checked<FacesResult> {
  const faces = decodeFaces(raw);
  if (Option.isNone(faces)) return { problem: "The faces answer doesn't have the faces shape." };
  const value = faces.value;
  const range = rangeProblem(value);
  if (range) return { problem: `The faces answer is wrong: ${range}.` };
  if (!increasing(value.frames.map((f) => f.t))) return { problem: "The faces answer's frame times don't rise." };
  if (!value.frames.every((f) => f.faces.every((b) => unit(b.confidence) && Number.isInteger(b.id))))
    return { problem: "The faces answer has a face without a whole id or a confidence from 0 to 1." };
  const frames = value.frames.map((f) => ({ t: f.t, faces: f.faces.map((b) => clippedFace(b)) }));
  if (frames.some((f) => f.faces.some((b) => !b))) return { problem: "The faces answer has a box with no area inside the picture." };
  return { value: { ...value, frames: frames as FacesResult["frames"] } };
}

/** A track result, checked: a box on every frame but a final lost one, times rising; boxes cut to the picture. */
export function parseTrack(raw: unknown): Checked<TrackResult> {
  const track = decodeTrack(raw);
  if (Option.isNone(track)) return { problem: "The track answer doesn't have the track shape." };
  const value = track.value;
  const range = rangeProblem(value);
  if (range) return { problem: `The track answer is wrong: ${range}.` };
  if (!value.frames.length) return { problem: "The track answer has no frames." };
  if (!increasing(value.frames.map((f) => f.t))) return { problem: "The track answer's frame times don't rise." };
  const last = value.frames.length - 1;
  if (value.frames.some((f, i) => f.lost && i !== last)) return { problem: "The track answer is lost before its last frame." };
  if (value.frames.some((f) => !f.lost && f.confidence !== undefined && !unit(f.confidence)))
    return { problem: "The track answer has a confidence outside 0 to 1." };
  const frames = value.frames.map((f) => (f.lost ? f : clippedTrackFrame(f)));
  if (frames.some((f) => !f)) return { problem: "The track answer has a box with no area inside the picture." };
  return { value: { ...value, frames: frames as TrackResult["frames"] } };
}

/** The index of the frame showing at source time t: the last starting at or before t + 0.0001 s (-1: before the first). */
export function frameAt(times: ReadonlyArray<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t + FRAME_EPSILON_S) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
