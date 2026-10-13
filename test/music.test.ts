// Phase 6 chunk 8 (D91) without the app: the bundled library's metadata against its files, the
// core helpers (filters, tempo, which media is a library track), the Audio tab's planner (one edit;
// never after a voiceover, never longer than the video, its own Music track when the first audio
// track is busy, a problem under 3 s) and the server's copy into media/ (identical copies reused,
// a different file gets -2, concurrent adds of one track end with one file and all succeed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyEdit, createSession, filterMusic, libraryTrackOf, loadModules, MUSIC_TRACKS, musicTempo, musicTrack, validateOps, validateProject, type Op, type Project } from "../packages/core/src/index.ts";
import { planAddMusic } from "../apps/web/src/project.ts";
import { copyLibraryTrack } from "../apps/server/src/music.ts";

const MUSIC = resolve("assets/music");
const modules = await loadModules("spec/modules/builtin");
const hasFfprobe = !spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).error;

test("library.json describes the shipped files: five CC0 tracks, about −16 LUFS, lengths as measured", { skip: hasFfprobe ? false : "needs ffprobe" }, () => {
  assert.equal(MUSIC_TRACKS.length, 5);
  for (const t of MUSIC_TRACKS) {
    assert.equal(t.license, "CC0-1.0");
    assert.match(t.source, /^https:\/\/freesound\.org\//);
    assert.ok(Math.abs(t.lufs + 16) <= 0.5, `${t.id} ${t.lufs}`);
    const path = join(MUSIC, t.file);
    assert.equal(readFileSync(path).length, t.bytes, t.file);
    const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }));
    assert.ok(Math.abs(seconds - t.seconds) < 0.01, `${t.id}: ${seconds} vs ${t.seconds}`);
    assert.ok(t.seconds <= 125, "trimmed to about 2 min");
  }
  assert.deepEqual(readdirSync(MUSIC).filter((f) => f.endsWith(".md")), [], "no .md licence file (they're never committed)");
});

test("filters, tempo and library media by path", () => {
  assert.equal(musicTempo(null), "free");
  assert.equal(musicTempo(75), "slow");
  assert.equal(musicTempo(95), "medium");
  assert.equal(musicTempo(120), "fast");
  assert.deepEqual(filterMusic({ mood: "calm" }).map((t) => t.id), ["cozy-4"]);
  assert.deepEqual(filterMusic({ tempo: "medium" }).map((t) => t.id), ["cozy-3"]);
  assert.deepEqual(filterMusic({ query: "RHODES soul" }).map((t) => t.id), ["cozy-2"]);
  assert.equal(filterMusic().length, 5);
  assert.equal(libraryTrackOf({ path: "media/cozy-1.m4a" })?.id, "cozy-1");
  assert.equal(libraryTrackOf({ path: "media/cozy-1-2.m4a" })?.id, "cozy-1");
  assert.equal(libraryTrackOf({ path: "/Users/x/cozy-1.m4a" }), undefined, "only copies inside the project");
  assert.equal(libraryTrackOf({ path: "media/song.m4a" }), undefined);
});

const fps = 30;
function project(audio: Array<{ id: string; name: string; items: Array<{ start: number; duration: number }> }> = [], mainFrames = 900): Project {
  return {
    format: "uncut/0",
    name: "x",
    canvas: { width: 1080, height: 1350, fps },
    media: [
      { id: "m", kind: "video", name: "c.mp4", path: "/tmp/c.mp4", probe: { frames: 9000, hasAudio: false } },
      { id: "vo", kind: "audio", name: "VO.m4a", path: "/tmp/vo.m4a", probe: { frames: 9000 } },
    ],
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: mainFrames ? [{ id: "c", type: "clip", media: "m", in: 0, duration: mainFrames }] : [] },
      ...audio.map((t) => ({ id: t.id, kind: "audio" as const, name: t.name, items: t.items.map((i, n) => ({ id: `${t.id}-${n}`, type: "audio" as const, media: "vo", in: 0, ...i })) })),
    ],
  };
}
const apply = (p: Project, ops: ReadonlyArray<unknown>) => {
  assert.deepEqual(validateOps(ops), []);
  const next = applyEdit(createSession(p), { actor: "user", ops: ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
};

test("+ on a library track: with a voiceover on the only audio track it gets its own Music track, as long as the video", () => {
  const cozy1 = musicTrack("cozy-1")!;
  const p = project([{ id: "voice", name: "Voice", items: [{ start: 0, duration: 900 }] }]);
  const plan = planAddMusic(p, cozy1, "media/cozy-1.m4a", 0);
  assert.ok(!("problem" in plan), JSON.stringify(plan));
  const next = apply(p, plan.ops);
  const music = next.tracks.find((t) => t.name === "Music")!;
  assert.ok(music, "a new Music track");
  assert.deepEqual(music.items, [{ id: "audio-1", type: "audio", media: "m-chill-lofi-lost-stars", in: 0, duration: 900, start: 0, fadeIn: 30, fadeOut: 60 }]);
  assert.deepEqual(next.tracks.find((t) => t.id === "voice")!.items.length, 1, "nothing after the voiceover");
  assert.equal(plan.summary, "Add Chill Lofi - lost stars from the music library");
  // From the playhead at 10 s: the 20 s left, on the first free track.
  const free = project([{ id: "voice", name: "Voice", items: [{ start: 0, duration: 200 }] }]);
  const later = planAddMusic(free, cozy1, "media/cozy-1.m4a", 300);
  assert.ok(!("problem" in later));
  const placed = apply(free, later.ops).tracks.find((t) => t.id === "voice")!.items.at(-1)!;
  assert.equal(placed.start, 300);
  assert.equal(placed.duration, 600);
  // Already in the project: no add_media, the same media.
  const again = planAddMusic(apply(p, plan.ops), cozy1, undefined, 0);
  assert.ok(!("problem" in again));
  assert.ok(!again.ops.some((o) => (o as { op: string }).op === "add_media"));
});

test("+ near the end is a problem, and an empty timeline gets the whole track", () => {
  const cozy2 = musicTrack("cozy-2")!;
  const p = project([], 900);
  const atEnd = planAddMusic(p, cozy2, "media/cozy-2.m4a", 900);
  assert.ok("problem" in atEnd && /at the end of the video/.test(atEnd.problem));
  const close = planAddMusic(p, cozy2, "media/cozy-2.m4a", 850);
  assert.ok("problem" in close && /Only 1\.7 s of the video are left/.test(close.problem));
  const empty = project([], 0);
  const whole = planAddMusic(empty, cozy2, "media/cozy-2.m4a", 0);
  assert.ok(!("problem" in whole));
  const item = apply(empty, whole.ops).tracks.find((t) => t.kind === "audio")!.items[0]!;
  assert.equal(item.duration, Math.floor(cozy2.seconds * fps));
  // Shorter than the video: the whole track.
  const long = project([], 3000);
  const fits = planAddMusic(long, cozy2, "media/cozy-2.m4a", 0);
  assert.ok(!("problem" in fits));
  assert.equal(apply(long, fits.ops).tracks.find((t) => t.kind === "audio")!.items[0]!.duration, Math.floor(cozy2.seconds * fps));
});

test("the copy into media/: reused when identical, -2 when another file has the name, concurrent adds end with one file", async () => {
  const root = mkdtempSync(join(tmpdir(), "uncut-music-"));
  try {
    for (let run = 0; run < 20; run++) {
      const dir = join(root, `p${run}`);
      mkdirSync(dir);
      const results = await Promise.all([1, 2, 3].map(() => copyLibraryTrack(MUSIC, dir, "cozy-3")));
      assert.deepEqual(results.map((r) => ("path" in r ? r.path : r.problem)), ["media/cozy-3.m4a", "media/cozy-3.m4a", "media/cozy-3.m4a"], `run ${run}`);
      assert.deepEqual(readdirSync(join(dir, "media")), ["cozy-3.m4a"], "one file, no leftovers");
    }
    const dir = join(root, "p0");
    assert.ok(readFileSync(join(dir, "media", "cozy-3.m4a")).equals(readFileSync(join(MUSIC, "cozy-3.m4a"))));
    // Another file with the library's name: the copy goes next to it.
    writeFileSync(join(dir, "media", "cozy-1.m4a"), "not the track");
    const other = await copyLibraryTrack(MUSIC, dir, "cozy-1");
    assert.ok("path" in other && other.path === "media/cozy-1-2.m4a");
    assert.equal(readFileSync(join(dir, "media", "cozy-1.m4a"), "utf8"), "not the track", "never replaced");
    const reused = await copyLibraryTrack(MUSIC, dir, "cozy-1");
    assert.ok("path" in reused && reused.path === "media/cozy-1-2.m4a");
    const missing = await copyLibraryTrack(MUSIC, dir, "cozy-9");
    assert.ok("problem" in missing && /no library track/.test(missing.problem));
    const noFiles = await copyLibraryTrack(join(root, "nowhere"), dir, "cozy-2");
    assert.ok("problem" in noFiles && /missing from this copy of Uncut/.test(noFiles.problem));
    assert.ok(!existsSync(join(dir, "media", "cozy-2.m4a")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
