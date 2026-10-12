// Phase 4 chunk 3 (D52): the timeline's edit planners, without the app. Moves land on the nearest
// free spot and snap; main-track moves reorder; trims clamp to the media and the neighbours;
// split picks the selected item or the main clip under the playhead; locked tracks refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, validateProject, loadModules, type Project } from "../packages/core/src/index.ts";
import { draftOf, nearestFreeSpot, planDelete, planMove, planSplit, planTrackFlag, planTrim, snapTargets, trimSnapTargets } from "../apps/web/src/edit.ts";

const modules = await loadModules("spec/modules/builtin");
const project: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 120, fps: 30, width: 320, height: 180, hasAudio: false } }],
  tracks: [
    {
      id: "text",
      kind: "text",
      name: "Text",
      items: [
        // Array order isn't time order on a free track.
        { id: "late", type: "text", start: 120, duration: 30, text: "Late" },
        { id: "title", type: "text", start: 0, duration: 60, text: "Title" },
      ],
    },
    { id: "text-2", kind: "text", name: "Text 2", items: [] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "m", in: 0, duration: 90 },
        { id: "b", type: "clip", media: "m", in: 10, duration: 60 },
        { id: "c", type: "clip", media: "m", in: 0, duration: 30 },
      ],
    },
    { id: "audio", kind: "audio", name: "Audio", items: [] },
  ],
};
const ok = (plan: object) => {
  assert.ok(!("problem" in plan), JSON.stringify(plan));
  return plan as { ops: Array<any>; [k: string]: any };
};
const apply = (p: Project, plan: object) => {
  const s = applyEdit(createSession(p), { actor: "user", ops: ok(plan).ops });
  assert.deepEqual(validateProject(s.project, modules), []);
  return s.project;
};
const item = (p: Project, id: string) => p.tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t.id }))).find((i) => i.id === id)!;

test("moves on a free track land on the nearest free spot; snapping sticks either edge", () => {
  assert.equal(nearestFreeSpot(project.tracks[0]!, "title", 100, 60), 60, "pushed left of 'late'");
  assert.equal(nearestFreeSpot(project.tracks[0]!, "title", 130, 60), 150, "pushed after 'late'");
  let plan = ok(planMove(project, "title", "text", 62));
  assert.deepEqual(plan.ops, [{ op: "move_item", item: "title", start: 60 }]);
  assert.equal(item(apply(project, plan), "title").start, 60);
  // 3 frames from the playhead (at 200), within a 4-frame threshold: the start sticks to it.
  plan = ok(planMove(project, "title", "text", 197, { targets: snapTargets(project, 200, "title"), threshold: 4 }));
  assert.equal(plan.start, 200);
  assert.equal(plan.snapAt, 200);
  // The end edge snaps too: end at 148 → 150 (late's end).
  plan = ok(planMove(project, "title", "text-2", 88, { targets: [150], threshold: 4 }));
  assert.deepEqual(plan.ops, [{ op: "move_item", item: "title", track: "text-2", start: 90 }]);
  assert.equal(plan.snapAt, 150);
  // Text can't go on main, and nothing moves to where it already is.
  assert.ok("problem" in planMove(project, "title", "main", 10));
  assert.deepEqual(ok(planMove(project, "title", "text", 0.4)).ops, []);
});

test("main-track moves reorder by the slot under the item's middle (index after removal)", () => {
  // a (0–90) dragged right so its middle passes b's and c's middles: last.
  let plan = ok(planMove(project, "a", "main", 120));
  assert.deepEqual(plan.ops, [{ op: "move_item", item: "a", index: 2 }]);
  assert.deepEqual(apply(project, plan).tracks[2]!.items.map((i) => i.id), ["b", "c", "a"]);
  plan = ok(planMove(project, "c", "main", 0));
  assert.deepEqual(apply(project, plan).tracks[2]!.items.map((i) => i.id), ["c", "a", "b"]);
  assert.deepEqual(ok(planMove(project, "b", "main", 50)).ops, [], "still in its own slot");
});

test("trims clamp to one frame, the media and the neighbours; main ripples, free tracks move the start", () => {
  // Left edge of b (in 10) can extend at most 10 frames.
  let plan = ok(planTrim(project, "b", "start", -25));
  assert.deepEqual(plan.ops, [{ op: "trim_item", item: "b", edge: "start", frames: -10 }]);
  let p = apply(project, plan);
  assert.deepEqual([item(p, "b").in, item(p, "b").duration], [0, 70]);
  // Right edge of b: in 10 + 60 → at most 120 frames of media, so 50 more.
  plan = ok(planTrim(project, "b", "end", 500));
  assert.deepEqual(plan.ops, [{ op: "trim_item", item: "b", edge: "end", frames: -50 }]);
  // Left trim of a by 30: in 30, duration 60, and b now starts at 60 (ripple).
  p = apply(project, ok(planTrim(project, "a", "start", 30)));
  assert.deepEqual([item(p, "a").in, item(p, "a").duration], [30, 60]);
  assert.equal((draftOf(p, []) as { project: Project }).project.tracks[2]!.items[1]!.id, "b");
  // At least one frame.
  assert.equal(ok(planTrim(project, "c", "end", -100)).duration, 1);
  // Text: the left edge moves the start, never before 0 or into the item before it.
  plan = ok(planTrim(project, "late", "start", -100));
  assert.deepEqual([plan.start, plan.duration], [60, 90], "stops at the end of 'title'");
  plan = ok(planTrim(project, "title", "end", 100));
  assert.equal(plan.duration, 120, "stops at the start of 'late'");
  // An edge snaps to the playhead.
  plan = ok(planTrim(project, "late", "end", 18, { targets: [0, 170], threshold: 4 }));
  assert.deepEqual([plan.duration, plan.snapAt], [50, 170]);
});

test("split: the selected item under the playhead, else the main clip there; delete; locks refuse", () => {
  let plan = ok(planSplit(project, undefined, 100));
  assert.deepEqual(plan.ops, [{ op: "split_item", item: "b", at: 10, newId: "b-1" }]);
  const p = apply(project, plan);
  assert.deepEqual([item(p, "b").duration, item(p, "b-1").in, item(p, "b-1").duration], [10, 20, 50]);
  plan = ok(planSplit(project, "title", 30));
  assert.deepEqual(plan.ops, [{ op: "split_item", item: "title", at: 30, newId: "title-1" }]);
  assert.ok("problem" in planSplit(project, "title", 90), "selected but not under the playhead");
  assert.ok("problem" in planSplit(project, undefined, 90), "on a cut, nothing to split");
  assert.deepEqual(ok(planDelete(project, "a")).ops, [{ op: "delete_item", item: "a" }]);
  const locked = apply(project, planTrackFlag(project, "text", "locked"));
  assert.equal(locked.tracks[0]!.locked, true);
  for (const plan of [planMove(locked, "title", "text", 70), planTrim(locked, "title", "end", 5), planSplit(locked, "title", 10), planDelete(locked, "title")]) {
    assert.match((plan as { problem: string }).problem, /locked/);
  }
  assert.ok("problem" in planMove(project, "title", "text-2", 0) === false);
  assert.ok("problem" in planMove(apply(project, planTrackFlag(project, "text-2", "locked")), "title", "text-2", 0), "can't move onto a locked track");
  assert.equal(apply(locked, planTrackFlag(locked, "text", "locked")).tracks[0]!.locked, undefined, "unlock removes the flag");
  const muted = apply(project, planTrackFlag(project, "audio", "mute"));
  assert.deepEqual(muted.tracks[3]!.mixer, { mute: true });
  assert.deepEqual(apply(muted, planTrackFlag(muted, "audio", "mute")).tracks[3]!.mixer, { mute: false });
});

// Review fixes (2026-10-12): transitions, snapping on main, images, speed, animations, locked items.
const withTransition: Project = {
  ...project,
  media: [{ id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: false } }],
  tracks: [
    project.tracks[0]!,
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "m", in: 0, duration: 90 },
        { id: "b", type: "clip", media: "m", in: 20, duration: 90, transitionIn: { module: "transition.crossfade", duration: 10 } },
        { id: "c", type: "clip", media: "m", in: 0, duration: 30 },
      ],
    },
  ],
};
/** Applies with the full validator: a plan must never be one the server refuses. */
const applyValid = (p: Project, plan: object) => apply(p, plan);

test("transitions on main: trims clamp to handles and twice the transition, split refuses near one, delete and move drop the ones at changed cuts", () => {
  assert.deepEqual(validateProject(withTransition, modules), []);
  // a's end can extend only until 5 frames (half the crossfade) of media are left after it.
  let plan = ok(planTrim(withTransition, "a", "end", 500));
  assert.equal(plan.duration, 295);
  applyValid(withTransition, plan);
  // b's start can extend only until 5 frames of media are left before its in-point.
  plan = ok(planTrim(withTransition, "b", "start", -500));
  assert.deepEqual(plan.ops, [{ op: "trim_item", item: "b", edge: "start", frames: -15 }]);
  applyValid(withTransition, plan);
  // a and b can't get shorter than 20 frames (twice the crossfade).
  assert.equal(ok(planTrim(withTransition, "a", "end", -500)).duration, 20);
  assert.equal(ok(planTrim(withTransition, "b", "start", 500)).duration, 20);
  applyValid(withTransition, planTrim(withTransition, "a", "start", 500));
  // Split a at 88/89 or b at 92: too close to the crossfade.
  for (const f of [80, 88, 89, 92, 95]) assert.match((planSplit(withTransition, undefined, f) as { problem: string }).problem, /transition/, `split at ${f}`);
  assert.ok(!("problem" in planSplit(withTransition, undefined, 60)));
  applyValid(withTransition, planSplit(withTransition, undefined, 60));
  applyValid(withTransition, planSplit(withTransition, undefined, 130));
  // Delete a: b would be first, so its transition goes too (one edit).
  let p = applyValid(withTransition, planDelete(withTransition, "a"));
  assert.deepEqual(p.tracks[1]!.items.map((i) => [i.id, !!i.transitionIn]), [["b", false], ["c", false]]);
  // Move b first, or a last: the transitions at the cuts that change go.
  p = applyValid(withTransition, planMove(withTransition, "b", "main", 0));
  assert.deepEqual(p.tracks[1]!.items.map((i) => i.id), ["b", "a", "c"]);
  p = applyValid(withTransition, planMove(withTransition, "a", "main", 300));
  assert.deepEqual(p.tracks[1]!.items.map((i) => [i.id, !!i.transitionIn]), [["b", false], ["c", false], ["a", false]]);
  // draftOf refuses what the server would, with a sentence (here: a 10-frame transition into an 8-frame clip).
  const bad = draftOf(withTransition, [{ op: "trim_item", item: "a", edge: "end", frames: 82 }]);
  assert.match((bad as { problem: string }).problem, /^Can't do that: .*transition/);
});

test("snapping on main: a small trim isn't pulled back to the clip's own edge or a rippling neighbour", () => {
  // b's end (150) is c's start; c's end (180) ripples with it. Neither is a target.
  const targets = trimSnapTargets(project, 0, "b", "end");
  assert.ok(!targets.includes(150) && !targets.includes(180), JSON.stringify(targets));
  const plan = ok(planTrim(project, "b", "end", -3, { targets, threshold: 6 }));
  assert.deepEqual(plan.ops, [{ op: "trim_item", item: "b", edge: "end", frames: 3 }]);
  // b's start (90) is a's end: not a target either, so a 2-frame left trim happens.
  assert.ok(!trimSnapTargets(project, 0, "b", "start").includes(90));
  assert.deepEqual(ok(planTrim(project, "b", "start", 2, { targets: trimSnapTargets(project, 0, "b", "start"), threshold: 6 })).ops, [{ op: "trim_item", item: "b", edge: "start", frames: 2 }]);
  // The playhead still is.
  assert.equal(ok(planTrim(project, "b", "end", -3, { targets: trimSnapTargets(project, 145, "b", "end"), threshold: 6 })).duration, 55);
});

test("images extend to the left freely; speed scales the source in trims and splits", () => {
  const p: Project = {
    ...project,
    media: [...project.media, { id: "img", kind: "image", name: "a.png", path: "/a.png", probe: { width: 100, height: 100 } }],
    tracks: [
      project.tracks[0]!,
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "i", type: "clip", media: "img", in: 0, duration: 30 }, { id: "f", type: "clip", media: "m", in: 0, duration: 40, speed: 2 }] },
    ],
  };
  let plan = ok(planTrim(p, "i", "start", -20));
  assert.deepEqual(plan.ops, [{ op: "trim_item", item: "i", edge: "start", frames: -20 }]);
  let after = applyValid(p, plan);
  assert.deepEqual([item(after, "i").in, item(after, "i").duration], [0, 50]);
  // At 2x, 40 frames use 80 of 120 source frames: the end can add 20 timeline frames.
  assert.equal(ok(planTrim(p, "f", "end", 100)).duration, 60);
  after = applyValid(p, planTrim(p, "f", "start", 10));
  assert.deepEqual([item(after, "f").in, item(after, "f").duration], [20, 30]);
  after = applyValid(p, planSplit(p, "f", 40));
  assert.deepEqual([item(after, "f-1").in, item(after, "f-1").duration], [20, 30]);
});

test("split keeps the in-animation and fade-in on the first half, the out ones on the second, keys in their half; trims respect them", () => {
  const anim: Project = {
    ...project,
    tracks: [
      {
        id: "text",
        kind: "text",
        name: "Text",
        items: [
          {
            id: "t",
            type: "text",
            start: 0,
            duration: 90,
            text: "Hi",
            animation: { in: { module: "move.fade", duration: 15 }, out: { module: "move.fade", duration: 20 } },
            keys: [{ frame: 0, opacity: 0 }, { frame: 30, opacity: 1 }, { frame: 80, opacity: 0.5 }],
          },
        ],
      },
      { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      { id: "audio", kind: "audio", name: "Audio", items: [{ id: "s", type: "audio", media: "snd", start: 0, duration: 60, fadeIn: 10, fadeOut: 10, gainKeys: [{ frame: 50, db: -6 }] }] },
    ],
    media: [{ id: "snd", kind: "audio", name: "s.wav", path: "/s.wav", probe: { frames: 600 } }],
  };
  assert.deepEqual(validateProject(anim, modules), []);
  let p = applyValid(anim, planSplit(anim, "t", 30));
  assert.deepEqual(item(p, "t").animation, { in: { module: "move.fade", duration: 15 } });
  assert.deepEqual(item(p, "t-1").animation, { out: { module: "move.fade", duration: 20 } });
  assert.deepEqual(item(p, "t").keys!.map((k) => k.frame), [0, 30]);
  assert.deepEqual(item(p, "t-1").keys!.map((k) => k.frame), [0, 50]);
  p = applyValid(anim, planSplit(anim, "s", 20));
  // A key at the cut on both halves keeps the envelope's value there (−6 dB: held before the first key).
  assert.deepEqual([item(p, "s").fadeIn, item(p, "s").fadeOut, item(p, "s").gainKeys], [10, undefined, [{ frame: 20, db: -6 }]]);
  assert.deepEqual([item(p, "s-1").fadeIn, item(p, "s-1").fadeOut, item(p, "s-1").gainKeys], [undefined, 10, [{ frame: 0, db: -6 }, { frame: 30, db: -6 }]]);
  // The end can't cut below the last key (80); the start trim moves keys with it.
  assert.equal(ok(planTrim(anim, "t", "end", -500)).duration, 80);
  p = applyValid(anim, planTrim(anim, "t", "start", 60));
  // (D75: a keyed value cut off at the new start gets a key there, so it doesn't jump.)
  assert.deepEqual([item(p, "t").duration, item(p, "t").keys!.map((k) => k.frame)], [30, [0, 20]]);
  assert.equal(ok(planTrim(anim, "s", "end", -500)).duration, 50, "the gain key at 50");
});

test("a locked item on an unlocked track can't be edited, and the ops around it are refused", () => {
  const p: Project = { ...project, tracks: project.tracks.map((t) => (t.id === "text" ? { ...t, items: t.items.map((i) => (i.id === "title" ? { ...i, locked: true } : i)) } : t)) };
  for (const plan of [planMove(p, "title", "text", 70), planTrim(p, "title", "end", 5), planSplit(p, "title", 10), planDelete(p, "title")]) {
    assert.match((plan as { problem: string }).problem, /locked/);
  }
  assert.ok(!("problem" in planMove(p, "late", "text", 200)), "its neighbour still moves");
});

test("the playhead can rest at the end (D56): End, seeking and stepping reach it; adding there appends after everything", async () => {
  // Never playing here, so the animation-frame clock is never started; reset() still cancels it.
  globalThis.cancelAnimationFrame ??= () => {};
  const { playback, getPlayback } = await import("../apps/web/src/playback.ts");
  const { planAddText, TEXT_PRESETS } = await import("../apps/web/src/project.ts");
  const { planAddBackground } = await import("../apps/web/src/text.ts");
  // A 4 s clip on main: 120 frames, playback over 0–119, the end at 120.
  const clip: Project = {
    ...project,
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m", in: 0, duration: 120 }] },
    ],
  };
  playback.reset();
  playback.setProject(120, 30, 120);
  playback.toEnd();
  assert.equal(getPlayback().frame, 120, "End goes after the last frame");
  playback.step(1);
  assert.equal(getPlayback().frame, 120, "and no further");
  playback.seek(500);
  assert.equal(getPlayback().frame, 120);
  playback.step(-1);
  assert.equal(getPlayback().frame, 119);
  // Text and a background added there go after the clip; the background onto main.
  const text = planAddText(clip, TEXT_PRESETS[0], 120);
  assert.ok("ops" in text);
  assert.equal(text.start, 120);
  const bg = planAddBackground(clip, { color: "#000000" }, 120, undefined);
  assert.ok("ops" in bg);
  assert.deepEqual(bg.ops, [{ op: "insert_item", track: "main", item: { id: "background-1", type: "component", component: "component.solid", duration: 90, props: { color: "#000000" } } }]);
  // The project grows: the playhead stays; it shrinks past the playhead: the new last frame.
  playback.toEnd();
  playback.setProject(210, 30, 210);
  assert.equal(getPlayback().frame, 120);
  playback.toEnd();
  playback.setProject(90, 30, 90);
  assert.equal(getPlayback().frame, 90, "to the new end, where the next thing added goes");
  // An empty project: frame 0 only.
  playback.setProject(1, 30, 0);
  playback.toEnd();
  assert.equal(getPlayback().frame, 0);
});
