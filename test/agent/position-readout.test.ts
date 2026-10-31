// measure what "position": the content box and its offset from the region's centre, from pixels.
import { test } from "node:test";
import assert from "node:assert/strict";

import { positionReadout, regionOf } from "../../apps/server/src/agent/agentPosition.ts";

function imageWith(width: number, height: number, box: { x: number; y: number; w: number; h: number }, background = 20, ink = 240) {
  const rgb = new Uint8Array(width * height * 3).fill(background);
  for (let y = box.y; y < box.y + box.h; y++) rgb.fill(ink, (y * width + box.x) * 3, (y * width + box.x + box.w) * 3);
  return { width, height, rgb };
}

const whole = { x: 0, y: 0, width: 200, height: 100 };

test("a centred box reads offset 0, a shifted one reads its shift in canvas pixels", () => {
  const centred = positionReadout(imageWith(200, 100, { x: 80, y: 40, w: 40, h: 20 }), whole, 1);
  assert.deepEqual(centred.box, { x: 80, y: 40, width: 40, height: 20 });
  assert.deepEqual(centred.offset, { x: 0, y: 0 });
  const shifted = positionReadout(imageWith(200, 100, { x: 90, y: 34, w: 40, h: 20 }), { x: 0, y: 0, width: 400, height: 200 }, 2);
  assert.deepEqual(shifted.offset, { x: 20, y: -12 }, "right and up, doubled to the canvas");
  assert.deepEqual(shifted.box, { x: 180, y: 68, width: 80, height: 40 });
});

test("the offset is from the region's centre, and the background comes from its edge", () => {
  const image = imageWith(200, 100, { x: 110, y: 30, w: 20, h: 20 });
  const read = positionReadout(image, { x: 100, y: 20, width: 40, height: 40 }, 1);
  assert.deepEqual(read.offset, { x: 0, y: 0 });
  assert.equal(read.background, "#141414");
});

test("a box that fills the region says its offset means nothing, a clear one doesn't", () => {
  const rgb = new Uint8Array(200 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) rgb.fill((x * 2 + y) % 256, (y * 200 + x) * 3, (y * 200 + x) * 3 + 3);
  const busy = positionReadout({ width: 200, height: 100, rgb }, whole, 1);
  assert.match(busy.note ?? "", /says nothing/);
  assert.equal(positionReadout(imageWith(200, 100, { x: 80, y: 40, w: 40, h: 20 }), whole, 1).note, undefined);
});

test("a plain region and a lone speck read as nothing there", () => {
  assert.equal(positionReadout(imageWith(200, 100, { x: 0, y: 0, w: 0, h: 0 }), whole, 1).box, null);
  assert.equal(positionReadout(imageWith(200, 100, { x: 50, y: 50, w: 1, h: 1 }), whole, 1).box, null);
});

test("regionOf: the whole canvas by default, refuses one outside it", () => {
  const canvas = { width: 1920, height: 1080 };
  assert.deepEqual(regionOf(undefined, canvas), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(regionOf({ x: 10, y: 10, width: 100, height: 50 }, canvas), { x: 10, y: 10, width: 100, height: 50 });
  assert.equal(regionOf({ x: 1900, y: 0, width: 100, height: 50 }, canvas), undefined);
  assert.equal(regionOf({ x: 1.5, y: 0, width: 100, height: 50 }, canvas), undefined);
  assert.equal(regionOf("everywhere", canvas), undefined);
});
