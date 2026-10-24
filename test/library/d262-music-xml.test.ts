// D262 (review of #69, D249): the Music library's XML is streamed a track at a time and never
// blocks the server for long; the scan stops at the song cap; a character reference that names no
// character reads as U+FFFD instead of throwing; a deleted song is left out and counted; one source
// that fails is listed as missing without hiding the user's other folders; an unchanged XML (same
// size and mtime) is not read again.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { MAX_MUSIC_SONGS, parseLibraryXml, readMusicLibrary, scanLibraryXml } from "../../apps/server/src/library/musicApp.ts";
import { soundFolders } from "../../apps/server/src/library/folders.ts";
import { MUSIC_LIBRARY_PATH } from "../../packages/core/src/audio/library.ts";
import { budget } from "../helpers/timing.ts";

let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-d262-")));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>Major Version</key><integer>1</integer>\n\t<key>Tracks</key>\n\t<dict>\n`;
const TAIL = `\t</dict>\n\t<key>Playlists</key>\n\t<array>\n\t\t<dict><key>Name</key><string>Library</string><key>Playlist Items</key><array><dict><key>Track ID</key><integer>1</integer></dict></array></dict>\n\t</array>\n</dict>\n</plist>\n`;
/** One track as Music writes it (about 25 keys). */
const entry = (id: number, extra: string) =>
  `\t\t<key>${id}</key>\n\t\t<dict>\n\t\t\t<key>Track ID</key><integer>${id}</integer>\n\t\t\t<key>Name</key><string>Song number ${id} &#38; friends</string>\n\t\t\t<key>Artist</key><string>Artist ${id % 977}</string>\n\t\t\t<key>Album Artist</key><string>Artist ${id % 977}</string>\n\t\t\t<key>Album</key><string>Album ${id % 3011}</string>\n\t\t\t<key>Genre</key><string>Pop</string>\n\t\t\t<key>Kind</key><string>Apple Music AAC audio file</string>\n\t\t\t<key>Size</key><integer>${4000000 + id}</integer>\n\t\t\t<key>Total Time</key><integer>201000</integer>\n\t\t\t<key>Disc Number</key><integer>1</integer>\n\t\t\t<key>Disc Count</key><integer>1</integer>\n\t\t\t<key>Track Number</key><integer>${id % 12}</integer>\n\t\t\t<key>Track Count</key><integer>12</integer>\n\t\t\t<key>Year</key><integer>2019</integer>\n\t\t\t<key>Date Modified</key><date>2021-03-01T10:00:00Z</date>\n\t\t\t<key>Date Added</key><date>2021-03-01T10:00:00Z</date>\n\t\t\t<key>Bit Rate</key><integer>256</integer>\n\t\t\t<key>Sample Rate</key><integer>44100</integer>\n\t\t\t<key>Play Count</key><integer>3</integer>\n\t\t\t<key>Release Date</key><date>2019-05-01T12:00:00Z</date>\n\t\t\t<key>Normalization</key><integer>1234</integer>\n\t\t\t<key>Persistent ID</key><string>${id.toString(16).padStart(16, "0")}</string>\n${extra}\t\t</dict>\n`;

async function writeXml(file: string, count: number, extra: (id: number) => string) {
  const out = createWriteStream(file);
  out.write(HEAD);
  for (let id = 1; id <= count; id++) if (!out.write(entry(id, extra(id)))) await new Promise<void>((r) => out.once("drain", () => r()));
  out.write(TAIL);
  await new Promise<void>((r) => out.end(r));
}

test("a large Library.xml streams without blocking the event loop for long", { timeout: 120000 }, async () => {
  const home = join(root, "big");
  mkdirSync(join(home, "Music"), { recursive: true });
  const file = join(home, "Music", "Library.xml");
  // 100k streamed songs (Apple Music: all left out, so the scan reads to the end): ~110 MB.
  const COUNT = 100_000;
  await writeXml(file, COUNT, () => `\t\t\t<key>Apple Music</key><true/>\n\t\t\t<key>Track Type</key><string>Remote</string>\n`);
  const h = monitorEventLoopDelay({ resolution: 5 });
  // A timer that measures every gap between its runs too (the histogram's own view, cross-checked).
  let worstGap = 0;
  let lastTick = performance.now();
  const tick = setInterval(() => {
    const t = performance.now();
    worstGap = Math.max(worstGap, t - lastTick);
    lastTick = t;
  }, 5);
  h.enable();
  const t0 = performance.now();
  const slices: Array<number> = [];
  const lib = await readMusicLibrary(
    home,
    "f-music",
    async () => ({ sounds: [], paths: new Map(), truncated: false }),
    (ms) => slices.push(ms),
  );
  const took = performance.now() - t0;
  h.disable();
  clearInterval(tick);
  const maxBlockMs = h.max / 1e6;
  const worstSlice = Math.max(...slices);
  console.log(
    `100k-track XML: ${took.toFixed(0)} ms in all, ${slices.length} slices, the longest ${worstSlice.toFixed(1)} ms (wall clock); worst event-loop delay ${maxBlockMs.toFixed(1)} ms, worst timer gap ${worstGap.toFixed(1)} ms`,
  );
  assert.equal(lib.found, true);
  assert.equal(lib.sounds.length, 0);
  assert.equal(lib.skipped, COUNT, "every Apple Music song counted");
  // Before D262 the whole file was one synchronous parse (~0.3 s for this size). Each slice of work
  // between two yields is short; the timers' view is logged (a loaded test machine stretches it).
  assert.ok(slices.length > 100, `the work was split up (${slices.length} slices)`);
  // Slices are timed by wall clock, so a test machine under load (the full suite runs files in
  // parallel next to packaged-app tests) can stretch one or two by descheduling or a GC pause; the
  // work itself is judged by the typical slice and the 95th percentile, with only a handful allowed long.
  const sorted = [...slices].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  // 50 ms on an Apple-silicon Mac, scaled on a slower one (a CI runner's virtual cores, #89).
  const LONG_MS = budget(50);
  const long = slices.filter((ms) => ms >= LONG_MS).length;
  assert.ok(p95 < LONG_MS, `95% of the slices held the event loop under ${p95.toFixed(1)} ms (budget ${LONG_MS.toFixed(0)} ms)`);
  assert.ok(long <= Math.max(3, slices.length * 0.02), `${long} of ${slices.length} slices held the event loop ${LONG_MS.toFixed(0)} ms or more`);
});

test("the scan stops at the song cap; deleted songs are left out and counted", { timeout: 60000 }, async () => {
  const home = join(root, "cap");
  const songs = join(root, "cap-songs");
  mkdirSync(join(home, "Music"), { recursive: true });
  mkdirSync(songs, { recursive: true });
  const file = join(home, "Music", "Library.xml");
  // 3 songs on disk, then far more than the cap whose files are gone.
  for (const n of [1, 2, 3]) writeFileSync(join(songs, `s${n}.mp3`), Buffer.alloc(1000, n));
  const total = MAX_MUSIC_SONGS * 3;
  await writeXml(
    file,
    total,
    (id) =>
      `\t\t\t<key>Track Type</key><string>File</string>\n\t\t\t<key>Location</key><string>${pathToFileURL(join(songs, `s${id}.mp3`)).href.replace("file:///", "file://localhost/")}</string>\n`,
  );
  let read = 0;
  const visited = await scanLibraryXml(file, () => ++read <= 10);
  assert.equal(visited, 11, "the scan stops as soon as it is told to");
  const lib = await readMusicLibrary(home, "f-music", async () => ({ sounds: [], paths: new Map(), truncated: false }));
  assert.equal(lib.truncated, true);
  assert.deepEqual(
    lib.sounds.map((s) => s.rel.split("/").at(-1)),
    ["s1.mp3", "s2.mp3", "s3.mp3"],
  );
  assert.equal(lib.sounds[0]!.bytes, 1000, "the size on disk");
  assert.equal(lib.skipped, MAX_MUSIC_SONGS - 3, "the listed songs whose files are gone are counted");
});

test("a character reference that names no character reads as U+FFFD", () => {
  const xml = `${HEAD}<key>1</key><dict><key>Name</key><string>Bad &#99999999; &#xD800; &#x1F600; ok</string></dict>${TAIL}`;
  const [t] = parseLibraryXml(xml);
  assert.equal(t!.Name, "Bad � � \u{1F600} ok");
});

test("one source that fails is listed as missing and hides none of the user's folders; an unchanged XML isn't read again", async () => {
  const dataDir = join(root, "data");
  const mine = join(root, "My sounds");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "Whoosh.wav"), Buffer.alloc(2000, 1));
  const home = join(root, "stamp");
  mkdirSync(join(home, "Music"), { recursive: true });
  const xml = join(home, "Music", "Library.xml");
  writeFileSync(xml, `${HEAD}<key>1</key><dict><key>Name</key><string>A</string></dict>${TAIL}`);

  let fail = true;
  let reads = 0;
  const readMusic: typeof readMusicLibrary = async (...args) => {
    reads++;
    if (fail) throw new RangeError("Invalid code point 99999999");
    return readMusicLibrary(...args);
  };
  const folders = soundFolders({ dataDir, musicRoot: home, readMusic });
  await folders.add(mine);
  const listed = await folders.add(MUSIC_LIBRARY_PATH);
  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.find((f) => f.path === mine)?.sounds.map((s) => s.name),
    ["Whoosh"],
    "the user's folder still listed",
  );
  const music = listed.find((f) => f.system === "music")!;
  assert.equal(music.missing, true, "the failing source is listed as missing");
  assert.equal(music.name, "Music library");

  // Read once, then reused while the XML's size and mtime hold; read again once it changes.
  fail = false;
  reads = 0;
  await folders.list(true);
  await folders.list();
  await folders.list();
  assert.equal(reads, 1, "an unchanged XML is read once");
  utimesSync(xml, new Date(), new Date(Date.now() + 5000));
  await folders.list();
  assert.equal(reads, 2, "a changed XML is read again");
  // Two lists at once share one read.
  utimesSync(xml, new Date(), new Date(Date.now() + 10000));
  await Promise.all([folders.list(), folders.list()]);
  assert.equal(reads, 3, "concurrent lists share one read");
});
