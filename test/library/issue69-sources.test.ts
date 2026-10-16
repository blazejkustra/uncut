// D249 on the server, offline: the Music app's library: read from its XML copy (Apple Music,
// protected, cloud-only and video left out and counted) or, without one, from its media folder
// (Apple Music's folder and .m4p left out); never the real ~/Music in a test; a song added into the
// project's media/. (Jamendo's tests left with Jamendo, D274.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { soundLibrary } from "../../apps/server/src/library/library.ts";
import { excluded, musicLibraryRoot, parseLibraryXml } from "../../apps/server/src/library/musicApp.ts";
import { MUSIC_LIBRARY_PATH } from "../../packages/core/src/audio/library.ts";

let root = "";
let mp3: Buffer;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-d249-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", join(root, "t.mp3")]);
  mp3 = readFileSync(join(root, "t.mp3"));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const lib = (opts: { musicRoot?: string; dataDir?: string } = {}) =>
  soundLibrary({ sfxDir: "assets/sfx", dataDir: opts.dataDir ?? join(root, "data"), freesoundKey: async () => undefined, musicRoot: opts.musicRoot, probeSeconds: async () => 1 });

const plist = (tracks: Array<Record<string, string | number | boolean>>) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Major Version</key><integer>1</integer><key>Tracks</key><dict>\n${tracks
    .map((t, i) => `<key>${100 + i}</key><dict>${Object.entries(t).map(([k, v]) => `<key>${k}</key>${typeof v === "boolean" ? `<${v}/>` : typeof v === "number" ? `<integer>${v}</integer>` : `<string>${v.replace(/&/g, "&#38;")}</string>`}`).join("")}</dict>`)
    .join("\n")}\n</dict><key>Playlists</key><array><dict><key>Name</key><string>Library</string></dict></array></dict></plist>\n`;

test("the Music library: its XML (DRM-free files only, counted), else its media folder; never the real one in a test", async () => {
  assert.equal(musicLibraryRoot({ NODE_TEST_CONTEXT: "child" }), undefined, "no library in a test run without one");
  assert.equal(musicLibraryRoot({ NODE_TEST_CONTEXT: "child", UNCUT_MUSIC_LIBRARY_DIR: "/x" }), "/x");

  const home = join(root, "Music-xml");
  const songs = join(root, "Elsewhere");
  mkdirSync(join(home, "Music"), { recursive: true });
  mkdirSync(songs, { recursive: true });
  writeFileSync(join(songs, "Yellow.m4a"), mp3);
  writeFileSync(join(songs, "Fix You.mp3"), mp3);
  writeFileSync(join(songs, "Locked.m4p"), mp3);
  const loc = (f: string) => pathToFileURL(join(songs, f)).href.replace("file:///", "file://localhost/");
  const tracks: Array<Record<string, string | number | boolean>> = [
    { "Track ID": 1, Name: "Yellow", Artist: "A Band", Album: "Parachutes", Kind: "Purchased AAC audio file", Size: mp3.length, "Track Type": "File", Location: loc("Yellow.m4a") },
    { "Track ID": 2, Name: "Fix You & Me", Artist: "A Band", Album: "X&Y", Kind: "MPEG audio file", "Track Type": "File", Location: loc("Fix You.mp3") },
    { "Track ID": 3, Name: "Streamed", Artist: "Someone", Kind: "Apple Music AAC audio file", "Apple Music": true, "Track Type": "Remote" },
    { "Track ID": 4, Name: "Old DRM", Artist: "Someone", Kind: "Protected AAC audio file", Protected: true, "Track Type": "File", Location: loc("Locked.m4p") },
    { "Track ID": 5, Name: "A Film", Kind: "Purchased MPEG-4 video file", "Has Video": true, "Track Type": "File", Location: loc("film.m4v") },
  ];
  writeFileSync(join(home, "Music", "Library.xml"), plist(tracks));
  const parsed = parseLibraryXml(readFileSync(join(home, "Music", "Library.xml"), "utf8"));
  assert.equal(parsed.length, 5, "the playlists after the tracks aren't read as tracks");
  assert.equal(parsed[1]!.Name, "Fix You & Me");
  assert.deepEqual(parsed.map(excluded), [undefined, undefined, "protected", "protected", "skip"]);

  const l = lib({ musicRoot: home, dataDir: join(root, "data-m") });
  assert.deepEqual(await l.folders.list(), [], "nothing until asked for");
  const listed = await l.folders.add(MUSIC_LIBRARY_PATH);
  const music = listed.find((f) => f.system === "music")!;
  assert.equal(music.name, "Music library");
  assert.equal(music.path, join(home, "Music", "Library.xml"));
  assert.deepEqual(music.sounds.map((s) => s.name), ["Yellow", "Fix You & Me"]);
  assert.equal(music.skipped, 2, "Apple Music and the protected song (the film isn't music)");
  assert.equal(music.sounds[0]!.rel, "A Band/Parachutes/Yellow.m4a", "artist and album as words to search by");
  // Added: copied into media/ with its own name and type.
  const project = join(root, "proj-m");
  mkdirSync(project);
  const added = await l.add(`folder:${music.sounds[0]!.id}`, project);
  assert.equal(added.path, "media/yellow.m4a");
  assert.equal((added.source as { folder: string }).folder, "Music library");
  assert.ok(existsSync(join(songs, "Yellow.m4a")), "the original stays");
  // Listed again after a restart (kept in sound-folders.json); removed.
  const again = lib({ musicRoot: home, dataDir: join(root, "data-m") });
  assert.equal((await again.folders.list())[0]!.system, "music");
  assert.deepEqual(await again.folders.remove(music.id), []);

  // No XML: the media folder, without Apple Music's folder and .m4p files.
  const plain = join(root, "Music-folder");
  const media = join(plain, "Music", "Media.localized", "Music");
  mkdirSync(join(media, "Artist", "Album"), { recursive: true });
  mkdirSync(join(media, "Apple Music", "X"), { recursive: true });
  writeFileSync(join(media, "Artist", "Album", "01 Song.m4a"), mp3);
  writeFileSync(join(media, "Artist", "Album", "02 Locked.m4p"), mp3);
  writeFileSync(join(media, "Apple Music", "X", "Sub.m4a"), mp3);
  const f = await lib({ musicRoot: plain, dataDir: join(root, "data-f") }).folders.add(MUSIC_LIBRARY_PATH);
  assert.deepEqual(f[0]!.sounds.map((s) => s.rel), ["Artist/Album/01 Song.m4a"]);
  assert.equal(f[0]!.path, media);

  // None at all: listed as missing.
  const missing = await lib({ musicRoot: join(root, "nothing"), dataDir: join(root, "data-n") }).folders.add(MUSIC_LIBRARY_PATH);
  assert.equal(missing[0]!.missing, true);
  const noRoot = await lib({ dataDir: join(root, "data-n2") }).folders.add(MUSIC_LIBRARY_PATH);
  assert.equal(noRoot[0]!.missing, true);
});
