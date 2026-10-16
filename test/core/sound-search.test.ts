// D208 without the app: search in people's words (meme names in any spelling, synonyms), the
// ranking (match, licence, length), the user's folders filtered the same way, and the designed
// pack's integrity (every file there, CC0 with how it was checked, levelled, small, its waveform,
// in THIRD_PARTY_NOTICES, no copyrighted meme clip).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { aliasOf, expandQuery, filterFolderSounds, filterSfx, MEME_SOUNDS, rankSounds, scoreSound, SFX_CATEGORIES, SFX_SOUNDS, SOUND_ALIASES, sfxCredit, squash, type SoundFolder } from "../../packages/core/src/audio/library.ts";

test("meme names in any spelling find their alias; plain words don't", () => {
  for (const q of ["fahh", "Fahh", "FAAAH", "faah", "fahhhhh", "fah"]) assert.equal(aliasOf(q)?.id, "fahh", q);
  for (const q of ["vine boom", "Vine-Boom", "vineboom", "viiine boooom"]) assert.equal(aliasOf(q)?.id, "boom", q);
  for (const q of ["ba dum tss", "badum tss", "Ba-dum tsss", "rimshot"]) assert.equal(aliasOf(q)?.id, "rimshot", q);
  for (const q of ["bruh", "bruhhh", "BRUH"]) assert.equal(aliasOf(q)?.id, "bruh", q);
  for (const q of ["sad trombone", "wah wah", "womp womp"]) assert.equal(aliasOf(q)?.id, "trombone", q);
  for (const q of ["air horn", "airhorn", "airhorrrn"]) assert.equal(aliasOf(q)?.id, "airhorn", q);
  for (const q of ["record scratch", "oof", "wow", "drumroll", "drum roll", "crickets"]) assert.ok(aliasOf(q), q);
  // Plain words are no meme: a whoosh is a whoosh, a boom is a boom.
  for (const q of ["whoosh", "boom", "click", "dramatic", "bong", ""]) assert.equal(aliasOf(q), undefined, q);
  assert.equal(squash("faaahhh"), "fah");
});

test("aliases: online searches checked to return free sounds, bundled answers that exist, clips said so", () => {
  const ids = new Set(SFX_SOUNDS.map((s) => s.id));
  for (const a of SOUND_ALIASES) {
    // Searches that return nothing on Openverse (checked 2026-10-14) are never sent.
    assert.doesNotMatch(a.online, /^(fahh?|vine boom|meme|anime wow|emotional damage)$/i, a.id);
    for (const b of a.bundled) assert.ok(ids.has(b), `${a.id}: ${b}`);
    if (a.tag) assert.match(a.tag, /^[a-z0-9-]+$/, a.id);
  }
  const fahh = expandQuery("Faaahh");
  assert.equal(fahh.online, "frustrated yell");
  assert.match(fahh.note!, /clip from a video, so it isn't free to use/);
  assert.match(fahh.note!, /Folders/);
  assert.doesNotMatch(fahh.note!, /[·•*]/);
  assert.equal(expandQuery("bruh").note, undefined, "bruh is a word anyone can say: no clip note");
  assert.equal(expandQuery("deep whoosh").online, "deep whoosh");
  // Every meme chip has a name people use and its alias's search.
  assert.ok(MEME_SOUNDS.length >= 12);
  for (const m of MEME_SOUNDS) assert.equal(aliasOf(m.name)?.online, m.query, m.id);
});

test("synonyms and spellings find bundled sounds; meme names find their sound-alikes first", () => {
  const ids = (q: string, category?: string) => filterSfx({ query: q, category }).map((s) => s.id);
  assert.ok(ids("swoosh").includes("whoosh-deep"), "swoosh finds whooshes");
  assert.ok(ids("woooosh").includes("whoosh-little"), "a long woosh too");
  assert.ok(ids("keyboard").includes("typing-mechanical"));
  assert.ok(ids("tap").includes("ui-click"));
  assert.ok(ids("chime").includes("glass-ping") || ids("chime").includes("chime"));
  assert.ok(ids("sucess").includes("success-chord"), "a missing letter (squashed)");
  // D250: Uncut's own sound-alikes answer first, the recordings after.
  assert.deepEqual(ids("fahh").slice(0, 2), ["exaggerated-shout", "frustrated-yell"]);
  assert.equal(ids("faaaahhh")[0], "exaggerated-shout");
  assert.equal(ids("vine boom")[0], "dramatic-boom");
  assert.equal(ids("taco bell")[0], "deep-bong");
  assert.equal(ids("ba dum tss")[0], "rimshot");
  assert.equal(ids("bonk")[0], "bonk");
  assert.equal(ids("ka-ching")[0], "cash-register");
  assert.equal(ids("dun dun dun")[0], "dun-dun-dun");
  assert.deepEqual(ids("trombone"), ["sad-trombone", "womp-womp"]);
  assert.deepEqual(ids("zzqx"), []);
  // A category narrows; no words: the whole category in the pack's order.
  assert.ok(ids("", "typing").length >= 3);
  assert.ok(ids("", "typing").every((id) => SFX_SOUNDS.find((s) => s.id === id)!.category === "typing"));
});

test("ranking: match first, then CC0 and a sound effect's length; nothing matching last", () => {
  const hits = [
    { title: "Forest ambience", tags: ["nature"], license: "cc0", seconds: 120 },
    { title: "whoosh long take", tags: ["air"], license: "by", seconds: 45 },
    { title: "Fast whoosh", tags: ["whoosh"], license: "by", seconds: 0.8 },
    { title: "Fast whoosh", tags: ["whoosh"], license: "cc0", seconds: 0.8 },
    { title: "Swish", tags: ["swoosh"], license: "cc0", seconds: 1 },
  ];
  const ranked = rankSounds(hits, "whoosh");
  // A 1 s CC0 swish (a synonym) beats a 45 s CC BY take for a sound effect; an unrelated sound is last.
  assert.deepEqual(ranked.map((h) => `${h.title} ${h.license}`), ["Fast whoosh cc0", "Fast whoosh by", "Swish cc0", "whoosh long take by", "Forest ambience cc0"]);
  assert.equal(scoreSound(hits[0]!, expandQuery("whoosh")), 0);
  // Music likes length; a meme alias counts its search words.
  assert.ok(scoreSound({ title: "Upbeat song", seconds: 150 }, expandQuery("upbeat"), "music") > scoreSound({ title: "Upbeat song", seconds: 8 }, expandQuery("upbeat"), "music"));
  const yell = rankSounds([{ title: "Birds", tags: [] }, { title: "vocals frustrated yell", tags: ["yell"] }], "fahh");
  assert.equal(yell[0]!.title, "vocals frustrated yell");
});

test("the user's folders: filtered by name, subfolder and spelling, best first", () => {
  const folders: Array<SoundFolder> = [
    {
      id: "aaaaaaaaaaaaaaaa",
      path: "/Users/me/Sounds",
      name: "Sounds",
      sounds: [
        { id: "1111111111111111", folder: "aaaaaaaaaaaaaaaa", name: "FAHHH meme", rel: "memes/FAHHH meme.mp3", ext: "mp3", bytes: 40000 },
        { id: "2222222222222222", folder: "aaaaaaaaaaaaaaaa", name: "big whoosh 02", rel: "transitions/big_whoosh_02.wav", ext: "wav", bytes: 900000 },
        { id: "3333333333333333", folder: "aaaaaaaaaaaaaaaa", name: "click", rel: "ui/click.wav", ext: "wav", bytes: 9000 },
      ],
    },
    { id: "bbbbbbbbbbbbbbbb", path: "/Volumes/X/sfx", name: "sfx", sounds: [], missing: true },
  ];
  const names = (q: string, folder?: string) => filterFolderSounds(folders, q, folder).map((s) => s.name);
  assert.deepEqual(names("fahh"), ["FAHHH meme"], "the user's own clip, found by its spelling");
  assert.deepEqual(names("swoosh"), ["big whoosh 02"], "a synonym");
  assert.deepEqual(names("transitions"), ["big whoosh 02"], "by its subfolder");
  assert.deepEqual(names("memes"), ["FAHHH meme"]);
  assert.equal(names("").length, 3);
  assert.deepEqual(names("", "bbbbbbbbbbbbbbbb"), []);
  assert.equal(filterFolderSounds(folders, "click")[0]!.folderName, "Sounds");
});

test("the designed pack (D208, D250): 100 to 160 CC0 sounds, each with its source, licence check, level, waveform and in the notices (Uncut's own aside)", () => {
  assert.ok(SFX_SOUNDS.length >= 100 && SFX_SOUNDS.length <= 160, String(SFX_SOUNDS.length));
  const notices = readFileSync("THIRD_PARTY_NOTICES", "utf8");
  const categories = new Set(SFX_CATEGORIES.map((c) => c.id));
  let total = 0;
  for (const s of SFX_SOUNDS) {
    assert.equal(s.license, "CC0-1.0", s.id);
    assert.ok(s.provider === "freesound" || s.provider === "kenney" || s.provider === "uncut", s.id);
    assert.match(s.licenseChecked, /^\d{4}-\d{2}-\d{2}$/, s.id);
    assert.match(s.licenseProof, s.provider === "kenney" ? /License\.txt: Creative Commons Zero, CC0/ : s.provider === "uncut" ? /^Synthesised by scripts\/sfx-synth\.ts .*no recording or sample/ : /Freesound page links the CC0 1\.0 deed/, s.id);
    if (s.provider === "kenney") assert.match(s.sourceFile ?? "", /^Audio\/[A-Za-z0-9_]+\.ogg$/, s.id);
    assert.ok(categories.has(s.category), s.id);
    assert.ok(s.tags.length >= 2, s.id);
    assert.match(s.file, /^[a-z0-9-]+\.m4a$/, s.id);
    const bytes = statSync(resolve("assets/sfx", s.file)).size;
    assert.equal(bytes, s.bytes, s.id);
    assert.ok(bytes < 150 * 1024, `${s.id}: ${bytes} bytes`);
    total += bytes;
    assert.ok(s.seconds >= 0.05 && s.seconds <= 6.5, `${s.id}: ${s.seconds}`);
    // Levelled: no louder than -20 LUFS, peaks under -1 dBFS (a quiet transient stays under its loudness target).
    assert.ok(s.lufs <= -19.5, `${s.id}: ${s.lufs} LUFS`);
    assert.ok(s.peakDb <= -0.9, `${s.id}: peak ${s.peakDb}`);
    assert.equal(s.peaks.length, 48, s.id);
    assert.ok(s.peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 100) && s.peaks.includes(100), s.id);
    if (s.provider === "uncut") assert.ok(!notices.includes(s.file), `${s.id} is Uncut's own, not a third-party notice`);
    else assert.ok(notices.includes(s.file) && notices.includes(s.source), `${s.id} in THIRD_PARTY_NOTICES`);
    assert.equal(sfxCredit(s).provider, s.provider);
  }
  assert.ok(total < 4 * 1024 * 1024, `pack ${total} bytes`);
  // What a product video needs, several of each.
  for (const [category, least] of [["ui", 6], ["pop", 3], ["swipe", 3], ["whoosh", 3], ["transition", 3], ["riser", 3], ["impact", 4], ["notification", 4], ["success", 4], ["glitch", 3], ["typing", 3]] as const) {
    assert.ok(filterSfx({ category }).length >= least, `${category}: ${filterSfx({ category }).length}`);
  }
  // Meme sounds are free recordings that sound alike, never a copyrighted clip by its name.
  for (const s of filterSfx({ category: "meme" })) assert.doesNotMatch(s.title, /fahh|vine|taco bell|emotional damage/i, s.id);
});
