// D249 on the server, offline: Jamendo (a stub on 127.0.0.1) with the user's client ID: only CC0 and
// CC BY tracks come back, its client ID only ever in the request URL (never in a hit, a credit or an
// error), a refused client ID in words, no ID: no request. The Music app's library: read from its
// XML copy (Apple Music, protected, cloud-only and video left out and counted) or, without one,
// from its media folder (Apple Music's folder and .m4p left out); never the real ~/Music in a test;
// a song added into the project's media/.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { allowBaseOverrides } from "../../apps/server/src/generate/providers.ts";
import { soundLibrary } from "../../apps/server/src/library/library.ts";
import { excluded, musicLibraryRoot, parseLibraryXml } from "../../apps/server/src/library/musicApp.ts";
import { jamendoHit, jamendoLicense } from "../../apps/server/src/library/sources.ts";
import { MUSIC_LIBRARY_PATH } from "../../packages/core/src/audio/library.ts";

const CLIENT = "c1i3nt5ecret";
let stub: Server;
let base = "";
let root = "";
let mp3: Buffer;
const requests: Array<URL> = [];
let refuse = false;

const track = (id: number, name: string, ccurl: string, extra: Record<string, unknown> = {}) => ({
  id: String(id),
  name,
  duration: 151,
  artist_id: "77",
  artist_name: "Indie Band",
  license_ccurl: ccurl,
  shareurl: `https://www.jamendo.com/track/${id}`,
  audio: `${base}/stream/${id}.mp3?from=app-${CLIENT}`,
  audiodownload: `${base}/download/${id}.mp3?from=app-${CLIENT}`,
  audiodownload_allowed: true,
  musicinfo: { tags: { genres: ["pop", "indie"], instruments: ["guitar"], vartags: ["happy"] } },
  ...extra,
});

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-d249-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", join(root, "t.mp3")]);
  mp3 = readFileSync(join(root, "t.mp3"));
  stub = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    requests.push(url);
    if (url.pathname === "/v3.0/tracks/") {
      res.writeHead(200, { "content-type": "application/json" });
      if (refuse) return res.end(JSON.stringify({ headers: { status: "failed", code: 5, error_message: `Your credential is not authorized: ${url.searchParams.get("client_id")}` }, results: [] }));
      const all = [
        track(1, "Happy Pop Song", "http://creativecommons.org/licenses/by/3.0/"),
        track(2, "Not Commercial", "http://creativecommons.org/licenses/by-nc/3.0/"),
        track(3, "Share Alike", "http://creativecommons.org/licenses/by-sa/3.0/"),
        track(4, "No Derivatives", "http://creativecommons.org/licenses/by-nd/3.0/"),
        track(5, "Stream Only", "http://creativecommons.org/licenses/by/4.0/", { audiodownload: "", audiodownload_allowed: false }),
      ];
      const id = url.searchParams.get("id");
      const results = id ? all.filter((t) => t.id === id) : all;
      return res.end(JSON.stringify({ headers: { status: "success", code: 0, results_count: results.length, results_fullcount: results.length }, results }));
    }
    if (/^\/(stream|download)\//.test(url.pathname)) {
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length) });
      return res.end(mp3);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  process.env.UNCUT_JAMENDO_BASE = base;
  allowBaseOverrides(true);
});
after(() => {
  stub.closeAllConnections();
  stub.close();
  delete process.env.UNCUT_JAMENDO_BASE;
  if (root) rmSync(root, { recursive: true, force: true });
});

const lib = (opts: { key?: string | undefined; musicRoot?: string; dataDir?: string } = {}) =>
  soundLibrary({ sfxDir: "assets/sfx", dataDir: opts.dataDir ?? join(root, "data"), freesoundKey: async () => undefined, jamendoKey: async () => opts.key, musicRoot: opts.musicRoot, probeSeconds: async () => 1 });

test("Jamendo: CC0 and CC BY only, the client ID only in the URL, a refused ID in words, no ID no request", async () => {
  assert.deepEqual(jamendoLicense("http://creativecommons.org/licenses/by/3.0/"), { license: "by", version: "3.0" });
  for (const no of ["http://creativecommons.org/licenses/by-nc/3.0/", "http://creativecommons.org/licenses/by-sa/4.0/", "http://creativecommons.org/licenses/by-nc-nd/3.0/", undefined]) assert.equal(jamendoLicense(no), undefined, String(no));
  assert.equal(jamendoHit({ ...track(9, "x", "http://creativecommons.org/licenses/by/3.0/"), shareurl: "javascript:alert(1)", shorturl: undefined }), undefined, "a page URL that isn't https");

  const none = lib();
  assert.deepEqual((await none.state()).sources, ["openverse"]);
  const before = requests.length;
  await assert.rejects(none.search({ kind: "music", query: "happy", source: "jamendo" }), /Jamendo client ID/);
  assert.equal(requests.length, before, "no request without a client ID");

  const keyed = lib({ key: CLIENT, dataDir: join(root, "data-j") });
  assert.deepEqual((await keyed.state()).sources, ["openverse", "jamendo"]);
  const r = await keyed.search({ kind: "music", query: "happy pop", source: "jamendo" });
  const sent = requests.at(-1)!;
  assert.equal(sent.pathname, "/v3.0/tracks/");
  assert.equal(sent.searchParams.get("client_id"), CLIENT);
  assert.equal(sent.searchParams.get("search"), "happy pop");
  assert.equal(sent.searchParams.get("include"), "licenses musicinfo");
  assert.equal(r.source, "jamendo");
  assert.deepEqual(r.hits.map((h) => h.id).sort(), ["1", "5"], "BY tracks only: no NC, SA or ND");
  const happy = r.hits.find((h) => h.id === "1")!;
  assert.equal(happy.creator, "Indie Band");
  assert.equal(happy.license, "by");
  assert.equal(happy.licenseVersion, "3.0");
  assert.equal(happy.landingUrl, "https://www.jamendo.com/track/1");
  assert.equal(happy.creatorUrl, "https://www.jamendo.com/artist/77");
  assert.deepEqual(happy.tags, ["pop", "indie", "happy", "guitar"]);
  assert.ok(!JSON.stringify(r).includes(CLIENT), "the client ID never in a result");

  // Added: downloaded (the allowed download URL), credits without the file URL (it names the client ID).
  const project = join(root, "proj");
  mkdirSync(project);
  const added = await keyed.add("jamendo:1", project);
  assert.equal(added.path, "media/happy-pop-song-indie-band.mp3");
  assert.ok(readFileSync(join(project, added.path)).equals(mp3));
  assert.ok(requests.some((u) => u.pathname === "/download/1.mp3"));
  assert.equal((added.source as { module: string }).module, "library.jamendo");
  assert.ok(!JSON.stringify(added).includes(CLIENT), "the client ID never in a project's credits");
  // Stream only (no download allowed): the stream URL.
  await keyed.add("jamendo:5", project);
  assert.ok(requests.some((u) => u.pathname === "/stream/5.mp3"));
  // After a restart (nothing remembered): looked up by id.
  const fresh = lib({ key: CLIENT, dataDir: join(root, "data-j2") });
  const again = await fresh.add("jamendo:1", join(root, "proj"));
  assert.equal(again.path, "media/happy-pop-song-indie-band.mp3", "the same file reused");
  assert.equal(requests.filter((u) => u.searchParams.get("id") === "1").length, 1);

  refuse = true;
  const other = lib({ key: "bad-id", dataDir: join(root, "data-j3") });
  await assert.rejects(other.search({ kind: "music", query: "refused", source: "jamendo" }), (e: Error) => /didn't accept your client ID/.test(e.message) && !e.message.includes("bad-id"));
  refuse = false;
});

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
