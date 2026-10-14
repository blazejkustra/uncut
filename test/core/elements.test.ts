// The general elements (D130, feedback E2): each draws with its defaults at the start, the middle
// and the end; user text is escaped; the progress bar fills and the countdown counts down over the
// item; shapes differ by kind; the image frame shows its media through the target's mediaUrl.
import { test } from "node:test";
import assert from "node:assert/strict";

import { componentDefaults, componentHtml, componentInfo, type Item } from "../../packages/core/src/index.ts";

const target = { canvas: { width: 1920, height: 1080 } };
const ELEMENTS = ["component.shape", "component.progress-bar", "component.lower-third", "component.callout", "component.subscribe", "component.countdown", "component.sticker", "component.image-frame"];
const item = (component: string, props: Record<string, unknown> = componentDefaults(component), duration = 150): Item => ({ id: "e1", type: "component", component, duration, props });
const html = (i: Item, local: number, t: Parameters<typeof componentHtml>[1] = target) => componentHtml(i, t, local, { fps: 30 });

test("every general element is drawn with its defaults at the start, middle and end", () => {
  for (const id of ELEMENTS) {
    assert.ok(componentInfo(id), `${id} is in the registry`);
    for (const local of [0, 75, 149]) {
      const out = html(item(id), local);
      assert.ok(out.length > 80, `${id} at ${local}`);
      assert.match(out, new RegExp(`data-component="${id}"`));
      assert.doesNotMatch(out, /<script|<iframe|<video|NaN|undefined/, `${id} at ${local}`);
    }
  }
});

test("user text is escaped", () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const cases: Array<[string, Record<string, unknown>]> = [
    ["component.lower-third", { name: hostile, title: hostile }],
    ["component.callout", { label: hostile, arrow: "right" }],
    ["component.subscribe", { label: hostile, done: hostile }],
    ["component.sticker", { emoji: hostile.slice(0, 16) }],
  ];
  for (const [id, props] of cases) {
    const out = html(item(id, { ...componentDefaults(id), ...props }), 60);
    assert.doesNotMatch(out, /<img src=x/, id);
    assert.match(out, /&lt;img/, id);
  }
});

test("the progress bar fills over the item; a fixed one stays", () => {
  const width = (out: string) => Number(/data-progress="([\d.]+)"/.exec(out)![1]);
  const bar = item("component.progress-bar");
  const at = [0, 50, 100, 149].map((f) => width(html(bar, f)));
  assert.equal(at[0], 0);
  assert.ok(at[1]! < at[2]! && at[2]! < at[3]!, String(at));
  assert.equal(at[3], 1);
  const fixed = item("component.progress-bar", { value: 40, animate: false });
  assert.equal(width(html(fixed, 0)), 0.4);
  assert.equal(html(fixed, 0), html(fixed, 120));
});

test("the countdown counts down from `from` to 0 over the item", () => {
  const count = (out: string) => Number(/data-count="(\d+)"/.exec(out)![1]);
  const c = item("component.countdown", { from: 5 }, 150);
  assert.equal(count(html(c, 0)), 5);
  assert.equal(count(html(c, 31)), 4);
  assert.equal(count(html(c, 149)), 1);
  assert.equal(count(componentHtml(c, target, 150, { fps: 30 })), 0);
  assert.doesNotMatch(html(item("component.countdown", { from: 5, ring: false }), 0), /<circle/);
});

test("shape kinds draw differently; lines and arrows are SVG", () => {
  const outs = ["rectangle", "circle", "line", "arrow"].map((kind) => html(item("component.shape", { ...componentDefaults("component.shape"), kind }), 0));
  assert.equal(new Set(outs).size, 4);
  assert.match(outs[1]!, /border-radius:50%/);
  assert.match(outs[2]!, /<svg data-shape="line"/);
  assert.match(outs[3]!, /<svg data-shape="arrow"[^]*<path/);
  assert.match(html(item("component.shape", { kind: "rectangle", fill: "#112233", stroke: "#FFFFFF", strokeWidth: 6 }), 0), /background:#112233[^"]*border:6px solid #FFFFFF/);
});

test("the subscribe button turns into its done label when pressed", () => {
  const s = item("component.subscribe");
  assert.match(html(s, 10), /data-pressed="false"[^]*Subscribe</);
  assert.match(html(s, 60), /data-pressed="true"[^]*<svg[^]*Subscribed</);
});

test("the image frame shows its media via mediaUrl; empty, a placeholder glyph without words", () => {
  const withImage = item("component.image-frame", { ...componentDefaults("component.image-frame"), image: { media: "m-photo" } });
  assert.match(html(withImage, 0, { ...target, mediaUrl: (id) => `data:image/png;base64,${id}` }), /<img src="data:image\/png;base64,m-photo"/);
  assert.doesNotMatch(html(withImage, 0, { ...target, mediaUrl: () => "javascript:alert(1)" }), /<img/);
  const empty = html(item("component.image-frame"), 0);
  assert.match(empty, /data-empty="true"[^]*<svg/);
  assert.doesNotMatch(empty.replace(/<[^>]*>/g, ""), /\w/, "no words in the placeholder");
});

test("the callout's arrow points where it's told, or there's none", () => {
  for (const arrow of ["left", "right", "up", "down"]) assert.match(html(item("component.callout", { label: "x", arrow }), 0), new RegExp(`data-arrow="${arrow}"`));
  assert.doesNotMatch(html(item("component.callout", { label: "x", arrow: "none" }), 0), /<svg/);
});
