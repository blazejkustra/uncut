// Issues #14, #15, #26 (D209) without the app.
// - #15: the eight canvas rates (23.976 to 60) validate, "Match first clip" picks the clip's shown
//   size and the nearest canvas rate, the timecode counts frames within a second at 29.97.
// - #14: the welcome and editor window sizes are remembered separately, clamped to each minimum.
// - #26: moving a rail tab before another, or to the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canvasForClip, CANVAS_FPS, loadModules, nearestCanvasFps, validateProject } from "../../packages/core/src/index.ts";
import { frameTimecode, CANVAS_PRESETS } from "../../apps/web/src/state/format.ts";
import { moveInRail } from "../../apps/web/src/editor/layout.ts";
import { readWindowSizes, WINDOW_MODES, writeWindowSizes } from "../../apps/desktop/src/windowState.ts";

const empty = (fps: number) => ({
  format: "uncut/0",
  name: "Rates",
  canvas: { width: 1920, height: 1080, fps },
  media: [],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }],
});

test("#15: every canvas rate validates, others don't; eight presets with distinct shapes or rates", async () => {
  const modules = await loadModules();
  assert.deepEqual([...CANVAS_FPS], [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]);
  for (const fps of CANVAS_FPS) assert.deepEqual(validateProject(empty(fps), modules), [], `${fps}`);
  for (const fps of [29.976, 23.98, 120]) assert.ok(validateProject(empty(fps), modules).length > 0, `${fps} is refused`);
  assert.equal(CANVAS_PRESETS.length, 8);
  const ids = CANVAS_PRESETS.map((p) => p.id);
  for (const id of ["square", "cinema", "4k-vertical", "1080p60"]) assert.ok(ids.includes(id), id);
  assert.deepEqual(CANVAS_PRESETS.find((p) => p.id === "4k-vertical")!.canvas, { width: 2160, height: 3840, fps: 30 });
  assert.deepEqual(CANVAS_PRESETS.find((p) => p.id === "cinema")!.canvas, { width: 2560, height: 1080, fps: 24 });
});

test("#15: Match first clip: the clip's size as shown, even sides, the nearest canvas rate", () => {
  const canvas = { width: 1920, height: 1080, fps: 30 as const, background: "#112233" };
  assert.equal(nearestCanvasFps(30000 / 1001), 29.97);
  assert.equal(nearestCanvasFps(24000 / 1001), 23.976);
  assert.equal(nearestCanvasFps(60000 / 1001), 59.94);
  assert.equal(nearestCanvasFps(25), 25);
  assert.equal(nearestCanvasFps(120), undefined);
  assert.equal(nearestCanvasFps(undefined), undefined);
  assert.deepEqual(canvasForClip(canvas, { width: 3840, height: 2160, fps: 60000 / 1001 }), { width: 3840, height: 2160, fps: 59.94, background: "#112233" });
  // A phone clip turned 90°: portrait.
  assert.deepEqual(canvasForClip(canvas, { width: 1920, height: 1080, fps: 30, rotation: 90 }), { width: 1080, height: 1920, fps: 30, background: "#112233" });
  // An odd size is made even; a rate that isn't a canvas rate keeps the canvas's.
  assert.deepEqual(canvasForClip(canvas, { width: 1279, height: 721, fps: 120 }), { width: 1280, height: 722, fps: 30, background: "#112233" });
  assert.equal(canvasForClip(canvas, { fps: 30 }), undefined);
});

test("#15: the timecode at 29.97 counts the frames within each second", () => {
  assert.equal(frameTimecode(0, 29.97), "00:00:00:00");
  assert.equal(frameTimecode(29, 29.97), "00:00:00:29");
  assert.equal(frameTimecode(30, 29.97), "00:00:01:00");
  assert.equal(frameTimecode(Math.ceil(30 * 60 * 29.97), 29.97), "00:30:00:00");
  assert.equal(frameTimecode(61, 30), "00:00:02:01");
  assert.equal(frameTimecode(23, 23.976), "00:00:00:23");
  assert.equal(frameTimecode(24, 23.976), "00:00:01:00");
});

test("#14: welcome and editor sizes are remembered on their own, clamped to each minimum", () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-window-"));
  try {
    const first = readWindowSizes(dir);
    assert.deepEqual(first.welcome, { width: WINDOW_MODES.welcome.width, height: WINDOW_MODES.welcome.height });
    assert.deepEqual(first.editor, { width: WINDOW_MODES.editor.width, height: WINDOW_MODES.editor.height });
    assert.ok(WINDOW_MODES.welcome.width < WINDOW_MODES.editor.width && WINDOW_MODES.welcome.minWidth < WINDOW_MODES.editor.minWidth);
    writeWindowSizes(dir, { welcome: { width: 700, height: 600 }, editor: { width: 1500, height: 900, x: 10, y: 20 } });
    assert.deepEqual(readWindowSizes(dir), { welcome: { width: 700, height: 600 }, editor: { width: 1500, height: 900, x: 10, y: 20 } });
    writeFileSync(join(dir, "window.json"), JSON.stringify({ welcome: { width: 100, height: 100 }, editor: { width: "x" } }));
    assert.deepEqual(readWindowSizes(dir), { welcome: { width: WINDOW_MODES.welcome.minWidth, height: WINDOW_MODES.welcome.minHeight }, editor: { width: 1280, height: 800 } });
    writeFileSync(join(dir, "window.json"), "not json");
    assert.equal(readWindowSizes(dir).editor.width, 1280);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#26: a rail tab moves before another, or to the end", () => {
  const order = ["media", "text", "audio", "brand"];
  assert.deepEqual(moveInRail(order, "audio", "media"), ["audio", "media", "text", "brand"]);
  assert.deepEqual(moveInRail(order, "media", undefined), ["text", "audio", "brand", "media"]);
  assert.deepEqual(moveInRail(order, "media", "audio"), ["text", "media", "audio", "brand"]);
  assert.deepEqual(moveInRail(order, "brand", "unknown"), ["media", "text", "audio", "brand"]);
});
