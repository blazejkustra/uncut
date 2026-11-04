// D328: face blur's masks for the export: for each frame of a layer, core faceCoverage of its face
// masks (planExport's, at the effects' size) as a grey picture, white where the picture is blurred,
// encoded losslessly (FFV1) for the export's graph. Only the pixels near a face are worked out.
import { spawn } from "node:child_process";
import { join } from "node:path";

import { type ClipMask, faceCoverage } from "@uncut/core";

import type { ExportPlan, VisualLayer } from "../exportPlan.ts";
import { Cancelled } from "./ffmpeg.ts";

/** One frame's mask: 0 to 255 per pixel of w × h. */
export function faceMaskFrame(masks: ReadonlyArray<ClipMask>, w: number, h: number, out = new Uint8Array(w * h)): Uint8Array {
  out.fill(0);
  for (const m of masks) {
    const reach = Math.max(m.feather, 1);
    const x0 = Math.max(0, Math.floor(m.x - reach));
    const y0 = Math.max(0, Math.floor(m.y - reach));
    const x1 = Math.min(w, Math.ceil(m.x + m.w + reach));
    const y1 = Math.min(h, Math.ceil(m.y + m.h + reach));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const v = Math.round(255 * faceCoverage(masks, x + 0.5, y + 0.5));
        if (v > out[y * w + x]!) out[y * w + x] = v;
      }
  }
  return out;
}

/** Writes grey frames to an FFV1 file through ffmpeg's stdin (4 threads). */
function encodeGrey(bin: string, w: number, h: number, fps: number, frames: number, frame: (i: number) => Uint8Array, out: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const args = ["-hide_banner", "-nostdin", "-y", "-v", "error", "-threads", "4", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${w}x${h}`, "-r", String(fps), "-i", "pipe:0", "-c:v", "ffv1", "-threads", "4", out];
    const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(new Cancelled());
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg couldn't write the face mask: ${stderr.trim().split("\n").slice(-2).join(" ")}`));
    });
    child.stdin.on("error", () => {});
    const writeFrom = (i: number) => {
      let next = i;
      while (next < frames) {
        const ok = child.stdin.write(frame(next++));
        if (!ok) return child.stdin.once("drain", () => writeFrom(next));
      }
      child.stdin.end();
    };
    writeFrom(0);
  });
}

/** The face mask videos of a plan's layers with face blur, by layer (files in `temp`). */
export async function writeFaceMasks(bin: string, plan: Pick<ExportPlan, "visuals" | "fps">, temp: string, signal: AbortSignal): Promise<Map<VisualLayer, string>> {
  const out = new Map<VisualLayer, string>();
  for (const [k, layer] of plan.visuals.entries()) {
    if ((layer.kind !== "video" && layer.kind !== "image") || !layer.fx?.faceMasks || !layer.fx.fx.faceBlur) continue;
    const { w, h, faceMasks } = layer.fx;
    const file = join(temp, `faces-${k}.mkv`);
    await encodeGrey(bin, w, h, plan.fps, layer.f1 - layer.f0, (i) => faceMaskFrame(faceMasks[i] ?? [], w, h), file, signal);
    out.set(layer, file);
  }
  return out;
}
