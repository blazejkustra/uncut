// C6: a ripple cut on Main takes the same stretch out of a graphic that spans it (start, length,
// box keys and its own time through `skips`), so its beats and transitions stay on the footage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEdit,
  createSession,
  graphicInfo,
  graphicLocal,
  loadModules,
  rippleSpans,
  validateProject,
  withGraphicRetime,
  type Item,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";

const modules = await loadModules("spec/modules/builtin", "spec/examples/plugins");
const FPS = 30;

/** Main: a (0–150, media 0–150) and b (150–300, media 400–550); a panel graphic over all 300 frames with a transition key at 200. */
function film(panel: Partial<Item> = {}, extra: Array<Item> = []): Project {
  return {
    format: "uncut/0",
    name: "Retime",
    canvas: { width: 1920, height: 1080, fps: FPS },
    media: [
      { id: "m-cam", kind: "video", name: "camera.mp4", path: "/tmp/camera.mp4", probe: { frames: 3000, fps: 30, width: 1920, height: 1080, hasAudio: true } },
    ],
    tracks: [
      {
        id: "gfx",
        kind: "video",
        name: "Graphics",
        items: [
          {
            id: "panel",
            type: "graphic",
            src: "graphics/panel.html",
            start: 0,
            duration: 300,
            keys: [
              { frame: 0, opacity: 1 },
              { frame: 200, opacity: 1 },
              { frame: 210, opacity: 0 },
            ],
            ...panel,
          } as Item,
        ],
      },
      ...(extra.length ? [{ id: "gfx-2", kind: "video" as const, name: "More graphics", items: extra }] : []),
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "a", type: "clip", media: "m-cam", in: 0, duration: 150 },
          { id: "b", type: "clip", media: "m-cam", in: 400, duration: 150 },
        ],
      },
    ],
  };
}

const apply = (project: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(project), { actor: "agent", ops }).project;
const item = (project: Project, id: string) => project.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;
/** The edit with the re-time added, applied; and what was re-timed. */
function cut(project: Project, ops: ReadonlyArray<Op>) {
  const planned = withGraphicRetime(project, ops);
  const after = apply(project, planned.ops);
  assert.deepEqual(validateProject(after, modules), []);
  return { after, retimed: planned.retimed, ops: planned.ops };
}

test("trimming a main clip's end skips the cut in the panel's time; the transition key after it moves with the footage", () => {
  const { after, retimed } = cut(film(), [{ op: "trim_item", item: "a", edge: "end", frames: 30 }]);
  const panel = item(after, "panel");
  assert.equal(panel.start, 0);
  assert.equal(panel.duration, 270);
  assert.deepEqual(panel.skips, [{ at: 120, frames: 30 }]);
  // The panel shows its frame 119 next to footage frame 119 and its frame 150 where b now starts (120).
  assert.equal(graphicLocal(panel, 119), 119);
  assert.equal(graphicLocal(panel, 120), 150);
  assert.equal(graphicLocal(panel, 269), 299);
  assert.equal(graphicInfo(panel, after.canvas, graphicLocal(panel, 0)).duration, 300, "render(t, info) still sees the graphic's whole length");
  // The fade out that started at 200 starts at 170 now, and still ends at 0.
  assert.deepEqual(
    panel.keys!.filter((k) => k.frame >= 160).map((k) => [k.frame, k.opacity]),
    [
      [170, 1],
      [180, 0],
    ],
  );
  assert.deepEqual(retimed, [{ id: "panel", src: "graphics/panel.html", frames: 30, cuts: 1, at: 120 }]);
});

test("a cut inside a clip (split and trim, as transcript_edit does) and a deleted clip; later cuts compose with earlier skips", () => {
  const first = cut(film(), [
    { op: "split_item", item: "a", at: 50, newId: "a-2" },
    { op: "trim_item", item: "a-2", edge: "start", frames: 20 },
  ]);
  const p1 = item(first.after, "panel");
  assert.deepEqual(p1.skips, [{ at: 50, frames: 20 }]);
  assert.equal(p1.duration, 280);
  // Then b goes (old frames 130–280 now): the panel's last 150 frames of film time go with it.
  const second = cut(first.after, [{ op: "delete_item", item: "b" }]);
  const p2 = item(second.after, "panel");
  assert.equal(p2.duration, 130);
  assert.deepEqual(p2.skips, [{ at: 50, frames: 20 }]);
  assert.equal(graphicLocal(p2, 129), 149);
  // A cut right at the panel's start: its `in` moves on instead of a skip.
  const head = cut(film(), [{ op: "trim_item", item: "a", edge: "start", frames: 15 }]);
  const p3 = item(head.after, "panel");
  assert.equal(p3.in, 15);
  assert.equal(p3.skips, undefined);
  assert.equal(p3.duration, 285);
});

test("a smaller graphic over the cut loses it too; one wholly after it and one the edit changes stay as they are", () => {
  const lower = { id: "lower", type: "graphic", src: "graphics/lower.html", start: 100, duration: 100 } as Item;
  const later = { id: "later", type: "graphic", src: "graphics/later.html", start: 250, duration: 40 } as Item;
  const { after, retimed } = cut(film({}, [lower, later]), [
    { op: "trim_item", item: "a", edge: "end", frames: 30 },
    { op: "update_item", item: "panel", set: { name: "Panel" } },
  ]);
  assert.deepEqual(
    retimed.map((r) => r.id),
    ["lower"],
  );
  assert.deepEqual([item(after, "lower").start, item(after, "lower").duration, item(after, "lower").skips], [100, 70, [{ at: 20, frames: 30 }]]);
  assert.equal(item(after, "later").start, 250, "free items after a cut stay where they are, as before");
  assert.equal(item(after, "panel").duration, 300, "the edit's own change to the panel wins");
});

test("only pure ripple cuts re-time: an insert, a reorder, a slip or a kept gap changes no graphic", () => {
  const base = film();
  const none = (ops: ReadonlyArray<Op>) => assert.deepEqual(withGraphicRetime(base, ops).retimed, [], JSON.stringify(ops));
  none([{ op: "insert_item", track: "main", index: 1, item: { id: "c", type: "clip", media: "m-cam", in: 900, duration: 30 } }]);
  none([{ op: "move_item", item: "b", index: 0 }]);
  none([{ op: "update_item", item: "b", set: { in: 420 } }]);
  none([
    { op: "delete_item", item: "a" },
    { op: "update_item", item: "b", set: { gap: 150 } },
  ]);
  none([{ op: "update_item", item: "panel", set: { start: 10 } }]);
  assert.deepEqual(rippleSpans(base, apply(base, [{ op: "trim_item", item: "b", edge: "start", frames: 10 }])), [{ at: 150, frames: 10 }]);
});

test("the engine keeps skips through a trimmed start, a trimmed end and a split", () => {
  const skipped = film({ skips: [{ at: 120, frames: 30 }], duration: 270, keys: [] });
  const trimmed = item(apply(skipped, [{ op: "trim_item", item: "panel", edge: "start", frames: 130 }]), "panel");
  assert.equal(trimmed.in, 160);
  assert.equal(trimmed.skips, undefined);
  const early = item(apply(skipped, [{ op: "trim_item", item: "panel", edge: "start", frames: 20 }]), "panel");
  assert.deepEqual([early.in, early.skips], [20, [{ at: 100, frames: 30 }]]);
  assert.equal(graphicLocal(early, 100), 150);
  const short = item(apply(skipped, [{ op: "trim_item", item: "panel", edge: "end", frames: 160 }]), "panel");
  assert.equal(short.skips, undefined);
  const halves = apply(skipped, [{ op: "split_item", item: "panel", at: 200, newId: "panel-2" }]);
  assert.deepEqual(item(halves, "panel").skips, [{ at: 120, frames: 30 }]);
  assert.equal(item(halves, "panel-2").in, 230);
  assert.equal(item(halves, "panel-2").skips, undefined);
  assert.deepEqual(validateProject(halves, modules), []);
});
