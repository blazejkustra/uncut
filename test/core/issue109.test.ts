// Issue #109 (D287): the follow card and the steps draw. Both are in the registry (not in
// UNDRAWN_COMPONENTS), draw deterministically with their defaults, settle to a still, escape their
// text; the follow card keeps a brand's colour locked (D275 / D278) and shows the user's logo with
// the platform's badge; the steps appear one after another; the example project's follow card draws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { componentDefaults, componentHtml, componentInfo, type Item, type Project } from "../../packages/core/src/index.ts";
import { componentBox, defaultComponentBox, DRAWN_COMPONENTS, elementCategory, UNDRAWN_COMPONENTS } from "../../packages/core/src/visual/components.ts";
import { stepsAt } from "../../packages/core/src/visual/elementsCards.ts";
import { BRAND_ICONS } from "../../packages/core/src/visual/brandIcons.ts";
import { ALL_DOCS } from "../../apps/server/src/agent/agentDocs.ts";

const target = { canvas: { width: 1920, height: 1080 }, mediaUrl: (id: string) => (id === "m-logo" ? "data:image/svg+xml;base64,PHN2Zy8+" : undefined) };
const IDS = ["component.follow-card", "component.steps"];
const item = (component: string, props: Record<string, unknown> = componentDefaults(component), duration = 300): Item => ({
  id: "e1",
  type: "component",
  component,
  duration,
  props,
});
const html = (i: Item, local: number) => componentHtml(i, target, local, { fps: 30 });

test("both are drawn, no longer listed as not drawn, in the Elements sections, in the agent's docs", () => {
  for (const id of IDS) {
    assert.ok(componentInfo(id), id);
    assert.ok(DRAWN_COMPONENTS.includes(id), id);
    assert.equal(UNDRAWN_COMPONENTS[id], undefined, id);
    assert.ok(ALL_DOCS.includes(id), `${id} in the docs`);
  }
  assert.deepEqual(Object.keys(UNDRAWN_COMPONENTS), ["component.zoom-pan"]);
  assert.equal(elementCategory("component.follow-card").category, "Social");
  assert.equal(elementCategory("component.steps").category, "Info");
  assert.ok(elementCategory("component.steps").keywords.includes("tutorial"));
  assert.ok(defaultComponentBox("component.follow-card", target), "placed when added");
  assert.ok(defaultComponentBox("component.steps", target));
});

test("defaults draw across the item's length; deterministic; no NaN; motion settles; text escaped", () => {
  for (const id of IDS) {
    for (const local of [0, 5, 15, 30, 45, 90, 150, 299]) {
      const out = html(item(id), local);
      assert.match(out, new RegExp(`data-component="${id}"`));
      assert.doesNotMatch(out, /NaN|undefined|Infinity|<script|<iframe|<video/, `${id} at ${local}`);
      assert.equal(out, html(item(id), local), `${id} at ${local}`);
    }
    assert.equal(html(item(id), 90), html(item(id), 140), `${id} still at 3 s`);
    assert.notEqual(html(item(id), 0), html(item(id), 140), `${id} moves at first`);
  }
  const hostile = '<img src=x onerror="alert(1)">';
  for (const [id, props] of [
    ["component.follow-card", { handle: hostile, title: hostile, button: hostile.slice(0, 24) }],
    ["component.steps", { title: hostile, steps: [{ text: hostile, detail: hostile }, hostile] }],
  ] as const) {
    const out = html(item(id, { ...componentDefaults(id), ...props }), 120);
    assert.doesNotMatch(out, /<img src=x/, id);
    assert.match(out, /&lt;img/, id);
  }
});

test("follow card: the brand's own mark and colour, locked; the user's logo with a badge; no pill ends", () => {
  const card = (props: Record<string, unknown>) => html(item("component.follow-card", { ...componentDefaults("component.follow-card"), ...props }), 60);
  const yt = card({ platform: "youtube", color: "#00FF00" });
  assert.ok(yt.includes(BRAND_ICONS.youtube!.path));
  assert.ok(yt.includes(`background:${BRAND_ICONS.youtube!.hex}`), "the button and picture in YouTube red");
  assert.ok(!yt.includes("#00FF00"), "color never recolours a brand");
  assert.match(yt, /data-button="true"[^>]*>Follow</);
  // A generic kind takes `color`.
  assert.ok(card({ platform: "web", color: "#00AA55" }).includes("background:#00AA55"));
  // A logo: the image on its tile, the platform's badge on the corner.
  const withLogo = card({ platform: "instagram", logo: { media: "m-logo" } });
  assert.match(withLogo, /<img src="data:image\/svg\+xml;base64,PHN2Zy8\+"/);
  assert.match(withLogo, /data-badge="instagram"/);
  assert.ok(withLogo.includes(BRAND_ICONS.instagram!.path));
  // A logo that can't be found draws the card without it.
  assert.doesNotMatch(card({ logo: { media: "m-missing" } }), /<img/);
  // No button when its word is empty.
  assert.doesNotMatch(card({ button: "" }), /data-button/);
  // Rounded corners, never pill ends (no radius of half the height or more).
  const box = componentBox(item("component.follow-card"), target.canvas, 60)!;
  for (const r of yt.matchAll(/border-radius:([\d.]+)px/g)) assert.ok(Number(r[1]) < box.h / 4, `radius ${r[1]}`);
});

test("steps: one after another, earlier ones dim, the line grows; plain strings work", () => {
  const props = { steps: [{ text: "a" }, { text: "b" }, { text: "c" }], start: 0.5, step: 1 };
  const shown = (f: number) => stepsAt(props, f, 30).rows.map((r) => r.shown);
  assert.deepEqual(shown(0), [0, 0, 0]);
  assert.deepEqual(shown(30), [1, 0, 0]);
  assert.deepEqual(shown(60), [1, 1, 0]);
  assert.deepEqual(shown(200), [1, 1, 1]);
  assert.deepEqual(
    stepsAt(props, 200, 30).rows.map((r) => r.dimmed),
    [1, 1, 0],
    "the last one stands out",
  );
  assert.deepEqual(
    stepsAt({ ...props, focus: false }, 200, 30).rows.map((r) => r.dimmed),
    [0, 0, 0],
  );
  assert.equal(stepsAt(props, 30, 30).line, 0);
  assert.equal(stepsAt(props, 200, 30).line, 2);
  const out = html(item("component.steps", { ...componentDefaults("component.steps"), ...props }), 50);
  assert.equal(out.match(/data-shown="true"/g)!.length, 1);
  assert.match(html(item("component.steps", { steps: ["One", "Two"] }), 200), />One<[^]*>2</);
});

test("the example project's follow card draws (handle, generic glyph without a platform; its logo file is missing)", () => {
  const project = JSON.parse(readFileSync("spec/examples/drone-weekend.uncut/project.json", "utf8")) as Project;
  const follow = project.tracks.flatMap((t) => t.items).find((i) => i.id === "gfx-follow")!;
  assert.equal(follow.component, "component.follow-card");
  const t = { canvas: project.canvas };
  const box = componentBox(follow, t.canvas, 60)!;
  assert.ok(box && box.w > 0 && box.h > 0);
  assert.deepEqual([box.w, box.h], [1800, 520], "its manifest size at 4K");
  const out = componentHtml(follow, t, 60, { fps: 30 });
  assert.match(out, />@blazejkustra</);
  assert.doesNotMatch(out, /<img|NaN|undefined/);
});
