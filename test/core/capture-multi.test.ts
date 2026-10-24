// D210 / D211: this Mac's sound on a "Mac sound" track (planPlaceTake "system"), and a multi-source
// take (core planPlaceMulti): every part at the playhead in one edit, grouped, the earlier recorders
// trimmed at their head by their start offsets so all begin together, all as long as the shortest;
// the screen on a video track above Main, the camera above it in the layout's box (a corner bubble
// or side by side), the microphone on Voiceover, this Mac's sound on Mac sound.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEdit, createSession, loadModules, validateProject, type Media, type Op, type Project } from "../../packages/core/src/index.ts";
import { alignParts, multiLayoutBoxes, planPlaceMulti, planPlaceTake, type MultiKind, type MultiLayoutName } from "../../packages/core/src/timeline/place.ts";

const modules = await loadModules("spec/modules/builtin");
const base: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: true } }],
  tracks: [
    { id: "overlay", kind: "video", name: "Overlay", items: [{ id: "o1", type: "clip", media: "m", in: 0, start: 0, duration: 60 }] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "m", in: 0, duration: 300 }] },
  ],
};
const ids = (p: Project) => new Set([...p.media.map((m) => m.id), ...p.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)])]);
const media = (id: string, kind: MultiKind, frames: number): Media =>
  kind === "voiceover" || kind === "system"
    ? { id, kind: "audio", name: id, path: `media/captures/t/${id}`, probe: { frames, hasAudio: true } }
    : { id, kind: "video", name: id, path: `media/captures/t/${id}`, probe: { frames, fps: 30, width: 1280, height: 720, hasAudio: false } };
const itemOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t.id, trackName: t.name }))).find((i) => i.id === id)!;

function placeMulti(
  p: Project,
  parts: ReadonlyArray<{ id: string; kind: MultiKind; frames: number; offsetMs: number }>,
  frame: number,
  layout?: MultiLayoutName,
) {
  const taken = ids(p);
  for (const x of parts) taken.add(x.id);
  const plan = planPlaceMulti(
    p,
    { parts: parts.map((x) => ({ mediaId: x.id, kind: x.kind, frames: x.frames, offsetMs: x.offsetMs })), frame, fps: p.canvas.fps, canvas: p.canvas, layout },
    taken,
  );
  const ops: Array<Op> = [...parts.map((x) => ({ op: "add_media", media: media(x.id, x.kind, x.frames) }) as Op), ...plan.ops];
  const s = applyEdit(createSession(p), { actor: "user", ops });
  assert.deepEqual(validateProject(s.project, modules), []);
  return { project: s.project, plan };
}

test("this Mac's sound alone goes on a new Mac sound track at the playhead", () => {
  const taken = ids(base);
  taken.add("sys");
  const plan = planPlaceTake(base, { mediaId: "sys", frames: 90, frame: 30, placement: "system" }, taken);
  const s = applyEdit(createSession(base), { actor: "user", ops: [{ op: "add_media", media: media("sys", "system", 90) }, ...plan.ops] });
  assert.deepEqual(validateProject(s.project, modules), []);
  const item = itemOf(s.project, plan.itemId);
  assert.equal(item.trackName, "Mac sound");
  assert.equal(item.type, "audio");
  assert.equal(item.start, 30);
  assert.equal(item.duration, 90);
});

test("alignParts trims each part by how much earlier its recorder started; all as long as the shortest", () => {
  const { ins, duration } = alignParts(
    [
      { offsetMs: 0, frames: 300 },
      { offsetMs: 40, frames: 299 },
      { offsetMs: 200, frames: 290 },
    ],
    30,
  );
  assert.deepEqual(ins, [6, 5, 0]);
  assert.equal(duration, 290);
  // Bad offsets count as 0.
  assert.deepEqual(
    alignParts(
      [
        { offsetMs: Number.NaN, frames: 10 },
        { offsetMs: -5, frames: 10 },
      ],
      30,
    ).ins,
    [0, 0],
  );
});

test("a four-source take: one edit, grouped, start-aligned, the camera a bubble over the screen", () => {
  const { project, plan } = placeMulti(
    base,
    [
      { id: "scr", kind: "screen", frames: 300, offsetMs: 0 },
      { id: "cam", kind: "camera", frames: 300, offsetMs: 30 },
      { id: "mic", kind: "voiceover", frames: 300, offsetMs: 70 },
      { id: "sys", kind: "system", frames: 300, offsetMs: 100 },
    ],
    15,
    "tr",
  );
  assert.equal(plan.items.length, 4);
  assert.deepEqual(
    plan.items.map((i) => i.kind),
    ["screen", "camera", "voiceover", "system"],
  );
  const items = plan.items.map((i) => itemOf(project, i.itemId));
  // Every part starts at the playhead, as long as the shortest after trimming, all in one group.
  for (const i of items) {
    assert.equal(i.start, 15);
    assert.equal(i.group, plan.group);
    assert.equal(i.duration, 300 - 3);
  }
  // 100 ms (3 frames) after the first recorder: the screen loses 3 frames at its head, the last none.
  assert.deepEqual(
    items.map((i) => i.in),
    [3, 2, 1, 0],
  );
  const [screen, camera, mic, sys] = items;
  assert.equal(screen!.trackName, "Screen", "Overlay isn't free at 15 (its clip runs to 60)");
  const order = project.tracks.map((t) => t.id);
  assert.ok(order.indexOf(camera!.track) < order.indexOf(screen!.track), "the camera is above the screen");
  assert.ok(order.indexOf(screen!.track) < order.indexOf("main"), "the screen is above Main");
  assert.equal(mic!.trackName, "Voiceover");
  assert.equal(sys!.trackName, "Mac sound");
  assert.equal(mic!.type, "audio");
  assert.deepEqual(camera!.transform, { x: 1920 - 43 - 324, y: 43, w: 324, h: 324, fit: "cover", radius: 162 });
  assert.equal(screen!.transform, undefined, "the screen keeps the whole frame");
  // Main is untouched.
  assert.equal(project.tracks.find((t) => t.id === "main")!.items.length, 1);
});

test("the screen goes on a new Screen track when no overlay is free, the camera on a new Camera track above it", () => {
  const { project, plan } = placeMulti(
    base,
    [
      { id: "scr", kind: "screen", frames: 90, offsetMs: 0 },
      { id: "cam", kind: "camera", frames: 95, offsetMs: 0 },
    ],
    0,
    "side",
  );
  const [screen, camera] = plan.items.map((i) => itemOf(project, i.itemId));
  assert.equal(screen!.trackName, "Screen");
  assert.equal(camera!.trackName, "Camera");
  const order = project.tracks.map((t) => t.name);
  assert.deepEqual(order, ["Overlay", "Camera", "Screen", "Main"]);
  assert.equal(screen!.duration, 90);
  assert.equal(camera!.duration, 90);
  assert.deepEqual(screen!.transform, { x: 0, y: 0, w: 1228, h: 1080, fit: "contain" });
  assert.deepEqual(camera!.transform, { x: 1228, y: 0, w: 692, h: 1080, fit: "cover" });
});

test("layout boxes for every preset stay on the canvas", () => {
  for (const layout of ["tl", "tr", "bl", "br", "side"] as const) {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
      [1080, 1350],
    ] as const) {
      const { camera, screen } = multiLayoutBoxes(layout, w, h);
      for (const b of [camera, ...(screen ? [screen] : [])]) {
        assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h, `${layout} ${w}x${h}`);
      }
    }
  }
  assert.deepEqual(multiLayoutBoxes("bl", 1920, 1080).camera, { x: 43, y: 1080 - 43 - 324, w: 324, h: 324, fit: "cover", radius: 162 });
});

test("sound only: the microphone and this Mac's sound on their own tracks, grouped", () => {
  const { project, plan } = placeMulti(
    base,
    [
      { id: "mic", kind: "voiceover", frames: 60, offsetMs: 12 },
      { id: "sys", kind: "system", frames: 61, offsetMs: 0 },
    ],
    100,
  );
  const [mic, sys] = plan.items.map((i) => itemOf(project, i.itemId));
  assert.equal(mic!.trackName, "Voiceover");
  assert.equal(sys!.trackName, "Mac sound");
  assert.equal(mic!.start, 100);
  assert.equal(sys!.start, 100);
  assert.equal(sys!.in, 0, "12 ms rounds to 0 frames at 30 fps");
  assert.equal(mic!.group, sys!.group);
  assert.ok(plan.group);
});

test("this Mac's sound needs macOS 13; tests get a stand-in, only with test media", async () => {
  const { systemAudioSupport, SYSTEM_AUDIO_FEATURES } = await import("../../apps/desktop/src/background.ts");
  assert.deepEqual(systemAudioSupport("darwin", "12.7.4"), { supported: false, macos: "12.7.4" });
  assert.deepEqual(systemAudioSupport("darwin", "13.0"), { supported: true, macos: "13.0" });
  assert.deepEqual(systemAudioSupport("darwin", "26.0"), { supported: true, macos: "26.0" });
  assert.equal(systemAudioSupport("linux", "6.1").supported, false);
  assert.deepEqual(systemAudioSupport("darwin", "12.0", { UNCUT_CDP: "9222", UNCUT_TEST_MEDIA: "fake" }), { supported: true, macos: "15.0", standin: true });
  assert.equal(systemAudioSupport("darwin", "15.0", { UNCUT_CDP: "9222", UNCUT_TEST_MEDIA: "fake", UNCUT_TEST_SYSTEM_AUDIO: "unsupported" }).supported, false);
  assert.equal(
    systemAudioSupport("darwin", "15.0", { UNCUT_TEST_SYSTEM_AUDIO: "unsupported" }).supported,
    true,
    "a stray variable can't change a release user's app",
  );
  assert.equal(SYSTEM_AUDIO_FEATURES, "MacCatapLoopbackAudioForScreenShare");
});
