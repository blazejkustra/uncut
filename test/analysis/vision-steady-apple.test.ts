// D332 on a Mac: the real uncut-vision helper's matte made steady through VisionAnalysis, on a
// synthetic clip (a red ball crossing a blue-grey field, subject mode, macOS 14+) with a one-frame
// green flash in the middle. The steady matte keeps the module's size, frames and clean ball
// edges, and the flash, a real change of picture, shows the module's own matte rather than a
// held one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { stabiliseMatte } from "../../apps/server/src/analysis/vision/stabiliseMatte.ts";
import { VisionAnalysis } from "../../apps/server/src/analysis/vision/vision.ts";
import { discoverPlugins, PluginHost } from "../../apps/server/src/plugins/plugins.ts";
import { findHelper } from "../../plugins/apple-vision/helper.ts";

const PLUGIN_DIR = resolve("plugins/apple-vision");
const W = 640;
const H = 360;
const FRAMES = 60;
const FLASH = 30;

const onPath = (name: string) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim() || undefined;
const ffmpeg = onPath("ffmpeg");
const skip =
  process.platform !== "darwin"
    ? "Apple Vision is macOS only"
    : !ffmpeg
      ? "ffmpeg isn't installed"
      : !onPath("xcrun")
        ? "Xcode's command line tools aren't installed"
        : Number(release().split(".")[0]) < 23
          ? "subject cutout needs macOS 14"
          : false;

let root = "";
let clip = "";
let host: PluginHost;
let analysis: (steady: boolean) => VisionAnalysis;

before(async () => {
  if (skip) return;
  if (!findHelper(PLUGIN_DIR)) execFileSync("node", ["native/vision/build.ts"], { stdio: "ignore" });
  root = mkdtempSync(join(tmpdir(), "uncut-vision-steady-"));
  clip = join(root, "ball.mov");
  const ball = `color=c=0xe04020:s=160x160:r=30:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-80,Y-80),75),255,0)'`;
  const flash = `[0][1]overlay=x='100+t*150':y=100[ball];[ball][2]overlay=enable='eq(n,${FLASH})'`;
  execFileSync(ffmpeg!, [
    ...["-v", "error", "-threads", "4", "-f", "lavfi", "-i", `color=c=0x6080a0:s=${W}x${H}:r=30:d=2`, "-f", "lavfi", "-i", ball],
    ...["-f", "lavfi", "-i", `color=c=0x20c040:s=${W}x${H}:r=30:d=2`],
    ...["-filter_complex", flash, "-c:v", "prores_ks", "-profile:v", "0", "-threads", "4", "-y", clip],
  ]);
  const discovery = await discoverPlugins([{ source: "bundled", dir: resolve("plugins") }], { moduleIds: new Set(), toolNames: new Set() });
  const found = discovery.plugins.find((p) => p.id === "apple.vision")!;
  host = new PluginHost();
  analysis = (steady) =>
    new VisionAnalysis({
      candidates: async () => [{ id: found.id, name: found.name, version: found.version, manifest: found.manifest as unknown as Record<string, unknown> }],
      call: (_id, tool, args, { signal, onProgress }) => host.call(found.spec, tool, args, signal, undefined, undefined, { onProgress }),
      ffmpeg: async () => ffmpeg,
      stabilise: steady ? stabiliseMatte : undefined,
    });
});

after(async () => {
  if (skip) return;
  await host.stopAll();
  rmSync(root, { recursive: true, force: true });
});

const decode = (video: string) =>
  execFileSync(ffmpeg!, ["-v", "error", "-threads", "4", "-i", video, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { maxBuffer: 64 << 20 });

const frameOf = (raw: Buffer, t: number) => raw.subarray(t * W * H, (t + 1) * W * H);

const meanDifference = (a: Uint8Array, b: Uint8Array) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) / a.length;

test("the real helper's matte made steady: same frames and size, clean edges kept, a one-frame flash not held", { skip, timeout: 180000 }, async () => {
  const signal = new AbortController().signal;
  const range = { start: 0, end: 2, mode: "subject" as const };
  const raw = await analysis(false).matte({ dir: join(root, "Raw.uncut"), path: clip }, range, { signal });
  const progress: Array<number> = [];
  const steady = await analysis(true).matte({ dir: join(root, "Steady.uncut"), path: clip }, range, { signal, onProgress: (p) => progress.push(p) });
  assert.deepEqual([steady.info.frames, steady.info.width, steady.info.height], [FRAMES, W, H]);
  assert.deepEqual(steady.info.times, raw.info.times);
  assert.equal(JSON.parse(readFileSync(steady.video.replace(/\.mkv$/, ".json"), "utf8")).result, 2);
  assert.ok(progress.some((p) => p > 0.8 && p < 1) && progress.at(-1)! > 0.99, JSON.stringify(progress.slice(-4)));

  const before = decode(raw.video);
  const after = decode(steady.video);
  assert.equal(after.length, before.length);
  for (let t = 0; t < FRAMES; t++) {
    if (Math.abs(t - FLASH) <= 1) continue;
    const d = meanDifference(frameOf(before, t), frameOf(after, t));
    assert.ok(d < 1, `frame ${t}: the steady matte moved the ball's matte by ${d.toFixed(2)} levels`);
  }
  assert.equal(meanDifference(frameOf(before, FLASH), frameOf(after, FLASH)), 0, "the flash shows the module's own matte");
});
