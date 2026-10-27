// Phase 4 chunk 1: GET /media/file/<id> serves the open project's footage to the preview. Only
// with the token, only media the project references, and with byte ranges for <video> seeking.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip =
  !existsSync(BUNDLE) || !existsSync(MEDIA) ? "server or media core not built (run pnpm build)" : !hasFfmpeg ? "needs ffmpeg to make test media" : false;
const T = { skip, timeout: 60000 };

let root = "";
let clip = "";
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let client: Awaited<ReturnType<typeof connect>> | undefined;
let base = "";
let token = "";

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-mediafile-")));
  clip = join(root, "Clip One.MP4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
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
    "-f",
    "mp4",
    clip,
  ]);
  copyFileSync(clip, join(root, "Kept.MP4"));
  writeFileSync(join(root, "secret.txt"), "not media");
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

const get = (path: string, { auth = token as string | null, range }: { auth?: string | null; range?: string } = {}) =>
  fetch(`${base}${path}${auth === null ? "" : `?token=${encodeURIComponent(auth)}`}`, range ? { headers: { range } } : {});

test("serves the project's media with ranges, and nothing else", T, async () => {
  assert.equal((await get("/media/file/m-clip-one")).status, 404, "nothing open yet");
  const created = (await client!.ok("project.create", { parentDir: root, name: "Files" })) as { dir: string };
  await client!.ok("project.edit", {
    ops: [
      {
        op: "add_media",
        media: { id: "m-clip-one", kind: "video", name: "Clip One.MP4", path: clip, probe: { frames: 60, fps: 30, width: 320, height: 240, hasAudio: false } },
      },
    ],
  });
  const bytes = readFileSync(clip);

  const whole = await get("/media/file/m-clip-one");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4", "the upper-case .MP4 is still video/mp4");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(Number(whole.headers.get("content-length")), bytes.length);
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(bytes));

  // What <video> asks first, a middle slice, a suffix, and a range past the end.
  const open = await get("/media/file/m-clip-one", { range: "bytes=0-" });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get("content-range"), `bytes 0-${bytes.length - 1}/${bytes.length}`);
  await open.arrayBuffer();
  const mid = await get("/media/file/m-clip-one", { range: "bytes=100-199" });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get("content-range"), `bytes 100-199/${bytes.length}`);
  assert.equal(mid.headers.get("content-length"), "100");
  assert.ok(Buffer.from(await mid.arrayBuffer()).equals(bytes.subarray(100, 200)));
  const tail = await get("/media/file/m-clip-one", { range: "bytes=-10" });
  assert.equal(tail.status, 206);
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(bytes.length - 10)));
  // A malformed range (end before start, garbage, several ranges) is ignored: the whole file.
  for (const range of ["bytes=5-2", "bytes=abc", "items=0-10", "bytes=0-1,5-6"]) {
    const r = await get("/media/file/m-clip-one", { range });
    assert.equal(r.status, 200, range);
    assert.equal(Number(r.headers.get("content-length")), bytes.length, range);
    await r.arrayBuffer();
  }
  const past = await get("/media/file/m-clip-one", { range: `bytes=${bytes.length}-` });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), `bytes */${bytes.length}`);

  // The token is required, and only media ids of the open project resolve.
  assert.equal((await get("/media/file/m-clip-one", { auth: null })).status, 401);
  assert.equal((await get("/media/file/m-clip-one", { auth: "wrong" })).status, 401);
  for (const path of [
    "/media/file/m-nope",
    "/media/file/",
    "/media/file/..%2Fsecret.txt",
    "/media/file/../secret.txt",
    "/media/file/%2Fetc%2Fpasswd",
    "/media/file/%",
    "/media/file/M-CLIP-ONE",
  ]) {
    assert.equal((await get(path)).status, 404, path);
  }

  // Ids are matched exactly, however long (the schema doesn't cap them).
  const longId = `m-${"x".repeat(120)}`;
  const copy = join(root, "copy.mp4");
  copyFileSync(clip, copy);
  await client!.ok("project.edit", {
    ops: [
      {
        op: "add_media",
        media: { id: longId, kind: "video", name: "copy.mp4", path: copy, probe: { frames: 60, fps: 30, width: 320, height: 240, hasAudio: false } },
      },
    ],
  });
  const long = await get(`/media/file/${longId}`);
  assert.equal(long.status, 200);
  assert.equal((await long.arrayBuffer()).byteLength, bytes.length);
  // A file that exists but can't be read is refused before any byte is sent, not a reset socket.
  chmodSync(copy, 0o000);
  try {
    assert.equal((await get(`/media/file/${longId}`)).status, 403);
    assert.equal((await get(`/media/file/${longId}`, { range: "bytes=0-" })).status, 403);
  } finally {
    chmodSync(copy, 0o644);
  }
  await client!.ok("project.undo");

  // #65 (D263): an undo takes the media out but its file stays (redo brings it back), so this
  // opening of the project keeps serving it; the preview may still be loading it in that moment.
  await client!.ok("project.undo");
  assert.equal((await get("/media/file/m-clip-one")).status, 200, "served after the undo, same opening");
  assert.equal((await get("/media/waveform/m-clip-one")).status, 404, "a removed clip without sound still has no waveform");
  // Another opening of the project only serves what it lists.
  await client!.ok("project.open", { dir: created.dir });
  assert.equal((await get("/media/file/m-clip-one")).status, 404, "not listed by this opening");
  await client!.ok("project.edit", {
    ops: [
      {
        op: "add_media",
        media: { id: "m-clip-one", kind: "video", name: "Clip One.MP4", path: clip, probe: { frames: 60, fps: 30, width: 320, height: 240, hasAudio: false } },
      },
    ],
  });
  // An empty file is served as empty (a range on it can't be satisfied).
  writeFileSync(clip, "");
  const empty = await get("/media/file/m-clip-one");
  assert.equal(empty.status, 200);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
  assert.equal((await get("/media/file/m-clip-one", { range: "bytes=0-" })).status, 416);
  // A referenced file that went missing is a 404 too, not a crash.
  rmSync(clip);
  assert.equal((await get("/media/file/m-clip-one")).status, 404);
});

/** The server's open descriptors on `file` (lsof), or undefined where lsof isn't there. */
const openOn = (pid: number, file: string) => {
  const r = spawnSync("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8" });
  return r.error ? undefined : r.stdout.split("\n").filter((l) => l === `n${file}`).length;
};

/** A request the client drops right after sending it, as <video> does on a seek. */
const dropped = (path: string) =>
  new Promise<void>((done) => {
    const req = httpGet(`${base}${path}?token=${encodeURIComponent(token)}`, { headers: { range: "bytes=0-" } }, (res) => {
      res.destroy();
      done();
    });
    req.on("error", () => done());
    setImmediate(() => {
      req.destroy();
      done();
    });
  });

test("requests dropped while the file opens leave no handle open (DEP0137)", T, async (t) => {
  const kept = join(root, "Kept.MP4");
  const probe = { frames: 60, fps: 30, width: 320, height: 240, hasAudio: false };
  await client!.ok("project.edit", { ops: [{ op: "add_media", media: { id: "m-kept", kind: "video", name: "Kept.MP4", path: kept, probe } }] });
  if (openOn(server!.proc.pid!, kept) === undefined) return t.skip("needs lsof");
  for (let i = 0; i < 300; i++) await dropped("/media/file/m-kept");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(openOn(server!.proc.pid!, kept), 0);
});
