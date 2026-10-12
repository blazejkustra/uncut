// Export settings shared by the server (which renders) and the renderer (whose dialog shows them).

export type ExportQuality = "draft" | "standard" | "high";

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The export size for a quality: Draft 720p, Standard 1080p (by the shorter side, never upscaled), High = the canvas. */
export function outputSize(canvas: { readonly width: number; readonly height: number }, quality: ExportQuality): { width: number; height: number } {
  const short = Math.min(canvas.width, canvas.height);
  const target = quality === "draft" ? 720 : quality === "standard" ? 1080 : short;
  const scale = Math.min(1, target / short);
  return { width: even(canvas.width * scale), height: even(canvas.height * scale) };
}
