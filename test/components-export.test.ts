// Phase 6 chunk 2 (D76, D77, D78) through the export and the agent's frames:
// - the plan: a static component is one PNG, a terminal one PNG per distinct look (N looks, N PNGs;
//   past MAX_RASTER_STATES it holds frames and warns), an SVG clip is a raster at its box, a
//   graphic one frame per drawn frame (capped the same way), media references become placeholders;
// - on the bundled server (ffmpeg-made media): a device frame's footage shows in its screen hole
//   and its bezel is the asset's colour, the end card matches Chromium's PNG of the same HTML
//   (SSIM ≥ 0.99), a terminal types frame by frame, an SVG logo fills its box, a graphic moves
//   as its render(t) says;
// - the fake claude: modules_list shows the components' params, one timeline_edit inserts a device
//   frame with its clip (insert_device_frame) and an end card, graphic_write + a graphic item, and
//   render_frames draws them all.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { applyEdit, componentBox, componentHtml, createSession, MAX_RASTER_STATES, planDeviceFrame, RENDER_CSS, screenRect, solidHtml, type Item, type Project } from "../packages/core/src/index.ts";
import { exportCommand, MEDIA_TOKEN, planExport } from "../apps/server/src/exportPlan.ts";
import { readGraphics } from "../apps/server/src/exporter.ts";
import { rasterizerCommand, startRasterizer } from "../apps/server/src/rasterizer.ts";
import { writeProject } from "./helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "./helpers/server.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skipServer = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) || !existsSync(MCP) ? "server, desktop or media core not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

type Rgb = [number, number, number];
const near = (a: Rgb, b: Rgb, tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const GRAPHIC = `<div id="sq" style="position:absolute;top:100px;left:0;width:200px;height:200px;background:#00ff00"></div>
<script>window.render = (t, info) => { document.getElementById("sq").style.left = Math.round(t * 300) + "px"; };</script>`;
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect width="200" height="60" fill="#ff8800"/></svg>`;

/** The fixture: a 1280×720 canvas over a dark solid, a device frame with red/blue footage, an end card, a terminal, an SVG logo and a graphic. */
function componentsProject(media: string): Project {
  const base: Project = {
    format: "uncut/0",
    name: "Components",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [
      { id: "m-screen", kind: "video", name: "Screen.mp4", path: join(media, "Screen.mp4"), probe: { frames: 120, fps: 30, width: 540, height: 960, hasAudio: false } },
      { id: "m-logo", kind: "image", name: "Logo.svg", path: join(media, "Logo.svg"), probe: { width: 200, height: 60 } },
    ],
    tracks: [
      { id: "cards", kind: "video", name: "Cards", items: [] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 300, props: { color: "#203040" } }] },
    ],
  };
  const device = planDeviceFrame(base, { media: "m-screen", start: 0, duration: 60, frameId: "phone", clipId: "screen" });
  if ("problem" in device) throw new Error(device.problem);
  const cards: Array<Item> = [
    { id: "end", type: "component", component: "component.end-card", start: 60, duration: 60, props: { logo: { media: "m-logo" }, title: "Argent [[for agents]]", code: "npx @swmansion/argent init", url: "argent.swmansion.com", background: "bg" } },
    { id: "term", type: "component", component: "component.terminal", start: 120, duration: 60, props: { title: "zsh", lines: [{ text: "npx your-tool init", kind: "input" }, { text: "✔ Ready" }], typeFrom: 0, speed: 30 } },
    { id: "logo", type: "clip", media: "m-logo", start: 180, duration: 30, transform: { x: 100, y: 100, w: 400, h: 120 } },
    { id: "move", type: "graphic", src: "graphics/move.html", start: 210, duration: 60 },
  ];
  return applyEdit(createSession(base), { actor: "user", ops: [...device.ops, ...cards.map((item) => ({ op: "insert_item" as const, track: "cards", item }))] }).project;
}

function makeMedia(dir: string) {
  mkdirSync(dir, { recursive: true });
  // Portrait footage: red on top, blue below, tagged BT.709.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=540x480:r=30,format=yuv420p[t];color=blue:s=540x480:r=30,format=yuv420p[b];[t][b]vstack", "-t", "4", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:v", "libx264", "-crf", "12", join(dir, "Screen.mp4")]);
  writeFileSync(join(dir, "Logo.svg"), LOGO_SVG);
}

// ---- the plan (no processes) ----

test("plan: a static component is one PNG; a terminal one per distinct look, capped with a warning; SVG and graphics are rasters; media are placeholders", () => {
  const project = componentsProject("/nowhere");
  const plan = planExport(project, { mediaPath: (m) => m.path, width: 1280, height: 720, graphic: (src) => (src === "graphics/move.html" ? GRAPHIC : undefined) });
  assert.ok(!("problem" in plan));
  const layer = (id: string) => plan.visuals.find((l) => l.item.id === id)!;
  const end = layer("end");
  assert.equal(end.kind, "raster");
  assert.equal(end.kind === "raster" && end.states.length, 1, "the end card is one PNG");
  assert.ok(end.kind === "raster" && end.states[0]!.includes(`${MEDIA_TOKEN}m-logo`), "its logo is a placeholder the exporter fills");
  assert.ok(plan.files.some((f) => f.media.id === "m-logo"), "and the logo's file is one the export checks");
  // The terminal: as many PNGs as distinct looks (each typed character, the output line).
  const term = layer("term");
  assert.ok(term.kind === "raster");
  const looks = new Set(Array.from({ length: 60 }, (_, f) => componentHtml(term.item, project, f))).size;
  assert.equal(term.states.length, looks, `${looks} looks, ${term.states.length} PNGs`);
  assert.ok(looks >= 19, "18 characters typed one by one, then the output");
  assert.equal(new Set(term.frames).size, looks);
  // The SVG logo: Chromium draws it at its box (a raster layer), the graphic one frame per frame.
  const logo = layer("logo");
  assert.ok(logo.kind === "raster" && logo.states.length === 1 && /<img src="uncut-media:m-logo"[^>]*width:400px;height:120px/.test(logo.states[0]!));
  const move = layer("move");
  assert.ok(move.kind === "graphic");
  assert.deepEqual(move.frames, Array.from({ length: 60 }, (_, i) => i));
  assert.match(move.doc, /window\.render = \(t, info\)/);
  assert.deepEqual(plan.warnings, []);
  // Past the cap: a terminal typing 400 characters, a graphic of 420 frames: frames are held, with a warning each.
  const long = structuredClone(project) as unknown as { tracks: Array<{ id: string; items: Array<Item & { duration: number }> }> };
  const cards = long.tracks.find((t) => t.id === "cards")!;
  cards.items = cards.items.map((i) => (i.id === "term" ? { ...i, duration: 420, props: { ...i.props, lines: [{ text: "x".repeat(400), kind: "input" }], speed: 30 } } : i.id === "move" ? { ...i, start: 600, duration: 420 } : i));
  long.tracks.find((t) => t.id === "main")!.items[0]!.duration = 1100;
  const capped = planExport(long as unknown as Project, { mediaPath: (m) => m.path, width: 1280, height: 720, graphic: () => GRAPHIC });
  assert.ok(!("problem" in capped));
  const t2 = capped.visuals.find((l) => l.item.id === "term")!;
  const g2 = capped.visuals.find((l) => l.item.id === "move")!;
  assert.ok(t2.kind === "raster" && t2.states.length <= MAX_RASTER_STATES, `terminal: ${t2.kind === "raster" && t2.states.length} PNGs`);
  assert.ok(g2.kind === "graphic" && new Set(g2.frames).size <= MAX_RASTER_STATES && g2.frames[1] === g2.frames[0], "graphic frames held in pairs");
  assert.equal(capped.warnings.length, 2);
  assert.match(capped.warnings[0]!, /"term" changes its look on more than 360 frames; the export draws every 2nd frame of it/);
  assert.match(capped.warnings[1]!, /"move" is drawn on more than 360 frames/);
  // A graphic whose file can't be read isn't drawn, and the export says so.
  const missing = planExport(project, { mediaPath: (m) => m.path, width: 1280, height: 720 });
  assert.ok(!("problem" in missing));
  assert.ok(!missing.visuals.some((l) => l.item.id === "move"));
  assert.match(missing.warnings[0]!, /graphics\/move\.html couldn't be read/);
  // The graph: rasters with an opacity (a graphic's transform.opacity) multiply their alpha.
  const faded = structuredClone(project) as Project;
  ((faded.tracks.find((t) => t.id === "cards")!.items as Array<Item>).find((i) => i.id === "move") as { transform?: unknown }).transform = { opacity: 0.5 };
  const fp = planExport(faded, { mediaPath: (m) => m.path, width: 1280, height: 720, graphic: () => GRAPHIC });
  assert.ok(!("problem" in fp));
  const rasters = new Map(fp.visuals.filter((l) => l.kind === "raster" || l.kind === "graphic").map((l) => [l, { kind: "still" as const, png: "/x.png" }]));
  const cmd = exportCommand(fp, { background: "/bg.png", rasters, caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 }, quality: "draft", output: "/o.mp4" });
  assert.match(cmd.graph, /lutyuv=a='val\*0\.5'/);
});

test("plan (review): a keyed component's box moves on every frame however long it is (only its look is capped); the device frame and its footage move together", () => {
  const base = componentsProject("/nowhere");
  const items = base.tracks.flatMap((t) => t.items);
  const phone = items.find((i) => i.id === "phone")!;
  const screen = items.find((i) => i.id === "screen")!;
  // 600 frames (20 s), the frame panning 300 px by a key; the footage got the same keys, offset.
  const keys = [{ frame: 0, x: phone.transform!.x! - 150 }, { frame: 599, x: phone.transform!.x! + 150 }];
  const dx = screen.transform!.x! - phone.transform!.x!;
  const long: Project = {
    ...base,
    media: base.media.map((m) => (m.id === "m-screen" ? { ...m, probe: { ...m.probe, frames: 900 } } : m)),
    tracks: base.tracks.map((t) => ({
      ...t,
      items: t.items
        .filter((i) => !["end", "term", "logo", "move"].includes(i.id))
        .map((i) => (i.id === "phone" ? { ...i, duration: 600, keys } : i.id === "screen" ? { ...i, duration: 600, keys: keys.map((k) => ({ ...k, x: k.x + dx })) } : i.id === "bg" ? { ...i, duration: 600 } : i)),
    })),
  };
  const plan = planExport(long, { mediaPath: (m) => m.path, width: 1280, height: 720 });
  assert.ok(!("problem" in plan));
  assert.deepEqual(plan.warnings, [], "nothing changes its look: no warning");
  const frameLayer = plan.visuals.find((l) => l.item.id === "phone")!;
  const clipLayer = plan.visuals.find((l) => l.item.id === "screen")!;
  assert.ok(frameLayer.kind === "raster" && clipLayer.kind === "video" && clipLayer.geometry);
  assert.ok(frameLayer.states.length > MAX_RASTER_STATES, `${frameLayer.states.length} positions, past the cap`);
  const left = (f: number) => Number(/left:([\d.-]+)px/.exec(frameLayer.states[frameLayer.frames[f]!]!)![1]);
  for (let f = 0; f < 600; f++) {
    const clipX = clipLayer.geometry.frames[f]!.x;
    assert.ok(Math.abs(clipX - (left(f) + dx)) <= 1, `frame ${f}: the footage at ${clipX}, the frame's screen at ${left(f) + dx}`);
    if (f > 0) assert.ok(left(f) >= left(f - 1), "the frame never steps back");
  }
  assert.ok(new Set(Array.from({ length: 600 }, (_, f) => left(f))).size > 290, "and moves on (almost) every frame");
});

test("readGraphics (review): only files under the project's own graphics/ folder, not through a symlinked folder", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "uncut-graphics-")));
  try {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "move.html"), GRAPHIC);
    const p = join(tmp, "P.uncut");
    mkdirSync(p);
    symlinkSync(outside, join(p, "graphics"));
    const project = componentsProject("/nowhere");
    assert.equal((await readGraphics(p, project)).size, 0, "a graphics folder pointing out of the project is ignored");
    rmSync(join(p, "graphics"));
    mkdirSync(join(p, "graphics"));
    writeFileSync(join(p, "graphics", "move.html"), GRAPHIC);
    assert.equal((await readGraphics(p, project)).get("graphics/move.html"), GRAPHIC);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- on the server ----

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let jobs: ReturnType<Client["subscribe"]>;
const resultLog = () => join(root, "results.jsonl");
const plan = () => join(root, "plan.json");
const job = (id: string) => jobs.values.at(-1)?.find((j: { id: string }) => j.id === id);
const finished = (id: string, timeout = 180000) => jobs.until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), timeout).then(() => job(id));
const frameOf = (file: string, n: number, out: string) => (execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-update", "1", out]), out);
const read = (file: string, f: number, x: number, y: number): Rgb => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${f}),format=rgb24,crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-"]);
  return [raw[0]!, raw[1]!, raw[2]!];
};
const crop = (file: string, f: number, x: number, y: number, w: number, h: number) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${f}),format=gray,crop=${w}:${h}:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-"]);
const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
/** The bounding box of pixels close to `rgb` in frame f: [x0, x1) × [y0, y1). */
const colourBox = (file: string, f: number, rgb: Rgb, tol: number, w = 1280, h = 720) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${f}),format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 64 * 1024 * 1024 });
  let x0 = w, x1 = 0, y0 = h, y1 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (Math.abs(raw[i]! - rgb[0]) <= tol && Math.abs(raw[i + 1]! - rgb[1]) <= tol && Math.abs(raw[i + 2]! - rgb[2]) <= tol) (x0 = Math.min(x0, x), (x1 = Math.max(x1, x + 1)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y + 1)));
    }
  return [x0, x1, y0, y1];
};

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-components-test-")));
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  makeMedia(join(root, "media"));
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan(), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: resultLog() } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("export: device frame footage in its hole and the bezel's colour, the end card as Chromium draws it, a terminal typing, an SVG at its box, a graphic moving", { skip: skipServer, timeout: 240000 }, async () => {
  const media = join(root, "media");
  const project = componentsProject(media);
  const dir = writeProject(root, "Components", project);
  mkdirSync(join(dir, "graphics"));
  writeFileSync(join(dir, "graphics", "move.html"), GRAPHIC);
  await client.ok("project.open", { dir });
  const output = join(root, "out", "Components.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  assert.equal(done.warnings, undefined, "nothing capped");
  mkdirSync("test-output", { recursive: true });

  // Device frame (frames 0–59): footage inside the hole matches the source, the bezel the asset.
  const frame = project.tracks.flatMap((t) => t.items).find((i) => i.id === "phone")!;
  const box = componentBox(frame, project.canvas, 30)!;
  const scr = screenRect("phone", box.w, box.h);
  const red = read(join(media, "Screen.mp4"), 0, 270, 100);
  const blue = read(join(media, "Screen.mp4"), 0, 270, 860);
  const top = read(output, 30, Math.round(box.x + scr.x + scr.w / 2), Math.round(box.y + scr.y + scr.h * 0.3));
  const bottom = read(output, 30, Math.round(box.x + scr.x + scr.w / 2), Math.round(box.y + scr.y + scr.h * 0.8));
  console.log(`  screen: top ${top} (source ${red}), bottom ${bottom} (source ${blue})`);
  assert.ok(near(top, red, 6), `the top of the screen is the footage's red: ${top} vs ${red}`);
  assert.ok(near(bottom, blue, 6), `the bottom is its blue: ${bottom} vs ${blue}`);
  const s = box.w / 420;
  const bezel = read(output, 30, Math.round(box.x + 7 * s), Math.round(box.y + box.h / 2));
  console.log(`  bezel ${bezel} (asset #1C1C1F)`);
  assert.ok(near(bezel, [0x1c, 0x1c, 0x1f], 5), `a bezel pixel is the asset's colour: ${bezel}`);
  assert.ok(near(read(output, 30, Math.round(box.x - 30), 360), [0x20, 0x30, 0x40], 5), "outside the frame: the background");
  frameOf(output, 30, resolve("test-output/components-export-device.png"));

  // End card (frame 90) vs Chromium's PNG of the same HTML: SSIM ≥ 0.99.
  const r = rasterizerCommand();
  assert.ok(!("problem" in r));
  const raster = await startRasterizer(r);
  const png = join(root, "end-card.png");
  try {
    const end = project.tracks.flatMap((t) => t.items).find((i) => i.id === "end")!;
    const logo = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString("base64")}`;
    const html = solidHtml(project.tracks.find((t) => t.id === "main")!.items[0]!, project) + componentHtml(end, { ...project, mediaUrl: () => logo }, 30, { fps: 30 });
    await raster.render({ width: 1280, height: 720, css: RENDER_CSS, html, out: png });
  } finally {
    await raster.close();
  }
  const exported = frameOf(output, 90, resolve("test-output/components-export-endcard.png"));
  const score = ssim(png, exported);
  console.log(`  end card export vs Chromium PNG: SSIM ${score.toFixed(4)}`);
  assert.ok(score >= 0.99, `SSIM ${score}`);
  // The SVG logo inside the end card drew (orange, above the title).
  assert.ok(colourBox(output, 90, [255, 136, 0], 40)[0] < 1280, "the end card's SVG logo shows");

  // Terminal (frames 120–179): each frame types a character; done typing, the frames stay the same.
  const term = componentBox(project.tracks.flatMap((t) => t.items).find((i) => i.id === "term")!, project.canvas, 0)!;
  const line = (f: number) => crop(output, f, Math.round(term.x), Math.round(term.y + term.h * 0.12), Math.round(term.w), Math.round(term.h * 0.2));
  const diff = (a: Buffer, b: Buffer) => a.reduce((n, v, i) => n + (Math.abs(v - b[i]!) > 40 ? 1 : 0), 0);
  assert.ok(diff(line(124), line(125)) > 10, "frame 125 shows one more character than 124");
  assert.ok(diff(line(130), line(131)) > 10);
  assert.ok(diff(line(170), line(175)) < 5, "after typing, nothing changes");
  frameOf(output, 135, resolve("test-output/components-export-terminal.png"));

  // SVG logo clip (frames 180–209): orange exactly over its box.
  const lit = colourBox(output, 195, [255, 136, 0], 40);
  console.log(`  SVG box: ${lit} (box 100–500 × 100–220)`);
  assert.ok(Math.abs(lit[0]! - 100) <= 2 && Math.abs(lit[1]! - 500) <= 2 && Math.abs(lit[2]! - 100) <= 2 && Math.abs(lit[3]! - 220) <= 2, `the SVG fills its box: ${lit}`);

  // Graphic (frames 210–269): the square at x = round(t·300).
  const green: Rgb = [0, 255, 0];
  assert.ok(near(read(output, 210, 100, 200), green, 40), "t = 0: the square at x 0–200");
  assert.ok(near(read(output, 240, 400, 200), green, 40), "t = 1: at x 300–500");
  assert.ok(!near(read(output, 240, 100, 200), green, 60), "and no longer at x 100");
});

test("graphic documents (review): their route takes only the graphic secret, which nothing else takes; a stuck graphic fails the export fast and by name", { skip: skipServer, timeout: 120000 }, async () => {
  const media = join(root, "media");
  const project = componentsProject(media);
  const dir = writeProject(root, "Graphic secret", project);
  mkdirSync(join(dir, "graphics"));
  writeFileSync(join(dir, "graphics", "move.html"), GRAPHIC);
  await client.ok("project.open", { dir });
  const hello = await client.ok("server.hello", {});
  assert.equal(typeof hello.graphicToken, "string");
  assert.notEqual(hello.graphicToken, server.ready.token);
  const base = `http://127.0.0.1:${server.ready.port}`;
  const get = (path: string, token: string) => fetch(`${base}${path}?token=${encodeURIComponent(token)}`).then((r) => r.status);
  assert.equal(await get("/media/graphic/move.html", hello.graphicToken), 200);
  assert.equal(await get("/media/graphic/move.html", server.ready.token), 401, "the server token isn't taken there");
  assert.equal(await get("/media/file/m-logo", hello.graphicToken), 401, "nor the graphic secret anywhere else");
  assert.equal(await get("/media/file/m-logo", server.ready.token), 200);
  const doc = await fetch(`${base}/media/graphic/move.html?token=${encodeURIComponent(hello.graphicToken)}`).then((r) => r.text());
  assert.ok(doc.indexOf("__uncutRender") < doc.indexOf('<div id="sq"'), "the bootstrap comes before the author's markup");
  // A top-level script that never ends: the export fails within the frame deadline, naming the graphic.
  writeFileSync(join(dir, "graphics", "stuck.html"), "<script>while (true) {}</script>");
  const stuck = await client.ok("project.edit", { ops: [{ op: "update_item", item: "move", set: { src: "graphics/stuck.html" } }], summary: "stuck" });
  assert.ok(stuck);
  const t0 = Date.now();
  const { jobId } = await client.ok("export.start", { output: join(root, "out", "Stuck.mp4"), quality: "draft", loudness: "off" });
  const failed = await finished(jobId);
  assert.equal(failed.phase, "failed");
  assert.match(failed.error, /"move" \(graphics\/stuck\.html\).*took longer than 5 s to load and draw a frame/);
  assert.ok(Date.now() - t0 < 25000, `failed in ${Date.now() - t0} ms, not after the 30 s render timeout`);
});

test("agent: modules_list shows the components' params; insert_device_frame and an end card in one edit; graphic_write; render_frames draws them", { skip: skipServer, timeout: 240000 }, async () => {
  const media = join(root, "media");
  const project: Project = {
    format: "uncut/0",
    name: "Agent components",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [
      { id: "m-screen", kind: "video", name: "Screen.mp4", path: join(media, "Screen.mp4"), probe: { frames: 120, fps: 30, width: 540, height: 960, hasAudio: false } },
      { id: "m-logo", kind: "image", name: "Logo.svg", path: join(media, "Logo.svg"), probe: { width: 200, height: 60 } },
    ],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 150, props: { color: "#203040" } }] },
    ],
  };
  const dir = writeProject(root, "Agent components", project);
  await client.ok("project.open", { dir });
  const agent = client.subscribe("agent.subscribe");
  await agent.until((st) => st?.dir === dir);
  rmSync(`${plan()}.turn`, { force: true });
  writeFileSync(
    plan(),
    JSON.stringify([
      [
        { tool: "project_read", args: {} },
        { tool: "modules_list", args: { kind: "component" } },
        {
          tool: "timeline_edit",
          args: {
            baseRevision: "$rev",
            summary: "Phone with the recording, then the end card",
            ops: [
              { op: "insert_device_frame", media: "m-screen", device: "phone", start: 0, duration: 60, frameId: "phone", clipId: "screen" },
              { op: "add_track", index: 1, track: { id: "cards", kind: "video", name: "Cards" } },
              { op: "insert_item", track: "cards", item: { id: "end", type: "component", component: "component.end-card", start: 60, duration: 60, props: { logo: { media: "m-logo" }, title: "Argent", code: "npx @swmansion/argent init", url: "argent.swmansion.com", background: "bg" } } },
            ],
          },
        },
        { tool: "graphic_write", args: { name: "move.html", html: GRAPHIC } },
        { tool: "graphic_write", args: { name: "move.html", html: GRAPHIC } },
        { tool: "project_read", args: {} },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "A moving square", ops: [{ op: "insert_item", track: "cards", item: { id: "move", type: "graphic", src: "graphics/move.html", start: 120, duration: 30 } }] } },
        { tool: "render_frames", args: { frames: [30, 90, 135], scale: 1 } },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "A graphic with no file", ops: [{ op: "insert_item", track: "cards", item: { id: "ghost", type: "graphic", src: "graphics/ghost.html", start: 0, duration: 30 } }] } },
        { tool: "project_read", args: {} },
        { tool: "render_frames", args: { frames: [10], scale: 0.25 } },
      ],
    ]),
  );
  const before = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length;
  const { turnId } = await client.ok("agent.send", { prompt: "Put the recording on a phone and end with the card" });
  await agent.until((st) => st?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 180000);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  assert.equal(turn.status, "done", JSON.stringify(turn).slice(0, 500));
  const results = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l)) as Array<{ tool: string; result: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> } }>;
  const [, listed, edit, wrote, again, , edit2, frames] = results;
  // modules_list: every drawn component with its params schema and placement, showsInPreview.
  const mods = JSON.parse(listed!.result.content[0]!.text!) as Array<{ id: string; params?: { properties?: Record<string, unknown> }; component?: unknown; showsInPreview: boolean }>;
  const end = mods.find((m) => m.id === "component.end-card")!;
  assert.deepEqual(Object.keys(end.params!.properties!).sort(), ["background", "code", "logo", "title", "url"]);
  assert.equal(end.showsInPreview, true);
  assert.ok(mods.find((m) => m.id === "component.device-frame")!.component, "the device frame's screens");
  assert.equal(mods.find((m) => m.id === "component.callout")!.showsInPreview, false);
  // One edit: the device frame's two tracks and items, the card's track and item.
  assert.ok(!edit!.result.isError, edit!.result.content[0]!.text);
  const saved = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Project;
  const items = saved.tracks.flatMap((t) => t.items);
  const screen = items.find((i) => i.id === "screen")!;
  const phone = items.find((i) => i.id === "phone")!;
  const box = componentBox(phone, saved.canvas, 0)!;
  const scr = screenRect("phone", box.w, box.h);
  assert.deepEqual(screen.transform, { x: Math.round(box.x + scr.x), y: Math.round(box.y + scr.y), w: Math.round(scr.w), h: Math.round(scr.h), fit: "cover", radius: Math.round(scr.radius) });
  assert.ok(items.some((i) => i.id === "end"));
  const card = turn.edits.find((e: any) => e.summary === "Phone with the recording, then the end card");
  assert.ok(card.lines.some((l: string) => /Added device frame phone/.test(l)) && card.lines.some((l: string) => /Added clip screen/.test(l)) && card.lines.some((l: string) => /Added end card end/.test(l)), card.lines.join(" | "));
  // graphic_write: a new file; never over an existing one.
  assert.ok(!wrote!.result.isError);
  assert.equal(JSON.parse(wrote!.result.content[0]!.text!).src, "graphics/move.html");
  assert.equal(readFileSync(join(dir, "graphics", "move.html"), "utf8"), GRAPHIC);
  assert.ok(again!.result.isError);
  assert.match(again!.result.content[0]!.text!, /already exists, and graphics are never overwritten/);
  assert.ok(!edit2!.result.isError, edit2!.result.content[0]!.text);
  // render_frames: the phone with the footage in it, the end card, the graphic.
  assert.ok(!frames!.result.isError, frames!.result.content[0]!.text);
  const images = frames!.result.content.filter((c) => c.type === "image");
  assert.equal(images.length, 3);
  const jpgs = [30, 90, 135].map((f, i) => {
    const file = join(root, `agent-${f}.jpg`);
    writeFileSync(file, Buffer.from(images[i]!.data!, "base64"));
    return file;
  });
  writeFileSync(resolve("test-output/components-agent-frames-30.jpg"), readFileSync(jpgs[0]!));
  writeFileSync(resolve("test-output/components-agent-frames-90.jpg"), readFileSync(jpgs[1]!));
  const isRed = ([r, g, b]: Rgb) => r > 170 && g < 90 && b < 90;
  const isBlue = ([r, g, b]: Rgb) => b > 170 && r < 90 && g < 90;
  assert.ok(isRed(read(jpgs[0]!, 0, Math.round(box.x + scr.x + scr.w / 2), Math.round(box.y + scr.y + scr.h * 0.3))), "render_frames: the footage's red on the phone's screen");
  assert.ok(isBlue(read(jpgs[0]!, 0, Math.round(box.x + scr.x + scr.w / 2), Math.round(box.y + scr.y + scr.h * 0.8))));
  assert.ok(near(read(jpgs[0]!, 0, Math.round(box.x + 7 * (box.w / 420)), Math.round(box.y + box.h / 2)), [0x1c, 0x1c, 0x1f], 16), "and the bezel");
  // The end card: its background (theme bg, near black) and its orange logo.
  assert.ok(near(read(jpgs[1]!, 0, 40, 40), [0x0a, 0x0a, 0x0b], 14), "the end card's background");
  assert.ok(colourBox(jpgs[1]!, 0, [255, 136, 0], 50)[0] < 1280, "its SVG logo");
  // The graphic at local frame 15 (t = 0.5): the square at x 150–350.
  assert.ok(near(read(jpgs[2]!, 0, 250, 200), [0, 255, 0], 50), "the graphic's square where render(0.5) put it");
  // A graphic whose file isn't there: render_frames says it isn't drawn.
  const ghost = results.at(-1)!;
  assert.ok(!ghost.result.isError);
  assert.match(ghost.result.content[0]!.text!, /the graphic "ghost" isn't drawn: graphics\/ghost\.html couldn't be read/);
});
