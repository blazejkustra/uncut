import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { keyAt, type Item, type Project } from "../../packages/core/src/index.ts";
import { VisionStopped, visionBusy } from "../../apps/server/src/analysis/vision/clipVision.ts";
import { trackPlan, trackTarget } from "../../apps/server/src/analysis/vision/track.ts";
import { VisionAnalysis } from "../../apps/server/src/analysis/vision/vision.ts";
import { VisionQueue } from "../../apps/server/src/analysis/vision/visionQueue.ts";
import { discoverPlugins, PluginHost } from "../../apps/server/src/plugins/plugins.ts";
import { findHelper } from "../../plugins/apple-vision/helper.ts";
import { until } from "../helpers/wait.ts";

const PLUGIN_DIR = resolve("plugins/apple-vision");
const W = 640;
const H = 360;
const SPEED = 150;
const onPath = (name: string) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim() || undefined;
const ffmpeg = onPath("ffmpeg");
const skip =
  process.platform !== "darwin"
    ? "Apple Vision is macOS only"
    : !ffmpeg
      ? "ffmpeg isn't installed"
      : !onPath("xcrun")
        ? "Xcode's command line tools aren't installed"
        : false;

let root = "";
let dir = "";
let host: PluginHost;
let queue: VisionQueue;

function project(clip: Partial<Item> = {}): Project {
  return {
    format: "uncut/0",
    name: "Track",
    canvas: { width: W, height: H, fps: 30 },
    media: [{ id: "m", kind: "video", name: "ball.mov", path: join(root, "ball.mov"), probe: { frames: 120, fps: 30, width: W, height: H, hasAudio: false } }],
    tracks: [
      {
        id: "text",
        kind: "text",
        name: "Text",
        items: [{ id: "t", type: "text", text: "Ball", start: 0, duration: 120, transform: { x: 30, y: 20 } } as Item],
      },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "clip", media: "m", in: 0, duration: 120, ...clip } as Item] },
    ],
  };
}

const BALL_AT_0 = { x: 100, y: 100, w: 160, h: 160 };

before(async () => {
  if (skip) return;
  if (!findHelper(PLUGIN_DIR)) execFileSync("node", ["native/vision/build.ts"], { stdio: "ignore" });
  root = mkdtempSync(join(tmpdir(), "uncut-vision-track-"));
  dir = join(root, "P.uncut");
  mkdirSync(dir);
  const ball = `color=c=0xe04020:s=160x160:r=30:d=4,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-80,Y-80),75),255,0)'`;
  execFileSync(ffmpeg!, [
    ...["-v", "error", "-threads", "4", "-f", "lavfi", "-i", `color=c=0x6080a0:s=${W}x${H}:r=30:d=4`, "-f", "lavfi", "-i", ball],
    ...["-filter_complex", `[0][1]overlay=x='100+t*${SPEED / 2}':y=100`, "-c:v", "prores_ks", "-profile:v", "0", "-threads", "4", "-y", join(root, "ball.mov")],
  ]);
  const discovery = await discoverPlugins([{ source: "bundled", dir: resolve("plugins") }], { moduleIds: new Set(), toolNames: new Set() });
  const found = discovery.plugins.find((p) => p.id === "apple.vision")!;
  host = new PluginHost();
  const vision = new VisionAnalysis({
    candidates: async () => [{ id: found.id, name: found.name, version: found.version, manifest: found.manifest as unknown as Record<string, unknown> }],
    call: (_id, tool, args, { signal, onProgress }) => host.call(found.spec, tool, args, signal, undefined, undefined, { onProgress }),
    ffmpeg: async () => ffmpeg,
  });
  queue = new VisionQueue({ vision, ffmpeg: async () => ffmpeg, exportBusy: () => false, onChange: () => {} });
  await queue.sync(dir, project());
});

after(async () => {
  if (skip) return;
  queue.shutdown();
  await host.stopAll();
  rmSync(root, { recursive: true, force: true });
});

test("D329: the real tracker follows the ball, and the text keeps its offset from it", { skip, timeout: 120000 }, async () => {
  const ask = { item: "t", target: "c", frame: 0, box: BALL_AT_0 };
  const p = project();
  const target = await trackTarget(p, dir, ask);
  const made = await queue.track(target, { item: "t", clip: "c" });
  assert.equal(made.output, "track");
  const plan = trackPlan(p, ask, target, made);
  assert.ok(!("note" in plan && plan.note), "the ball isn't lost");
  const keys = (plan.ops[0] as unknown as { set: { keys: Item["keys"] } }).set.keys!;
  assert.equal(keys[0]!.x, 30);
  assert.ok(keys.length < 40, `thinned: ${keys.length} keys for 120 frames`);
  for (const frame of [30, 60, 110]) {
    const moved = keyAt(keys, "x", frame, 30)! - 30;
    const truth = (frame / 30) * (SPEED / 2);
    assert.ok(Math.abs(moved - truth) < 10, `frame ${frame}: moved ${moved}, the ball moved ${truth}`);
    assert.ok(Math.abs(keyAt(keys, "y", frame, 30)! - 20) < 10, `frame ${frame}: y stays near 20`);
  }
});

test("D329: at 2× the keys move twice as fast on the timeline", { skip, timeout: 120000 }, async () => {
  const p = project({ speed: 2, duration: 60 });
  const ask = { item: "t", target: "c", frame: 0, box: BALL_AT_0 };
  const target = await trackTarget(p, dir, ask);
  const made = await queue.track(target, { item: "t", clip: "c" });
  const keys = (trackPlan(p, ask, target, made).ops[0] as unknown as { set: { keys: Item["keys"] } }).set.keys!;
  const moved = keyAt(keys, "x", 30, 30)! - 30;
  const truth = 2 * (SPEED / 2);
  assert.ok(Math.abs(moved - truth) < 12, `moved ${moved}, the ball moved ${truth}`);
});

test("D329: cancelling stops the real run and nothing is kept", { skip, timeout: 120000 }, async () => {
  const p = project();
  const ask = { item: "t", target: "c", frame: 2, box: BALL_AT_0 };
  const target = await trackTarget(p, dir, ask);
  const done = queue.track(target, { item: "t", clip: "c" });
  queue.cancelTrack("t");
  await assert.rejects(done, VisionStopped);
  assert.equal(
    queue.list().some((s) => s.vision?.output === "track"),
    false,
  );
  await until(() => !visionBusy(), "the stopped run is over");
});
