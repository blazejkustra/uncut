import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import type { ProxyState } from "../../packages/contracts/src/index.ts";
import { applyEdit, createSession, keyAt, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { VisionStopped } from "../../apps/server/src/analysis/vision/clipVision.ts";
import { trackPlan, trackTarget } from "../../apps/server/src/analysis/vision/track.ts";
import { VisionFailure } from "../../apps/server/src/analysis/vision/vision.ts";
import { VisionQueue } from "../../apps/server/src/analysis/vision/visionQueue.ts";
import { deferred, fakeVision, oneClipProject, visionFolder, type FakeVisionOptions } from "../helpers/fakeVision.ts";
import { until } from "../helpers/wait.ts";

const TIMEOUT = { timeout: 30000 };
const MOVING = (frame: number) => ({ x: 0.1 + frame * 0.002, y: 0.4, w: 0.1, h: 0.1 });
const ASK = { item: "t", target: "c", frame: 0, box: { x: 200, y: 900, w: 100, h: 100 } };

const apply = (p: Project, ops: ReadonlyArray<unknown>) => applyEdit(createSession(p), { actor: "user", ops: ops as ReadonlyArray<Op> }).project;

function withText(path: string): Project {
  const p = oneClipProject(path);
  return { ...p, tracks: [{ id: "text", kind: "text", name: "Text", items: [{ id: "t", type: "text", text: "Hi", start: 0, duration: 60, transform: { x: 50, y: 60 } } as Item] }, ...p.tracks] };
}

function queueOf(options: FakeVisionOptions) {
  const { vision, calls } = fakeVision(options);
  const seen: Array<ReadonlyArray<ProxyState>> = [];
  const queue = new VisionQueue({ vision, ffmpeg: async () => "ffmpeg", exportBusy: () => false, onChange: (s) => seen.push(s) });
  return { queue, calls, seen, vision };
}

const textOf = (p: Project) => p.tracks[0]!.items[0]!;

test("D329: a track runs in the queue, its state on the stream names the item and clip and goes when it's over", TIMEOUT, async () => {
  const f = visionFolder();
  try {
    const gate = deferred();
    const { queue, seen, calls } = queueOf({ track: MOVING, hold: () => gate.gate });
    const p = withText(f.media);
    await queue.sync(f.dir, p);
    const target = await trackTarget(p, f.dir, ASK);
    const done = queue.track(target, { item: "t", clip: "c" });
    await until(() => calls.length === 1, "the module was asked");
    const state = queue.list().find((s) => s.vision?.output === "track");
    assert.equal(state?.phase, "running");
    assert.equal(state?.vision?.item, "t");
    assert.equal(state?.vision?.target, "c");
    assert.ok(seen.flat().some((s) => s.vision?.output === "track"));
    gate.open();
    const made = await done;
    assert.equal(made.output, "track");
    assert.equal(queue.list().some((s) => s.vision?.output === "track"), false);
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D329: edits made while tracking are kept: the plan is made on the project as it is then", TIMEOUT, async () => {
  const f = visionFolder();
  try {
    const { queue } = queueOf({ track: MOVING });
    const before = withText(f.media);
    await queue.sync(f.dir, before);
    const target = await trackTarget(before, f.dir, ASK);
    const made = await queue.track(target, { item: "t", clip: "c" });
    const edited = apply(before, [{ op: "update_item", item: "t", set: { transform: { x: 500, y: 600 }, keys: [{ frame: 10, opacity: 0.5 }], text: "New" } }]);
    const plan = trackPlan(edited, ASK, target, made);
    const after = textOf(apply(edited, plan.ops));
    assert.equal(after.text, "New");
    assert.equal(keyAt(after.keys, "x", 0, 30), 500, "from where the text is now");
    assert.ok(after.keys!.some((k) => k.opacity === 0.5), "its other keys stay");
    assert.ok(keyAt(after.keys, "x", 40, 30)! > 500);
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D329: the clip moved or trimmed while tracking: the keys follow the source's moments; gone is a sentence", TIMEOUT, async () => {
  const f = visionFolder();
  try {
    const { queue } = queueOf({ track: MOVING });
    const before = withText(f.media);
    await queue.sync(f.dir, before);
    const target = await trackTarget(before, f.dir, ASK);
    const made = await queue.track(target, { item: "t", clip: "c" });
    const slow = apply(before, [{ op: "update_item", item: "c", set: { speed: 2, duration: 30 } }]);
    const fast = textOf(apply(slow, trackPlan(slow, ASK, target, made).ops));
    const dx = keyAt(fast.keys, "x", 15, 30)! - 50;
    assert.ok(Math.abs(dx - 30 * 0.002 * 1080) < 40, `2× in the clip's time: moved ${dx} (the picture is contained in 1080 wide)`);
    const gone = apply(before, [{ op: "update_item", item: "t", set: { locked: true } }]);
    assert.throws(() => trackPlan(gone, ASK, target, made), /locked/);
    const noClip = { ...before, tracks: [before.tracks[0]!, { ...before.tracks[1]!, items: [] }] };
    assert.throws(() => trackPlan(noClip, ASK, target, made), /video clip/);
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D329: cancelling reaches the module, says stopped and leaves nothing; a second track on the same item is refused", TIMEOUT, async () => {
  const f = visionFolder();
  try {
    const { queue, calls } = queueOf({
      track: MOVING,
      hold: (_tool, signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    });
    const p = withText(f.media);
    await queue.sync(f.dir, p);
    const target = await trackTarget(p, f.dir, ASK);
    const done = queue.track(target, { item: "t", clip: "c" });
    await until(() => calls.length === 1, "the module was asked");
    await assert.rejects(queue.track(target, { item: "t", clip: "c" }), /being tracked already/);
    queue.cancelTrack("t");
    await assert.rejects(done, VisionStopped);
    assert.equal(calls[0]!.signal.aborted, true);
    assert.equal(queue.list().some((s) => s.vision?.output === "track"), false);
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D329: the caller's own stop (the socket went) stops the run, also while it only waits behind another", TIMEOUT, async () => {
  const f = visionFolder();
  try {
    const gate = deferred();
    const { queue, calls } = queueOf({ track: MOVING, hold: (_tool, signal) => Promise.race([gate.gate, new Promise<void>((r) => signal.addEventListener("abort", () => r()))]) });
    const p = withText(f.media);
    const two = { ...p, tracks: [{ ...p.tracks[0]!, items: [...p.tracks[0]!.items, { id: "u", type: "text", text: "Yo", start: 0, duration: 60 } as Item] }, p.tracks[1]!] };
    await queue.sync(f.dir, two);
    const first = await trackTarget(two, f.dir, ASK);
    const second = await trackTarget(two, f.dir, { ...ASK, item: "u", box: { x: 300, y: 900, w: 90, h: 90 } });
    const running = queue.track(first, { item: "t", clip: "c" });
    await until(() => calls.length === 1, "the module was asked");
    const stop = new AbortController();
    const waiting = queue.track(second, { item: "u", clip: "c" }, stop.signal);
    assert.equal(queue.list().find((s) => s.vision?.item === "u")?.phase, "queued");
    stop.abort();
    await assert.rejects(waiting, VisionStopped);
    assert.equal(calls.length, 1, "the waiting one never asked the module");
    gate.open();
    await running;
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D329: a deleted overlay or a closed project stops the run with a sentence", TIMEOUT, async () => {
  const f = visionFolder();
  try {
    const { queue, calls } = queueOf({ track: MOVING, hold: (_tool, signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })) });
    const p = withText(f.media);
    await queue.sync(f.dir, p);
    const done = queue.track(await trackTarget(p, f.dir, ASK), { item: "t", clip: "c" });
    await until(() => calls.length === 1, "the module was asked");
    await queue.sync(f.dir, { ...p, tracks: [{ ...p.tracks[0]!, items: [] }, p.tracks[1]!] });
    await assert.rejects(done, /went while it was being tracked/);
    assert.equal(calls[0]!.signal.aborted, true);
    await queue.sync(f.dir, p);
    const again = queue.track(await trackTarget(p, f.dir, ASK), { item: "t", clip: "c" });
    await queue.sync(undefined, undefined);
    await assert.rejects(again, /went while it was being tracked/);
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D329: a project edit during tracking doesn't drop its state or stop it", TIMEOUT, async () => {
  const f = visionFolder();
  try {
    const gate = deferred();
    const { queue, calls } = queueOf({ track: MOVING, hold: () => gate.gate });
    const p = withText(f.media);
    await queue.sync(f.dir, p);
    const done = queue.track(await trackTarget(p, f.dir, ASK), { item: "t", clip: "c" });
    await until(() => calls.length === 1, "the module was asked");
    await queue.sync(f.dir, apply(p, [{ op: "update_item", item: "t", set: { text: "New" } }]));
    assert.equal(queue.list().find((s) => s.vision?.item === "t")?.phase, "running");
    gate.open();
    assert.equal((await done).output, "track");
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D329: offline media, a module's refusal and no module are sentences", TIMEOUT, async () => {
  const f = visionFolder();
  try {
    const { queue } = queueOf({ refuse: { track: "The .mkv format isn't one the module can read." } });
    const p = withText(f.media);
    await queue.sync(f.dir, p);
    await assert.rejects(queue.track(await trackTarget(p, f.dir, ASK), { item: "t", clip: "c" }), /can read/);
    const none = queueOf({ noModule: true });
    await none.queue.sync(f.dir, p);
    await assert.rejects(none.queue.track(await trackTarget(p, f.dir, ASK), { item: "t", clip: "c" }), (e: Error) => e instanceof VisionFailure && /Motion tracking/.test(e.message));
    rmSync(f.media);
    await assert.rejects(trackTarget(p, f.dir, ASK), /isn't there/);
    queue.shutdown();
    none.queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D329: inside the project's own files is refused like every vision read", TIMEOUT, async () => {
  const f = visionFolder();
  try {
    const p = withText(`${f.dir}/project.json`);
    await assert.rejects(trackTarget(p, f.dir, ASK), /project's own files/);
  } finally {
    f.cleanup();
  }
});
