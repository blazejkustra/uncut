// D290 through the real renderers: a graphic that draws a project video's frames over time
// (await uncut.frame(id, 0.5 + t) on a canvas), a still by marker in an <img> and in a CSS url(),
// drawn by the export rasteriser (apps/desktop render.ts: a top-level data: page, the media fetched
// from its uncut-media:// scheme, answered by the server's source over the JSON lines) and the
// preview's way (a sandboxed iframe of the graphic route's document; the media asked of the parent
// page by postMessage, which fetches the graphic-media route), then compared.
// - the export draws the exact frame for each t: the graphic's frame matches the source frame
//   ffmpeg gives at that moment, and not the next one;
// - determinism: the same t twice is the same pixels; it moves with t;
// - preview vs export: SSIM ≥ 0.99 at several moments;
// - the document stays small (nothing inlined).
// The preview side's route and parent page are stand-ins built from the same functions the server
// route (graphicMediaRoute.ts: parseGraphicMediaRequest + the source's picture) and the editor
// (apps/web preview/graphicMedia.ts: fetch, reply with the Blob) use.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { GRAPHIC_CSP, graphicDocument, graphicInfo, parseGraphicMediaRequest, type Media, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { graphicMediaSource, type GraphicMediaSource } from "../../apps/server/src/export/graphicMedia.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { opaquePixels, pixelHash, rgbaOf, ssim } from "../helpers/image-compare.ts";

const DESKTOP = process.env.UNCUT_TEST_DESKTOP ?? resolve("apps/desktop/dist/main.cjs");
const which = (name: string) => spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
const bin = which("ffmpeg");
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : bin ? false : "needs ffmpeg";

const W = 640;
const H = 360;
const canvas = { width: W, height: H, fps: 30 };

// The video fills the canvas (its frame at 0.5 s + t), a still sits in the corner as an <img>
// marker, and a CSS url() marker paints a strip; a label moves with t.
const FOOTAGE = `<style>
#c { position: absolute; inset: 0; }
#still { position: absolute; right: 10px; top: 10px; width: 100px; height: 50px; }
#strip { position: absolute; left: 0; bottom: 0; width: 120px; height: 40px; background: url("uncut:media/still") center / cover; }
</style>
<canvas id="c" width="${W}" height="${H}"></canvas>
<img id="still" src="uncut:media/still">
<div id="strip"></div>
<script>
const ctx = document.getElementById("c").getContext("2d");
window.render = async (t, info) => {
  const frame = await uncut.frame("clip", 0.5 + t, { width: info.width });
  ctx.clearRect(0, 0, info.width, info.height);
  ctx.drawImage(frame, 0, 0, info.width, info.height);
};
</script>`;

const PREVIEW_MAIN = `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("fs");
const { url, width, height, jobs, profile } = JSON.parse(process.env.UNCUT_PREVIEW_JOBS);
app.setPath("userData", profile);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.dock && app.dock.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width, height, useContentSize: true, frame: false, transparent: true, backgroundColor: "#00000000", enableLargerThanScreen: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.setContentSize(width, height);
  await win.loadURL(url);
  await win.webContents.executeJavaScript("window.ready");
  for (const job of jobs) {
    const answer = await win.webContents.executeJavaScript("window.renderAt(" + JSON.stringify(job.t) + ", " + JSON.stringify(job.info) + ")");
    if (answer !== true) throw new Error("render failed: " + answer);
    const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    writeFileSync(job.out, image.toPNG());
  }
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
`;

// The editor's stand-in: the graphic's iframe, render(t) by postMessage, and media asked of it
// answered as apps/web/src/preview/graphicMedia.ts does (only the graphic's own iframe).
const hostPage = (
  src: string,
) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}iframe{border:0;display:block;width:${W}px;height:${H}px}</style></head><body>
<iframe sandbox="allow-scripts" src="${src}"></iframe>
<script>
const frame = document.querySelector("iframe");
window.ready = new Promise((done) => frame.addEventListener("load", () => done(true)));
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.uncut !== "media" || e.source !== frame.contentWindow) return;
  const q = new URLSearchParams({ t: String(d.t) });
  if (d.w) q.set("w", String(d.w));
  if (d.h) q.set("h", String(d.h));
  fetch("/media/graphic-media/" + encodeURIComponent(d.id) + "?" + q)
    .then(async (r) => (r.ok ? { blob: await r.blob() } : { error: await r.text() }))
    .then((r) => e.source.postMessage({ uncut: "media-reply", seq: d.seq, ...r }, "*"));
});
let seq = 0;
window.renderAt = (t, info) => new Promise((done) => {
  const mine = ++seq;
  const on = (e) => { if (e.data && e.data.uncut === "rendered" && e.data.seq === mine) { removeEventListener("message", on); done(e.data.error || true); } };
  addEventListener("message", on);
  frame.contentWindow.postMessage({ uncut: "render", seq: mine, t, info }, "*");
});
</script></body></html>`;

let root: string;
let dir: string;
let doc: string;
let server: Server;
let port: number;
let raster: Rasterizer;
let source: GraphicMediaSource;
let clipPath: string;
const media: Array<Media> = [];
const project = { canvas, media, tracks: [{ items: [{ type: "graphic", src: "graphics/footage.html", duration: 60 }] }] } as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-graphic-media-export-")));
  dir = join(root, "Media.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "footage.html"), FOOTAGE);
  // A generated clip (testsrc2: every frame differs; tagged BT.709) and a still.
  clipPath = join(root, "clip.mp4");
  const c = spawnSync(bin, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-t",
    "3",
    "-c:v",
    "libx264",
    "-g",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    clipPath,
  ]);
  assert.equal(c.status, 0, String(c.stderr));
  const still = join(root, "still.png");
  const s = spawnSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=200x100", "-frames:v", "1", still]);
  assert.equal(s.status, 0, String(s.stderr));
  media.push({ id: "clip", kind: "video", name: "clip.mp4", path: clipPath }, { id: "still", kind: "image", name: "still.png", path: still });
  source = graphicMediaSource({ bin, media: () => media, mediaPath: (m) => m.path });
  const graphics = await readGraphics(dir, project, {});
  doc = graphicDocument(graphics.get("graphics/footage.html")!, canvas);
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/host.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(hostPage("/media/graphic/footage.html"));
    }
    if (url.pathname === "/media/graphic/footage.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-security-policy": `${GRAPHIC_CSP}; sandbox allow-scripts`,
        "x-content-type-options": "nosniff",
      });
      return res.end(doc);
    }
    if (url.pathname.startsWith("/media/graphic-media/")) {
      const ask = parseGraphicMediaRequest(decodeURIComponent(url.pathname.slice("/media/graphic-media/".length)), url.searchParams);
      if ("problem" in ask) {
        res.writeHead(400);
        return res.end(ask.problem);
      }
      return void source.picture(ask).then(
        (p) => {
          res.writeHead(200, { "content-type": p.type, "access-control-allow-origin": "*" });
          res.end(p.bytes);
        },
        (error: Error) => {
          res.writeHead(404);
          res.end(error.message);
        },
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command, undefined, { media: source.file });
});

after(async () => {
  if (skip) return;
  await raster?.close();
  server?.close();
  source?.close();
  if (process.env.UNCUT_KEEP_OUTPUT) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

const exportFrame = (local: number, out: string) =>
  raster.render({
    kind: "graphic",
    width: W,
    height: H,
    doc,
    t: local / canvas.fps,
    info: graphicInfo({ duration: 60, props: {} }, canvas, local),
    out,
    name: "footage",
  });

async function previewFrames(frames: ReadonlyArray<{ local: number; out: string }>) {
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const main = join(root, "preview-main.cjs");
  writeFileSync(main, PREVIEW_MAIN);
  const jobs = frames.map((f) => ({ t: f.local / canvas.fps, info: graphicInfo({ duration: 60, props: {} }, canvas, f.local), out: f.out }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UNCUT_PREVIEW_JOBS: JSON.stringify({ url: `http://127.0.0.1:${port}/host.html`, width: W, height: H, jobs, profile: join(root, "preview-profile") }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
  const code = await new Promise<number | null>((done) => child.on("exit", (c) => done(c)));
  clearTimeout(timer);
  assert.equal(code, 0, `preview run failed: ${output}`);
}

/** The source frame n of the clip at the canvas size, as a PNG (straight from ffmpeg). */
function sourceFrame(n: number, out: string) {
  const r = spawnSync(bin, ["-v", "error", "-y", "-i", clipPath, "-vf", `select=eq(n\\,${n}),scale=${W}:${H}:flags=bicubic`, "-frames:v", "1", out]);
  assert.equal(r.status, 0, String(r.stderr));
}

/** Mean absolute difference of the RGB in the region the video alone covers (left of the still, above the strip). */
function videoDiff(a: string, b: string): number {
  const pa = rgbaOf(a);
  const pb = rgbaOf(b);
  let sum = 0;
  let count = 0;
  for (let y = 0; y < H - 50; y++)
    for (let x = 130; x < W - 120; x++) {
      const i = (y * W + x) * 4;
      sum += Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!) + Math.abs(pa[i + 2]! - pb[i + 2]!);
      count += 3;
    }
  return sum / count;
}

test("a graphic drawing a project video's frames: exact frames in the export, the same in the preview", { skip, timeout: 240000 }, async (t) => {
  assert.ok(Buffer.byteLength(doc) < 64 * 1024, `nothing inlined: the document is ${Buffer.byteLength(doc)} bytes`);
  const locals = [0, 7, 31];
  const exported: Array<string> = [];
  for (const local of locals) {
    const out = join(root, `export-${local}.png`);
    await exportFrame(local, out);
    exported.push(out);
    // The exact source frame for 0.5 s + t at 30 fps: 15 + local; not the next one.
    const n = 15 + local;
    const right = join(root, `source-${n}.png`);
    const next = join(root, `source-${n + 1}.png`);
    sourceFrame(n, right);
    sourceFrame(n + 1, next);
    const d = videoDiff(out, right);
    const dn = videoDiff(out, next);
    t.diagnostic(`local ${local}: mean diff to source frame ${n} ${d.toFixed(2)}, to ${n + 1} ${dn.toFixed(2)}`);
    assert.ok(d < 3, `local ${local}: the source frame ${n} (diff ${d})`);
    assert.ok(dn > d + 1, `local ${local}: not frame ${n + 1} (${dn} vs ${d})`);
    assert.ok(opaquePixels(out) / (W * H) > 0.99, "the frame is covered");
  }
  // The same moment again (after others): the same pixels; another moment: others.
  const again = join(root, "export-7-again.png");
  await exportFrame(7, again);
  assert.equal(pixelHash(again), pixelHash(exported[1]!), "deterministic");
  assert.notEqual(pixelHash(exported[0]!), pixelHash(exported[1]!), "it moves with t");
  // The markers: the still's picture is in the corner (the <img>) and the strip (CSS url()).
  const px = rgbaOf(exported[0]!);
  const at = (x: number, y: number) => [...px.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
  const plain = rgbaOf(join(root, `source-15.png`));
  const plainAt = (x: number, y: number) => [...plain.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
  const differs = (a: Array<number>, b: Array<number>) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) > 30;
  assert.ok(
    [
      [W - 60, 20],
      [W - 30, 50],
      [W - 90, 40],
    ].some(([x, y]) => differs(at(x!, y!), plainAt(x!, y!))),
    "the <img> marker drew the still",
  );
  assert.ok(
    [
      [20, H - 20],
      [60, H - 10],
      [100, H - 30],
    ].some(([x, y]) => differs(at(x!, y!), plainAt(x!, y!))),
    "the CSS url() marker drew the still",
  );

  // The preview's way: the same moments.
  const previews = locals.map((local) => ({ local, out: join(root, `preview-${local}.png`) }));
  await previewFrames(previews);
  for (const [i, p] of previews.entries()) {
    const score = ssim(p.out, exported[i]!, W, H);
    t.diagnostic(`local ${p.local}: preview vs export SSIM ${score.toFixed(4)}`);
    assert.ok(score >= 0.99, `local ${p.local}: preview vs export SSIM ${score}`);
  }
});
