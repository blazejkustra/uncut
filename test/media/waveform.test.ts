// Phase 4 chunk 5 (D54): GET /media/waveform/<id> gives the timeline the peaks of a media item's
// sound. Only with the token, only media of the open project that has sound; made with ffmpeg on
// the first request, cached under the project's .cache/waveforms keyed by the file, and read from
// there afterwards. Also: the media file route allows CORS reads (Web Audio needs them).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, projectCopy, startServer } from "../helpers/server.ts";
import { isWaveformFileOf, makeLimiter, PeakMeter } from "../../apps/server/src/media/waveforms.ts";
import { chmodSync, mkdirSync } from "node:fs";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip =
  !existsSync(BUNDLE) || !existsSync(MEDIA) ? "server or media core not built (run pnpm build)" : !hasFfmpeg ? "needs ffmpeg to make test media" : false;
const T = { skip, timeout: 60000 };

let root = "";
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let client: Awaited<ReturnType<typeof connect>> | undefined;
let base = "";
let token = "";
let dir = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-wave-")));
  // 2 s of a 440 Hz tone at half scale, then 1 s of silence.
  ff("-f", "lavfi", "-i", "aevalsrc='if(lt(t,2),0.5*sin(2*PI*440*t),0)':s=48000:d=3", "-c:a", "aac", "-b:a", "192k", join(root, "Tone.m4a"));
  ff("-f", "lavfi", "-i", "testsrc=size=160x120:rate=30", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "silent.mp4"));
  ff(
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x120:rate=30",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.25*sin(2*PI*660*t):s=48000",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    join(root, "talk.mp4"),
  );
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data") } });
  client = await connect(server.ready.port, server.ready.token);
  base = `http://127.0.0.1:${server.ready.port}`;
  token = server.ready.token;
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const get = (path: string, auth: string | null = token) => fetch(`${base}${path}${auth === null ? "" : `?token=${encodeURIComponent(auth)}`}`);
const peaksOf = (json: { peaks: string }) => [...Buffer.from(json.peaks, "base64")];

test("waveforms: token, known media with sound, peaks that match the file, cached after the first request", T, async () => {
  assert.equal((await get("/media/waveform/m-tone")).status, 404, "nothing open yet");
  const snapshot = await client!.ok("project.create", { parentDir: root, name: "Waves" });
  dir = (snapshot as { dir: string }).dir;
  await client!.ok("project.edit", {
    ops: [
      { op: "add_media", media: { id: "m-tone", kind: "audio", name: "Tone.m4a", path: join(root, "Tone.m4a"), probe: { frames: 90, hasAudio: true } } },
      {
        op: "add_media",
        media: {
          id: "m-silent",
          kind: "video",
          name: "silent.mp4",
          path: join(root, "silent.mp4"),
          probe: { frames: 30, fps: 30, width: 160, height: 120, hasAudio: false },
        },
      },
      {
        op: "add_media",
        media: {
          id: "m-talk",
          kind: "video",
          name: "talk.mp4",
          path: join(root, "talk.mp4"),
          probe: { frames: 30, fps: 30, width: 160, height: 120, hasAudio: true },
        },
      },
      { op: "add_media", media: { id: "m-gone", kind: "audio", name: "gone.m4a", path: join(root, "gone.m4a"), probe: { frames: 30, hasAudio: true } } },
    ],
  });

  assert.equal((await get("/media/waveform/m-tone", null)).status, 401, "no token");
  assert.equal((await get("/media/waveform/m-tone", "wrong")).status, 401, "bad token");
  assert.equal((await get("/media/waveform/m-nope")).status, 404, "unknown id");
  assert.equal((await get("/media/waveform/..%2Fsecret")).status, 404, "not an id");
  assert.equal((await get("/media/waveform/m-silent")).status, 404, "a video without sound");
  assert.equal((await get("/media/waveform/m-gone")).status, 404, "a file that isn't there");

  // First request: decoded (two at once share one decode).
  const [first, again] = await Promise.all([get("/media/waveform/m-tone"), get("/media/waveform/m-tone")]);
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(first.headers.get("x-uncut-waveform"), "decode");
  assert.equal(first.headers.get("content-type"), "application/json");
  assert.equal(first.headers.get("access-control-allow-origin"), "*", "the file:// renderer may read it");
  const json = (await first.json()) as { version: number; rate: number; seconds: number; peaks: string };
  assert.deepEqual(await again.json(), json);
  assert.equal(json.version, 1);
  assert.equal(json.rate, 100);
  assert.ok(Math.abs(json.seconds - 3) < 0.1, `${json.seconds} s`);
  const peaks = peaksOf(json);
  assert.ok(Math.abs(peaks.length - 300) <= 3, `${peaks.length} peaks for 3 s`);
  // The tone at half scale peaks at ~128 of 255; the silent last second at ~0.
  const tone = peaks.slice(20, 180);
  const quiet = peaks.slice(220, 290);
  const mean = (a: Array<number>) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(Math.abs(mean(tone) - 127.5) < 8, `tone peaks ${mean(tone)}`);
  assert.ok(Math.max(...quiet) < 5, `silence peaks ${Math.max(...quiet)}`);

  const files = readdirSync(join(dir, ".cache", "waveforms"));
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^m-tone--[0-9a-f]{12}\.json$/);

  // Second request: read from the cache, no decode.
  const cached = await get("/media/waveform/m-tone");
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get("x-uncut-waveform"), "cache");
  assert.deepEqual(await cached.json(), json);

  // A clip's sound works too.
  const talk = await get("/media/waveform/m-talk");
  assert.equal(talk.status, 200);
  const talkPeaks = peaksOf((await talk.json()) as { peaks: string });
  assert.ok(Math.abs(mean(talkPeaks.slice(10, 80)) - 64) < 8, "the clip's quarter-scale tone");

  // The file changes: new peaks under a new key, the old file goes.
  ff("-f", "lavfi", "-i", "aevalsrc=0.9*sin(2*PI*440*t):s=48000:d=1", "-c:a", "aac", join(root, "Tone.m4a"));
  utimesSync(join(root, "Tone.m4a"), new Date(), new Date(Date.now() + 5000));
  const changed = peaksOf((await (await get("/media/waveform/m-tone")).json()) as { peaks: string });
  assert.ok(changed.length < 150 && mean(changed.slice(10, 90)) > 200, "the new, louder, shorter file");
  const after = readdirSync(join(dir, ".cache", "waveforms")).filter((f) => f.startsWith("m-tone--"));
  assert.equal(after.length, 1);
  assert.notEqual(after[0], files[0]);
});

test("the media file route allows CORS reads, for Web Audio in the file:// renderer", T, async () => {
  const r = await fetch(`${base}/media/file/m-tone?token=${encodeURIComponent(token)}`, { headers: { range: "bytes=0-99", origin: "null" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.match(r.headers.get("access-control-expose-headers") ?? "", /Content-Range/);
  await r.arrayBuffer();
});

test("a cache folder that can't be written still gets its peaks; a missing ffmpeg is a 503, not a 404", T, async () => {
  // The cache folder is a read-only directory: the peaks come back anyway (and aren't cached).
  const folder = join(dir, ".cache", "waveforms");
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  chmodSync(folder, 0o500);
  try {
    const r = await get("/media/waveform/m-talk");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-uncut-waveform"), "decode");
    assert.ok(peaksOf((await r.json()) as { peaks: string }).length > 50);
  } finally {
    chmodSync(folder, 0o700);
  }
  // A server whose PATH has no ffmpeg: "try again later", not "no sound".
  const bare = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data-bare"), PATH: "/usr/bin:/bin" } });
  const c = await connect(bare.ready.port, bare.ready.token);
  try {
    await c.ok("project.open", { dir: projectCopy(dir) });
    const r = await fetch(`http://127.0.0.1:${bare.ready.port}/media/waveform/m-talk?token=${encodeURIComponent(bare.ready.token)}`);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "30");
    assert.equal(
      (await fetch(`http://127.0.0.1:${bare.ready.port}/media/waveform/m-silent?token=${encodeURIComponent(bare.ready.token)}`)).status,
      404,
      "no sound is still a 404",
    );
  } finally {
    c.close();
    await bare.stop();
  }
});

test("waveform helpers: the limiter never lets an extra decode in; cleanup matches only the id's own files; the meter reads s16le", async () => {
  const limit = makeLimiter(2);
  let running = 0;
  let worst = 0;
  const task = async () => {
    await limit.slot();
    running++;
    worst = Math.max(worst, running);
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    running--;
    limit.release();
  };
  await Promise.all(Array.from({ length: 40 }, task));
  assert.equal(worst, 2);
  assert.equal(limit.held(), 0);

  assert.equal(isWaveformFileOf("m-a--0123456789ab.json", "m-a"), true);
  assert.equal(isWaveformFileOf("m-a--b--0123456789ab.json", "m-a"), false, "another id that starts the same way");
  assert.equal(isWaveformFileOf("m-a--0123456789ab.json.tmp-12", "m-a"), false);
  assert.equal(isWaveformFileOf("m-ab--0123456789ab.json", "m-a"), false);

  // 160 samples (two peaks at 80 per peak) split across chunks at an odd byte.
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(i === 100 ? -16384 : i === 30 ? 32767 : 0, i * 2);
  const meter = new PeakMeter();
  meter.push(pcm.subarray(0, 61));
  meter.push(pcm.subarray(61, 201));
  meter.push(pcm.subarray(201));
  const w = meter.finish();
  assert.deepEqual([...Buffer.from(w.peaks, "base64")], [255, 128]);
  assert.equal(w.seconds, 160 / 8000);
});
