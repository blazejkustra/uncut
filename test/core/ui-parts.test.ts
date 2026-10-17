// uncut:lib/ui.js (uncutUI): Uncut's own editor UI as parts a graphic animates, generated from the
// real components and CSS by scripts/ui-parts.ts. Here, without a browser: the generated file is in
// step with what it is made from (else: node scripts/ui-parts.ts), it loads in a VM touching nothing
// but window, every part the header promises is there with its size, every CSS rule is scoped under
// .uncut-ui (a part can't restyle the graphic around it), nothing in the data can close the inline
// script it is inlined into, and the header documents the whole API. The parts drawn through the
// export rasteriser and the preview: test/export/graphic-libs-export.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { GRAPHIC_LIBS, GRAPHIC_LIBS_DOC } from "../../packages/core/src/index.ts";
import { libInputHash, pooled, runtimeJs, scopeSelector, uiPartsInputHash, uiPartsInputs, UI_HEADER } from "../../scripts/ui-parts-lib.ts";
import { librarySignatures } from "../../apps/server/src/agent/agentDocs.ts";

const ROOT = resolve(".");
const LIB = readFileSync(resolve("assets/graphic-libs/ui.js"), "utf8");
const PARTS = ["editor", "topbar", "agent", "message", "turn", "review", "timeline", "preview", "composer", "storyboard", "export", "exportProgress", "inspector", "effects"];

type Ui = { parts(): Array<string>; size(n: string): { width: number; height: number }; css(): string; mount: unknown; find: unknown; findAll: unknown; cursor: unknown; timecode(s: number, fps?: number): string };
const load = () => {
  const window: Record<string, unknown> = {};
  runInNewContext(LIB, { window });
  return window.uncutUI as Ui;
};

test("ui.js is generated from the app as it is now (else run: node scripts/ui-parts.ts)", () => {
  const inputs = uiPartsInputs(ROOT);
  // The harness's whole import closure: a helper or component outside the parts' folders changes the editor part too.
  for (const f of ["apps/web/src/ui/Tooltip.tsx", "apps/web/src/state/format.ts", "apps/web/src/editor/App.tsx", "apps/web/package.json"]) assert.ok(inputs.includes(f), f);
  for (const f of ["apps/web/src/styles.css", "apps/web/src/panels/Composer.tsx", "apps/web/src/timeline/ItemBox.tsx", "apps/web/src/panels/ExportDialog.tsx", "apps/web/src/uiparts/fixture.ts", "apps/web/src/uiparts/runtime.ts", "apps/web/src/uiparts/extract.ts"]) assert.ok(inputs.includes(f), f);
  assert.equal(libInputHash(LIB), uiPartsInputHash(ROOT), "assets/graphic-libs/ui.js is stale: regenerate it with node scripts/ui-parts.ts");
  assert.ok(LIB.startsWith(UI_HEADER), "the header is the generator's");
  assert.ok(LIB.includes(runtimeJs(readFileSync(resolve("apps/web/src/uiparts/runtime.ts"), "utf8"))), "the runtime is runtime.ts, types stripped");
});

test("no invented run facts in the parts: the fixture's markup states no timing, count, BPM, defect or fix, and the review starts neutral", () => {
  const data = JSON.parse(/var DATA = (\{.*\});\n/.exec(LIB)![1]!) as { pool: Array<string>; parts: Record<string, { html: string }> };
  for (const [n, p] of Object.entries(data.parts)) {
    const text = p.html.replace(/\u0001\d+\u0002/g, "").replace(/<[^>]+>/g, " ");
    // (The export's "About 38 s left" stays in the markup for its layout; the runtime blanks it.)
    assert.doesNotMatch(text, /Opus|\d+ s\)|BPM|drop at \d|Placed \d|\d+k \/ \d+M|Flood keyed|frame 744|1289/, n);
    assert.doesNotMatch(p.html, /agent-review-defect"|agent-review-fix"|token-meter-text/, `${n}: no invented defect, fix or context usage`);
  }
  // The runtime blanks what the capture can't avoid (the review's result, round, scores; the plan's
  // state; the turn's status; the export's time left) before the graphic's props, which alone add facts.
  const code = runtimeJs(readFileSync(resolve("apps/web/src/uiparts/runtime.ts"), "utf8"));
  assert.match(code, /neutral\(root\);\s*applyProps\(name, root, name === "editor" \? \{ media: o\.media \} : o\)/);
  // The editor's panels get their props right after (liveEditor), each from its blanked markup.
  assert.match(code, /function liveEditor[\s\S]*neutral\(el\)/);
  for (const want of [/"Reviewing"/, /\.plan-state/, /\.turn-status/, /\.export-status \.muted/]) assert.match(code, want);
  assert.match(UI_HEADER, /Run facts are real or absent/);
  assert.doesNotMatch(UI_HEADER, /status \("Passed"/);
  assert.match(GRAPHIC_LIBS_DOC, /By default a part states no run facts/);
});

test("it's a bundled library: loads in a VM with only window, every part with its size, the API complete", () => {
  assert.ok((GRAPHIC_LIBS as ReadonlyArray<string>).includes("ui.js"));
  assert.match(GRAPHIC_LIBS_DOC, /uncut:lib\/ui\.js/);
  assert.match(GRAPHIC_LIBS_DOC, /For a film about Uncut itself, build from these parts instead of redrawing its panels/);
  const ui = load();
  assert.deepEqual([...ui.parts()].sort(), [...PARTS].sort());
  for (const n of PARTS) {
    const s = ui.size(n);
    assert.ok(s.width > 0 && s.height > 0, `${n}: ${s.width} x ${s.height}`);
  }
  assert.deepEqual({ ...ui.size("editor") }, { width: 1920, height: 900 }, "the editor is the whole window");
  assert.throws(() => ui.size("nope"), /no part "nope"/);
  assert.equal(ui.timecode(12.5, 60), "00:00:12:30");
  assert.equal(ui.timecode(0), "00:00:00:00");
  for (const f of ["mount", "find", "findAll", "cursor"]) assert.equal(typeof (ui as unknown as Record<string, unknown>)[f], "function", f);
  // The header names every function the object has, and every part.
  const signatures = librarySignatures(LIB)!;
  for (const line of signatures.split("\n")) assert.ok(UI_HEADER.includes(line.replace(/\(.*$/, "(")), line);
  for (const n of PARTS) assert.ok(UI_HEADER.includes(n), n);
  assert.doesNotMatch(UI_HEADER, /[·•]|\w \* \w/);
});

test("the parts' CSS is all scoped under .uncut-ui, and keeps no hover or focus state", () => {
  const css = load().css();
  // Every selector of every rule starts at the scope.
  const selectors = [...css.matchAll(/(^|\})\s*([^{}]+)\{/g)].flatMap((m) => m[2]!.split(",").map((s) => s.trim()));
  assert.ok(selectors.length > 200, `${selectors.length} selectors`);
  for (const s of selectors) assert.ok(s === ".uncut-ui" || s.startsWith(".uncut-ui ") || s.startsWith(".uncut-ui."), s);
  assert.doesNotMatch(css, /:hover|:focus|:active/);
  // Nothing runs on the wall clock: a frame is a function of t alone.
  assert.doesNotMatch(css, /transition(-[a-z-]+)?\s*:|animation(-[a-z-]+)?\s*:|@keyframes/);
  assert.doesNotMatch(css, /@font-face/, "the app's fonts are the system's: nothing to load");
  // The page's own background isn't taken (a part on a transparent graphic stays a part).
  assert.doesNotMatch(css, /\.uncut-ui\{[^}]*background/);
  assert.match(css, /\.uncut-ui\{[^}]*--select:\s*#6d8cff/, "the app's colour tokens, on the scope");
  assert.equal(scopeSelector("*"), ".uncut-ui, .uncut-ui *");
  assert.equal(scopeSelector(":root"), ".uncut-ui");
  assert.equal(scopeSelector('body[data-window="editor"] .x > .y'), ".uncut-ui .x > .y");
  assert.equal(scopeSelector(".clip.selected .edge"), ".uncut-ui .clip.selected .edge");
});

test("the data can't close its script, repeated icons are pooled, and the whole library fits the export's budget", () => {
  assert.doesNotMatch(LIB, /<\/script|<!--/i);
  const data = JSON.parse(/var DATA = (\{.*\});\n/.exec(LIB)![1]!) as { pool: Array<string>; parts: Record<string, { html: string }> };
  assert.ok(data.pool.length > 10);
  assert.equal(new Set(data.pool).size, data.pool.length, "each pooled piece once");
  for (const [n, p] of Object.entries(data.parts)) {
    assert.doesNotMatch(p.html, /<svg/, `${n}: icons are pooled`);
    assert.doesNotMatch(p.html, /http:\/\/127\.0\.0\.1|src="http/, `${n}: nothing points at the server`);
    for (const m of p.html.matchAll(/\u0001(\d+)\u0002/g)) assert.ok(Number(m[1]) < data.pool.length, n);
  }
  const { parts, pool } = pooled({ a: { html: '<i><svg a="1"></svg><svg a="1"></svg><img src="data:image/png;base64,AAAA"></i>', width: 1, height: 1, ancestors: [] } });
  assert.deepEqual(pool, ['<svg a="1"></svg>', "data:image/png;base64,AAAA"]);
  assert.equal(parts.a!.html, '<i>\u00010\u0002\u00010\u0002<img src="\u00011\u0002"></i>');
  // The pieces runtime and the Effects tab's look thumbnails (JPEG) brought it near 300 KB; the whole document with every library stays under MAX_GRAPHIC_DOC_BYTES (graphic-libs.test.ts).
  // The live editor stage and fly (round 7) took it past 310 KB.
  assert.ok(Buffer.byteLength(LIB) < 320_000, `ui.js is ${Buffer.byteLength(LIB)} bytes`);
});

test("runtimeJs drops whole-line comments only: code after a leading /* */ stays, a multi-line template literal can't be cut", () => {
  assert.equal(runtimeJs("/* a */ const x = 1;\nconst y = 2; /* b */\nconst z = 3;"), "/* a */ const x = 1;\nconst y = 2; /* b */\nconst z = 3;");
  assert.equal(runtimeJs("  /* lead */ go();\nkeep();\n  /** doc\n   * more */\n// gone\nend();"), "/* lead */ go();\nkeep();\n\nend();");
  assert.equal(runtimeJs('const u = "http://x", c = "a{background:url(//x)}", r = /\\/\\//g;'), 'const u = "http://x", c = "a{background:url(//x)}", r = /\\/\\//g;');
  assert.throws(() => runtimeJs("const s = `line\n// not a comment\nend`;"), /multi-line template literal/);
  assert.equal(runtimeJs("const s = `one\ntwo`;"), "const s = `one\ntwo`;");
});

test("pure at load and from t: no clocks, timers or randomness in the runtime", () => {
  const code = runtimeJs(readFileSync(resolve("apps/web/src/uiparts/runtime.ts"), "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(code, /Math\.random|Date\.now|performance\.now|setTimeout|setInterval|requestAnimationFrame|new Date/);
});
