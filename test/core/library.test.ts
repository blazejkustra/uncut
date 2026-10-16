// The sound library's shared parts (D134, D135) without the app: the bundled sound-effects pack
// (every file there, CC0, a Freesound page), the quick searches, hit ids, credits (CC BY lines,
// CC0 thanks, bundled music found by its file, "Found with Openverse"), and the Audio tab's plan
// for a library sound (media with its credits + an item at the playhead on a free audio track;
// music fades and stops at the video's end, a sound effect goes in whole), valid for the format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { applyEdit, createSession, loadModules, validateProject, type Op, type Project } from "../../packages/core/src/index.ts";
import { attributionLine, creditOf, creditsOf, creditsText, filterSfx, hitKey, lengthLabel, limitSentence, MEME_SOUNDS, MUSIC_GENRES, parseHitKey, SFX_CATEGORIES, SFX_SOUNDS, sfxCredit, sfxSound, type LibraryHit } from "../../packages/core/src/audio/library.ts";
import { planAddLibrarySound } from "../../apps/web/src/state/project.ts";

const modules = await loadModules("spec/modules/builtin");

test("the bundled sound-effects pack: every sound a CC0 file from a Freesound page, a Kenney pack or Uncut's synthesiser, in a known category", () => {
  assert.ok(SFX_SOUNDS.length >= 12, String(SFX_SOUNDS.length));
  const categories = new Set(SFX_CATEGORIES.map((c) => c.id));
  for (const s of SFX_SOUNDS) {
    assert.equal(s.license, "CC0-1.0", s.id);
    if (s.provider === "kenney") assert.match(s.source, /^https:\/\/kenney\.nl\/assets\/[a-z-]+$/, s.id);
    else if (s.provider === "uncut") assert.equal(s.source, "https://github.com/blazejkustra/uncut/blob/main/scripts/sfx-synth.ts", s.id);
    else assert.match(s.source, /^https:\/\/freesound\.org\/people\/[^/]+\/sounds\/\d+\/$/, s.id);
    assert.ok(categories.has(s.category), `${s.id}: ${s.category}`);
    const path = resolve("assets/sfx", s.file);
    assert.ok(existsSync(path), s.file);
    assert.equal(statSync(path).size, s.bytes, s.file);
    assert.ok(s.seconds > 0 && s.seconds <= 8, `${s.id}: ${s.seconds}`);
  }
  assert.equal(new Set(SFX_SOUNDS.map((s) => s.id)).size, SFX_SOUNDS.length);
  for (const id of ["whoosh", "ui", "impact", "riser", "notification", "crowd", "meme"]) assert.ok(filterSfx({ category: id }).length > 0, id);
  assert.deepEqual(filterSfx({ query: "trombone" }).map((s) => s.id), ["sad-trombone", "womp-womp"]);
  assert.deepEqual(filterSfx({ query: "laughs" }).map((s) => s.id).sort(), ["applause", "crowd-laugh"], "by the category's name too");
  // Quick searches that return results on Openverse ("vine boom" and "meme" return none or junk).
  for (const q of [...SFX_CATEGORIES, ...MEME_SOUNDS, ...MUSIC_GENRES]) assert.doesNotMatch(q.query, /vine|meme/, q.id);
  assert.equal(MEME_SOUNDS.find((m) => m.id === "boom")!.query, "bass boom");
  assert.equal(MEME_SOUNDS.find((m) => m.id === "fahh")!.query, "frustrated yell", "Fahh: a free sound-alike search (D208)");
});

test("hit ids round-trip and junk is refused; lengths and limits in words", () => {
  assert.equal(hitKey({ source: "openverse", id: "eab8a6e2-0ac8" }), "openverse:eab8a6e2-0ac8");
  assert.deepEqual(parseHitKey("freesound:534387"), { source: "freesound", id: "534387" });
  assert.deepEqual(parseHitKey("jamendo:1204669"), { source: "jamendo", id: "1204669" });
  for (const bad of ["pixabay:1", "openverse:", "openverse:../x", "sfx:boom", "freesound:1/2"]) assert.equal(parseHitKey(bad), undefined, bad);
  assert.equal(lengthLabel(0.72), "0.7 s");
  assert.equal(lengthLabel(115.8), "1:56");
  const now = Date.parse("2026-10-14T10:00:00Z");
  assert.equal(limitSentence("openverse", { scope: "minute", until: "2026-10-14T10:00:42Z" }, now), "Openverse's search limit is reached. Try again in 42 s.");
  assert.equal(limitSentence("openverse", { scope: "day", until: "2026-10-15T00:00:00Z" }, now), "Openverse's daily search limit is reached. Try again tomorrow.");
  for (const s of [limitSentence("freesound", { scope: "minute", until: "2026-10-14T10:05:00Z" }, now)]) assert.doesNotMatch(s, /[·•*]/);
});

const BY: LibraryHit = {
  source: "openverse",
  id: "b1",
  title: "Ambient Dance",
  creator: "Some Artist",
  landingUrl: "https://www.jamendo.com/track/1",
  provider: "jamendo",
  license: "by",
  licenseVersion: "3.0",
  licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
  attribution: '"Ambient Dance" by Some Artist is licensed under CC BY 3.0.',
  seconds: 228,
  tags: [],
};

test("credits: CC BY lines to paste, CC0 thanks, bundled music by its file, Openverse named (D135)", () => {
  const base: Project = { format: "uncut/0", name: "Launch", canvas: { width: 1920, height: 1080, fps: 30 }, media: [], tracks: [] };
  assert.equal(creditsText(base), "");
  assert.deepEqual(creditsOf(base), { attribution: [], publicDomain: [], openverse: false });
  const bass = sfxSound("bass-boom")!;
  const project: Project = {
    ...base,
    media: [
      { id: "m-song", kind: "audio", name: "Ambient Dance", path: "media/ambient-dance.mp3", source: { ...creditOf(BY, { sha256: "ab", downloaded: "2026-10-14T00:00:00Z" }) } },
      { id: "m-song-2", kind: "audio", name: "Ambient Dance", path: "media/ambient-dance-2.mp3", source: { ...creditOf(BY) } },
      { id: "m-boom", kind: "audio", name: "Bass boom", path: "media/bass-boom.m4a", source: { ...sfxCredit(bass) } },
      { id: "m-cozy", kind: "audio", name: "Dusty rhodes", path: "media/cozy-2.m4a" },
      { id: "m-cam", kind: "video", name: "cam.mp4", path: "/cam.mp4" },
    ],
  };
  const c = creditsOf(project);
  assert.deepEqual(c.attribution.map((a) => a.title), ["Ambient Dance"], "one line per sound, even used twice");
  assert.deepEqual(c.publicDomain.map((a) => a.libraryId), ["sfx:bass-boom", "music:cozy-2"]);
  assert.equal(c.openverse, true);
  assert.equal(
    creditsText(project),
    [
      "Music and sound",
      '"Ambient Dance" by Some Artist (https://www.jamendo.com/track/1), licensed under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/)',
      "",
      "Public domain (CC0)",
      '"Bass boom" by LordHannes (https://freesound.org/people/LordHannes/sounds/268084/)',
      '"Dusty rhodes neo soul loop" by modcam.music (https://freesound.org/people/modcam.music/sounds/676586/)',
      "",
      "Found with Openverse (openverse.org)",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(creditsText(project), /[·•*]/);
  assert.equal(attributionLine({ title: "T", creator: "C", license: "cc0", licenseVersion: "1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" }), '"T" by C is marked with CC0 1.0. To view the terms, visit https://creativecommons.org/publicdomain/zero/1.0/');
});

test("Audio tab plan: library sound with its credits at the playhead on a free audio track, valid", () => {
  const project: Project = {
    format: "uncut/0",
    name: "P",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "m-cam", kind: "video", name: "cam.mp4", path: "/cam.mp4", probe: { frames: 300, fps: 30, hasAudio: true } }],
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-cam", in: 0, duration: 300 }] },
      { id: "audio", kind: "audio", name: "Audio", items: [] },
    ],
  };
  const apply = (p: Project, plan: ReturnType<typeof planAddLibrarySound>) => {
    assert.ok("ops" in plan, "problem" in plan ? plan.problem : "");
    const next = applyEdit(createSession(p), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
    assert.deepEqual(validateProject(next, modules), []);
    return { next, plan };
  };
  // Music (228 s) at frame 60: cut at the video's end (240 frames), fades, on the free Audio track.
  const music = apply(project, planAddLibrarySound(project, { libraryId: "openverse:b1", name: BY.title, path: "media/ambient-dance-some-artist.mp3", seconds: 228, source: { ...creditOf(BY) }, music: true }, 60));
  const media = music.next.media.find((m) => m.path === "media/ambient-dance-some-artist.mp3")!;
  assert.equal(media.id, "m-ambient-dance");
  assert.equal(media.source?.module, "library.openverse");
  assert.equal(media.source?.license, "by");
  assert.equal(media.probe?.frames, 228 * 30);
  assert.deepEqual(music.next.tracks.find((t) => t.id === "audio")!.items, [{ id: "audio-1", type: "audio", media: media.id, in: 0, duration: 240, start: 60, fadeIn: 30, fadeOut: 60 }]);
  assert.equal(music.plan.summary, "Add Ambient Dance from the music library");
  // A sound effect at the same frame: the Audio track is busy, so a new Sound effects track; whole, no fades.
  const bass = sfxSound("bass-boom")!;
  const sfx = apply(music.next, planAddLibrarySound(music.next, { libraryId: "sfx:bass-boom", name: bass.title, path: "media/bass-boom.m4a", seconds: bass.seconds, source: { ...sfxCredit(bass) }, music: false }, 60));
  const track = sfx.next.tracks.find((t) => t.name === "Sound effects")!;
  assert.equal(track.id, "sfx-1");
  assert.deepEqual(track.items, [{ id: "sound-1", type: "audio", media: "m-bass-boom", in: 0, duration: 120, start: 60 }]);
  // Added again (the media is there): only the item, on the next free stretch's track.
  const again = planAddLibrarySound(sfx.next, { libraryId: "sfx:bass-boom", name: bass.title, seconds: bass.seconds, music: false }, 200);
  assert.ok("ops" in again);
  assert.deepEqual((again.ops as Array<{ op: string }>).map((o) => o.op), ["insert_item"]);
  // Music with less than 3 s of video left: a problem, not a blip.
  const late = planAddLibrarySound(project, { libraryId: "openverse:b1", name: BY.title, path: "media/x.mp3", seconds: 228, music: true }, 280);
  assert.ok("problem" in late && /Only 0\.7 s/.test(late.problem));
  assert.ok("problem" in planAddLibrarySound(project, { libraryId: "openverse:zz", name: "Z", seconds: 3, music: false }, 0));
});
