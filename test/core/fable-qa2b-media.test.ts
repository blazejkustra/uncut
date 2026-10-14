// Fable QA round 2, Media/Audio chunk (F8, F27; D167, D169) without the app: removing a media with
// the items that use it, and Fit to video, each applied with the engine and checked by the validator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { componentDefaults, applyEdit, createSession, EditError, loadModules, validateOps, validateProject, describeOp, type Op, type Project } from "../../packages/core/src/index.ts";
import { fitFadeOut, mediaUses, planFitToVideo, planRemoveMedia, usedMediaIds, videoEnd } from "../../packages/core/src/timeline/mediaPlan.ts";

const modules = await loadModules("spec/modules/builtin");
const dir = mkdtempSync(join(tmpdir(), "uncut-media-"));
const clipFile = join(dir, "a.mp4");
writeFileSync(clipFile, "not really a video");

const base: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m", kind: "video", name: "a.mp4", path: clipFile, probe: { frames: 900, fps: 30, width: 1920, height: 1080, hasAudio: true } },
    { id: "n", kind: "video", name: "b.mp4", path: "/b.mp4", probe: { frames: 900, fps: 30, width: 1920, height: 1080, hasAudio: true } },
    { id: "song", kind: "audio", name: "song.m4a", path: "/song.m4a", probe: { frames: 300, hasAudio: true } },
    { id: "long", kind: "audio", name: "long.m4a", path: "/long.m4a", probe: { frames: 3000, hasAudio: true } },
  ],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "t1", type: "text", start: 200, duration: 60, text: "Hi", transform: { x: 100, y: 100 }, style: { size: 96 } }] },
    { id: "overlay", kind: "video", name: "Overlay", items: [{ id: "pip", type: "clip", media: "m", in: 0, start: 160, duration: 60 }] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "m", in: 0, duration: 150 },
        { id: "b", type: "clip", media: "n", in: 300, duration: 150, transitionIn: { module: "transition.crossfade", duration: 10 } },
        { id: "c", type: "clip", media: "m", in: 600, duration: 150, transitionIn: { module: "transition.crossfade", duration: 10 } },
        { id: "d", type: "clip", media: "n", in: 600, duration: 150, transitionIn: { module: "transition.crossfade", duration: 10 } },
      ],
    },
    { id: "music", kind: "audio", name: "Music", items: [{ id: "bed", type: "audio", media: "song", in: 0, start: 30, duration: 200, fadeIn: 30 }] },
    { id: "music2", kind: "audio", name: "Music 2", items: [{ id: "bed2", type: "audio", media: "long", in: 0, start: 0, duration: 2000, gainKeys: [{ frame: 100, db: -6 }, { frame: 1500, db: -12 }] }] },
  ],
};

function apply(project: Project, ops: ReadonlyArray<Op>) {
  assert.deepEqual(validateOps(ops), []);
  const session = applyEdit(createSession(project), { actor: "user", ops }, (p) => validateProject(p, modules));
  return session;
}
const items = (p: Project) => p.tracks.flatMap((t) => t.items);

test("F8 (D167): Remove from project takes the media and every item using it in one edit; the file stays", () => {
  assert.deepEqual(mediaUses(base, "m").map((u) => u.item.id), ["pip", "a", "c"]);
  assert.deepEqual([...usedMediaIds(base)].sort(), ["long", "m", "n", "song"]);
  const plan = planRemoveMedia(base, "m");
  assert.ok("ops" in plan, "problem" in plan ? plan.problem : "");
  assert.equal(plan.items, 3);
  // The clips after a removed main clip lose their transition in (b after a, d after c).
  assert.deepEqual(
    plan.ops.filter((o) => o.op === "set_transition").map((o) => (o as { item: string }).item),
    ["b", "d"],
  );
  assert.equal(plan.ops.at(-1)!.op, "delete_media");
  const session = apply(base, plan.ops);
  assert.equal(session.revision, 1, "one revision");
  assert.equal(session.log.length, 1);
  assert.ok(!session.project.media.some((m) => m.id === "m"));
  assert.ok(!items(session.project).some((i) => i.media === "m"));
  assert.deepEqual(session.project.tracks.find((t) => t.role === "main")!.items.map((i) => i.id), ["b", "d"]);
  assert.ok(existsSync(clipFile), "the file on disk is untouched");
  assert.match(describeOp(plan.ops.at(-1)!, base), /Removed media a\.mp4 \(m\)/);
  // An unused media: just the media op.
  const unused = { ...base, media: [...base.media, { id: "x", kind: "image" as const, name: "x.png", path: "/x.png" }] };
  const p2 = planRemoveMedia(unused, "x");
  assert.ok("ops" in p2);
  assert.deepEqual(p2.ops, [{ op: "delete_media", media: "x" }]);
  assert.equal(p2.items, 0);
});

test("F8 (D167): the engine refuses delete_media while an item uses it; captions count; locks refuse the plan", () => {
  assert.throws(() => apply(base, [{ op: "delete_media", media: "m" }]), EditError);
  const withCaptions: Project = { ...base, tracks: [...base.tracks, { id: "cap", kind: "text", name: "Captions", items: [{ id: "cc", type: "captions", source: "n", start: 0, duration: 300, words: [] } as never] }] };
  assert.deepEqual(mediaUses(withCaptions, "n").map((u) => u.item.id), ["b", "d", "cc"]);
  const locked: Project = { ...base, tracks: base.tracks.map((t) => (t.id === "overlay" ? { ...t, locked: true } : t)) };
  const refused = planRemoveMedia(locked, "m");
  assert.ok("problem" in refused);
  assert.match(refused.problem, /locked track/);
});

test("F27 (D169): Fit to video trims a longer sound to the end of the picture, with a fade out", () => {
  assert.equal(videoEnd(base), 600);
  const plan = planFitToVideo(base, "bed2");
  assert.ok("ops" in plan, "problem" in plan ? plan.problem : "");
  assert.equal(plan.mode, "trim");
  const next = apply(base, plan.ops).project;
  const bed2 = items(next).find((i) => i.id === "bed2")!;
  assert.equal(bed2.duration, 600);
  assert.equal(bed2.loop, undefined);
  assert.equal(bed2.fadeOut, fitFadeOut(600, 30));
  assert.equal(bed2.fadeOut, 60);
  assert.deepEqual(bed2.gainKeys, [{ frame: 100, db: -6 }], "keys past the new end go");
});

test("F27 (D169): Fit to video loops a shorter sound to the end of the picture; refusals", () => {
  const plan = planFitToVideo(base, "bed");
  assert.ok("ops" in plan, "problem" in plan ? plan.problem : "");
  assert.equal(plan.mode, "loop");
  const next = apply(base, plan.ops).project;
  const bed = items(next).find((i) => i.id === "bed")!;
  assert.equal(bed.start, 30);
  assert.equal(bed.duration, 570, "from its start to the end of the picture");
  assert.equal(bed.loop, true);
  assert.equal(bed.fadeOut, 60);
  assert.equal(bed.fadeIn, 30, "its fade in stays");
  // Fitting again changes nothing.
  const again = planFitToVideo(next, "bed");
  assert.ok("ops" in again);
  assert.equal(again.ops.length, 0);
  // Past the end of the picture, or not a sound.
  const late: Project = { ...base, tracks: base.tracks.map((t) => (t.id === "music" ? { ...t, items: [{ ...t.items[0]!, start: 700 }] } : t)) };
  assert.ok("problem" in planFitToVideo(late, "bed"));
  assert.ok("problem" in planFitToVideo(base, "a"));
  // Another sound on the track in the way.
  const crowded: Project = { ...base, tracks: base.tracks.map((t) => (t.id === "music" ? { ...t, items: [...t.items, { id: "hit", type: "audio" as const, media: "song", in: 0, start: 400, duration: 30 }] } : t)) };
  const blocked = planFitToVideo(crowded, "bed");
  assert.ok("problem" in blocked);
  assert.match(blocked.problem, /in the way at 13\.3 s/);
});

test("F8 (D167, review fix): an element showing the media (an image frame's image) counts as a use and goes with it", () => {
  const withFrame: Project = {
    ...base,
    media: [...base.media, { id: "pic", kind: "image", name: "pic.png", path: "/pic.png", probe: { width: 800, height: 600 } } as never],
    tracks: [...base.tracks, { id: "el", kind: "video", name: "Elements", items: [{ id: "frame", type: "component", component: "component.image-frame", start: 0, duration: 90, props: { ...componentDefaults("component.image-frame"), image: { media: "pic" } } } as never] }],
  };
  assert.deepEqual(mediaUses(withFrame, "pic").map((u) => u.item.id), ["frame"]);
  assert.ok(usedMediaIds(withFrame).has("pic"), "the Used badge");
  assert.throws(() => apply(withFrame, [{ op: "delete_media", media: "pic" }]), EditError);
  const plan = planRemoveMedia(withFrame, "pic");
  assert.ok("ops" in plan);
  assert.equal(plan.items, 1);
  const session = apply(withFrame, plan.ops);
  assert.ok(!items(session.project).some((i) => i.id === "frame"));
  assert.ok(!session.project.media.some((m) => m.id === "pic"));
});
