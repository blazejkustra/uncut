// D193 through the real renderers: graphics that load bundled libraries (a lit three.js cube
// turning with t, a confetti burst) drawn by the export rasteriser (apps/desktop render.ts: the
// document as a top-level data: URL in an offscreen window, every other request cancelled) and by
// the preview's way (a sandboxed iframe, allow-scripts, of the graphic route's document over HTTP,
// render(t) by postMessage), then compared.
// - determinism: the same frame drawn twice by the export is the same pixels;
// - preview vs export: SSIM ≥ 0.98;
// - the frame isn't empty (the cube is drawn: WebGL works in the offscreen export window).
// What's compared on the preview side: the route's bytes come from the same functions the route
// calls (readGraphics with the bundled libraries, then graphicDocument), served by a small HTTP
// server here with the route's CSP and sandbox headers; the page around the iframe is a stand-in
// for the editor's (Preview.tsx: an <iframe sandbox="allow-scripts"> at canvas size, render asked
// by postMessage, captured after the "rendered" answer once a sentinel row shows that frame), in a
// hidden offscreen Electron window.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { GRAPHIC_CSP, graphicDocument, graphicInfo, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { opaquePixels, pixelHash, ssim } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 640;
const H = 360;
const canvas = { width: W, height: H, fps: 30 };

const CUBE = `<canvas id="c"></canvas>
<script src="uncut:lib/three.js"></script>
<script>
let renderer, scene, camera, cube;
function setup(info) {
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(info.width, info.height);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, info.width / info.height, 0.1, 100);
  camera.position.set(0, 0, 5);
  cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshStandardMaterial({ color: 0x3399ff, roughness: 0.4 }));
  scene.add(cube);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(2, 3, 4);
  scene.add(sun);
}
window.render = (t, info) => {
  if (!renderer) setup(info);
  cube.rotation.set(t * 0.7, t * 1.1, 0);
  renderer.render(scene, camera);
};
</script>`;

const CONFETTI = `<canvas id="c"></canvas>
<script src="uncut:lib/confetti.js"></script>
<script src="uncut:lib/random.js"></script>
<script>
const c = document.getElementById("c");
window.render = (t, info) => {
  c.width = info.width;
  c.height = info.height;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const rnd = uncutRandom(5);
  uncutConfetti.draw(ctx, t, { seed: 11, count: 220, origin: { x: rnd.range(0.4, 0.6), y: 0.8 }, size: 1.6 });
};
</script>`;

// Uncut's own UI parts (uncut:lib/ui.js) as live DOM, animated from t: the composer typing
// with its caret and a pressed Send, the timeline's clips and playhead, the export's progress, the
// review's bars filling, a canvas of the graphic's own in the preview's frame, the pointer. On the
// first frame every slot of every part must resolve (a missing one fails the frame).
const UI = `<div id="stage" style="position:absolute;left:0;top:0;width:640px;height:360px;background:#f1f0ed;overflow:hidden"></div>
<script src="uncut:lib/motion.js"></script>
<script src="uncut:lib/ui.js"></script>
<script>
const stage = document.getElementById("stage");
const host = (x, y) => { const d = document.createElement("div"); d.style.cssText = "position:absolute;left:" + x + "px;top:" + y + "px"; stage.appendChild(d); return d; };
const at = { composer: host(16, 16), review: host(16, 150), timeline: host(250, 230), exportProgress: host(250, 16), preview: host(430, 110), seq: host(0, 0), carry: host(0, 0), frame: host(0, 0), piece: host(0, 0), stage: host(470, 250) };
const pic = document.createElement("canvas");
pic.width = 108; pic.height = 135;
const pic2 = document.createElement("canvas");
pic2.width = 108; pic2.height = 135;
pic2.getContext("2d").fillStyle = "#3a7";
pic2.getContext("2d").fillRect(0, 0, 108, 135);
let checked = false;
window.render = (t) => {
  if (!checked) {
    const scratch = host(0, 0);
    // The turn's reply, edit row and review card, and clips, show only when passed (the fixture's are left out).
    const clips = { clips: [{ track: "Main", start: 0, duration: 2, name: "A" }] };
    const bring = { turn: { steps: ["Read the brand kit"], reply: "Done.", edit: "Placed the clips on Main", review: true }, timeline: clips, editor: { timeline: clips } };
    for (const n of uncutUI.parts()) {
      const full = uncutUI.mount(scratch, n, bring[n]);
      for (const s of uncutUI.slots(n)) if (!uncutUI.find(full, s)) throw new Error(n + ": no slot " + s);
      const root = uncutUI.mount(scratch, n);
      // Mounted without props, no part states a run fact (a result, round, score, model, time).
      // Field values count too (an input's value isn't its text): the export's file name, the clip's timings.
      const said = (root.textContent + " " + [...root.querySelectorAll("input")].map((i) => i.value).join(" ")).match(/Passed|round \\d|Opus|\\d+ s left|BPM|\\d+ edits|Electro Dreams|Keyboard typing|Airy whoosh|Rendering… \\d|Wrote graphic|Launch film|DJI 0063|00:00:28|00:00:07:00|00:00:09:42|00:00:16:42/);
      if (said) throw new Error(n + ": states " + said[0] + " without props");
      // Asked for, the turn's review card is a blank one too: the fixture's result and scores never come back with it.
      if (n === "turn" && (/Passed|round \\d/.test(full.textContent) || uncutUI.findAll(full, ".score-value").some((v) => v.textContent))) throw new Error("turn: review: true shows the fixture's result or scores");
      if (n === "review" && uncutUI.findAll(root, "score").some((r) => r.querySelector(".score-value").textContent)) throw new Error("review: a score without props");
    }
    // Every slot also stands alone as a piece (built, measured, unboxed).
    for (const n of uncutUI.parts()) for (const s of uncutUI.slots(n)) uncutUI.piece(scratch, n + "." + s, { width: 100, props: bring[n] });
    scratch.remove();
    checked = true;
  }
  const prompt = "Make a 28 s launch film for Uncut on the beat";
  uncutUI.mount(at.composer, "composer", { scale: 0.5, text: prompt.slice(0, Math.floor(t * 24)), caret: true, press: { send: t > 1.2 ? 0.95 : 1 } });
  uncutUI.mount(at.review, "review", { scale: 0.42, progress: Math.min(1, t / 1.5), scores: { hook: 7, motion: 6 } });
  uncutUI.mount(at.timeline, "timeline", { scale: 0.2, playhead: t * 3, clips: [{ track: "Main", start: 0, duration: 3 + t, name: "DJI 0055", selected: true }, { track: "Main", start: 3.1 + t, duration: 4, name: "DJI 0063" }] });
  uncutUI.mount(at.exportProgress, "exportProgress", { scale: 0.5, progress: Math.min(1, t / 3), eta: 30 - t * 10 });
  const ctx = pic.getContext("2d");
  ctx.fillStyle = "hsl(" + Math.round(t * 90) + ", 70%, 50%)";
  ctx.fillRect(0, 0, 108, 135);
  uncutUI.mount(at.preview, "preview", { scale: 0.15, frame: pic, time: t });
  // Pieces: the composer's box morphing into the agent's steps (mid-morph at frame 40), the Saved pill alone.
  uncutUI.sequence(at.seq, t, [{ at: 0, piece: "composer.box", props: { text: prompt }, size: { width: 200 }, width: 220, x: 320, y: 300 }, { at: 1.2, piece: "turn.steps", props: { steps: ["Read the brand kit", "Placed the clips on Main"] }, size: { width: 200 }, width: 240, x: 330, y: 290 }]);
  // Mid-morph at frame 40 too: the prompt carried into its message, pushed in from the left, light; a leaving preview frame, cropped by the shell, giving way to the export's job.
  uncutUI.sequence(at.carry, t, [{ at: 0, piece: "composer", props: { text: prompt }, width: 200, type: 12, x: 110, y: 300 }, { at: 1.2, piece: "message", props: { text: prompt }, carry: [["input", "text"]], from: "left", theme: "light", width: 180, type: 12, x: 120, y: 310 }]);
  uncutUI.sequence(at.frame, t, [{ at: 0, piece: "preview.frame", props: { frame: pic2 }, width: 120, x: 560, y: 300 }, { at: 1.2, piece: "exportProgress.job", props: { progress: Math.min(1, t / 3) }, from: "right", width: 140, type: 10, x: 560, y: 300 }]);
  uncutUI.piece(at.piece, "topbar.saved", { width: 90, x: 590, y: 30 });
  // The program as a live stage, blurred then in focus: steps, clips and the playhead moving, the Inspector
  // tab and the export running over it; mid-flight at frame 40, the hero composer docking into its slot
  // and a media tile flying onto the timeline as its clip.
  const ed = uncutUI.mount(at.stage, "editor", { width: 1200, height: 800, scale: 0.12, blur: 2 * Math.max(0, 1 - t), dim: 0.3 * Math.max(0, 1 - t), media: [{ name: "A", meta: "Video", image: pic2.toDataURL(), duration: 12 }], topbar: { title: "Film" }, turn: { steps: ["Read the brand kit", "Found the beats"].slice(0, 1 + (t > 0.5)), done: t > 0.8 ? 2 : 0 }, timeline: { clips: t > 0.3 ? [{ track: "Main", start: 0, duration: 2 + t, name: "A" }] : [], playhead: t }, side: t > 1.1 ? "inspector" : undefined, inspector: { title: "A", filter: "Warm", amount: 50 }, exportProgress: t > 1.3 ? { progress: t / 3 } : undefined });
  uncutUI.fly(stage, t, { id: "dock", at: 0.4, dur: 0.6, from: { piece: "composer", props: { text: prompt }, width: 150, type: 9, x: 520, y: 200 }, to: uncutUI.find(ed, "composer") });
  uncutUI.fly(stage, t, { id: "tile", at: 0.35, dur: 0.6, from: ed.querySelector('[data-testid="media-tile"] .thumb'), to: ed.querySelector(".tl-lane.main .clip"), arc: -20 });
  uncutUI.cursor(stage, { x: 120 + t * 40, y: 90, scale: t > 1.2 && t < 1.35 ? 0.85 : 1, size: 18 });
};
</script>`;

/** The preview stand-in: an Electron main that loads the host page, asks for each frame and captures it. */
const PREVIEW_MAIN = `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("fs");
const { url, width, height, jobs, profile } = JSON.parse(process.env.UNCUT_PREVIEW_JOBS);
app.setPath("userData", profile);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.dock && app.dock.hide();
// One row taller than the canvas: the graphic's sentinel row (see PREVIEW_SENTINEL).
const nextPaint = (win) => new Promise((done) => {
  const finish = () => { clearTimeout(timer); win.webContents.off("paint", finish); done(); };
  const timer = setTimeout(finish, 1000);
  win.webContents.on("paint", finish);
  win.webContents.invalidate();
});
// The page as drawn once its sentinel row shows the frame's mark: on a busy machine (a CI VM, #88)
// a capture right after "rendered" can copy an older frame, as the export's grab (render.ts) knows.
const grab = async (win, mark) => {
  const until = Date.now() + 10000;
  for (;;) {
    await nextPaint(win);
    const image = await win.webContents.capturePage({ x: 0, y: 0, width, height: height + 1 });
    const row = image.crop({ x: 0, y: height, width: 1, height: 1 }).toBitmap();
    const seen = (row[2] > 127 ? 4 : 0) + (row[1] > 127 ? 2 : 0) + (row[0] > 127 ? 1 : 0);
    if (image.getSize().height === height + 1 && seen === mark) return image.crop({ x: 0, y: 0, width, height });
    if (Date.now() > until) throw new Error("the rendered frame never reached the capture");
  }
};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width, height: height + 1, useContentSize: true, frame: false, transparent: true, backgroundColor: "#00000000", enableLargerThanScreen: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.setContentSize(width, height + 1);
  await win.loadURL(url);
  await win.webContents.executeJavaScript("window.ready");
  for (const job of jobs) {
    const answer = await win.webContents.executeJavaScript("window.renderAt(" + JSON.stringify(job.t) + ", " + JSON.stringify(job.info) + ")");
    if (typeof answer !== "number") throw new Error("render failed: " + answer);
    writeFileSync(job.out, (await grab(win, answer)).toPNG());
  }
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
`;

/** Appended to the served document (see `served`): the sentinel row at y = H, set on request. */
const PREVIEW_SENTINEL = `<script>addEventListener("message", (e) => {
  if (!e.data || e.data.uncut !== "sentinel") return;
  let s = document.getElementById("__uncut_sentinel");
  if (!s) { s = document.createElement("div"); s.id = "__uncut_sentinel"; s.style.cssText = "position:fixed;left:0;right:0;top:${H}px;height:1px;z-index:2147483647"; document.documentElement.appendChild(s); }
  const m = e.data.mark;
  s.style.background = "rgb(" + (m & 4 ? 255 : 0) + "," + (m & 2 ? 255 : 0) + "," + (m & 1 ? 255 : 0) + ")";
  parent.postMessage({ uncut: "sentinel-set", mark: m }, "*");
});</script>`;

const hostPage = (
  src: string,
) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}iframe{border:0;display:block;width:${W}px;height:${H + 1}px}</style></head><body>
<iframe sandbox="allow-scripts" src="${src}"></iframe>
<script>
const frame = document.querySelector("iframe");
window.ready = new Promise((done) => frame.addEventListener("load", () => done(true)));
let seq = 0;
window.renderAt = (t, info) => new Promise((done) => {
  const mine = ++seq;
  const on = (e) => { if (e.data && e.data.uncut === "rendered" && e.data.seq === mine) { removeEventListener("message", on); if (e.data.error) return done(e.data.error);
    // Rendered: the graphic's sentinel row takes this frame's mark (1–7), so the capture can tell it from an older frame.
    const mark = (mine % 7) + 1;
    const set = (m) => { if (m.data && m.data.uncut === "sentinel-set" && m.data.mark === mark) { removeEventListener("message", set); done(mark); } };
    addEventListener("message", set);
    frame.contentWindow.postMessage({ uncut: "sentinel", mark }, "*"); } };
  addEventListener("message", on);
  frame.contentWindow.postMessage({ uncut: "render", seq: mine, t, info }, "*");
});
</script></body></html>`;

let root: string;
let dir: string;
let docs: Map<string, string>;
let served: Map<string, string>;
let server: Server;
let port: number;
let raster: Rasterizer;
const project = {
  canvas,
  tracks: [
    {
      items: [
        { type: "graphic", src: "graphics/cube.html", duration: 90 },
        { type: "graphic", src: "graphics/confetti.html", duration: 90 },
        { type: "graphic", src: "graphics/ui.html", duration: 90 },
      ],
    },
  ],
} as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-graphic-libs-export-")));
  dir = join(root, "Libs.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "cube.html"), CUBE);
  writeFileSync(join(dir, "graphics", "confetti.html"), CONFETTI);
  writeFileSync(join(dir, "graphics", "ui.html"), UI);
  // Both sides read the graphics the one way (readGraphics + the bundled libraries) and wrap them in graphicDocument.
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  docs = new Map([...graphics].map(([src, html]) => [src, graphicDocument(html, canvas)]));
  // The preview stand-in's capture check, as the export's (render.ts SENTINEL_ID): asked after a
  // frame is rendered, the document sets a row below the canvas to that frame's mark. It must be in
  // the iframe's own frame: a row of the host page can reach the capture before the iframe's
  // picture does (a busy CI VM captured the stage's bare background, or nothing).
  served = new Map([...docs].map(([src, doc]) => [src, doc + PREVIEW_SENTINEL]));
  // The graphic route's stand-in: the document with the route's headers; and the host page.
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (path === "/host.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(hostPage(new URL(req.url!, "http://x").searchParams.get("src")!));
    }
    const doc = served.get(`graphics/${path.slice("/media/graphic/".length)}`);
    if (!path.startsWith("/media/graphic/") || !doc) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-security-policy": `${GRAPHIC_CSP}; sandbox allow-scripts`,
      "x-content-type-options": "nosniff",
    });
    res.end(doc);
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

/** The export's frame of a graphic at `local` (render.ts: top-level data: URL, offscreen). */
async function exportFrame(src: string, local: number, out: string) {
  const info = graphicInfo({ duration: 90, props: {} }, canvas, local);
  await raster.render({ kind: "graphic", width: W, height: H, doc: docs.get(src)!, t: local / canvas.fps, info, out, name: src });
}

/** The preview's frames of a graphic (iframe of the route over HTTP), all in one Electron run (async: the route is served from this process). */
async function previewFrames(src: string, frames: ReadonlyArray<{ local: number; out: string }>) {
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const main = join(root, "preview-main.cjs");
  writeFileSync(main, PREVIEW_MAIN);
  const jobs = frames.map((f) => ({ t: f.local / canvas.fps, info: graphicInfo({ duration: 90, props: {} }, canvas, f.local), out: f.out }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UNCUT_PREVIEW_JOBS: JSON.stringify({
      url: `http://127.0.0.1:${port}/host.html?src=${encodeURIComponent(`/media/graphic/${src.slice("graphics/".length)}`)}`,
      width: W,
      height: H,
      jobs,
      profile: join(root, "preview-profile"),
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
}

test(
  "a three.js cube, a confetti burst and Uncut's UI parts: the export draws the same pixels twice, and what the preview's iframe draws",
  { skip, timeout: 120000 },
  async (t) => {
    for (const [src, local, minOpaque] of [
      ["graphics/cube.html", 20, 0.08],
      ["graphics/confetti.html", 24, 0.01],
      ["graphics/ui.html", 40, 0.99],
    ] as const) {
      const name = src.slice("graphics/".length, -".html".length);
      const a = join(root, `${name}-export-a.png`);
      const b = join(root, `${name}-export-b.png`);
      await exportFrame(src, local, a);
      // Another frame in between, then the first again: the same pixels.
      await exportFrame(src, local + 13, join(root, `${name}-export-other.png`));
      await exportFrame(src, local, b);
      assert.equal(pixelHash(a), pixelHash(b), `${name}: deterministic`);
      assert.notEqual(pixelHash(join(root, `${name}-export-other.png`)), pixelHash(a), `${name}: it moves with t`);
      const drawn = opaquePixels(a) / (W * H);
      assert.ok(drawn > minOpaque, `${name}: ${(drawn * 100).toFixed(1)} % of the frame drawn`);
      // The preview's way, the same frame.
      const p = join(root, `${name}-preview.png`);
      await previewFrames(src, [{ local, out: p }]);
      const score = ssim(p, a, W, H);
      t.diagnostic(`${name}: ${(drawn * 100).toFixed(1)} % drawn, preview vs export SSIM ${score.toFixed(4)}`);
      assert.ok(score >= 0.98, `${name}: preview vs export SSIM ${score}`);
      assert.ok(opaquePixels(p) / (W * H) > minOpaque, `${name}: the preview drew it too`);
    }
  },
);
