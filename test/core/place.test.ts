// D114: where a take recorded on this Mac goes on the timeline, in the same edit as its add_media
// (core planPlaceTake): a voiceover on a free Voiceover track at the playhead (a new one when none
// is free, never a music track, never shifted), a camera or screen take on a free video track
// above Main at the playhead (else a new Recordings track just above Main). Nothing moves.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEdit, createSession, loadModules, validateProject, type Media, type Op, type Project } from "../../packages/core/src/index.ts";
import { planPlaceTake } from "../../packages/core/src/timeline/place.ts";

const modules = await loadModules("spec/modules/builtin");
const base: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: true } },
    { id: "song", kind: "audio", name: "song.m4a", path: "/song.m4a", probe: { frames: 900, hasAudio: true } },
  ],
  tracks: [
    { id: "overlay", kind: "video", name: "Overlay", items: [{ id: "o1", type: "clip", media: "m", in: 0, start: 0, duration: 60 }] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "m", in: 0, duration: 300 }] },
    { id: "music", kind: "audio", name: "Music", items: [{ id: "s1", type: "audio", media: "song", in: 0, start: 0, duration: 300 }] },
  ],
};
const ids = (p: Project) => new Set([...p.media.map((m) => m.id), ...p.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)])]);
const take = (id: string, kind: Media["kind"], frames: number): Media => ({
  id,
  kind,
  name: `${id}.m4a`,
  path: `media/captures/${id}`,
  probe: { frames, hasAudio: true },
});

/** add_media + the placement, as one edit, validated. */
function place(p: Project, media: Media, frame: number, placement: "voiceover" | "video") {
  const taken = ids(p);
  taken.add(media.id);
  const plan = planPlaceTake(p, { mediaId: media.id, frames: media.probe!.frames!, frame, placement }, taken);
  const ops: Array<Op> = [{ op: "add_media", media }, ...plan.ops];
  const s = applyEdit(createSession(p), { actor: "user", ops });
  assert.deepEqual(validateProject(s.project, modules), []);
  return { project: s.project, plan };
}
const itemOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t.id, trackName: t.name }))).find((i) => i.id === id)!;

test("a voiceover goes on a new Voiceover track at the playhead, never on the music track", () => {
  const { project, plan } = place(base, take("vo1", "audio", 75), 45, "voiceover");
  const item = itemOf(project, plan.itemId);
  assert.equal(item.trackName, "Voiceover");
  assert.equal(item.start, 45);
  assert.equal(item.duration, 75);
  assert.equal(item.media, "vo1");
  assert.equal(project.tracks.find((t) => t.id === "music")!.items.length, 1, "the music track is untouched");
  assert.equal(project.tracks.filter((t) => t.kind === "audio").length, 2);

  // A second take later on the same track: it's free there, so it goes on it.
  const second = place(project, take("vo2", "audio", 30), 150, "voiceover");
  assert.equal(itemOf(second.project, second.plan.itemId).track, plan.trackId);
  assert.equal(second.plan.ops.length, 1, "no new track");

  // A take over the first one: a second Voiceover track, at the same frame (not shifted).
  const third = place(project, take("vo3", "audio", 60), 60, "voiceover");
  const t3 = itemOf(third.project, third.plan.itemId);
  assert.equal(t3.trackName, "Voiceover 2");
  assert.equal(t3.start, 60);
});

test("a locked Voiceover track is skipped; ids never clash", () => {
  const locked: Project = { ...base, tracks: [...base.tracks, { id: "voiceover-1", kind: "audio", name: "Voiceover", locked: true, items: [] }] };
  const { project, plan } = place(locked, take("vo", "audio", 30), 0, "voiceover");
  assert.notEqual(plan.trackId, "voiceover-1");
  assert.equal(itemOf(project, plan.itemId).trackName, "Voiceover 2");
});

test("a camera or screen take starts at the playhead on a free track above Main, else a new Recordings track", () => {
  // Overlay is busy 0-60: a take at 30 gets a new Recordings track, just above Main.
  const busy = place(base, take("cam", "video", 90), 30, "video");
  const item = itemOf(busy.project, busy.plan.itemId);
  assert.equal(item.trackName, "Recordings");
  assert.equal(item.start, 30);
  assert.equal(item.type, "clip");
  const order = busy.project.tracks.map((t) => t.id);
  assert.equal(order.indexOf(busy.plan.trackId), order.indexOf("main") - 1);
  // At 100 the overlay track is free: it goes there.
  const free = place(base, take("cam2", "video", 90), 100, "video");
  assert.equal(itemOf(free.project, free.plan.itemId).track, "overlay");
  assert.equal(free.plan.ops.length, 1);
  // Main never moves.
  assert.deepEqual(free.project.tracks.find((t) => t.id === "main")!.items, base.tracks[1]!.items);
});
