// A custom-range export of a graphic (the launch-film rehearsal: an 18–28 s export drew the
// graphic's 0–10 s). The range is the project sliced (core sliceProject), which trims each item's
// start; a graphic had no source time, so its trimmed start was lost. Now a graphic's own time runs
// from its `in` (core graphicLocal):
// - the slice gives the graphic `in` = what it cut off, as it gives the music and a clip;
// - the plan draws the graphic's frames from there (and motion blur's sub-frames at those times),
//   render(t, info) gets a duration counted from the graphic's start;
// - a graphic overlay that starts inside the range is untouched, one that straddles it shifts;
// - splitting a graphic in the editor: the second half goes on from where the first stopped.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEdit, createSession, graphicInfo, graphicLocal, loadModules, validateProject, type Op, type Project } from "../../packages/core/src/index.ts";
import { sliceProject } from "../../packages/core/src/timeline/slice.ts";
import { planExport } from "../../apps/server/src/export/exportPlan.ts";

const modules = await loadModules("spec/modules/builtin");
const fps = 60;
const project: Project = {
  format: "uncut/0",
  name: "Range",
  canvas: { width: 1080, height: 1350, fps },
  media: [
    { id: "song", kind: "audio", name: "song.mp3", path: "/song.mp3", probe: { frames: 1680, hasAudio: true } },
    { id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 3000, fps: 50, width: 3840, height: 2160, hasAudio: false } },
  ],
  tracks: [
    { id: "over", kind: "video", name: "Overlay", items: [{ id: "late", type: "graphic", src: "graphics/late.html", start: 1200, duration: 300 }, { id: "across", type: "graphic", src: "graphics/across.html", start: 900, duration: 300 }] },
    { id: "b", kind: "video", name: "B", items: [{ id: "c", type: "clip", media: "m", in: 50, start: 800, duration: 200 }] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "film", type: "graphic", src: "graphics/film.html", duration: 1680 }] },
    { id: "audio", kind: "audio", name: "Audio", items: [{ id: "music", type: "audio", media: "song", start: 0, in: 0, duration: 1680 }] },
  ],
};
const find = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;

test("an 18–28 s slice: the graphic, the music, a clip and an overlay all start from 18 s of themselves", () => {
  assert.deepEqual(validateProject(project, modules), []);
  const part = sliceProject(project, { from: 18 * fps, to: 28 * fps });
  assert.ok(!("problem" in part), JSON.stringify(part));
  assert.deepEqual(validateProject(part, modules), [], "a graphic with in passes the schema");
  assert.deepEqual([find(part, "film").in, find(part, "film").duration], [1080, 600]);
  assert.deepEqual([find(part, "music").in, find(part, "music").start, find(part, "music").duration], [1080, 0, 600]);
  // The clip ended before the range; the overlay that straddled it shifts like the main graphic; the late one is whole.
  assert.equal(part.tracks.flatMap((t) => t.items).some((i) => i.id === "c"), false);
  assert.deepEqual([find(part, "across").in, find(part, "across").start, find(part, "across").duration], [180, 0, 120]);
  assert.deepEqual([find(part, "late").in, find(part, "late").start], [undefined, 120]);

  const plan = planExport(part, { mediaPath: () => "", width: 1080, height: 1350, graphic: () => "<script>function render(){}</script>", motionBlur: true });
  assert.ok(!("problem" in plan), JSON.stringify(plan));
  const layer = (id: string) => plan.visuals.find((v) => v.item.id === id && v.kind === "graphic") as Extract<(typeof plan.visuals)[number], { kind: "graphic" }>;
  const film = layer("film");
  assert.equal(film.frames[0], 1080, "the graphic's first frame drawn is its 18 s");
  assert.equal(film.frames.at(-1), 1679);
  // Motion blur's sub-frames around the graphic's own time, not the export's.
  assert.ok(film.motion && Math.abs(film.motion.ts[0]![0]! - 18) < 1 / fps, JSON.stringify(film.motion?.ts[0]));
  assert.equal(graphicInfo(film.item, { ...part.canvas, fps }, film.frames[0]!).duration, 1680, "info.duration counts from the graphic's start");
  assert.equal(layer("across").frames[0], 180);
  assert.equal(layer("late").frames.find((_, k) => layer("late").f0 + k >= 120), 0);
});

test("the whole timeline draws as before (no in: frames from 0)", () => {
  const plan = planExport(project, { mediaPath: () => "/x", width: 1080, height: 1350, graphic: () => "<script>function render(){}</script>" });
  assert.ok(!("problem" in plan));
  const film = plan.visuals.find((v) => v.item.id === "film" && v.kind === "graphic") as Extract<(typeof plan.visuals)[number], { kind: "graphic" }>;
  assert.equal(film.frames[0], 0);
  assert.equal(graphicLocal({ duration: 10 }, -5), 0);
  assert.equal(graphicLocal({ duration: 10, in: 30 }, 50), 39);
});

test("splitting a graphic: the second half goes on from where the first stopped", () => {
  const s = applyEdit(createSession(project), { actor: "user", ops: [{ op: "split_item", item: "film", at: 600, newId: "film-2" }] as ReadonlyArray<Op> });
  assert.deepEqual(validateProject(s.project, modules), []);
  assert.equal(find(s.project, "film").in, undefined);
  assert.deepEqual([find(s.project, "film-2").in, find(s.project, "film-2").duration], [600, 1080]);
  const t = applyEdit(createSession(project), { actor: "user", ops: [{ op: "trim_item", item: "film", edge: "start", frames: 120 }] as ReadonlyArray<Op> });
  assert.equal(find(t.project, "film").in, 120);
});
