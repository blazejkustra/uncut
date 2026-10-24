// The agent's shader effects (D213): shader_write builds one with TypeGPU from the agent's params
// and WGSL body (shaderBuild.ts; nothing of the agent's runs as JavaScript), checks it (core
// shaderDefProblems: bounded loops, no storage, no I/O), compiles and draws it once on a sample
// picture with the rasteriser's WebGPU (the same runner the preview and the export use), and keeps
// it in the project's shaders/ folder as <name>.json, id project.<name>. The agent applies it with
// timeline_edit (core expandShaderEffects fills in the definition): the clip carries a copy, so it
// draws the same whatever happens to the file.
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { shaderDefProblems, shaderFrameBytes, shaderModuleCode, shaderParamBytes, shaderValues, type ShaderDef, type ShaderParam } from "@uncut/core";
import { rasterizerCommand, startRasterizer } from "../export/rasterizer.ts";
import { buildShader } from "../plugins/shaderBuild.ts";

export const SHADER_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_FILE = 64 * 1024;

/** The project's own shader effects (shaders/*.json that still pass the checks), by id. */
export async function projectShaders(dir: string): Promise<Map<string, ShaderDef>> {
  const out = new Map<string, ShaderDef>();
  const folder = join(dir, "shaders");
  let names: Array<string>;
  try {
    const real = await realpath(folder);
    if (!real.startsWith(`${await realpath(dir)}${sep}`)) return out;
    names = (await readdir(real)).filter((n) => n.endsWith(".json") && SHADER_NAME.test(n.slice(0, -5))).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const raw = await readFile(join(folder, n), "utf8");
      if (raw.length > MAX_FILE) continue;
      const j = JSON.parse(raw) as Partial<ShaderDef>;
      const def: ShaderDef = {
        id: `project.${n.slice(0, -5)}`,
        name: String(j.name ?? n.slice(0, -5)).slice(0, 60),
        ...(typeof j.description === "string" ? { description: j.description.slice(0, 300) } : {}),
        params: Array.isArray(j.params) ? j.params : [],
        wgsl: String(j.wgsl ?? ""),
      };
      if (!shaderDefProblems(def).length) out.set(def.id, def);
    } catch {
      // a broken file is no effect
    }
  }
  return out;
}

/** A sample picture to try a shader on: a gradient sky, a sun, hills, sea and colour swatches (RGBA). */
function samplePicture(w: number, h: number): Buffer {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      let r = 60 + 180 * v;
      let g = 110 + 80 * v;
      let b = 190 - 100 * v;
      if (Math.hypot(u - 0.65, v - 0.45) < 0.08) [r, g, b] = [255, 244, 196];
      if (v > 0.62 + 0.06 * Math.sin(u * 9)) [r, g, b] = [59, 93, 58];
      if (v > 0.72) [r, g, b] = [30 + 30 * (1 - v), 90 - 40 * v, 120 - 50 * v];
      if (v > 0.82 && v < 0.94 && u > 0.4) {
        const swatch = [
          [230, 57, 70],
          [244, 211, 94],
          [42, 157, 143],
          [91, 75, 219],
          [255, 255, 255],
          [17, 17, 17],
        ][Math.min(5, Math.floor((u - 0.4) / 0.1))]!;
        [r, g, b] = swatch as [number, number, number];
      }
      const i = (y * w + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  return px;
}

export type ShaderWriteResult =
  | { readonly ok: true; readonly def: ShaderDef; readonly file: string; readonly png?: Buffer; readonly note?: string; readonly replaced: boolean }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

/**
 * Build, check, try and keep an effect (see the header). Never throws: problems come back as
 * sentences. `env` reaches the rasteriser command (tests: UNCUT_RENDER_ENTRY, UNCUT_TEST_NO_GPU).
 */
export async function writeProjectShader(
  dir: string,
  args: { readonly name: unknown; readonly title?: unknown; readonly description?: unknown; readonly params?: unknown; readonly body: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShaderWriteResult> {
  const name = args.name;
  if (typeof name !== "string" || !SHADER_NAME.test(name))
    return { ok: false, problems: ["name must be lowercase letters, digits and dashes (1–41), e.g. heat-haze; the effect's id becomes project.<name>."] };
  const params = (Array.isArray(args.params) ? args.params : []) as ReadonlyArray<ShaderParam>;
  const built = buildShader(params, typeof args.body === "string" ? args.body : "");
  if (!("wgsl" in built)) return { ok: false, problems: built.problems };
  const title =
    typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, 60) : name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  const def: ShaderDef = {
    id: `project.${name}`,
    name: title,
    ...(typeof args.description === "string" && args.description.trim() ? { description: args.description.trim().slice(0, 300) } : {}),
    params,
    wgsl: built.wgsl,
  };
  // Compiled and drawn once with WebGPU (the GPU's own compiler finds what the checks can't).
  let png: Buffer | undefined;
  let note: string | undefined;
  const command = rasterizerCommand(env);
  if ("problem" in command) note = `Not tried on the GPU here: ${command.problem}`;
  else {
    const temp = await mkdtemp(join(tmpdir(), "uncut-shader-write-"));
    const raster = await startRasterizer(command, env).catch((error: Error) => error);
    try {
      if (raster instanceof Error) note = `Not tried on the GPU here: ${raster.message}`;
      else {
        const W = 480;
        const H = 270;
        await writeFile(join(temp, "in.rgba"), samplePicture(W, H));
        const out = join(temp, "out.png");
        const params = shaderParamBytes(def.params, shaderValues(def.params, {}));
        const drawn = await raster
          .render({
            kind: "shader",
            width: W,
            height: H,
            code: shaderModuleCode(def),
            frame: [...new Float32Array(shaderFrameBytes(W, H, 0.5, false))],
            ...(params ? { params: [...new Float32Array(params)] } : {}),
            input: join(temp, "in.rgba"),
            out,
            name: def.name,
          })
          .then(
            () => undefined,
            (error: Error) => error.message.replace(/^The text renderer failed: /, ""),
          );
        if (drawn && drawn.startsWith("no-webgpu: "))
          note = `Saved, but not tried: this Mac has no WebGPU (${drawn.slice("no-webgpu: ".length).replace(/\.$/, "")}), so it can't be previewed or exported here.`;
        else if (drawn) return { ok: false, problems: [`It doesn't run on the GPU: ${drawn.replace(/^[^:]*: The shader doesn't compile: /, "WGSL: ")}`] };
        else png = await readFile(out);
      }
    } finally {
      if (!(raster instanceof Error)) await raster.close();
      await rm(temp, { recursive: true, force: true });
    }
  }
  const folder = join(dir, "shaders");
  try {
    await mkdir(folder, { recursive: true });
    const real = await realpath(folder);
    if (!real.startsWith(`${await realpath(dir)}${sep}`))
      return { ok: false, problems: ["The project's shaders folder points outside the project, so nothing was written."] };
    const file = join(real, `${name}.json`);
    const replaced = await readFile(file).then(
      () => true,
      () => false,
    );
    await writeFile(
      file,
      `${JSON.stringify({ name: def.name, ...(def.description ? { description: def.description } : {}), params: def.params, wgsl: def.wgsl, body: args.body }, null, 2)}\n`,
    );
    return { ok: true, def, file: `shaders/${name}.json`, ...(png ? { png } : {}), ...(note ? { note } : {}), replaced };
  } catch (error) {
    return { ok: false, problems: [`Couldn't write shaders/${name}.json: ${(error as Error).message}`] };
  }
}
