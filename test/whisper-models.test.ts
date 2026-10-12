// Phase 5 chunk 4 (D68): speech model downloads against a local HTTP server serving a small fake
// model (never the real 550 MB one): progress, .part then an atomic rename, size and SHA-256 checks,
// cancel leaves nothing, a dropped connection resumes with a Range request, the store joins one
// download and stops one nobody waits for.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cancelled } from "../apps/server/src/analysisRunner.ts";
import { DEFAULT_MODEL, downloadFile, modelInfo, MODELS, ModelStore, Paused } from "../apps/server/src/whisperModels.ts";

const BODY = randomBytes(3 * 1024 * 1024 + 123);
const SHA = createHash("sha256").update(BODY).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = "";
let server: Server;
let base = "";
/** Requests seen: path and Range header. */
const seen: Array<{ url: string; range?: string; ifRange?: string }> = [];
/**
 * Per-test behaviour: "slow" sends in small timed chunks; "drop" cuts the first response off at
 * 1 MB; "hold" sends 64 KB and then nothing; "badrange" answers a range with one starting at 0.
 */
let mode: "normal" | "slow" | "drop" | "hold" | "badrange" = "normal";
/** The file's ETag: a resume with another one in If-Range gets the whole file again. */
let etag = '"v1"';

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-models-")));
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", ...(req.headers.range ? { range: req.headers.range } : {}), ...(req.headers["if-range"] ? { ifRange: String(req.headers["if-range"]) } : {}) });
    if (req.url === "/missing.bin") {
      res.writeHead(404).end("no");
      return;
    }
    // Like Hugging Face: /resolve/... redirects to the file host.
    if (req.url?.startsWith("/redirect/")) {
      res.writeHead(302, { location: `/files/${req.url.slice("/redirect/".length)}` }).end();
      return;
    }
    let start = 0;
    const ifRange = req.headers["if-range"];
    const m = ifRange && ifRange !== etag ? null : /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m) start = mode === "badrange" ? 0 : Number(m[1]);
    if (start >= BODY.length) {
      res.writeHead(416).end();
      return;
    }
    const part = BODY.subarray(start);
    res.writeHead(m ? 206 : 200, { "content-length": String(part.length), "content-type": "application/octet-stream", etag, ...(m ? { "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` } : {}) });
    if (mode === "hold") {
      res.write(part.subarray(0, 64 * 1024));
      return;
    }
    if (mode === "drop" && !m) {
      res.write(part.subarray(0, 1024 * 1024), () => setTimeout(() => res.socket?.destroy(), 50));
      return;
    }
    if (mode === "slow") {
      let at = 0;
      const tick = () => {
        if (res.destroyed) return;
        if (at >= part.length) return void res.end();
        res.write(part.subarray(at, at + 64 * 1024));
        at += 64 * 1024;
        setTimeout(tick, 20);
      };
      tick();
      return;
    }
    res.end(part);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  if (root) rmSync(root, { recursive: true, force: true });
});

const fresh = (name: string) => {
  const dir = join(root, name);
  return { dir, dest: join(dir, "ggml-test.bin"), part: join(dir, "ggml-test.bin.part") };
};

test("the catalog: the default is the multilingual large-v3-turbo q5_0 (~574 MB); base and small are offered too", () => {
  assert.equal(DEFAULT_MODEL, "large-v3-turbo-q5_0");
  const d = modelInfo(DEFAULT_MODEL)!;
  assert.deepEqual([d.file, d.bytes, d.multilingual, d.offered], ["ggml-large-v3-turbo-q5_0.bin", 574041195, true, true]);
  assert.deepEqual(MODELS.filter((m) => m.offered).map((m) => m.id), ["large-v3-turbo-q5_0", "small", "base"]);
  for (const m of MODELS) assert.match(m.sha256, /^[0-9a-f]{64}$/);
});

test("a download: progress, a .part while it runs, renamed when whole and checked; redirects followed", async () => {
  mode = "slow";
  const { dest, part } = fresh("ok");
  const progress: Array<[number, number | undefined]> = [];
  let sawPart = false;
  await downloadFile({
    url: `${base}/redirect/ggml-test.bin`,
    dest,
    bytes: BODY.length,
    sha256: SHA,
    signal: new AbortController().signal,
    onProgress: (received, total) => {
      progress.push([received, total]);
      if (existsSync(part) && !existsSync(dest)) sawPart = true;
    },
  });
  assert.ok(sawPart, "the bytes go to .part first");
  assert.ok(!existsSync(part));
  assert.ok(readFileSync(dest).equals(BODY));
  assert.ok(progress.length > 10, `progress (${progress.length} updates)`);
  assert.deepEqual(progress.at(-1), [BODY.length, BODY.length]);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i]![0] >= progress[i - 1]![0]);
});

test("a wrong checksum or size: an error, and no model file nor .part left", async () => {
  mode = "normal";
  const { dest, part } = fresh("bad");
  await assert.rejects(downloadFile({ url: `${base}/files/x.bin`, dest, bytes: BODY.length, sha256: "0".repeat(64), signal: new AbortController().signal }), /damaged/);
  assert.ok(!existsSync(dest) && !existsSync(part));
  await assert.rejects(downloadFile({ url: `${base}/files/x.bin`, dest, bytes: 1000, signal: new AbortController().signal }), /bigger than the model/);
  assert.ok(!existsSync(dest) && !existsSync(part));
  await assert.rejects(downloadFile({ url: `${base}/missing.bin`, dest, signal: new AbortController().signal }), /answered 404/);
  assert.ok(!existsSync(dest));
});

test("cancel mid-download: rejects with Cancelled, and leaves no partial file", async () => {
  mode = "slow";
  const { dir, dest, part } = fresh("cancel");
  const controller = new AbortController();
  const done = downloadFile({ url: `${base}/files/x.bin`, dest, bytes: BODY.length, sha256: SHA, signal: controller.signal, onProgress: (received) => received > 512 * 1024 && controller.abort() });
  await assert.rejects(done, Cancelled);
  assert.ok(!existsSync(dest) && !existsSync(part));
  assert.deepEqual(readdirSync(dir), []);
});

test("a dropped connection keeps the .part; the next try resumes it with a Range request and checks the whole file", async () => {
  mode = "drop";
  const { dest, part } = fresh("resume");
  await assert.rejects(downloadFile({ url: `${base}/files/x.bin`, dest, bytes: BODY.length, sha256: SHA, signal: new AbortController().signal }), /resumes where it stopped/);
  assert.ok(!existsSync(dest));
  const kept = statSync(part).size;
  assert.ok(kept >= 1024 * 1024 && kept < BODY.length, `kept ${kept} bytes`);
  seen.length = 0;
  await downloadFile({ url: `${base}/files/x.bin`, dest, bytes: BODY.length, sha256: SHA, signal: new AbortController().signal });
  assert.deepEqual(seen, [{ url: "/files/x.bin", range: `bytes=${kept}-`, ifRange: '"v1"' }]);
  assert.ok(readFileSync(dest).equals(BODY));
  assert.ok(!existsSync(part));
  // A stale .part that isn't the start of this file fails the checksum and is removed.
  const other = fresh("stale");
  mkdirSync(other.dir, { recursive: true });
  writeFileSync(other.part, randomBytes(1000));
  mode = "normal";
  await assert.rejects(downloadFile({ url: `${base}/files/x.bin`, dest: other.dest, bytes: BODY.length, sha256: SHA, signal: new AbortController().signal }), /damaged/);
  assert.ok(!existsSync(other.part) && !existsSync(other.dest));
});

test("the store: on demand only, one download joined by every asker, a Setup download runs on, an unwanted one stops", async () => {
  mode = "slow";
  const dir = join(root, "store");
  const states: Array<ReturnType<ModelStore["state"]>> = [];
  const selected: Array<string> = [];
  // A local server: checked against the size it sends (the catalog's sizes are the real models').
  const store = new ModelStore({ dir, selected: "base", baseUrl: `${base}/files`, onChange: (s) => states.push(s), onSelect: (id) => selected.push(id) });
  await store.refresh();
  assert.equal(store.state().models.find((m) => m.id === "base")!.installed, false);
  assert.equal(existsSync(dir), false, "nothing is downloaded until asked");

  // Two transcripts ask: one download.
  seen.length = 0;
  const fractions: Array<number> = [];
  const [a, b] = await Promise.all([
    store.ensure("base", { signal: new AbortController().signal, onProgress: (f) => fractions.push(f) }),
    store.ensure("base", { signal: new AbortController().signal }),
  ]);
  assert.equal(a, join(dir, "ggml-base.bin"));
  assert.equal(b, a);
  assert.equal(seen.length, 1, "one request");
  assert.ok(readFileSync(a).equals(BODY));
  assert.ok(fractions.length > 0 && fractions.every((f) => f >= 0 && f <= 1));
  assert.equal(store.state().models.find((m) => m.id === "base")!.installed, true);
  assert.deepEqual(store.state().downloads.find((d) => d.model === "base"), { model: "base", phase: "done", received: BODY.length, total: BODY.length });
  assert.ok(states.some((s) => s.downloads.some((d) => d.model === "base" && d.phase === "downloading" && d.received > 0)));
  // Installed: no request.
  seen.length = 0;
  await store.ensure("base", { signal: new AbortController().signal });
  assert.equal(seen.length, 0);

  // A transcript that stops waiting pauses the download it started (nobody else wants it); the .part stays.
  const waiter = new AbortController();
  const gone = store.ensure("small", { signal: waiter.signal });
  await sleep(150);
  waiter.abort();
  await assert.rejects(gone, Cancelled);
  await sleep(100);
  assert.equal(store.state().downloads.find((d) => d.model === "small")!.phase, "cancelled");
  assert.ok(existsSync(join(dir, "ggml-small.bin.part")) && !existsSync(join(dir, "ggml-small.bin")));

  // One from Setup keeps going when a transcript that joined it stops waiting; cancel stops it.
  store.download("small");
  const joined = new AbortController();
  const j = store.ensure("small", { signal: joined.signal });
  await sleep(100);
  joined.abort();
  await assert.rejects(j, Cancelled);
  await sleep(150);
  assert.equal(store.state().downloads.find((d) => d.model === "small")!.phase, "downloading");
  store.cancel("small");
  await sleep(150);
  assert.equal(store.state().downloads.find((d) => d.model === "small")!.phase, "cancelled");
  assert.ok(!existsSync(join(dir, "ggml-small.bin.part")));

  // Choosing a model is saved through onSelect; an unknown one is refused.
  store.select("small");
  assert.deepEqual(selected, ["small"]);
  assert.equal(store.state().selected, "small");
  assert.throws(() => store.select("huge"), /no model "huge"/);
  store.shutdown();
});

test("an abort right after starting (before the request is even made) still cancels, at once, leaving nothing", async () => {
  mode = "hold";
  for (const when of ["sync", "microtask", "immediate", "timeout"] as const) {
    const { dir, dest } = fresh(`early-${when}`);
    const controller = new AbortController();
    const t0 = Date.now();
    const done = downloadFile({ url: `${base}/files/x.bin`, dest, signal: controller.signal, stallMs: 10000 });
    if (when === "sync") controller.abort();
    else if (when === "microtask") queueMicrotask(() => controller.abort());
    else if (when === "immediate") setImmediate(() => controller.abort());
    else setTimeout(() => controller.abort(), 30);
    await assert.rejects(done, Cancelled, when);
    assert.ok(Date.now() - t0 < 2000, `${when}: cancelled in ${Date.now() - t0} ms, not after the stall timeout`);
    assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [], `${when}: nothing left`);
  }
});

test("a pause keeps the .part; the resume asks for the rest with If-Range; a changed file or a wrong range starts over", async () => {
  mode = "slow";
  const { dest, part } = fresh("pause");
  const paused = new AbortController();
  await assert.rejects(
    downloadFile({ url: `${base}/files/x.bin`, dest, bytes: BODY.length, sha256: SHA, signal: paused.signal, onProgress: (received) => received > 512 * 1024 && paused.abort(new Paused()) }),
    Cancelled,
  );
  const kept = statSync(part).size;
  assert.ok(kept > 0, "the .part is kept");
  assert.equal(JSON.parse(readFileSync(`${part}.json`, "utf8")).etag, '"v1"');
  seen.length = 0;
  mode = "normal";
  await downloadFile({ url: `${base}/files/x.bin`, dest, bytes: BODY.length, sha256: SHA, signal: new AbortController().signal });
  assert.deepEqual(seen, [{ url: "/files/x.bin", range: `bytes=${kept}-`, ifRange: '"v1"' }]);
  assert.ok(readFileSync(dest).equals(BODY));
  assert.ok(!existsSync(part) && !existsSync(`${part}.json`));

  // The file changed on the server since (another ETag): it sends the whole file, which is used.
  const changed = fresh("changed");
  mode = "slow";
  const p2 = new AbortController();
  await assert.rejects(downloadFile({ url: `${base}/files/x.bin`, dest: changed.dest, signal: p2.signal, onProgress: (received) => received > 256 * 1024 && p2.abort(new Paused()) }), Cancelled);
  etag = '"v2"';
  mode = "normal";
  seen.length = 0;
  await downloadFile({ url: `${base}/files/x.bin`, dest: changed.dest, bytes: BODY.length, sha256: SHA, signal: new AbortController().signal });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.ifRange, '"v1"');
  assert.ok(readFileSync(changed.dest).equals(BODY));
  etag = '"v1"';

  // A 206 that doesn't start where the .part ends isn't used: it starts over from 0.
  const wrong = fresh("badrange");
  mkdirSync(wrong.dir, { recursive: true });
  writeFileSync(wrong.part, BODY.subarray(0, 1000));
  mode = "badrange";
  seen.length = 0;
  await downloadFile({ url: `${base}/files/x.bin`, dest: wrong.dest, bytes: BODY.length, sha256: SHA, signal: new AbortController().signal });
  assert.deepEqual(seen.map((x) => x.range), ["bytes=1000-", undefined]);
  assert.ok(readFileSync(wrong.dest).equals(BODY));
});

test("a folder Uncut can't write in is said in a sentence", async () => {
  mode = "normal";
  const locked = join(root, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  try {
    await assert.rejects(downloadFile({ url: `${base}/files/x.bin`, dest: join(locked, "m", "x.bin"), signal: new AbortController().signal }), /isn't allowed to write in/);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("the store: a cancel ends the download at once (a new Download starts afresh); detaching and quitting keep the .part", async () => {
  mode = "slow";
  const dir = join(root, "store2");
  const store = new ModelStore({ dir, selected: "base", baseUrl: `${base}/files` });
  // Download, then Cancel right away, then Download again: the second isn't the dying first one.
  store.download("base");
  store.cancel("base");
  store.download("base");
  assert.equal(store.state().downloads.find((d) => d.model === "base")!.phase, "downloading");
  // The file is renamed into place a moment before the download's phase turns "done": wait for both.
  const finished = () => store.state().models.find((m) => m.id === "base")!.installed && store.state().downloads.find((d) => d.model === "base")!.phase === "done";
  for (let i = 0; i < 200 && !finished(); i++) await sleep(25);
  assert.ok(readFileSync(join(dir, "ggml-base.bin")).equals(BODY), "the new download finished whole");
  assert.equal(store.state().downloads.find((d) => d.model === "base")!.phase, "done");
  assert.ok(!existsSync(join(dir, "ggml-base.bin.part")));

  // A transcript that stops waiting pauses it: the .part stays for the next ask, which resumes.
  const waiter = new AbortController();
  const gone = store.ensure("small", { signal: waiter.signal });
  for (let i = 0; i < 100 && (!existsSync(join(dir, "ggml-small.bin.part")) || statSync(join(dir, "ggml-small.bin.part")).size < 256 * 1024); i++) await sleep(20);
  waiter.abort();
  await assert.rejects(gone, Cancelled);
  await sleep(100);
  const kept = statSync(join(dir, "ggml-small.bin.part")).size;
  assert.ok(kept > 0, "paused, not deleted");
  seen.length = 0;
  const path = await store.ensure("small", { signal: new AbortController().signal });
  assert.equal(seen[0]!.range, `bytes=${kept}-`, "resumed");
  assert.ok(readFileSync(path).equals(BODY));

  // An ensure whose signal aborts at once doesn't leave a download running.
  const quick = new AbortController();
  const q = store.ensure("tiny.en", { signal: quick.signal });
  quick.abort();
  await assert.rejects(q, Cancelled);
  await sleep(100);
  assert.notEqual(store.state().downloads.find((d) => d.model === "tiny.en")?.phase, "downloading");

  // Quitting mid-download keeps the .part.
  store.download("base.en");
  for (let i = 0; i < 100 && !existsSync(join(dir, "ggml-base.en.bin.part")); i++) await sleep(20);
  await sleep(100);
  store.shutdown();
  await sleep(150);
  assert.ok(existsSync(join(dir, "ggml-base.en.bin.part")), "kept for next time");
});
