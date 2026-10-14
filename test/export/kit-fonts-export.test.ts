// D198 (issue #34) through the real server, export and preview route: a brand kit whose font has
// its file ("Uncut Kit Mono", the bundled DM Mono's file under a family no Mac has installed),
// chosen for the project. A graphic that draws canvas text in that family and a text item set in
// it are exported (export.start) twice: with the kit's file, and with the file gone from the kit
// (the fallback a missing font used to be, silently). The frames differ where the text is, so the
// kit's font is what the export drew; and the graphic's frame matches what the preview's sandboxed
// iframe draws from the server's own graphic route (SSIM). Screenshots: test-output/issue34-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicInfo } from "../../packages/core/src/index.ts";
import { graphicToken } from "../../apps/server/src/export/graphicToken.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { pixelHash, ssim } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "server, media core or desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 1920;
const H = 1080;
const FAMILY = "Uncut Kit Mono";
// Opaque, so the export's frame and the preview's can be compared as they are.
const GRAPHIC = `<canvas id="c"></canvas>
<script>
const c = document.getElementById("c");
window.render = (t, info) => {
  c.width = info.width;
  c.height = info.height;
  const x = c.getContext("2d");
  x.fillStyle = "#f4f1ea";
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#101820";
  x.font = "120px '${FAMILY}', sans-serif";
  x.fillText("Argent iii", 80, 260);
  x.font = "72px '${FAMILY}', sans-serif";
  x.fillText("WWW 0123 mmm", 80, 420);
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
// The editor's Preview.tsx stand-in: an <iframe sandbox="allow-scripts"> at canvas size, render asked by postMessage.
const hostPage = (src: string) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}iframe{border:0;display:block;width:${W}px;height:${H}px}</style></head><body>
<iframe sandbox="allow-scripts" src="${src}"></iframe>
<script>
const frame = document.querySelector("iframe");
window.ready = new Promise((done) => frame.addEventListener("load", () => done(true)));
let seq = 0;
window.renderAt = (t, info) => new Promise((done) => {
  const mine = ++seq;
  const on = (e) => { if (e.data && e.data.uncut === "rendered" && e.data.seq === mine) { removeEventListener("message", on); done(e.data.error || true); } };
  addEventListener("message", on);
  frame.contentWindow.postMessage({ uncut: "render", seq: mine, t, info }, "*");
});
</script></body></html>`;

let root = "";
let server: Awaited<ReturnType<typeof startServer>>;
let client: Awaited<ReturnType<typeof connect>>;
let jobs: ReturnType<Awaited<ReturnType<typeof connect>>["subscribe"]>;
let host: HttpServer;
let hostPort = 0;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-kit-fonts-export-")));
  mkdirSync(join(root, "projects"));
  mkdirSync(join(root, "out"));
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_FONT_DIRS: "" } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
  host = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(hostPage(new URL(req.url!, "http://x").searchParams.get("src")!));
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
const frameOf = (file: string, n: number, out: string) => (execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-update", "1", out]), out);

async function exportTo(name: string) {
  const output = join(root, "out", `${name}.mp4`);
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  return output;
}

async function previewFrame(local: number, out: string) {
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const main = join(root, "preview-main.cjs");
  writeFileSync(main, PREVIEW_MAIN);
  const canvas = { width: W, height: H, fps: 30 };
  const route = `http://127.0.0.1:${server.ready.port}/media/graphic/kit.html?token=${encodeURIComponent(graphicToken(server.ready.token))}`;
  const jobsJson = [{ t: local / 30, info: graphicInfo({ duration: 30, props: {} }, canvas, local), out }];
  const env: NodeJS.ProcessEnv = { ...process.env, UNCUT_PREVIEW_JOBS: JSON.stringify({ url: `http://127.0.0.1:${hostPort}/host.html?src=${encodeURIComponent(route)}`, width: W, height: H, jobs: jobsJson, profile: join(root, "preview-profile") }) };
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

test("a graphic and a text in the kit's font: the export draws the kit's file (not the fallback) and the graphic matches the preview", { skip, timeout: 300000 }, async (t) => {
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Fonts" });
  const dir = snap.dir as string;
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "kit.html"), GRAPHIC);
  // The kit: its font with its file, chosen for the project.
  await client.ok("brand.saveKit", { kit: { id: "acme", name: "Acme", scope: "global", logos: {}, colors: [], fonts: [], tone: "", taglines: [], urls: [], dos: [], donts: [], examples: [] } });
  const fontFile = join(root, "KitMono.woff2");
  copyFileSync(resolve("assets/fonts/DMMono-Regular.woff2"), fontFile);
  const added = await client.ok("brand.addFile", { kit: "acme", scope: "global", path: fontFile });
  const withFile = { id: "acme", name: "Acme", scope: "global", logos: {}, colors: [], fonts: [{ family: FAMILY, role: "headline", file: added.name }], tone: "", taglines: [], urls: [], dos: [], donts: [], examples: [] };
  await client.ok("brand.saveKit", { kit: withFile });
  await client.ok("brand.setActive", { kit: "acme", skills: [] });
  await client.ok("project.edit", {
    baseRevision: snap.revision,
    summary: "A graphic and a text in the kit's font",
    ops: [
      { op: "add_track", track: { id: "g", kind: "video", name: "Graphics", items: [] }, index: 0 },
      { op: "insert_item", track: "g", item: { id: "kit", type: "graphic", src: "graphics/kit.html", start: 0, duration: 30 } },
      { op: "insert_item", track: "text", item: { id: "title", type: "text", text: "Argent iii WWW 0123", start: 30, duration: 30, style: { font: FAMILY, size: 110, color: "#ffffff" } } },
    ],
  });

  const kitOut = await exportTo("kit");
  // The fallback: the same kit without the font's file (what every graphic did before D198).
  await client.ok("brand.saveKit", { kit: { ...withFile, fonts: [{ family: FAMILY, role: "headline" }] } });
  const fallbackOut = await exportTo("fallback");

  mkdirSync("test-output", { recursive: true });
  const g = frameOf(kitOut, 10, resolve("test-output/issue34-export-graphic-kit-font.png"));
  const gFallback = frameOf(fallbackOut, 10, resolve("test-output/issue34-export-graphic-fallback.png"));
  const txt = frameOf(kitOut, 40, resolve("test-output/issue34-export-text-kit-font.png"));
  const txtFallback = frameOf(fallbackOut, 40, resolve("test-output/issue34-export-text-fallback.png"));
  assert.notEqual(pixelHash(g), pixelHash(gFallback), "the graphic's text is drawn in the kit's font, not the fallback");
  assert.notEqual(pixelHash(txt), pixelHash(txtFallback), "the text item is drawn in the kit's font, not the fallback");
  const apart = ssim(g, gFallback, W, H);
  const textApart = ssim(txt, txtFallback, W, H);

  // The preview's way: the server's graphic route (with the kit's font, as the export) in a sandboxed iframe.
  await client.ok("brand.saveKit", { kit: withFile });
  const preview = join(root, "preview.png");
  await previewFrame(10, preview);
  copyFileSync(preview, resolve("test-output/issue34-preview-graphic-kit-font.png"));
  const same = ssim(preview, g, W, H);
  t.diagnostic(`graphic: export vs preview SSIM ${same.toFixed(4)}, kit font vs fallback ${apart.toFixed(4)}; text item: kit font vs fallback ${textApart.toFixed(4)}`);
  assert.ok(same >= 0.99, `the export's graphic is what the preview draws: SSIM ${same}`);
  // Most of the frame is the plain background, so a whole-frame SSIM of the fallback stays high; it's still well apart.
  assert.ok(apart <= 0.98 && textApart <= 0.98, `the fallback is another picture (graphic SSIM ${apart}, text ${textApart})`);
  assert.ok(readFileSync(preview).length > 1000);
});
