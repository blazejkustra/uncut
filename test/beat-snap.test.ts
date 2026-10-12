// Phase 5 chunk 6 (D70): beats as snap targets on the timeline, without the app. A beat at t seconds
// of the media sits at start + (t·fps − in) / speed on the timeline (wrapping when the item loops);
// moves snap to other items' beats, trims to the trimmed item's own beats too (also past its
// current end), except a main clip trimmed from the start (its content shifts); the playhead snaps
// to beats; beats closer than MIN_BEAT_PX on screen are neither drawn nor targets.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../packages/core/src/index.ts";
import { beatsInItem, beatTargets, MIN_BEAT_PX, planMove, planTrim, snapPlayhead, snapTargets, trimSnapTargets, visibleBeats, type BeatMap } from "../apps/web/src/edit.ts";

const FPS = 30;
// Beats every half second from 1 s: media frames 30, 45, 60, … of m-song (20 s long).
const SONG = Array.from({ length: 38 }, (_, i) => 1 + i * 0.5);
// The drum loop's beats: 0, 0.5, 1, 1.5 s of a 2 s file.
const LOOP = [0, 0.5, 1, 1.5];
const beats: BeatMap = new Map([
  ["m-song", SONG],
  ["m-loop", LOOP],
  ["m-cam", [2.2, 3.3]],
]);
const project: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: FPS },
  media: [
    { id: "m-song", kind: "audio", name: "song.wav", path: "/song.wav", probe: { frames: 600, hasAudio: true } },
    { id: "m-loop", kind: "audio", name: "loop.wav", path: "/loop.wav", probe: { frames: 60, hasAudio: true } },
    { id: "m-cam", kind: "video", name: "cam.mp4", path: "/cam.mp4", probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: true } },
    { id: "m-mute", kind: "video", name: "mute.mp4", path: "/mute.mp4", probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: false } },
  ],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "title", type: "text", start: 200, duration: 30, text: "Title" }] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "cam", type: "clip", media: "m-cam", in: 30, duration: 90 },
        { id: "mute", type: "clip", media: "m-mute", in: 0, duration: 60 },
      ],
    },
    {
      id: "audio",
      kind: "audio",
      name: "Audio",
      items: [
        { id: "song", type: "audio", media: "m-song", in: 15, start: 30, duration: 300 },
        { id: "drums", type: "audio", media: "m-loop", in: 0, start: 400, duration: 150, loop: true },
      ],
    },
  ],
} as Project;
const item = (id: string) => project.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;
// Zoomed in: a beat every 15 frames is 30 px apart at 2 px a frame.
const near = { beats, ppf: 2 };

test("a beat's place on the timeline: (t·fps − in) / speed from the item's start, wrapped when it loops", () => {
  // song: in 15, so media frame 30 (1 s) is 15 frames in; the last beat inside 300 frames is at 285.
  const song = beatsInItem(project, item("song"), SONG);
  assert.deepEqual(song.slice(0, 3), [15, 30, 45]);
  assert.equal(song.at(-1), 285);
  assert.ok(song.every((f) => f >= 0 && f < 300));
  // At double speed the beats come twice as often.
  assert.deepEqual(beatsInItem(project, { ...item("song"), speed: 2 }, SONG).slice(0, 3), [7.5, 15, 22.5]);
  // A looped 2 s file (60 frames) over 150 frames: its four beats, again every 60 frames.
  assert.deepEqual(beatsInItem(project, item("drums"), LOOP), [0, 15, 30, 45, 60, 75, 90, 105, 120, 135]);
  // A clip with sound has beats; one without, or text, has none.
  assert.deepEqual(beatsInItem(project, item("cam"), [2.2, 3.3]).map((f) => Math.round(f * 1000) / 1000), [36, 69]);
  assert.deepEqual(beatsInItem(project, item("mute"), [2, 3]), []);
  assert.deepEqual(beatsInItem(project, item("title"), [2, 3]), []);
});

test("too close on screen: no ticks and no beat targets", () => {
  assert.equal(MIN_BEAT_PX, 12);
  // 15 frames apart: 30 px at ppf 2 (shown), 7.5 px at ppf 0.5 (hidden).
  assert.equal(visibleBeats(project, item("song"), SONG, 2).length, 19);
  assert.deepEqual(visibleBeats(project, item("song"), SONG, 0.5), []);
  assert.deepEqual(beatTargets(project, { beats, ppf: 0.3 }), [], "cam's beats (33 frames apart) hidden too at 10 px");
  assert.ok(beatTargets(project, near).length > 0);
  assert.deepEqual(beatTargets(project, undefined), []);
});

test("moves snap to other items' beats, never to their own", () => {
  const targets = snapTargets(project, 0, "title", near);
  // song's beats on the timeline: 30 + 15 = 45, 60, … 315; cam's at 36 and 69 (main starts at 0).
  for (const f of [45, 60, 315, 36, 69]) assert.ok(targets.includes(f), `${f} is a target`);
  // The title dragged to 238 sticks to the beat at 240 (2 frames, within a 3-frame threshold).
  const plan = planMove(project, "title", "text", 238, { targets, threshold: 3 }) as { start: number; snapAt: number };
  assert.equal(plan.start, 240);
  assert.equal(plan.snapAt, 240);
  // Without beats it doesn't (nothing else within reach).
  assert.equal((planMove(project, "title", "text", 238, { targets: snapTargets(project, 0, "title"), threshold: 3 }) as { start: number }).start, 238);
  // Moving the song itself: its own beats move with it, so they're not targets (cam's still are).
  const own = snapTargets(project, 0, "song", near);
  assert.ok(!own.includes(45) && !own.includes(75));
  assert.ok(own.includes(36));
});

test("trims snap to beats, the trimmed item's own included (past its current end too)", () => {
  // The song's end (330) dragged out to 343: the next beat of its own media is at 345.
  const end = trimSnapTargets(project, 0, "song", "end", near);
  assert.ok(end.includes(345), "a beat past the current end");
  assert.ok(!end.includes(330), "not its own edge");
  const plan = planTrim(project, "song", "end", 13, { targets: end, threshold: 3 }) as { duration: number; snapAt: number };
  assert.equal(plan.duration, 315);
  assert.equal(plan.snapAt, 345);
  // Its start on a free track: start and in move together, so its beats stay put (and earlier
  // media is reachable: media frame 0 + … → the beat at 1 s is at 45, the one at 0.5 s isn't a beat).
  const start = trimSnapTargets(project, 0, "song", "start", near);
  assert.ok(start.includes(45) && start.includes(60));
  // A main clip trimmed from the start keeps its start and shifts its content: its beats move.
  const camStart = trimSnapTargets(project, 0, "cam", "start", near);
  assert.ok(!camStart.includes(36) && !camStart.includes(69), JSON.stringify(camStart));
  // Its end: its own beats stay (36, 69, and further into its media: 3.3 s… none, 2 beats only), and the song's count too.
  const camEnd = trimSnapTargets(project, 0, "cam", "end", near);
  assert.ok(camEnd.includes(36) && camEnd.includes(69) && camEnd.includes(45));
});

test("the playhead snaps to the nearest beat within the threshold", () => {
  assert.deepEqual(snapPlayhead(project, 58.6, near, 3), { frame: 60, snapAt: 60 });
  assert.deepEqual(snapPlayhead(project, 52, near, 3), { frame: 52 });
  assert.deepEqual(snapPlayhead(project, 58.6, { beats, ppf: 0.3 }, 12), { frame: 58.6 }, "too close together at this zoom");
  assert.deepEqual(snapPlayhead(project, 58.6, undefined, 3), { frame: 58.6 });
});
