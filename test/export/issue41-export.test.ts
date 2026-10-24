// Issue #41 (D215) in the export plan: a text card on the main track is a title clip. A crossfade
// into it draws it over the overlap with the same opacity as core visualsAt (the preview's), held
// at its first look; a push out of it moves it as the whole canvas, frame for frame as visualsAt
// shifts it. (The preview vs export SSIM is in test/app/issue40-41-app.test.ts.)
import { test } from "node:test";
import assert from "node:assert/strict";

import { layout, textHtml, visualsAt, type Project } from "../../packages/core/src/index.ts";
import { alphaAt, planExport, rampsAt } from "../../apps/server/src/export/exportPlan.ts";

const W = 1280;
const H = 720;

function project(): Project {
  return {
    format: "uncut/0",
    name: "Title on Main",
    canvas: { width: W, height: H, fps: 30 },
    textLooks: 1,
    media: [],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "bg-a", type: "component", component: "component.solid", duration: 60, props: { color: "#203040" } },
          {
            id: "title",
            type: "text",
            text: "Chapter one",
            duration: 60,
            transitionIn: { module: "transition.crossfade", duration: 12 },
            style: { preset: "text.title", size: 96, color: "#FFFFFF" },
            transform: { x: 200, y: 300 },
          },
          {
            id: "bg-b",
            type: "component",
            component: "component.solid",
            duration: 60,
            props: { color: "#402030" },
            transitionIn: { module: "transition.push-left", duration: 12 },
          },
        ],
      },
    ],
  };
}

test("plan: a text on Main through a crossfade in and a push out draws as visualsAt does (opacity, held look, canvas shift)", () => {
  const p = project();
  const plan = planExport(p, { mediaPath: () => "", width: W, height: H });
  assert.ok(!("problem" in plan), "problem" in plan ? plan.problem : "");
  const layers = plan.visuals.filter((l) => l.item.id === "title");
  assert.ok(layers.length >= 1);
  // Over the crossfade's overlap (54–66) and the push's (114–126): the layers cover them.
  assert.equal(Math.min(...layers.map((l) => l.f0)), 54);
  assert.equal(Math.max(...layers.map((l) => l.f1)), 126);
  const { starts } = layout(p);
  for (let f = 54; f < 126; f++) {
    const v = visualsAt(p, starts, f).find((x) => x.item.id === "title")!;
    const layer = layers.find((l) => f >= l.f0 && f < l.f1)!;
    assert.ok(layer, `a layer at ${f}`);
    const opacity = rampsAt(layer.ramps, f) * alphaAt(layer, f);
    assert.ok(Math.abs(opacity - v.opacity) < 1e-6, `opacity at ${f}: ${opacity} vs ${v.opacity}`);
    if (layer.kind === "raster") assert.equal(layer.states[layer.frames[f - layer.f0]!], textHtml(v.item, p, { motion: v.motion }), `look at ${f}`);
    // The push: the layer's placement moves left by visualsAt's shift (in output px = canvas px here).
    const geo = (layer as { geometry?: { frames: ReadonlyArray<{ x: number }> } }).geometry;
    if (v.shift) assert.ok(geo && Math.abs(geo.frames[f - layer.f0]!.x - v.shift) <= 1, `shift at ${f}: ${geo?.frames[f - layer.f0]?.x} vs ${v.shift}`);
  }
  // Before its start (the crossfade's first half) it holds its first look: no motion, the same HTML as at its start.
  const at = (f: number) => visualsAt(p, starts, f).find((x) => x.item.id === "title")!;
  assert.equal(textHtml(at(55).item, p, { motion: at(55).motion }), textHtml(at(60).item, p, { motion: at(60).motion }));
});
