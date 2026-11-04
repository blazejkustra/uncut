import {
  type ClipFx,
  type ClipMask,
  type FaceFrames,
  type FaceSample,
  type Item,
  type Media,
  type Project,
  faceMasks,
  facesAt,
  matteFrames,
  visionProblem,
  visionRange,
  visionSeconds,
} from "@uncut/core";

// D328: what background removal and face blur read in the export: the matte's frames and the face
// boxes for each of a layer's frames, through core's clip-to-media mapping (visionSeconds).

/** The vision results a clip reads (the exporter makes them before the plan; see analysis/vision/clipVision.ts). */
export interface PlanVision {
  readonly matte?: { readonly file: string; readonly info: { readonly fps: number; readonly times: ReadonlyArray<number> } };
  readonly faces?: FaceFrames;
}

export type VisionLookup = (
  media: Media,
  request: { readonly output: "matte" | "faces"; readonly mode?: "person" | "subject" | undefined; readonly start: number; readonly end: number },
) => PlanVision | { readonly problem: string } | undefined;

/** A layer's matte (D328): the .mkv, the matte-clock time of its first frame, and each frame's after it. */
export interface LayerMatte {
  readonly file: string;
  /** The matte's own frame rate (its .mkv's frames are on a 1/fps grid from 0). */
  readonly fps: number;
  readonly source: number;
  readonly times: ReadonlyArray<number>;
}

export interface ClipVisionPlan {
  /** The effects as drawn: without a cutout or face blur whose result isn't there. */
  readonly effects: ClipFx | undefined;
  readonly matte?: LayerMatte;
  /** The faces on each frame from f0 (boxes 0 to 1 of the picture). */
  readonly faces?: ReadonlyArray<ReadonlyArray<FaceSample>>;
}

/**
 * The vision data of a clip's frames [from, from + count) (local frames), or the effects without
 * what can't be drawn, with a warning saying why.
 */
export function clipVision(
  project: Project,
  item: Item,
  media: Media,
  effects: ClipFx | undefined,
  from: number,
  count: number,
  lookup: VisionLookup | undefined,
  warn: (output: "matte" | "faces", why: string) => void,
): ClipVisionPlan {
  if (!effects?.cutout && !effects?.faceBlur) return { effects };
  const range = visionRange(project, item);
  let drawn: ClipFx = effects;
  const out: { matte?: LayerMatte; faces?: ReadonlyArray<ReadonlyArray<FaceSample>> } = {};
  if (effects.cutout) {
    const problem = visionProblem(project, item, "matte");
    const got = !problem && range ? lookup?.(media, { output: "matte", mode: effects.cutout.mode, ...range }) : undefined;
    const matte = got && "matte" in got ? got.matte : undefined;
    if (matte) {
      const frames = matteFrames(project, item, matte.info.times, from, count).map((i) => i / matte.info.fps);
      out.matte = { file: matte.file, fps: matte.info.fps, source: frames[0]!, times: frames.map((t) => t - frames[0]!) };
    } else {
      const { cutout: _, ...rest } = drawn;
      drawn = rest;
      warn("matte", problem ?? (got && "problem" in got ? got.problem : "its matte couldn't be made"));
    }
  }
  if (effects.faceBlur) {
    const problem = visionProblem(project, item, "faces");
    const got = !problem && range ? lookup?.(media, { output: "faces", ...range }) : undefined;
    const faces = got && "faces" in got ? got.faces : undefined;
    if (faces) {
      const only = effects.faceBlur.faces;
      out.faces = Array.from({ length: count }, (_, k) => facesAt(faces, visionSeconds(project, item, from + k), only));
    } else {
      const { faceBlur: _, ...rest } = drawn;
      drawn = rest;
      warn("faces", problem ?? (got && "problem" in got ? got.problem : "its faces couldn't be found"));
    }
  }
  return { effects: Object.keys(drawn).length ? drawn : undefined, ...out };
}

/** The faces of each frame as masks on the effects' picture (w × h px, `k` px per canvas px). */
export const layerFaceMasks = (faces: ReadonlyArray<ReadonlyArray<FaceSample>>, fx: ClipFx, w: number, h: number, k: number): Array<Array<ClipMask>> =>
  faces.map((f) => (fx.faceBlur ? faceMasks(f, fx.faceBlur, w, h, k) : []));
