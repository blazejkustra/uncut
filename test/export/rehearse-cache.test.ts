// The rehearsal's cache (apps/server/src/export/exporter/rehearse.ts), on a fake rasteriser: a
// result is kept per set of graphics *as drawn* (canvas and fps included), and a rehearsal stopped
// under it (the turn stopped, the rasteriser gone) isn't kept as the graphic's failure.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExportPlan } from "../../apps/server/src/export/exportPlan.ts";
import type { Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { rehearseGraphics } from "../../apps/server/src/export/exporter/rehearse.ts";

const planOf = (doc: string, o: { width?: number; height?: number; fps?: number } = {}): ExportPlan =>
  ({
    fps: o.fps ?? 30,
    canvas: { width: o.width ?? 64, height: o.height ?? 80 },
    visuals: [{ kind: "graphic", doc, f0: 0, f1: 10, frames: Array.from({ length: 10 }, (_, i) => i), item: { id: "g", src: "graphics/g.html", duration: 10 } }],
  }) as unknown as ExportPlan;

const fake = (render: Rasterizer["render"]) => ({ render, close: async () => {}, pid: 1 }) as unknown as Rasterizer;

test("a passed rehearsal isn't reused for another canvas size or fps", async () => {
  let calls = 0;
  const r = fake(async () => void calls++);
  const doc = `<p>canvas ${Math.random()}</p>`;
  assert.equal((await rehearseGraphics(r, planOf(doc), { budgetMs: 10_000 })).covered, 10);
  assert.equal(calls, 1);
  await rehearseGraphics(r, planOf(doc), { budgetMs: 10_000 });
  assert.equal(calls, 1, "the same graphics on the same canvas: cached");
  await rehearseGraphics(r, planOf(doc, { width: 80, height: 64 }), { budgetMs: 10_000 });
  assert.equal(calls, 2, "another canvas: rehearsed again");
  await rehearseGraphics(r, planOf(doc, { fps: 60 }), { budgetMs: 10_000 });
  assert.equal(calls, 3, "another fps: rehearsed again");
});

test("a rehearsal stopped under it (the rasteriser gone) isn't remembered as the graphic's failure", async () => {
  const doc = `<p>stopped ${Math.random()}</p>`;
  const stop = new AbortController();
  const dying = fake(async () => {
    stop.abort();
    throw new Error("The text renderer stopped (SIGKILL).");
  });
  const first = await rehearseGraphics(dying, planOf(doc), { budgetMs: 10_000, signal: stop.signal });
  assert.equal(first.failure, undefined, "stopped, not failed");
  let calls = 0;
  const fine = fake(async () => void calls++);
  const again = await rehearseGraphics(fine, planOf(doc), { budgetMs: 10_000 });
  assert.equal(again.failure, undefined);
  assert.equal(calls, 1, "rehearsed again");
  assert.equal(again.covered, 10);
});

test("a crash that names no frame is said once, not kept; a frame's own failure is kept", async () => {
  const doc = `<p>crash ${Math.random()}</p>`;
  const crash = await rehearseGraphics(fake(async () => { throw new Error("The text renderer stopped (code 1)."); }), planOf(doc), { budgetMs: 10_000 });
  assert.match(crash.failure ?? "", /stopped/);
  let calls = 0;
  await rehearseGraphics(fake(async () => void calls++), planOf(doc), { budgetMs: 10_000 });
  assert.equal(calls, 1, "rehearsed again after the crash");
  const doc2 = `<p>breaks ${Math.random()}</p>`;
  const broke = await rehearseGraphics(fake(async () => { throw new Error("The text renderer failed: at its frame 4: boom"); }), planOf(doc2), { budgetMs: 10_000 });
  assert.match(broke.failure ?? "", /boom/);
  calls = 0;
  const kept = await rehearseGraphics(fake(async () => void calls++), planOf(doc2), { budgetMs: 10_000 });
  assert.equal(calls, 0, "the graphic's own failure is kept");
  assert.match(kept.failure ?? "", /boom/);
});
