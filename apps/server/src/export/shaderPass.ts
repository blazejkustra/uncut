// Shader effects in the export (D213): each shaded layer's picture decoded as the export shows it
// (exportPlan shaderSourceArgs: raw RGBA at the effects' size, piped out of ffmpeg), every frame
// drawn by the rasteriser's WebGPU (the preview's own runner) with t = its moment from the clip's
// start, and the drawn frames piped into a second ffmpeg that keeps them losslessly (FFV1) as the
// layer's picture (CommandOptions.shaded). The rest of the export (other effects, the box, opacity,
// transitions) then runs as for any clip.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { shaderFrameBytes, shaderModuleCode, shaderParamBytes, shaderTime, type ShaderUse } from "@uncut/core";
import { shaderSourceArgs, type CommandOptions, type ExportPlan, type VisualLayer } from "./exportPlan.ts";
import type { Rasterizer } from "./rasterizer.ts";
import { localInputs } from "../media/localInputs.ts";

/** The layers with a shader effect, in plan order. */
export const shadedLayers = (plan: Pick<ExportPlan, "visuals">) => plan.visuals.filter((l) => (l.kind === "video" || l.kind === "image") && !!l.fx?.shader);

const floats = (b: ArrayBuffer | undefined) => (b ? [...new Float32Array(b)] : undefined);
const clipName = (layer: VisualLayer) => `"${layer.item.name ?? layer.item.id}"`;

/** The sentence an export ends with when the rasteriser has no WebGPU. */
export function noWebGpuMessage(layer: VisualLayer, why: string): string {
  const use = (layer as { fx?: { shader?: ShaderUse } }).fx?.shader;
  return `Can't export: the clip ${clipName(layer)} uses the shader effect ${use?.def.name ?? "?"}, which needs WebGPU, and the export's renderer has none (${why.replace(/^no-webgpu: /, "").replace(/\.$/, "")}). Remove the effect, or export on a Mac with WebGPU.`;
}

/** Check, before any frame, that the rasteriser can draw shaders: throws the export's sentence if not. */
export async function checkShaders(r: Rasterizer, plan: Pick<ExportPlan, "visuals">): Promise<void> {
  const first = shadedLayers(plan)[0];
  if (!first) return;
  try {
    await r.render({ kind: "shader-probe" });
  } catch (error) {
    const m = /no-webgpu: .*/.exec((error as Error).message);
    throw new Error(noWebGpuMessage(first, m ? m[0] : (error as Error).message));
  }
}

interface Spawned {
  readonly child: ChildProcess;
  stderr: string;
  readonly done: Promise<number | null>;
}

function start(bin: string, args: ReadonlyArray<string>, stdin: "ignore" | "pipe"): Spawned {
  const child = spawn(bin, localInputs(bin, args), { stdio: [stdin, "pipe", "pipe"] });
  const s: Spawned = {
    child,
    stderr: "",
    done: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    }),
  };
  child.stderr!.on("data", (d: Buffer) => (s.stderr = (s.stderr + d).slice(-8000)));
  return s;
}

/** Reads exactly `size` bytes at a time from a stream (undefined at its end). */
function frameReader(stream: NodeJS.ReadableStream, size: number) {
  const chunks: Array<Buffer> = [];
  let have = 0;
  let ended = false;
  let wake: (() => void) | undefined;
  stream.on("data", (d: Buffer) => {
    chunks.push(d);
    have += d.length;
    if (have >= size) stream.pause();
    wake?.();
  });
  stream.on("end", () => {
    ended = true;
    wake?.();
  });
  return async (): Promise<Buffer | undefined> => {
    while (have < size && !ended) {
      stream.resume();
      await new Promise<void>((r) => (wake = r));
      wake = undefined;
    }
    if (have < size) return undefined;
    const all = Buffer.concat(chunks);
    chunks.length = 0;
    chunks.push(all.subarray(size));
    have = all.length - size;
    return all.subarray(0, size);
  };
}

/**
 * Draw every shaded layer's frames (see the header) into `dir`: the layer → its FFV1 file. Throws
 * with the clip, the effect and the moment when a frame can't be drawn; stops on `signal`.
 */
export async function shadeLayers(r: Rasterizer, bin: string, plan: ExportPlan, opts: Pick<CommandOptions, "caps" | "untagged">, dir: string, signal: AbortSignal, onFrame?: (done: number, total: number) => void): Promise<Map<VisualLayer, string>> {
  const out = new Map<VisualLayer, string>();
  const layers = shadedLayers(plan);
  if (!layers.length) return out;
  await checkShaders(r, plan);
  const total = layers.reduce((n, l) => n + l.f1 - l.f0, 0);
  let done = 0;
  for (const [j, layer] of layers.entries()) {
    if (layer.kind !== "video" && layer.kind !== "image") continue;
    const fx = layer.fx!;
    const use = fx.shader!;
    const { w, h } = fx;
    const frames = layer.f1 - layer.f0;
    const code = shaderModuleCode(use.def);
    const params = floats(shaderParamBytes(use.def.params, use.values));
    const file = join(dir, `shader-${j}.mkv`);
    const input = join(dir, `shader-${j}-in.rgba`);
    const drawn = join(dir, `shader-${j}-out.rgba`);
    const decode = start(bin, shaderSourceArgs(layer, opts, plan.width, plan.height, plan.fps), "ignore");
    const encode = start(bin, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-framerate", String(plan.fps), "-i", "pipe:0", "-c:v", "ffv1", "-pix_fmt", "bgra", file], "pipe");
    const kill = () => {
      decode.child.kill("SIGKILL");
      encode.child.kill("SIGKILL");
    };
    signal.addEventListener("abort", kill, { once: true });
    encode.child.stdin!.on("error", () => {});
    try {
      const next = frameReader(decode.child.stdout!, w * h * 4);
      let last: Buffer | undefined;
      for (let i = 0; i < frames; i++) {
        if (signal.aborted) throw new Error("cancelled");
        // A source that ends early (a probe that overstated it) holds its last frame, as the export's tpad does.
        const picture = (await next()) ?? last;
        if (!picture) throw new Error(`ffmpeg gave no picture for the clip ${clipName(layer)}: ${decode.stderr.trim().split("\n").at(-1) ?? ""}`);
        last = picture;
        await writeFile(input, picture);
        const t = shaderTime(layer.f0 + i, fx.start, plan.fps);
        await r
          .render({ kind: "shader", width: w, height: h, code, frame: floats(shaderFrameBytes(w, h, t, false))!, ...(params ? { params } : {}), input, out: drawn, name: `the shader effect ${use.def.name} on ${clipName(layer)}` })
          .catch((error: Error) => {
            const m = /no-webgpu: .*/.exec(error.message);
            throw new Error(m ? noWebGpuMessage(layer, m[0]) : `The shader effect ${use.def.name} on the clip ${clipName(layer)} couldn't be drawn at ${t.toFixed(2)} s: ${error.message.replace(/^The text renderer failed: /, "")}`);
          });
        const pixels = await readFile(drawn);
        if (!encode.child.stdin!.write(pixels)) await new Promise<void>((resolve) => encode.child.stdin!.once("drain", resolve));
        onFrame?.(++done, total);
      }
      decode.child.stdout!.resume();
      decode.child.kill("SIGKILL");
      encode.child.stdin!.end();
      const exit = await encode.done;
      if (exit !== 0) throw new Error(`ffmpeg couldn't keep the shader's frames: ${encode.stderr.trim().split("\n").at(-1) ?? ""}`);
      await decode.done.catch(() => null);
    } catch (error) {
      kill();
      await Promise.allSettled([decode.done, encode.done]);
      throw error;
    } finally {
      signal.removeEventListener("abort", kill);
    }
    out.set(layer, file);
  }
  return out;
}
