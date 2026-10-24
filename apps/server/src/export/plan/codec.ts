import { type ExportCodec, type ExportEncoder, defaultEncoder, presetBitrateMbps, HARDWARE_H264_QUALITY, SOFTWARE_H264_CRF } from "@uncut/core";
import type { Quality } from "./types.ts";

// ---- ffmpeg ----

/**
 * What the rasteriser made for a raster layer: one PNG, a numbered sequence (one file per frame,
 * hard links to its few looks), or a streamed layer's one lossless video (D291: FFV1, straight
 * BGRA, alpha exact) of `frames` frames.
 */
export type RasterOutput =
  | { readonly kind: "still"; readonly png: string }
  | { readonly kind: "sequence"; readonly pattern: string }
  | { readonly kind: "video"; readonly file: string; readonly frames: number };

export interface Caps {
  readonly encoders: ReadonlySet<string>;
  readonly videotoolboxDecode: boolean;
  /** ffmpeg's major version (undefined for builds that don't say, e.g. git snapshots). */
  readonly major?: number | undefined;
}

/** How to hand ffmpeg a filter graph in a file: `-/filter_complex` from 7 on, `-filter_complex_script` before (deprecated since 7). */
export const graphFileArgs = (caps: Pick<Caps, "major">, file: string) =>
  caps.major !== undefined && caps.major < 7 ? ["-filter_complex_script", file] : ["-/filter_complex", file];

/** F4 (D171): what the Advanced row changes; absent = the preset's (H.264, its encoder and rate). */
export interface VideoChoice {
  readonly codec?: ExportCodec | undefined;
  /** D212: hardware (VideoToolbox) or software; absent = the preset's (`defaultEncoder`). */
  readonly encoder?: ExportEncoder | undefined;
  readonly bitrateMbps?: number | undefined;
}

/** Whether this ffmpeg can make HEVC (VideoToolbox, else libx265). */
export const canHevc = (caps: Pick<Caps, "encoders">) => caps.encoders.has("hevc_videotoolbox") || caps.encoders.has("libx265");

/** D212: whether an export with these choices encodes with VideoToolbox on this ffmpeg. */
export function usesHardware(quality: Quality, caps: Pick<Caps, "encoders">, choice: VideoChoice = {}): boolean {
  const codec = choice.codec ?? "h264";
  const hardware = codec === "hevc" ? caps.encoders.has("hevc_videotoolbox") : caps.encoders.has("h264_videotoolbox");
  if (!hardware) return false;
  // HEVC without libx265 has only VideoToolbox, whatever was asked.
  if (codec === "hevc" && !caps.encoders.has("libx265")) return true;
  if (codec === "h264" && !caps.encoders.has("libx264")) return true;
  return (choice.encoder ?? defaultEncoder(quality)) === "hardware";
}

/**
 * Encoder arguments for a quality (D55, D171, D212): H.264 for every preset, HEVC only when chosen.
 * VideoToolbox for Draft and Standard, libx264 / libx265 for High, unless Advanced picks the
 * encoder (or this ffmpeg has only one). H.264 is constant quality (VideoToolbox `-q:v`, libx264
 * crf) unless a bitrate is set; HEVC aims at the preset's bitrate. `fps` is the output's rate.
 */
export function videoCodec(quality: Quality, caps: Caps, size: { width: number; height: number }, fps: number, choice: VideoChoice = {}): Array<string> {
  const codec = choice.codec ?? "h264";
  const chosen = choice.bitrateMbps !== undefined && choice.bitrateMbps > 0 ? `${Math.round(choice.bitrateMbps * 10) / 10}M` : undefined;
  const rate = chosen ?? `${presetBitrateMbps(quality, codec, size, fps)}M`;
  const hardware = usesHardware(quality, caps, choice);
  // The encoders don't all write the colour tags they're given, so the bitstream filter does.
  const tags = (c: ExportCodec) => ["-bsf:v", `${c}_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0`];
  if (codec === "hevc") {
    if (hardware) return ["-c:v", "hevc_videotoolbox", "-allow_sw", "1", "-profile:v", "main", "-b:v", rate, "-tag:v", "hvc1", ...tags("hevc")];
    return ["-c:v", "libx265", "-preset", quality === "draft" ? "veryfast" : "medium", "-b:v", rate, "-tag:v", "hvc1", ...tags("hevc")];
  }
  if (hardware)
    return [
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      "-profile:v",
      "high",
      ...(chosen ? ["-b:v", chosen] : ["-q:v", String(HARDWARE_H264_QUALITY[quality])]),
      ...(quality === "draft" ? ["-prio_speed", "1"] : []),
      "-tag:v",
      "avc1",
      ...tags("h264"),
    ];
  const preset = ["-preset", quality === "draft" ? "veryfast" : "medium"];
  if (chosen) return ["-c:v", "libx264", ...preset, "-b:v", chosen, "-tag:v", "avc1", ...tags("h264")];
  return ["-c:v", "libx264", ...preset, "-crf", String(SOFTWARE_H264_CRF[quality]), "-tag:v", "avc1", ...tags("h264")];
}

/**
 * D212: whether a failed encode looks like VideoToolbox refusing (no session, no constant-quality
 * mode on this Mac, a hardware error), so the export tries again with the software encoder.
 */
export const hardwareEncoderFailed = (stderr: string) =>
  /videotoolbox|VTCompression|compression session|Error (?:while opening|initializing output stream)|Could not open encoder|Error submitting video frame|encoder.*(?:not supported|failed)/i.test(
    stderr,
  );
