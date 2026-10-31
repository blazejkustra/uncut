import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { LoudnessResult } from "../../analysis/analysis.ts";
import { FRAME_EDGE } from "../agentTools.ts";

/** D189: render_frames with phone true: frames this wide (a phone in a feed). */
export const PHONE_WIDTH = 360;

/**
 * render_frames' scale: phone true draws a feed's width; else `asked` (0 to 1), which only a single
 * frame (a detail check) may take past FRAME_EDGE; else FRAME_EDGE.
 */
export function frameScale(canvas: { readonly width: number; readonly height: number }, frames: number, asked: unknown, phone: boolean): number {
  if (phone) return Math.min(1, PHONE_WIDTH / canvas.width);
  const edge = Math.min(1, FRAME_EDGE / Math.max(canvas.width, canvas.height));
  if (typeof asked !== "number" || asked <= 0 || asked > 1) return edge;
  return frames === 1 ? asked : Math.min(asked, edge);
}

/** D194: media_download's limits per turn. */
export const DOWNLOADS_PER_TURN = 20;
export const DOWNLOAD_BYTES_PER_TURN = 1024 * 1024 * 1024;

/** media_analyze waits this long for its jobs before answering "running" (UNCUT_ANALYZE_WAIT_MS for tests). */
export const analyzeWaitMs = () => {
  const n = Number(process.env.UNCUT_ANALYZE_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 55_000;
};
/** transcript_edit waits this long for a loudness pass that isn't cached (D74). */
export const SILENCES_WAIT_MS = 20_000;
/** At most this many silences in one answer (a range narrows it down). */
const MAX_SILENCES = 400;

/** The loudness analyzer's result as media_analyze returns it: silences in project frames of the media too. */
export function loudnessOut(
  result: LoudnessResult,
  cached: boolean,
  frames: (seconds: number, round: (x: number) => number) => number,
  range: { start: number; end: number } | undefined,
) {
  if (!result.hasAudio) return { state: "done", cached, hasAudio: false, note: "This media has no sound, so there's nothing to measure." };
  const all = (result.silence?.ranges ?? [])
    .map((r) => ({ start: frames(r.start, Math.ceil), end: frames(r.end, Math.floor) }))
    .filter((r) => r.end > r.start && (!range || (r.start < range.end && r.end > range.start)));
  return {
    state: "done",
    cached,
    hasAudio: true,
    ...(result.seconds !== undefined ? { seconds: result.seconds } : {}),
    integratedLufs: result.integratedLufs ?? null,
    loudnessRangeLu: result.loudnessRangeLu ?? null,
    truePeakDbtp: result.truePeakDbtp ?? null,
    silence: {
      thresholdDb: result.silence?.thresholdDb,
      minSeconds: result.silence?.minSeconds,
      count: all.length,
      ...(range ? { range } : {}),
      ranges: all.slice(0, MAX_SILENCES),
      ...(all.length > MAX_SILENCES ? { truncated: `Only the first ${MAX_SILENCES} of ${all.length}; pass range for the rest.` } : {}),
    },
  };
}

/** contact_sheet: when the asked-for columns didn't fit the sheet, say what was used instead. */
export const columnsNote = (asked: number | undefined, used: number) =>
  asked !== undefined && asked !== used ? `${asked} columns didn't fit the sheet's size, so it has ${used}.` : "";
export const realOr = (path: string, dir: string) => realpath(isAbsolute(path) ? path : resolve(dir, path)).catch(() => path);
