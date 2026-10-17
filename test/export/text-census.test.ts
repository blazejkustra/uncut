// The text census (packages/core census.ts) through the export rasteriser: the keynote film T3 set
// its agent thread as a piece at type 54 on a 1350 px canvas (a 4 % font; its 12 px step rows at
// 12/13 of that), letters about 2.7 % tall, and nothing measured them. The census lists those words
// with their size; the steps as their own piece at the default size, and words under a blur or
// faded out, aren't listed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { censusOf, graphicDocument, graphicInfo, SMALL_TEXT, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { censusNear, legibilityNote } from "../../apps/server/src/agent/agentLegibility.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 1080;
const H = 1350;
const canvas = { width: W, height: H, fps: 30 };
const STEPS = ["Read the brand kit", "Found the song's beats, 120 BPM", "Ranked the 6 drone clips"];

// t < 1: T3's thread piece at type 54; t >= 1: the steps as their own piece at the default size, the
// T3 thread blurred behind them (the stage) and a faded caption.
const STAGE = `<div id="host" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:#0a0a0a"></div>
<div id="back" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;filter:blur(6px)"></div>
<div id="pics" style="display:none"><canvas width="540" height="400" style="position:absolute;left:0;top:0;width:1080px;height:800px"></canvas>
<svg viewBox="0 0 108 135" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"><text x="5" y="100" font-size="8" font-family="DM Sans">Big svg words</text><text x="5" y="120" font-size="3" font-family="DM Sans">Tiny svg words</text></svg></div>
<div id="fade" style="position:absolute;left:40px;top:1250px;font:20px 'DM Sans';color:#fff;opacity:0.2">Faded caption words</div>
<script src="uncut:lib/ui.js"></script>
<script>
const props = { message: { text: "Create a promo video for Uncut from this drone footage" }, turn: { steps: ${JSON.stringify(STEPS)}, done: 2 } };
window.render = (t) => {
  const host = document.getElementById("host");
  const back = document.getElementById("back");
  document.getElementById("pics").style.display = t >= 1.8 ? "block" : "none";
  if (t < 1) {
    back.replaceChildren();
    uncutUI.sequence(host, t, [{ at: 0, piece: "agent.thread", props, width: 960, type: 54 }]);
  } else {
    uncutUI.sequence(back, t, [{ at: 0, piece: "agent.thread", props, width: 960, type: 54 }]);
    uncutUI.sequence(host, t, [{ at: 0, piece: "turn.steps", props: { steps: ${JSON.stringify(STEPS)}, done: 2 } }]);
  }
};
</script>`;

// T4-keynote's Export moment: a sequence swapping topbar.export into export.high (dur 0.2 at 1.0 s) over
// the editor stage mounted with blur and dim, and a big caption the graphic fades itself.
const SOFT = `<div id="stage" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></div>
<div id="seq" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></div>
<div id="cap" style="position:absolute;left:40px;top:1200px;font:80px 'DM Sans';color:#fff">Ship it today</div>
<script src="uncut:lib/ui.js"></script>
<script>
window.render = (t) => {
  uncutUI.mount(document.getElementById("stage"), "composer", { width: 360, height: 160, scale: 5, blur: t >= 1.5 ? 8 : 0, dim: t >= 1.5 ? 0.35 : 0, text: "Big stage words" });
  document.getElementById("cap").style.opacity = t >= 1.5 ? "0.2" : "1";
  uncutUI.sequence(document.getElementById("seq"), t, [{ at: 0, piece: "topbar.export", props: {}, y: 675 }, { at: 1.0, piece: "export.high", props: { quality: "high" }, y: 675, dur: 0.2 }]);
};
</script>`;

let root: string;
let docs: Map<string, string>;
let raster: Rasterizer;
const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/census.html", duration: 60 }] }] } as unknown as Project;
const softProject = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/soft.html", duration: 60 }] }] } as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-census-")));
  const dir = join(root, "Census.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "census.html"), STAGE);
  writeFileSync(join(dir, "graphics", "soft.html"), SOFT);
  const libs = await loadGraphicLibs(resolve("assets/graphic-libs"));
  const graphics = await readGraphics(dir, project, libs);
  const softs = await readGraphics(dir, softProject, libs);
  docs = new Map([...graphics, ...softs].map(([src, html]) => [src, graphicDocument(html, canvas)]));
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

async function census(local: number, src = "graphics/census.html") {
  const out = join(root, `f-${src.length}-${local}.png`);
  const info = graphicInfo({ duration: 60, props: {} }, canvas, local);
  const reply = await raster.render({ kind: "graphic", width: W, height: H, doc: docs.get(src)!, t: local / canvas.fps, info, out, census: SMALL_TEXT });
  const c = censusOf(reply ? reply.census : undefined);
  assert.ok(c, "a census came back");
  return c;
}

test("the census lists T3's thread words under 3 % and not the steps set as their own piece", { skip, timeout: 120000 }, async (t) => {
  const thread = await census(0);
  t.diagnostic(JSON.stringify(thread));
  for (const step of STEPS) {
    const run = thread.small.find((x) => x.text === step);
    assert.ok(run, `"${step}" listed`);
    assert.ok(run.share > 2 && run.share < 3, `"${step}" at ${run.share} %`);
  }
  const steps = await census(45);
  t.diagnostic(JSON.stringify(steps));
  assert.ok(steps.measured >= STEPS.length, "the steps were measured");
  assert.deepEqual(steps.small, [], "nothing under the floor: the blurred thread and the faded caption are texture");
  const note = legibilityNote([{ frame: 0, small: thread.small, measured: thread.measured }], H);
  assert.match(note ?? "", /frame 0: .*"Read the brand kit" 2\.\d %/);
  assert.match(note ?? "", /uncutUI\.frameText\(el, world/);
  assert.equal(legibilityNote([{ frame: 45, small: steps.small, measured: steps.measured }], H), undefined);
});

test("SVG text is sized through its viewBox, and a canvas on screen is reported as unseen, never as no small text", { skip, timeout: 120000 }, async (t) => {
  const c = await census(57);
  t.diagnostic(JSON.stringify(c));
  assert.equal(c.small.find((x) => x.text === "Big svg words"), undefined, "80 px in frame px: not small");
  const tiny = c.small.find((x) => x.text === "Tiny svg words");
  assert.ok(tiny && tiny.share > 1.4 && tiny.share < 1.8, `the viewBox's 10x counted: ${tiny?.share}`);
  assert.equal(c.unseen, 1, "the canvas");
  assert.equal((await census(45)).unseen, undefined);
  const note = legibilityNote([{ frame: 57, small: [], measured: c.measured, unseen: c.unseen }], H);
  assert.match(note ?? "", /frame 57, text drawn on a canvas.*isn't measured/);
});

test("a word blurred mid-swap, in a blurred and dimmed stage, or faded by the graphic is listed with exactly what softens it", { skip, timeout: 120000 }, async (t) => {
  // f 32 at 30 fps: a third into the 0.2 s swap into export.high at 1.0 s, as T4's f 1356 was (0.4 in).
  const mid = await census(32, "graphics/soft.html");
  t.diagnostic(JSON.stringify(mid));
  const high = mid.soft?.find((x) => x.text === "High");
  assert.ok(high && high.by === "swap" && high.piece === "export.high" && high.side === "in" && high.at === 1 && high.dur === 0.2, JSON.stringify(high));
  assert.equal(mid.soft?.some((x) => x.by === "stage"), false, "the stage isn't blurred yet");
  const rest = await census(40, "graphics/soft.html");
  assert.equal(rest.soft?.find((x) => x.text === "High"), undefined, "at rest the card reads");
  assert.ok(rest.measured > 0);
  const hint = censusNear([{ frame: 32, measured: mid.measured, small: mid.small, ...(mid.soft ? { soft: mid.soft } : {}) }], 32 / canvas.fps, canvas.fps) ?? "";
  assert.match(hint, /softened at f 32: "High" .*uncutUI\.sequence's swap into "export\.high" \(its key at 1 s, dur 0\.2 s\).*at rest at 1\.2 s/, hint);
  // The stage's own props and the graphic's own opacity, each named.
  const late = await census(50, "graphics/soft.html");
  t.diagnostic(JSON.stringify(late.soft));
  const stage = late.soft?.find((x) => x.by === "stage");
  assert.equal(late.soft?.some((x) => x.by === "stage" && x.share < SMALL_TEXT * 100), false, "a stage's small chrome isn't listed");
  assert.ok(stage && stage.part === "composer" && stage.blur > 1 && stage.bright < 0.7, JSON.stringify(stage));
  assert.equal(late.soft?.find((x) => x.text === "High")?.by, undefined, "the hero piece over the stage isn't softened by it");
  const cap = late.soft?.find((x) => x.text === "Ship it today");
  assert.ok(cap && cap.by === "graphic" && cap.prop === "opacity" && cap.el === "div#cap", JSON.stringify(cap));
  const note = legibilityNote([{ frame: 50, measured: late.measured, small: late.small, ...(late.soft ? { soft: late.soft } : {}) }], H) ?? "";
  assert.match(note, /"Big stage words.*blurred 8 px, darkened to 65 %: uncutUI\.mount\("composer"\)'s blur and dim props/);
  assert.match(note, /"Ship it today" 4\.3 % \(at 20 % opacity: the graphic's own opacity on div#cap/);
});
