// Phase 4 chunk 5 (D54) without the app: the Inspector's, timeline's and track header's sound
// planners (apps/web/src/sound.ts), whose results must pass the validator, adding audio from the
// Audio tab (at the playhead when the track is free there), and the agent's note in words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, describeOp, loadModules, manualEditsNote, validateProject, type Op, type Project } from "../packages/core/src/index.ts";
import { planTrackFlag } from "../apps/web/src/edit.ts";
import { planAddMedia } from "../apps/web/src/project.ts";
import { clampDb, hasSound, planFade, planGain, planTrackGain, soundTrack } from "../apps/web/src/sound.ts";

const modules = await loadModules("spec/modules/builtin");
const project: Project = {
  format: "uncut/0",
  name: "S",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m-cam", kind: "video", name: "cam.mp4", path: "/cam.mp4", probe: { frames: 300, fps: 30, hasAudio: true } },
    { id: "m-mute", kind: "video", name: "mute.mp4", path: "/mute.mp4", probe: { frames: 300, fps: 30, hasAudio: false } },
    { id: "m-song", kind: "audio", name: "song.m4a", path: "/song.m4a", probe: { frames: 600 } },
  ],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-cam", in: 0, duration: 90 }, { id: "clip-2", type: "clip", media: "m-mute", in: 0, duration: 90 }] },
    { id: "audio", kind: "audio", name: "Audio", items: [{ id: "audio-1", type: "audio", media: "m-song", in: 0, start: 30, duration: 120 }] },
  ],
};

function apply(p: Project, plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(p), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
}
const item = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;

test("volume: clamped to −60…+12 dB in tenths, 0 dB removes the field, only on items with sound", () => {
  assert.equal(clampDb(-6.04), -6);
  assert.equal(clampDb(-100), -60);
  assert.equal(clampDb(30), 12);
  let p = apply(project, planGain(project, "clip-1", -6));
  assert.equal(item(p, "clip-1").gainDb, -6);
  p = apply(p, planGain(p, "clip-1", 40));
  assert.equal(item(p, "clip-1").gainDb, 12);
  p = apply(p, planGain(p, "clip-1", 0));
  assert.equal("gainDb" in item(p, "clip-1"), false);
  assert.deepEqual(planGain(p, "clip-1", 0), { ops: [], summary: "" }, "no change, no edit");
  assert.ok("problem" in planGain(p, "clip-2", -6), "a clip without sound has no volume");
  assert.ok("problem" in planGain(p, "nope", -6));
  assert.equal(hasSound(p, item(p, "audio-1")), true);
  assert.equal(hasSound(p, item(p, "clip-2")), false);
  const planned = planGain(project, "audio-1", -60);
  assert.ok("ops" in planned && planned.summary === "Set volume of song.m4a to −∞ dB (silent)", JSON.stringify(planned));
});

test("fades: frames, clamped so in + out fit the item, 0 removes them", () => {
  let p = apply(project, planFade(project, "audio-1", "in", 30));
  assert.equal(item(p, "audio-1").fadeIn, 30);
  p = apply(p, planFade(p, "audio-1", "out", 500));
  assert.equal(item(p, "audio-1").fadeOut, 90, "the out fade stops where the in fade ends");
  p = apply(p, planFade(p, "audio-1", "in", -5));
  assert.equal("fadeIn" in item(p, "audio-1"), false);
  p = apply(p, planFade(p, "clip-1", "out", 15.4));
  assert.equal(item(p, "clip-1").fadeOut, 15, "clips fade too");
  const summary = planFade(project, "audio-1", "in", 30);
  assert.ok("ops" in summary && summary.summary === "Fade in song.m4a over 1.0 s");
});

test("track volume keeps mute, and the note tells volume and mute apart", () => {
  let p = apply(project, planTrackFlag(project, "audio", "mute"));
  p = apply(p, planTrackGain(p, "audio", -6));
  assert.deepEqual(p.tracks[2]!.mixer, { mute: true, gainDb: -6 });
  p = apply(p, planTrackGain(p, "audio", 0));
  assert.deepEqual(p.tracks[2]!.mixer, { mute: true });
  const clean = apply(project, planTrackGain(project, "audio", -3));
  assert.deepEqual(apply(clean, planTrackGain(clean, "audio", 0)).tracks[2]!.mixer, undefined, "an empty mixer goes");
  assert.equal(soundTrack(project, project.tracks[1]!), true, "main holds a clip with sound");
  assert.equal(soundTrack(project, project.tracks[0]!), false);

  // The same mixer shape, two meanings: the summary says which.
  const vol = planTrackGain(apply(project, planTrackFlag(project, "audio", "mute")), "audio", -6);
  assert.ok("ops" in vol);
  const op = vol.ops[0] as Op;
  assert.equal(describeOp(op, project, vol.summary), "Set volume of track audio to −6 dB (muted)");
  assert.equal(describeOp(op, project, "Mute track Audio"), "Muted track audio");
  assert.equal(describeOp({ op: "update_track", track: "audio", set: { mixer: { mute: true } } }, project), "Muted track audio");
  assert.equal(describeOp({ op: "update_track", track: "audio", set: { mixer: { gainDb: -12 } } }, project), "Set volume of track audio to −12 dB");
});

test("the agent's note lists volume and fade changes in words", () => {
  let s = createSession(project);
  const edit = (plan: ReturnType<typeof planGain>) => {
    assert.ok("ops" in plan);
    s = applyEdit(s, { actor: "user", ops: plan.ops as ReadonlyArray<Op>, summary: plan.summary });
  };
  edit(planGain(s.project, "clip-1", -6));
  edit(planFade(s.project, "audio-1", "in", 30));
  edit(planFade(s.project, "audio-1", "out", 45));
  edit(planFade(s.project, "audio-1", "in", 0));
  edit(planTrackGain(s.project, "audio", 3.5));
  edit(planTrackFlag(s.project, "audio", "mute"));
  const note = manualEditsNote(s, 0);
  assert.match(note, /Set volume of cam\.mp4 \(clip-1\) to −6 dB/);
  assert.match(note, /Faded in song\.m4a \(audio-1\) over 1\.0 s/);
  assert.match(note, /Faded out song\.m4a \(audio-1\) over 1\.5 s/);
  assert.match(note, /Removed the fade in on song\.m4a \(audio-1\)/);
  assert.match(note, /Set volume of track audio to \+3\.5 dB/);
  assert.match(note, /Muted track audio/);
  assert.equal(describeOp({ op: "update_item", item: "audio-1", set: { gainDb: -6, fadeIn: 30 } }, s.project), "Changed the sound of song.m4a (audio-1): volume −6 dB, fade in 1.0 s");
});

test("adding audio: at the playhead when the first audio track is free there, else after its last sound", () => {
  // audio-1 covers 30..150; the song is 600 frames.
  const at = (frame: number) => {
    const plan = planAddMedia(project, "m-song", frame);
    assert.ok("ops" in plan);
    return plan.start;
  };
  assert.equal(at(150), 150, "free from 150 on");
  assert.equal(at(100), 150, "taken at 100: after the last sound");
  const noTrack: Project = { ...project, tracks: project.tracks.filter((t) => t.kind !== "audio") };
  const plan = planAddMedia(noTrack, "m-song", 45);
  assert.ok("ops" in plan);
  assert.equal(plan.start, 45, "a new track is free everywhere");
  const p = apply(noTrack, plan);
  assert.deepEqual(p.tracks.at(-1)!.items, [{ id: "audio-2", type: "audio", media: "m-song", in: 0, duration: 600, start: 45 }]);
});
