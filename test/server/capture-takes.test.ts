// D114 on a headless server (the same path a remote environment takes): a take recorded on this
// Mac arrives as a MediaRecorder-style webm through /api/upload, then capture.save converts it into
// media/captures/ (a voiceover to .m4a, a camera or screen take to H.264 + AAC .mp4), removes the
// upload and imports it as one user edit, placed at the playhead when asked: a voiceover on a
// Voiceover track (one ⌘Z takes the media, the item and the track out; redo puts them back).
// Refused: a path outside media/uploads, no project open.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const skip = !existsSync(BUNDLE) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : !has("ffmpeg") || !has("ffprobe") ? "needs ffmpeg and ffprobe" : false;
const T = { skip, timeout: 60000 };

let root = "";
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-takes-")));
  // What MediaRecorder makes: webm with Opus (and VP8), no length in the header.
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5", "-c:a", "libopus", "-f", "webm", join(root, "voice.webm")]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:v", "libvpx", "-b:v", "1M", "-c:a", "libopus", "-f", "webm", join(root, "camera.webm")]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=1.5", "-c:v", "libvpx", "-b:v", "1M", "-f", "webm", join(root, "screen.webm")]);
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const upload = (port: number, token: string, name: string, body: Uint8Array<ArrayBuffer>) =>
  fetch(`http://127.0.0.1:${port}/api/upload?name=${encodeURIComponent(name)}`, { method: "POST", body, headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" } }).then(async (r) => {
    assert.equal(r.status, 200, await r.clone().text());
    return ((await r.json()) as { path: string }).path;
  });
const streams = (file: string) =>
  (JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" })) as { streams: Array<{ codec_type: string; codec_name: string }>; format: { duration: string } });

test("takes from this Mac: uploaded webm becomes an m4a voiceover on a Voiceover track at the playhead, or an mp4 camera or screen take; one undo each", T, async () => {
  const s = await startServer({ args: ["--data-dir", join(root, "data"), "--port", "0"], env: { UNCUT_DATA_DIR: "" }, captureStderr: true });
  const token = readFileSync(join(root, "data", "server-token"), "utf8").trim();
  const { port } = s.ready;
  const client = await connect(port, token);
  assert.equal((await client.fail("capture.save", { path: "/tmp/x.webm", kind: "voiceover" }))._tag, "CaptureError", "no project open");
  mkdirSync(join(root, "projects"), { recursive: true });
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Takes" });
  const dir = snap.dir as string;
  const fps = snap.project.canvas.fps as number;

  // Refused: a file that isn't in media/uploads (even inside the project).
  writeFileSync(join(dir, "uncut-take-voiceover-bbbbbbbbbbbb.webm"), readFileSync(join(root, "voice.webm")));
  const refused = await client.fail("capture.save", { path: join(dir, "uncut-take-voiceover-bbbbbbbbbbbb.webm"), kind: "voiceover" });
  assert.match(refused.message, /isn't in the project's media\/uploads folder/);
  assert.ok(existsSync(join(dir, "uncut-take-voiceover-bbbbbbbbbbbb.webm")), "left alone");

  // Refused and left in place: a file the user uploaded (D108, not a Capture tab name), and a
  // Capture-tab-named upload that is already media in the project.
  const userUpload = await upload(port, token, "talk.webm", new Uint8Array(readFileSync(join(root, "voice.webm"))));
  assert.match((await client.fail("capture.save", { path: userUpload, kind: "voiceover" })).message, /isn't a recording from the Capture tab/);
  assert.ok(existsSync(userUpload));
  const used = await upload(port, token, "uncut-take-voiceover-aaaaaaaaaaaa.webm", new Uint8Array(readFileSync(join(root, "voice.webm"))));
  const rev = (await client.ok("project.get", {})).revision;
  await client.ok("project.edit", { baseRevision: rev, ops: [{ op: "add_media", media: { id: "m-used", kind: "audio", name: "used.webm", path: used, probe: { frames: 75, hasAudio: true } } }] });
  assert.match((await client.fail("capture.save", { path: used, kind: "voiceover" })).message, /already media in the project/);
  assert.ok(existsSync(used), "an imported file is never removed");
  await client.ok("project.undo", {});
  rmSync(used);
  rmSync(userUpload);

  // A voiceover at frame 45.
  const voice = await upload(port, token, "uncut-take-voiceover-0123456789ab.webm", readFileSync(join(root, "voice.webm")));
  const saved = await client.ok("capture.save", { path: voice, kind: "voiceover", device: "Studio Mic", placeAt: 45 });
  assert.match(saved.name, /^Voiceover \d{8}-\d{6}\.m4a$/);
  assert.ok(Math.abs(saved.seconds - 2.5) <= 0.1, `${saved.seconds} s`);
  assert.equal(existsSync(voice), false, "the upload is gone");
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const media = project.media.find((m: { id: string }) => m.id === saved.mediaId);
  assert.equal(media.path, `media/captures/${saved.name}`);
  assert.deepEqual(media.source, { module: "capture.microphone", device: "Studio Mic" });
  assert.equal(media.kind, "audio");
  const file = join(dir, media.path);
  const probe = streams(file);
  assert.deepEqual(probe.streams.map((x) => `${x.codec_type}:${x.codec_name}`), ["audio:aac"]);
  const track = project.tracks.find((t: { id: string }) => t.id === saved.trackId);
  assert.equal(track.name, "Voiceover");
  assert.equal(track.kind, "audio");
  const item = track.items.find((i: { id: string }) => i.id === saved.itemId);
  assert.equal(item.start, 45);
  assert.equal(item.media, saved.mediaId);
  assert.ok(Math.abs(item.duration / fps - 2.5) <= 0.1, `${item.duration} frames`);

  // One undo takes the media, the item and the track out; redo puts all three back.
  const undone = await client.ok("project.undo", {});
  assert.equal(undone.project.media.length, 0);
  assert.equal(undone.project.tracks.some((t: { id: string }) => t.id === saved.trackId), false);
  assert.ok(existsSync(file), "undo leaves the file, like captures");
  const redone = await client.ok("project.redo", {});
  assert.equal(redone.project.tracks.find((t: { id: string }) => t.id === saved.trackId).items[0].id, saved.itemId);

  // A camera take into Media only (no placeAt): H.264 + AAC, at the project's frame rate.
  const cam = await upload(port, token, "uncut-take-camera-0123456789ab.webm", readFileSync(join(root, "camera.webm")));
  const camera = await client.ok("capture.save", { path: cam, kind: "camera", device: "FaceTime HD Camera" });
  assert.match(camera.name, /^Camera \d{8}-\d{6}\.mp4$/);
  assert.equal(camera.itemId, undefined);
  const camProbe = streams(join(dir, "media", "captures", camera.name));
  assert.deepEqual(camProbe.streams.map((x) => `${x.codec_type}:${x.codec_name}`).sort(), ["audio:aac", "video:h264"]);

  // A screen take named after its window, placed at the playhead on a new Recordings track.
  const scr = await upload(port, token, "uncut-take-screen-0123456789ab.webm", readFileSync(join(root, "screen.webm")));
  const screen = await client.ok("capture.save", { path: scr, kind: "screen", name: "Simulator", placeAt: 0 });
  assert.match(screen.name, /^Simulator \d{8}-\d{6}\.mp4$/);
  const after = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  assert.equal(after.tracks.find((t: { id: string }) => t.id === screen.trackId).name, "Recordings");
  assert.deepEqual(after.media.find((m: { id: string }) => m.id === screen.mediaId).source, { module: "capture.screen" });
  assert.deepEqual(streams(join(dir, "media", "captures", screen.name)).streams.map((x) => x.codec_type), ["video"]);

  assert.deepEqual(readdirSync(join(dir, "media", "uploads")), [], "nothing left in uploads");
  await s.stop();
});
