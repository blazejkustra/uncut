// D328: auto reframe on the server: the plan is made against the project as it is once the subject
// is found, the fallback matte outlives the next edit's cleanup, and a stop reaches everything it
// started (the module's run, the ffmpeg reading the matte). A fake vision module and a stand-in ffmpeg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyEdit, createSession, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { VisionStopped } from "../../apps/server/src/analysis/vision/clipVision.ts";
import { reframeEdit, reframePlan, reframeSubject } from "../../apps/server/src/analysis/vision/reframe.ts";
import { VisionQueue } from "../../apps/server/src/analysis/vision/visionQueue.ts";
import { analysisDir } from "../../apps/server/src/analysis/queue/cache.ts";
import { expandVisionOps } from "../../apps/server/src/agent/tools/visionOps.ts";
import { fakeVision, oneClipProject, visionFolder, type FaceBox, type MatteSpec } from "../helpers/fakeVision.ts";
import { until } from "../helpers/wait.ts";

const skip = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error ? "needs ffmpeg" : false;
const T = { skip, timeout: 60000 };
const ffmpeg = async () => "ffmpeg";

const LEFT_THEN_RIGHT = (frame: number): FaceBox => ({ x: frame < 30 ? 0.1 : 0.75, y: 0.2, w: 0.1, h: 0.2 });
const MOVING_MATTE: MatteSpec = { width: 96, height: 54, fps: 30, frames: 60, lum: "if(between(X,4+N,20+N),255,0)" };

const apply = (p: Project, ops: ReadonlyArray<unknown>) => applyEdit(createSession(p), { actor: "user", ops: ops as ReadonlyArray<Op> }).project;
const clipOf = (p: Project) => p.tracks[0]!.items[0]!;
const FADE_KEYS = [
  { frame: 0, opacity: 0 },
  { frame: 20, opacity: 1 },
];

/** Resolves when the signal aborts, or after `ms` (a run nobody stopped goes on to answer). */
const untilAborted = (signal: AbortSignal, ms = 3000) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

test("D328: keys added while faces were being found are kept, and the plan fits the clip as it is then", T, async () => {
  const f = visionFolder();
  try {
    const { vision } = fakeVision({ face: LEFT_THEN_RIGHT });
    const before = oneClipProject(f.media);
    const subject = await reframeSubject(vision, before, f.dir, "c", ffmpeg);
    const edited = apply(before, [{ op: "update_item", item: "c", set: { keys: FADE_KEYS, duration: 50 } }]);
    const after = apply(edited, reframePlan(edited, "c", subject).ops);
    const keys = clipOf(after).keys!;
    assert.deepEqual(keys.filter((k) => k.opacity !== undefined).map((k) => [k.frame, k.opacity]), [[0, 0], [20, 1]]);
    assert.ok(keys.some((k) => k.x !== undefined), JSON.stringify(keys));
    assert.ok(keys.every((k) => k.frame <= 50), "the plan is for the clip's new length");
  } finally {
    f.cleanup();
  }
});

test("D328: the plan made from the project as it was before the wait would have lost those keys", T, async () => {
  const f = visionFolder();
  try {
    const { vision } = fakeVision({ face: LEFT_THEN_RIGHT });
    const before = oneClipProject(f.media);
    const stale = await reframeEdit(vision, before, f.dir, "c", ffmpeg);
    const edited = apply(before, [{ op: "update_item", item: "c", set: { keys: FADE_KEYS } }]);
    const keys = clipOf(apply(edited, stale.ops)).keys!;
    assert.equal(keys.some((k) => k.opacity !== undefined), false);
  } finally {
    f.cleanup();
  }
});

test("D328: a clip deleted or locked while faces were being found is refused with a sentence", T, async () => {
  const f = visionFolder();
  try {
    const { vision } = fakeVision({ face: LEFT_THEN_RIGHT });
    const before = oneClipProject(f.media);
    const subject = await reframeSubject(vision, before, f.dir, "c", ffmpeg);
    const deleted = { ...before, tracks: [{ ...before.tracks[0]!, items: [] }] };
    assert.throws(() => reframePlan(deleted, "c", subject), /Pick a clip first/);
    const locked = apply(before, [{ op: "update_item", item: "c", set: { locked: true } }]);
    assert.throws(() => reframePlan(locked, "c", subject), /locked/);
  } finally {
    f.cleanup();
  }
});

test("D328: the vision.reframe RPC finds the subject on the open project, then plans inside the edit on the project as it is then", () => {
  const source = readFileSync("apps/server/src/app/ws.ts", "utf8");
  const handler = source.slice(source.indexOf("[RPC_METHODS.visionReframe]"), source.indexOf("[RPC_METHODS.historySubscribe]"));
  assert.match(handler, /reframeSubject\(analysis\.vision, open\.project as Project, open\.dir, itemId, shellFfmpeg\(config\), signal\)/);
  assert.match(handler, /reframeSubject[\s\S]*editFromVision\(open\.openId, \(now\) => reframePlan\(now, itemId, subject, zoom\)/);
  assert.match(handler, /proxies\.track[\s\S]*editFromVision\(open\.openId, \(now\) => trackPlan\(now, ask, made\.target, made\.result\)/);
  assert.match(source, /editFromVision = [\s\S]*\.editIn\(openId, \(now\) =>[\s\S]*plan\(now as Project\)/);
  assert.doesNotMatch(handler, /reframeEdit/);
});

function mattesOnDisk(dir: string) {
  const root = analysisDir(dir);
  return readdirSync(root).flatMap((print) => {
    const folder = join(root, print, "vision");
    return existsSync(folder) ? readdirSync(folder).filter((n) => n.startsWith("matte-")).map((n) => join(folder, n)) : [];
  });
}

test("D328: the matte a clip without faces is reframed from survives the next edit's cleanup, and a second reframe reuses it", T, async () => {
  const f = visionFolder();
  try {
    const { vision, calls } = fakeVision({ matte: MOVING_MATTE });
    const p = oneClipProject(f.media);
    const plan = await reframeEdit(vision, p, f.dir, "c", ffmpeg);
    const set = (plan.ops[0] as { set: Pick<Item, "keys" | "transform"> }).set;
    assert.equal(set.transform?.fit, "cover");

    const kept = mattesOnDisk(f.dir);
    assert.ok(kept.some((n) => n.endsWith(".mkv")), kept.join());
    const folder = join(analysisDir(f.dir), "old-print", "vision");
    mkdirSync(folder, { recursive: true });
    const unheld = join(folder, `matte-${"b".repeat(24)}.mkv`);
    writeFileSync(unheld, "matte");

    const queue = new VisionQueue({ vision, ffmpeg, exportBusy: () => false, onChange: () => {} });
    await queue.sync(f.dir, apply(p, plan.ops));
    assert.equal(existsSync(unheld), false, "the cleanup did run");
    for (const file of kept) assert.equal(existsSync(file), true, `${file} is held`);
    queue.shutdown();

    const made = calls.filter((c) => c.tool === "matte").length;
    await reframeEdit(vision, p, f.dir, "c", ffmpeg);
    assert.equal(calls.filter((c) => c.tool === "matte").length, made);
  } finally {
    f.cleanup();
  }
});

test("D328: an already aborted signal stops reframeSubject before the module is asked", T, async () => {
  const f = visionFolder();
  try {
    const { vision, calls } = fakeVision({ face: LEFT_THEN_RIGHT });
    await assert.rejects(reframeSubject(vision, oneClipProject(f.media), f.dir, "c", ffmpeg, AbortSignal.abort()), VisionStopped);
    assert.equal(calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test("D328: aborting reframeEdit stops the module's run for the faces", T, async () => {
  const f = visionFolder();
  try {
    const { vision, calls } = fakeVision({ face: LEFT_THEN_RIGHT, hold: (_tool, signal) => untilAborted(signal) });
    const stop = new AbortController();
    const reframing = reframeEdit(vision, oneClipProject(f.media), f.dir, "c", ffmpeg, { signal: stop.signal });
    await until(() => calls.length === 1, "the module was asked");
    stop.abort();
    await assert.rejects(reframing, VisionStopped);
    assert.equal(calls[0]!.signal.aborted, true);
  } finally {
    f.cleanup();
  }
});

test("D328: aborting while the fallback matte is being made stops its run", T, async () => {
  const f = visionFolder();
  try {
    let stoppedInTime = false;
    const holdTheMatte = async (tool: string, signal: AbortSignal) => {
      if (tool !== "matte") return;
      await untilAborted(signal);
      stoppedInTime = signal.aborted;
    };
    const { vision, calls } = fakeVision({ hold: holdTheMatte });
    const stop = new AbortController();
    const finding = reframeSubject(vision, oneClipProject(f.media), f.dir, "c", ffmpeg, stop.signal);
    await until(() => calls.some((c) => c.tool === "matte"), "the module was asked for the matte");
    stop.abort();
    await assert.rejects(finding, VisionStopped);
    await until(() => stoppedInTime, "the module's run was stopped by the abort, not left to finish");
  } finally {
    f.cleanup();
  }
});

/** A stand-in ffmpeg that says its pid, then runs for as long as nobody stops it. */
function slowFfmpeg(root: string) {
  const script = join(root, "ffmpeg-slow");
  const pidFile = join(root, "ffmpeg-slow.pid");
  writeFileSync(script, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 20\n`);
  chmodSync(script, 0o755);
  return { script, pidFile };
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("D328: aborting kills the ffmpeg reading the fallback matte", T, async () => {
  const f = visionFolder();
  try {
    const { vision } = fakeVision({ matte: MOVING_MATTE });
    const slow = slowFfmpeg(f.root);
    const stop = new AbortController();
    const finding = reframeSubject(vision, oneClipProject(f.media), f.dir, "c", async () => slow.script, stop.signal);
    await until(() => existsSync(slow.pidFile) && readFileSync(slow.pidFile, "utf8").trim() !== "", "ffmpeg started");
    const pid = Number(readFileSync(slow.pidFile, "utf8"));
    assert.equal(running(pid), true);
    const started = Date.now();
    stop.abort();
    await assert.rejects(finding);
    assert.ok(Date.now() - started < 5000);
    assert.equal(running(pid), false);
  } finally {
    f.cleanup();
  }
});

test("D328: a stop that lands while ffmpeg is being looked up starts no ffmpeg", T, async () => {
  const f = visionFolder();
  try {
    const { vision } = fakeVision({ matte: MOVING_MATTE });
    const slow = slowFfmpeg(f.root);
    const stop = new AbortController();
    const lookup = async () => {
      stop.abort();
      return slow.script;
    };
    await assert.rejects(reframeSubject(vision, oneClipProject(f.media), f.dir, "c", lookup, stop.signal), VisionStopped);
    assert.equal(existsSync(slow.pidFile), false);
  } finally {
    f.cleanup();
  }
});

test("D328: the agent's reframe op passes its signal through: aborting stops the module and answers with a problem", T, async () => {
  const f = visionFolder();
  try {
    const { vision, calls } = fakeVision({ face: LEFT_THEN_RIGHT, hold: (_tool, signal) => untilAborted(signal) });
    const stop = new AbortController();
    const expanding = expandVisionOps(oneClipProject(f.media), f.dir, [{ op: "reframe", item: "c" }], vision, ffmpeg, stop.signal);
    await until(() => calls.length === 1, "the module was asked");
    stop.abort();
    const answer = await expanding;
    assert.ok("problem" in answer, JSON.stringify(answer));
    assert.match(answer.problem, /ops\[0\] \(reframe\): Stopped/);
    assert.equal(calls[0]!.signal.aborted, true);
  } finally {
    f.cleanup();
  }
});

test("D328: the timeline_edit tool hands its run's abort signal to the vision ops", () => {
  const source = readFileSync("apps/server/src/agent/tools/run.ts", "utf8");
  assert.match(source, /expandVisionOps\([\s\S]*?r\.abort\.signal\b/);
});
