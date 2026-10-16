// Issue #12 (D265): the GPU compositor's pure helpers: which <video>s Chromium shows with SMPTE 170M
// primaries converted (the compositor converts those itself), and where a picture lands in its box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertsPrimaries } from "../../apps/web/src/preview/scrub.ts";
import { fitInto } from "../../apps/web/src/preview/gpu.ts";

test("convertsPrimaries: tagged primaries, else the matrix, else BT.601 below 720 lines (as the export's untaggedFilter)", () => {
  assert.equal(convertsPrimaries(undefined, 360), true);
  assert.equal(convertsPrimaries(undefined, 719), true);
  assert.equal(convertsPrimaries(undefined, 720), false);
  assert.equal(convertsPrimaries(undefined, 2160), false);
  assert.equal(convertsPrimaries(undefined, 0), false, "no picture yet");
  assert.equal(convertsPrimaries({}, 360), true);
  assert.equal(convertsPrimaries({ primaries: 1 }, 360), false, "SD tagged BT.709");
  assert.equal(convertsPrimaries({ primaries: 6 }, 1080), true, "HD tagged SMPTE 170M");
  assert.equal(convertsPrimaries({ primaries: 5 }, 1080), true, "BT.470BG");
  assert.equal(convertsPrimaries({ primaries: 9 }, 2160), false, "BT.2020");
  assert.equal(convertsPrimaries({ matrix: 1 }, 360), false, "SD with a BT.709 matrix");
  assert.equal(convertsPrimaries({ matrix: 6 }, 1080), true);
});

test("fitInto: cover, contain and fill centred in the rect", () => {
  const r = { x: 10, y: 20, w: 400, h: 400 };
  assert.deepEqual(fitInto(r, { w: 1280, h: 720 }, "fill"), r);
  assert.deepEqual(fitInto(r, { w: 1280, h: 720 }, "contain"), { x: 10, y: 107.5, w: 400, h: 225 });
  const c = fitInto(r, { w: 1280, h: 720 }, "cover");
  assert.ok(Math.abs(c.w - 711.111) < 0.01 && c.h === 400 && Math.abs(c.x - (10 - 155.5555)) < 0.01 && c.y === 20);
  assert.deepEqual(fitInto(r, { w: 0, h: 0 }, "cover"), r, "no picture yet");
});
