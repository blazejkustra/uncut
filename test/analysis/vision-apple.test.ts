// D325 on a Mac: the real uncut-vision helper behind the bundled Apple Vision plugin, through the
// plugin host and VisionAnalysis, on a synthetic clip (a red ball crossing a blue-grey field).
// Vision finds no person in it, so the cutout is checked in subject mode (macOS 14+) and person
// mode is checked to run and find nothing. Builds the helper first when it isn't there.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseFaces, parseTrack } from "../../packages/contracts/src/index.ts";
import { fingerprint } from "../../apps/server/src/analysis/analysis.ts";
import { VisionAnalysis } from "../../apps/server/src/analysis/vision/vision.ts";
import { visionDir } from "../../apps/server/src/analysis/vision/visionCache.ts";
import { discoverPlugins, PluginHost } from "../../apps/server/src/plugins/plugins.ts";
import { findHelper } from "../../plugins/apple-vision/helper.ts";

const PLUGIN_DIR = resolve("plugins/apple-vision");
const W = 640;
const H = 360;
const FRAMES = 60;

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
const subjectSkip = skip || (Number(release().split(".")[0]) < 23 ? "subject cutout needs macOS 14" : false);

let root = "";
let clip = "";
let host: PluginHost;
let vision: VisionAnalysis;
let visionWith: (ffmpegPath: string) => VisionAnalysis;

before(async () => {
  if (skip) return;
  if (!findHelper(PLUGIN_DIR)) execFileSync("node", ["native/vision/build.ts"], { stdio: "ignore" });
  root = mkdtempSync(join(tmpdir(), "uncut-vision-apple-"));
  clip = join(root, "ball.mov");
  const ball = `color=c=0xe04020:s=160x160:r=30:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-80,Y-80),75),255,0)'`;
  execFileSync(ffmpeg!, [
    ...["-v", "error", "-threads", "4", "-f", "lavfi", "-i", `color=c=0x6080a0:s=${W}x${H}:r=30:d=2`, "-f", "lavfi", "-i", ball],
    ...["-filter_complex", "[0][1]overlay=x='100+t*150':y=100", "-c:v", "prores_ks", "-profile:v", "0", "-threads", "4", "-y", clip],
  ]);
  const discovery = await discoverPlugins([{ source: "bundled", dir: resolve("plugins") }], { moduleIds: new Set(), toolNames: new Set() });
  const found = discovery.plugins.find((p) => p.id === "apple.vision");
  assert.ok(found, JSON.stringify(discovery.broken));
  assert.deepEqual(found.warnings, []);
  host = new PluginHost();
  visionWith = (ffmpegPath) =>
    new VisionAnalysis({
      candidates: async () => [{ id: found.id, name: found.name, version: found.version, manifest: found.manifest as unknown as Record<string, unknown> }],
      call: (_id, tool, args, { signal, onProgress }) => host.call(found.spec, tool, args, signal, undefined, undefined, { onProgress }),
      ffmpeg: async () => ffmpegPath,
    });
  vision = visionWith(ffmpeg!);
});

after(async () => {
  if (skip) return;
  await host.stopAll();
  rmSync(root, { recursive: true, force: true });
});

/** uncut-vision processes still working on `file` (other test runs' helpers don't count). */
const helpersOn = (file: string) => spawnSync("pgrep", ["-f", `uncut-vision matte --input ${file}`], { encoding: "utf8" }).stdout.trim();

const project = () => join(root, "P.uncut");
const signal = () => new AbortController().signal;

/** The matte's frames as raw grey bytes, and its packet count. */
function decodeMatte(video: string) {
  const probe = execFileSync(
    "ffprobe",
    ["-v", "error", "-count_packets", "-show_entries", "stream=codec_name,pix_fmt,width,height,nb_read_packets", "-of", "json", video],
    {
      encoding: "utf8",
    },
  );
  const stream = (JSON.parse(probe) as { streams: Array<Record<string, unknown>> }).streams[0]!;
  const raw = execFileSync(ffmpeg!, ["-v", "error", "-threads", "4", "-i", video, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { maxBuffer: 64 << 20 });
  return { stream, raw };
}

/** Share of white pixels and their mean x (0 to 1) in one frame. */
function whiteOf(raw: Buffer, frame: number) {
  let count = 0;
  let sumX = 0;
  for (let i = 0; i < W * H; i++)
    if (raw[frame * W * H + i]! > 128) {
      count++;
      sumX += (i % W) / W;
    }
  return { share: count / (W * H), x: count ? sumX / count : 0 };
}

test(
  "subject matte: an FFV1 grey .mkv, one frame per source frame at the source size, following the ball; cached after",
  { skip: subjectSkip, timeout: 120000 },
  async () => {
    const progress: Array<number> = [];
    const made = await vision.matte(
      { dir: project(), path: clip },
      { start: 0, end: 2, mode: "subject" },
      { signal: signal(), onProgress: (p) => progress.push(p) },
    );
    assert.equal(made.cached, false);
    assert.equal(made.info.frames, FRAMES);
    assert.equal(made.info.times.length, FRAMES);
    assert.equal(made.info.times[0], 0);
    assert.ok(Math.abs(made.info.times[FRAMES - 1]! - 59 / 30) < 0.001);
    assert.deepEqual([made.info.width, made.info.height, made.info.fps], [W, H, 30]);
    assert.deepEqual(made.info.module, { id: "apple.vision", version: "0.1.0+uncut-vision 1" });
    assert.ok(progress.length > 0 && progress.at(-1)! > 0.95, JSON.stringify(progress.slice(-3)));

    const { stream, raw } = decodeMatte(made.video);
    assert.deepEqual([stream.codec_name, stream.pix_fmt, stream.width, stream.height, Number(stream.nb_read_packets)], ["ffv1", "gray", W, H, FRAMES]);
    assert.equal(raw.length, FRAMES * W * H);
    const first = whiteOf(raw, 0);
    const last = whiteOf(raw, FRAMES - 1);
    const ballShare = (Math.PI * 75 * 75) / (W * H);
    for (const f of [first, last]) assert.ok(f.share > ballShare * 0.6 && f.share < ballShare * 1.6, `white share ${f.share} vs the ball's ${ballShare}`);
    assert.ok(Math.abs(first.x - 180 / W) < 0.03, `first frame centre ${first.x}`);
    assert.ok(Math.abs(last.x - (180 + (59 / 30) * 150) / W) < 0.03, `last frame centre ${last.x}`);

    const again = await vision.matte({ dir: project(), path: clip }, { start: 0, end: 2, mode: "subject" }, { signal: signal() });
    assert.equal(again.cached, true);
    assert.equal(again.video, made.video);
  },
);

test(
  "person matte: runs on a clip with no one in it and comes out black; a sub-range starts at the frame showing at its start",
  { skip, timeout: 120000 },
  async () => {
    const made = await vision.matte({ dir: project(), path: clip }, { start: 0.51, end: 1.02, mode: "person" }, { signal: signal() });
    assert.deepEqual(made.info.times.slice(0, 2), [0.5, 0.533333], "0.51 shows the frame that started at 0.5");
    assert.equal(made.info.times.at(-1), 1, "the frame at 1.0 starts before 1.02");
    assert.equal(made.info.frames, 16);
    const { raw } = decodeMatte(made.video);
    assert.equal(raw.length, 16 * W * H);
    assert.equal(whiteOf(raw, 8).share, 0);
  },
);

test("faces: the contract's shape, none in the synthetic clip", { skip, timeout: 60000 }, async () => {
  const { result } = await vision.faces({ dir: project(), path: clip }, { start: 0, end: 1 }, { signal: signal() });
  assert.ok("value" in parseFaces(result));
  assert.equal(result.frames.length, 30);
  assert.ok(result.frames.every((f) => f.faces.length === 0));
});

test("track: follows the ball from its box to the end of the range", { skip, timeout: 60000 }, async () => {
  const box = { x: 100 / W, y: 100 / H, w: 160 / W, h: 160 / H };
  const { result } = await vision.track({ dir: project(), path: clip }, { at: 0, end: 2, box }, { signal: signal() });
  assert.ok("value" in parseTrack(result));
  assert.equal(result.frames.length, FRAMES);
  const last = result.frames.at(-1)!;
  assert.ok(!last.lost);
  const centre = last.x! + last.w! / 2;
  assert.ok(Math.abs(centre - (180 + (59 / 30) * 150) / W) < 0.05, `tracked centre ${centre}`);
});

test("cancel: the helper and ffmpeg stop, nothing is cached, the plugin keeps running", { skip, timeout: 60000 }, async () => {
  const controller = new AbortController();
  const target = { dir: join(root, "Cancel.uncut"), path: clip };
  const run = vision.matte(target, { start: 0, end: 2, mode: "person" }, { signal: controller.signal, onProgress: () => controller.abort() });
  await assert.rejects(run, /cancelled/);
  const dir = visionDir(target.dir, await fingerprint(clip));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
  assert.ok(host.processOf("apple.vision"), "the plugin process is still up");
  const helpers = helpersOn(clip);
  assert.equal(helpers, "", "no helper left running");
});

/** No matte, no .part, no empty folder and no helper left after `run` failed. */
async function assertNothingLeft(target: { dir: string; path: string }) {
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!existsSync(visionDir(target.dir, await fingerprint(clip))), "no vision folder");
  assert.equal(helpersOn(clip), "", "no helper left running");
  assert.ok(host.processOf("apple.vision"), "the plugin process is still up");
}

test("ffmpeg failing early: a prompt sentence with ffmpeg's own words, the helper stopped, nothing left", { skip, timeout: 60000 }, async () => {
  const broken = join(root, "broken-ffmpeg");
  writeFileSync(broken, "#!/bin/sh\necho 'Unknown encoder ffv1' >&2\nexit 1\n");
  chmodSync(broken, 0o755);
  const target = { dir: join(root, "Broken.uncut"), path: clip };
  const started = Date.now();
  await assert.rejects(
    visionWith(broken).matte(target, { start: 0, end: 2, mode: "person" }, { signal: signal() }),
    /ffmpeg couldn't write the matte \(exit 1\): Unknown encoder ffv1/,
  );
  assert.ok(Date.now() - started < 20000, `took ${Date.now() - started} ms`);
  await assertNothingLeft(target);
});

test("ffmpeg missing: a sentence naming it, the plugin keeps running, nothing left", { skip, timeout: 60000 }, async () => {
  const target = { dir: join(root, "Missing.uncut"), path: clip };
  await assert.rejects(
    visionWith(join(root, "no-ffmpeg-here")).matte(target, { start: 0, end: 2, mode: "person" }, { signal: signal() }),
    /ffmpeg couldn't start \(.*no-ffmpeg-here\)/,
  );
  await assertNothingLeft(target);
});
