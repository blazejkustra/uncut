// D333: the playback engine draws only clips it can play forward from their own file at one steady
// speed; reversed (D327: a reversed copy) and ramped clips stay on their <video>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { engineDraws } from "../../apps/web/src/preview/play/engine.ts";
import type { Item } from "../../apps/web/src/state/project.ts";

const clip = (extra: Partial<Item> = {}) => ({ id: "c", type: "clip", media: "m", duration: 60, in: 0, ...extra }) as Item;

test("plain clips and steady speeds up to 4x are drawn by the engine", () => {
  assert.equal(engineDraws(clip()), true);
  assert.equal(engineDraws(clip({ speed: 2 })), true);
  assert.equal(engineDraws(clip({ speed: 4 })), true);
});

test("reversed, ramped, looped and too fast clips stay on their <video>", () => {
  const speedKeys = [
    { frame: 0, speed: 1 },
    { frame: 30, speed: 3, ease: "inOut" },
  ];
  assert.equal(engineDraws(clip({ reverse: true })), false);
  assert.equal(engineDraws(clip({ speedKeys } as Partial<Item>)), false);
  assert.equal(engineDraws(clip({ loop: true })), false);
  assert.equal(engineDraws(clip({ speed: 8 })), false);
});
