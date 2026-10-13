// Phase 6 chunk 4 (D80, D81) without the app: text looks from the text-style manifests, the style →
// HTML/CSS mapping (stroke, shadow, box, case), the word-by-word and zoom moves per frame, inserting
// text in a look (Text tab and agent), the Style tab's planners, and old projects drawing as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  animationAt,
  lookProblems,
  textPlacement,
  applyEdit,
  createSession,
  describeOp,
  EASES,
  layout,
  LEGACY_LOOKS,
  loadModules,
  moveFades,
  planInsertText,
  TEXT_PRESETS,
  TEXT_STYLES,
  textHtml,
  validateModule,
  validateProject,
  visualsAt,
  withAlpha,
  wordCount,
  wordProgress,
  zoomScale,
  type Item,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";
import { planAddText } from "../../apps/web/src/state/project.ts";
import { planAnimation, planPreset, planResetLook, planShadow, planStroke, planTextBox, planTransform, textBox, textDecorOf } from "../../apps/web/src/preview/text.ts";
import { emptyProject } from "../../apps/server/src/project/projects.ts";
import { expandTextLooks, modulesList, SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";

const modules = await loadModules("spec/modules/builtin");
const canvas = { width: 1920, height: 1080, fps: 30 } as const;
const empty: Project = {
  format: "uncut/0",
  name: "Looks",
  canvas,
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
  ],
};
function apply(project: Project, plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(project), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
}
const itemIn = (project: Project, id: string) => project.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;
const text = (over: Partial<Item> = {}): Item => ({ id: "t", type: "text", start: 0, duration: 90, text: "One two three four", ...over }) as Item;
const style = (html: string) => /style="([^"]*)"/.exec(html)![1]!;

// textHtml before D80 for every built-in style, no preset, and the examples' text items (captured
// at 885d14a). The only change since: the soft shadow moved from RENDER_CSS onto the element.
const GOLDEN: Record<string, string> = {
  "style:text.title": "<div class=\"pv-text\" data-item=\"t\" style=\"left:8%;top:38%;width:max-content;max-width:92%;font-size:12cqh;font-weight:700;font-family:-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.02em;line-height:1.05;color:#F2F1EE;text-align:left;--accent:#99DAFF;--mono:'SF Mono', ui-monospace, Menlo, monospace;opacity:1\">Hello <span class=\"accent\">world</span> <b>bold</b> <code>x</code></div>",
  "style:text.header": "<div class=\"pv-text\" data-item=\"t\" style=\"left:8%;top:46%;width:max-content;max-width:92%;font-size:6cqh;font-weight:500;font-family:-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.02em;line-height:1.1;color:#F2F1EE;text-align:left;--accent:#99DAFF;--mono:'SF Mono', ui-monospace, Menlo, monospace;opacity:1\">Hello <span class=\"accent\">world</span> <b>bold</b> <code>x</code></div>",
  "style:text.lower-third": "<div class=\"pv-text\" data-item=\"t\" style=\"left:6.25%;top:80%;width:max-content;max-width:93.75%;font-size:5cqh;font-weight:600;font-family:-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.01em;line-height:1.1;color:#F2F1EE;text-align:left;--accent:#99DAFF;--mono:'SF Mono', ui-monospace, Menlo, monospace;opacity:1\">Hello <span class=\"accent\">world</span> <b>bold</b> <code>x</code></div>",
  "style:text.footnote": "<div class=\"pv-text\" data-item=\"t\" style=\"left:6.25%;top:90%;width:max-content;max-width:93.75%;font-size:3cqh;font-weight:400;font-family:-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:0em;line-height:1.25;color:#8C8C91;text-align:left;--accent:#99DAFF;--mono:'SF Mono', ui-monospace, Menlo, monospace;opacity:1\">Hello <span class=\"accent\">world</span> <b>bold</b> <code>x</code></div>",
  "style:text.mono-label": "<div class=\"pv-text\" data-item=\"t\" style=\"left:6.25%;top:10%;width:max-content;max-width:93.75%;font-size:3.5cqh;font-weight:500;font-family:'SF Mono', ui-monospace, Menlo, monospace;letter-spacing:0em;line-height:1.2;color:#F2F1EE;text-align:left;--accent:#99DAFF;--mono:'SF Mono', ui-monospace, Menlo, monospace;opacity:1\">Hello <span class=\"accent\">world</span> <b>bold</b> <code>x</code></div>",
  "style:text.captions": "<div class=\"pv-text\" data-item=\"t\" style=\"left:10%;top:78%;width:max-content;max-width:90%;font-size:5cqh;font-weight:600;font-family:-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.01em;line-height:1.15;color:#F2F1EE;text-align:center;--accent:#99DAFF;--mono:'SF Mono', ui-monospace, Menlo, monospace;opacity:1\">Hello <span class=\"accent\">world</span> <b>bold</b> <code>x</code></div>",
  "style:none": "<div class=\"pv-text\" data-item=\"t\" style=\"left:8%;top:42%;width:max-content;max-width:92%;font-size:8cqh;font-weight:600;font-family:-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.02em;line-height:1.05;color:#F2F1EE;text-align:left;--accent:#99DAFF;--mono:'SF Mono', ui-monospace, Menlo, monospace;opacity:1\">Hello <span class=\"accent\">world</span> <b>bold</b> <code>x</code></div>",
  "close-the-loop:txt-hook": "<div class=\"pv-text\" data-item=\"txt-hook\" style=\"left:6.6667%;top:38.5185%;width:max-content;max-width:93.3333%;font-size:7.1111cqh;font-weight:600;font-family:'DM Sans', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.02em;line-height:1.05;color:#F2F1EE;text-align:left;--accent:#99DAFF;--mono:'DM Mono', 'SF Mono', ui-monospace, Menlo, monospace;opacity:0.5;transform:translate(0cqw,0.7407cqh)\">Claude Code tests\nyour app now</div>",
  "close-the-loop:txt-taps": "<div class=\"pv-text\" data-item=\"txt-taps\" style=\"left:6.6667%;top:7.1111%;width:max-content;max-width:93.3333%;font-size:4.1481cqh;font-weight:600;font-family:'DM Sans', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.02em;line-height:1.1;color:#F2F1EE;text-align:left;--accent:#99DAFF;--mono:'DM Mono', 'SF Mono', ui-monospace, Menlo, monospace;opacity:0.5;transform:translate(0cqw,0.7407cqh)\">It taps through the login itself</div>",
  "close-the-loop:txt-result": "<div class=\"pv-text\" data-item=\"txt-result\" style=\"left:6.6667%;top:41.4815%;width:max-content;max-width:93.3333%;font-size:5.9259cqh;font-weight:600;font-family:'DM Sans', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.02em;line-height:1.05;color:#F2F1EE;text-align:left;--accent:#99DAFF;--mono:'DM Mono', 'SF Mono', ui-monospace, Menlo, monospace;opacity:0.5;transform:translate(0cqw,0.7407cqh)\">Found the bug\n<span class=\"accent\">Fixed it and tested again</span></div>",
  "drone-weekend:title-1": "<div class=\"pv-text\" data-item=\"title-1\" style=\"left:4.1667%;top:83.3333%;width:max-content;max-width:95.8333%;font-size:5.5556cqh;font-weight:600;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.01em;line-height:1.1;color:#F4F3F0;text-align:left;--accent:#F5C26B;--mono:'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;opacity:0.5;transform:translate(0cqw,0.463cqh)\">Intro</div>",
  "drone-weekend:title-2": "<div class=\"pv-text\" data-item=\"title-2\" style=\"left:4.1667%;top:83.3333%;width:max-content;max-width:95.8333%;font-size:5.5556cqh;font-weight:600;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.01em;line-height:1.1;color:#F4F3F0;text-align:left;--accent:#F5C26B;--mono:'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;opacity:0.5;transform:translate(0cqw,0.463cqh)\">Why a drone app</div>",
  "drone-weekend:title-3": "<div class=\"pv-text\" data-item=\"title-3\" style=\"left:4.1667%;top:83.3333%;width:max-content;max-width:95.8333%;font-size:5.5556cqh;font-weight:600;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.01em;line-height:1.1;color:#F4F3F0;text-align:left;--accent:#F5C26B;--mono:'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;opacity:0.5;transform:translate(0cqw,0.463cqh)\">Building it</div>",
  "drone-weekend:title-4": "<div class=\"pv-text\" data-item=\"title-4\" style=\"left:4.1667%;top:83.3333%;width:max-content;max-width:95.8333%;font-size:5.5556cqh;font-weight:600;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.01em;line-height:1.1;color:#F4F3F0;text-align:left;--accent:#F5C26B;--mono:'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;opacity:0.5;transform:translate(0cqw,0.463cqh)\">First flight</div>",
  "drone-weekend:title-5": "<div class=\"pv-text\" data-item=\"title-5\" style=\"left:4.1667%;top:83.3333%;width:max-content;max-width:95.8333%;font-size:5.5556cqh;font-weight:600;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Helvetica Neue', sans-serif;letter-spacing:-0.01em;line-height:1.1;color:#F4F3F0;text-align:left;--accent:#F5C26B;--mono:'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;opacity:0.5;transform:translate(0cqw,0.463cqh)\">What's next</div>"
};

test("old projects draw as before (D80): the six older looks and no-preset text keep the soft shadow, now inline", () => {
  const out: Record<string, string> = {};
  for (const id of [...LEGACY_LOOKS, undefined]) out[`style:${id ?? "none"}`] = textHtml(text({ text: "Hello [[world]] **bold** `x`", ...(id ? { style: { preset: id } } : {}) }), { canvas: { ...canvas, background: "#000" } });
  for (const ex of ["close-the-loop", "drone-weekend", "drone-montage"]) {
    const p = JSON.parse(readFileSync(`spec/examples/${ex}.uncut/project.json`, "utf8")) as Project;
    for (const t of p.tracks) for (const i of t.items) if (i.type === "text") out[`${ex}:${i.id}`] = textHtml(i, p, { opacity: 0.5, motion: { dy: 10 } });
  }
  assert.deepEqual(Object.keys(out).sort(), Object.keys(GOLDEN).sort());
  for (const [k, html] of Object.entries(GOLDEN)) assert.equal(out[k], html.replace(/opacity:([\d.]+)/, "opacity:$1;text-shadow:0 2px 18px rgb(0 0 0 / 45%)"), k);
  assert.deepEqual(LEGACY_LOOKS, ["text.title", "text.header", "text.lower-third", "text.footnote", "text.mono-label", "text.captions"]);
  // A new look has no shadow; an older one with shadow false has none either.
  assert.doesNotMatch(textHtml(text({ style: { preset: "text.big-title" } }), { canvas }), /text-shadow/);
  assert.doesNotMatch(textHtml(text({ style: { preset: "text.title", shadow: false } }), { canvas }), /text-shadow/);
});

test("looks come from the text-style manifests: every one validates, has a look, and a text in it is a valid project", () => {
  const manifests = readdirSync("spec/modules/builtin").filter((f) => f.startsWith("text.")).map((f) => JSON.parse(readFileSync(`spec/modules/builtin/${f}`, "utf8")));
  assert.deepEqual(Object.keys(TEXT_STYLES).sort(), manifests.map((m) => m.id).sort(), "TEXT_STYLES == the text-style manifests");
  assert.ok(manifests.length >= 14);
  for (const m of manifests) {
    assert.deepEqual(validateModule(m), [], m.id);
    assert.equal(m.kind, "text-style");
    const look = TEXT_STYLES[m.id]!;
    assert.equal(look.size, m.look.size);
    assert.equal(look.name, m.name);
    // No brand names or personal data; no · or * between words on screen.
    assert.doesNotMatch(look.text, /[·]|\s\*\s/, m.id);
    for (const w of look.with ?? []) assert.ok(TEXT_STYLES[w.look], `${m.id} comes with ${w.look}`);
    // A text in this look (moves, params and the looks it comes with) passes the validator.
    const next = apply(empty, planInsertText(empty, { look: m.id, start: 0, duration: 60 }));
    assert.equal(itemIn(next, next.tracks.flatMap((t) => t.items)[0]!.id).type, "text");
  }
  // A look with a bad block is refused by the module schema.
  assert.ok(validateModule({ ...manifests[0], look: { size: 0.1, weight: 700, x: 0, y: 0, stroke: { color: "red" } } }).length > 0, "stroke needs a width");
  assert.ok(validateModule({ ...manifests[0], look: { size: 0.1, weight: 700, x: 0, y: 0, glow: true } }).length > 0, "unknown look field");
  // The grid: the three older tiles first (same ids), then curated looks; ids unique.
  assert.deepEqual(TEXT_PRESETS.slice(0, 3).map((p) => [p.id, p.module]), [["title", "text.title"], ["text", "text.header"], ["lower-third", "text.lower-third"]]);
  assert.ok(TEXT_PRESETS.length >= 10 && TEXT_PRESETS.length <= 12);
  assert.equal(new Set(TEXT_PRESETS.map((p) => p.id)).size, TEXT_PRESETS.length);
  for (const p of TEXT_PRESETS) assert.ok(TEXT_STYLES[p.module], p.module);
});

test("style → CSS: stroke, shadow, box (box and per line), case; the look's in em, the item's in px, false removes", () => {
  const t = { canvas };
  const s1 = style(textHtml(text({ style: { size: 100, stroke: { width: 6, color: "#FF0000" } } }), t));
  assert.match(s1, /-webkit-text-stroke:6px #FF0000;paint-order:stroke fill/);
  const s2 = style(textHtml(text({ style: { size: 100, shadow: { x: 2, y: 4, blur: 10, color: "#000000", opacity: 0.5 } } }), t));
  assert.match(s2, /text-shadow:2px 4px 10px rgb\(0 0 0 \/ 50%\)/);
  const s3 = style(textHtml(text({ style: { size: 100, background: { color: "accent", opacity: 1, padding: 20, radius: 8 } } }), t));
  assert.match(s3, /background:#99DAFF;padding:10px 20px;border-radius:8px/);
  const lines = textHtml(text({ style: { size: 100, background: { color: "#000", opacity: 0.6, padding: 12, radius: 6, wrap: "lines" } } }), t);
  assert.doesNotMatch(style(lines), /background:/);
  assert.match(lines, /<span class="pv-line" style="background:rgb\(0 0 0 \/ 60%\);padding:6px 12px;border-radius:6px">One two three four<\/span><\/div>$/);
  assert.match(style(textHtml(text({ style: { uppercase: true } }), t)), /text-transform:uppercase/);
  // A look's stroke is in em: text.stroke-title's 0.08 em at its 119 px (0.11 × 1080) → 9.504 px.
  const stroked = style(textHtml(text({ style: { preset: "text.stroke-title" } }), t));
  assert.match(stroked, /-webkit-text-stroke:9.504px #000000/);
  assert.match(stroked, /width:92.5%/, "a span look fills the safe area when the item has no box");
  assert.match(style(textHtml(text({ style: { preset: "text.stroke-title", size: 200 } }), t)), /-webkit-text-stroke:16px/, "scales with the item's size");
  assert.doesNotMatch(style(textHtml(text({ style: { preset: "text.stroke-title", stroke: false } }), t)), /text-stroke/);
  assert.match(style(textHtml(text({ style: { preset: "text.boxed-label" } }), t)), /background:#99DAFF;padding:9.72px 19.44px;border-radius:9.504px/);
  assert.match(textHtml(text({ style: { preset: "text.caption" } }), t), /class="pv-line" style="background:rgb\(0 0 0 \/ 70%\)/);
  // Unsafe colours fall back (stroke black, box black).
  assert.match(style(textHtml(text({ style: { stroke: { width: 2, color: "red;x:url(a)" } } }), t)), /-webkit-text-stroke:2px #000000/);
  assert.equal(withAlpha("#abc", 0.5), "rgb(170 187 204 / 50%)");
  assert.equal(withAlpha("accent", 1), "accent");
  assert.equal(withAlpha("red", 0.25), "color-mix(in srgb, red 25%, transparent)");
  // The schema: false or a typed object.
  const bad = { ...empty, tracks: [{ ...empty.tracks[0]!, items: [text({ style: { stroke: { width: -1 } } })] }, empty.tracks[1]!] };
  assert.ok(validateProject(bad, modules).length > 0, "negative stroke refused");
  const off = { ...empty, tracks: [{ ...empty.tracks[0]!, items: [text({ style: { preset: "text.caption", stroke: false, shadow: false, background: false } })] }, empty.tracks[1]!] };
  assert.deepEqual(validateProject(off, modules), []);
});

test("word by word (D81): the visible word count per frame, per-word looks, out in order, markup kept", () => {
  assert.equal(wordCount("One two three four"), 4);
  assert.equal(wordCount("Make it [[stand out]]"), 4);
  assert.equal(wordCount("a**b** c\nd"), 3, "a word cut by a tag stays one word");
  const item = text({ duration: 60, animation: { in: { module: "move.word-by-word", duration: 20, params: { style: "fade" } } } });
  const visible = (f: number) => (animationAt(item, f, canvas).motion.words ?? [1, 1, 1, 1]).filter((w) => w > 0).length;
  // n = 4 words over 20 frames: word i starts at frame 5·i; visible at f = ceil(f·4/20), all from 20.
  assert.deepEqual([0, 1, 5, 6, 10, 11, 15, 16, 19, 20, 40].map(visible), [0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4]);
  for (let f = 0; f < 20; f++) assert.equal(visible(f), Math.min(4, Math.ceil((f * 4) / 20)), `frame ${f}`);
  assert.deepEqual(wordProgress(4, 0.5, false), [1, 1, 0, 0]);
  assert.deepEqual(wordProgress(4, 0.5, true), [0, 0, 1, 1], "out: the first words leave first");
  assert.equal(animationAt(item, 20, canvas).motion.words, undefined, "after the move: the plain text");
  const html = textHtml(item, { canvas }, { motion: animationAt(item, 7, canvas).motion });
  assert.match(html, /<span class="pv-w">One<\/span> <span class="pv-w" style="opacity:0.4">two<\/span> <span class="pv-w" style="opacity:0">three<\/span>/);
  // Accent markup survives around word spans; pop and rise are transforms.
  const pop = text({ text: "Make it [[stand out]]", animation: { in: { module: "move.word-by-word", duration: 8 } } });
  const popHtml = textHtml(pop, { canvas }, { motion: animationAt(pop, 3, canvas).motion });
  assert.match(popHtml, /<span class="accent"><span class="pv-w" style="opacity:0;transform:scale\(0.6\)">stand<\/span>/);
  const rise = text({ animation: { in: { module: "move.word-by-word", duration: 8, params: { style: "rise" } } } });
  assert.match(textHtml(rise, { canvas }, { motion: animationAt(rise, 1, canvas).motion }), /transform:translateY\([\d.]+em\)/);
  // It doesn't change the item's opacity; it isn't drawn on non-text items.
  assert.equal(animationAt(item, 3, canvas).opacity, 1);
  assert.equal(moveFades(item, item.animation!.in!), false);
  assert.equal(animationAt({ duration: 60, animation: item.animation }, 3, canvas).motion.words, undefined);
  // Params are checked against the manifest.
  const badParams = { ...empty, tracks: [{ ...empty.tracks[0]!, items: [text({ animation: { in: { module: "move.word-by-word", duration: 10, params: { style: "spin" } } } })] }, empty.tracks[1]!] };
  assert.ok(validateProject(badParams, modules).some((p) => p.code === "params"));
});

test("zoom move (D81): scale per frame with eases, in from params.scale and out to it, fading unless fade is false", () => {
  const item = text({ duration: 60, animation: { in: { module: "move.zoom", duration: 10, params: { scale: 0.5, ease: "linear" } }, out: { module: "move.zoom", duration: 10, params: { scale: 2, ease: "in", fade: false } } } });
  for (let f = 0; f < 10; f++) {
    const { motion, opacity } = animationAt(item, f, canvas);
    assert.ok(Math.abs((motion.scale ?? 1) - (0.5 + 0.5 * (f / 10))) < 1e-9, `in ${f}`);
    assert.ok(Math.abs(opacity - f / 10) < 1e-9);
  }
  assert.equal(animationAt(item, 30, canvas).motion.scale, undefined, "full size between the moves");
  for (const f of [50, 54, 59]) {
    const left = 59 - f;
    const { motion, opacity } = animationAt(item, f, canvas);
    assert.ok(Math.abs((motion.scale ?? 1) - (1 + 1 * EASES.in(1 - left / 10))) < 1e-9, `out ${f}`);
    assert.equal(opacity, 1, "fade false");
  }
  for (const ease of ["linear", "in", "out", "inOut"] as const) {
    assert.equal(zoomScale(0, false, { scale: 0.7, ease }), 0.7);
    assert.equal(zoomScale(1, false, { scale: 0.7, ease }), 1);
    assert.ok(Math.abs(zoomScale(0.5, false, { scale: 0.7, ease }) - (0.7 + 0.3 * EASES[ease](0.5))) < 1e-12);
  }
  assert.equal(zoomScale(0, false, undefined), 0.7, "the manifest's default scale");
  assert.equal(moveFades(item, item.animation!.in!), true);
  assert.equal(moveFades(item, item.animation!.out!), false);
  assert.match(style(textHtml(item, { canvas }, { motion: { dy: 10, scale: 0.75 } })), /transform:translate\(0cqw,0.9259cqh\) scale\(0.75\)/);
  // visualsAt carries it (preview and export read it from there).
  const p = { ...empty, tracks: [{ ...empty.tracks[0]!, items: [item] }, empty.tracks[1]!] };
  const v = visualsAt(p, layout(p).starts, 5).find((x) => x.item.id === "t")!;
  assert.equal(v.motion.scale, 0.75);
});

test("inserting text in a look (Text tab, agent): older tiles as before, a curated look with its moves, a kicker on its own track", () => {
  // The older Title tile: exactly the item it made before D80.
  const title = planAddText(empty, TEXT_PRESETS[0], 0);
  assert.ok("ops" in title);
  assert.deepEqual(title.ops, [{ op: "insert_item", track: "text", item: { id: "title-1", type: "text", start: 0, duration: 90, text: "Title", transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } } }]);
  // Big title: spans the safe area, zooms in (0.6 s = 18 frames).
  const big = planInsertText(empty, { look: "text.big-title", start: 30, duration: 90 });
  const next = apply(empty, big);
  assert.deepEqual(itemIn(next, "big-title-1"), { id: "big-title-1", type: "text", start: 30, duration: 90, text: "Your title", transform: { x: 72, y: 389, w: 1776 }, style: { preset: "text.big-title", size: 162, weight: 800 }, animation: { in: { module: "move.zoom", duration: 18, params: { scale: 0.85, ease: "out", fade: true } } } });
  // Kicker and title: two items, the kicker on a new text track on top, 0.065 × 1080 above.
  const kicker = planInsertText(next, { look: "text.kicker-title", start: 30, duration: 90 });
  const both = apply(next, kicker);
  assert.ok("itemIds" in kicker);
  assert.deepEqual(kicker.itemIds, ["kicker-title-1", "kicker-1"]);
  assert.equal(both.tracks.filter((t) => t.kind === "text").length, 3);
  assert.equal(itemIn(both, "kicker-1").transform!.y, itemIn(both, "kicker-title-1").transform!.y! - 70);
  assert.equal(itemIn(both, "kicker-1").transform!.x, itemIn(both, "kicker-title-1").transform!.x);
  assert.match((planInsertText(empty, { look: "text.nope", start: 0, duration: 9 }) as { problem: string }).problem, /no text look called text\.nope/);
  // The agent's insert_text: the same plan, with style over the look's.
  const expanded = expandTextLooks(empty, [{ op: "insert_text", look: "text.caption", text: "Hello there", start: 0, duration: 60, id: "cap-1", style: { stroke: { width: 3, color: "#000000" } } }]);
  assert.ok("ops" in expanded);
  const withCap = apply(empty, { ops: expanded.ops });
  assert.deepEqual(itemIn(withCap, "cap-1").style, { preset: "text.caption", size: 49, weight: 600, stroke: { width: 3, color: "#000000" } });
  assert.match((expandTextLooks(empty, [{ op: "insert_text", look: "text.caption", start: 0 }]) as { problem: string }).problem, /start and duration are required/);
  assert.match((expandTextLooks(empty, [{ op: "insert_text", look: "text.caption", start: 0, duration: 9, colour: "red" }]) as { problem: string }).problem, /unknown field colour/);
  // modules_list shows each look whole; the prompt documents insert_text and the moves.
  const listed = modulesList(modules, "text-style");
  const cap = listed.find((m) => m.id === "text.caption") as unknown as { look: { background: { wrap: string }; units: string }; showsInPreview: boolean };
  assert.equal(cap.look.background.wrap, "lines");
  assert.match(cap.look.units, /em of the font size/);
  assert.ok(cap.showsInPreview);
  assert.ok(modulesList(modules, "move").every((m) => m.showsInPreview), "every built-in move draws now");
  assert.match(SYSTEM_PROMPT, /"op":"insert_text","look":"text.big-title"/);
  assert.match(SYSTEM_PROMPT, /move\.word-by-word/);
  assert.match(SYSTEM_PROMPT, /move\.zoom/);
});

test("Style tab planners: outline, shadow, box, apply and reset to preset, move params; labels and the edit note", () => {
  let p = apply(empty, planInsertText(empty, { look: "text.title", start: 0, duration: 90, id: "t1" }));
  // What it draws now: the legacy shadow, no outline, no box.
  assert.deepEqual(textDecorOf(itemIn(p, "t1"), p).shadow, { x: 0, y: 2, blur: 18, color: "#000000", opacity: 0.45 });
  const stroke = planStroke(p, "t1", { width: 8 });
  assert.ok("ops" in stroke);
  assert.equal(stroke.summary, "Outline text: 8 px");
  p = apply(p, stroke);
  assert.deepEqual(itemIn(p, "t1").style!.stroke, { width: 8, color: "#000000" });
  p = apply(p, planStroke(p, "t1", { color: "accent" }));
  assert.deepEqual(itemIn(p, "t1").style!.stroke, { width: 8, color: "accent" });
  const noShadow = planShadow(p, "t1", false);
  assert.ok("ops" in noShadow && noShadow.summary === "Remove text shadow");
  p = apply(p, noShadow);
  assert.equal(itemIn(p, "t1").style!.shadow, false);
  assert.doesNotMatch(textHtml(itemIn(p, "t1"), { canvas }), /text-shadow/);
  const shadow = planShadow(p, "t1", { blur: 30, opacity: 1.7 });
  assert.ok("ops" in shadow && shadow.summary === "Add text shadow");
  p = apply(p, shadow);
  assert.deepEqual(itemIn(p, "t1").style!.shadow, { x: 0, y: 4, blur: 30, color: "#000000", opacity: 1 });
  const box = planTextBox(p, "t1", { wrap: "lines", padding: -5 });
  assert.ok("ops" in box && box.summary === "Put text on a box per line");
  p = apply(p, box);
  assert.deepEqual(itemIn(p, "t1").style!.background, { color: "#000000", opacity: 0.7, padding: 0, radius: 23, wrap: "lines" });
  // describeOp words it (history and the agent's note).
  const op = (stroke.ops[0] as Op);
  assert.match(describeOp(op, p), /outline 8 px #000000/);
  // Apply a look: its outline/shadow/box show (the item's own go); colour and position stay.
  const applied = planPreset(p, "t1", "text.stroke-title");
  assert.ok("ops" in applied);
  p = apply(p, applied);
  assert.deepEqual(itemIn(p, "t1").style, { preset: "text.stroke-title", size: 119, weight: 800 });
  assert.match(textHtml(itemIn(p, "t1"), { canvas }), /-webkit-text-stroke:9.52px #000000/, "0.08 em of its 119 px");
  // Reset to preset: style and position the look's again.
  p = apply(p, planStroke(p, "t1", false));
  p = apply(p, { ops: [{ op: "update_item", item: "t1", set: { transform: { x: 500, y: 500 }, style: { ...itemIn(p, "t1").style, color: "#F5C26B" } } }] });
  const reset = planResetLook(p, "t1");
  assert.ok("ops" in reset && reset.summary === "Reset text to Stroked title");
  p = apply(p, reset);
  assert.deepEqual(itemIn(p, "t1").style, { preset: "text.stroke-title", size: 119, weight: 800 });
  assert.deepEqual(itemIn(p, "t1").transform, { x: 72, y: 432, w: 1776 });
  assert.deepEqual((planResetLook(p, "t1") as unknown as { ops: unknown[] }).ops, [], "nothing to reset");
  // A move with params.
  const anim = planAnimation(p, "t1", "in", { module: "move.word-by-word", duration: 24, params: { style: "rise" } });
  assert.ok("ops" in anim && anim.summary === "Animate text: word by word in");
  p = apply(p, anim);
  assert.deepEqual(itemIn(p, "t1").animation, { in: { module: "move.word-by-word", duration: 24, params: { style: "rise" } } });
  assert.match(describeOp((anim.ops[0] as Op), p), /word by word in 0.8s/);
});

test("review (D80): textBox and planTransform use the drawn box (look width, a span's safe area under a theme margin), so moving a preset-only text doesn't reflow it", () => {
  const themed: Project = { ...empty, theme: { margin: 100 } };
  for (const preset of ["text.quote", "text.big-title", "text.title"]) {
    const it = text({ style: { preset } });
    const at = textPlacement(it, themed);
    const box = textBox(it, themed);
    assert.deepEqual([box.x, box.y, box.w], [Math.round(at.x), Math.round(at.y), at.w === undefined ? undefined : Math.round(at.w)], preset);
    const css = style(textHtml(it, themed));
    assert.match(css, new RegExp(`left:${String(Math.round((at.x / 1920) * 1e6) / 1e4).replace(".", "\\.")}%`), preset);
  }
  assert.deepEqual([textBox(text({ style: { preset: "text.big-title" } }), themed).x, textBox(text({ style: { preset: "text.big-title" } }), themed).w], [100, 1720], "span: theme margin");
  assert.equal(textBox(text({ style: { preset: "text.quote" } }), themed).w, Math.round(1920 * 0.76));
  // A preset-only quote moved by drag / X field: its drawn width goes with the position.
  const p = { ...themed, tracks: [{ ...themed.tracks[0]!, items: [text({ style: { preset: "text.quote" } })] }, themed.tracks[1]!] };
  const moved = apply(p, planTransform(p, "t", { x: 300 }));
  assert.deepEqual(itemIn(moved, "t").transform, { x: 300, y: Math.round(1080 * 0.38), w: 1459 });
  assert.match(style(textHtml(itemIn(moved, "t"), moved)), /width:75\.9896%/, "still 76 % wide");
  const span = { ...themed, tracks: [{ ...themed.tracks[0]!, items: [text({ style: { preset: "text.big-title" } })] }, themed.tracks[1]!] };
  assert.deepEqual(itemIn(apply(span, planTransform(span, "t", { y: 500 })), "t").transform, { x: 100, y: 500, w: 1720 }, "a span look keeps its box");
});

test("review (D80): ids — a requested id is reserved before new tracks and refused when taken; the Text tile numbers text-1; hidden tracks are skipped; animation null reaches the kicker", () => {
  const noText: Project = { ...empty, tracks: [empty.tracks[1]!] };
  const plan = planInsertText(noText, { look: "text.title", start: 0, duration: 30, id: "text-1" });
  const next = apply(noText, plan);
  assert.ok(itemIn(next, "text-1"));
  assert.notEqual(next.tracks[0]!.id, "text-1");
  assert.match((planInsertText(next, { look: "text.title", start: 60, duration: 30, id: "text-1" }) as { problem: string }).problem, /"text-1" is already used/);
  const tile = planAddText(empty, TEXT_PRESETS[1], 0) as unknown as { ops: Array<{ item?: Item }> };
  assert.equal(tile.ops.at(-1)!.item!.id, "text-1", "the Text tile keeps its id base");
  const hidden: Project = { ...empty, tracks: [{ ...empty.tracks[0]!, hidden: true }, empty.tracks[1]!] };
  const onHidden = planInsertText(hidden, { look: "text.title", start: 0, duration: 30 }) as { ops: Array<{ op: string; track?: string | { id: string } }> };
  assert.equal(onHidden.ops[0]!.op, "add_track", "a hidden track isn't used");
  const still = apply(empty, planInsertText(empty, { look: "text.kicker-title", start: 0, duration: 60, animation: null }));
  assert.ok(still.tracks.flatMap((t) => t.items).every((i) => i.animation === undefined), "no moves on the title or its kicker");
});

test("review (D80): the textLooks marker — new projects draw no default shadow on any path; old ones keep it", () => {
  const fresh = emptyProject("New", { width: 1920, height: 1080, fps: 30 });
  assert.equal(fresh.textLooks, 1);
  assert.deepEqual(validateProject(fresh, modules), []);
  const title = text({ style: { preset: "text.title" } });
  assert.match(textHtml(title, empty), /text-shadow:0 2px 18px/, "old project: as before");
  assert.doesNotMatch(textHtml(title, fresh), /text-shadow/, "new project: none");
  assert.doesNotMatch(textHtml(text(), fresh), /text-shadow/, "no preset: none");
  assert.equal(textDecorOf(title, fresh).shadow, undefined, "the Inspector shows none");
  assert.match(textHtml(text({ style: { preset: "text.title", shadow: { y: 3, blur: 6 } } }), fresh), /text-shadow:0px 3px 6px/, "a set shadow still draws");
  // Inserting, applying an older preset and resetting in a new project: still no shadow.
  let p = apply(fresh, planInsertText(fresh, { look: "text.title", start: 0, duration: 30, id: "t1" }));
  assert.doesNotMatch(textHtml(itemIn(p, "t1"), p), /text-shadow/);
  p = apply(p, planPreset(p, "t1", "text.lower-third"));
  p = apply(p, planResetLook(p, "t1"));
  assert.doesNotMatch(textHtml(itemIn(p, "t1"), p), /text-shadow/);
  assert.ok(validateProject({ ...fresh, textLooks: 2 }, modules).length > 0, "only 1");
});

test("review (D80/D81): lenient open — empty or extra-keyed style objects and unknown move params still validate; empties count as absent", () => {
  const items = [
    text({ id: "a", style: { preset: "text.stroke-title", stroke: {} as never, shadow: {}, background: { glow: true } as never } }),
    text({ id: "b", start: 100, style: { shadow: { blur: 4, spread: 2 } as never }, animation: { in: { module: "move.zoom", duration: 10, params: { scale: 0.5, bounce: true } } } }),
  ];
  const p: Project = { ...empty, tracks: [{ ...empty.tracks[0]!, items }, empty.tracks[1]!] };
  assert.deepEqual(validateProject(p, modules), []);
  const a = style(textHtml(items[0]!, p));
  assert.match(a, /-webkit-text-stroke:9\.504px/, "stroke {} = the look's");
  assert.doesNotMatch(a, /background:/, "a box without a colour isn't drawn");
  assert.doesNotMatch(a, /text-shadow/, "shadow {} = absent (new look: none)");
  assert.match(style(textHtml(items[1]!, p)), /text-shadow:0px 0px 4px/);
  const bad: Project = { ...p, tracks: [{ ...p.tracks[0]!, items: [text({ animation: { in: { module: "move.zoom", duration: 10, params: { scale: "big" } } } })] }, p.tracks[1]!] };
  assert.ok(validateProject(bad, modules).some((x) => x.code === "params"), "known params are still typed");
});

test("review (D81): word by word on a boxed text leaves the words out until they arrive, so the box grows", () => {
  const cap = text({ text: "One two three", style: { preset: "text.caption" }, animation: { in: { module: "move.word-by-word", duration: 12, params: { style: "fade" } } } });
  const at = (f: number) => textHtml(cap, { canvas }, { motion: animationAt(cap, f, canvas).motion });
  assert.match(at(5), /<span class="pv-line"[^>]*><span class="pv-w">One<\/span> <span class="pv-w" style="opacity:0.25">two<\/span><\/span>/, "three isn't there yet, nor the space before it");
  assert.doesNotMatch(at(0), /pv-w/, "nothing on the first frame");
  assert.match(at(12), />One two three<\/span>/, "after the move: the plain text");
  const plain = text({ text: "One two three", animation: cap.animation });
  assert.equal((textHtml(plain, { canvas }, { motion: animationAt(plain, 5, canvas).motion }).match(/pv-w/g) ?? []).length, 3, "without a box every word keeps its place");
});

test("review (D80): looks — only text styles take one, fonts are the bundled ones, moves and companions exist and validate", () => {
  assert.deepEqual(lookProblems(modules), []);
  const title = JSON.parse(readFileSync("spec/modules/builtin/text.title.json", "utf8"));
  const solid = JSON.parse(readFileSync("spec/modules/builtin/component.solid.json", "utf8"));
  assert.ok(validateModule({ ...solid, look: title.look }).length > 0, "a component can't have a look");
  assert.ok(validateModule({ ...title, look: { ...title.look, font: "Comic Sans" } }).length > 0, "font enum");
  const broken = new Map(modules);
  broken.set("text.title", { ...title, look: { ...title.look, animation: { in: { module: "transition.wipe", seconds: 1 }, out: { module: "move.zoom", seconds: 1, params: { scale: -1 } } }, with: [{ look: "text.nope", text: "x" }] } });
  const problems = lookProblems(broken).map((x) => x.message);
  assert.equal(problems.length, 3, problems.join(" | "));
  assert.match(problems.join(" | "), /transition\.wipe" is a transition, expected move.*move\.zoom: must be > 0.*text style "text\.nope" is not installed/);
});
