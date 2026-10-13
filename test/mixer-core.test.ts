// Phase 6 chunk 6 (D83) without the app: the mix's maths in core (dB → gain, the whole chain item
// gain × keys × fades × track × pan × master, the equal-power pan law, solo/mute, the gainKeys
// envelope at given frames), the export plan carrying pan and master, the Mixer's and the timeline
// envelope's planners (apps/web/src/sound.ts, edit.ts), whose edits must pass the validator, and
// the words the agent gets for them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anySolo, applyEdit, audibleAt, audibleTracks, mixNote, trackHasSound, createSession, dbToGain, describeOp, itemGain, keyDbAt, layout, loadModules, masterGain, outputGains, panGains, trackAudible, validateProject, type Op, type Project, type Track } from "../packages/core/src/index.ts";
import { audioGraph, planExport } from "../apps/server/src/exportPlan.ts";
import { planTrackFlag } from "../apps/web/src/edit.ts";
import { clampPan, envelopeDbAt, levelY, panShort, panWords, keyIndexAt, planAddGainKey, planMasterGain, planMoveGainKey, planRemoveGainKey, planTrackPan, yLevel } from "../apps/web/src/sound.ts";

const modules = await loadModules("spec/modules/builtin");
const near = (a: number, b: number, eps = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≉ ${b}`);
const db = (g: number) => 20 * Math.log10(g);

const project = (patch: { voice?: Partial<Track>; music?: Partial<Track>; master?: Project["master"] } = {}): Project => ({
  format: "uncut/0",
  name: "Mix",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m-voice", kind: "audio", name: "voice.wav", path: "/voice.wav", probe: { frames: 600 } },
    { id: "m-song", kind: "audio", name: "song.wav", path: "/song.wav", probe: { frames: 600 } },
  ],
  tracks: [
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    { id: "voice", kind: "audio", name: "Voice", ...patch.voice, items: [{ id: "v", type: "audio", media: "m-voice", in: 0, start: 0, duration: 120, gainDb: -3, gainKeys: [{ frame: 30, db: 0 }, { frame: 90, db: -12 }], fadeOut: 30 }] },
    { id: "music", kind: "audio", name: "Music", ...patch.music, items: [{ id: "s", type: "audio", media: "m-song", in: 0, start: 0, duration: 120 }] },
  ],
  ...(patch.master ? { master: patch.master } : {}),
});
const track = (p: Project, id: string) => p.tracks.find((t) => t.id === id)!;
function apply(p: Project, plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(p), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
}

test("dB → gain: 0 dB is 1, −6 dB is 0.501, +12 dB is 3.98, −60 dB and below is silence", () => {
  near(dbToGain(0), 1);
  near(dbToGain(-6), 0.501187, 1e-6);
  near(dbToGain(12), 3.981072, 1e-6);
  assert.equal(dbToGain(-60), 0);
  assert.equal(dbToGain(-80), 0);
  near(masterGain({ master: { gainDb: -6 } }), 0.501187, 1e-6);
  assert.equal(masterGain({}), 1);
  assert.equal(masterGain({ master: { gainDb: -60 } }), 0);
});

test("gainKeys: linear in dB between keys, held before the first and after the last", () => {
  const keys = [{ frame: 30, db: 0 }, { frame: 90, db: -12 }];
  assert.equal(keyDbAt(keys, 0), 0);
  assert.equal(keyDbAt(keys, 30), 0);
  assert.equal(keyDbAt(keys, 45), -3);
  assert.equal(keyDbAt(keys, 60), -6);
  assert.equal(keyDbAt(keys, 89.5), -11.9);
  assert.equal(keyDbAt(keys, 90), -12);
  assert.equal(keyDbAt(keys, 200), -12);
  // Unsorted keys are read in frame order; two keys on one frame are a step (the later one after it).
  assert.equal(keyDbAt([{ frame: 60, db: -6 }, { frame: 0, db: 0 }], 30), -3);
  assert.equal(keyDbAt([{ frame: 0, db: 0 }, { frame: 30, db: -6 }, { frame: 30, db: -20 }, { frame: 60, db: -20 }], 31), -20);
});

test("pan law: θ = (pan+1)·π/4, near side 1, far side √2·cos θ / √2·sin θ; centre unity, never a boost, ends exact", () => {
  assert.deepEqual(panGains(0), { left: 1, right: 1 });
  assert.deepEqual(panGains(-1), { left: 1, right: 0 }, "hard left: right silent, left at 0 dB");
  assert.deepEqual(panGains(1), { left: 0, right: 1 });
  const half = panGains(0.5);
  assert.equal(half.right, 1, "the near side stays at 1");
  near(half.left, Math.SQRT2 * Math.cos((3 * Math.PI) / 8), 1e-12);
  near(db(half.left), -5.333, 1e-3, "pan +0.5 left");
  const left = panGains(-0.5);
  assert.equal(left.left, 1);
  near(left.right, Math.SQRT2 * Math.sin(Math.PI / 8), 1e-12);
  for (let p = -1; p <= 1.0001; p += 0.05) {
    const g = panGains(p);
    assert.ok(g.left <= 1 && g.right <= 1 && g.left >= 0 && g.right >= 0, `no boost at ${p}: ${JSON.stringify(g)}`);
    assert.ok(Math.max(g.left, g.right) === 1, `the near side is 1 at ${p}`);
  }
  // The far side falls monotonically as the pan moves away from it.
  for (let p = 0; p < 1; p += 0.1) assert.ok(panGains(p + 0.1).left < panGains(p).left);
  assert.deepEqual(panGains(-3), panGains(-1), "clamped");
  assert.deepEqual(panGains(Number.NaN), panGains(0));
});

test("the whole chain: item gain × keys × fades × track × pan × master, per channel", () => {
  const p = project({ voice: { mixer: { gainDb: -6, pan: 0.5 } }, master: { gainDb: -4 } });
  const voice = track(p, "voice");
  // Frame 60: keys −6, item −3, track −6 → −15 dB; no fade yet (it starts at 90).
  near(itemGain(voice, 0, 60), dbToGain(-15), 1e-12);
  const g = outputGains(p, voice, 0, 60);
  near(g.left, dbToGain(-15) * dbToGain(-4) * panGains(0.5).left, 1e-12);
  near(g.right, dbToGain(-15) * dbToGain(-4) * panGains(0.5).right, 1e-12);
  // Frame 105: keys −12, item −3, track −6 → −21 dB, half way through the fade out.
  near(outputGains(p, voice, 0, 105).left, dbToGain(-21) * 0.5 * dbToGain(-4) * panGains(0.5).left, 1e-12);
  // The −60 dB cutoff is on the combined item dB (item + keys + track), not per stage.
  const quiet = project({ voice: { mixer: { gainDb: -50 } } });
  assert.equal(itemGain(track(quiet, "voice"), 0, 100), 0, "−3 −12 −50 = −65 dB: silence");
  // An unpanned track at 0 dB master: exactly the item gain on both channels (as before D83).
  const plain = project();
  const m = outputGains(plain, track(plain, "music"), 0, 10);
  assert.deepEqual(m, { left: 1, right: 1 });
});

test("solo and mute: mute wins, any solo silences the unsoloed, a muted solo still silences the rest", () => {
  const audible = (p: Project) => p.tracks.filter((t) => t.kind === "audio").map((t) => [t.id, trackAudible(p, t)]);
  assert.deepEqual(audible(project()), [["voice", true], ["music", true]]);
  assert.deepEqual(audible(project({ music: { mixer: { mute: true } } })), [["voice", true], ["music", false]]);
  assert.deepEqual(audible(project({ voice: { mixer: { solo: true } } })), [["voice", true], ["music", false]]);
  assert.deepEqual(audible(project({ voice: { mixer: { solo: true } }, music: { mixer: { solo: true } } })), [["voice", true], ["music", true]]);
  assert.deepEqual(audible(project({ voice: { mixer: { solo: true, mute: true } } })), [["voice", false], ["music", false]]);
  const p = project({ voice: { mixer: { solo: true } } });
  const at = audibleAt(p, layout(p).starts, 10);
  assert.deepEqual(at.map((a) => [a.item.id, a.muted, a.gain > 0]), [["v", false, true], ["s", true, false]], "the unsoloed item stays listed (kept warm) but silent");
  assert.deepEqual(outputGains(p, track(p, "music"), 0, 10), { left: 0, right: 0 });
});

test("solo and the notes: a solo on a track that can't sound is ignored; solo + mute, all muted and a silent master say nothing will be heard; the export plan warns", () => {
  const text: Track = { id: "titles", kind: "text", name: "Titles", mixer: { solo: true }, items: [] };
  const withText = { ...project(), tracks: [...project().tracks, text] };
  assert.equal(anySolo(withText), false, "a soloed text track isn't a solo");
  assert.deepEqual(audibleTracks(withText).map((t) => t.id), ["voice", "music"]);
  assert.equal(mixNote(withText), undefined);
  // An audio track whose last item was deleted, soloed: ignored too.
  const empty = project({ voice: { mixer: { solo: true } } });
  const emptied = { ...empty, tracks: empty.tracks.map((t) => (t.id === "voice" ? { ...t, items: [] } : t)) };
  assert.equal(anySolo(emptied), false);
  assert.equal(trackAudible(emptied, track(emptied, "music")), true);
  assert.equal(trackHasSound(emptied, track(emptied, "voice")), false);
  // Solo: who is heard.
  assert.equal(mixNote(project({ voice: { mixer: { solo: true } } })), "Solo is on: only Voice will be heard, in the preview and the export.");
  assert.equal(mixNote(project({ voice: { mixer: { solo: true } }, music: { mixer: { solo: true } } })), "Solo is on: only Voice and Music will be heard, in the preview and the export.");
  // Solo + mute on the only soloed track: nothing.
  const soloMuted = project({ voice: { mixer: { solo: true, mute: true } } });
  assert.deepEqual(audibleTracks(soloMuted), []);
  assert.equal(mixNote(soloMuted), "Nothing will be heard: Voice is soloed but muted.");
  assert.equal(mixNote(project({ voice: { mixer: { mute: true } }, music: { mixer: { mute: true } } })), "Nothing will be heard: every track with sound is muted.");
  assert.equal(mixNote(project({ master: { gainDb: -60 } })), "Nothing will be heard: the master volume is at −∞.");
  assert.equal(mixNote(project()), undefined);
  assert.equal(mixNote({ ...project(), tracks: [project().tracks[0]!] }), undefined, "nothing to hear anyway: nothing to say");
  const plan = planExport(soloMuted, { mediaPath: (m) => m.path, width: 640, height: 360 });
  assert.ok(!("problem" in plan));
  assert.ok(plan.warnings.includes("Nothing will be heard: Voice is soloed but muted."), JSON.stringify(plan.warnings));
  assert.deepEqual(plan.audio, []);
  const solo = planExport(project({ music: { mixer: { solo: true } } }), { mediaPath: (m) => m.path, width: 640, height: 360 });
  assert.ok(!("problem" in solo) && solo.warnings.some((w) => w.startsWith("Solo is on: only Music")));
});

test("export plan: each layer carries its track's pan, the plan the master volume; solo leaves the others out", () => {
  const p = project({ voice: { mixer: { pan: -1 } }, master: { gainDb: -6 } });
  const plan = planExport(p, { mediaPath: (m) => m.path, width: 640, height: 360 });
  assert.ok(!("problem" in plan));
  near(plan.masterGain, dbToGain(-6), 1e-12);
  assert.deepEqual(plan.audio.map((a) => [a.item.id, a.pan]), [["v", { left: 1, right: 0 }], ["s", { left: 1, right: 1 }]]);
  const graph = audioGraph(plan, 0).filters.join(";\n");
  assert.match(graph, /pan=stereo\|c0=1\*c0\|c1=0\*c1/, "the voice is panned");
  assert.equal(graph.match(/pan=stereo\|c0=/g)?.length, 1, "the centred music isn't");
  assert.match(graph, /normalize=0,volume=0\.501187,atrim/, "master volume after the sum");
  const solo = planExport(project({ music: { mixer: { solo: true } } }), { mediaPath: (m) => m.path, width: 640, height: 360 });
  assert.ok(!("problem" in solo));
  assert.deepEqual(solo.audio.map((a) => a.item.id), ["s"]);
  const plain = planExport(project(), { mediaPath: (m) => m.path, width: 640, height: 360 });
  assert.ok(!("problem" in plain));
  assert.doesNotMatch(audioGraph(plain, 0).filters.join(";"), /normalize=0,volume|pan=stereo\|c0/, "nothing added without pan or master");
});

test("schema: master.gainDb and mixer pan/solo are valid in range, refused outside", () => {
  assert.deepEqual(validateProject(project({ voice: { mixer: { gainDb: -6, pan: -0.3, solo: true } }, master: { gainDb: -3, loudness: { targetLufs: -14 } } }), modules), []);
  assert.ok(validateProject(project({ master: { gainDb: 13 } }), modules).some((e) => e.code === "schema"));
  assert.ok(validateProject(project({ voice: { mixer: { pan: 1.5 } } }), modules).some((e) => e.code === "schema"));
});

test("Mixer planners: pan (hundredths, centre removes it), solo, master volume; labels and the agent's words", () => {
  const base = project({ voice: { mixer: { gainDb: -6 } }, master: { loudness: { targetLufs: -14 } } });
  assert.equal(clampPan(-0.304), -0.3);
  assert.equal(clampPan(4), 1);
  assert.equal(panWords(-0.3), "30 % left");
  assert.equal(panWords(0), "centre");
  assert.equal(panShort(0.25), "R25");
  const pan = planTrackPan(base, "voice", -0.3);
  assert.ok("ops" in pan && pan.summary === "Pan Voice 30 % left", JSON.stringify(pan));
  let p = apply(base, pan);
  assert.deepEqual(track(p, "voice").mixer, { gainDb: -6, pan: -0.3 }, "the mixer's volume is kept");
  assert.equal(describeOp(pan.ops[0] as Op, p, pan.summary), "Panned track voice 30 % left");
  p = apply(p, planTrackPan(p, "voice", 0.01));
  assert.equal(track(p, "voice").mixer?.pan, 0.01);
  p = apply(p, planTrackPan(p, "voice", 0));
  assert.deepEqual(track(p, "voice").mixer, { gainDb: -6 }, "centre removes pan");
  assert.deepEqual(planTrackPan(p, "voice", 0), { ops: [], summary: "" });

  const solo = planTrackFlag(p, "voice", "solo");
  assert.ok("ops" in solo && solo.summary === "Solo Voice");
  p = apply(p, solo);
  assert.deepEqual(track(p, "voice").mixer, { gainDb: -6, solo: true });
  assert.equal(describeOp(solo.ops[0] as Op, p, solo.summary), "Soloed track voice");
  const unsolo = planTrackFlag(p, "voice", "solo");
  assert.ok("ops" in unsolo && unsolo.summary === "Unsolo Voice");
  p = apply(p, unsolo);
  assert.deepEqual(track(p, "voice").mixer, { gainDb: -6 }, "unsolo removes the field");
  const music = apply(p, planTrackFlag(p, "music", "solo"));
  const offAgain = planTrackFlag(music, "music", "solo");
  assert.ok("ops" in offAgain && (offAgain.ops[0] as unknown as { set: { mixer: unknown } }).set.mixer === null, "an empty mixer goes");

  const master = planMasterGain(p, -3);
  assert.ok("ops" in master && master.summary === "Set master volume to −3 dB");
  p = apply(p, master);
  assert.deepEqual(p.master, { loudness: { targetLufs: -14 }, gainDb: -3 }, "loudness is kept");
  assert.equal(describeOp(master.ops[0] as Op, p, master.summary), "Set master volume to −3 dB");
  p = apply(p, planMasterGain(p, 0));
  assert.deepEqual(p.master, { loudness: { targetLufs: -14 } });
  const bare = apply(project({ master: { gainDb: -2 } }), planMasterGain(project({ master: { gainDb: -2 } }), 0));
  assert.equal(bare.master, undefined, "an empty master goes");
  // The agent's update_track without a summary that says which: everything listed.
  assert.equal(describeOp({ op: "update_track", track: "voice", set: { mixer: { pan: 0.4, solo: true } } }, p), "Set mixer of track voice: panned 40 % right, soloed");
  assert.equal(describeOp({ op: "update_track", track: "voice", set: { mixer: { gainDb: -8, pan: -1 } } }, p), "Set volume of track voice to −8 dB, panned 100 % left");
  assert.equal(describeOp({ op: "update_project", set: { master: { gainDb: -2 } } }, p), "Set master volume to −2 dB");
  // D87: the loudness target is said too.
  assert.equal(describeOp({ op: "update_project", set: { master: { loudness: { targetLufs: -16 } } } }, p), "Set the master: loudness target Quieter (−16 LUFS)");
});

test("volume keys on the timeline: add at the line's value or a dB, move between neighbours, remove; the level scale", () => {
  const base = project();
  const voice = () => base.tracks[1]!.items[0]!;
  // The line: gainDb + keys.
  assert.equal(envelopeDbAt(voice(), 60), -9);
  // Add on the line: no change in sound (the key takes the envelope's value there).
  const add = planAddGainKey(base, "v", 60);
  assert.ok("ops" in add && add.summary === "Add volume key at 2.0 s");
  let p = apply(base, add);
  const v = (q: Project) => q.tracks[1]!.items[0]!;
  assert.deepEqual(v(p).gainKeys, [{ frame: 30, db: 0 }, { frame: 60, db: -6 }, { frame: 90, db: -12 }]);
  for (const f of [0, 31, 45, 60, 75, 119]) near(envelopeDbAt(v(p), f), envelopeDbAt(voice(), f), 1e-9, `frame ${f}`);
  assert.deepEqual(planAddGainKey(p, "v", 60), { ops: [], summary: "" }, "the same key again is no edit");
  // Add with a dB (the item's dB there): stored relative to gainDb, clamped so the sum stays in range.
  const loud = planAddGainKey(p, "v", 10, 30);
  assert.ok("ops" in loud && loud.summary === "Add volume key at 0.3 s (+12 dB)");
  p = apply(p, loud);
  assert.deepEqual(v(p).gainKeys?.[0], { frame: 10, db: 15 });
  // Move (keys by index in frame order: 10, 30, 60, 90): frame and dB, one frame clear of its
  // neighbours, so dragging onto a neighbour never makes two keys share a frame.
  assert.deepEqual(v(p).gainKeys?.map((k) => k.frame), [10, 30, 60, 90]);
  const move = planMoveGainKey(p, "v", 2, 200, -20);
  assert.ok("ops" in move && move.summary === "Move volume key to 3.0 s, −20 dB", JSON.stringify(move));
  p = apply(p, move);
  assert.deepEqual(v(p).gainKeys?.map((k) => k.frame), [10, 30, 89, 90]);
  assert.deepEqual(v(p).gainKeys?.[2], { frame: 89, db: -17 });
  p = apply(p, planMoveGainKey(p, "v", 2, 0, -20));
  assert.deepEqual(v(p).gainKeys?.map((k) => k.frame), [10, 30, 31, 90], "back onto the left neighbour: stops one frame after it");
  // No room either side (neighbours one apart): the frame stays, the dB moves.
  const tight = apply(p, planMoveGainKey(p, "v", 1, 31, -20));
  assert.deepEqual(tight.tracks[1]!.items[0]!.gainKeys?.map((k) => k.frame), [10, 30, 31, 90]);
  p = apply(p, planMoveGainKey(p, "v", 3, 500, -12));
  assert.deepEqual(v(p).gainKeys?.at(-1), { frame: 120, db: -9 }, "the last key stops at the item's end");
  assert.ok("problem" in planMoveGainKey(p, "v", 7, 70, 0), "a key that isn't there");
  // Remove by index: only that key, even when two share a frame (older projects can have steps).
  const rm = planRemoveGainKey(p, "v", 0);
  assert.ok("ops" in rm && rm.summary === "Remove volume key at 0.3 s");
  p = apply(p, rm);
  const step = apply(p, { ops: [{ op: "update_item", item: "v", set: { gainKeys: [{ frame: 30, db: 0 }, { frame: 60, db: -6 }, { frame: 60, db: -20 }] } }] });
  const one = apply(step, planRemoveGainKey(step, "v", 2));
  assert.deepEqual(one.tracks[1]!.items[0]!.gainKeys, [{ frame: 30, db: 0 }, { frame: 60, db: -6 }], "one of the two keys at 60 goes");
  assert.equal(keyIndexAt([{ frame: 90, db: 0 }, { frame: 30, db: 0 }], 90), 1);
  while (v(p).gainKeys?.length) p = apply(p, planRemoveGainKey(p, "v", 0));
  assert.equal(v(p).gainKeys, undefined);
  assert.ok("problem" in planAddGainKey({ ...base, media: [] }, "v", 10), "no sound, no keys");
  // The level scale: +12 at the top, 0 dB a quarter down, −24 at three quarters, silence at the bottom.
  assert.equal(levelY(12), 0);
  assert.equal(levelY(0), 0.25);
  assert.equal(levelY(-24), 0.75);
  assert.equal(levelY(-60), 1);
  assert.equal(levelY(-200), 1);
  for (const d of [12, 3, 0, -6, -24, -40, -60]) near(yLevel(levelY(d)), d, 1e-9, `round trip ${d}`);
});
