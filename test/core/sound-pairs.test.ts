// Timeline v2 phase 3 (D349): a video with sound goes on the timeline as a linked pair, the clip
// (muted) and its sound on an audio track, from every placement path; a linked sound crossfades
// across a main-track transition as the clip's own sound did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, audibleAt, createSession, layout, loadModules, validateProject, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import {
  insertedClips,
  linkIndex,
  planDetachAudio,
  planPlaceMedia,
  planPutOnMain,
  takenIds,
  withSoundPairs,
} from "../../packages/core/src/timeline/arrange.ts";
import { planAddAtPlayhead, planAddMedia, planDropMedia, type Planned } from "../../apps/web/src/state/project.ts";
import { copyItems, planPaste } from "../../apps/web/src/timeline/clipboard.ts";
import { isLinkSelection, withLinkMates } from "../../apps/web/src/timeline/edit.ts";
import { linkedOps } from "../helpers/links.ts";

const modules = await loadModules("spec/modules/builtin");
const talk = { frames: 600, fps: 30, width: 320, height: 180, hasAudio: true };
const silent = { frames: 600, fps: 30, width: 320, height: 180, hasAudio: false };

const project = (main: Array<Item> = [], extra: Array<Project["tracks"][number]> = []): Project => ({
  format: "uncut/0",
  name: "Pairs",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "talk", kind: "video", name: "talk.mp4", path: "/talk.mp4", probe: talk },
    { id: "broll", kind: "video", name: "broll.mp4", path: "/broll.mp4", probe: silent },
  ],
  tracks: [
    ...extra.filter((t) => t.kind !== "audio"),
    { id: "main", kind: "video", role: "main", name: "Main", items: main },
    ...extra.filter((t) => t.kind === "audio"),
  ],
});

const applied = (p: Project, ops: ReadonlyArray<unknown>) => {
  const next = applyEdit(createSession(p), { actor: "user", ops: linkedOps(p, ops as ReadonlyArray<Op>) }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
};
const opsOf = (plan: Planned) => {
  if ("problem" in plan) throw new Error(plan.problem);
  return plan.ops;
};
const find = (p: Project, id: string) => {
  for (const track of p.tracks) for (const item of track.items) if (item.id === id) return { item, track };
  throw new Error(`no ${id}`);
};
/** The sound linked to clip `id`: on an audio track, the same stretch of the same media. */
function pairOf(p: Project, id: string) {
  const clip = find(p, id);
  const link = linkIndex(p.tracks).keyOf.get(id);
  assert.ok(link, `${id} is linked`);
  const mates = linkIndex(p.tracks)
    .members.get(link)!
    .filter((m) => m.item.id !== id);
  assert.equal(mates.length, 1);
  const sound = mates[0]!;
  const starts = layout(p).starts;
  assert.equal(clip.item.mute, true);
  assert.equal(sound.track.kind, "audio");
  assert.equal(sound.item.type, "audio");
  assert.equal(sound.item.media, clip.item.media);
  assert.equal(sound.item.in ?? 0, clip.item.in ?? 0);
  assert.equal(starts.get(sound.item.id), starts.get(id));
  assert.equal(sound.item.duration, clip.item.duration);
  return sound;
}

test("D349: a video with sound dropped on an empty timeline lands as a V1 clip and its linked sound on a new A1; one without sound stays a clip", () => {
  const p = applied(project(), opsOf(planDropMedia(project(), "talk", { frame: 0 })));
  const clip = p.tracks.find((t) => t.role === "main")!.items[0]!;
  const sound = pairOf(p, clip.id);
  assert.equal(sound.track.name, "Audio");
  assert.equal(p.tracks.filter((t) => t.kind === "audio").length, 1);

  const b = applied(p, opsOf(planDropMedia(p, "broll", { frame: 900 })));
  const broll = b.tracks.flatMap((t) => t.items).find((i) => i.media === "broll")!;
  assert.equal(broll.mute, undefined);
  assert.equal(linkIndex(b.tracks).keyOf.has(broll.id), false);
  assert.equal(b.tracks.flatMap((t) => t.items).filter((i) => i.type === "audio").length, 1);
});

test("D349: dropped between two V1 pairs, the new sound goes on A1 between their sounds (the later one moves with its clip)", () => {
  let p = project();
  p = applied(p, opsOf(planAddMedia(p, "talk", 0, { in: 0, frames: 90 })));
  p = applied(p, opsOf(planAddMedia(p, "talk", 0, { in: 300, frames: 90 })));
  const [a, b] = p.tracks.find((t) => t.role === "main")!.items;
  p = applied(p, opsOf(planDropMedia(p, "talk", { frame: 89, track: "main", range: { in: 150, frames: 60 } })));
  const main = p.tracks.find((t) => t.role === "main")!.items;
  assert.deepEqual(
    main.map((i) => i.id),
    [a!.id, main[1]!.id, b!.id],
  );
  const audio = p.tracks.filter((t) => t.kind === "audio");
  assert.equal(audio.length, 1, "no second audio track");
  for (const clip of main) assert.equal(pairOf(p, clip.id).track.id, audio[0]!.id);
  assert.equal(layout(p).starts.get(pairOf(p, b!.id).item.id), 150);
});

test("D349: Add to timeline and the source viewer's Add In to Out place the marked stretch as a pair", () => {
  const p = applied(project(), opsOf(planAddMedia(project(), "talk", 0, { in: 120, frames: 45 })));
  const clip = p.tracks.find((t) => t.role === "main")!.items[0]!;
  assert.equal(clip.in, 120);
  assert.equal(pairOf(p, clip.id).item.in, 120);
});

test("D349: Add at playhead puts a generated video above V1 with its sound linked", () => {
  const base = project([{ id: "c1", type: "clip", media: "broll", in: 0, duration: 300 }]);
  const plan = planAddAtPlayhead(base, "talk", 60);
  if ("problem" in plan) throw new Error(plan.problem);
  const p = applied(base, plan.ops);
  const placed = find(p, plan.itemId);
  assert.notEqual(placed.track.role, "main");
  pairOf(p, plan.itemId);
});

test("D349: Put on V1 gives a clip that plays its own sound its sound on an audio track, linked; an already linked clip keeps its pair", () => {
  const overlay = {
    id: "v2",
    kind: "video" as const,
    name: "Video 2",
    items: [{ id: "o", type: "clip" as const, media: "talk", in: 30, start: 0, duration: 60 }],
  };
  const base = project([{ id: "c1", type: "clip", media: "broll", in: 0, duration: 120 }], [overlay]);
  const plan = planPutOnMain(base, "o", { frame: 120 });
  if ("problem" in plan) throw new Error(plan.problem);
  const p = applied(base, plan.ops);
  assert.equal(find(p, "o").track.role, "main");
  pairOf(p, "o");

  const again = planPutOnMain(p, pairOf(p, "o").item.id);
  assert.ok("problem" in again, "a sound stays on its track");
});

test("D349: a muted, ramped or reversed video stays one clip", () => {
  const p = project();
  for (const extra of [{ mute: true }, { reverse: true }]) {
    const ops: Array<Op> = [{ op: "insert_item", track: "main", item: { id: "x", type: "clip", media: "talk", in: 0, duration: 60, ...extra } as Item }];
    const next = applied(p, ops);
    assert.equal(linkIndex(next.tracks).keyOf.has("x"), false);
  }
});

test("D349: ⌘C ⌘V of a pair pastes a pair of its own, the sound under where the clip lands", () => {
  let p = project();
  p = applied(p, opsOf(planAddMedia(p, "talk", 0, { in: 0, frames: 90 })));
  const clip = p.tracks.find((t) => t.role === "main")!.items[0]!;
  const sound = pairOf(p, clip.id);
  const plan = planPaste(p, copyItems(p, [clip.id, sound.item.id]), 30);
  if ("problem" in plan) throw new Error(plan.problem);
  p = applied(p, plan.ops);
  const pasted = plan.ids.find((id) => find(p, id).item.type === "clip")!;
  const mate = pairOf(p, pasted);
  assert.notEqual(linkIndex(p.tracks).keyOf.get(pasted), linkIndex(p.tracks).keyOf.get(clip.id));
  assert.equal(layout(p).starts.get(mate.item.id), 90);
  assert.equal(linkIndex(p.tracks).members.get(linkIndex(p.tracks).keyOf.get(clip.id)!)!.length, 2);
});

test("D349: a click selects a clip with its linked sound, and that selection counts as the clip alone", () => {
  const p = applied(project(), opsOf(planAddMedia(project(), "talk")));
  const clip = p.tracks.find((t) => t.role === "main")!.items[0]!;
  const sound = pairOf(p, clip.id).item.id;
  assert.deepEqual(withLinkMates(p, clip.id), [clip.id, sound]);
  assert.deepEqual(withLinkMates(p, sound), [sound, clip.id]);
  assert.equal(isLinkSelection(p, [sound, clip.id]), true);
  assert.equal(isLinkSelection(p, [clip.id]), false);
  assert.equal(isLinkSelection(p, [clip.id, sound, "title"]), false);
});

/** Two V1 clips of `talk` meeting under a transition, their sound in the clips (clip-owned). */
const transitionProject = (module: string): Project =>
  project([
    { id: "a", type: "clip", media: "talk", in: 0, duration: 90 },
    { id: "b", type: "clip", media: "talk", in: 300, duration: 90, transitionIn: { module, duration: 20 } },
  ]);
/** The same with each clip's sound detached onto A1 and linked (what a placement now makes). */
function paired(p: Project): Project {
  let next = p;
  for (const id of ["a", "b"]) {
    const plan = planDetachAudio(next, id, takenIds(next));
    if ("problem" in plan) throw new Error(plan.problem);
    next = applied(next, plan.ops);
  }
  return next;
}
/** What sounds at frame f, as [media, source seconds, gain] in a stable order. */
const heard = (p: Project, f: number) =>
  audibleAt(p, layout(p).starts, f)
    .filter((a) => a.gain > 0)
    .map((a) => [a.item.media, Math.round(a.source * 1e6), Math.round(a.gain * 1e9)] as const)
    .sort();

test("D349: linked sound crossfades and dips across a V1 transition exactly as the clips' own sound did", () => {
  for (const module of ["transition.crossfade", "transition.dip-to-black"]) {
    const owned = transitionProject(module);
    const pairs = paired(owned);
    assert.equal(pairs.tracks.filter((t) => t.kind === "audio")[0]!.items.length, 2);
    for (let f = 0; f < 180; f += 0.5) assert.deepEqual(heard(pairs, f), heard(owned, f), `${module} at ${f}`);
    const overlap = heard(pairs, 90);
    assert.equal(overlap.length, module === "transition.crossfade" ? 2 : 0, module);
  }
});

test("D349: a J cut's edge (the sound's start moved off the cut) has no crossfade; the other edge keeps it", () => {
  const pairs = paired(transitionProject("transition.crossfade"));
  const bSound = linkIndex(pairs.tracks)
    .members.get(linkIndex(pairs.tracks).keyOf.get("b")!)!
    .find((m) => m.item.id !== "b")!.item;
  const aSound = linkIndex(pairs.tracks)
    .members.get(linkIndex(pairs.tracks).keyOf.get("a")!)!
    .find((m) => m.item.id !== "a")!.item;
  const ops: Array<Op> = [
    { op: "trim_item", item: aSound.id, edge: "end", frames: 30, solo: true },
    { op: "trim_item", item: bSound.id, edge: "start", frames: -30, solo: true },
  ];
  const j = applyEdit(createSession(pairs), { actor: "user", ops }).project;
  const at = (f: number) => audibleAt(j, layout(j).starts, f).filter((a) => a.gain > 0);
  assert.deepEqual(
    at(65).map((a) => a.item.id),
    [bSound.id],
    "b's sound alone from its own start",
  );
  assert.equal(at(65)[0]!.gain, 1, "no crossfade on an edge that left the cut");
});

test("D349: a file imported and dropped in one edit (a Finder drop) lands as a pair", () => {
  const empty: Project = { ...project(), media: [] };
  const entry = { id: "m-new", kind: "video" as const, name: "New.mp4", path: "/New.mp4", probe: talk };
  const plan = planPlaceMedia(empty, [entry], { frame: 0, track: "main" }, takenIds(empty));
  if ("problem" in plan) throw new Error(plan.problem);
  const ops: Array<Op> = [{ op: "add_media", media: entry }, ...plan.ops];
  const p = applied(empty, withSoundPairs(empty, ops, insertedClips(plan.ops)));
  pairOf(p, plan.placed[0]!.itemId);
});
