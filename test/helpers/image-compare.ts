// Comparing rendered PNGs with ffmpeg (no image libraries in the repo): raw RGBA pixels, a hash of
// them, how many aren't transparent, and SSIM over grayscale with transparency flattened on black.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** A PNG's pixels as RGBA bytes (width × height × 4). */
export const rgbaOf = (png: string): Buffer => execFileSync("ffmpeg", ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 256 * 1024 * 1024 });

/** A hash of a PNG's pixels (not its bytes: encoders may differ in metadata). */
export const pixelHash = (png: string) => createHash("sha256").update(rgbaOf(png)).digest("hex");

/** How many pixels have any opacity. */
export function opaquePixels(png: string): number {
  const px = rgbaOf(png);
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) n++;
  return n;
}

/** SSIM (0–1, "All") of two same-size images over grayscale, each flattened onto black first. */
export function ssim(a: string, b: string, width: number, height: number): number {
  const flat = (i: number) => `color=black:s=${width}x${height}[bg${i}];[bg${i}][${i}]overlay=format=auto:shortest=1,format=gray[g${i}]`;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-filter_complex", `${flat(0)};${flat(1)};[g0][g1]ssim`, "-f", "null", "-"], { encoding: "utf8" });
  const m = /All:([\d.]+)/.exec(r.stderr);
  if (!m) throw new Error(`ffmpeg ssim failed: ${r.stderr.slice(-400)}`);
  return Number(m[1]);
}
