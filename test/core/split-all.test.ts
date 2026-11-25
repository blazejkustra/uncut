// Timeline v2 phase 1 (D346): split all tracks at the playhead (⇧⌘K, and S with nothing
// selected) on a project with clips on V1, V2 and A1, and the tracks' V1/A1 codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, validateProject, loadModules, type Project } from "../../packages/core/src/index.ts";
import { withLinkedAudio } from "../../packages/core/src/timeline/arrange.ts";
import { planSplit, planSplitAll, planTrackFlag } from "../../apps/web/src/timeline/edit.ts";
import { isDefaultTrackName, trackCodes } from "../../apps/web/src/state/project.ts";

const modules = await loadModules("spec/modules/builtin");
const project: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "cam", kind: "video", name: "cam.mp4", path: "/cam.mp4", probe: { frames: 600, fps: 30, width: 320, height: 180, hasAudio: true } },
    { id: "screen", kind: "video", name: "screen.mp4", path: "/screen.mp4", probe: { frames: 600, fps: 30, width: 320, height: 180, hasAudio: false } },
    { id: "music", kind: "audio", name: "music.m4a", path: "/music.m4a", probe: { frames: 600, fps: 30, hasAudio: true } },
  ],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "title", type: "text", start: 0, duration: 60, text: "Hi" }] },
    { id: "screen-track", kind: "video", name: "Video 2", items: [{ id: "shot", type: "clip", media: "screen", in: 0, start: 30, duration: 120 }] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "cam", in: 0, duration: 90, mute: true },
        { id: "b", type: "clip", media: "cam", in: 100, duration: 90 },
      ],
    },
    {
      id: "voice",
      kind: "audio",
      name: "Audio",
      items: [{ id: "a-sound", type: "audio", media: "cam", in: 0, start: 0, duration: 90, linkedTo: "a" }],
    },
    { id: "bed", kind: "audio", name: "Music", items: [{ id: "song", type: "audio", media: "music", in: 0, start: 0, duration: 300 }] },
  ],
};

const ok = (plan: object) => {
  assert.ok(!("problem" in plan), JSON.stringify(plan));
  return plan as { ops: Array<{ op: string; item: string; at: number; newId: string }>; newIds: Array<string>; summary: string };
};
const apply = (p: Project, plan: object) => {
  const s = applyEdit(createSession(p), { actor: "user", ops: withLinkedAudio(p, ok(plan).ops as never) });
  assert.deepEqual(validateProject(s.project, modules), []);
  return s.project;
};
const items = (p: Project) => p.tracks.flatMap((t) => t.items.map((i) => ({ track: t.id, id: i.id, start: i.start, duration: i.duration })));

test("split all: every unlocked item under the playhead on V1, V2 and A1 in one edit; a linked sound splits with its clip", () => {
  assert.deepEqual(validateProject(project, modules), []);
  const plan = ok(planSplitAll(project, 45));
  assert.deepEqual(
    plan.ops.map((o) => [o.item, o.at]),
    [
      ["title", 45],
      ["shot", 15],
      ["a", 45],
      ["song", 45],
    ],
    "a-sound isn't cut on its own: it follows a",
  );
  assert.equal(new Set(plan.newIds).size, 4, "a new id per piece");
  assert.equal(plan.summary, "Split 4 items at the playhead");
  const after = apply(project, plan);
  const counts = Object.fromEntries(after.tracks.map((t) => [t.id, t.items.length]));
  assert.deepEqual(counts, { text: 2, "screen-track": 2, main: 3, voice: 2, bed: 2 }, JSON.stringify(items(after)));
  const voice = after.tracks.find((t) => t.id === "voice")!.items;
  assert.deepEqual(
    voice.map((i) => [i.start, i.duration]),
    [
      [0, 45],
      [45, 45],
    ],
    "the linked sound is cut where its clip is",
  );
});

test("split all: S with nothing selected does the same; a selection still splits only itself", () => {
  assert.deepEqual(ok(planSplit(project, undefined, 45)).ops, ok(planSplitAll(project, 45)).ops);
  assert.deepEqual(
    ok(planSplit(project, "song", 45)).ops.map((o) => o.item),
    ["song"],
  );
});

test("split all: locked tracks and items stay whole, captions aren't cut, nothing under the playhead says so", () => {
  const locked = apply(project, planTrackFlag(project, "screen-track", "locked"));
  assert.deepEqual(
    ok(planSplitAll(locked, 45)).ops.map((o) => o.item),
    ["title", "a", "song"],
  );
  assert.match((planSplitAll(project, 400) as { problem: string }).problem, /playhead over an item/);
  assert.deepEqual(
    ok(planSplitAll(project, 90)).ops.map((o) => o.item),
    ["shot", "song"],
    "on the cut between a and b only what runs across it",
  );
});

test("split all: a cut too close to a V1 transition refuses the whole split", () => {
  const withTransition: Project = {
    ...project,
    tracks: project.tracks.map((t) =>
      t.id === "main" ? { ...t, items: [t.items[0]!, { ...t.items[1]!, transitionIn: { module: "transition.crossfade", duration: 10 } }] } : t,
    ),
  };
  assert.deepEqual(validateProject(withTransition, modules), []);
  assert.match((planSplitAll(withTransition, 85) as { problem: string }).problem, /transition/);
  assert.equal(ok(planSplitAll(withTransition, 45)).ops.length, 4);
});

test("track codes: the main track is V1, picture tracks above it V2, V3 from the bottom up, sound A1, A2 from the top", () => {
  const codes = trackCodes(project);
  assert.deepEqual(Object.fromEntries(codes), { main: "V1", "screen-track": "V2", text: "V3", voice: "A1", bed: "A2" });
  assert.deepEqual(["Main", "Video", "Video 2", "Audio 3", "Text", "Music", "Camera"].map(isDefaultTrackName), [true, true, true, true, false, false, false]);
});
