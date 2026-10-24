// Feedback round 1, chunk B planners: media on any track (T1, D122), several audio tracks (T6,
// D124), detach audio (T3, D123), speed (G9, D125), group move / ripple delete / new tracks (T8,
// T7, D126), a part of the timeline as its own project (G7, D127).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyEdit,
  audibleAt,
  createSession,
  layout,
  loadModules,
  soundMedia,
  subtitleCues,
  validateProject,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";
import { planDetachAudio, planPlaceMedia, planSetSpeed, takenIds } from "../../packages/core/src/timeline/arrange.ts";
import { sliceProject } from "../../packages/core/src/timeline/slice.ts";
import { planGroupMove, planMove, planMoveToNewTrack, planRippleDelete, snapTargets } from "../../apps/web/src/timeline/edit.ts";
import { planDropMedia } from "../../apps/web/src/state/project.ts";

const modules = await loadModules("spec/modules/builtin");
const base: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 600, fps: 30, width: 320, height: 180, hasAudio: true } },
    { id: "mute", kind: "video", name: "b.mp4", path: "/b.mp4", probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: false } },
    { id: "song", kind: "audio", name: "song.m4a", path: "/song.m4a", probe: { frames: 900, hasAudio: true } },
    { id: "pic", kind: "image", name: "p.png", path: "/p.png", probe: { width: 100, height: 100 } },
  ],
  tracks: [
    { id: "overlay", kind: "video", name: "Overlay", items: [{ id: "o1", type: "clip", media: "m", in: 0, start: 0, duration: 60 }] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "m", in: 0, duration: 150, gainDb: -3, fadeOut: 10 },
        { id: "b", type: "clip", media: "m", in: 200, duration: 150, transitionIn: { module: "transition.crossfade", duration: 10 } },
      ],
    },
    { id: "music", kind: "audio", name: "Music", items: [{ id: "s1", type: "audio", media: "song", in: 0, start: 0, duration: 300 }] },
  ],
};
const valid = (p: Project) => assert.deepEqual(validateProject(p, modules), []);
const apply = (p: Project, ops: ReadonlyArray<unknown>) => {
  const s = applyEdit(createSession(p), { actor: "user", ops: ops as ReadonlyArray<Op> });
  valid(s.project);
  return s.project;
};
const find = (p: Project, id: string) => {
  for (const t of p.tracks) {
    const i = t.items.find((x) => x.id === id);
    if (i) return { ...i, track: t.id };
  }
  return undefined;
};

test("T1: a video dropped on an overlay lane lands there at the drop frame; on main in the nearest slot", () => {
  const over = planDropMedia(base, "m", { frame: 100, track: "overlay" });
  assert.ok(!("problem" in over));
  const p = apply(base, over.ops);
  assert.equal(find(p, over.itemId)!.track, "overlay");
  assert.equal(find(p, over.itemId)!.start, 100);
  // Dropped where something is: the nearest free spot.
  const busy = planDropMedia(base, "m", { frame: 10, track: "overlay" });
  assert.ok(!("problem" in busy));
  assert.equal(find(apply(base, busy.ops), busy.itemId)!.start, 60);
  // Main: between a and b (the drop is past a's middle).
  const main = planDropMedia(base, "mute", { frame: 140, track: "main" });
  assert.ok(!("problem" in main));
  const pm = apply(base, main.ops);
  assert.deepEqual(
    pm.tracks[1]!.items.map((i) => i.id),
    ["a", main.itemId, "b"],
  );
  assert.equal(main.start, 150);
  // A video on an audio lane: its sound; a silent one isn't taken there (it goes above main instead).
  const sound = planDropMedia(base, "m", { frame: 400, track: "music" });
  assert.ok(!("problem" in sound));
  assert.equal(find(apply(base, sound.ops), sound.itemId)!.type, "audio");
  const silent = planDropMedia(base, "mute", { frame: 400, track: "music" });
  assert.ok(!("problem" in silent));
  assert.equal(find(apply(base, silent.ops), silent.itemId)!.type, "clip");
});

test("T1: a clip moves from main to an overlay and back; off main it loses its transition and ripple", () => {
  const off = planMove(base, "b", "overlay", 200);
  assert.ok(!("problem" in off));
  const p = apply(base, off.ops);
  const b = find(p, "b")!;
  assert.equal(b.track, "overlay");
  assert.equal(b.start, 200);
  assert.equal(b.transitionIn, undefined);
  assert.deepEqual(
    p.tracks[1]!.items.map((i) => i.id),
    ["a"],
  );
  const back = planMove(p, "b", "main", 0);
  assert.ok(!("problem" in back));
  const q = apply(p, back.ops);
  assert.deepEqual(
    q.tracks[1]!.items.map((i) => i.id),
    ["b", "a"],
  );
  assert.equal(find(q, "b")!.start, undefined);
  // Dragged above the top lane: a new video track on top.
  const fresh = planMoveToNewTrack(base, "a", "top", 30);
  assert.ok(!("problem" in fresh));
  const r = apply(base, fresh.ops);
  assert.equal(r.tracks[0]!.id, fresh.track);
  assert.equal(r.tracks[0]!.kind, "video");
  assert.equal(find(r, "a")!.start, 30);
  assert.equal(find(r, "b")!.transitionIn, undefined, "b now opens main: its transition goes");
});

test("T6: sounds at the playhead each get a free audio track, a new one when all are busy", () => {
  const one = planPlaceMedia(base, [base.media[2]!], { frame: 100 }, takenIds(base));
  assert.ok(!("problem" in one));
  const p = apply(base, one.ops);
  const track = p.tracks.find((t) => t.id === one.placed[0]!.trackId)!;
  assert.equal(track.kind, "audio");
  assert.notEqual(track.id, "music", "Music is busy at 100");
  assert.equal(track.name, "Audio");
  assert.equal(one.placed[0]!.start, 100);
  // After the music ends, the Music track is free again.
  const later = planPlaceMedia(base, [base.media[2]!], { frame: 300 }, takenIds(base));
  assert.ok(!("problem" in later));
  assert.equal(later.placed[0]!.trackId, "music");
  // Three sounds over each other: three tracks, all heard at once.
  let q = p;
  const two = planPlaceMedia(q, [base.media[2]!], { frame: 120 }, takenIds(q));
  assert.ok(!("problem" in two));
  q = apply(q, two.ops);
  assert.equal(q.tracks.filter((t) => t.kind === "audio").length, 3);
  assert.equal(q.tracks.at(-1)!.name, "Audio 2");
  const heard = audibleAt(q, layout(q).starts, 150).filter((a) => a.item.type === "audio");
  assert.equal(heard.length, 3);
});

test("T3: detach audio makes an audio item from the clip's sound and mutes the clip; preview mix and export agree", () => {
  const plan = planDetachAudio(base, "a", takenIds(base));
  assert.ok(!("problem" in plan));
  const p = apply(base, plan.ops);
  const clip = find(p, "a")!;
  const audio = find(p, plan.itemId)!;
  assert.equal(clip.mute, true);
  assert.equal(clip.gainDb, undefined);
  assert.equal(clip.fadeOut, undefined);
  assert.equal(audio.type, "audio");
  assert.equal(audio.media, "m");
  assert.equal(audio.in, 0);
  assert.equal(audio.start, 0);
  assert.equal(audio.duration, 150);
  assert.equal(audio.gainDb, -3);
  assert.equal(audio.fadeOut, 10);
  assert.notEqual(audio.track, "music", "Music is busy there");
  // The clip makes no sound now; its sound plays from the audio item.
  assert.equal(soundMedia(p, find(p, "a")!), undefined);
  const heard = audibleAt(p, layout(p).starts, 50)
    .map((x) => x.item.id)
    .sort();
  assert.deepEqual(heard, [plan.itemId, "o1", "s1"].sort());
  // Independent: it can move and be trimmed on its own.
  const moved = apply(p, [
    { op: "update_item", item: plan.itemId, set: { start: 400 } },
    { op: "trim_item", item: plan.itemId, edge: "end", frames: 50 },
  ]);
  assert.equal(find(moved, plan.itemId)!.start, 400);
  assert.equal(find(moved, "a")!.duration, 150);
  // Twice: refused.
  assert.ok("problem" in planDetachAudio(p, "a", takenIds(p)));
  // A silent clip has nothing to detach.
  const silent = apply(base, [{ op: "insert_item", track: "overlay", item: { id: "s", type: "clip", media: "mute", in: 0, start: 100, duration: 30 } }]);
  assert.ok("problem" in planDetachAudio(silent, "s", takenIds(silent)));
  // Old projects (no mute field) sound exactly as before.
  assert.deepEqual(
    audibleAt(base, layout(base).starts, 50)
      .map((x) => x.item.id)
      .sort(),
    ["a", "o1", "s1"],
  );
});

test("G9: speed keeps the media stretch, so the length changes; keepPitch round-trips; images refused", () => {
  const twice = planSetSpeed(base, "a", 2);
  assert.ok(!("problem" in twice));
  const p = apply(base, twice.ops);
  const a = find(p, "a")!;
  assert.equal(a.speed, 2);
  assert.equal(a.duration, 75);
  assert.equal(layout(p).starts.get("b"), 75, "main ripples");
  // Slower than the media allows: clamped to the media's end.
  const slow = planSetSpeed(base, "b", 0.25);
  assert.ok(!("problem" in slow));
  const q = apply(base, slow.ops);
  assert.equal(find(q, "b")!.duration, 600);
  // Pitch follows the speed when asked, and back.
  const tape = planSetSpeed(p, "a", 2, false);
  assert.ok(!("problem" in tape));
  const r = apply(p, tape.ops);
  assert.equal(find(r, "a")!.keepPitch, false);
  const back = planSetSpeed(r, "a", 1, true);
  assert.ok(!("problem" in back));
  const s = apply(r, back.ops);
  assert.equal(find(s, "a")!.speed, undefined);
  assert.equal(find(s, "a")!.keepPitch, undefined);
  assert.equal(find(s, "a")!.duration, 150);
  // Audio items have a speed too (D125).
  const song = planSetSpeed(base, "s1", 1.5);
  assert.ok(!("problem" in song));
  assert.equal(find(apply(base, song.ops), "s1")!.duration, 200);
  const pic = apply(base, [{ op: "insert_item", track: "overlay", item: { id: "p1", type: "clip", media: "pic", start: 100, duration: 60 } }]);
  assert.ok("problem" in planSetSpeed(pic, "p1", 2));
  // A free item that would run into its neighbour is refused.
  const tight = apply(base, [{ op: "insert_item", track: "overlay", item: { id: "o2", type: "clip", media: "m", in: 0, start: 60, duration: 30 } }]);
  assert.ok("problem" in planSetSpeed(tight, "o1", 0.5));
});

test("T8: a group moves by the same frames and lanes (main clips along, #58), refuses collisions; ripple delete closes free gaps", () => {
  const p = apply(base, [
    { op: "add_track", track: { id: "v2", kind: "video", name: "V2" }, index: 0 },
    { op: "insert_item", track: "overlay", item: { id: "o2", type: "clip", media: "m", in: 0, start: 100, duration: 30 } },
    { op: "insert_item", track: "music", item: { id: "s2", type: "audio", media: "song", in: 0, start: 400, duration: 60 } },
  ]);
  const lanes = ["v2", "overlay", "main", "music"];
  const group = planGroupMove(p, ["o1", "o2"], 20, 0, lanes);
  assert.ok(!("problem" in group));
  const q = apply(p, group.ops);
  assert.equal(find(q, "o1")!.start, 20);
  assert.equal(find(q, "o2")!.start, 120);
  // Up one lane: both onto V2, offsets kept.
  const up = planGroupMove(p, ["o1", "o2"], 0, -1, lanes);
  assert.ok(!("problem" in up));
  const r = apply(p, up.ops);
  assert.equal(find(r, "o1")!.track, "v2");
  assert.equal(find(r, "o2")!.start, 100);
  // Snapping: the group edge nearest a target sticks to it (o2's end to a's end at 150, over o1's start to the playhead at 21).
  const snapped = planGroupMove(p, ["o1", "o2"], 18, 0, lanes, { targets: snapTargets(p, 21, new Set(["o1", "o2"])), threshold: 4 });
  assert.ok(!("problem" in snapped));
  assert.equal(snapped.delta, 20);
  assert.equal(snapped.snapAt, 150);
  const toPlayhead = planGroupMove(p, ["o1"], 18, 0, lanes, { targets: snapTargets(p, 21, new Set(["o1"])), threshold: 4 });
  assert.ok(!("problem" in toPlayhead));
  assert.equal(toPlayhead.snapAt, 21);
  // #58 (D229): a main clip moves along with the rest (in time, staying on Main).
  const withMain = planGroupMove(p, ["o1", "a"], 10, 0, lanes);
  assert.ok(!("problem" in withMain));
  const m = apply(p, withMain.ops);
  assert.equal(find(m, "o1")!.start, 10);
  assert.equal(find(m, "a")!.track, "main");
  assert.ok("problem" in planGroupMove(p, ["s1"], 120, 0, lanes), "s2 is in the way");
  // Ripple delete on a free track: the later item moves left by the deleted length.
  const rip = planRippleDelete(p, ["o1"]);
  assert.ok(!("problem" in rip));
  const t = apply(p, rip.ops);
  assert.equal(find(t, "o2")!.start, 40);
  assert.equal(find(t, "o1"), undefined);
  // Markers are snap targets (T8).
  assert.ok(snapTargets({ ...p, markers: [{ frame: 77 }] }, 0, "o1").includes(77));
});

test("G7: a part of the timeline is a project of its own: cut exactly, shifted, transitions at the edges dropped", () => {
  const withSubs = apply(base, [
    { op: "add_track", track: { id: "subs", kind: "text", name: "Subtitles" }, index: 0 },
    { op: "insert_item", track: "subs", item: { id: "t1", type: "text", text: "Hi", start: 90, duration: 120 } },
  ]);
  const part = sliceProject({ ...withSubs, markers: [{ frame: 200 }, { frame: 10 }] }, { from: 100, to: 250 });
  assert.ok(!("problem" in part));
  valid(part);
  assert.equal(layout(part).duration, 150);
  const main = part.tracks.find((t) => t.role === "main")!;
  assert.deepEqual(
    main.items.map((i) => [i.id, i.in, i.duration]),
    [
      ["a", 100, 50],
      ["b", 200, 100],
    ],
  );
  assert.equal(main.items[1]!.transitionIn?.duration, 10, "the crossfade at 150 is inside the range: kept");
  const edge = sliceProject(base, { from: 148, to: 250 });
  assert.ok(!("problem" in edge));
  assert.equal(edge.tracks.find((t) => t.role === "main")!.items[1]!.transitionIn, undefined, "its blend would start before the range: a clean cut");
  assert.equal(find(part, "o1"), undefined, "the overlay ended before the range");
  assert.equal(find(part, "s1")!.start, 0);
  assert.equal(find(part, "s1")!.in, 100);
  assert.equal(find(part, "s1")!.duration, 150);
  assert.equal(find(part, "t1")!.start, 0);
  assert.equal(find(part, "t1")!.duration, 110);
  assert.deepEqual(part.markers, [{ frame: 100 }]);
  // The subtitles file follows the range: the cue starts at 0.
  assert.equal(subtitleCues(part)[0]?.from, 0);
  assert.ok("problem" in sliceProject(base, { from: 5000, to: 6000 }));
});

test("T3 (D123): a linked detached sound follows its clip: transcript cuts, ripple, speed; unlinked once moved", async () => {
  const { planTextCut } = await import("../../packages/core/src/index.ts");
  const { withLinkedAudio } = await import("../../packages/core/src/timeline/arrange.ts");
  const words = [
    { text: "Hello", start: 0.5, end: 1.0 },
    { text: "um", start: 1.2, end: 1.5 },
    { text: "this", start: 1.6, end: 2.0 },
  ];
  const talk: Project = {
    ...base,
    media: [
      { id: "m-talk", kind: "video", name: "Talk.mp4", path: "/Talk.mp4", probe: { frames: 180, fps: 30, width: 320, height: 180, hasAudio: true } },
      base.media[0]!,
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "intro", type: "clip", media: "m", in: 0, duration: 30 },
          { id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 180 },
        ],
      },
      { id: "fx", kind: "audio", name: "FX", items: [] },
    ],
  };
  const edit = (p: Project, ops: ReadonlyArray<Op>) => apply(p, withLinkedAudio(p, ops));
  const det = planDetachAudio(talk, "clip-1", takenIds(talk));
  assert.ok(!("problem" in det));
  const p = apply(talk, det.ops);
  assert.equal(find(p, det.itemId)!.linkedTo, "clip-1");
  // The transcript cut of "um" (media frames 36–45) cuts the detached sound too: it's never heard.
  const cut = planTextCut(p, "m-talk", { words, language: "en", seconds: 6 }, { remove: [{ from: 1, to: 1 }] });
  assert.ok(!("problem" in cut));
  const q = edit(p, cut.ops);
  const sounds = q.tracks.flatMap((t) => t.items.filter((i) => i.type === "audio" && i.media === "m-talk"));
  assert.deepEqual(
    sounds.map((i) => [i.start, i.in, i.duration]).sort((a, b) => a[0]! - b[0]!),
    [
      [30, 0, 36],
      [66, 45, 135],
    ],
  );
  const starts = layout(q).starts;
  for (let f = 30; f < 30 + 171; f += 3) {
    const heard = audibleAt(q, starts, f).filter((a) => a.item.media === "m-talk");
    assert.equal(heard.length, 1, `one talk sound at ${f}`);
    const s = heard[0]!.source * 30;
    assert.ok(s < 36 || s >= 45, `the cut word isn't heard at ${f} (source frame ${s})`);
  }
  // A ripple on main (the intro deleted): the sounds move with their clips.
  const r = edit(q, [{ op: "delete_item", item: "intro" }]);
  assert.deepEqual(
    r.tracks
      .flatMap((t) => t.items.filter((i) => i.type === "audio" && i.media === "m-talk"))
      .map((i) => i.start)
      .sort((a, b) => a! - b!),
    [0, 36],
  );
  // Speed on the clip: the sound keeps up.
  const sp = planSetSpeed(r, "clip-1", 2);
  assert.ok(!("problem" in sp));
  const s2 = edit(r, sp.ops);
  assert.deepEqual([find(s2, det.itemId)!.speed, find(s2, det.itemId)!.duration], [2, 18]);
  // Moved by hand: unlinked, and the clip's next change leaves it alone.
  const moved = edit(s2, [{ op: "update_item", item: det.itemId, set: { start: 300 } }]);
  assert.equal(find(moved, det.itemId)!.linkedTo, undefined);
  const after = edit(moved, [{ op: "delete_item", item: "clip-1" }]);
  assert.equal(find(after, det.itemId)!.start, 300, "an unlinked sound stays when its clip goes");
  // A linked sound goes with its clip.
  const gone = edit(s2, [{ op: "delete_item", item: "clip-1" }]);
  assert.equal(find(gone, det.itemId), undefined);
});

test("G4: renaming media doesn't change what the checks think it is (music by its file, not its name)", async () => {
  const { projectChecks } = await import("../../packages/core/src/index.ts");
  const song: Project = {
    ...base,
    tracks: [base.tracks[1]!, { id: "fx", kind: "audio", name: "FX", items: [{ id: "s1", type: "audio", media: "song", in: 0, start: 0, duration: 300 }] }],
  };
  const fades = (p: Project) => projectChecks(p, { rules: [] }).filter((c) => c.id === "music-fades").length;
  assert.equal(fades(song), 1, "song.m4a is music");
  const renamed = { ...song, media: song.media.map((m) => (m.id === "song" ? { ...m, name: "Intro" } : m)) };
  assert.equal(fades(renamed), 1, "still music after a rename");
  const named = { ...song, media: song.media.map((m) => (m.id === "song" ? { ...m, path: "/fx.m4a", name: "My song" } : m)) };
  assert.equal(fades(named), 0, "a display name alone doesn't make it music");
});

test("T3: detach skips a muted or soloed-out audio track", () => {
  const free = apply(base, [{ op: "trim_item", item: "s1", edge: "end", frames: 200 }]);
  const ok = planDetachAudio(free, "b", takenIds(free));
  assert.ok(!("problem" in ok));
  assert.equal(ok.trackId, "music", "Music is free from 100 on");
  const p = apply(free, [{ op: "update_track", track: "music", set: { mixer: { mute: true } } }]);
  // Music is free from 150 on; b (150–300) would fit there, but it's muted.
  const det = planDetachAudio(p, "b", takenIds(p));
  assert.ok(!("problem" in det));
  assert.notEqual(det.trackId, "music");
});

test("G7: the export range falls back to the whole timeline, and says so, when its marks or selection are gone", async () => {
  const { effectiveRange } = await import("../../apps/web/src/panels/exportRange.ts");
  const custom = { from: 0, to: 10 };
  assert.deepEqual(effectiveRange("marks", { marks: { from: 3, to: 9 }, custom }), { kind: "marks", range: { from: 3, to: 9 } });
  assert.deepEqual(effectiveRange("marks", { custom }), { kind: "all", fellBack: "marks" });
  assert.deepEqual(effectiveRange("selection", { custom }), { kind: "all", fellBack: "selection" });
  assert.deepEqual(effectiveRange("custom", { custom }), { kind: "custom", range: custom });
  assert.deepEqual(effectiveRange("all", { marks: { from: 1, to: 2 }, custom }), { kind: "all" });
});
