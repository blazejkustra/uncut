// Phase 6 chunk 5 (D82) through the export:
// - the plan: a captions item is one raster layer from its first card to its last, each frame the
//   text item core captionAt gives drawn by textHtml (an empty state between cards); word mode is
//   one look per speaking word on a long talk (no warning);
// - on the bundled server: captions over a clip with a cut in the middle show in the lower band
//   exactly on their cards' frames (the cut word never shows), and a word-mode frame matches
//   Chromium's PNG of the same HTML (SSIM ≥ 0.98) with the speaking word in the accent colour.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  applyEdit,
  captionAt,
  captionCards,
  createSession,
  planMakeCaptions,
  TEXT_STYLES,
  RENDER_CSS,
  textHtml,
  type CutTranscript,
  type Project,
} from "../../packages/core/src/index.ts";
import { CAPTION_GAP_HTML, planExport } from "../../apps/server/src/export/exportPlan.ts";
import { rasterizerCommand, startRasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skipServer =
  !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP)
    ? "server, desktop or media core not built (run pnpm build)"
    : hasFfmpeg
      ? false
      : "needs ffmpeg";

const W = 1280;
const H = 720;
const BG = "#203040";

// Media seconds at 30 fps. The main track plays media frames 0–59, then 120–179 (a cut removes 60–119,
// so "Delta" at 66–78 never shows); "Echo" (138) lands at timeline 78.
const WORDS = [
  { text: "Alpha", start: 0.2, end: 0.6 }, // 6–18
  { text: "Bravo", start: 0.7, end: 1.1 }, // 21–33
  { text: "Charlie.", start: 1.2, end: 1.6 }, // 36–48
  { text: "Delta", start: 2.2, end: 2.6 }, // cut
  { text: "Echo", start: 4.6, end: 5.0 }, // media 138–150 → 78–90
  { text: "Foxtrot.", start: 5.1, end: 5.5 }, // media 153–165 → 93–105
];
const T: CutTranscript = { words: WORDS, language: "en", seconds: 6 };

function captionsProject(path: string, mode: "line" | "word", words = T): Project {
  const base: Project = {
    format: "uncut/0",
    name: "Captions export",
    canvas: { width: W, height: H, fps: 30 },
    textLooks: 1,
    media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path, probe: { frames: 180, fps: 30, width: 640, height: 360, hasAudio: true } }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 60 },
          { id: "clip-2", type: "clip", media: "m-talk", in: 120, duration: 60 },
        ],
      },
    ],
  };
  const plan = planMakeCaptions(base, { media: "m-talk", transcript: words, mode });
  assert.ok(!("problem" in plan), "problem" in plan ? plan.problem : "");
  return applyEdit(createSession(base), { actor: "user", ops: plan.ops }).project;
}
const capOf = (p: Project) => p.tracks.flatMap((t) => t.items).find((i) => i.type === "captions")!;

test("plan: a raster layer per run of touching cards, each frame core captionAt's text; one look per card or speaking word", () => {
  for (const mode of ["line", "word"] as const) {
    const project = captionsProject("/tmp/none.mp4", mode);
    const plan = planExport(project, { mediaPath: () => "/tmp/none.mp4", width: W, height: H });
    assert.ok(!("problem" in plan), "problem" in plan ? plan.problem : "");
    const layers = plan.visuals.filter((l) => l.item.type === "captions");
    // Two cards 21 frames apart: two layers, nothing drawn in between.
    assert.deepEqual(
      layers.map((l) => [l.f0, l.f1]),
      [
        [6, 57],
        [78, 114],
      ],
    );
    for (const layer of layers) {
      assert.ok(layer.kind === "raster");
      if (layer.kind !== "raster") return;
      assert.deepEqual(layer.ramps, []);
      for (let f = layer.f0; f < layer.f1; f++) {
        const text = captionAt(project, capOf(project), f);
        assert.ok(text, `${mode} frame ${f}`);
        assert.equal(layer.states[layer.frames[f - layer.f0]!], textHtml(text, project), `${mode} frame ${f}`);
      }
    }
    // Line: one look per card (a still each); word: one per word shown (3 + 2).
    assert.deepEqual(
      layers.map((l) => (l.kind === "raster" ? l.states.length : 0)),
      mode === "line" ? [1, 1] : [3, 2],
    );
    assert.deepEqual(plan.warnings, []);
  }
});

test("plan: an hour of distinct words in word mode: one look per word, at most 16 layers, quick to plan, a warning with the extra time", () => {
  // 9000 distinct words over an hour (0.4 s each), sentences of 7, a 3 s break every 70 words (gaps between runs of cards).
  const words: Array<{ text: string; start: number; end: number }> = [];
  let t = 0.2;
  for (let i = 0; i < 9000; i++) {
    words.push({ text: `word${i}${i % 7 === 6 ? "." : ""}`, start: t, end: t + 0.3 });
    t += i % 70 === 69 ? 3 : i % 7 === 6 ? 0.9 : 0.4;
  }
  const seconds = Math.ceil(t + 1);
  const frames = seconds * 30;
  const base = captionsProject("/tmp/none.mp4", "word", { words, seconds, language: "en" });
  const project: Project = {
    ...base,
    media: [{ ...base.media[0]!, probe: { ...base.media[0]!.probe, frames } }],
    tracks: base.tracks.map((tr) => (tr.role === "main" ? { ...tr, items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: frames }] } : tr)),
  };
  const t0 = performance.now();
  const plan = planExport(project, { mediaPath: () => "/tmp/none.mp4", width: W, height: H });
  const ms = performance.now() - t0;
  assert.ok(!("problem" in plan));
  const layers = plan.visuals.filter((l) => l.item.type === "captions");
  const looks = layers.reduce((n, l) => n + (l.kind === "raster" ? l.states.length : 0), 0);
  console.log(`  an hour (${frames} frames): ${layers.length} layers, ${looks} looks, planned in ${ms.toFixed(0)} ms`);
  assert.ok(layers.length <= 16 && layers.length > 1);
  assert.ok(looks >= 9000 && looks <= 9000 + layers.length, `one look per word (+ a gap look per merged layer): ${looks}`);
  assert.ok(ms < 8000, `${ms} ms`);
  assert.match(plan.warnings.join(" "), /caption looks to draw, which adds about \d+ min/);
  // Spot-check frames against captionAt.
  for (const f of [100, 54321, frames - 200]) {
    const layer = layers.find((l) => l.f0 <= f && f < l.f1);
    const text = captionAt(project, capOf(project), f);
    if (!layer) assert.equal(text, undefined);
    else if (layer.kind === "raster") assert.equal(layer.states[layer.frames[f - layer.f0]!], text ? textHtml(text, project) : CAPTION_GAP_HTML);
  }
});

test(
  "portrait canvases (4:5, 9:16): every card drawn by Chromium has exactly its lines and stays inside the safe area",
  { skip: skipServer, timeout: 120000 },
  async () => {
    const sentence =
      "Captions should never wrap past their lines on a tall canvas, even with longer words like internationalization or responsibilities sprinkled in between the short ones. That keeps every card readable and inside the frame.";
    const words = sentence.split(" ").map((text, i) => ({ text, start: 0.2 + i * 0.22, end: 0.38 + i * 0.22 }));
    const r = rasterizerCommand();
    assert.ok(!("problem" in r));
    const raster = await startRasterizer(r);
    const dirPng = mkdtempSync(join(tmpdir(), "uncut-captions-portrait-"));
    try {
      for (const [cw, ch] of [
        [1080, 1350],
        [1080, 1920],
      ] as Array<[number, number]>) {
        for (const look of ["text.caption", "text.captions", "text.lower-third"]) {
          const base: Project = {
            format: "uncut/0",
            name: "Portrait",
            canvas: { width: cw, height: ch, fps: 30 },
            textLooks: 1,
            media: [
              {
                id: "m-talk",
                kind: "video",
                name: "Talk.mp4",
                path: "/tmp/none.mp4",
                probe: { frames: 360, fps: 30, width: 1080, height: 1920, hasAudio: true },
              },
            ],
            tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 360 }] }],
          };
          const made = planMakeCaptions(base, { media: "m-talk", transcript: { words, seconds: 12 }, look });
          assert.ok(!("problem" in made));
          const project = applyEdit(createSession(base), { actor: "user", ops: made.ops }).project;
          const item = capOf(project);
          const margin = Math.round(Math.min(cw, ch) / 15);
          const cards = captionCards(project, item);
          assert.ok(cards.length >= 4);
          for (const [n, card] of cards.entries()) {
            const png = join(dirPng, `${cw}x${ch}-${look}-${n}.png`);
            await raster.render({
              width: cw,
              height: ch,
              css: RENDER_CSS,
              html: `<div style="position:absolute;inset:0;background:${BG}"></div>${textHtml(captionAt(project, item, card.from)!, project)}`,
              out: png,
            });
            const px = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 64 * 1024 * 1024 });
            const bg = px[0]!;
            let top = ch;
            let bottom = -1;
            let left = cw;
            let right = -1;
            const textRows: Array<boolean> = [];
            for (let y = 0; y < ch; y++) {
              let lit = false;
              for (let x = 0; x < cw; x++) {
                const v = px[y * cw + x]!;
                if (Math.abs(v - bg) > 12) {
                  top = Math.min(top, y);
                  bottom = Math.max(bottom, y);
                  left = Math.min(left, x);
                  right = Math.max(right, x);
                }
                if (v > 200) lit = true;
              }
              textRows.push(lit);
            }
            // Lines of text from the height of the white ink: n lines span (n − 1) line heights plus about one em of glyphs.
            const size = (item.style as { size: number }).size;
            const lh = TEXT_STYLES[look]!.lineHeight * size;
            const inkTop = textRows.indexOf(true);
            const inkBottom = textRows.lastIndexOf(true);
            const lines = Math.round((inkBottom - inkTop + 1 - 0.9 * size) / lh) + 1;
            const where = `${cw}×${ch} ${look} card ${n} "${card.words.map((w) => w.text).join(" ")}"`;
            assert.equal(lines, card.lines.length, `${where}: lines drawn`);
            // Horizontally the look's own x is the limit (a lower third sits at 6.25 % of the width, inside 72 px).
            const x0 = Math.min(margin, (item.transform as { x: number }).x);
            assert.ok(
              top >= margin && bottom <= ch - margin && left >= x0 - 2 && right <= cw - x0 + 2,
              `${where}: box ${left},${top}–${right},${bottom} outside the safe area (${margin})`,
            );
          }
        }
      }
    } finally {
      await raster.close();
      rmSync(dirPng, { recursive: true, force: true });
    }
  },
);

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let jobs: ReturnType<Client["subscribe"]>;
const job = (id: string) => jobs.values.at(-1)?.find((j: { id: string }) => j.id === id);
const finished = (id: string, timeout = 180000) =>
  jobs.until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), timeout).then(() => job(id));
const frameOf = (file: string, n: number, out: string) => (
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-update", "1", out]),
  out
);
/** Every frame of the file as raw RGB (W×H×3 each). */
const rgbFrames = (file: string) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 * 1024 * 1024 });
const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]format=gray[a];[1]format=gray[b];[a][b]ssim", "-f", "null", "-"], {
    encoding: "utf8",
  });
  const m = /All:([\d.]+)/.exec(r.stderr);
  if (!m) throw new Error(`ssim of ${a} and ${b} failed: ${r.stderr.slice(-400)}`);
  return Number(m[1]);
};
/** In the lower band: near-white pixels (caption text) and light-blue ones (the accent, #99DAFF). */
function band(all: Buffer, f: number) {
  const size = W * H * 3;
  const px = all.subarray(f * size, (f + 1) * size);
  let white = 0;
  let accent = 0;
  for (let y = Math.round(H * 0.75); y < Math.round(H * 0.97); y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const [r, g, b] = [px[i]!, px[i + 1]!, px[i + 2]!];
      if (r > 220 && g > 220 && b > 220) white++;
      if (b > 220 && r > 110 && r < 190 && g > 180 && b - r > 50) accent++;
    }
  }
  return { white, accent };
}

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-captions-export-test-")));
  mkdirSync(join(root, "out"));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${BG.replace("#", "0x")}:size=640x360:rate=30`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=48000",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    join(root, "Talk.mp4"),
  ]);
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data") } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "export: captions over a cut show on their cards' frames only; a word-mode frame is Chromium's drawing of the same HTML",
  { skip: skipServer, timeout: 300000 },
  async () => {
    mkdirSync("test-output", { recursive: true });
    const exportOf = async (name: string, project: Project) => {
      const dir = writeProject(root, name, project);
      await client.ok("project.open", { dir });
      const output = join(root, "out", `${name}.mp4`);
      const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
      const done = await finished(jobId);
      assert.equal(done.phase, "done", done.error);
      return output;
    };

    // Line mode: "Alpha Bravo Charlie." over 6–56 (until 48 + the 9-frame hold), "Echo Foxtrot." over 78–113.
    const line = captionsProject(join(root, "Talk.mp4"), "line");
    assert.deepEqual(
      captionCards(line, capOf(line)).map((c) => [c.from, c.to]),
      [
        [6, 57],
        [78, 114],
      ],
    );
    const lineFile = await exportOf("Line", line);
    const frames = rgbFrames(lineFile);
    assert.equal(frames.length, W * H * 3 * 120, "the export is the main track's 120 frames (captions don't lengthen it)");
    const shown = Array.from({ length: 120 }, (_, f) => band(frames, f).white > 200);
    const expected = Array.from({ length: 120 }, (_, f) => (f >= 6 && f < 57) || (f >= 78 && f < 114));
    const wrong = shown.flatMap((s, f) => (s !== expected[f] ? [f] : []));
    console.log(`  caption text in the lower band on frames ${shown.flatMap((s, f) => (s ? [f] : [])).join(",")}`);
    assert.deepEqual(wrong, [], `frames where the captions are wrong: ${wrong.join(", ")}`);
    frameOf(lineFile, 30, resolve("test-output/captions-export-line.png"));

    // Word mode at frame 25: "Bravo" speaks (21–35). The export vs Chromium's PNG of the same HTML.
    const word = captionsProject(join(root, "Talk.mp4"), "word");
    const wordFile = await exportOf("Word", word);
    const text = captionAt(word, capOf(word), 25)!;
    assert.equal(text.text, "Alpha [[Bravo]] Charlie.");
    const r = rasterizerCommand();
    assert.ok(!("problem" in r));
    const raster = await startRasterizer(r);
    const ref = join(root, "word-ref.png");
    try {
      await raster.render({
        width: W,
        height: H,
        css: RENDER_CSS,
        html: `<div style="position:absolute;inset:0;background:${BG}"></div>${textHtml(text, word)}`,
        out: ref,
      });
    } finally {
      await raster.close();
    }
    const exported = frameOf(wordFile, 25, resolve("test-output/captions-export-word.png"));
    const score = ssim(ref, exported);
    console.log(`  word mode frame 25 vs Chromium PNG: SSIM ${score.toFixed(4)}`);
    assert.ok(score >= 0.98, `SSIM ${score}`);
    const wordFrames = rgbFrames(wordFile);
    const lit = band(wordFrames, 25);
    assert.ok(lit.accent > 100, `the speaking word in the accent colour (${lit.accent} px)`);
    assert.ok(band(wordFrames, 40).accent > 100 && band(wordFrames, 40).white > 200, "Charlie. lit, the others white");
    assert.equal(band(wordFrames, 60).white, 0, "nothing between the cards");
  },
);
