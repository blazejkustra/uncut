import type { ExportPlan, VisualLayer } from "./types.ts";

/** A stretch of the export's frames, [start, end), encoded on its own. */
export interface FrameRange {
  readonly start: number;
  readonly end: number;
}

/**
 * How many 1080p layers one ffmpeg composites at most when the export is split in time: each
 * layer's filters keep their own frames until the encode ends (about 50-125 MB a 1080p layer), so
 * an export of hundreds of clips in one ffmpeg held over 20 GB.
 */
export const CHUNK_LAYERS = 16;

/** CHUNK_LAYERS for a `width` × `height` export: fewer for larger pictures (4K: 4), at least 2. */
export const chunkLayers = (width: number, height: number) => Math.max(2, Math.round((CHUNK_LAYERS * 1920 * 1080) / (width * height)));

const overlaps = (layer: Pick<VisualLayer, "f0" | "f1">, range: FrameRange) => layer.f0 < range.end && layer.f1 > range.start;

/**
 * The plan's frames cut into ranges where at most `max` layers show (a range is never cut inside
 * fewer than one frame, so a single frame with more layers is a range of its own). One range when
 * the whole plan fits.
 */
export function chunkRanges(visuals: ReadonlyArray<Pick<VisualLayer, "f0" | "f1">>, frames: number, max = CHUNK_LAYERS): Array<FrameRange> {
  const cuts = [...new Set(visuals.flatMap((l) => [l.f0, l.f1]).filter((f) => f > 0 && f < frames))].sort((a, b) => a - b);
  cuts.push(frames);
  const ranges: Array<FrameRange> = [];
  let start = 0;
  while (start < frames) {
    const after = cuts.filter((f) => f > start);
    let end = after[0]!;
    for (const candidate of after.slice(1)) {
      if (visuals.filter((l) => overlaps(l, { start, end: candidate })).length > max) break;
      end = candidate;
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

/** The plan with only the layers that show in `range` (they keep their own frame numbers). */
export const planInRange = (plan: ExportPlan, range: FrameRange): ExportPlan => ({ ...plan, visuals: plan.visuals.filter((l) => overlaps(l, range)) });
