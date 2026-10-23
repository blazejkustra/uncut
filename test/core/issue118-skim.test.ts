// Issue #118, without the app: skimming (the frame under the pointer shown instead of the
// playhead's while paused) and a media tile's skim, in the playback state the preview draws from.
import { test } from "node:test";
import assert from "node:assert/strict";

const frames: Array<FrameRequestCallback> = [];
Object.assign(globalThis, { requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb), cancelAnimationFrame: () => {} });
const { playback, getPlayback } = await import("../../apps/web/src/preview/playback.ts");

test("skimming: the hovered frame is kept apart from the playhead, whole and within the project", () => {
  playback.reset();
  playback.setProject(301, 30, 300);
  playback.seek(40);
  playback.hover(120.6);
  assert.equal(getPlayback().hover, 121);
  assert.equal(getPlayback().frame, 40, "the playhead stays");
  playback.hover(9999);
  assert.equal(getPlayback().hover, 300, "never past the end");
  playback.hover(undefined);
  assert.equal(getPlayback().hover, undefined);
});

test("skimming: a media tile's skim replaces the timeline's, and the other way round", () => {
  playback.reset();
  playback.setProject(301, 30, 300);
  playback.hover(50);
  playback.hoverMedia("m-a", 2.5);
  assert.deepEqual(getPlayback().hoverMedia, { media: "m-a", seconds: 2.5 });
  assert.equal(getPlayback().hover, undefined);
  playback.hover(60);
  assert.equal(getPlayback().hoverMedia, undefined);
  assert.equal(getPlayback().hover, 60);
});

test("skimming: off while playing, and with the switch off", () => {
  playback.reset();
  playback.setProject(301, 30, 300);
  playback.hover(50);
  playback.play();
  assert.equal(getPlayback().hover, undefined, "playing stops skimming");
  playback.hover(80);
  assert.equal(getPlayback().hover, undefined, "and the pointer doesn't skim while playing");
  playback.pause();
  playback.toggleSkimming();
  assert.equal(getPlayback().skimming, false);
  playback.hover(80);
  playback.hoverMedia("m-a", 1);
  assert.equal(getPlayback().hover, undefined);
  assert.equal(getPlayback().hoverMedia, undefined);
  playback.toggleSkimming();
  playback.hover(80);
  assert.equal(getPlayback().hover, 80);
});
