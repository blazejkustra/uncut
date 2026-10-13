// Phase 6 chunk 4 (D80, D81) through the export and the agent:
// - the plan: a word-by-word text is one PNG per distinct look (core textHtml at each frame), a
//   zoom fades as an alpha ramp, a move longer than MAX_RASTER_STATES looks holds frames and warns;
// - on the bundled server: a stroked title and a boxed label exported vs Chromium's PNG of the same
//   HTML (SSIM ≥ 0.98), word by word shows the expected number of words at sampled frames (bright
//   column runs), a zoomed text's width within 2 px of core's scale;
// - the fake claude: modules_list shows the looks, timeline_edit's insert_text adds a text in a
//   look with style fields, render_frames draws it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { animationAt, layout, MAX_RASTER_STATES, RENDER_CSS, solidHtml, textHtml, visualsAt, zoomScale, type Item, type Project } from "../../packages/core/src/index.ts";
import { planExport } from "../../apps/server/src/export/exportPlan.ts";
import { rasterizerCommand, startRasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skipServer = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) || !existsSync(MCP) ? "server, desktop or media core not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 1280;
const H = 720;
const BG = "#203040";
const WORDS = "ABCD EFGH IJKL MNOP";

/** The fixture: a dark solid, then a stroked title, a boxed label, a word-by-word line and a zoom, 30 frames apart. */
function textProject(): Project {
  const items: Array<Item> = [
    { id: "stroke", type: "text", start: 0, duration: 30, text: "Your title", style: { preset: "text.stroke-title" } },
    { id: "boxed", type: "text", start: 30, duration: 30, text: "New label", transform: { x: 200, y: 260 }, style: { preset: "text.boxed-label", size: 72, weight: 700, stroke: { width: 2, color: "#FFFFFF" } } },
    { id: "lines", type: "text", start: 30, duration: 30, text: "A caption that\nruns on two lines", style: { preset: "text.caption" } },
    {
      id: "words",
      type: "text",
      start: 60,
      duration: 60,
      text: WORDS,
      transform: { x: 100, y: 300 },
      style: { font: "DM Mono", size: 80, weight: 500, color: "#FFFFFF", tracking: 0 },
      animation: { in: { module: "move.word-by-word", duration: 40, params: { style: "fade" } } },
    },
    {
      id: "zoom",
      type: "text",
      start: 120,
      duration: 60,
      text: "ZOOM",
      transform: { x: 400, y: 280, w: 480 },
      style: { font: "DM Mono", size: 120, weight: 500, color: "#FFFFFF", align: "center", tracking: 0 },
      animation: { in: { module: "move.zoom", duration: 30, params: { scale: 0.5, ease: "inOut", fade: false } } },
    },
  ];
  return {
    format: "uncut/0",
    name: "Text looks",
    canvas: { width: W, height: H, fps: 30 },
    media: [],
    tracks: [
      { id: "text-2", kind: "text", name: "Text 2", items: items.filter((i) => i.id === "lines") },
      { id: "text", kind: "text", name: "Text", items: items.filter((i) => i.id !== "lines") },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 180, props: { color: BG } }] },
    ],
  };
}
const itemOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;

test("plan: word by word is one look per frame it changes (core textHtml); a zoom fades by a ramp unless fade is false; a long move is capped with a warning", () => {
  const project = textProject();
  const plan = planExport(project, { mediaPath: () => "", width: W, height: H });
  assert.ok(!("problem" in plan), "problem" in plan ? plan.problem : "");
  const words = plan.visuals.find((l) => l.item.id === "words")!;
  assert.equal(words.kind, "raster");
  if (words.kind !== "raster") return;
  // Frames 60–99 change every frame (fade per word), then it holds the plain text: 40 + 1 looks.
  assert.equal(words.states.length, 41);
  const { starts } = layout(project);
  for (let f = words.f0; f < words.f1; f++) {
    const v = visualsAt(project, starts, f).find((x) => x.item.id === "words")!;
    assert.equal(words.states[words.frames[f - words.f0]!], textHtml(v.item, project, { motion: v.motion }), `frame ${f}`);
  }
  assert.deepEqual(words.ramps, [], "word by word doesn't fade the whole text");
  const zoom = plan.visuals.find((l) => l.item.id === "zoom")!;
  assert.deepEqual(zoom.ramps, [], "fade false: no ramp");
  const fading = planExport({ ...project, tracks: project.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === "zoom" ? { ...i, animation: { in: { module: "move.zoom", duration: 30 } } } : i)) })) }, { mediaPath: () => "", width: W, height: H });
  assert.ok(!("problem" in fading));
  assert.deepEqual(fading.visuals.find((l) => l.item.id === "zoom")!.ramps, [{ type: "in", st: 120, d: 30 }]);
  assert.deepEqual(plan.warnings, []);
  // A word-by-word move over 400 frames has 400 looks: capped to MAX_RASTER_STATES with a warning.
  const long: Project = { ...project, tracks: [{ id: "text", kind: "text", name: "Text", items: [{ id: "slow", type: "text", start: 0, duration: 420, text: "one two three four five six seven eight", animation: { in: { module: "move.word-by-word", duration: 400, params: { style: "fade" } } } }] }, project.tracks[2]!] };
  const capped = planExport(long, { mediaPath: () => "", width: W, height: H });
  assert.ok(!("problem" in capped));
  const slow = capped.visuals.find((l) => l.item.id === "slow")!;
  assert.ok(slow.kind === "raster" && slow.states.length <= MAX_RASTER_STATES);
  assert.match(capped.warnings.join(" "), /"slow" changes its look on more than 360 frames/);
});

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
const gray = (file: string, f: number) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${f}),format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 64 * 1024 * 1024 });
const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]format=gray[a];[1]format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
/** Columns (x) in a band of rows whose brightest pixel is above `level`. */
const litColumns = (px: Buffer, y0: number, y1: number, level: number) => Array.from({ length: W }, (_, x) => {
  let max = 0;
  for (let y = y0; y < y1; y++) max = Math.max(max, px[y * W + x]!);
  return max > level;
});
/** Runs of lit columns separated by gaps wider than `gap` px: [x0, x1). */
const runs = (lit: ReadonlyArray<boolean>, gap: number) => {
  const out: Array<[number, number]> = [];
  for (let x = 0; x < lit.length; x++) {
    if (!lit[x]) continue;
    const last = out.at(-1);
    if (last && x - last[1] <= gap) last[1] = x + 1;
    else out.push([x, x + 1]);
  }
  return out;
};

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-text-export-test-")));
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
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

test("export: stroked and boxed text as Chromium draws them, word by word word count per frame, zoom width per frame", { skip: skipServer, timeout: 240000 }, async () => {
  const project = textProject();
  const dir = writeProject(root, "Text looks", project);
  await client.ok("project.open", { dir });
  const output = join(root, "out", "Text.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  mkdirSync("test-output", { recursive: true });

  // Stroked title (frame 15) and the boxed label with per-line captions (frame 45) vs Chromium's
  // PNG of the same HTML over the same background.
  const r = rasterizerCommand();
  assert.ok(!("problem" in r));
  const raster = await startRasterizer(r);
  const bg = solidHtml(itemOf(project, "bg"), project);
  const refs: Record<string, string> = {};
  try {
    for (const [name, ids] of [["stroke", ["stroke"]], ["boxed", ["boxed", "lines"]]] as const) {
      refs[name] = join(root, `${name}.png`);
      await raster.render({ width: W, height: H, css: RENDER_CSS, html: bg + ids.map((id) => textHtml(itemOf(project, id), project)).join(""), out: refs[name]! });
    }
  } finally {
    await raster.close();
  }
  for (const [name, f] of [["stroke", 15], ["boxed", 45]] as const) {
    const exported = frameOf(output, f, resolve(`test-output/text-export-${name}.png`));
    const score = ssim(refs[name]!, exported);
    console.log(`  ${name} export vs Chromium PNG: SSIM ${score.toFixed(4)}`);
    assert.ok(score >= 0.98, `${name}: SSIM ${score}`);
  }
  // The stroke is really there: dark pixels hug the white letters on the blue-grey background.
  const strokeFrame = gray(output, 15);
  let dark = 0;
  for (let y = 250; y < 470; y++) for (let x = 0; x < W; x++) if (strokeFrame[y * W + x]! < 20) dark++;
  assert.ok(dark > 2000, `a black outline around the title (${dark} dark pixels)`);

  // Word by word (frames 60–119, 4 words over 40 frames, fade): lit word runs in the text's band.
  const band = [300, 400] as const;
  const bgLevel = gray(output, 60).subarray(band[0] * W, band[1] * W).reduce((m, v) => Math.max(m, v), 0);
  const full = runs(litColumns(gray(output, 110), band[0], band[1], 140), 20);
  assert.equal(full.length, 4, `four words once they're in: ${JSON.stringify(full)}`);
  const item = itemOf(project, "words");
  for (const local of [0, 5, 10, 15, 20, 25, 30, 35, 45]) {
    const px = gray(output, 60 + local);
    // A word counts as shown when it's at least half there (core's progress ≥ 0.5).
    const shown = full.filter(([x0, x1]) => {
      let max = 0;
      for (let y = band[0]; y < band[1]; y++) for (let x = x0; x < x1; x++) max = Math.max(max, px[y * W + x]!);
      return max > bgLevel + (255 - bgLevel) * 0.4;
    }).length;
    const words = animationAt(item, local, project.canvas).motion.words ?? [1, 1, 1, 1];
    const expected = words.filter((w) => w >= 0.5).length;
    console.log(`  word by word, frame ${local}: ${shown} words (core: ${expected})`);
    assert.equal(shown, expected, `frame ${local}`);
  }
  frameOf(output, 85, resolve("test-output/text-export-words.png"));

  // Zoom (frames 120–179, scale 0.5 → 1 inOut over 30 frames, no fade): ink width vs core's scale.
  const zoomItem = itemOf(project, "zoom");
  const width = (f: number) => {
    const lit = runs(litColumns(gray(output, f), 200, 520, 140), 200);
    assert.equal(lit.length, 1, `frame ${f}: one run of ink ${JSON.stringify(lit)}`);
    return lit[0]![1] - lit[0]![0];
  };
  const base = width(170);
  for (const local of [0, 8, 15, 22, 29]) {
    const s = zoomScale(local / 30, false, zoomItem.animation!.in!.params);
    assert.equal(animationAt(zoomItem, local, project.canvas).motion.scale, s === 1 ? undefined : s);
    const w = width(120 + local);
    console.log(`  zoom frame ${local}: width ${w} px, core ${(base * s).toFixed(1)} px (scale ${s.toFixed(3)})`);
    assert.ok(Math.abs(w - base * s) <= 2, `frame ${local}: ${w} vs ${base * s}`);
  }
});

test("agent: modules_list shows the looks; insert_text adds a text in a look with style fields; render_frames draws it", { skip: skipServer, timeout: 240000 }, async () => {
  const project: Project = {
    format: "uncut/0",
    name: "Agent text",
    canvas: { width: W, height: H, fps: 30 },
    media: [],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 120, props: { color: BG } }] },
    ],
  };
  const dir = writeProject(root, "Agent text", project);
  await client.ok("project.open", { dir });
  const agent = client.subscribe("agent.subscribe");
  await agent.until((st) => st?.dir === dir);
  rmSync(`${plan()}.turn`, { force: true });
  writeFileSync(
    plan(),
    JSON.stringify([
      [
        { tool: "project_read", args: {} },
        { tool: "modules_list", args: { kind: "text-style" } },
        {
          tool: "timeline_edit",
          args: {
            baseRevision: "$rev",
            summary: "A big title with a kicker, then a caption",
            ops: [
              { op: "insert_text", look: "text.kicker-title", text: "Ride the ridge", start: 0, duration: 60, id: "title" },
              { op: "insert_text", look: "text.caption", text: "Filmed on a calm morning", start: 60, duration: 60, id: "cap", style: { stroke: { width: 3, color: "#000000" }, background: false }, animation: { in: { module: "move.word-by-word", duration: 20, params: { style: "rise" } } } },
            ],
          },
        },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "A look that isn't there", ops: [{ op: "insert_text", look: "text.sparkles", start: 0, duration: 30 }] } },
        { tool: "render_frames", args: { frames: [30, 90], scale: 0.5 } },
      ],
    ]),
  );
  const before = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length;
  const { turnId } = await client.ok("agent.send", { prompt: "Add a title and a caption" });
  await agent.until((st) => st?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 180000);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  assert.equal(turn.status, "done", JSON.stringify(turn).slice(0, 500));
  const results = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l)) as Array<{ tool: string; result: { isError?: boolean; content: Array<{ type: string; text?: string }> } }>;
  const [, listed, edit, bad, frames] = results;
  const looks = JSON.parse(listed!.result.content[0]!.text!) as Array<{ id: string; look?: { size: number; background?: unknown; with?: unknown }; showsInPreview: boolean }>;
  assert.ok(looks.length >= 14);
  assert.ok(looks.every((l) => l.look && l.showsInPreview), "every text style has its look");
  assert.ok(looks.find((l) => l.id === "text.caption")!.look!.background);
  assert.ok(looks.find((l) => l.id === "text.kicker-title")!.look!.with);
  assert.ok(!edit!.result.isError, edit!.result.content[0]!.text);
  const saved = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Project;
  const items = saved.tracks.flatMap((t) => t.items);
  assert.deepEqual(itemOf(saved, "title").style, { preset: "text.kicker-title", size: 72, weight: 700 });
  assert.equal(itemOf(saved, "title").text, "Ride the ridge");
  const kicker = items.find((i) => i.style?.preset === "text.kicker")!;
  assert.equal(kicker.text, "Chapter one", "the kicker came along");
  assert.deepEqual(itemOf(saved, "cap").style, { preset: "text.caption", size: 32, weight: 600, stroke: { width: 3, color: "#000000" }, background: false });
  assert.deepEqual(itemOf(saved, "cap").animation, { in: { module: "move.word-by-word", duration: 20, params: { style: "rise" } } });
  assert.equal(saved.tracks.filter((t) => t.kind === "text").length, 2, "the kicker got its own text track");
  const card = turn.edits.find((e: any) => e.summary === "A big title with a kicker, then a caption");
  assert.ok(card.lines.some((l: string) => /Added text title/.test(l)) && card.lines.some((l: string) => /Added text cap/.test(l)), card.lines.join(" | "));
  assert.ok(bad!.result.isError);
  assert.match(bad!.result.content[0]!.text!, /no text look called text\.sparkles/);
  assert.ok(!frames!.result.isError, frames!.result.content[0]!.text);
  assert.equal(frames!.result.content.filter((c) => c.type === "image").length, 2);
});
