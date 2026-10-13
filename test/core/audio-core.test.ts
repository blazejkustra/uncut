// Phase 4 chunk 5 (D54): the audio maths the preview's mix and export share. Gain at frame f from
// the item's volume, gainKeys, fades, the track's volume, mute and solo, and main-track
// transitions crossfading the sound, checked at the boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { audibleAt, dbToGain, fadeAt, gainToDb, keyDbAt, layout, validateProject, loadModules, type Item, type Project, type Track } from "../../packages/core/src/index.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// 30 fps. Main: "a" (60 frames of a clip with sound), "b" (60 frames, a 20-frame crossfade in, so
// the cut at 60 blends 50..70), "mute" (a clip without sound). Music on an audio track from 30.
const project = (patch: { music?: Partial<Item>; musicTrack?: Partial<Track>; mainTrack?: Partial<Track>; extra?: Array<Track> } = {}): Project => ({
  format: "uncut/0",
  name: "A",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "cam", kind: "video", name: "cam.mp4", path: "/cam.mp4", probe: { frames: 900, fps: 30, hasAudio: true } },
    { id: "silent", kind: "video", name: "silent.mp4", path: "/silent.mp4", probe: { frames: 900, fps: 30, hasAudio: false } },
    { id: "song", kind: "audio", name: "song.m4a", path: "/song.m4a", probe: { frames: 300 } },
    { id: "pic", kind: "image", name: "p.png", path: "/p.png", probe: {} },
  ],
  tracks: [
    { id: "main", kind: "video", role: "main", name: "Main", ...patch.mainTrack, items: [
      { id: "a", type: "clip", media: "cam", in: 30, duration: 60 },
      { id: "b", type: "clip", media: "cam", in: 300, duration: 60, transitionIn: { module: "transition.crossfade", duration: 20 } },
      { id: "quiet", type: "clip", media: "silent", in: 0, duration: 30 },
      { id: "still", type: "clip", media: "pic", duration: 30 },
    ] },
    { id: "music", kind: "audio", name: "Music", ...patch.musicTrack, items: [{ id: "m", type: "audio", media: "song", start: 30, in: 0, duration: 120, ...patch.music }] },
    ...(patch.extra ?? []),
  ],
});

const at = (p: Project, f: number) => {
  const { starts } = layout(p);
  return Object.fromEntries(audibleAt(p, starts, f).map((a) => [a.item.id, a]));
};
const gain = (p: Project, f: number, id: string) => at(p, f)[id]?.gain;

test("dB and gain: 0 dB is 1, −6 dB about half, −60 dB and below is silence, +12 dB about 4×", () => {
  near(dbToGain(0), 1);
  near(dbToGain(-6), 0.501, 0.001);
  near(dbToGain(-20), 0.1);
  near(dbToGain(12), 3.981, 0.001);
  assert.equal(dbToGain(-60), 0);
  assert.equal(dbToGain(-90), 0);
  near(dbToGain(-59.9), 10 ** (-59.9 / 20));
  near(gainToDb(0.5), -6.0206, 0.0001);
  assert.equal(gainToDb(0), -Infinity);
});

test("what sounds: clips with audio and audio items; not silent clips, stills or past the end", () => {
  const p = project();
  assert.deepEqual(Object.keys(at(p, 0)), ["a"]);
  assert.deepEqual(Object.keys(at(p, 30)).sort(), ["a", "m"]);
  assert.equal(at(p, 29)["m"], undefined, "music starts at 30");
  assert.equal(at(p, 150)["m"], undefined, "music ends at 150 (exclusive)");
  assert.ok(at(p, 149.9)["m"], "and sounds right up to it");
  assert.deepEqual(Object.keys(at(p, 125)), ["m"], "the clip without sound and the still are skipped");
  // Source time: in + (f − start) × speed, in seconds.
  near(at(p, 0)["a"]!.source, 1);
  near(at(p, 45)["m"]!.source, 0.5);
  near(at(project({ music: { in: 15, speed: 2 } as Partial<Item> }), 45)["m"]!.source, (15 + 30) / 30);
});

test("item and track volume add in dB", () => {
  near(gain(project({ music: { gainDb: -6 } }), 60, "m")!, dbToGain(-6));
  near(gain(project({ musicTrack: { mixer: { gainDb: -6 } } }), 60, "m")!, dbToGain(-6));
  near(gain(project({ music: { gainDb: 6 }, musicTrack: { mixer: { gainDb: -12 } } }), 60, "m")!, dbToGain(-6));
  near(gain(project({ music: { gainDb: 12 }, musicTrack: { mixer: { gainDb: 12 } } }), 60, "m")!, dbToGain(24));
  assert.equal(gain(project({ music: { gainDb: -60 } }), 60, "m"), 0, "−60 dB is silence");
  assert.equal(gain(project({ music: { gainDb: -30 }, musicTrack: { mixer: { gainDb: -30 } } }), 60, "m"), 0, "the sum at −60 is silence too");
});

test("fades: linear, 0 on the first frame and at the end, 1 once the fade is over", () => {
  // Music: 120 frames from 30, fade in 30, fade out 60 → in over 30..60, out over 90..150.
  const p = project({ music: { fadeIn: 30, fadeOut: 60 } });
  assert.equal(gain(p, 30, "m"), 0);
  near(gain(p, 45, "m")!, 0.5);
  near(gain(p, 59, "m")!, 29 / 30);
  near(gain(p, 60, "m")!, 1);
  near(gain(p, 89, "m")!, 1);
  near(gain(p, 90, "m")!, 1);
  near(gain(p, 120, "m")!, 0.5);
  near(gain(p, 149, "m")!, 1 / 60);
  near(gain(p, 149.5, "m")!, 0.5 / 60, 1e-9);
  // Overlapping fades (in + out = the whole item) multiply.
  const both = project({ music: { duration: 60, fadeIn: 30, fadeOut: 30 } });
  near(gain(both, 45, "m")!, 0.5);
  near(gain(both, 60, "m")!, 1);
  near(gain(both, 75, "m")!, 0.5);
  // Fades combine with volume.
  near(gain(project({ music: { fadeIn: 30, gainDb: -6 } }), 45, "m")!, 0.5 * dbToGain(-6));
  near(fadeAt({ duration: 10, fadeIn: 0, fadeOut: 0 }, 5), 1, 0);
});

test("gainKeys: an envelope in dB on top of the volume, linear between keys, held outside", () => {
  const keys = [{ frame: 60, db: -10 }, { frame: 0, db: 0 }, { frame: 90, db: -10 }];
  near(keyDbAt(keys, -5), 0);
  near(keyDbAt(keys, 0), 0);
  near(keyDbAt(keys, 30), -5);
  near(keyDbAt(keys, 60), -10);
  near(keyDbAt(keys, 75), -10);
  near(keyDbAt(keys, 200), -10);
  near(keyDbAt([{ frame: 10, db: -3 }], 0), -3, 0);
  near(keyDbAt(undefined, 10), 0);
  near(keyDbAt([{ frame: 5, db: 0 }, { frame: 5, db: -6 }], 5), 0, 0);
  // The example project's music: 0 dB until 600, then down to −4 dB at 640.
  const p = project({ music: { gainDb: -2, gainKeys: [{ frame: 0, db: 0 }, { frame: 30, db: -4 }] } });
  near(gain(p, 30, "m")!, dbToGain(-2));
  near(gain(p, 45, "m")!, dbToGain(-4));
  near(gain(p, 60, "m")!, dbToGain(-6));
  near(gain(p, 140, "m")!, dbToGain(-6));
});

test("mute silences a track, solo silences the others, hidden doesn't silence anything", () => {
  const muted = project({ musicTrack: { mixer: { mute: true, gainDb: -3 } } });
  assert.equal(gain(muted, 60, "m"), 0);
  assert.equal(at(muted, 60)["m"]!.muted, true, "listed (so playback keeps it warm) but silent");
  near(gain(muted, 10, "a")!, 1, 0);
  const mainMuted = project({ mainTrack: { mixer: { mute: true } } });
  assert.equal(gain(mainMuted, 10, "a"), 0, "video tracks have a mixer too: muting main silences its clips");
  const soloed = project({ musicTrack: { mixer: { solo: true } } });
  assert.equal(gain(soloed, 40, "a"), 0);
  near(gain(soloed, 40, "m")!, 1);
  const hidden = project({ mainTrack: { hidden: true } });
  near(gain(hidden, 10, "a")!, 1, 0);
  // An audio item on a second track is mixed with the first.
  const two = project({ extra: [{ id: "vo", kind: "audio", name: "VO", items: [{ id: "v", type: "audio", media: "song", start: 0, duration: 60, gainDb: -6 }] }] });
  assert.deepEqual(Object.keys(at(two, 40)).sort(), ["a", "m", "v"]);
});

test("a main-track transition crossfades the sound over its frames, centred on the cut", () => {
  // Cut at 60, 20-frame crossfade: "a" sounds until 70 and fades 1 → 0 over 50..70; "b" starts
  // at 50 (its source 10 frames before its in-point) and fades 0 → 1 over the same frames.
  const p = project();
  near(gain(p, 49, "a")!, 1, 0);
  assert.equal(at(p, 49)["b"], undefined);
  near(gain(p, 50, "a")!, 1);
  near(gain(p, 50, "b")!, 0);
  near(gain(p, 55, "a")!, 0.75);
  near(gain(p, 55, "b")!, 0.25);
  near(gain(p, 60, "a")!, 0.5);
  near(gain(p, 60, "b")!, 0.5);
  near(gain(p, 69, "a")!, 0.05);
  near(gain(p, 69, "b")!, 0.95);
  assert.equal(at(p, 70)["a"], undefined, "a is done at 70");
  near(gain(p, 70, "b")!, 1);
  near(at(p, 50)["b"]!.source, (300 - 10) / 30);
  near(at(p, 69)["a"]!.source, (30 + 69) / 30);
  // The two always add up to 1 inside the transition.
  for (let f = 50; f < 70; f += 0.5) near(gain(p, f, "a")! + gain(p, f, "b")!, 1, 1e-9);
  // A fade on the transition's side is skipped (the transition blends); the other side keeps it.
  const faded = structuredClone(p) as unknown as { tracks: Array<{ items: Array<Record<string, unknown>> }> };
  Object.assign(faded.tracks[0]!.items[0]!, { fadeOut: 30, fadeIn: 30 });
  Object.assign(faded.tracks[0]!.items[1]!, { fadeIn: 30 });
  const fp = faded as unknown as Project;
  near(gain(fp, 55, "a")!, 0.75, 1e-9);
  near(gain(fp, 15, "a")!, 0.5, 1e-9);
  near(gain(fp, 55, "b")!, 0.25, 1e-9);
});

test("looped audio wraps around its media", () => {
  // song has 300 frames; a 600-frame looped item from 30 is back at its start at 330.
  const p = project({ music: { duration: 600, loop: true } });
  near(at(p, 300)["m"]!.source, 270 / 30);
  near(at(p, 330)["m"]!.source, 0);
  near(at(p, 345)["m"]!.source, 0.5);
});

test("the schema takes fades and keys on clips and bounds volumes to −60…+12 dB", async () => {
  const modules = await loadModules();
  const ok = project({ music: { gainDb: 12, fadeIn: 10 } }) as unknown as { tracks: Array<{ items: Array<Record<string, unknown>> }> };
  Object.assign(ok.tracks[0]!.items[0]!, { gainDb: -6, fadeIn: 15, fadeOut: 15, gainKeys: [{ frame: 0, db: 0 }] });
  delete (ok.tracks[0]!.items[1] as Record<string, unknown>).transitionIn;
  assert.deepEqual(validateProject(ok, modules), []);
  const loud = structuredClone(ok);
  Object.assign(loud.tracks[1]!.items[0]!, { gainDb: 13 });
  assert.ok(validateProject(loud, modules).some((e) => e.code === "schema"), "13 dB is too loud");
  const quiet = structuredClone(ok);
  Object.assign(quiet.tracks[0]!.items[0]!, { gainDb: -61 });
  assert.ok(validateProject(quiet, modules).some((e) => e.code === "schema"), "−61 dB is out of range");
  const long = structuredClone(ok);
  Object.assign(long.tracks[0]!.items[0]!, { fadeIn: 40, fadeOut: 30 });
  assert.ok(validateProject(long, modules).some((e) => e.code === "fade-too-long"));
});

test("split and start trims keep the volume envelope continuous (a key goes on the cut)", async () => {
  const { applyEdit, createSession, itemGain } = await import("../../packages/core/src/index.ts");
  // Music: 0 dB at 0 → −12 dB at 60 (frames from its start at 30).
  const p = project({ music: { gainKeys: [{ frame: 0, db: 0 }, { frame: 60, db: -12 }] } });
  const split = applyEdit(createSession(p), { actor: "user", ops: [{ op: "split_item", item: "m", at: 30, newId: "m-2" }] }).project;
  const track = split.tracks[1]!;
  assert.deepEqual(track.items[0]!.gainKeys, [{ frame: 0, db: 0 }, { frame: 30, db: -6 }]);
  assert.deepEqual(track.items[1]!.gainKeys, [{ frame: 0, db: -6 }, { frame: 30, db: -12 }]);
  // No step at the cut: the first half's last frame and the second's first are continuous.
  near(itemGain(track, 0, 30), itemGain(track, 1, 0), 1e-12);
  for (const f of [40, 59, 60, 61, 75, 100]) {
    const before = gain(p, f, "m")!;
    const after = at(split, f)["m"]?.gain ?? at(split, f)["m-2"]!.gain;
    near(after, before, 1e-9);
  }
  // A start trim that cuts keys off puts one at the new start with the value there.
  const trimmed = applyEdit(createSession(p), { actor: "user", ops: [{ op: "trim_item", item: "m", edge: "start", frames: 15 }] }).project;
  assert.deepEqual(trimmed.tracks[1]!.items[0]!.gainKeys, [{ frame: 0, db: -3 }, { frame: 45, db: -12 }]);
  for (const f of [45, 60, 105]) near(gain(trimmed, f, "m")!, gain(p, f, "m")!, 1e-9);
});
