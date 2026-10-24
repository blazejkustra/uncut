// D210 / D211 on a headless server: this Mac's sound alone (capture.save kind "system") becomes an
// .m4a on a Mac sound track; a multi-source take (capture.saveMulti) becomes media/captures/<take>/
// screen.mp4, camera.mp4, mic.m4a and system.m4a, imported and placed as one edit (one ⌘Z), grouped,
// the camera a bubble over the screen, and start-aligned: each file has the same moment (a flash in
// the pictures, a beep in the sound) at a different time because its recorder started later; after
// the placement that moment lands on the same timeline frame in all four (±1 frame).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const has = (name: string) => {
  try {
    return Boolean(execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim());
  } catch {
    return false;
  }
};
const skip =
  !existsSync(BUNDLE) || !existsSync(MEDIA)
    ? "server bundle or media core not built (run pnpm build)"
    : !has("ffmpeg") || !has("ffprobe")
      ? "needs ffmpeg and ffprobe"
      : false;
const T = { skip, timeout: 120000 };

// The same moment, 1.0 s after the first recorder started, in each file: a recorder that started
// `offsetMs` later has it at 1.0 - offset.
const OFFSETS = { screen: 0, camera: 50, voiceover: 120, system: 200 } as const;
const EVENT = 1.0;

let root = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-multi-")));
  const flash = (name: string, at: number) =>
    ff(
      "-f",
      "lavfi",
      "-i",
      `color=c=black:size=640x360:rate=30:duration=3,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,${at},${at + 0.3})'`,
      "-c:v",
      "libvpx",
      "-b:v",
      "1M",
      "-f",
      "webm",
      join(root, name),
    );
  const beep = (name: string, at: number) =>
    ff(
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=1000:sample_rate=48000:duration=3,volume=enable='not(between(t,${at},${at + 0.3}))':volume=0`,
      "-c:a",
      "libopus",
      "-f",
      "webm",
      join(root, name),
    );
  flash("screen.webm", EVENT - OFFSETS.screen / 1000);
  flash("camera.webm", EVENT - OFFSETS.camera / 1000);
  beep("mic.webm", EVENT - OFFSETS.voiceover / 1000);
  beep("system.webm", EVENT - OFFSETS.system / 1000);
  ff("-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "libopus", "-f", "webm", join(root, "alone.webm"));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const upload = (port: number, token: string, name: string, file: string) =>
  fetch(`http://127.0.0.1:${port}/api/upload?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body: readFileSync(file),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
  }).then(async (r) => {
    assert.equal(r.status, 200, await r.clone().text());
    return ((await r.json()) as { path: string }).path;
  });
const codecs = (file: string) =>
  (
    JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", file], { encoding: "utf8" })) as {
      streams: Array<{ codec_type: string; codec_name: string }>;
    }
  ).streams
    .map((x) => `${x.codec_type}:${x.codec_name}`)
    .sort();

/** When the flash (the first non-black picture) or the beep (the first sound) is in a converted file, seconds. */
function eventIn(file: string, kind: "video" | "audio"): number {
  const filter = kind === "video" ? ["-vf", "blackdetect=d=0.01:pix_th=0.2", "-an"] : ["-af", "silencedetect=n=-40dB:d=0.05", "-vn"];
  const out = spawnSync("ffmpeg", ["-hide_banner", "-i", file, ...filter, "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const m = kind === "video" ? out.match(/black_end:\s*([\d.]+)/) : out.match(/silence_end:\s*([\d.]+)/);
  assert.ok(m, `no event found in ${file}:\n${out.slice(-800)}`);
  return Number(m[1]);
}

test("this Mac's sound alone: an m4a on a Mac sound track at the playhead", T, async () => {
  const s = await startServer({ args: ["--data-dir", join(root, "data1"), "--port", "0"], env: { UNCUT_DATA_DIR: "" }, captureStderr: true });
  const token = readFileSync(join(root, "data1", "server-token"), "utf8").trim();
  const client = await connect(s.ready.port, token);
  mkdirSync(join(root, "projects1"), { recursive: true });
  const snap = await client.ok("project.create", { parentDir: join(root, "projects1"), name: "Sound" });
  const dir = snap.dir as string;
  const path = await upload(s.ready.port, token, "uncut-take-system-0123456789ab.webm", join(root, "alone.webm"));
  const saved = await client.ok("capture.save", { path, kind: "system", placeAt: 30 });
  assert.match(saved.name, /^Mac sound \d{8}-\d{6}\.m4a$/);
  assert.ok(Math.abs(saved.seconds - 2) <= 0.1, `${saved.seconds} s`);
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const media = project.media.find((m: { id: string }) => m.id === saved.mediaId);
  assert.equal(media.kind, "audio");
  assert.deepEqual(media.source, { module: "capture.system" });
  assert.deepEqual(codecs(join(dir, media.path)), ["audio:aac"]);
  const track = project.tracks.find((t: { id: string }) => t.id === saved.trackId);
  assert.equal(track.name, "Mac sound");
  assert.equal(track.kind, "audio");
  const item = track.items.find((i: { id: string }) => i.id === saved.itemId);
  assert.equal(item.type, "audio");
  assert.equal(item.start, 30);
  await s.stop();
});

test("a multi-source take: four files in one folder, one edit, grouped, the camera a bubble, aligned within a frame", T, async () => {
  const s = await startServer({ args: ["--data-dir", join(root, "data2"), "--port", "0"], env: { UNCUT_DATA_DIR: "" }, captureStderr: true });
  const token = readFileSync(join(root, "data2", "server-token"), "utf8").trim();
  const { port } = s.ready;
  const client = await connect(port, token);
  mkdirSync(join(root, "projects2"), { recursive: true });
  const snap = await client.ok("project.create", { parentDir: join(root, "projects2"), name: "Multi" });
  const dir = snap.dir as string;
  const fps = snap.project.canvas.fps as number;
  const { width, height } = snap.project.canvas as { width: number; height: number };
  const before = (await client.ok("project.get", {})).revision;

  const parts = [
    {
      path: await upload(port, token, "uncut-take-screen-00000000000a.webm", join(root, "screen.webm")),
      kind: "screen",
      device: "Test window",
      offsetMs: OFFSETS.screen,
    },
    {
      path: await upload(port, token, "uncut-take-camera-00000000000b.webm", join(root, "camera.webm")),
      kind: "camera",
      device: "FaceTime HD Camera",
      offsetMs: OFFSETS.camera,
    },
    {
      path: await upload(port, token, "uncut-take-voiceover-00000000000c.webm", join(root, "mic.webm")),
      kind: "voiceover",
      device: "Studio Mic",
      offsetMs: OFFSETS.voiceover,
    },
    { path: await upload(port, token, "uncut-take-system-00000000000d.webm", join(root, "system.webm")), kind: "system", offsetMs: OFFSETS.system },
  ];

  // Refused: the same source twice; nothing touched.
  assert.match((await client.fail("capture.saveMulti", { parts: [parts[0], { ...parts[0], path: parts[1]!.path }], placeAt: 0 })).message, /once/);
  assert.equal(readdirSync(join(dir, "media", "uploads")).length, 4);

  const saved = await client.ok("capture.saveMulti", { parts, name: "Demo", placeAt: 12, layout: "br" });
  assert.match(saved.name, /^Demo \d{8}-\d{6}$/);
  assert.equal(saved.folder, `media/captures/${saved.name}`);
  assert.deepEqual(readdirSync(join(dir, saved.folder)).sort(), ["camera.mp4", "mic.m4a", "screen.mp4", "system.m4a"]);
  assert.deepEqual(readdirSync(join(dir, "media", "uploads")), [], "the uploads are gone");
  assert.deepEqual(codecs(join(dir, saved.folder, "screen.mp4")), ["video:h264"]);
  assert.deepEqual(codecs(join(dir, saved.folder, "camera.mp4")), ["video:h264"]);
  assert.deepEqual(codecs(join(dir, saved.folder, "mic.m4a")), ["audio:aac"]);
  assert.deepEqual(codecs(join(dir, saved.folder, "system.m4a")), ["audio:aac"]);

  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  assert.equal(project.media.length, 4);
  const sourceOf = (kind: string) =>
    project.media.find((m: { id: string }) => m.id === saved.media.find((x: { kind: string }) => x.kind === kind).mediaId).source;
  assert.deepEqual(sourceOf("screen"), { module: "capture.screen", device: "Test window", take: saved.name });
  assert.deepEqual(sourceOf("system"), { module: "capture.system", take: saved.name });
  assert.deepEqual(sourceOf("voiceover"), { module: "capture.microphone", device: "Studio Mic", take: saved.name });

  // Tracks and positions.
  const all = project.tracks.flatMap((t: { id: string; name: string; items: Array<Record<string, unknown>> }) =>
    t.items.map((i) => ({ ...i, trackName: t.name, trackId: t.id })),
  );
  const item = (kind: string) => all.find((i: { id: string }) => i.id === saved.items.find((x: { kind: string }) => x.kind === kind).itemId);
  const screen = item("screen");
  const camera = item("camera");
  const mic = item("voiceover");
  const sys = item("system");
  assert.equal(screen.trackName, "Screen");
  assert.equal(camera.trackName, "Camera");
  assert.equal(mic.trackName, "Voiceover");
  assert.equal(sys.trackName, "Mac sound");
  const order = project.tracks.map((t: { name: string }) => t.name);
  assert.ok(order.indexOf("Camera") < order.indexOf("Screen") && order.indexOf("Screen") < order.indexOf("Main"), order.join(", "));
  for (const i of [screen, camera, mic, sys]) {
    assert.equal(i.start, 12, "every part starts at the playhead");
    assert.equal(i.group, saved.group, "one group");
    assert.equal(i.duration, screen.duration, "as long as the shortest");
  }
  assert.ok(saved.group);
  const size = Math.round((Math.min(width, height) * 0.3) / 2) * 2;
  const margin = Math.round(Math.min(width, height) * 0.04);
  assert.deepEqual(camera.transform, { x: width - margin - size, y: height - margin - size, w: size, h: size, fit: "cover", radius: size / 2 });

  // Aligned: the moment in each file, on the timeline: start + (event in the file - in), in frames.
  const onTimeline = (i: { start: number; in: number }, file: string, kind: "video" | "audio") =>
    i.start + eventIn(join(dir, saved.folder, file), kind) * fps - i.in;
  const at = [
    onTimeline(screen, "screen.mp4", "video"),
    onTimeline(camera, "camera.mp4", "video"),
    onTimeline(mic, "mic.m4a", "audio"),
    onTimeline(sys, "system.m4a", "audio"),
  ];
  const spread = Math.max(...at) - Math.min(...at);
  assert.ok(spread <= 1, `the same moment lands within a frame on every track: ${at.map((x) => x.toFixed(2)).join(", ")}`);
  // Without the correction the screen and this Mac's sound would be 200 ms (6 frames) apart.
  assert.equal(screen.in - sys.in, Math.round((OFFSETS.system * fps) / 1000));

  // One ⌘Z takes the four media, the items and the new tracks out; redo puts them back.
  const undone = await client.ok("project.undo", {});
  assert.equal(undone.project.media.length, 0);
  assert.deepEqual(
    undone.project.tracks.map((t: { name: string }) => t.name),
    snap.project.tracks.map((t: { name: string }) => t.name),
  );
  assert.equal(undone.revision > before, true);
  const redone = await client.ok("project.redo", {});
  assert.equal(redone.project.media.length, 4);
  await s.stop();
});
