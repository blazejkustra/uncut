// Vision results on clips (D328): background removal (effect.cutout) and face blur
// (effect.face-blur) read a matte and face boxes that an on-device vision module made for a range
// of the clip's media (D325). Both are in the media's own seconds, so a clip's moment maps to them
// through the same clip-to-source mapping as its picture (D327 sourceAt): `visionSeconds`. The
// frame of a result for a moment is the last one starting at or before it (+0.0001 s, D38).
// A reversed clip's moment maps to the forward media's frame its reversed copy shows.
import { sourceAt } from "../audio/audio.ts";
import { sourceFrames, transitionHandles } from "../timeline/speedRamp.ts";
import type { Item, Project } from "../timeline/types.ts";
import { type ClipMask, maskCoverage } from "./fx/matte.ts";

export const FRAME_EPSILON_S = 0.0001;

/** Vision results cover whole steps of this many seconds of the media (with transition handles), so small trims reuse them. */
export const VISION_STEP_S = 2;

type WithTracks = Pick<Project, "media" | "canvas"> & { readonly tracks?: Project["tracks"] };

/** The index of the frame showing at `t`: the last starting at or before t + 0.0001 s (0 before the first). */
export function frameIndex(times: ReadonlyArray<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t + FRAME_EPSILON_S) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const mediaOf = (project: Pick<Project, "media">, item: Pick<Item, "media">) => (item.media ? project.media.find((m) => m.id === item.media) : undefined);

/** The media's own seconds of the frame a clip shows `local` frames after its start. */
export function visionSeconds(project: WithTracks, item: Item, local: number): number {
  const fps = project.canvas.fps;
  if (!item.reverse) return Math.max(0, sourceAt(project, item, local));
  const length = mediaOf(project, item)?.probe?.frames ?? 0;
  const played = (item.in ?? 0) + sourceFrames(item, local);
  return Math.max(0, length - 1 - Math.floor(played + 1e-9)) / fps;
}

/** The media's length in seconds, when it's known. */
const mediaSeconds = (project: WithTracks, item: Item) => {
  const frames = mediaOf(project, item)?.probe?.frames;
  return frames ? frames / project.canvas.fps : undefined;
};

/**
 * The stretch of a clip's media [start, end) (seconds) its vision results cover: what it shows,
 * plus what its main-track transitions play past its ends, rounded out to VISION_STEP_S steps.
 */
export function visionRange(project: WithTracks, item: Item): { readonly start: number; readonly end: number } | undefined {
  const length = mediaSeconds(project, item);
  if (item.type !== "clip" || !length) return undefined;
  if (item.loop) return { start: 0, end: length };
  const { before, after } = transitionHandles(project, item);
  const ends = [visionSeconds(project, item, -before), visionSeconds(project, item, Math.max(0, item.duration + after - 1))];
  const lo = Math.min(...ends);
  const hi = Math.max(...ends) + 1 / project.canvas.fps;
  const start = Math.max(0, Math.floor(lo / VISION_STEP_S) * VISION_STEP_S);
  const end = Math.min(length, Math.ceil(hi / VISION_STEP_S) * VISION_STEP_S);
  return end > start ? { start, end } : undefined;
}

/** Why a clip can't use vision results (cutout: the matte; faces), or undefined when it can. */
export function visionProblem(project: WithTracks, item: Item, output: "matte" | "faces"): string | undefined {
  const media = mediaOf(project, item);
  if (item.type !== "clip" || !media || media.kind !== "video")
    return output === "matte" ? "Background removal works on video clips." : "Face blur works on video clips.";
  if (!media.probe?.frames) return "Uncut doesn't know this video's length yet, so it can't analyse it.";
  if (output === "matte" && item.reverse) return "Background removal doesn't work on a clip that plays backwards: turn Play backwards off first.";
  if (output === "matte" && item.loop) return "Background removal doesn't work on a looped clip: turn Loop off first.";
  return undefined;
}

/** For `count` frames from local frame `from`: the index of the matte frame each shows (times: the matte's frame times). */
export const matteFrames = (project: WithTracks, item: Item, times: ReadonlyArray<number>, from: number, count: number): Array<number> =>
  Array.from({ length: count }, (_, k) => frameIndex(times, visionSeconds(project, item, from + k)));

// ---- cutout ----

export type CutoutMode = "person" | "subject";

/** effect.cutout: which matte, and how its edge is drawn (softness 1 keeps the matte as it is). */
export interface Cutout {
  readonly mode: CutoutMode;
  readonly softness: number;
  readonly shrink: number;
}

/** Where a matte value (0 to 1) of `c.shrink` lands half way: 0.5 with no shrink, 0.95 at full shrink. */
const cutoutCentre = (c: Cutout) => 0.5 + 0.45 * c.shrink;

/** A pixel's alpha from its matte value m (0 to 1, white = keep). */
export const matteAlpha = (c: Cutout, m: number) => Math.min(1, Math.max(0, (m - cutoutCentre(c)) / c.softness + 0.5));

const num = (v: number) => `${Math.round(v * 1e6) / 1e6}`;

/** matteAlpha as an ffmpeg lut expression of `val` (0 to 255), giving 0 to 255. */
export const matteAlphaExpr = (c: Cutout) => `255*clip((val/255-${num(cutoutCentre(c))})/${num(c.softness)}+0.5,0,1)`;

// ---- faces ----

export interface FaceSample {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Face boxes per frame (the vision contract's faces result), normalised 0 to 1 from the top left. */
export interface FaceFrames {
  readonly frames: ReadonlyArray<{ readonly t: number; readonly faces: ReadonlyArray<FaceSample> }>;
}

/** A face missing on some frames is drawn between its boxes across a gap up to this long, and held this long after its last one. */
export const FACE_GAP_S = 0.5;
export const FACE_HOLD_S = 0.25;

interface FaceIndex {
  readonly times: ReadonlyArray<number>;
  /** Per face id: the frames it's on (rising) and its box on each. */
  readonly tracks: ReadonlyMap<number, { readonly frames: Array<number>; readonly boxes: Array<FaceSample> }>;
}

const indexes = new WeakMap<FaceFrames, FaceIndex>();

function indexOf(result: FaceFrames): FaceIndex {
  const known = indexes.get(result);
  if (known) return known;
  const tracks = new Map<number, { frames: Array<number>; boxes: Array<FaceSample> }>();
  result.frames.forEach((frame, i) => {
    for (const face of frame.faces) {
      const track = tracks.get(face.id) ?? { frames: [], boxes: [] };
      track.frames.push(i);
      track.boxes.push(face);
      tracks.set(face.id, track);
    }
  });
  const index = { times: result.frames.map((f) => f.t), tracks };
  indexes.set(result, index);
  return index;
}

/** The last position in a rising list at or before `v` (-1: none). */
function atOrBefore(list: ReadonlyArray<number>, v: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! <= v) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** One face at frame `i`: its own box, else drawn between its neighbours across a short gap, else held briefly after its last. */
function faceAt(track: { readonly frames: ReadonlyArray<number>; readonly boxes: ReadonlyArray<FaceSample> }, times: ReadonlyArray<number>, i: number) {
  const k = atOrBefore(track.frames, i);
  if (k >= 0 && track.frames[k] === i) return track.boxes[k]!;
  if (k < 0) return undefined;
  const a = track.frames[k]!;
  const t = times[i]!;
  const next = track.frames[k + 1];
  if (next !== undefined && times[next]! - times[a]! <= FACE_GAP_S) {
    const p = (t - times[a]!) / (times[next]! - times[a]!);
    const from = track.boxes[k]!;
    const to = track.boxes[k + 1]!;
    return { id: from.id, x: lerp(from.x, to.x, p), y: lerp(from.y, to.y, p), w: lerp(from.w, to.w, p), h: lerp(from.h, to.h, p) };
  }
  return t - times[a]! <= FACE_HOLD_S ? track.boxes[k]! : undefined;
}

/** The faces on screen at media second `t` (only the ids in `only`, when given). */
export function facesAt(result: FaceFrames, t: number, only?: ReadonlyArray<number>): Array<FaceSample> {
  if (!result.frames.length) return [];
  const index = indexOf(result);
  const i = frameIndex(index.times, t);
  const out: Array<FaceSample> = [];
  for (const [id, track] of index.tracks) {
    if (only?.length && !only.includes(id)) continue;
    const face = faceAt(track, index.times, i);
    if (face) out.push(face);
  }
  return out;
}

/** The faces a result found, by id: when each is first and last seen and its first box (the Inspector's pick list). */
export function faceList(result: FaceFrames): Array<{ readonly id: number; readonly from: number; readonly to: number; readonly box: FaceSample }> {
  const index = indexOf(result);
  return [...index.tracks.entries()]
    .map(([id, track]) => ({ id, from: index.times[track.frames[0]!]!, to: index.times[track.frames.at(-1)!]!, box: track.boxes[0]! }))
    .sort((a, b) => a.from - b.from || a.id - b.id);
}

export type FaceShape = "ellipse" | "rectangle";

/** effect.face-blur: the blur (canvas px), the shape drawn round each face, its soft edge (canvas px) and padding (share of the face's size each side). */
export interface FaceBlur {
  readonly amount: number;
  readonly shape: FaceShape;
  readonly feather: number;
  readonly padding: number;
  /** Only these face ids (none: every face). */
  readonly faces?: ReadonlyArray<number>;
}

/** The faces as masks on a picture of w × h px (`k`: px per canvas px, for the feather). */
export function faceMasks(faces: ReadonlyArray<FaceSample>, blur: FaceBlur, w: number, h: number, k = 1): Array<ClipMask> {
  return faces.map((f) => {
    const pw = f.w * blur.padding;
    const ph = f.h * blur.padding;
    return {
      shape: blur.shape,
      invert: false,
      x: (f.x - pw) * w,
      y: (f.y - ph) * h,
      w: Math.max(1, (f.w + 2 * pw) * w),
      h: Math.max(1, (f.h + 2 * ph) * h),
      radius: 0,
      feather: blur.feather * k,
    };
  });
}

/** How much of the pixel centred at (x, y) is blurred: the most any face's mask covers it. */
export function faceCoverage(masks: ReadonlyArray<ClipMask>, x: number, y: number): number {
  let c = 0;
  for (const m of masks) c = Math.max(c, maskCoverage(m, x, y));
  return c;
}
