// Issue #71 (D251): the Elements tab's content for everyone's videos. The new elements (follow
// handle, social button, checklist, quote card, rating, price tag, map pin, before / after) draw
// deterministically, settle or loop in whole frames (so the export's capped looks hold), escape
// their text; the bigger sticker set (sections, marks that stretch, words and colours, draw-on,
// loops) and the Elements sections and search words.
import { test } from "node:test";
import assert from "node:assert/strict";

import { componentDefaults, componentHtml, componentInfo, COMPONENTS, type Item } from "../../packages/core/src/index.ts";
import { defaultComponentBox, ELEMENT_CATEGORIES, elementCategory, naturalSize } from "../../packages/core/src/visual/components.ts";
import { checklistAt, inkOn, ratingAt, priceSwing, pinDrop } from "../../packages/core/src/visual/elementsMore.ts";
import { stickerMotion } from "../../packages/core/src/visual/elements.ts";
import {
  artSvg,
  searchStickers,
  STICKER_ART,
  STICKER_ART_IDS,
  STICKER_GROUPS,
  STICKERS,
  stickerArt,
  stickerProps,
} from "../../packages/core/src/visual/stickers.ts";

const target = { canvas: { width: 1920, height: 1080 } };
const NEW = [
  "component.follow",
  "component.social-button",
  "component.checklist",
  "component.quote",
  "component.rating",
  "component.price-tag",
  "component.map-pin",
  "component.before-after",
];
const item = (component: string, props: Record<string, unknown> = componentDefaults(component), duration = 300): Item => ({
  id: "e1",
  type: "component",
  component,
  duration,
  props,
});
const html = (i: Item, local: number) => componentHtml(i, target, local, { fps: 30 });

test("every new element draws with its defaults across its length; deterministic; no NaN, scripts or footage", () => {
  for (const id of NEW) {
    assert.ok(componentInfo(id), `${id} is in the registry`);
    for (const local of [0, 5, 15, 30, 45, 90, 150, 299]) {
      const out = html(item(id), local);
      assert.match(out, new RegExp(`data-component="${id}"`));
      assert.doesNotMatch(out, /NaN|undefined|Infinity|<script|<iframe|<video/, `${id} at ${local}`);
      assert.equal(out, html(item(id), local), `${id} at ${local}: the same HTML twice`);
    }
  }
});

test("one-shot motions settle to a still within about two and a half seconds (the export draws one look after)", () => {
  for (const id of [
    "component.follow",
    "component.social-button",
    "component.quote",
    "component.rating",
    "component.price-tag",
    "component.before-after",
    "component.checklist",
    "component.lower-third",
    "component.callout",
  ]) {
    assert.equal(html(item(id), 90), html(item(id), 140), `${id} still at 3 s`);
    assert.notEqual(html(item(id), 0), html(item(id), 140), `${id} moves at first`);
  }
  // Each lower third style, the shape's new kinds.
  for (const style of ["bar", "pill", "underline", "card", "split", "minimal"]) {
    const lt = item("component.lower-third", { ...componentDefaults("component.lower-third"), style });
    assert.equal(html(lt, 60), html(lt, 120), style);
    assert.doesNotMatch(html(lt, 10), /NaN|undefined/, style);
  }
  assert.match(html(item("component.shape", { kind: "star", fill: "#FFCC00" }), 0), /<svg data-shape="star"[^]*<polygon/);
  assert.match(html(item("component.shape", { kind: "triangle", fill: "#FFCC00" }), 0), /<svg data-shape="triangle"[^]*<polygon/);
  // The map pin's ring loops every 1.6 s (48 frames) once it has landed.
  const pin = item("component.map-pin");
  assert.equal(html(pin, 40), html(pin, 88));
  assert.notEqual(html(pin, 40), html(pin, 60));
  assert.equal(
    html(item("component.map-pin", { ...componentDefaults("component.map-pin"), pulse: false }), 40),
    html(item("component.map-pin", { ...componentDefaults("component.map-pin"), pulse: false }), 100),
  );
  assert.deepEqual(pinDrop(30, 30), { dy: 0, squash: 1 });
  assert.equal(priceSwing(60, 30), 0);
});

test("user text is escaped in every new element", () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const cases: Array<[string, Record<string, unknown>]> = [
    ["component.follow", { handle: hostile, label: hostile }],
    ["component.social-button", { label: hostile, count: hostile.slice(0, 16) }],
    ["component.checklist", { title: hostile, items: [{ text: hostile }] }],
    ["component.quote", { quote: hostile, author: hostile, role: hostile }],
    ["component.rating", { label: hostile }],
    ["component.price-tag", { price: hostile.slice(0, 16), was: hostile.slice(0, 16), label: hostile.slice(0, 16) }],
    ["component.map-pin", { label: hostile, detail: hostile }],
    ["component.before-after", { before: hostile.slice(0, 30), after: hostile.slice(0, 30) }],
    ["component.lower-third", { name: hostile, title: hostile, style: "split" }],
    ["component.sticker", { art: "speech", text: hostile.slice(0, 24) }],
  ];
  for (const [id, props] of cases) {
    const out = html(item(id, { ...componentDefaults(id), ...props }), 120);
    assert.doesNotMatch(out, /<img src=x/, id);
    assert.match(out, /&lt;img/, id);
  }
});

test("the checklist ticks one row after another; a to-do row stays unticked; the rating fills star by star, halves too", () => {
  const props = { items: [{ text: "a" }, { text: "b" }, { text: "c", todo: true }], start: 0.5, step: 1 };
  const at = (f: number) => checklistAt(props, f, 30).map((r) => r.ticked);
  assert.deepEqual(at(0), [0, 0, 0]);
  assert.deepEqual(at(30), [1, 0, 0]);
  assert.deepEqual(at(60), [1, 1, 0]);
  assert.deepEqual(at(200), [1, 1, 0]);
  const out = html(item("component.checklist", { ...componentDefaults("component.checklist"), ...props }), 200);
  assert.equal(out.match(/data-ticked="true"/g)!.length, 2);
  assert.deepEqual(ratingAt({ value: 3.5, stars: 5 }, 200, 30), [1, 1, 1, 0.5, 0]);
  assert.deepEqual(ratingAt({ value: 3.5, stars: 5 }, 0, 30), [0, 0, 0, 0, 0]);
  assert.deepEqual(ratingAt({ value: 2, stars: 3, animate: false }, 0, 30), [1, 1, 0]);
});

test("the social button presses: filled, its label changes, a whole-number count goes up; a pointer only when asked", () => {
  const b = item("component.social-button", { kind: "like", count: "41", pressAt: 1, cursor: true });
  assert.match(html(b, 10), /data-pressed="false"[^]*Like<[^]*41</);
  assert.match(html(b, 60), /data-pressed="true"[^]*Liked<[^]*42</);
  assert.match(html(b, 20), /data-pointer="true"/);
  assert.doesNotMatch(html(b, 90), /data-pointer/, "gone after the click");
  assert.doesNotMatch(html(item("component.social-button", { kind: "bell", cursor: false }), 20), /data-pointer/);
  assert.match(
    html(item("component.subscribe", { ...componentDefaults("component.subscribe") }), 20),
    /data-pointer="true"/,
    "new subscribe buttons get the pointer",
  );
  assert.doesNotMatch(html(item("component.subscribe", { label: "Subscribe", done: "Subscribed", pressAt: 1 }), 20), /data-pointer/, "older ones don't");
  assert.equal(inkOn("#FFE14D"), "#0A0A0B");
  assert.equal(inkOn("#2F80FF"), "#FFFFFF");
});

test("stickers: sections, a large drawn set with their own words and colours, marks that stretch", () => {
  assert.ok(STICKER_ART_IDS.length >= 50, `${STICKER_ART_IDS.length} drawn stickers`);
  assert.ok(STICKERS.length >= 190);
  for (const g of STICKER_GROUPS)
    assert.ok(
      STICKERS.some((s) => s.group === g),
      `${g} has stickers`,
    );
  for (const id of STICKER_ART_IDS) {
    const svg = STICKER_ART[id]!.svg;
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [\d.]+ 200"/, id);
    assert.doesNotMatch(svg, /\{\{|\}\}|NaN|undefined|<script|href=/, id);
    assert.equal(svg.split("<svg").length, 2, `${id}: one svg`);
  }
  // Words and colour.
  assert.match(artSvg("sale", { text: "-30%" }), />-30%<\/text>/);
  assert.match(artSvg("sale"), />SALE<\/text>/);
  assert.match(artSvg("heart", { color: "#00FF00" }), /fill="#00FF00"/);
  assert.doesNotMatch(artSvg("heart", { color: '"/><script>' }), /<script/, "a colour can't break out");
  const long = Number(/font-size="([\d.]+)"/.exec(artSvg("new", { text: "BRAND NEW TODAY" }))![1]);
  const short = Number(/font-size="([\d.]+)"/.exec(artSvg("new"))![1]);
  assert.ok(long < short, "longer words are set smaller to fit");
  // Marks stretch to their box's aspect; pictures stay square.
  assert.match(artSvg("underline", { aspect: 6 }), /viewBox="0 0 1200 200"[^>]*preserveAspectRatio="none"/);
  assert.match(artSvg("star", { aspect: 6 }), /viewBox="0 0 200 200"/);
  assert.deepEqual(stickerArt("circle-hand")?.mark, true);
  const size = naturalSize({ component: "component.sticker", props: { art: "underline" } }, target.canvas);
  assert.deepEqual(size, { width: 560, height: 80 });
  const box = defaultComponentBox("component.sticker", target, { art: "circle-hand" })!;
  assert.equal(box.x + box.w / 2, 960, "a mark lands in the middle");
  const pic = defaultComponentBox("component.sticker", target, { art: "star" })!;
  assert.ok(pic.x > 960, "a picture top-right");
  // Search: names, keywords and section names.
  assert.ok(searchStickers("badges").every((s) => s.group === "Badges") && searchStickers("badges").length >= 8);
  assert.equal(searchStickers("underline")[0]!.art, "underline");
  assert.equal(searchStickers("subscribe bell")[0]!.art, "bell");
  assert.deepEqual(stickerProps(searchStickers("hand-drawn circle")[0]!), { art: "circle-hand", enter: "draw", tilt: 0 });
});

test("sticker motion: pop, draw-on, slide, fade; loops repeat in whole frames from when it's in; older items keep their pop", () => {
  // Draw: hidden at 0, the strokes' dash offset falls to 0 by 0.8 s.
  const draw = item("component.sticker", { art: "circle-hand", enter: "draw" }, 120);
  assert.match(html(draw, 0), /visibility:hidden/);
  const offset = (f: number) => Number(/stroke-dashoffset="([\d.]+)"/.exec(html(draw, f))![1]);
  assert.ok(offset(4) > offset(12) && offset(12) > offset(20), `${offset(4)} ${offset(12)} ${offset(20)}`);
  assert.equal(offset(30), 0);
  assert.equal(html(draw, 30), html(draw, 100), "drawn, then still");
  // Loops: periodic once in.
  for (const [loop, period] of [
    ["wiggle", 21],
    ["float", 60],
    ["pulse", 30],
    ["spin", 120],
  ] as const) {
    const s = item("component.sticker", { emoji: "🔥", enter: "pop", loop }, 600);
    assert.equal(html(s, 20), html(s, 20 + period), loop);
    assert.notEqual(html(s, 20), html(s, 20 + Math.floor(period / 4)), loop);
  }
  assert.equal(stickerMotion({ enter: "slide" }, 0, 30).opacity, 0);
  assert.equal(stickerMotion({ enter: "fade" }, 30, 30).opacity, 1);
  // pop: false (an older item) = no pop; pop: true (or nothing) = the D165 pop.
  assert.equal(stickerMotion({ pop: false, tilt: 10 }, 0, 30).scale, 1);
  assert.ok(stickerMotion({ pop: true }, 0, 30).scale < 1e-9);
  assert.equal(stickerMotion({}, 15, 30).scale, 1);
});

test("Elements sections: every drawn element has one, the dev-promo ones apart; unknown ids under More", () => {
  for (const c of COMPONENTS) assert.notEqual(elementCategory(c.id).category, "More", c.id);
  const used = new Set(COMPONENTS.map((c) => elementCategory(c.id).category));
  for (const cat of ELEMENT_CATEGORIES) if (cat !== "More") assert.ok(used.has(cat), cat);
  assert.equal(elementCategory("component.terminal").category, "Product demos");
  assert.equal(elementCategory("plugin.x.y").category, "More");
  assert.ok(elementCategory("component.follow").keywords.includes("instagram"), "found by the platform people search for");
});

test("D275: the follow handle draws each brand's own mark in its colour (Simple Icons); generic kinds stay", async () => {
  const { BRAND_ICONS } = await import("../../packages/core/src/visual/brandIcons.ts");
  const { FOLLOW_PLATFORM_NAMES } = await import("../../packages/core/src/visual/elementsMore.ts");
  const schema = componentInfo("component.follow")!.manifest.params as { properties: { platform: { enum: Array<string> } } };
  const ids = schema.properties.platform.enum;
  for (const want of [
    "youtube",
    "instagram",
    "tiktok",
    "x",
    "linkedin",
    "facebook",
    "twitch",
    "github",
    "threads",
    "bluesky",
    "discord",
    "spotify",
    "web",
    "mail",
    "video",
  ])
    assert.ok(ids.includes(want), want);
  for (const id of ids) assert.ok(FOLLOW_PLATFORM_NAMES[id], `${id} has a name in the inspector`);
  assert.equal(componentDefaults("component.follow").platform, "youtube");
  const at = (platform: string, style = "pill") => html(item("component.follow", { handle: "@me", platform, style }), 60);
  for (const [id, b] of Object.entries(BRAND_ICONS)) {
    const out = at(id);
    assert.ok(out.includes(b.path), `${id} draws its mark`);
    assert.ok(out.includes(`background:${b.hex}`), `${id} in ${b.hex}`);
  }
  assert.ok(at("youtube").includes("#FF0000"));
  // A light brand colour gets dark ink on its circle, in the pill and the solid style.
  assert.match(at("snapchat"), /fill="#000000" d="/);
  assert.match(at("snapchat", "solid"), /fill="#000000" d="/);
  // LinkedIn (not in Simple Icons) and the generic kinds draw Uncut's own glyphs.
  assert.ok(at("linkedin").includes("background:#0A66C2"));
  for (const g of ["web", "mail", "video", "linkedin"]) assert.ok(!Object.values(BRAND_ICONS).some((b) => at(g).includes(b.path)), `${g} draws no brand mark`);
  assert.ok(elementCategory("component.follow").keywords.includes("bluesky"));
});
