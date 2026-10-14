// Phase 4 chunk 4 (D53) without the app: how text and backgrounds render (core render.ts, the one
// place for preview and export), in/out animations (core timeline.ts), the manual-edit note's
// words, and the Inspector/canvas planners (apps/web/src/preview/text.ts), whose results must pass the
// validator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { animationAt, applyEdit, createSession, describeOp, layout, loadModules, manualEditsNote, solidBackground, solidHtml, textHtml, validateProject, visualsAt, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { itemLabel, planAddText, TEXT_PRESETS } from "../../apps/web/src/state/project.ts";
import { planAddBackground, planAnimation, planBackground, planCentre, planPreset, planStyle, planText, planTransform, snapBox, swatches, textBox, toggleAccent } from "../../apps/web/src/preview/text.ts";

const modules = await loadModules("spec/modules/builtin");
const title: Item = { id: "title-1", type: "text", start: 0, duration: 90, text: "Title", transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } };
const empty: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: false } }],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [title] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    { id: "audio", kind: "audio", name: "Audio", items: [] },
  ],
};
const withFootage: Project = { ...empty, tracks: [empty.tracks[0]!, { ...empty.tracks[1]!, items: [{ id: "clip-1", type: "clip", media: "m", in: 0, duration: 300 }] }, empty.tracks[2]!] };

/** Apply a plan's ops and validate the result like the server does. */
function apply(project: Project, plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(project), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
}
const itemIn = (project: Project, id: string) => project.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;

test("textHtml: colour (theme token or CSS), alignment, box width, font and accent come out inline", () => {
  const theme = { colors: { fg: "#F4F3F0", accent: "#F5C26B", brand: "#123456" }, fonts: { sans: "Inter" } };
  const html = textHtml({ ...title, transform: { x: 72, y: 100, w: 1776 }, style: { ...title.style, color: "brand", align: "center" }, text: "a [[b]]" }, { canvas: empty.canvas, theme });
  assert.match(html, /width:92\.5%;/, "w is a share of the canvas width");
  assert.match(html, /color:#123456;/, "a theme token resolves to the project's colour");
  assert.match(html, /text-align:center;/);
  assert.match(html, /font-family:'Inter', -apple-system/, "the theme's sans font first, then the system stack");
  assert.match(html, /--accent:#F5C26B;/, "the accent colour travels with the text (export has no app CSS)");
  // Without a theme the defaults apply; a CSS colour passes through; a broken one falls back.
  assert.match(textHtml({ ...title, style: { color: "#FF0000" } }, empty), /color:#FF0000;/);
  assert.match(textHtml(title, empty), /color:#F2F1EE;/, "the title preset's fg without a theme");
  const evil = textHtml({ ...title, style: { color: 'red;background:url("x")' } }, empty);
  assert.match(evil, /color:#F2F1EE;/, "a colour that would escape the declaration is refused");
  assert.ok(!evil.includes("url("));
  // The mono-label preset uses the mono stack; markup for bold and mono.
  assert.match(textHtml({ ...title, style: { preset: "text.mono-label" }, text: "**x** `y`" }, empty), /font-family:'SF Mono'.*<b>x<\/b> <code>y<\/code>/);
  // Motion from an animation: offset and wipe.
  assert.match(textHtml(title, empty, { motion: { dy: 54, reveal: 0.5 } }), /transform:translate\(0cqw,5cqh\);clip-path:inset\(-20% 50% -20% -5%\)/);
});

test("component.solid: a colour or a gradient, theme tokens resolved", () => {
  const bg: Item = { id: "bg", type: "component", component: "component.solid", duration: 30, props: { color: "bg" } };
  assert.equal(solidBackground(bg, empty), "#0A0A0B");
  assert.equal(solidBackground({ ...bg, props: { color: "#0B1D3A", to: "#3B1E54", angle: 160 } }, empty), "linear-gradient(160deg, #0B1D3A, #3B1E54)");
  assert.equal(solidHtml(bg, empty, { opacity: 0.5 }), `<div class="pv-solid" data-item="bg" style="background:#0A0A0B;opacity:0.5"></div>`);
});

test("animations: fade in from 0 on the first frame, fade out to 0 on the last; rise moves up into place", () => {
  const faded: Item = { ...title, animation: { in: { module: "move.fade", duration: 10 }, out: { module: "move.fade", duration: 10 } } };
  const op = (f: number) => animationAt(faded, f, empty.canvas).opacity;
  assert.deepEqual([op(0), op(5), op(10), op(50), op(79), op(84), op(89)], [0, 0.5, 1, 1, 1, 0.5, 0]);
  const rise = animationAt({ ...title, animation: { in: { module: "move.rise", duration: 10 } } }, 0, empty.canvas);
  assert.equal(rise.opacity, 0);
  assert.ok(Math.abs(rise.motion.dy! - 1080 * 0.04) < 1e-9, "starts 4 % of the height lower");
  assert.deepEqual(animationAt({ ...title, animation: { in: { module: "move.rise", duration: 10 } } }, 10, empty.canvas).motion, {}, "in place after the animation");
  assert.equal(animationAt({ ...title, animation: { in: { module: "move.wipe", duration: 10 } } }, 0, empty.canvas).motion.reveal, 0);
  // Through visualsAt, as the preview and export see it.
  const project = { ...empty, tracks: [{ ...empty.tracks[0]!, items: [faded] }, ...empty.tracks.slice(1)] };
  const { starts } = layout(project);
  assert.deepEqual([0, 5, 85, 89, 90].map((f) => visualsAt(project, starts, f)[0]?.opacity), [0, 0.5, 0.4, 0, undefined]);
});

test("the manual-edit note says what changed on a text in words", () => {
  const words = (op: Op) => describeOp(op, empty);
  assert.equal(words({ op: "update_item", item: "title-1", set: { text: "Hello\nworld" } }), 'Changed the text of title-1 to "Hello / world"');
  assert.equal(words({ op: "update_item", item: "title-1", set: { style: { preset: "text.title", size: 96.4, weight: 700, color: "accent", align: "center" } } }), 'Restyled text "Title" (title-1): style text.title, size 96, weight 700, colour accent, aligned center');
  assert.equal(words({ op: "update_item", item: "title-1", set: { transform: { x: 72, y: 496, w: 1776 } } }), 'Moved text "Title" (title-1) on the canvas to x 72, y 496, box 1776 wide');
  assert.equal(words({ op: "update_item", item: "title-1", set: { animation: { in: { module: "move.fade", duration: 9 } } } }), 'Animated text "Title" (title-1): fade in 0.3s, no out animation');
  assert.equal(words({ op: "update_item", item: "title-1", set: { animation: null } }), 'Animated text "Title" (title-1): no in animation, no out animation');
  assert.equal(words({ op: "insert_item", track: "main", item: { id: "background-1", type: "component", component: "component.solid", duration: 90, props: { color: "#0B1D3A" } } }), "Added background background-1 (#0B1D3A) on track main");
  assert.equal(words({ op: "update_item", item: "title-1", set: { locked: true } }), 'Changed locked on text "Title" (title-1)');
  // In the note the agent gets.
  let s = createSession(empty);
  s = applyEdit(s, { actor: "user", ops: [{ op: "update_item", item: "title-1", set: { text: "Kraków" } }] });
  s = applyEdit(s, { actor: "user", ops: [{ op: "update_item", item: "title-1", set: { style: { preset: "text.title", size: 130, weight: 700, color: "#FF0000" } } }] });
  assert.match(manualEditsNote(s, 0), /Changed the text of title-1 to "Kraków"\n- Restyled text "Kraków" \(title-1\): style text\.title, size 130, weight 700, colour #FF0000/);
});

test("style planners keep the rest of the style; presets reset size, weight and the preset-only fields", () => {
  let p = apply(empty, planStyle(empty, "title-1", { color: "accent" }));
  assert.deepEqual(itemIn(p, "title-1").style, { preset: "text.title", size: 130, weight: 700, color: "accent" }, "update_item replaces style whole, so the plan sends all of it");
  p = apply(p, planStyle(p, "title-1", { size: 0.2, weight: 1234 }));
  assert.deepEqual(itemIn(p, "title-1").style, { preset: "text.title", size: 1, weight: 900, color: "accent" }, "clamped to the schema's limits");
  p = apply(p, planStyle(p, "title-1", { tracking: 0.1, font: "mono" }));
  p = apply(p, planPreset(p, "title-1", "text.lower-third"));
  assert.deepEqual(itemIn(p, "title-1").style, { preset: "text.lower-third", size: 54, weight: 600, color: "accent" }, "colour stays, font and tracking go");
  assert.deepEqual(planStyle(p, "title-1", { color: "accent" }), { ops: [], summary: "Restyle text" }, "no change, no edit");
  assert.deepEqual(planText(p, "title-1", "Title"), { ops: [], summary: "" });
  assert.deepEqual("problem" in planPreset(p, "title-1", "text.nope"), true);
});

test("position: transform merges, centre spans the safe area, w null fits the text", () => {
  let p = apply(empty, planTransform(empty, "title-1", { x: 300.4 }));
  assert.deepEqual(itemIn(p, "title-1").transform, { x: 300, y: 410 });
  p = apply(p, planCentre(p, "title-1"));
  assert.deepEqual(itemIn(p, "title-1").transform, { x: 72, y: 410, w: 1776 });
  assert.equal(itemIn(p, "title-1").style!.align, "center");
  p = apply(p, planTransform(p, "title-1", { w: null }));
  assert.deepEqual(itemIn(p, "title-1").transform, { x: 72, y: 410 });
  // A text item with no transform (the agent can write one) starts from its preset's spot.
  const bare = { ...empty, tracks: [{ ...empty.tracks[0]!, items: [{ id: "t", type: "text" as const, start: 0, duration: 30, text: "x", style: { preset: "text.header" } }] }, ...empty.tracks.slice(1)] };
  assert.deepEqual(textBox(itemIn(bare, "t"), bare), { x: 154, y: 497, w: undefined, size: 65, weight: 500, color: "fg", align: "left" });
  // Locked items refuse.
  const locked = { ...empty, tracks: [{ ...empty.tracks[0]!, locked: true }, ...empty.tracks.slice(1)] };
  assert.match((planTransform(locked, "title-1", { x: 1 }) as { problem: string }).problem, /locked/);
});

test("animations: set, clamp to the item, clear the last one removes animation", () => {
  let p = apply(empty, planAnimation(empty, "title-1", "in", { module: "move.fade", duration: 9 }));
  assert.deepEqual(itemIn(p, "title-1").animation, { in: { module: "move.fade", duration: 9 } });
  p = apply(p, planAnimation(p, "title-1", "out", { module: "move.rise", duration: 500 }));
  assert.deepEqual(itemIn(p, "title-1").animation!.out, { module: "move.rise", duration: 90 }, "no longer than the item");
  p = apply(p, planAnimation(p, "title-1", "in", null));
  p = apply(p, planAnimation(p, "title-1", "out", null));
  assert.equal(itemIn(p, "title-1").animation, undefined);
});

test("backgrounds: a title card on main, under the selected text, or on a free video track over footage", () => {
  // Empty main, the title selected: the background spans the title, on main.
  const card = planAddBackground(empty, { color: "#0B1D3A" }, 45, "title-1");
  let p = apply(empty, card);
  assert.deepEqual(itemIn(p, "background-1"), { id: "background-1", type: "component", component: "component.solid", duration: 90, props: { color: "#0B1D3A" } });
  assert.equal(p.tracks.find((t) => t.role === "main")!.items.length, 1);
  // Nothing selected, playhead at main's end: appended there, 3 s.
  p = apply(p, planAddBackground(p, { color: "bg" }, 90, undefined));
  assert.deepEqual(p.tracks.find((t) => t.role === "main")!.items.map((i) => [i.id, i.duration]), [["background-1", 90], ["background-2", 90]]);
  // Over footage at frame 60 (D146): the whole edit, on a new Background track right below main.
  const over = planAddBackground(withFootage, { color: "#000000", to: "#3B1E54", angle: 160 }, 60, undefined);
  p = apply(withFootage, over);
  assert.deepEqual(p.tracks.map((t) => t.id), ["text", "main", "background-track-1", "audio"]);
  assert.deepEqual(itemIn(p, "background-1"), { id: "background-1", type: "component", component: "component.solid", duration: 300, props: { color: "#000000", to: "#3B1E54", angle: 160 }, start: 0 });
  // In the preview's order it is drawn under the footage (and the text).
  const { starts } = layout(p);
  assert.deepEqual(visualsAt(p, starts, 70).map((v) => v.item.id), ["background-1", "clip-1", "title-1"]);
  // Again over the footage: that track is taken for the whole edit, so a second one below main.
  const again = planAddBackground(p, { color: "#FFFFFF" }, 200, undefined);
  p = apply(p, again);
  assert.deepEqual(p.tracks.map((t) => [t.id, t.name]), [["text", "Text"], ["main", "Main"], ["background-track-2", "Background 2"], ["background-track-1", "Background"], ["audio", "Audio"]]);
  assert.equal(itemIn(p, "background-2").start, 0);
  // Past the footage (frame 320 of a 300-frame edit): from there, 3 s, on the free track below main.
  const tail = apply(withFootage, planAddBackground(withFootage, { color: "#FFFFFF" }, 320, undefined));
  assert.deepEqual([itemIn(tail, "background-1").start, itemIn(tail, "background-1").duration], [320, 90]);
  // Colours: gradient on and off.
  p = apply(p, planBackground(p, "background-2", { to: "#3B1E54", angle: 90 }));
  assert.deepEqual(itemIn(p, "background-2").props, { color: "#FFFFFF", to: "#3B1E54", angle: 90 });
  p = apply(p, planBackground(p, "background-2", { to: null }));
  assert.deepEqual(itemIn(p, "background-2").props, { color: "#FFFFFF" });
});

test("canvas snapping: centre lines and safe margins within the threshold, guides to draw", () => {
  const box = { w: 400, h: 100 };
  assert.deepEqual(snapBox({ x: 755, y: 300, ...box }, empty, 10), { x: 760, y: 300, guides: [{ axis: "x", at: 960, kind: "centre" }] });
  assert.deepEqual(snapBox({ x: 66, y: 488, ...box }, empty, 10), { x: 72, y: 490, guides: [{ axis: "x", at: 72, kind: "margin" }, { axis: "y", at: 540, kind: "centre" }] });
  assert.deepEqual(snapBox({ x: 1450, y: 910, ...box }, empty, 10), { x: 1448, y: 908, guides: [{ axis: "x", at: 1848, kind: "margin" }, { axis: "y", at: 1008, kind: "margin" }] });
  assert.deepEqual(snapBox({ x: 500, y: 300, ...box }, empty, 10).guides, []);
});

test("accent toggles [[ ]] around the selection or the word at the caret", () => {
  assert.deepEqual(toggleAccent("make it pop", 5, 7), { text: "make [[it]] pop", from: 7, to: 9 });
  assert.deepEqual(toggleAccent("make [[it]] pop", 7, 9), { text: "make it pop", from: 5, to: 7 });
  assert.deepEqual(toggleAccent("make [[it]] pop", 5, 11), { text: "make it pop", from: 5, to: 7 });
  assert.deepEqual(toggleAccent("make it pop", 9, 9), { text: "make it [[pop]]", from: 10, to: 13 });
  assert.deepEqual(toggleAccent("", 0, 0), { text: "", from: 0, to: 0 });
});

test("swatches: the theme's tokens first, then plain colours it doesn't already have", () => {
  const values = swatches(empty).map((s) => s.value);
  assert.deepEqual(values.slice(0, 4), ["bg", "fg", "mute", "accent"]);
  assert.ok(values.includes("#0B1D3A"));
});

test("colours: only plain colour syntax gets into a style; images, variables and layers fall back", () => {
  const solid = (color: string): Item => ({ id: "bg", type: "component", component: "component.solid", duration: 30, props: { color } });
  for (const ok of ["#0B1D3A", "#fff", "#11223344", "rebeccapurple", "rgb(10, 20, 30)", "rgba(10,20,30,0.5)", "rgb(10 20 30 / 50%)", "hsl(210deg 50% 20%)", "hsla(210, 50%, 20%, 0.4)"]) {
    assert.equal(solidBackground(solid(ok), empty), ok, ok);
  }
  for (const bad of ['url("x.png")', "url(x.png)", "image-set(x.png 1x)", "var(--x)", "red, url(x)", "linear-gradient(red, blue)", "red;color:blue", "expression(alert(1))"]) {
    assert.equal(solidBackground(solid(bad), empty), "#0A0A0B", bad);
    assert.match(textHtml({ ...title, style: { color: bad } }, empty), /color:#F2F1EE;/, bad);
  }
  assert.equal(solidBackground({ ...solid("#000"), props: { color: "#000", to: "url(x)" } }, empty), "linear-gradient(180deg, #000, #000)", "a bad second colour falls back to the first");
});

test("animations don't fight a main-track transition: the transition blends, no dip to black", () => {
  const clip = (id: string, extra: Partial<Item> = {}): Item => ({ id, type: "clip", media: "m", in: 30, duration: 60, ...extra });
  const project: Project = {
    ...empty,
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [clip("a", { animation: { out: { module: "move.fade", duration: 10 } } }), clip("b", { transitionIn: { module: "transition.crossfade", duration: 10 }, animation: { in: { module: "move.fade", duration: 10 } } })] },
    ],
  };
  const { starts } = layout(project);
  // Frames 55–64 are the crossfade: a stays fully there (its fade-out is skipped at this cut), b fades in by the transition only.
  for (const f of [55, 58, 60, 63]) {
    const vs = visualsAt(project, starts, f);
    assert.equal(vs.find((v) => v.item.id === "a")?.opacity, 1, `a at ${f}`);
    assert.ok(Math.abs(vs.find((v) => v.item.id === "b")!.opacity - (f - 55) / 10) < 1e-9, `b at ${f}`);
  }
  // Outside the item's frames an animation holds its edge state instead of extrapolating.
  assert.equal(animationAt({ duration: 30, animation: { out: { module: "move.fade", duration: 10 } } }, 40, empty.canvas).opacity, 0);
  assert.equal(animationAt({ duration: 30, animation: { in: { module: "move.rise", duration: 10 } } }, -5, empty.canvas).opacity, 0);
});

test("backgrounds never land above main (D146); labels say what they are; text presets use core's looks", () => {
  const layered: Project = {
    ...withFootage,
    tracks: [{ id: "overlay", kind: "video", name: "Overlay", items: [] }, withFootage.tracks[0]!, withFootage.tracks[1]!, withFootage.tracks[2]!],
  };
  const p = apply(layered, planAddBackground(layered, { color: "#000000" }, 60, undefined));
  assert.deepEqual(p.tracks.map((t) => t.id), ["overlay", "text", "main", "background-track-1", "audio"], "a new track under main, not the free overlay above it");
  const { starts } = layout(p);
  assert.deepEqual(visualsAt(p, starts, 70).map((v) => v.item.id), ["background-1", "clip-1", "title-1"]);
  const bg = itemIn(p, "background-1");
  assert.equal(itemLabel(p, bg), "Background #000000");
  assert.equal(itemLabel(p, { ...bg, props: { color: "bg", to: "#3B1E54" } }), "Gradient bg → #3B1E54");
  assert.equal(itemLabel(p, { ...bg, name: "Intro card" }), "Intro card");
  const added = planAddText(empty, TEXT_PRESETS[0], 0) as unknown as { ops: Array<{ op: string; item?: Item }> };
  assert.deepEqual(added.ops.at(-1)!.item, { id: "title-2", type: "text", start: 0, duration: 90, text: "Title", transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } });
});
