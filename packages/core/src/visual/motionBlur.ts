// Motion blur in the export (D291): a frame is the average of `samples` pictures drawn at moments
// spread over the open shutter, `shutter` degrees of the frame interval (180°: half of it, a film
// camera's), starting at the frame's own time, so the first sub-frame is the sharp frame and one
// sample is no blur. The export draws graphics this way (the rasteriser streams each sub-frame,
// ffmpeg averages them on premultiplied colour). The preview draws no blur.
import type { Item, Project } from "../timeline/types.ts";

export interface MotionBlur {
  /** Pictures averaged per frame. */
  readonly samples: number;
  /** Degrees of the frame interval the sub-frames spread over (360 = the whole interval). */
  readonly shutter: number;
}

/** What an export uses without a project setting: 4 sub-frames over a 180° shutter. */
export const MOTION_BLUR_DEFAULTS: MotionBlur = { samples: 4, shutter: 180 };
export const MOTION_BLUR_SAMPLES = { min: 2, max: 16 } as const;

/** Whether an export blurs by default: the project's `on`, else on for Standard and High, off for Draft. */
export const motionBlurDefault = (project: Pick<Project, "motionBlur">, quality: "draft" | "standard" | "high") => project.motionBlur?.on ?? quality !== "draft";

/** The project's blur (its samples and shutter, or the defaults), clamped to what the export takes. */
export function projectMotionBlur(project: Pick<Project, "motionBlur">): MotionBlur {
  const s = project.motionBlur?.samples;
  const sh = project.motionBlur?.shutter;
  return {
    samples: typeof s === "number" && Number.isFinite(s) ? Math.min(MOTION_BLUR_SAMPLES.max, Math.max(MOTION_BLUR_SAMPLES.min, Math.round(s))) : MOTION_BLUR_DEFAULTS.samples,
    shutter: typeof sh === "number" && Number.isFinite(sh) ? Math.min(360, Math.max(1, sh)) : MOTION_BLUR_DEFAULTS.shutter,
  };
}

/** An item's blur in an export with blur `on` (the export's switch): none when it's off or the item opts out (motionBlur false). */
export const itemMotionBlur = (item: Pick<Item, "motionBlur">, project: Pick<Project, "motionBlur">, on: boolean): MotionBlur | undefined => (on && item.motionBlur !== false ? projectMotionBlur(project) : undefined);

/**
 * The moments (seconds) drawn for frame `frame` (a number of frames from the item's start, at
 * `fps`): sub-frame j of n at (frame + j·(shutter/360)/n) / fps, j = 0…n−1. Without blur, the frame's
 * own moment. `still` (a held frame: before the item starts or after it ends) gives the frame's own
 * moment n times, so a held frame stays sharp.
 */
export function subFrameTimes(frame: number, fps: number, blur?: MotionBlur, still = false): Array<number> {
  if (!blur || blur.samples <= 1) return [frame / fps];
  const open = blur.shutter / 360;
  return Array.from({ length: blur.samples }, (_, j) => (still ? frame : frame + (j * open) / blur.samples) / fps);
}
