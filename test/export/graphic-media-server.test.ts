// D290 through the real server: a project whose graphic draws its own video's frames over time
// (await uncut.frame("m-clip", 0.5 + t)) is exported with export.start (the export's rasteriser
// gets the frames from the server's source over its JSON lines), and the same moments are drawn
// the preview's way from the server's own routes: the graphic document route in a sandboxed
// iframe, its media asked of the page, which fetches the graphic-media route with the server
// token (as apps/web/src/preview/graphicMedia.ts does). The export's frames are the source frames
// for those moments and match the preview. Screenshots: test-output/d290-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicInfo, type Project } from "../../packages/core/src/index.ts";
import { graphicToken } from "../../apps/server/src/export/graphicToken.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { ssim } from "../helpers/image-compare.ts";

const ENTRY = process.env.UNCUT_TEST_SERVER ?? BUNDLE;
const DESKTOP = process.env.UNCUT_TEST_DESKTOP ?? resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(ENTRY) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "server, media core or desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 640;
const H = 360;
const GRAPHIC = `<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
window.render = async (t, info) => {
  const frame = await uncut.frame("m-clip", 0.5 + t, { width: info.width });
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
// The editor's stand-in: the sandboxed iframe of the server's graphic route; media asked of this
// page answered from the server's graphic-media route (the server token), as the editor does.
const hostPage = (src: string, media: string) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}iframe{border:0;display:block;width:${W}px;height:${H}px}</style></head><body>
<iframe sandbox="allow-scripts" src="${src}"></iframe>
<script>
const frame = document.querySelector("iframe");
window.ready = new Promise((done) => frame.addEventListener("load", () => done(true)));
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.uncut !== "media" || e.source !== frame.contentWindow) return;
  const u = new URL(${JSON.stringify(media)});
  u.pathname += "/" + encodeURIComponent(d.id);
  u.searchParams.set("t", String(d.t));
  if (d.w) u.searchParams.set("w", String(d.w));
  if (d.h) u.searchParams.set("h", String(d.h));
  fetch(u).then(async (r) => (r.ok ? { blob: await r.blob() } : { error: await r.text() })).then((r) => e.source.postMessage({ uncut: "media-reply", seq: d.seq, ...r }, "*"));
});
let seq = 0;
window.renderAt = (t, info) => new Promise((done) => {
  const mine = ++seq;
  const on = (e) => { if (e.data && e.data.uncut === "rendered" && e.data.seq === mine) { removeEventListener("message", on); done(e.data.error || true); } };
  addEventListener("message", on);
  frame.contentWindow.postMessage({ uncut: "render", seq: mine, t, info }, "*");
});
</script></body></html>`;

let root = "";
let clip = "";
let server: Awaited<ReturnType<typeof startServer>>;
let client: Awaited<ReturnType<typeof connect>>;
let jobs: ReturnType<Awaited<ReturnType<typeof connect>>["subscribe"]>;
let host: HttpServer;
let hostPort = 0;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-graphic-media-server-")));
  mkdirSync(join(root, "out"));
  clip = join(root, "Clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "3", "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", clip]);
  server = await startServer({ entry: ENTRY, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_FONT_DIRS: "", UNCUT_RENDER_ENTRY: DESKTOP } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
  host = createServer((req, res) => {
    const q = new URL(req.url!, "http://x").searchParams;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(hostPage(q.get("src")!, q.get("media")!));
  });
  await new Promise<void>((done) => host.listen(0, "127.0.0.1", done));
  hostPort = (host.address() as { port: number }).port;
});
after(async () => {
  client?.close();
  await server?.stop();
  host?.close();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const job = (id: string) => jobs.values.at(-1)?.find((j: { id: string }) => j.id === id);
const finished = (id: string) => jobs.until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), 180000).then(() => job(id));
const frameOf = (file: string, n: number, out: string, scale = "") => (execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${n})${scale}`, "-frames:v", "1", "-update", "1", out]), out);

async function previewFrames(frames: ReadonlyArray<{ local: number; out: string }>) {
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const main = join(root, "preview-main.cjs");
  writeFileSync(main, PREVIEW_MAIN);
  const canvas = { width: W, height: H, fps: 30 };
  const secret = encodeURIComponent(graphicToken(server.ready.token));
  const src = `http://127.0.0.1:${server.ready.port}/media/graphic/footage.html?token=${secret}`;
  const media = `http://127.0.0.1:${server.ready.port}/media/graphic-media?token=${encodeURIComponent(server.ready.token)}`;
  const list = frames.map((f) => ({ t: f.local / 30, info: graphicInfo({ duration: 45, props: {} }, canvas, f.local), out: f.out }));
  const env: NodeJS.ProcessEnv = { ...process.env, UNCUT_PREVIEW_JOBS: JSON.stringify({ url: `http://127.0.0.1:${hostPort}/host.html?src=${encodeURIComponent(src)}&media=${encodeURIComponent(media)}`, width: W, height: H, jobs: list, profile: join(root, "preview-profile") }) };
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

test("a graphic drawing the project's own video: export.start draws its exact frames, and the preview's routes draw the same", { skip, timeout: 300000 }, async (t) => {
  const project: Project = {
    format: "uncut/0",
    name: "Graphic media",
    canvas: { width: W, height: H, fps: 30 },
    media: [{ id: "m-clip", kind: "video", name: "Clip.mp4", path: clip, probe: { frames: 90, fps: 30, width: 1280, height: 720, hasAudio: false } }],
    // The morph's cut: the graphic's last frame (local 44) draws source frame 59; the clip after it starts on that same frame.
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src: "graphics/footage.html", duration: 45 }, { id: "c", type: "clip", media: "m-clip", in: 59, duration: 15 }] }],
  } as Project;
  const dir = writeProject(root, "GraphicMedia", project);
  mkdirSync(join(dir, "graphics"));
  writeFileSync(join(dir, "graphics", "footage.html"), GRAPHIC);
  await client.ok("project.open", { dir });

  // The route wants the server token (the graphic's own secret isn't it), and says what's unknown.
  const base = `http://127.0.0.1:${server.ready.port}/media/graphic-media/m-clip?t=0`;
  assert.equal((await fetch(`${base}&token=${encodeURIComponent(graphicToken(server.ready.token))}`)).status, 401, "not with the graphic secret");
  const first = await fetch(`${base}&token=${encodeURIComponent(server.ready.token)}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/bmp");
  const unknown = await fetch(`http://127.0.0.1:${server.ready.port}/media/graphic-media/nope?t=0&token=${encodeURIComponent(server.ready.token)}`);
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /no media nope/);

  const output = join(root, "out", "graphic-media.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "high", loudness: "off" });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);

  mkdirSync("test-output", { recursive: true });
  const locals = [0, 11, 40];
  const previews = locals.map((local) => ({ local, out: join(root, `preview-${local}.png`) }));
  await previewFrames(previews);
  for (const [i, local] of locals.entries()) {
    const exported = frameOf(output, local, resolve(`test-output/d290-export-${local}.png`));
    copyFileSync(previews[i]!.out, resolve(`test-output/d290-preview-${local}.png`));
    const same = ssim(previews[i]!.out, exported, W, H);
    // The source's own frame for 0.5 s + t (15 + local), and the one after it.
    const right = frameOf(clip, 15 + local, join(root, `source-${local}.png`), `,scale=${W}:${H}:flags=bicubic`);
    const next = frameOf(clip, 16 + local, join(root, `source-next-${local}.png`), `,scale=${W}:${H}:flags=bicubic`);
    const toRight = ssim(exported, right, W, H);
    const toNext = ssim(exported, next, W, H);
    t.diagnostic(`frame ${local}: export vs preview SSIM ${same.toFixed(4)}; export vs source frame ${15 + local} ${toRight.toFixed(4)}, vs ${16 + local} ${toNext.toFixed(4)}`);
    assert.ok(same >= 0.97, `frame ${local}: the export is what the preview draws (SSIM ${same})`);
    assert.ok(toRight > toNext, `frame ${local}: the source frame ${15 + local}, not the next (${toRight} vs ${toNext})`);
  }
  // The cut from the graphic to a clip of the same footage: the same source frame on both sides
  // (the graphic's picture through Chromium, the clip's through the export's own filters).
  const before = frameOf(output, 44, resolve("test-output/d290-cut-graphic.png"));
  const after = frameOf(output, 45, resolve("test-output/d290-cut-clip.png"));
  const cut = ssim(before, after, W, H);
  const mean = (png: string) => {
    const px = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", "scale=1:1:flags=area,format=rgb24", "-f", "rawvideo", "-"]);
    return [...px];
  };
  t.diagnostic(`the cut: graphic frame vs clip frame SSIM ${cut.toFixed(4)}, mean RGB ${mean(before).join(",")} vs ${mean(after).join(",")}`);
  assert.ok(cut >= 0.98, `the graphic's last frame is the clip's first: SSIM ${cut}`);
});
