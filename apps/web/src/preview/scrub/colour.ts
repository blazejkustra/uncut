// D221 scrub cache (scrub.ts): the colour space frames are decoded with, and which footage is lifted.
import type { StreamColour } from "@uncut/core/mp4index";

const PRIMARIES: Record<number, VideoColorPrimaries> = {
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
  9: "bt2020" as VideoColorPrimaries,
  12: "smpte432" as VideoColorPrimaries,
};
const TRANSFER: Record<number, VideoTransferCharacteristics> = {
  1: "bt709",
  6: "smpte170m",
  13: "iec61966-2-1",
  8: "linear" as VideoTransferCharacteristics,
  16: "pq" as VideoTransferCharacteristics,
  18: "hlg" as VideoTransferCharacteristics,
};
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

/** Transfers the lift wasn't measured for (sRGB, linear, PQ, HLG): left as they are. */
const UNMEASURED = new Set([13, 8, 16, 18]);

/**
 * Whether macOS lifts this footage's mid-tones when it shows the <video> (tone.ts). D222, measured
 * in the packaged app on H.264 grey ramps: it goes by the picture's height, not its tags: 360 lines
 * and up are lifted (640×360, 360×360, 352×640, 720×404, HD; untagged, BT.709- or BT.601-tagged),
 * below aren't (320×180 even tagged BT.709, 640×352, 656×352, 1024×288). Likely Chromium's
 * hardware-decode path, which only takes 360 lines and up. `height`: the <video>'s videoHeight.
 */
export function liftsTone(c: StreamColour | undefined, height: number): boolean {
  return height >= 360 && !(c?.transfer !== undefined && UNMEASURED.has(c.transfer));
}

/**
 * Issue #12 (D265): whether Chromium shows this <video> with SMPTE 170M (or BT.470BG) primaries
 * converted to BT.709's, as the export does for untagged SD (server untaggedFilter): its primaries
 * when tagged, else what its matrix implies, else BT.601 below 720 lines (decoderColour's reading).
 * The GPU compositor uploads a <video>'s values without that conversion, so it makes it itself.
 */
export function convertsPrimaries(c: StreamColour | undefined, height: number): boolean {
  if (c?.primaries !== undefined) return c.primaries === 5 || c.primaries === 6;
  if (c?.matrix !== undefined) return c.matrix === 5 || c.matrix === 6;
  return height > 0 && height < 720;
}
