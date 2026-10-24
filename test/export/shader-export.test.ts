// Shader effects (D213) through the real renderers: a TypeGPU ripple (made with shaderBuild, as
// shader_write makes one) on Colours.mp4 (test/helpers/fx-fixture.ts, 640×360, a still picture, so
// only the shader's t moves it) in a 640×360 project.
// - the export: planExport, the rasteriser's WebGPU drawing each frame (shadeLayers), exportCommand
//   through ffmpeg to an H.264 mp4, frames read back;
// - determinism: the shader pass made twice gives the same pixels, frame for frame;
// - preview vs export: the preview's way (a <video> of the clip over HTTP, the runner bundled for the
//   rasteriser (apps/desktop/dist/shader-runner.js, the preview's own shaderRunner.ts) drawing into a
//   WebGPU canvas exactly as apps/web/src/preview/shader.ts does, the offscreen window captured)
//   against the exported frame: SSIM ≥ 0.98 at three moments; the ripple really is drawn (the
//   plain clip is further off) and moves with t;
// - fallback: a rasteriser without a GPU (UNCUT_TEST_NO_GPU) refuses the export with a sentence that
//   names the clip and the effect, and the runner says why there's no WebGPU;
// - the catalog's effects (plugins/catalog/typegpu-effects) and the shader template compile and draw
//   on the GPU at their defaults (each changes the picture, the same pixels twice); a contact sheet
//   of them is test-output/issue20-catalog.png;
// - shader_write (agentShaders.ts): built with TypeGPU, tried on the GPU, kept as shaders/<name>.json;
//   a body the GPU's compiler refuses is refused with its line; without WebGPU it's kept with a note.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  shaderEntry,
  shaderFrameBytes,
  shaderModuleCode,
  shaderParamBytes,
  type Project,
  type ShaderDef,
  type ShaderParam,
} from "../../packages/core/src/index.ts";
import { exportCommand, planExport, silentFailure, type ExportPlan } from "../../apps/server/src/export/exportPlan.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { checkShaders, shadeLayers } from "../../apps/server/src/export/shaderPass.ts";
import { buildShader } from "../../apps/server/src/plugins/shaderBuild.ts";
import { writeProjectShader } from "../../apps/server/src/agent/agentShaders.ts";
import { makeColours } from "../helpers/fx-fixture.ts";
import { ssim } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const RUNNER = resolve("apps/desktop/dist/shader-runner.js");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) || !existsSync(RUNNER) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 640;
const H = 360;
const FPS = 30;
const LENGTH = 30;
const MOMENTS = [0, 9, 23];

export const RIPPLE_PARAMS: ReadonlyArray<ShaderParam> = [
  { key: "amplitude", label: "Amplitude", type: "number", min: 0, max: 0.05, default: 0.012 },
  { key: "frequency", label: "Frequency", type: "number", min: 1, max: 80, default: 40 },
  { key: "speed", label: "Speed", type: "number", min: 0, max: 20, default: 6 },
  { key: "tint", label: "Tint", type: "color", default: "#9fd3ff" },
];
const RIPPLE_BODY = `(uv, t, size, p) {
  let c = uv - vec2f(0.5);
  let d = length(c * vec2f(size.x / size.y, 1.0));
  let off = normalize(c + vec2f(0.00001)) * sin(d * p.frequency - t * p.speed) * p.amplitude;
  let col = frame(uv + off);
  return vec4f(mix(col.rgb, col.rgb * p.tint, 0.35), 1.0);
}`;

let root = "";
let def: ShaderDef;
let server: Server;
let port = 0;
let raster: Rasterizer;
const caps = { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 };

const project = (): Project => ({
  format: "uncut/0",
  name: "Shader",
  canvas: { width: W, height: H, fps: FPS, background: "#000000" },
  media: [
    { id: "m-c", kind: "video", name: "Colours.mp4", path: join(root, "Colours.mp4"), probe: { frames: 60, fps: FPS, width: W, height: H, hasAudio: false } },
  ],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [{ id: "c1", type: "clip", media: "m-c", in: 0, duration: LENGTH, effects: [shaderEntry(def, { amplitude: 0.02, speed: 8 })] }],
    },
  ],
});

before(async () => {
  if (skip) return;
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-shader-export-")));
  makeColours(join(root, "Colours.mp4"));
  const built = buildShader(RIPPLE_PARAMS, RIPPLE_BODY);
  if (!("wgsl" in built)) throw new Error(built.problems.join(" "));
  def = { id: "project.ripple", name: "Ripple", params: RIPPLE_PARAMS, wgsl: built.wgsl };
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (path === "/preview.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PREVIEW_PAGE);
    }
    if (path === "/shader-runner.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(readFileSync(RUNNER));
    }
    if (path === "/Colours.mp4") {
      res.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "none" });
      return res.end(readFileSync(join(root, "Colours.mp4")));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  server?.close();
  if (process.env.UNCUT_KEEP_OUTPUT) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

/** The plan of the project. */
function plan(): ExportPlan {
  const p = planExport(project(), { mediaPath: (m) => m.path, width: W, height: H });
  if ("problem" in p) throw new Error(p.problem);
  return p;
}

/** The shader pass into a folder of its own: the layer's FFV1 file. */
async function shade(name: string): Promise<{ plan: ExportPlan; file: string; shaded: Map<never, string> }> {
  const p = plan();
  const folder = join(root, name);
  mkdirSync(folder);
  const shaded = await shadeLayers(raster, "ffmpeg", p, { caps }, folder, new AbortController().signal);
  assert.equal(shaded.size, 1);
  return { plan: p, file: [...shaded.values()][0]!, shaded: shaded as Map<never, string> };
}

const framesHash = (file: string) =>
  createHash("sha256")
    .update(execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 256 << 20 }))
    .digest("hex");

/** The whole export (H.264 4:2:0, as a user gets it), its frames at MOMENTS as PNGs. */
async function exportFrames(): Promise<Array<string>> {
  const { plan: p, shaded } = await shade("export");
  const bg = join(root, "bg.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`, "-frames:v", "1", bg]);
  const out = join(root, "export.mp4");
  const cmd = exportCommand(p, { background: bg, rasters: new Map(), caps, quality: "high", output: out, shaded });
  writeFileSync(join(root, "graph.txt"), cmd.graph);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...cmd.inputs, "-/filter_complex", join(root, "graph.txt"), ...cmd.outputArgs], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  assert.equal(silentFailure(r.stderr), undefined);
  return MOMENTS.map((f) => {
    const png = join(root, `export-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", out, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", png]);
    return png;
  });
}

/**
 * The preview stand-in's page: Preview.tsx's shader path (shader.ts) on a <video> of the clip: a
 * WebGPU canvas at the effects' size, configured with the preferred format and premultiplied alpha,
 * drawn by the runner from the video element with t from the clip's start.
 */
const PREVIEW_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}canvas,video{position:absolute;left:0;top:0;width:${W}px;height:${H}px}video{visibility:hidden}</style>
<script src="/shader-runner.js"></script></head><body><video muted playsinline src="/Colours.mp4"></video><canvas width="${W}" height="${H}"></canvas>
<script>
const video = document.querySelector("video");
const canvas = document.querySelector("canvas");
let runner, context;
window.ready = (async () => {
  await new Promise((done) => video.readyState >= 2 ? done() : video.addEventListener("loadeddata", done, { once: true }));
  const r = await UncutShader.ShaderRunner.create();
  if ("problem" in r) return r.problem;
  runner = r;
  context = canvas.getContext("webgpu");
  context.configure({ device: runner.device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "premultiplied" });
  return true;
})();
window.draw = async (a) => {
  video.currentTime = a.source;
  await new Promise((done) => video.addEventListener("seeked", done, { once: true }));
  const format = navigator.gpu.getPreferredCanvasFormat();
  const pipeline = await runner.pipeline(a.code, format);
  if (typeof pipeline === "string") return pipeline;
  runner.drawToCanvas(pipeline, { kind: "external", source: video, width: video.videoWidth, height: video.videoHeight }, { code: a.code, frame: new Float32Array(a.frame).buffer, params: new Float32Array(a.params).buffer, width: a.width, height: a.height }, context);
  await runner.device.queue.onSubmittedWorkDone();
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  return true;
};
</script></body></html>`;

const PREVIEW_MAIN = `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("fs");
const { url, width, height, jobs, profile, noGpu } = JSON.parse(process.env.UNCUT_PREVIEW_JOBS);
app.setPath("userData", profile);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
if (noGpu) app.commandLine.appendSwitch("disable-gpu");
app.dock && app.dock.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width, height, useContentSize: true, frame: false, enableLargerThanScreen: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.setContentSize(width, height);
  await win.loadURL(url);
  const ready = await win.webContents.executeJavaScript("window.ready");
  if (ready !== true) { console.log("NO-WEBGPU " + ready); app.exit(0); return; }
  for (const job of jobs) {
    const answer = await win.webContents.executeJavaScript("window.draw(" + JSON.stringify(job.args) + ")");
    if (answer !== true) throw new Error("draw failed: " + answer);
    const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    writeFileSync(job.out, image.toPNG());
  }
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
`;

/** Runs the preview stand-in (an Electron of its own, the page over HTTP from this process). */
async function preview(jobs: ReadonlyArray<{ args: unknown; out: string }>, noGpu = false): Promise<string> {
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const main = join(root, "preview-main.cjs");
  writeFileSync(main, PREVIEW_MAIN);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UNCUT_PREVIEW_JOBS: JSON.stringify({
      url: `http://127.0.0.1:${port}/preview.html`,
      width: W,
      height: H,
      jobs,
      profile: join(root, `preview-profile-${noGpu ? "nogpu" : "gpu"}`),
      noGpu,
    }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  const code = await new Promise<number | null>((done) => child.on("exit", (c) => done(c)));
  clearTimeout(timer);
  assert.equal(code, 0, `preview run failed: ${output}`);
  return output;
}

test("D213: the shader pass draws the same pixels twice, and it moves with t", { skip, timeout: 120000 }, async () => {
  const a = await shade("pass-a");
  const b = await shade("pass-b");
  assert.equal(framesHash(a.file), framesHash(b.file), "two passes, the same frames");
  const frame = (file: string, n: number) =>
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
      maxBuffer: 64 << 20,
    });
  assert.notDeepEqual(frame(a.file, 0), frame(a.file, 12), "t moves the ripple");
  assert.equal(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,width,height", "-of", "csv=p=0", a.file],
      { encoding: "utf8" },
    ).trim(),
    `${W},${H},${LENGTH}`,
  );
});

test("D213: preview vs export, SSIM ≥ 0.98 at three moments (and the ripple is drawn)", { skip, timeout: 180000 }, async () => {
  const exported = await exportFrames();
  const code = shaderModuleCode(def);
  const values = project().tracks[0]!.items[0]!.effects![0]!.params!.values as Record<string, number | string>;
  const params = [...new Float32Array(shaderParamBytes(def.params, values)!)];
  // The source frame shown at frame f (Colours.mp4 is a still picture: any moment of it is the same).
  const jobs = MOMENTS.map((f) => ({
    args: { code, frame: [...new Float32Array(shaderFrameBytes(W, H, f / FPS, true))], params, width: W, height: H, source: (f + 0.5) / FPS },
    out: join(root, `preview-${f}.png`),
  }));
  await preview(jobs);
  const plain = join(root, "plain.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(root, "Colours.mp4"), "-frames:v", "1", plain]);
  const scores: Array<string> = [];
  for (const [i, f] of MOMENTS.entries()) {
    const s = ssim(jobs[i]!.out, exported[i]!, W, H);
    const unshaded = ssim(plain, exported[i]!, W, H);
    scores.push(`${f}: ${s.toFixed(4)} (plain clip ${unshaded.toFixed(4)})`);
    assert.ok(s >= 0.98, `frame ${f}: preview vs export SSIM ${s.toFixed(4)}`);
    assert.ok(unshaded < s - 0.01, `frame ${f}: the ripple is drawn (plain clip vs export ${unshaded.toFixed(4)}, preview ${s.toFixed(4)})`);
  }
  console.log(`  preview vs export SSIM: ${scores.join(", ")}`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    jobs[1]!.out,
    "-i",
    exported[1]!,
    "-filter_complex",
    "hstack",
    resolve("test-output/issue20-preview-vs-export.png"),
  ]);
});

test("D213: without WebGPU the export refuses with why, and the runner says there's none", { skip, timeout: 120000 }, async () => {
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP, UNCUT_TEST_NO_GPU: "1" });
  if ("problem" in command) throw new Error(command.problem);
  assert.ok(command.args.includes("--uncut-no-gpu"));
  const blind = await startRasterizer(command);
  try {
    await assert.rejects(checkShaders(blind, plan()), (error: Error) => {
      assert.match(
        error.message,
        /^Can't export: the clip "c1" uses the shader effect Ripple, which needs WebGPU, and the export's renderer has none \(.+\)\. Remove the effect, or export on a Mac with WebGPU\.$/,
      );
      return true;
    });
    // The same through the pass itself: nothing drawn, the same sentence.
    await assert.rejects(shadeLayers(blind, "ffmpeg", plan(), { caps }, root, new AbortController().signal), /needs WebGPU/);
  } finally {
    await blind.close();
  }
  const said = await preview([], true);
  assert.match(said, /NO-WEBGPU .*(WebGPU|GPU)/);
});

test("D213: the catalog's effects and the shader template compile and draw on the GPU", { skip, timeout: 120000 }, async () => {
  const manifests = ["plugins/catalog/typegpu-effects/uncut.module.json", "plugins/catalog/_shader-template/uncut.module.json"].map((f) =>
    JSON.parse(readFileSync(f, "utf8")),
  );
  const input = join(root, "catalog-in.rgba");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(root, "Colours.mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", input]);
  const source = readFileSync(input);
  const pngs: Array<string> = [];
  for (const m of manifests)
    for (const e of m.contributes.shaders as Array<ShaderDef & { export: string }>) {
      const values = Object.fromEntries(e.params.map((p) => [p.key, p.default]));
      const params = shaderParamBytes(e.params, values);
      const job = (out: string) =>
        raster.render({
          kind: "shader",
          width: W,
          height: H,
          code: shaderModuleCode(e),
          frame: [...new Float32Array(shaderFrameBytes(W, H, 0.7, false))],
          ...(params ? { params: [...new Float32Array(params)] } : {}),
          input,
          out,
          name: e.id,
        });
      const a = join(root, `${e.id}-a.rgba`);
      const b = join(root, `${e.id}-b.rgba`);
      await job(a);
      await job(b);
      assert.deepEqual(readFileSync(a), readFileSync(b), `${e.id}: the same pixels twice`);
      let changed = 0;
      const px = readFileSync(a);
      for (let i = 0; i < px.length; i += 4)
        if (Math.abs(px[i]! - source[i]!) + Math.abs(px[i + 1]! - source[i + 1]!) + Math.abs(px[i + 2]! - source[i + 2]!) > 12) changed++;
      assert.ok(changed / (W * H) > 0.05, `${e.id} changes the picture (${((100 * changed) / (W * H)).toFixed(1)}% of pixels)`);
      const png = join(root, `${e.id}.png`);
      await job(png);
      pngs.push(png);
    }
  assert.equal(pngs.length, 5);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...pngs.flatMap((p) => ["-i", p]),
    "-filter_complex",
    `${pngs.map((_, i) => `[${i}:v]scale=320:180[s${i}]`).join(";")};${pngs.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${pngs.length}:layout=0_0|320_0|640_0|0_180|320_180:fill=black`,
    resolve("test-output/issue20-catalog.png"),
  ]);
});

test(
  "D213: shader_write builds with TypeGPU, tries it on the GPU and keeps it; refuses what the GPU refuses; without WebGPU it says so",
  { skip, timeout: 120000 },
  async () => {
    const project = join(root, "Written.uncut");
    mkdirSync(project);
    const env = { ...process.env, UNCUT_RENDER_ENTRY: DESKTOP };
    const ok = await writeProjectShader(
      project,
      {
        name: "scan-wave",
        title: "Scan wave",
        params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 0.05, default: 0.01 }],
        body: "(uv, t, size, p) { let c = frame(uv + vec2f(sin(uv.y * 40.0 + t * 4.0) * p.amount, 0.0)); return vec4f(c.rgb, 1.0); }",
      },
      env,
    );
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal(ok.def.id, "project.scan-wave");
    assert.equal(ok.file, "shaders/scan-wave.json");
    assert.ok(ok.png && ok.png.subarray(1, 4).toString() === "PNG", "a picture of it on the sample");
    writeFileSync(resolve("test-output/issue20-shader-write.png"), ok.png!);
    const saved = JSON.parse(readFileSync(join(project, "shaders", "scan-wave.json"), "utf8"));
    assert.equal(saved.wgsl, ok.def.wgsl);
    assert.equal(ok.replaced, false);
    // The GPU's own compiler: a call to nothing passes the checks but not WebGPU.
    const bad = await writeProjectShader(project, { name: "broken", body: "(uv, t, size) { return nothing(uv); }" }, env);
    assert.ok(!bad.ok);
    assert.match(bad.problems[0]!, /^It doesn't run on the GPU: .*nothing/);
    assert.ok(!existsSync(join(project, "shaders", "broken.json")), "nothing kept");
    // The checks before the GPU: a loop.
    const looped = await writeProjectShader(project, { name: "looped", body: "(uv, t, size) { loop { } }" }, env);
    assert.ok(!looped.ok);
    assert.match(looped.problems.join(" "), /can't use loop/);
    const badName = await writeProjectShader(project, { name: "Bad Name", body: "(uv, t, size) { return frame(uv); }" }, env);
    assert.ok(!badName.ok);
    assert.match(badName.problems[0]!, /lowercase letters/);
    // No WebGPU: kept, with a note that says so (it can't be previewed or exported here).
    const blind = await writeProjectShader(project, { name: "scan-wave", body: "(uv, t, size) { return frame(uv); }" }, { ...env, UNCUT_TEST_NO_GPU: "1" });
    assert.ok(blind.ok);
    assert.equal(blind.replaced, true);
    assert.equal(blind.png, undefined);
    assert.match(blind.note!, /^Saved, but not tried: this Mac has no WebGPU \(.+\), so it can't be previewed or exported here\.$/);
  },
);
