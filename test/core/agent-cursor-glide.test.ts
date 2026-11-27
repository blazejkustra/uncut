// D348: the cursor's motion without the app: stops queue so each one is visited, but when calls
// come faster than the glide, stops in between are dropped so the newest is reached within
// MAX_LAG_MS; reduced motion jumps. Pinning to a panel's edge and the pill's contrast.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentCursorStop } from "../../packages/contracts/src/index.ts";

import { advance, DWELL_MS, emptyGlide, FAST_GLIDE_MS, GLIDE_MS, MAX_LAG_MS, progress, receive } from "../../apps/web/src/editor/cursors/glide.ts";
import { pillColour, pinTo, whiteContrast } from "../../apps/web/src/editor/cursors/place.ts";

const stop = (seq: number): AgentCursorStop => ({ seq, step: seq, label: `Step ${seq}`, target: { kind: "time", frame: seq * 10 } });
const stops = (...seqs: Array<number>) => seqs.map(stop);

test("one stop glides at once; a stop already seen isn't queued again", () => {
  let g = receive(emptyGlide(), stops(1), 0);
  g = advance(g, 0);
  assert.equal(g.leg?.stop.seq, 1);
  assert.equal(g.leg?.ms, GLIDE_MS);
  g = receive(g, stops(1), 50);
  assert.equal(g.queue.length, 0);
});

test("a stop that comes while the cursor glides waits for the glide and a rest", () => {
  let g = advance(receive(emptyGlide(), stops(1), 0), 0);
  g = receive(g, stops(1, 2), 100);
  assert.equal(advance(g, GLIDE_MS).leg?.stop.seq, 1, "still resting on the first");
  g = advance(g, GLIDE_MS + DWELL_MS);
  assert.equal(g.leg?.stop.seq, 2);
  assert.equal(g.leg?.startedAt, GLIDE_MS + DWELL_MS);
});

test("calls faster than the glide queue, then drop stops so the newest is never more than MAX_LAG_MS late", () => {
  let g = advance(receive(emptyGlide(), stops(1), 0), 0);
  g = receive(g, stops(1, 2, 3), 20);
  g = advance(g, GLIDE_MS + DWELL_MS);
  assert.equal(g.leg?.stop.seq, 2, "two waiting: both visited");
  assert.equal(g.leg?.ms, FAST_GLIDE_MS, "faster while another waits");

  let h = advance(receive(emptyGlide(), stops(1), 0), 0);
  h = receive(h, stops(1, 2, 3, 4, 5, 6, 7, 8), 10);
  const now = GLIDE_MS + DWELL_MS;
  h = advance(h, now);
  const visited = [h.leg!.stop.seq, ...h.queue.map((q) => q.stop.seq)];
  assert.ok(visited.length < 7, `stops in between dropped: ${visited}`);
  assert.equal(visited.at(-1), 8, "the newest is kept");
  const reachLast = now + visited.length * FAST_GLIDE_MS + (visited.length - 1) * DWELL_MS;
  assert.ok(reachLast <= 10 + MAX_LAG_MS, `the newest is reached ${reachLast - 10} ms after it came`);
});

test("reduced motion jumps: no glide", () => {
  const g = advance(receive(emptyGlide(), stops(1), 0), 0, true);
  assert.equal(g.leg?.ms, 0);
  assert.equal(progress(g.leg!, 0), 1);
});

test("the glide eases out and ends where it's going", () => {
  const leg = { startedAt: 100, ms: 300 };
  assert.equal(progress(leg, 100), 0);
  assert.ok(progress(leg, 175) > 0.25, "ease-out: more than a quarter of the way at a quarter of the time");
  assert.equal(progress(leg, 400), 1);
  assert.equal(progress(leg, 900), 1);
});

test("a target out of view pins to the nearest edge of its panel", () => {
  const bounds = { left: 200, top: 100, right: 800, bottom: 400 };
  assert.deepEqual(pinTo({ x: 300, y: 200 }, bounds), { x: 300, y: 200 });
  assert.deepEqual(pinTo({ x: 1500, y: 200 }, bounds), { x: 790, y: 200, pin: "right" });
  assert.deepEqual(pinTo({ x: -40, y: 200 }, bounds), { x: 210, y: 200, pin: "left" });
  assert.deepEqual(pinTo({ x: 300, y: 900 }, bounds), { x: 300, y: 390, pin: "down" });
});

test("the pill keeps white text at 4.5:1 for every agent colour", () => {
  for (const colour of ["#5b8def", "#3fb68b", "#d9a43b", "#b072d8", "#e0655b", "#4bb3c4", "#6d8cff", "#ffffff"]) {
    const pill = pillColour(colour);
    assert.ok(whiteContrast(pill) >= 4.5, `${colour} → ${pill}: ${whiteContrast(pill).toFixed(2)}`);
  }
  assert.equal(pillColour("#1f3a8a"), "#1f3a8a", "a dark colour stays as it is");
});
