// D328: a matte's life beside the preview and the export: odd sizes, its preview copy being optional
// for the export, the pins that keep it from the preview's cleanup, and offline or refused media
// answering with a reason. A fake vision module (test/helpers/fakeVision.ts); real ffmpeg on small clips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProxyState } from "../../packages/contracts/src/index.ts";
import type { Item, Project } from "../../packages/core/src/index.ts";
import {
  type ClipVisionResult,
  clipVisionTargets,
  ensureClipVision,
  pinVision,
  previewOf,
  readyVision,
  requestId,
  visionBusy,
  visionPinned,
  visionResolver,
} from "../../apps/server/src/analysis/vision/clipVision.ts";
import { VisionQueue } from "../../apps/server/src/analysis/vision/visionQueue.ts";
import { analysisDir } from "../../apps/server/src/analysis/queue/cache.ts";
import { exportCommand, planExport, silentFailure } from "../../apps/server/src/export/exportPlan.ts";
import { afterRunSettled, CUTOUT_PERSON, deferred, fakeVision, oneClipProject, visionFolder } from "../helpers/fakeVision.ts";

const skip = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error ? "needs ffmpeg" : false;
const T = { skip, timeout: 60000 };
const CAP = ["-threads", "4", "-filter_threads", "4", "-filter_complex_threads", "4"];

const ODD_W = 853;
const ODD_H = 480;
const CANVAS_W = 854;
const ODD_MATTE = { width: ODD_W, height: ODD_H, fps: 30, frames: 15, lum: `if(lt(X,${ODD_W / 2}),255,0)` };

type Folder = ReturnType<typeof visionFolder>;

const hasFfmpeg = async (): Promise<string | undefined> => "ffmpeg";
const noFfmpeg = async (): Promise<string | undefined> => undefined;
const queueOf = (vision: ReturnType<typeof fakeVision>["vision"], { ffmpeg = hasFfmpeg, exportBusy = (): boolean => false } = {}) => new VisionQueue({ vision, ffmpeg, exportBusy, onChange: () => {} });

const solidClip = (out: string, colour: string, size: string) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", ...CAP, "-f", "lavfi", "-i", `color=c=${colour}:s=${size}:r=30:d=0.5`, "-c:v", "ffv1", out]);

function oddSizeFiles(f: Folder) {
  const top = join(f.root, "odd.mkv");
  const under = join(f.root, "under.mkv");
  solidClip(top, "0xe02020", `${ODD_W}x${ODD_H}`);
  solidClip(under, "0x2020e0", `${CANVAS_W}x${ODD_H}`);
  return { top, under };
}

function oddSizeProject(top: string, under: string): Project {
  const probe = (width: number) => ({ frames: 15, fps: 30, width, height: ODD_H, hasAudio: false });
  return {
    format: "uncut/0",
    name: "Odd",
    canvas: { width: CANVAS_W, height: ODD_H, fps: 30, background: "#000000" },
    media: [
      { id: "odd", kind: "video", name: "odd.mkv", path: top, probe: probe(ODD_W) },
      { id: "under", kind: "video", name: "under.mkv", path: under, probe: probe(CANVAS_W) },
    ],
    tracks: [
      { id: "top", kind: "video", name: "Top", items: [{ id: "t", type: "clip", media: "odd", start: 0, in: 0, duration: 15, effects: [CUTOUT_PERSON] } as Item] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "u", type: "clip", media: "under", in: 0, duration: 15 } as Item] },
    ],
  };
}

/** Exports frame 5 with what readyVision made; its RGB pixels, and the inputs the command read. */
async function exportOddFrame(f: Folder, p: Project, vision: ReturnType<typeof fakeVision>["vision"]) {
  const ready = await readyVision(vision, p, f.dir);
  try {
    const plan = planExport(p, { mediaPath: (m) => m.path, width: CANVAS_W, height: ODD_H, vision: visionResolver(ready) });
    if ("problem" in plan) throw new Error(plan.problem);
    assert.deepEqual(plan.warnings, []);
    const background = join(f.root, "bg.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${CANVAS_W}x${ODD_H}`, "-frames:v", "1", background]);
    const cmd = exportCommand(plan, { background, rasters: new Map(), caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 }, quality: "high", output: join(f.root, "x.mp4") });
    const graph = join(f.root, "graph.txt");
    writeFileSync(graph, cmd.graph);
    const out = join(f.root, "out.mkv");
    const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...CAP, ...cmd.inputs, "-/filter_complex", graph, "-map", "[vout]", "-c:v", "ffv1", "-frames:v", "6", out, "-map", "[aout]", "-f", "null", "-"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr.slice(-1500));
    assert.equal(silentFailure(r.stderr), undefined);
    const frame = execFileSync("ffmpeg", ["-v", "error", ...CAP, "-i", out, "-vf", "select=eq(n\\,5),format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 8 << 20 });
    const px = (x: number, y: number) => [...frame.subarray((y * CANVAS_W + x) * 3, (y * CANVAS_W + x) * 3 + 3)];
    return { px, inputs: cmd.inputs, video: [...ready.made.values()][0] as ClipVisionResult & { output: "matte" } };
  } finally {
    ready.release();
  }
}

function assertCutOut(px: (x: number, y: number) => Array<number>) {
  const kept = px(100, 240);
  const removed = px(700, 240);
  assert.ok(kept[0]! > 180 && kept[2]! < 80, `the clip shows where the matte is white: ${kept}`);
  assert.ok(removed[2]! > 180 && removed[0]! < 80, `the track below shows where the matte is black: ${removed}`);
}

test("D328: 853x480 footage gets a matte and an encoded preview copy at even size, and the export applies the cutout", T, async () => {
  const f = visionFolder();
  try {
    const { top, under } = oddSizeFiles(f);
    const p = oddSizeProject(top, under);
    const { vision } = fakeVision({ matte: ODD_MATTE });
    const queue = queueOf(vision);
    await queue.sync(f.dir, p);
    await queue.idle();
    const state = queue.list()[0]!;
    assert.equal(state.phase, "done", state.error);
    const preview = queue.fileFor("odd", `${state.key}.mp4`)!;
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", preview], { encoding: "utf8" }).trim();
    assert.equal(probe, `h264,${CANVAS_W},${ODD_H}`);
    queue.shutdown();
    assertCutOut((await exportOddFrame(f, p, vision)).px);
  } finally {
    f.cleanup();
  }
});

test("D328: the export reads the matte itself: it makes no preview copy and doesn't need one", T, async () => {
  const f = visionFolder();
  try {
    const { top, under } = oddSizeFiles(f);
    const { vision } = fakeVision({ matte: ODD_MATTE });
    const { px, inputs, video } = await exportOddFrame(f, oddSizeProject(top, under), vision);
    assertCutOut(px);
    assert.ok(inputs.includes(video.video), "the export's command reads the matte's .mkv");
    assert.equal(inputs.some((a) => a.endsWith(".preview.mp4")), false);
    assert.equal(existsSync(previewOf(video.video)), false, "making the matte for the export made no preview copy");
  } finally {
    f.cleanup();
  }
});

test("D328: a preview copy that can't be made fails only the preview: the export still applies the cutout", T, async () => {
  const f = visionFolder();
  try {
    const { top, under } = oddSizeFiles(f);
    const p = oddSizeProject(top, under);
    const { vision } = fakeVision({ matte: ODD_MATTE });
    const queue = queueOf(vision, { ffmpeg: noFfmpeg });
    await queue.sync(f.dir, p);
    await queue.idle();
    const state = queue.list()[0]!;
    assert.equal(state.phase, "failed");
    assert.match(state.error!, /The matte is made, but its preview couldn't be/);
    queue.shutdown();
    assertCutOut((await exportOddFrame(f, p, vision)).px);
  } finally {
    f.cleanup();
  }
});

/** A matte no clip reads, of an earlier edit, in the project's cache. */
function leftoverMatte(dir: string) {
  const folder = join(analysisDir(dir), "old-print", "vision");
  mkdirSync(folder, { recursive: true });
  const video = join(folder, `matte-${"a".repeat(24)}.mkv`);
  writeFileSync(video, "matte");
  return video;
}

test("D328: a matte is pinned the moment its run hands it over, so cleanup can't take it before the reader pins it", T, async () => {
  const f = visionFolder();
  try {
    const { vision } = fakeVision();
    const p = oneClipProject(f.media, { effects: [CUTOUT_PERSON] });
    const target = (await clipVisionTargets(p, f.dir)).targets[0]!;
    const made = await ensureClipVision(vision, target);
    assert.ok(made.output === "matte");
    assert.equal(visionPinned(made.video), true);
    await afterRunSettled();
    assert.equal(visionPinned(made.video), false, "with no reader left the run's own pin goes");
  } finally {
    f.cleanup();
  }
});

test("D328: cleanup leaves a matte an export holds until the export lets it go", T, async () => {
  const f = visionFolder();
  try {
    const { vision } = fakeVision();
    const used = oneClipProject(f.media, { effects: [CUTOUT_PERSON] });
    const unused = oneClipProject(f.media);
    const ready = await readyVision(vision, used, f.dir);
    const made = [...ready.made.values()][0]!;
    assert.ok(made.output === "matte");
    await afterRunSettled();
    assert.equal(visionPinned(made.video), true);
    const queue = queueOf(vision);
    await queue.sync(f.dir, unused);
    assert.equal(existsSync(made.video), true, "pinned by the export");
    ready.release();
    assert.equal(visionPinned(made.video), false);
    await queue.sync(f.dir, unused);
    assert.equal(existsSync(made.video), false, "released and read by no clip");
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D328: pins count: one holder letting go leaves the matte pinned for the other, and releasing twice counts once", T, () => {
  const made: ClipVisionResult = { output: "faces", key: "faces-x", file: "/tmp/pin-count.json", result: { start: 0, end: 1, fps: 30, width: 1, height: 1, frames: [] } as never };
  const first = pinVision([made]);
  const second = pinVision([made]);
  first();
  first();
  assert.equal(visionPinned(made.file), true);
  second();
  assert.equal(visionPinned(made.file), false);
});

test("D328: cleanup skips while a result is being made or an export runs, and removes the leftover after", T, async () => {
  const f = visionFolder();
  try {
    const { gate, open } = deferred();
    const entered = deferred();
    const { vision } = fakeVision({
      hold: async () => {
        entered.open();
        await gate;
      },
    });
    const leftover = leftoverMatte(f.dir);
    const unused = oneClipProject(f.media);
    const target = (await clipVisionTargets(oneClipProject(f.media, { effects: [CUTOUT_PERSON] }), f.dir)).targets[0]!;
    const making = ensureClipVision(vision, target);
    await entered.gate;
    assert.equal(visionBusy(), true);
    const queue = queueOf(vision);
    await queue.sync(f.dir, unused);
    assert.equal(existsSync(leftover), true, "something is being made");
    open();
    await making;
    await afterRunSettled();
    const exporting = queueOf(vision, { exportBusy: () => true });
    await exporting.sync(f.dir, unused);
    assert.equal(existsSync(leftover), true, "an export runs");
    await queue.sync(f.dir, unused);
    assert.equal(existsSync(leftover), false);
    queue.shutdown();
    exporting.shutdown();
  } finally {
    f.cleanup();
  }
});

const onlyState = (queue: VisionQueue): ProxyState => {
  const states = queue.list();
  assert.equal(states.length, 1);
  return states[0]!;
};

test("D328: offline media: the clip's state is failed with the reason at once, and comes back when the file does", T, async () => {
  const f = visionFolder();
  try {
    const { vision, calls } = fakeVision();
    const offline = join(f.root, "offline.mp4");
    const p = oneClipProject(offline, { effects: [CUTOUT_PERSON] });
    const queue = queueOf(vision);
    await queue.sync(f.dir, p);
    await queue.idle();
    const state = onlyState(queue);
    assert.equal(state.phase, "failed");
    assert.match(state.error!, /talk\.mp4's file isn't there/);
    assert.equal(calls.length, 0);

    writeFileSync(offline, Buffer.alloc(4096, 5));
    await queue.sync(f.dir, p);
    await queue.idle();
    assert.equal(onlyState(queue).phase, "done", onlyState(queue).error);

    rmSync(offline);
    await queue.sync(f.dir, p);
    assert.equal(onlyState(queue).phase, "failed", "media going offline after it was done says so too");
    assert.match(onlyState(queue).error!, /isn't there/);
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D328: refused media is failed with the reason, while an export runs too (the queue isn't pumping)", T, async () => {
  const f = visionFolder();
  try {
    const { vision, calls } = fakeVision();
    const queue = queueOf(vision, { exportBusy: () => true });
    await queue.sync(f.dir, oneClipProject(join(f.dir, "project.json"), { effects: [CUTOUT_PERSON] }));
    const state = onlyState(queue);
    assert.equal(state.phase, "failed");
    assert.match(state.error!, /project's own files/);
    assert.equal(calls.length, 0);
    queue.shutdown();
  } finally {
    f.cleanup();
  }
});

test("D328: clipVisionTargets lists a media it can't read as refused with its reason, not as a target", T, async () => {
  const f = visionFolder();
  try {
    mkdirSync(join(f.dir, ".cache"));
    writeFileSync(join(f.dir, ".cache", "x.mp4"), "x");
    const reasons: ReadonlyArray<[string, RegExp]> = [
      [join(f.root, "gone.mp4"), /isn't there/],
      [join(f.dir, "project.json"), /project's own files/],
      [join(f.dir, ".cache", "x.mp4"), /project's own files|cache/],
    ];
    for (const [path, reason] of reasons) {
      const { targets, refused } = await clipVisionTargets(oneClipProject(path, { effects: [CUTOUT_PERSON] }), f.dir);
      assert.deepEqual(targets, []);
      assert.equal(refused.length, 1);
      assert.match(refused[0]!.reason, reason);
      assert.equal(refused[0]!.id, requestId("m", refused[0]!));
    }
  } finally {
    f.cleanup();
  }
});

test("D328: a module's own error or no module at all reach the clip's state as failed, in their words", T, async () => {
  const f = visionFolder();
  try {
    const p = oneClipProject(f.media, { effects: [CUTOUT_PERSON] });
    const crashed = queueOf(fakeVision({ refuse: { matte: "The helper crashed on frame 12." } }).vision);
    await crashed.sync(f.dir, p);
    await crashed.idle();
    assert.equal(onlyState(crashed).phase, "failed");
    assert.equal(onlyState(crashed).error, "The helper crashed on frame 12.");
    crashed.shutdown();

    const none = queueOf(fakeVision({ noModule: true }).vision);
    await none.sync(f.dir, p);
    await none.idle();
    assert.equal(onlyState(none).phase, "failed");
    assert.match(onlyState(none).error!, /Background removal needs a vision module/);
    none.shutdown();
  } finally {
    f.cleanup();
  }
});
