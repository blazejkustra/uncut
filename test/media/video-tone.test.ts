// D222: the inverse of macOS's measured <video> lift (preview/tone.ts) undoes it to well under a level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VIDEO_TONE, VIDEO_UNTONE, videoTone, videoUntone } from "../../apps/web/src/preview/tone.ts";

/** As an SVG feComponentTransfer table reads a table: linear between evenly spaced points. */
const table = (t: ReadonlyArray<number>, v: number) => {
  const n = t.length - 1;
  const x = Math.min(1, Math.max(0, v)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return t[i]! + (t[i + 1]! - t[i]!) * (x - i);
};

test("the lift is monotonic, so it has an inverse", () => {
  for (let i = 1; i < VIDEO_TONE.length; i++) assert.ok(VIDEO_TONE[i]! > VIDEO_TONE[i - 1]!);
  assert.equal(VIDEO_UNTONE.length, 256);
  assert.equal(VIDEO_UNTONE[0], 0);
  assert.equal(VIDEO_UNTONE[255], 1);
});

test("the untone table then the lift give back every 8-bit level (within 0.5)", () => {
  let worst = 0;
  for (let k = 0; k <= 255; k++) {
    const shown = videoTone(table(VIDEO_UNTONE, k / 255)) * 255;
    worst = Math.max(worst, Math.abs(shown - k));
  }
  assert.ok(worst < 0.5, `worst ${worst.toFixed(3)} levels`);
});

test("grey 126 (shown as ~137 by the <video>) is given ~116 to show 126", () => {
  assert.ok(Math.abs(videoTone(126 / 255) * 255 - 137) < 1.5);
  assert.ok(Math.abs(videoTone(videoUntone(126 / 255)) * 255 - 126) < 1e-6);
  assert.ok(videoUntone(126 / 255) * 255 < 118);
});
