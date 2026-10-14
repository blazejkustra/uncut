// Fable QA round 2, the Text chunk (F21, F22, F24; D163–D166) without the app: the new text moves
// and loops per frame from core, the Out names, moveFades in step with animationAt's opacity,
// stickers and their search, the image frame's fit and crop, caption styles and the karaoke fill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { animationAt, applyEdit, captionAt, captionCards, createSession, DRAWN_MOVES, loadModules, moveFades, planMakeCaptions, textHtml, validateProject, type CutTranscript, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { charCount, cutChars } from "../../packages/core/src/visual/render.ts";
import { bounceOut } from "../../packages/core/src/timeline/timeline.ts";
import { CAPTION_STYLES, captionStyleFields, captionStyleSample, planCaptionHighlight, planCaptionStyle } from "../../packages/core/src/text/captions.ts";
import { searchStickers, STICKER_ART, STICKER_ART_IDS, STICKERS, stickerProps } from "../../packages/core/src/visual/stickers.ts";
import { drawImageFrame, drawSticker, imageFrameCrop, imageFrameRect } from "../../packages/core/src/visual/elements.ts";
import { componentHtml } from "../../packages/core/src/visual/components.ts";
import { describeOp } from "../../packages/core/src/index.ts";
import { LOOPS, MOVES, moveLabel, planAnimation } from "../../apps/web/src/preview/text.ts";
import { planAddComponent } from "../../apps/web/src/preview/components.ts";

const modules = await loadModules("spec/modules/builtin");
const canvas = { width: 1920, height: 1080, fps: 30 } as const;
const text = (extra: Partial<Item> = {}): Item => ({ id: "t1", type: "text", start: 0, duration: 60, text: "Hello world", style: { preset: "text.title" }, ...extra });
const at = (item: Item, local: number) => animationAt(item, local, canvas);
const project = (items: ReadonlyArray<Item>): Project => ({
  format: "uncut/0",
  name: "T",
  canvas,
  textLooks: 1,
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 90, props: { color: "#000000" } }] },
  ],
});

test("F21: the In list has the new moves, the Out list their out names, and Loop pulse and wiggle", () => {
  const ins = MOVES.map((m) => (m.id ? moveLabel(m.id, "in") : m.label));
  const outs = MOVES.map((m) => (m.id ? moveLabel(m.id, "out") : m.label));
  for (const name of ["Typewriter", "Bounce", "Blur in", "Scale in", "Pop"]) assert.ok(ins.includes(name), name);
  for (const name of ["Erase", "Bounce out", "Blur out", "Scale out", "Pop out"]) assert.ok(outs.includes(name), name);
  assert.ok(!outs.includes("Typewriter") && !outs.includes("Blur in"));
  assert.deepEqual(LOOPS.map((l) => l.label), ["None", "Pulse", "Wiggle"]);
  // Every listed move is a drawn, installed move module.
  for (const m of [...MOVES, ...LOOPS].filter((m) => m.id)) {
    assert.ok((DRAWN_MOVES as ReadonlyArray<string>).includes(m.id), m.id);
    assert.equal(modules.get(m.id)?.kind, "move", m.id);
  }
});

test("F21: typewriter shows floor(p·n) characters; Erase takes them from the end; a box leaves them out", () => {
  const item = text({ animation: { in: { module: "move.typewriter", duration: 10 }, out: { module: "move.typewriter", duration: 10 } } });
  const n = charCount("Hello world");
  assert.equal(n, 11);
  assert.equal(at(item, 0).motion.chars, 0);
  assert.equal(at(item, 5).motion.chars, Math.floor(0.5 * n));
  assert.equal(at(item, 10).motion.chars, undefined, "all there after the move");
  assert.equal(at(item, 59).motion.chars, 0, "erased on the last frame");
  assert.equal(at(item, 54).motion.chars, Math.floor((5 / 10) * n));
  assert.equal(at(item, 5).opacity, 1, "no fade");
  // HTML: the rest is invisible in place; markup tags and entities count right.
  assert.equal(cutChars("Hel<b>lo</b> w", 4), 'Hel<b>l<span style="opacity:0">o</span></b><span style="opacity:0"> w</span>');
  assert.equal(cutChars("a &amp; b", 3), 'a &amp;<span style="opacity:0"> b</span>');
  assert.equal(cutChars("abc", 1, true), "a");
  const html = textHtml(item, { canvas }, { motion: at(item, 5).motion });
  assert.match(html, />Hello<span style="opacity:0"> world<\/span><\/div>$/);
  const boxed = text({ style: { preset: "text.title", background: { color: "#000000", padding: 10 } }, animation: item.animation! });
  assert.match(textHtml(boxed, { canvas }, { motion: at(boxed, 5).motion }), />Hello<\/div>$/);
});

test("F21: bounce, blur in, scale in and pop per frame", () => {
  const anim = (module: string) => text({ animation: { in: { module, duration: 10 }, out: { module, duration: 10 } } });
  // Bounce: from 8 % of the height above, bouncing in (bounceOut), fading linearly.
  const b = anim("move.bounce");
  assert.equal(at(b, 0).motion.dy, -0.08 * 1080);
  assert.ok(Math.abs(at(b, 3).motion.dy! + (1 - bounceOut(0.3)) * 0.08 * 1080) < 1e-9);
  assert.equal(at(b, 3).opacity, 0.3);
  assert.equal(at(b, 10).motion.dy, undefined);
  // Blur in: 2.5 cqh → 0 (ease out), fading; drawn as a filter in cqh.
  const bl = anim("move.blur");
  assert.equal(at(bl, 0).motion.blur, 2.5);
  assert.equal(at(bl, 5).motion.blur, Math.round((1 - (1 - 0.5 ** 3)) * 2.5 * 1000) / 1000);
  assert.match(textHtml(bl, { canvas }, { motion: at(bl, 5).motion }), /filter:blur\(0\.313cqh\)/);
  assert.equal(at(bl, 59).motion.blur, 2.5, "blur out ends fully blurred");
  // Scale in: 0 → 1 (ease out), no fade.
  const sc = anim("move.scale");
  assert.equal(at(sc, 0).motion.scale, 0);
  assert.equal(at(sc, 5).motion.scale, 1 - 0.5 ** 3);
  assert.equal(at(sc, 5).opacity, 1);
  // Pop: 0.4 → 1 with an overshoot past 1, its quick fade in the HTML (motion.fade), not the opacity.
  const pop = anim("move.pop");
  assert.ok(Math.abs(at(pop, 0).motion.scale! - 0.4) < 1e-9);
  assert.ok(Math.max(...[5, 6, 7, 8, 9].map((f) => at(pop, f).motion.scale ?? 1)) > 1, "overshoots");
  assert.ok(Math.abs(at(pop, 1).motion.fade! - 0.3) < 1e-9);
  assert.equal(at(pop, 1).opacity, 1);
  assert.match(textHtml(pop, { canvas }, { motion: at(pop, 1).motion }), /opacity:0\.3[;"]/);
  // On a component they don't move it (text only).
  const comp: Item = { id: "c", type: "component", component: "component.sticker", duration: 60, animation: { in: { module: "move.pop", duration: 10 } } };
  assert.deepEqual(at(comp, 2), { opacity: 1, motion: {} });
});

test("F21: moveFades is true exactly when animationAt fades the text (the export's ramps match the preview)", () => {
  for (const module of DRAWN_MOVES) {
    for (const slot of ["in", "out"] as const) {
      if (module === "move.pulse" || module === "move.wiggle") continue;
      const item = text({ animation: { [slot]: { module, duration: 10 } } });
      const mid = slot === "in" ? 4 : 55;
      const fades = at(item, mid).opacity < 1;
      assert.equal(moveFades(item, item.animation![slot]!), fades, `${module} ${slot}`);
      // and linearly: opacity = p where it fades
      if (fades) assert.ok(Math.abs(at(item, mid).opacity - (slot === "in" ? 0.4 : (59 - mid) / 10)) < 1e-9, `${module} ${slot} linear`);
    }
  }
});

test("F21: loops repeat every loop length; equal phases draw equal HTML; no opacity change", () => {
  const pulse = text({ duration: 90, animation: { loop: { module: "move.pulse", duration: 30 } } });
  assert.equal(at(pulse, 0).motion.scale, undefined);
  assert.ok(Math.abs(at(pulse, 15).motion.scale! - 1.08) < 1e-12, "the top of a pulse: +8 %");
  assert.equal(at(pulse, 15).opacity, 1);
  assert.equal(textHtml(pulse, { canvas }, { motion: at(pulse, 7).motion }), textHtml(pulse, { canvas }, { motion: at(pulse, 37).motion }));
  const wiggle = text({ duration: 90, animation: { loop: { module: "move.wiggle", duration: 20, params: { amount: 6 } } }, transform: { x: 100, y: 100, rotate: 10 } });
  assert.equal(at(wiggle, 5).motion.rotate, 6);
  assert.equal(at(wiggle, 15).motion.rotate, -6);
  assert.match(textHtml(wiggle, { canvas }, { motion: at(wiggle, 5).motion }), /rotate\(16deg\)/);
  // In + loop together: the in's scale times the loop's.
  const both = text({ duration: 90, animation: { in: { module: "move.scale", duration: 10 }, loop: { module: "move.pulse", duration: 20 } } });
  assert.ok(Math.abs(at(both, 5).motion.scale! - (1 - 0.5 ** 3) * (1 + 0.08 * (1 - Math.cos(Math.PI / 2)) / 2)) < 1e-12);
  // Valid in a project; the Inspector planner and the edit log name them.
  const p = project([pulse]);
  assert.deepEqual(validateProject(p, modules), []);
  const plan = planAnimation(p as never, "t1", "loop", { module: "move.wiggle", duration: 15 });
  assert.ok("ops" in plan);
  assert.equal(plan.summary, "Animate text: wiggle loop");
  assert.match(describeOp(plan.ops[0]!, p), /wiggle loop every 0\.5s/);
  const out = planAnimation(p as never, "t1", "out", { module: "move.typewriter", duration: 15 });
  assert.ok("ops" in out && out.summary === "Animate text: erase");
  // Bad params are refused against the manifest.
  assert.ok(validateProject(project([text({ animation: { loop: { module: "move.pulse", duration: 30, params: { amount: 5 } } } })]), modules).length > 0);
});

test("F22: stickers: the bundled set, search by name, keyword or the emoji, drawn art", () => {
  assert.ok(STICKERS.length >= 120);
  assert.deepEqual(STICKER_ART_IDS, (modules.get("component.sticker")!.params as { properties: { art: { enum: Array<string> } } }).properties.art.enum);
  assert.equal(searchStickers("fire")[0]!.emoji, "🔥");
  assert.equal(searchStickers("lol")[0]!.emoji, "😂", "a keyword");
  assert.equal(searchStickers("🚀")[0]!.emoji, "🚀");
  assert.equal(searchStickers("thumbs up")[0]!.emoji, "👍", "every word must match");
  assert.equal(searchStickers("wow")[0]!.art, "burst", "a name match first");
  assert.deepEqual(searchStickers("zzqx"), []);
  assert.equal(searchStickers("").length, STICKERS.length);
  // Drawn: the SVG inside the sticker box, with pop and tilt; an emoji as before.
  const target = { canvas };
  const draw = (props: Record<string, unknown>) => drawSticker({ props, w: 300, h: 300, local: 30, fps: 30, target } as never);
  assert.match(draw({ art: "heart", tilt: 0 }), /data-art="heart"[^>]*><svg/);
  assert.ok(draw({ art: "heart" }).includes(STICKER_ART.heart!.svg));
  assert.match(draw({ emoji: "🚀" }), /🚀/);
  // Added from the set: one component with the emoji (or the art and its name), valid.
  const p = project([]);
  const add = planAddComponent(p as never, "component.sticker", 0, { props: stickerProps(searchStickers("rocket")[0]!) });
  assert.ok(!("problem" in add));
  const item = (add.ops as ReadonlyArray<Op>).flatMap((o) => (o.op === "insert_item" ? [o.item as Item] : []))[0]!;
  assert.equal(item.props!.emoji, "🚀");
  assert.equal(add.summary, "Add sticker 🚀");
  const art = planAddComponent(p as never, "component.sticker", 0, { props: stickerProps(searchStickers("check")[0]!) });
  assert.ok(!("problem" in art));
  const artItem = (art.ops as ReadonlyArray<Op>).flatMap((o) => (o.op === "insert_item" ? [o.item as Item] : []))[0]!;
  assert.equal(artItem.props!.art, "check");
  assert.equal(artItem.name, "Check");
  const made = applyEdit(createSession(p), { actor: "user", ops: [...(add.ops as ReadonlyArray<Op>)] }).project;
  assert.deepEqual(validateProject(made, modules), []);
});

test("F22: image frame fit and crop: cover fills, contain shows it all, zoom and focus crop", () => {
  const frame = { w: 800, h: 500 };
  const img = { width: 1000, height: 1000 };
  assert.deepEqual(imageFrameRect({ fit: "cover" }, frame, img), { x: 0, y: -150, w: 800, h: 800 });
  assert.deepEqual(imageFrameRect({ fit: "contain" }, frame, img), { x: 150, y: 0, w: 500, h: 500 });
  // Focus at the top: the top of the picture shows; zoom 2 about the top-left focus.
  assert.deepEqual(imageFrameRect({ fit: "cover", focusY: 0 }, frame, img), { x: 0, y: 0, w: 800, h: 800 });
  assert.deepEqual(imageFrameRect({ fit: "cover", zoom: 2, focusX: 0, focusY: 0 }, frame, img), { x: 0, y: 0, w: 1600, h: 1600 });
  assert.deepEqual(imageFrameCrop({ zoom: 9, focusX: -5 }), { fit: "cover", zoom: 4, focusX: 0, focusY: 50 });
  // HTML: unchanged without a crop; object-position and a scale about the focus with one.
  const target = { canvas, mediaUrl: (id: string) => `uncut-media://${id}` };
  const plain = drawImageFrame({ props: { fit: "contain", image: { media: "m-img" } }, w: 800, h: 500, local: 0, fps: 30, target } as never);
  assert.match(plain, /object-fit:contain">/);
  const crop = drawImageFrame({ props: { fit: "cover", zoom: 1.5, focusX: 20, focusY: 80, image: { media: "m-img" } }, w: 800, h: 500, local: 0, fps: 30, target } as never);
  assert.match(crop, /object-fit:cover;object-position:20% 80%;transform:scale\(1\.5\);transform-origin:20% 80%">/);
  // The defaults (zoom 1, focus 50 %) draw as before the crop existed.
  const item: Item = { id: "f", type: "component", component: "component.image-frame", duration: 30, props: { fit: "cover", zoom: 1, focusX: 50, focusY: 50, radius: 24 } };
  assert.doesNotMatch(componentHtml(item, { canvas } as never, 0, { fps: 30 })!, /object-position|scale\(/);
  const withFrame = project([]);
  const valid = { ...withFrame, tracks: [{ id: "over", kind: "video" as const, name: "Overlay", items: [{ ...item, start: 0 }] }, ...withFrame.tracks] };
  assert.deepEqual(validateProject(valid, modules), []);
});

// ---- captions ----

const WORDS = [
  { text: "One", start: 0.5, end: 0.9 },
  { text: "two", start: 1.0, end: 1.4 },
  { text: "three", start: 1.5, end: 1.9 },
  { text: "four", start: 2.0, end: 2.4 },
];
const T: CutTranscript = { words: WORDS, language: "en", seconds: 3 };
function captioned(captionStyle?: string, mode?: "line" | "word"): Project {
  const p: Project = {
    format: "uncut/0",
    name: "C",
    canvas,
    textLooks: 1,
    media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path: "/tmp/Talk.mp4", probe: { frames: 90, fps: 30, width: 1920, height: 1080, hasAudio: true } }],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 90 }] }],
  };
  const made = planMakeCaptions(p, { media: "m-talk", transcript: T, ...(mode ? { mode } : {}), ...(captionStyle ? { captionStyle } : {}) });
  assert.ok(!("problem" in made), "problem" in made ? made.problem : "");
  return applyEdit(createSession(p), { actor: "user", ops: made.ops }).project;
}
const opsOf = (plan: { readonly ops: ReadonlyArray<Op> } | { readonly problem: string }) => {
  assert.ok("ops" in plan, "problem" in plan ? plan.problem : "");
  return plan.ops;
};
const capOf = (p: Project) => p.tracks.flatMap((t) => t.items).find((i) => i.type === "captions")!;

test("F24: caption styles: 8 presets, each a whole style (canvas px) with its id; applying sets the mode", () => {
  assert.equal(CAPTION_STYLES.length, 8);
  assert.deepEqual(CAPTION_STYLES.map((s) => s.name), ["Box", "Outline", "Karaoke", "Highlight", "Word box", "Big yellow", "Minimal", "Card"]);
  assert.deepEqual(captionStyleFields("big-yellow", canvas), { preset: "text.caption", size: 92, weight: 900, uppercase: true, color: "#FFE14D", stroke: { width: 8.6, color: "#000000" }, shadow: false, background: false, captionStyle: "big-yellow" });
  assert.deepEqual(captionStyleFields("karaoke", canvas), { preset: "text.caption", size: 59, weight: 800, color: "#FFFFFF", stroke: { width: 5.4, color: "#000000" }, shadow: false, background: false, accent: "#FFD23F", karaoke: true, captionStyle: "karaoke" });
  const p = captioned();
  const cap = capOf(p);
  const plan = planCaptionStyle(p, cap.id, "karaoke");
  assert.ok("ops" in plan && plan.summary === "Caption style karaoke");
  const styled = applyEdit(createSession(p), { actor: "user", ops: plan.ops }).project;
  assert.deepEqual(validateProject(styled, modules), []);
  const after = capOf(styled);
  assert.equal(after.mode, "word");
  assert.equal(after.style!.captionStyle, "karaoke");
  assert.deepEqual(after.transform, cap.transform, "the position stays");
  assert.ok("problem" in planCaptionStyle(p, cap.id, "nope"));
  // Each preset draws through textHtml: the outline's stroke, the card's box per line, the big yellow's case.
  for (const s of CAPTION_STYLES) {
    const next = applyEdit(createSession(p), { actor: "user", ops: opsOf(planCaptionStyle(p, cap.id, s.id)) }).project;
    const drawn = captionAt(next, capOf(next), 20)!;
    const html = textHtml(drawn, next);
    if (s.id === "outline") assert.match(html, /-webkit-text-stroke:6\.5px #000000/);
    if (s.id === "card") assert.match(html, /class="pv-line" style="background:rgb\(255 255 255 \/ 94%\)/);
    if (s.id === "big-yellow") assert.match(html, /text-transform:uppercase/);
    if (s.id === "minimal") assert.doesNotMatch(html, /background:/);
    assert.ok(captionStyleSample(s.id, { width: 640, height: 200 }));
  }
});

test("F24: the speaking word's colour, the karaoke fill and the word box", () => {
  const p = captioned("highlight");
  const cap = capOf(p);
  assert.equal(cap.mode, "word", "the default style's mode");
  assert.equal(cap.style!.captionStyle, "highlight");
  const card = captionCards(p, cap)[0]!;
  const f = card.words[2]!.from; // "three" speaking
  // Highlight: only the speaking word, in the style's colour.
  const hl = captionAt(p, cap, f)!;
  assert.equal(hl.text, "One two [[three]] four");
  assert.match(textHtml(hl, p), /--accent:#3DDC84/);
  // Karaoke: every word said so far is filled.
  const k = applyEdit(createSession(p), { actor: "user", ops: opsOf(planCaptionHighlight(p, cap.id, { karaoke: true, accent: "#FF00AA" })) }).project;
  const kd = captionAt(k, capOf(k), f)!;
  assert.equal(kd.text, "[[One two three]] four");
  assert.match(textHtml(kd, k), /--accent:#FF00AA/);
  assert.equal(captionAt(k, capOf(k), card.words[0]!.from)!.text, "[[One]] two three four");
  // The word box: a class and its colour; RENDER_CSS boxes the accent only then.
  const b = applyEdit(createSession(p), { actor: "user", ops: opsOf(planCaptionHighlight(p, cap.id, { accentBox: "#7C5CFF" })) }).project;
  const bh = textHtml(captionAt(b, capOf(b), f)!, b);
  assert.match(bh, /class="pv-text acc-box"/);
  assert.match(bh, /--accent-bg:#7C5CFF/);
  assert.deepEqual(validateProject(b, modules), []);
  // Without a style nothing changes: the theme's accent, no box.
  const plain = captioned(undefined, "word");
  assert.doesNotMatch(textHtml(captionAt(plain, capOf(plain), f)!, plain), /acc-box|--accent-bg/);
  // An unknown default style is refused.
  const bad = planMakeCaptions({ ...plain, tracks: plain.tracks.filter((t) => t.role === "main") }, { media: "m-talk", transcript: T, captionStyle: "nope" });
  assert.ok("problem" in bad);
});
