// D221 scrub cache (scrub.ts): the colour space frames are decoded with, and which footage is lifted.
import type { StreamColour } from "@uncut/core/mp4index";

const PRIMARIES: Record<number, VideoColorPrimaries> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020" as VideoColorPrimaries, 12: "smpte432" as VideoColorPrimaries };
const TRANSFER: Record<number, VideoTransferCharacteristics> = { 1: "bt709", 6: "smpte170m", 13: "iec61966-2-1", 8: "linear" as VideoTransferCharacteristics, 16: "pq" as VideoTransferCharacteristics, 18: "hlg" as VideoTransferCharacteristics };
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

/**
 * Whether macOS lifts this footage's mid-tones when it shows the <video> (tone.ts): measured for
 * the BT.709 transfer (tagged, or untagged from 720 lines up), not for BT.601's (untagged SD).
 */
export function liftsTone(c: StreamColour | undefined, height: number): boolean {
  return (c?.transfer ?? (height < 720 ? 6 : 1)) === 1;
}
