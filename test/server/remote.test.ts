// Phase 9 (D106-D110): the headless server. Its pairing token is made once and kept 0600 in its
// data dir; it refuses a wide bind with a weak token; the gate checks Origin, the token (query or
// Bearer) and rate-limits wrong ones; files.list browses its disk; uploads go into the open
// project's media/uploads/ (capped, never over a file, never outside the project); a finished
// export downloads byte for byte.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect as netConnect } from "node:net";
import { join } from "node:path";

import { freePort } from "../helpers/app.ts";
import { BUNDLE, MEDIA, connect, killAll, openSocket, startServer } from "../helpers/server.ts";

const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const skip = existsSync(BUNDLE) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";
const skipExport = skip || (!which("ffmpeg") ? "needs ffmpeg" : false);
const T = { skip, timeout: 30000 };

let root = "";
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-remote-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A headless server; its token is read from its data dir (it's never on stdout, D106). */
const headless = async (name: string, args: ReadonlyArray<string> = [], env: NodeJS.ProcessEnv = {}) => {
  const s = await startServer({ args: ["--data-dir", join(root, name), ...args], env: { UNCUT_DATA_DIR: "", ...env }, captureStderr: true });
  assert.equal(s.ready.token, undefined, "no token on the stdout ready line");
  if (!env.UNCUT_TOKEN) s.ready.token = readFileSync(join(root, name, "server-token"), "utf8").trim();
  return s;
};

const get = (port: number, path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers });

test("a headless server keeps its token 0600 in its data dir, prints how to pair, and keeps it across restarts", T, async () => {
  const port = await freePort();
  const first = await headless("keep", ["--port", String(port)]);
  const token = first.ready.token;
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(first.ready.port, port);
  const file = join(root, "keep", "server-token");
  assert.equal(readFileSync(file, "utf8").trim(), token);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "keep")).mode & 0o077, 0, "the data dir is the user's only");
  await new Promise((r) => setTimeout(r, 200));
  assert.match(first.stderr(), new RegExp(`uncut://pair\\?url=http%3A%2F%2F127\\.0\\.0\\.1%3A${port}&token=${token}`));
  await first.stop();
  const again = await headless("keep", ["--port", String(port)]);
  assert.equal(again.ready.token, token, "the same token after a restart");
  const ping = await get(port, "/api/ping", { authorization: `Bearer ${token}` });
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).ok, true);
  await again.stop();
});

test("it refuses to listen beyond loopback with a weak token, and a bad --port", T, async () => {
  await assert.rejects(headless("weak", ["--host", "0.0.0.0", "--port", "0"], { UNCUT_TOKEN: "short" }), /exited \(1\)/);
  // A wide bind with a real token: allowed, with the not-encrypted warning printed.
  const wide = await headless("wide", ["--host", "0.0.0.0", "--port", "0"]);
  await new Promise((r) => setTimeout(r, 200));
  assert.match(wide.stderr(), /Warning: plain http, not encrypted/);
  await wide.stop();
  await assert.rejects(headless("badport", ["--port", "http"]), /exited \(2\)/);
});

test("the gate: token by query or Bearer, 401 without, 403 for a web origin, file:// and none allowed; WebSocket too", T, async () => {
  const s = await headless("gate", ["--port", "0"]);
  const { port, token } = s.ready;
  assert.equal((await get(port, "/api/ping")).status, 401);
  assert.equal((await get(port, `/api/ping?token=${token}x`)).status, 401);
  assert.equal((await get(port, `/api/ping?token=${token}`)).status, 200);
  assert.equal((await get(port, "/api/ping", { authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await get(port, "/api/ping", { authorization: `Bearer ${token}`, origin: "https://evil.example" })).status, 403);
  assert.equal((await get(port, "/api/ping", { authorization: `Bearer ${token}`, origin: "file://" })).status, 200);
  assert.equal((await get(port, "/api/ping", { authorization: `Bearer ${token}`, origin: "null" })).status, 200);
  // Media routes take the header too (the relay sends it there).
  assert.equal((await get(port, "/media/file/nope", { authorization: `Bearer ${token}` })).status, 404);
  // WebSocket: the token works, a wrong one and a web origin don't.
  const ws = await openSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  ws.close();
  await assert.rejects(openSocket(`ws://127.0.0.1:${port}/ws?token=nope`));
  const upgrade = await new Promise<string>((done) => {
    const sock = netConnect(port, "127.0.0.1", () =>
      sock.write(
        `GET /ws?token=${token} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://evil.example\r\n\r\n`,
      ),
    );
    let text = "";
    sock.on("data", (d) => (text += d));
    sock.on("close", () => done(text));
  });
  assert.match(upgrade, /^HTTP\/1\.1 403/);
  await s.stop();
});

test("ten wrong tokens block more guesses for a while (429); the right token always gets in; no token and cross-site requests aren't counted", T, async () => {
  const s = await headless("limit", ["--port", "0"]);
  const { port, token } = s.ready;
  // A web page's <img> spam (no token, or cross-site with a wrong one) spends nothing.
  for (let i = 0; i < 20; i++) assert.equal((await get(port, "/api/ping")).status, 401);
  for (let i = 0; i < 20; i++) assert.equal((await get(port, `/api/ping?token=x${i}`, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await get(port, `/api/ping?token=${token}`, { "sec-fetch-site": "cross-site" })).status, 200, "the app's own file:// page is cross-site too");
  for (let i = 0; i < 9; i++) assert.equal((await get(port, `/api/ping?token=wrong${i}`)).status, 401);
  assert.equal((await get(port, "/api/ping?token=wrong9")).status, 401);
  assert.equal((await get(port, "/api/ping?token=wrong10")).status, 429, "the tenth wrong token blocks guessing");
  assert.equal((await get(port, `/api/ping?token=${token}`)).status, 200, "the owner is never locked out");
  const ws = await openSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  ws.close();
  await s.stop();
});

test("files.list: a folder's entries (dirs first, projects marked, hidden left out), and why not", T, async () => {
  const s = await headless("files", ["--port", "0"]);
  const client = await connect(s.ready.port, s.ready.token);
  const top = join(root, "browse");
  mkdirSync(join(top, "Trip.uncut"), { recursive: true });
  writeFileSync(join(top, "Trip.uncut", "project.json"), "{}");
  mkdirSync(join(top, "footage"));
  writeFileSync(join(top, "a.mp4"), "12345");
  writeFileSync(join(top, ".hidden"), "x");
  symlinkSync(join(top, "footage"), join(top, "link"));
  const listing = await client.ok("files.list", { dir: top });
  assert.equal(listing.dir, top);
  assert.equal(listing.parent, root);
  assert.deepEqual(listing.entries, [
    { name: "footage", kind: "dir" },
    { name: "link", kind: "dir" },
    { name: "Trip.uncut", kind: "dir", project: true },
    { name: "a.mp4", kind: "file", size: 5 },
  ]);
  const home = await client.ok("files.list", {});
  assert.equal(home.dir, home.home);
  assert.equal((await client.fail("files.list", { dir: "relative/path" })).reason, "invalid-path");
  assert.equal((await client.fail("files.list", { dir: join(top, "gone") })).reason, "missing");
  assert.equal((await client.fail("files.list", { dir: join(top, "a.mp4") })).reason, "not-a-folder");
  const hello = await client.ok("server.hello", {});
  assert.equal(hello.home, home.home);
  assert.ok(typeof hello.defaultParentDir === "string" && typeof hello.hostname === "string");
  client.close();
  await s.stop();
});

const upload = (port: number, token: string, name: string, body: Uint8Array<ArrayBuffer> | string) =>
  fetch(`http://127.0.0.1:${port}/api/upload?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
  });

test("uploads: into the open project's media/uploads/, a safe name, never over a file, capped, never through a symlink out", T, async () => {
  const s = await headless("up", ["--port", "0"], { UNCUT_UPLOAD_MAX_BYTES: "1000" });
  const { port, token } = s.ready;
  const client = await connect(port, token);
  assert.equal((await upload(port, token, "a.mp4", "x")).status, 409, "no project open");
  mkdirSync(join(root, "up-projects"), { recursive: true });
  const snap = await client.ok("project.create", { parentDir: join(root, "up-projects"), name: "Up" });
  const uploads = join(snap.dir, "media", "uploads");
  const first = await upload(port, token, "../../evil name.mp4", "hello");
  assert.equal(first.status, 200, await first.clone().text());
  assert.deepEqual(await first.json(), { path: join(uploads, "evil name.mp4") });
  assert.equal(readFileSync(join(uploads, "evil name.mp4"), "utf8"), "hello");
  const second = await (await upload(port, token, "evil name.mp4", "again")).json();
  assert.equal(second.path, join(uploads, "evil name 2.mp4"), "the first file is kept");
  assert.equal(readFileSync(join(uploads, "evil name.mp4"), "utf8"), "hello");
  assert.equal((await (await upload(port, token, ".hidden", "x")).json()).path, join(uploads, "hidden"));
  // Names are capped at 200 bytes of UTF-8, the extension kept, no character cut in half.
  const long = (await (await upload(port, token, `${"ż".repeat(150)}.mp4`, "x")).json()).path as string;
  const base = long.slice(uploads.length + 1);
  assert.ok(Buffer.byteLength(base) <= 200 && base.endsWith(".mp4") && /^ż+\.mp4$/.test(base), base);
  rmSync(long);
  // Over the cap: refused from its Content-Length, and nothing is left behind.
  const big = await upload(port, token, "big.mp4", new Uint8Array(2000));
  assert.equal(big.status, 413);
  assert.match(await big.text(), /larger than this server takes/);
  // Over the cap without a Content-Length (chunked): cut off while streaming.
  const chunked = await fetch(`http://127.0.0.1:${port}/api/upload?name=stream.mp4`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: new ReadableStream({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(400));
        c.close();
      },
    }),
    duplex: "half",
  } as RequestInit).catch((error: Error) => error);
  if (!(chunked instanceof Error)) assert.equal(chunked.status, 413);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(readdirSync(uploads).sort(), ["evil name 2.mp4", "evil name.mp4", "hidden"]);
  // Without the token: 401, nothing written.
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/upload?name=x.mp4`, { method: "POST", body: "x" })).status, 401);
  // media/uploads as a symlink out of the project: refused.
  rmSync(uploads, { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, uploads);
  const escaped = await upload(port, token, "a.mp4", "x");
  assert.equal(escaped.status, 403);
  assert.deepEqual(readdirSync(outside), []);
  // media itself as a symlink out: refused before anything is made through it.
  rmSync(join(snap.dir, "media"), { recursive: true });
  const outside2 = join(root, "outside2");
  mkdirSync(outside2);
  symlinkSync(outside2, join(snap.dir, "media"));
  assert.equal((await upload(port, token, "b.mp4", "x")).status, 403);
  assert.deepEqual(readdirSync(outside2), [], "no uploads/ made outside");
  client.close();
  await s.stop();
});

test("download: a finished export streams byte for byte (and by range); nothing else does", { skip: skipExport, timeout: 180000 }, async () => {
  const s = await headless("dl", ["--port", "0"]);
  const { port, token } = s.ready;
  const client = await connect(port, token);
  const jobs = client.subscribe("media.jobs");
  const exports = client.subscribe("export.jobs");
  mkdirSync(join(root, "dl-projects"), { recursive: true });
  const snap = await client.ok("project.create", { parentDir: join(root, "dl-projects"), name: "Down" });
  const clip = join(root, "clip.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=1",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    clip,
  ]);
  // Up as an upload, imported from media/uploads/ (as a drop on a remote does).
  const up = await (await upload(port, token, "clip.mp4", readFileSync(clip))).json();
  assert.equal(up.path, join(snap.dir, "media", "uploads", "clip.mp4"));
  const { jobId } = await client.ok("media.import", { paths: [up.path] });
  await jobs.until((list) => list.some((j: any) => j.id === jobId && j.phase === "done"), 60000);
  const project = (await client.ok("project.get", {})).project;
  const media = project.media[0];
  assert.equal(media.path, "media/uploads/clip.mp4", "stored inside the project");
  await client.ok("project.edit", {
    ops: [{ op: "insert_item", track: "main", item: { id: "c1", type: "clip", media: media.id, in: 0, duration: 30 } }],
    summary: "clip",
  });
  const output = join(root, "dl-out.mp4");
  const started = await client.ok("export.start", { output, quality: "draft", loudness: "off" });
  assert.equal((await get(port, `/api/export/${started.jobId}`, { authorization: `Bearer ${token}` })).status, 404, "not before it's done");
  await exports.until((list) => list.some((j: any) => j.id === started.jobId && ["done", "failed"].includes(j.phase)), 120000);
  const res = await get(port, `/api/export/${started.jobId}`, { authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename\*=UTF-8''dl-out\.mp4/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(output));
  const part = await get(port, `/api/export/${started.jobId}`, { authorization: `Bearer ${token}`, range: "bytes=0-9" });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), readFileSync(output).subarray(0, 10));
  assert.equal((await get(port, `/api/export/${started.jobId}`)).status, 401);
  assert.equal((await get(port, "/api/export/nope", { authorization: `Bearer ${token}` })).status, 404);
  assert.equal((await get(port, `/api/export/..%2F..%2Fetc%2Fpasswd`, { authorization: `Bearer ${token}` })).status, 404);
  client.close();
  await s.stop();
});

test("the desktop's server is unchanged: no token file, a fresh token every start", T, async () => {
  const data = join(root, "desktop-data");
  const s = await startServer({ env: { UNCUT_DATA_DIR: data } });
  assert.ok(s.ready.token, "a generated token on the ready line, as before");
  assert.equal(s.ready.host, undefined);
  assert.ok(!existsSync(join(data, "server-token")));
  await s.stop();
});
