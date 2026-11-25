// HDR footage (HLG, PQ) is tone-mapped to SDR BT.709 by swscale's colour management (ffmpeg 8+;
// the ffmpeg Uncut ships has no zimg or libplacebo). An ffmpeg without it leaves the picture as is.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { hdrKind, type HdrKind, type MediaColour } from "@uncut/core";

import { withoutApiKey } from "../app/shellEnv.ts";
import { colourOf, posterKey } from "./mediaLibrary/helpers.ts";
import { runProbe } from "./probe.ts";

const IN_TRANSFER: Readonly<Record<HdrKind, string>> = { HLG: "arib-std-b67", PQ: "smpte2084" };

export const COLOUR_ENTRIES = "stream=color_transfer,color_primaries,color_space,bits_per_raw_sample,pix_fmt";

async function probeColour(ffprobe: string, path: string): Promise<MediaColour | undefined> {
  const r = await runProbe(
    ffprobe,
    ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-show_entries", COLOUR_ENTRIES, "-of", "json", path],
    { timeoutMs: 15000, env: withoutApiKey(process.env) },
  );
  if (r.kind !== "done" || r.code !== 0) return undefined;
  try {
    return colourOf((JSON.parse(r.stdout) as { streams?: Array<Record<string, unknown>> }).streams?.[0]);
  } catch {
    return undefined;
  }
}

const colours = new Map<string, Promise<MediaColour | undefined>>();

/** A file's colour, asked of ffprobe once per version of the file (its path, size and modification time). */
export async function fileColour(ffprobe: string | undefined, path: string): Promise<MediaColour | undefined> {
  const key = await posterKey(path);
  if (!ffprobe || !key) return undefined;
  const name = `${path}\0${key}`;
  let colour = colours.get(name);
  if (!colour) {
    if (colours.size > 512) colours.clear();
    colour = probeColour(ffprobe, path);
    colours.set(name, colour);
  }
  return colour;
}

/** The filter that tone-maps HDR to SDR BT.709 (limited range); "" for anything else. */
export function toneMapFilter(colour: MediaColour | undefined): string {
  const kind = hdrKind(colour);
  if (!kind) return "";
  return `scale=in_transfer=${IN_TRANSFER[kind]}:in_primaries=bt2020:out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709:out_range=tv:intent=perceptual`;
}

const support = new Map<string, Promise<boolean>>();

/** Whether this ffmpeg's scale filter does colour management (ffmpeg 8 and later), asked once per binary. */
export function toneMapSupported(ffmpeg: string): Promise<boolean> {
  let known = support.get(ffmpeg);
  if (!known) {
    known = runProbe(ffmpeg, ["-hide_banner", "-h", "filter=scale"], { timeoutMs: 10000, env: withoutApiKey(process.env), maxBytes: 256 * 1024 }).then(
      (r) => r.kind === "done" && /\bout_transfer\b/.test(r.stdout) && /\bintent\b/.test(r.stdout),
    );
    support.set(ffmpeg, known);
  }
  return known;
}

/** The tone map for a file read by this ffmpeg (its ffprobe beside it): "" for SDR, or when this ffmpeg can't. */
export async function toneMapFor(ffmpeg: string, path: string): Promise<string> {
  const colour = await fileColour(join(dirname(ffmpeg), "ffprobe"), path);
  if (!hdrKind(colour) || !(await toneMapSupported(ffmpeg))) return "";
  return toneMapFilter(colour);
}

/**
 * The cache key of pictures made from a file (proxies, posters, filmstrips): its posterKey, and for
 * HDR another one, so pictures made before HDR was tone-mapped are made again.
 */
export async function pictureKey(ffprobe: string | undefined, path: string): Promise<string | undefined> {
  const key = await posterKey(path);
  if (!key || !hdrKind(await fileColour(ffprobe, path))) return key;
  return createHash("sha1").update(`${key}\0sdr`).digest("hex").slice(0, 12);
}
