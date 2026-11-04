// D327 review: reversed copies are made by one run shared by every caller, a caller that stops
// stops only its own wait, a run nobody waits for stops and can start again, copies an export or a
// frame session holds aren't removed, and leftovers of unfinished runs are.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProxyState } from "../../packages/contracts/src/index.ts";
import type { Item, Project } from "../../packages/core/src/index.ts";
import { Cancelled } from "../../apps/server/src/export/exporter/ffmpeg.ts";
import { ensureReversed, pinReversed, reversedDir, ReverseQueue, reverseTargets } from "../../apps/server/src/media/reversed.ts";

const skip = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error ? "needs ffmpeg" : false;
let dir = "";
before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-reversed-"));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=320x180:r=30:d=6",
    "-c:v",
    "libx264",
    "-g",
    "10",
    "-threads",
    "4",
    join(dir, "src.mp4"),
  ]);
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

const project = (clips: Array<Item>): Project => ({
  format: "uncut/0",
  name: "Rev",
  canvas: { width: 320, height: 180, fps: 30 },
  media: [{ id: "m", kind: "video", name: "src.mp4", path: join(dir, "src.mp4"), probe: { frames: 180, fps: 30, width: 320, height: 180, hasAudio: false } }],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: clips }],
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reversedClip = (inPoint: number): Item => ({ id: "c", type: "clip", media: "m", in: inPoint, duration: 30, reverse: true });
const targetOf = async (p: Project) => (await reverseTargets(p, dir, (m) => m.path))[0]!;
/** Chunks of 3 frames, so a run lasts long enough to stop. */
const options = (signal?: AbortSignal) => ({ ffmpeg: "ffmpeg", fps: 30, signal, bufferBytes: 320 * 180 * 8 * 3 });

test("a caller that stops waiting leaves the shared run to the others", { skip, timeout: 60000 }, async () => {
  const target = await targetOf(project([reversedClip(20)]));
  const a = new AbortController();
  const first = ensureReversed(target, options(a.signal));
  const second = ensureReversed(target, options());
  await sleep(150);
  a.abort();
  await assert.rejects(first, Cancelled);
  await second;
  assert.ok(existsSync(target.output));
});

test("a run nobody waits for stops (no copy, no leftovers), and the next ask makes it", { skip, timeout: 60000 }, async () => {
  const target = await targetOf(project([reversedClip(100)]));
  const a = new AbortController();
  const run = ensureReversed(target, options(a.signal));
  setTimeout(() => a.abort(), 50);
  await assert.rejects(run, Cancelled);
  await ensureReversed(target, options());
  assert.ok(existsSync(target.output));
  assert.deepEqual(
    readdirSync(reversedDir(dir)).filter((f) => f.includes(".part") || f.includes(".chunks-")),
    [],
  );
});

test(
  "the preview's queue: a run another caller stopped still finishes for it; held copies stay, others and leftovers go",
  { skip, timeout: 60000 },
  async () => {
    const p = project([reversedClip(60)]);
    const target = await targetOf(p);
    let states: ReadonlyArray<ProxyState> = [];
    const queue = new ReverseQueue({ ffmpeg: async () => "ffmpeg", exportBusy: () => false, onChange: (s) => (states = s) });
    const frames = new AbortController();
    const render = ensureReversed(target, options(frames.signal));
    await queue.sync(dir, p);
    await sleep(150);
    assert.equal(states.find((s) => s.reverse)?.phase, "running");
    frames.abort();
    await assert.rejects(render, Cancelled);
    await queue.idle();
    assert.equal(states.find((s) => s.reverse)?.phase, "done");
    assert.ok(existsSync(target.output));

    const release = pinReversed([target]);
    writeFileSync(join(reversedDir(dir), "m--000000000000--0-30.mp4.part"), "");
    mkdirSync(join(reversedDir(dir), "m--000000000000--0-30.mp4.chunks-abc"));
    await queue.sync(dir, project([]));
    assert.ok(existsSync(target.output), "held by an export");
    assert.deepEqual(
      readdirSync(reversedDir(dir)).filter((f) => f.includes(".part") || f.includes(".chunks-")),
      [],
    );
    release();
    await queue.sync(dir, project([]));
    assert.ok(!existsSync(target.output), "no clip reads it and nothing holds it");
    queue.shutdown();
  },
);
