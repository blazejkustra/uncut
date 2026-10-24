// D286: Uncut's synthesised sounds go through the master stage (no DC, a 0.9 peak, no NaN, faded
// edges) and match the pack's library.json entries; the ones made wide are stereo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RATE, SYNTH_SOUNDS } from "../../scripts/sfx-synth.ts";

const pack = (
  JSON.parse(readFileSync("assets/sfx/library.json", "utf8")) as { sounds: Array<{ id: string; provider: string; title: string; tags: Array<string> }> }
).sounds;

test("every synth recipe is in the pack under the same id, title and tags (D250, D286)", () => {
  const uncut = pack.filter((s) => s.provider === "uncut");
  assert.deepEqual(uncut.map((s) => s.id).sort(), SYNTH_SOUNDS.map((s) => s.id).sort());
  for (const s of SYNTH_SOUNDS) {
    const entry = uncut.find((e) => e.id === s.id)!;
    assert.equal(entry.title, s.title);
    assert.deepEqual(entry.tags, s.tags);
  }
});

test("the master stage: peak 0.9, no DC, finite, faded edges; wide sounds are stereo (D286)", () => {
  for (const id of ["exaggerated-shout", "dramatic-boom", "deep-bong", "bonk", "whoosh-airy", "riser-noise", "clock-ticking"]) {
    const out = SYNTH_SOUNDS.find((s) => s.id === id)!.make();
    const chs = Array.isArray(out) ? out : [out as Float32Array];
    if (["whoosh-airy", "riser-noise", "deep-bong"].includes(id)) assert.equal(chs.length, 2, `${id} is stereo`);
    let peak = 0;
    for (const x of chs) {
      assert.ok(x.length > RATE * 0.05 && x.length < RATE * 6.5, `${id}: ${x.length / RATE} s`);
      let sum = 0;
      for (const v of x) {
        assert.ok(Number.isFinite(v), id);
        peak = Math.max(peak, Math.abs(v));
        sum += v;
      }
      assert.ok(Math.abs(sum / x.length) < 0.002, `${id}: DC ${sum / x.length}`);
      assert.ok(Math.abs(x[0]!) < 1e-9, `${id} starts at 0`);
      assert.ok(Math.abs(x[x.length - 1]!) < 0.01, `${id} ends faded`);
    }
    assert.ok(Math.abs(peak - 0.9) < 0.01, `${id}: peak ${peak}`);
  }
});
