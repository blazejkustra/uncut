// Phase 3 chunk 5: media.import runs as a server-side job: probes through the media core
// (ffprobe for what it can't read), one undoable edit into the project it was started in,
// posters afterwards, served only to the token. Covers the review's attack cases too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { lockApps, unlockApps } from "../helpers/app.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip =
  !existsSync(BUNDLE) || !existsSync(MEDIA) ? "server or media core not built (run pnpm build)" : !hasFfmpeg ? "needs ffmpeg to make test media" : false;
const T = { skip, timeout: 120000 };

let root: string, files: Record<"clip" | "still" | "wav" | "rotated" | "frag" | "broken" | "missing", string>, s: Session;
const ffmpeg = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const color = (name: string | null, c: string, path?: string) =>
  ffmpeg("-f", "lavfi", "-i", `color=c=${c}:size=64x48`, "-frames:v", "1", path ?? join(root, name!));
/** Average colour of an image as [r, g, b]. */
const rgb = (path: string) => [...execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];

type Session = Awaited<ReturnType<typeof session>>;
async function session(env: NodeJS.ProcessEnv = {}) {
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), ...env } });
  const client = await connect(server.ready.port, server.ready.token);
  const jobs = client.subscribe("media.jobs");
  /** Start an import and wait for its job to finish. */
  const importAndWait = async (paths: ReadonlyArray<string>, timeout = 60000) => {
    const { jobId } = await client.ok("media.import", { paths });
    await waitJob(jobId, timeout);
    return jobs.values
      .flat()
      .filter((j) => j.id === jobId)
      .at(-1);
  };
  const waitJob = (jobId: string, timeout = 60000) =>
    jobs.until((list) => list.some((j: any) => j.id === jobId && (j.phase === "done" || j.phase === "failed")), timeout);
  return {
    ...client,
    server,
    jobs,
    importAndWait,
    waitJob,
    base: `http://127.0.0.1:${server.ready.port}`,
    token: server.ready.token,
    end: async () => (client.close(), await server.stop()),
  };
}

before(async () => {
  if (skip) return;
  // Hundreds of ffmpeg runs: take a turn with the Electron tests, whose pixel and timing checks
  // (and VideoToolbox) suffer when the machine is this busy.
  await lockApps();
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-import-")));
  files = {
    clip: join(root, "Holiday Clip.mp4"),
    still: join(root, "poster.png"),
    wav: join(root, "voice.wav"),
    rotated: join(root, "phone.mp4"),
    frag: join(root, "fragmented.mp4"),
    broken: join(root, "broken.mp4"),
    missing: join(root, "missing.mp4"),
  };
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    files.clip,
  );
  ffmpeg("-f", "lavfi", "-i", "testsrc=size=640x360", "-frames:v", "1", files.still);
  ffmpeg("-f", "lavfi", "-i", "sine=duration=1.5", files.wav);
  ffmpeg("-display_rotation", "-90", "-i", files.clip, "-c", "copy", files.rotated);
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "frag_keyframe+empty_moov",
    files.frag,
  );
  writeFileSync(files.broken, "this is not a video");
  s = await session();
});
after(async () => {
  await s?.end();
  killAll();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

let dir: string;
test("one job: good files in one edit, bad ones reported in order, nothing copied", T, async () => {
  ({ dir } = await s.ok("project.create", { parentDir: root, name: "Imports" }));
  const before = (await s.ok("project.get")).revision;
  mkdirSync(join(root, "a-folder"));
  const job = await s.importAndWait([
    files.clip,
    files.still,
    files.wav,
    files.rotated,
    files.frag,
    files.broken,
    files.missing,
    "relative/clip.mp4",
    join(root, "a-folder"),
  ]);
  assert.equal(job.phase, "done");
  assert.deepEqual(
    job.result.imported.map((i: any) => [i.name, i.id, i.via]),
    [
      ["Holiday Clip.mp4", "m-holiday-clip", "native"],
      ["poster.png", "m-poster", "native"],
      ["voice.wav", "m-voice", "ffprobe"],
      ["phone.mp4", "m-phone", "native"],
      ["fragmented.mp4", "m-fragmented", "native"],
    ],
  );
  assert.deepEqual(
    job.result.failed.map((f: any) => [f.path, f.message]),
    [
      [files.broken, "Uncut can't read this kind of file yet."],
      [files.missing, "The file doesn't exist."],
      ["relative/clip.mp4", "Not an absolute path."],
      [join(root, "a-folder"), "Folders can't be imported yet; drop the files inside."],
    ],
  );
  assert.equal(job.postersTotal, 4);
  assert.equal(job.postersDone, 4);
  const snap = await s.ok("project.get");
  assert.equal(snap.revision, before + 1, "one edit for the whole batch");
  const media = Object.fromEntries(snap.project.media.map((m: any) => [m.id, m]));
  assert.deepEqual(media["m-holiday-clip"], {
    id: "m-holiday-clip",
    kind: "video",
    name: "Holiday Clip.mp4",
    path: files.clip,
    probe: { frames: 60, fps: 30, width: 320, height: 240, hasAudio: true },
  });
  assert.deepEqual(media["m-poster"], {
    id: "m-poster",
    kind: "image",
    name: "poster.png",
    path: files.still,
    probe: { width: 640, height: 360, hasAudio: false },
  });
  assert.equal(media["m-voice"].probe.frames, 45);
  assert.deepEqual([media["m-phone"].probe.width, media["m-phone"].probe.height], [240, 320], "stored as shown: portrait");
  assert.equal(media["m-fragmented"].probe.frames, 60, "a fragmented MP4 still gets its length");
  for (const m of snap.project.media) if (m.kind !== "image") assert.ok(m.probe.frames >= 1, m.id);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).media, snap.project.media);
  assert.ok(!existsSync(join(dir, "media", "Holiday Clip.mp4")), "footage is referenced, not copied");
});

test("importing a path that's already in the project skips it, even from two jobs at once", T, async () => {
  const revision = (await s.ok("project.get")).revision;
  const again = await s.importAndWait([files.clip, files.clip]);
  assert.deepEqual(again.result.imported, []);
  assert.deepEqual(
    again.result.skipped.map((x: any) => x.reason),
    ["Already in the project.", "Already in the project."],
  );
  assert.equal((await s.ok("project.get")).revision, revision);

  // Two jobs started together with the same new file: one imports it, the other skips it.
  const twin = join(root, "twin.png");
  color("twin.png", "green");
  const [a, b] = await Promise.all([s.ok("media.import", { paths: [twin] }), s.ok("media.import", { paths: [twin] })]);
  await s.waitJob(a.jobId);
  await s.waitJob(b.jobId);
  const finished = s.jobs.values.at(-1).filter((j: any) => j.id === a.jobId || j.id === b.jobId);
  assert.deepEqual(
    finished.map((j: any) => j.phase),
    ["done", "done"],
  );
  assert.equal(
    finished.reduce((n: any, j: any) => n + j.result.imported.length, 0),
    1,
  );
  assert.deepEqual(
    finished.flatMap((j: any) => j.result.skipped.map((x: any) => x.reason)),
    ["Already in the project."],
  );
});

test("ids never collide with track, item or scene ids", T, async () => {
  await s.ok("project.edit", { ops: [{ op: "add_track", track: { id: "m-collide", kind: "video", name: "Overlay" } }] });
  const collide = join(root, "collide.png");
  color("collide.png", "white");
  const job = await s.importAndWait([collide]);
  assert.deepEqual(
    job.result.imported.map((i: any) => i.id),
    ["m-collide-2"],
  );
  await s.ok("project.undo");
  await s.ok("project.undo");
});

test("thumbnails: only with the token, only the current file's poster, and no traversal", T, async () => {
  const get = (path: string, token: string | null = s.token) => fetch(`${s.base}${path}${token === null ? "" : `?token=${encodeURIComponent(token)}`}`);
  const ok = await get("/media/thumb/m-holiday-clip");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer()).slice(0, 3)], [0xff, 0xd8, 0xff]);
  assert.equal((await get("/media/thumb/m-holiday-clip", null)).status, 401);
  assert.equal((await get("/media/thumb/m-holiday-clip", "wrong")).status, 401);
  for (const path of [
    "/media/thumb/..%2F..%2Fproject.json",
    "/media/thumb/../../project.json",
    "/media/thumb/m-holiday-clip.jpg",
    "/media/thumb/%2Fetc%2Fpasswd",
    "/media/thumb/m-nope",
    "/media/thumb/",
    "/media/thumb/%E0%A4%A",
    "/media/thumb/%",
  ]) {
    assert.equal((await get(path)).status, 404, path);
  }
  // A symlink planted under the expected poster name, pointing outside, isn't followed.
  const thumbs = join(dir, ".cache/thumbs");
  const real = readdirSync(thumbs).find((f) => f.startsWith("m-poster--"))!;
  rmSync(join(thumbs, real));
  symlinkSync(join(dir, "project.json"), join(thumbs, real));
  assert.equal((await get("/media/thumb/m-poster")).status, 404);
  const list = await s.ok("media.thumbnails");
  assert.ok(list.includes("m-holiday-clip"));
});

test("a reused id gets its own poster, not the old file's", T, async () => {
  const first = join(root, "one", "same.png");
  const second = join(root, "two", "same.png");
  mkdirSync(join(root, "one"));
  mkdirSync(join(root, "two"));
  color(null, "red", first);
  color(null, "blue", second);
  const a = await s.importAndWait([first]);
  assert.deepEqual(
    a.result.imported.map((i: any) => i.id),
    ["m-same"],
  );
  await s.ok("project.undo");
  const b = await s.importAndWait([second]);
  assert.deepEqual(
    b.result.imported.map((i: any) => i.id),
    ["m-same"],
  );
  const bytes = Buffer.from(await (await fetch(`${s.base}/media/thumb/m-same?token=${s.token}`)).arrayBuffer());
  const poster = join(root, "fetched.jpg");
  writeFileSync(poster, bytes);
  const [r, , bl] = rgb(poster);
  assert.ok(bl > 150 && r < 100, `poster colour ${rgb(poster)} should be blue`);
  assert.equal(readdirSync(join(dir, ".cache/thumbs")).filter((f) => f.startsWith("m-same--")).length, 1, "the old poster is gone");
});

test("a file named like an image sequence (shot%d.png) is imported as itself", T, async () => {
  // (ffmpeg would itself expand the % in an output name, so make it under another name first.)
  const pattern = join(root, "shot%d.png");
  color("red-shot.png", "red");
  execFileSync("mv", [join(root, "red-shot.png"), pattern]);
  color("shot1.png", "blue");
  const job = await s.importAndWait([pattern]);
  assert.deepEqual(
    job.result.imported.map((i: any) => i.name),
    ["shot%d.png"],
  );
  const poster = readdirSync(join(dir, ".cache/thumbs")).find((f) => f.startsWith(`${job.result.imported[0].id}--`))!;
  const [r, , bl] = rgb(join(dir, ".cache/thumbs", poster));
  assert.ok(r > 150 && bl < 100, `poster colour ${rgb(join(dir, ".cache/thumbs", poster))} should be red (shot%d.png), not blue (shot1.png)`);
});

test("FIFOs aren't opened: the job reports them and finishes", T, async () => {
  const fifo = join(root, "pipe.mp4");
  execFileSync("mkfifo", [fifo]);
  const started = Date.now();
  const job = await s.importAndWait([fifo], 15000);
  assert.deepEqual(
    job.result.failed.map((f: any) => f.message),
    ["Not a regular file."],
  );
  assert.ok(Date.now() - started < 10000);
});

test("undo removes a whole import; redo brings it back", T, async () => {
  const media = (await s.ok("project.get")).project.media.length;
  const one = join(root, "undo-me.png");
  color("undo-me.png", "yellow");
  await s.importAndWait([one]);
  assert.equal((await s.ok("project.get")).project.media.length, media + 1);
  assert.equal((await s.ok("project.undo")).project.media.length, media);
  assert.equal((await s.ok("project.redo")).project.media.length, media + 1);
});

test("a big import isn't cut short by any request timeout and reports progress", T, async () => {
  const many = join(root, "many");
  mkdirSync(many);
  color(null, "gray", join(many, "src.png"));
  const paths = Array.from({ length: 200 }, (_, i) => {
    const p = join(many, `frame-${String(i).padStart(3, "0")}.png`);
    copyFileSync(join(many, "src.png"), p);
    return p;
  });
  const { jobId } = await s.ok("media.import", { paths });
  await s.waitJob(jobId, 110000);
  const states = s.jobs.values.flat().filter((j: any) => j.id === jobId);
  const last = states.at(-1);
  assert.equal(last.phase, "done");
  assert.equal(last.result.imported.length, 200);
  assert.ok(
    states.some((j: any) => j.phase === "probing" && j.probed > 0 && j.probed < 200) ||
      states.some((j: any) => j.phase === "posters" && j.postersDone > 0 && j.postersDone < 200),
    "progress was reported along the way",
  );
  await s.ok("project.undo");
});

test("an import never lands in another project: closing it mid-way refuses the edit", T, async () => {
  const other = await s.ok("project.create", { parentDir: root, name: "Other" });
  const busy = Array.from({ length: 60 }, (_, i) => join(root, "many", `frame-${String(i).padStart(3, "0")}.png`));
  const { jobId } = await s.ok("media.import", { paths: busy });
  // Switch projects while the job is still probing.
  await s.ok("project.open", { dir });
  await s.waitJob(jobId);
  const job = s.jobs.values
    .flat()
    .filter((j: any) => j.id === jobId)
    .at(-1);
  assert.equal(job.phase, "failed");
  assert.equal(job.error, "The project was closed before this finished.");
  assert.deepEqual(JSON.parse(readFileSync(join(other.dir, "project.json"), "utf8")).media, []);
  assert.ok(!existsSync(join(other.dir, ".cache/thumbs")) || readdirSync(join(other.dir, ".cache/thumbs")).length === 0);
});

test("if the media core dies on a file, it's restarted for the rest of the batch", T, async () => {
  // A helper that dies on any request mentioning "crash" and hands the rest to the real one.
  const fake = join(root, "dying-helper.sh");
  writeFileSync(fake, `#!/bin/sh\nwhile IFS= read -r line; do\n  case "$line" in *crash*) exit 3;; esac\n  printf '%s\\n' "$line" | "${MEDIA}"\ndone\n`);
  chmodSync(fake, 0o755);
  const t = await session({ UNCUT_MEDIA_BIN: fake });
  try {
    await t.ok("project.create", { parentDir: root, name: "Crashy" });
    const crash = join(root, "crash.png");
    color("crash.png", "black");
    color("after.png", "white");
    const job = await t.importAndWait([files.still, crash, join(root, "after.png")]);
    assert.deepEqual(
      job.result.imported.map((i: any) => i.name),
      ["poster.png", "after.png"],
    );
    assert.deepEqual(
      job.result.failed.map((f: any) => [f.path, f.message]),
      [[crash, "The media core stopped while reading this file."]],
    );
  } finally {
    await t.end();
  }
});

test("without an open project, import says so", T, async () => {
  await s.ok("project.close");
  const error = await s.fail("media.import", { paths: [files.clip] });
  assert.equal(error.reason, "no-project");
});
