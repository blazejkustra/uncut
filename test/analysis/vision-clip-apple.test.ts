// D328 on a Mac: background removal end to end with the real uncut-vision helper behind the bundled
// Apple Vision plugin, on a synthetic clip (a red ball crossing a blue-grey field, subject mode,
// macOS 14+): the preview's queue makes the matte and its H.264 copy with progress and serves them
// by key, the export plan reads it and ffmpeg shows the track below outside the ball, a clip that
// stops using it has it cleaned up, and a path outside the D12 rules is refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ProxyState } from "../../packages/contracts/src/index.ts";
import type { Project } from "../../packages/core/src/index.ts";
import { exportCommand, planExport, silentFailure } from "../../apps/server/src/export/exportPlan.ts";
import { VisionAnalysis } from "../../apps/server/src/analysis/vision/vision.ts";
import { readyVision, visionMediaPath, visionResolver } from "../../apps/server/src/analysis/vision/clipVision.ts";
import { VisionQueue } from "../../apps/server/src/analysis/vision/visionQueue.ts";
import { discoverPlugins, PluginHost } from "../../apps/server/src/plugins/plugins.ts";
import { findHelper } from "../../plugins/apple-vision/helper.ts";

const PLUGIN_DIR = resolve("plugins/apple-vision");
const W = 640;
const H = 360;
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
let dir = "";
let host: PluginHost;
let vision: VisionAnalysis;

before(async () => {
  if (skip) return;
  if (!findHelper(PLUGIN_DIR)) execFileSync("node", ["native/vision/build.ts"], { stdio: "ignore" });
  root = mkdtempSync(join(tmpdir(), "uncut-vision-clip-"));
  dir = join(root, "P.uncut");
  mkdirSync(dir);
  const ball = `color=c=0xe04020:s=160x160:r=30:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-80,Y-80),75),255,0)'`;
  execFileSync(ffmpeg!, [
    ...["-v", "error", "-threads", "4", "-f", "lavfi", "-i", `color=c=0x6080a0:s=${W}x${H}:r=30:d=2`, "-f", "lavfi", "-i", ball],
    ...["-filter_complex", "[0][1]overlay=x='100+t*150':y=100", "-c:v", "prores_ks", "-profile:v", "0", "-threads", "4", "-y", join(root, "ball.mov")],
  ]);
  execFileSync(ffmpeg!, [
    "-v",
    "error",
    "-threads",
    "4",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x20c040:s=${W}x${H}:r=30:d=2`,
    "-c:v",
    "prores_ks",
    "-profile:v",
    "0",
    "-y",
    join(root, "green.mov"),
  ]);
  const discovery = await discoverPlugins([{ source: "bundled", dir: resolve("plugins") }], { moduleIds: new Set(), toolNames: new Set() });
  const found = discovery.plugins.find((p) => p.id === "apple.vision")!;
  host = new PluginHost();
  vision = new VisionAnalysis({
    candidates: async () => [{ id: found.id, name: found.name, version: found.version, manifest: found.manifest as unknown as Record<string, unknown> }],
    call: (_id, tool, args, { signal, onProgress }) => host.call(found.spec, tool, args, signal, undefined, undefined, { onProgress }),
    ffmpeg: async () => ffmpeg,
  });
});

after(async () => {
  if (skip) return;
  await host.stopAll();
  rmSync(root, { recursive: true, force: true });
});

const video = (id: string, file: string) => ({
  id,
  kind: "video" as const,
  name: file,
  path: join(root, file),
  probe: { frames: 60, fps: 30, width: W, height: H, hasAudio: false },
});

function project(cutout = true): Project {
  return {
    format: "uncut/0",
    name: "Cutout",
    canvas: { width: W, height: H, fps: 30, background: "#000000" },
    media: [video("ball", "ball.mov"), video("green", "green.mov")],
    tracks: [
      {
        id: "top",
        kind: "video",
        name: "Top",
        items: [
          {
            id: "b",
            type: "clip",
            media: "ball",
            start: 0,
            in: 0,
            duration: 60,
            ...(cutout ? { effects: [{ module: "effect.cutout", params: { mode: "subject" } }] } : {}),
          },
        ],
      },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "clip", media: "green", in: 0, duration: 60 }] },
    ],
  };
}

/** Frame n of the export of `p` (RGB 0 to 255). */
function exportFrame(p: Project, lookup: Parameters<typeof planExport>[1]["vision"], n: number): Buffer {
  const plan = planExport(p, { mediaPath: (m) => m.path, width: W, height: H, vision: lookup });
  if ("problem" in plan) throw new Error(plan.problem);
  assert.deepEqual(plan.warnings, []);
  const bg = join(root, "bg.png");
  execFileSync(ffmpeg!, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`, "-frames:v", "1", bg]);
  const cmd = exportCommand(plan, {
    background: bg,
    rasters: new Map(),
    caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 },
    quality: "high",
    output: join(root, "x.mp4"),
  });
  const graph = join(root, "graph.txt");
  writeFileSync(graph, cmd.graph);
  const out = join(root, `export-${n}.mkv`);
  const r = spawnSync(
    ffmpeg!,
    [
      "-hide_banner",
      "-y",
      "-threads",
      "4",
      ...cmd.inputs,
      "-/filter_complex",
      graph,
      "-map",
      "[vout]",
      "-c:v",
      "ffv1",
      "-frames:v",
      String(n + 1),
      out,
      "-map",
      "[aout]",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  assert.equal(silentFailure(r.stderr), undefined);
  return execFileSync(ffmpeg!, [
    "-v",
    "error",
    "-i",
    out,
    "-vf",
    `select=eq(n\\,${n}),scale=in_color_matrix=bt709:in_range=tv,format=rgb24`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
}

const px = (frame: Buffer, x: number, y: number) => [...frame.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];

test(
  "the preview's queue makes the subject matte and its preview copy, with progress, served by key; the export cuts the ball out",
  { skip, timeout: 240000 },
  async () => {
    const states: Array<ReadonlyArray<ProxyState>> = [];
    const queue = new VisionQueue({ vision, ffmpeg: async () => ffmpeg, exportBusy: () => false, onChange: (s) => states.push(s) });
    await queue.sync(dir, project());
    await queue.idle();
    const last = states.at(-1)!;
    assert.equal(last.length, 1);
    assert.equal(last[0]!.phase, "done", last[0]!.error);
    assert.deepEqual(last[0]!.vision, { output: "matte", mode: "subject", start: 0, end: 2 });
    assert.ok(
      states.some((s) => s[0]?.phase === "running" && (s[0].progress ?? 0) > 0 && (s[0].progress ?? 0) < 1),
      "progress while it ran",
    );
    const key = last[0]!.key!;
    assert.match(key, /^matte-[0-9a-f]{24}$/);
    const preview = queue.fileFor("ball", `${key}.mp4`)!;
    assert.ok(existsSync(preview));
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", preview], {
      encoding: "utf8",
    }).trim();
    assert.equal(probe, `h264,${W},${H}`);
    assert.equal(queue.fileFor("ball", "matte-000000000000000000000000.mp4"), undefined);
    assert.equal(queue.fileFor("ball", "../../project.json"), undefined);

    const ready = await readyVision(vision, project(), dir);
    assert.equal(ready.made.size, 1);
    const frame = exportFrame(project(), visionResolver(ready), 30);
    ready.release();
    // Frame 30: the ball's centre is at x 100 + 150 + 80 = 330, y 180.
    const centre = px(frame, 330, 180);
    assert.ok(centre[0]! > 180 && centre[2]! < 90, `the ball shows: ${centre}`);
    const far = px(frame, 40, 40);
    assert.ok(far[1]! > 150 && far[0]! < 80, `the green track below shows where the matte is black: ${far}`);

    // The clip stops using it: the matte and its copies go.
    await queue.sync(dir, project(false));
    assert.equal(existsSync(preview), false);
    queue.shutdown();
  },
);

test("vision only reads media files of the project: not its own files, not .cache", { skip }, async () => {
  mkdirSync(join(dir, ".cache"), { recursive: true });
  writeFileSync(join(dir, ".cache", "green.mov"), readFileSync(join(root, "green.mov")));
  writeFileSync(join(dir, "inside.mov"), readFileSync(join(root, "green.mov")));
  const media = (path: string) => ({ id: "x", kind: "video" as const, name: "x", path });
  await assert.rejects(visionMediaPath(dir, media(".cache/green.mov")), /project's own files|cache/);
  await assert.rejects(visionMediaPath(dir, media("inside.mov")), /project's own files/);
  await assert.rejects(visionMediaPath(dir, media(join(root, "nope.mov"))), /isn't there/);
  assert.equal(await visionMediaPath(dir, media(join(root, "ball.mov"))), join(root, "ball.mov").replace(/^\/var\//, "/private/var/"));
});
