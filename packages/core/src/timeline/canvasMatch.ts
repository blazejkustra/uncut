// D209 (issue #15): "Match first clip": a new project takes its first video's size and frame rate.
import { CANVAS_FPS, type Canvas, type CanvasFps } from "./types.ts";

/** The canvas rate nearest to a clip's (29.97002997 → 29.97, 23.98 → 23.976); undefined when none is within 0.05. */
export function nearestCanvasFps(fps: number | undefined): CanvasFps | undefined {
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0) return undefined;
  let best: CanvasFps | undefined;
  for (const r of CANVAS_FPS) if (Math.abs(r - fps) <= 0.05 && (best === undefined || Math.abs(r - fps) < Math.abs(best - fps))) best = r;
  return best;
}

/** Even, 16…8192 (the schema's range; H.264 wants even sizes). */
const side = (v: number) => Math.min(8192, Math.max(16, Math.round(v / 2) * 2));

/**
 * The canvas a clip asks for: its picture as shown (a phone clip turned 90° is portrait), even
 * sides, and its rate when it's one of the canvas rates (else the canvas keeps its own). The
 * background is kept. Undefined when the clip has no size.
 */
export function canvasForClip(
  canvas: Canvas,
  clip: {
    readonly width?: number | undefined;
    readonly height?: number | undefined;
    readonly fps?: number | undefined;
    readonly rotation?: number | undefined;
  },
): Canvas | undefined {
  if (!clip.width || !clip.height) return undefined;
  const turned = clip.rotation === 90 || clip.rotation === 270;
  const width = side(turned ? clip.height : clip.width);
  const height = side(turned ? clip.width : clip.height);
  return { ...canvas, width, height, fps: nearestCanvasFps(clip.fps) ?? canvas.fps };
}
