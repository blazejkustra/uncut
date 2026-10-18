// D207 (issue #31): core's sound rule. The evidence project (16 effects in 21.5 s, a UI click 7
// times incl. on text, two booms, a slow loop under fast cuts) trips every finding; a tasteful mix
// (3 effects on real events, under the music, a fast track) is clean; the loud finding's fix is a
// valid edit that clears it; the sound sheet lists music and every effect with what it lands on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, loadModules, projectChecks, SFX_PER_10S, SOUND_HARD, soundSheet, validateOps, validateProject, type Item, type Project } from "../../packages/core/src/index.ts";

const modules = await loadModules("spec/modules/builtin", "spec/examples/plugins");
const FPS = 30;

/** 21.5 s 1080×1350: main cuts every `cut` frames, texts, music (its tempo in the file name) and effects. */
function make({ cut = 60, music = "lofi-loop-75bpm.m4a", musicGain = 0, sfx = [], texts = [] }: { cut?: number; music?: string; musicGain?: number; sfx?: Array<{ file: string; at: number; gainDb?: number; duration?: number }>; texts?: Array<{ start: number; text: string }> } = {}): Project {
  const length = 645;
  const clips: Array<Item> = [];
  for (let f = 0, i = 0; f < length; f += cut, i++) clips.push({ id: `c${i}`, type: "clip", media: "m-clip", in: 0, duration: Math.min(cut, length - f) } as Item);
  const files = [...new Set(sfx.map((s) => s.file))];
  return {
    format: "uncut/0",
    name: "Sound",
    canvas: { width: 1080, height: 1350, fps: FPS },
    media: [
      { id: "m-clip", kind: "video", name: "clip.mp4", path: "/tmp/clip.mp4", probe: { frames: 3000, fps: 30, width: 1080, height: 1350, hasAudio: false } },
      { id: "m-music", kind: "audio", name: "Music", path: `media/${music}`, probe: { frames: 3600 } },
      ...files.map((f) => ({ id: `m-${f.replace(".m4a", "")}`, kind: "audio" as const, name: f.replace(/\.m4a$/, ""), path: `media/${f}`, probe: { frames: 120 } })),
    ],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: texts.map((t, i) => ({ id: `t${i}`, type: "text", start: t.start, duration: 90, text: t.text, style: { preset: "text.title", size: 96 } }) as Item) },
      { id: "main", kind: "video", role: "main", name: "Main", items: clips },
      { id: "music", kind: "audio", name: "Music", items: [{ id: "music-1", type: "audio", media: "m-music", in: 0, start: 0, duration: length, fadeIn: 30, fadeOut: 60, gainDb: musicGain } as Item] },
      { id: "sfx", kind: "audio", name: "SFX", items: sfx.map((s, i) => ({ id: `s${i}`, type: "audio", media: `m-${s.file.replace(".m4a", "")}`, in: 0, start: s.at, duration: s.duration ?? 12, ...(s.gainDb !== undefined ? { gainDb: s.gainDb } : {}) }) as Item) },
    ],
  };
}
const sound = (p: Project) => projectChecks(p).filter((c) => c.id === "sound");
const kinds = (p: Project) => [...new Set(sound(p).map((c) => c.key.split(":")[1]))].sort();

test("the evidence project (16 effects in 21.5 s) trips density, repeats, hits, level, sync, clicks on text, memes and pace", () => {
  // Cuts every 1 s (30 frames) under a 75 BPM loop; clicks on every text and as "typing", two booms, whooshes everywhere.
  const sfx = [
    ...[6, 84, 150, 240, 330, 420, 500].map((at) => ({ file: "ui-click.m4a", at })),
    { file: "impact-boom.m4a", at: 120 },
    { file: "dramatic-boom.m4a", at: 300 },
    ...[30, 90, 180, 270, 360].map((at) => ({ file: "whoosh-short.m4a", at: at - 1 })),
    { file: "ding.m4a", at: 455 },
    { file: "airhorn.m4a", at: 600 },
  ];
  assert.equal(sfx.length, 16);
  const texts = [6, 84, 150, 240, 330, 420, 500].map((start, i) => ({ start, text: `Line ${i + 1}` }));
  // (Overlapping effects on one track, as the agent's auto-lanes would split them; the rule doesn't care.)
  const p = make({ cut: 30, sfx, texts });
  assert.deepEqual(kinds(p), ["click-text", "density", "hits", "loud", "meme", "pace", "repeat", "sync"]);
  const found = sound(p);
  const density = found.find((c) => c.key.startsWith("sound:density:"))!;
  assert.match(density.message, /sound effects start between .* at most 4 in any 10\.0 s/);
  assert.ok(SOUND_HARD.test(density.key), "density fails a critic round");
  assert.match(found.find((c) => c.key === "sound:repeat:ui-click")!.message, /ui-click plays 7 times/);
  assert.match(found.find((c) => c.key.startsWith("sound:hits:"))!.message, /2 big hits \(impact-boom at 4\.0 s, dramatic-boom at 10\.0 s\)/);
  assert.match(found.find((c) => c.key === "sound:click-text:s0")?.message ?? "", /clicks on a text/);
  assert.equal(found.find((c) => c.key === "sound:meme:s15")?.severity, "info");
  assert.match(found.find((c) => c.key.startsWith("sound:pace:"))!.message, /75 BPM under something new every 0\.7 s/);
  // Whooshes 1 frame before each cut land; the ding at 15.2 s lands on nothing.
  assert.ok(!found.some((c) => c.key === "sound:sync:s9"), "a whoosh a frame before a cut lands");
  assert.match(found.find((c) => c.key === "sound:sync:s14")!.message, /ding at 15\.2 s lands on nothing that changes on screen \(the nearest is/);
});

test("a tasteful mix is clean: 3 effects on real events, 9 dB under a fast track", () => {
  const p = make({ cut: 60, music: "lofi-loop-95bpm.m4a", sfx: [{ file: "whoosh-short.m4a", at: 119, gainDb: -9 }, { file: "ui-click.m4a", at: 300, gainDb: -10 }, { file: "impact-boom.m4a", at: 480, gainDb: -8 }] });
  assert.deepEqual(sound(p), [], JSON.stringify(sound(p)));
  assert.ok(SFX_PER_10S >= 3);
});

test("level: an effect at the music's gain is loud (hard); its fix puts it 9 dB under and clears it", () => {
  const p = make({ cut: 60, music: "lofi-loop-95bpm.m4a", musicGain: -2, sfx: [{ file: "whoosh-short.m4a", at: 119 }] });
  const loud = sound(p).find((c) => c.key === "sound:loud:s0")!;
  assert.match(loud.message, /whoosh-short at 4\.0 s is at 0 dB over music at −2 dB; effects sit 6 to 12 dB under the music/);
  assert.ok(SOUND_HARD.test(loud.key));
  assert.deepEqual(validateOps(loud.fix!.ops), []);
  const next = applyEdit(createSession(p), { actor: "user", ops: loud.fix!.ops, summary: loud.fix!.summary }).project;
  assert.deepEqual(validateProject(next, modules), []);
  assert.equal(next.tracks.find((t) => t.id === "sfx")!.items[0]!.gainDb, -11);
  assert.deepEqual(sound(next), []);
  // A file that isn't from the pack: its loudness is unknown, so a soft note, never a hard finding.
  const other = make({ cut: 60, music: "lofi-loop-95bpm.m4a", sfx: [{ file: "my-whoosh.wav", at: 119 }] });
  const level = sound(other).find((c) => c.key === "sound:level:s0")!;
  assert.equal(level.severity, "info");
  assert.ok(!SOUND_HARD.test(level.key));
  assert.match(level.message, /its own loudness is unknown/);
});

test("a short video gets a pro-rata limit; a riser lands on what it builds to; sounds named like effects count", () => {
  const p = make({ cut: 60, music: "lofi-loop-95bpm.m4a", sfx: [{ file: "riser.m4a", at: 60, duration: 60, gainDb: -10 }] });
  assert.deepEqual(sound(p), [], "a riser ending on the cut at 4 s lands");
  const off = make({ cut: 60, music: "lofi-loop-95bpm.m4a", sfx: [{ file: "riser.m4a", at: 85, duration: 60, gainDb: -10 }] });
  assert.ok(sound(off).some((c) => c.key === "sound:sync:s0"), "a riser ending between cuts lands on nothing");
});

test("the sound sheet: music with its tempo and level, each effect with its kind, level against the music and what it lands on", () => {
  const p = make({ cut: 60, music: "lofi-loop-95bpm.m4a", sfx: [{ file: "whoosh-short.m4a", at: 119, gainDb: -9 }, { file: "ding.m4a", at: 455 }] });
  const sheet = soundSheet(p);
  assert.match(sheet[0]!, /^music 0\.0 s to 21\.5 s: Music, 95 BPM, at 0 dB, fades in, fades out$/);
  assert.match(sheet[1]!, /^sound effect 4\.0 s \(f 119\): whoosh-short \(whoosh\), 0\.4 s, at −9 dB \(−9 dB against the music\); lands on the cut to c2 \(f 120\)/);
  assert.match(sheet[2]!, /ding \(ui\).*lands on nothing that changes on screen/);
  assert.match(sheet.at(-2)!, /^2 sound effects in 21\.5 s \(0\.9 per 10 s; the bar is at most 4\), 2 different$/);
  // D217: the profile last (strict when the video's brief says nothing).
  assert.equal(sheet.at(-1), "Sound profile strict: at most 4 effects in any 10 s, 6 dB under the music; too many or too loud fails a review.");
  assert.ok(!/[·•]/.test(sheet.join("\n")));
});

test("D296: a song on a plain \"Audio\" track, its file named after the song, is music on the sheet (not \"No music\")", () => {
  const p = make({ music: "2-electro-dreams_arulo_mixkit-190_cut28.mp3" });
  const music = p.tracks.find((t) => t.id === "music")!;
  const plain = { ...p, tracks: p.tracks.map((t) => (t === music ? { ...t, name: "Audio" } : t)).filter((t) => t.id !== "sfx") };
  const sheet = soundSheet(plain);
  assert.match(sheet[0]!, /^music 0\.0 s to 21\.5 s: Music, at 0 dB/);
  assert.ok(!sheet.includes("No music and no sound effects."), sheet.join("\n"));
  // A long sound named like an effect is still music past 15 s; a short one stays an effect.
  const swish = make({ music: "3-swish-swed_arulo_mixkit-201_cut28.mp3" });
  assert.match(soundSheet({ ...swish, tracks: swish.tracks.map((t) => (t.id === "music" ? { ...t, name: "Audio" } : t)) })[0]!, /^music 0\.0 s/);
});

// D297: the ui sound profile (a motion film): a click on every beat inside the film's one graphic is
// neither too dense nor a repeat nor "on nothing" (the change is inside the graphic); a meme still is noted.
test("ui profile: one soft click per press inside a graphic is fine; outside a graphic it still has to land on something", () => {
  const clicks = Array.from({ length: 20 }, (_, i) => ({ file: "click-soft.m4a", at: 15 + i * 15, gainDb: -12 }));
  const base = make({ cut: 645, music: "electro-120bpm.m4a", sfx: [...clicks, { file: "airhorn.m4a", at: 400, gainDb: -12 }] });
  const withGraphic = { ...base, tracks: [...base.tracks, { id: "gfx", kind: "video", name: "Graphics", items: [{ id: "film", type: "graphic", src: "graphics/film.html", start: 0, duration: 645 } as Item] }] } as Project;
  const ui = projectChecks(withGraphic, { sound: "ui" }).filter((c) => c.id === "sound").map((c) => c.key.split(":")[1]);
  assert.deepEqual([...new Set(ui)].sort(), ["meme"]);
  const strict = projectChecks(withGraphic, { sound: "strict" }).filter((c) => c.id === "sound").map((c) => c.key.split(":")[1]);
  assert.ok(strict.includes("density") && strict.includes("repeat"), strict.join(", "));
  const bare = projectChecks(base as Project, { sound: "ui" }).filter((c) => c.id === "sound").map((c) => c.key.split(":")[1]);
  assert.ok(bare.includes("sync"), "no graphic: a click on nothing is still a finding");
});

// T2, A2r8: the user asked for the music only. Under the music profile an added effect is one
// finding (music-only) and the other effect rules have nothing to judge; no effects is clean.
test("music profile: any sound effect is one music-only finding; none is clean", () => {
  const clicks = Array.from({ length: 6 }, (_, i) => ({ file: "click-soft.m4a", at: 15 + i * 15, gainDb: -12 }));
  const withSfx = make({ cut: 645, music: "electro-120bpm.m4a", sfx: clicks });
  const keys = projectChecks(withSfx, { sound: "music" }).filter((c) => c.id === "sound").map((c) => c.key.split(":")[1]);
  assert.deepEqual([...new Set(keys)], ["music-only"]);
  const none = make({ cut: 645, music: "electro-120bpm.m4a", sfx: [] });
  assert.deepEqual(projectChecks(none, { sound: "music" }).filter((c) => c.id === "sound").map((c) => c.key), []);
  assert.match(soundSheet(none, { sound: "music" }).join("\n"), /Sound profile music only/);
});

// D306: the user wants keyboard sounds on the typed prompt; a typing sound landing on a text being
// typed is the right sound, not "a click on a text". A UI click there still is; music only (the
// user's request) still rules every effect out.
test("a keyboard sound on typing isn't a click on text; a UI click on text still is; music only still drops both", () => {
  const texts = [{ start: 150, text: "Cut my drone clips" }, { start: 330, text: "into a reel" }];
  const p = make({ cut: 60, music: "lofi-loop-120bpm.m4a", texts, sfx: [{ file: "typing-keyboard.m4a", at: 150, gainDb: -10 }, { file: "ui-click.m4a", at: 330, gainDb: -10 }] });
  const keys = sound(p).map((c) => c.key);
  assert.ok(!keys.includes("sound:click-text:s0"), `the bundled typing sound on typing: ${keys.join(", ")}`);
  assert.ok(keys.includes("sound:click-text:s1"), "a UI click on a text is still flagged");
  const named = make({ cut: 60, music: "lofi-loop-120bpm.m4a", texts, sfx: [{ file: "my-keyboard-clack.m4a", at: 150, gainDb: -10 }] });
  assert.ok(!sound(named).some((c) => c.key.startsWith("sound:click-text:")), "a keyboard sound by its name");
  const musicOnly = projectChecks(p, { sound: "music" }).filter((c) => c.id === "sound");
  assert.ok(musicOnly.some((c) => c.key.startsWith("sound:music-only:")), "music only (the user's words) still asks for none");
});
