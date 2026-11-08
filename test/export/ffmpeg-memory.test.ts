// An export's ffmpeg stays within memory (2026-11-02: one ffmpeg reached 22 GB on a 225-clip
// export and the Mac went down): VideoToolbox decodes for the first 16 inputs only, long timelines
// split into time chunks of a few layers, heavy runs take turns, and a runaway run is stopped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chunkLayers, chunkRanges, exportCommand, planExport, type ExportPlan } from "../../apps/server/src/export/exportPlan.ts";
import { HARDWARE_DECODES_MAX, capHardwareDecodes, capsOf, encodeArgs, guardedRun } from "../../apps/server/src/export/exporter/ffmpeg.ts";
import { encodeChunked } from "../../apps/server/src/export/exporter/chunkedEncode.ts";
import { MemoryLimitExceeded, ffmpegMemoryLimit, parseFootprint, watchMemory } from "../../apps/server/src/export/exporter/processMemory.ts";
import { makeSlots } from "../../apps/server/src/export/exporter/slots.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const videoInput = (file: string) => ["-hwaccel", "videotoolbox", "-ss", "1", "-t", "2", "-i", file];
const count = (args: ReadonlyArray<string>, arg: string) => args.filter((a) => a === arg).length;

test("only the first 16 inputs decode on VideoToolbox; each keeps its seek and two decoder threads", () => {
  const inputs = ["-i", "bg.png", ...Array.from({ length: 40 }, (_, i) => videoInput(`clip-${i}.mp4`)).flat()];
  const capped = capHardwareDecodes(inputs);
  assert.equal(count(capped, "videotoolbox"), HARDWARE_DECODES_MAX);
  assert.equal(count(capped, "-i"), 41);
  assert.equal(count(capped, "-ss"), 40);
  assert.deepEqual(capped.slice(-6), ["-ss", "1", "-t", "2", "-i", "clip-39.mp4"]);
  const args = encodeArgs({ inputs, outputArgs: ["out.mp4"] }, ["-/filter_complex", "graph.txt"]);
  assert.equal(count(args, "videotoolbox"), HARDWARE_DECODES_MAX);
  assert.equal(count(args, "-threads"), 41);
  assert.deepEqual(capHardwareDecodes(inputs.slice(0, 2 + 8 * 3)), inputs.slice(0, 2 + 8 * 3), "a few inputs are left as they are");
});

test("chunk ranges cover every frame once, each with at most its share of layers", () => {
  const layers = Array.from({ length: 40 }, (_, i) => ({ f0: i * 10, f1: i * 10 + 15 }));
  const ranges = chunkRanges(layers, 415, 4);
  assert.equal(ranges[0]!.start, 0);
  assert.equal(ranges.at(-1)!.end, 415);
  ranges.forEach((r, i) => {
    assert.ok(r.end > r.start);
    if (i > 0) assert.equal(r.start, ranges[i - 1]!.end);
    assert.ok(layers.filter((l) => l.f0 < r.end && l.f1 > r.start).length <= 4, `range ${r.start}-${r.end}`);
  });
  assert.deepEqual(chunkRanges(layers, 415, 100), [{ start: 0, end: 415 }]);
  const stacked = Array.from({ length: 10 }, () => ({ f0: 0, f1: 30 }));
  assert.deepEqual(chunkRanges(stacked, 30, 4), [{ start: 0, end: 30 }], "a frame with more layers than the share is still one range");
  assert.equal(chunkLayers(1920, 1080), 16);
  assert.equal(chunkLayers(3840, 2160), 4);
  assert.equal(chunkLayers(7680, 4320), 2);
});

test("heavy runs take turns: no more than the slots at once, the rest in order, a cancelled wait leaves", async () => {
  const slots = makeSlots(2);
  let running = 0;
  let most = 0;
  const order: Array<number> = [];
  const job = async (i: number) => {
    const release = await slots.take();
    running++;
    most = Math.max(most, running);
    order.push(i);
    await sleep(20);
    running--;
    release();
    release();
  };
  await Promise.all([0, 1, 2, 3, 4].map(job));
  assert.equal(most, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  assert.equal(slots.active(), 0);

  const hold = await slots.take();
  const hold2 = await slots.take();
  const controller = new AbortController();
  const waiting = slots.take(controller.signal);
  assert.equal(slots.queued(), 1);
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(slots.queued(), 0);
  hold();
  hold2();
  assert.equal(slots.active(), 0);
});

test("the memory guard reads macOS's footprint and fires once over the limit", async () => {
  assert.equal(parseFootprint("ffmpeg [123]: 64-bit    Footprint: 12 MB (16384 bytes per page)"), 12 * 1024 ** 2);
  assert.equal(parseFootprint("x [1]: 64-bit    Footprint: 1.5 GB (16384 bytes per page)"), 1.5 * 1024 ** 3);
  assert.equal(parseFootprint("no such process"), undefined);
  assert.equal(ffmpegMemoryLimit(24 * 1024 ** 3), Math.round(24 * 1024 ** 3 * 0.4));
  const seen: Array<number> = [];
  const stop = watchMemory(
    1,
    100,
    (used) => seen.push(used),
    5,
    async () => 500,
  );
  await sleep(60);
  stop();
  assert.deepEqual(seen, [500]);
});

test("an ffmpeg over its memory limit is stopped with a clear error", { skip: hasFfmpeg ? false : "needs ffmpeg", timeout: 30000 }, async () => {
  const args = ["-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "10", "-f", "null", "-"];
  const started = Date.now();
  const error = await guardedRun("ffmpeg", args, undefined, undefined, { memoryLimit: 1024 }).then(
    () => undefined,
    (e: Error) => e,
  );
  assert.ok(error instanceof MemoryLimitExceeded, String(error));
  assert.match(error.message, /ffmpeg was stopped at [\d.]+ GB of memory/);
  assert.ok(Date.now() - started < 8000, "stopped long before it would have finished");
});

const clipsProject = (file: string, clips: number): Project =>
  ({
    format: "uncut/0",
    name: "Chunks",
    canvas: { width: 320, height: 180, fps: 30 },
    media: [{ id: "m-a", kind: "video", name: "A.mp4", path: file, probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: true } }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: Array.from({ length: clips }, (_, i) => ({ id: `c${i}`, type: "clip" as const, media: "m-a", in: (i * 7) % 200, duration: 6 })),
      },
    ],
  }) as unknown as Project;

const psnr = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { encoding: "utf8" });
  const average = /average:(\S+)/.exec(r.stderr)?.[1];
  return average === "inf" ? Infinity : Number(average);
};
const frameCount = (file: string) =>
  Number(
    execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], {
      encoding: "utf8",
    }).trim(),
  );

test("an export split into time chunks matches the one-run export frame for frame", { skip: hasFfmpeg ? false : "needs ffmpeg", timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-chunks-")));
  try {
    const file = join(root, "A.mp4");
    const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
    ff(
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:r=48000",
      "-t",
      "10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      file,
    );
    const background = join(root, "bg.png");
    ff("-f", "lavfi", "-i", "color=c=black:s=320x180", "-frames:v", "1", background);
    const plan = planExport(clipsProject(file, 12), { mediaPath: (m) => m.path, width: 320, height: 180 }) as ExportPlan;
    assert.equal(plan.visuals.length, 12);
    const caps = await capsOf("ffmpeg");
    const signal = new AbortController().signal;
    const encode = async (name: string, maxLayers: number) => {
      const temp = mkdtempSync(join(root, `${name}-`));
      const output = join(root, `${name}.mp4`);
      const options = { background, rasters: new Map(), caps, quality: "high" as const, output, video: { encoder: "software" as const } };
      const r = await encodeChunked({ bin: "ffmpeg", caps, plan, options, temp, signal, progress: () => () => {}, maxLayers });
      assert.equal(r.code, 0, r.stderr.slice(-500));
      return output;
    };
    const whole = await encode("whole", 100);
    const chunked = await encode("chunked", 3);
    assert.ok(chunkRanges(plan.visuals, plan.frames, 3).length > 1);
    assert.equal(frameCount(chunked), plan.frames);
    assert.equal(frameCount(whole), plan.frames);
    assert.ok(psnr(chunked, whole) > 40, `PSNR ${psnr(chunked, whole)}`);
    const range = exportCommand(plan, { background, rasters: new Map(), caps, quality: "high", output: "x.mp4", range: { start: 12, end: 30 } });
    assert.match(range.graph, /loop=loop=17:size=1:start=0,settb=1\/30,setpts=N\+12\[b0\]/);
    assert.ok(range.outputArgs.includes("-an") && !range.outputArgs.includes("[aout]"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const worstFramePsnr = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr=stats_file=-", "-f", "null", "-"], { encoding: "utf8" });
  const frames = r.stdout.trim().split("\n");
  assert.ok(frames.length > 1, r.stderr.slice(-500));
  return Math.min(...frames.map((l) => Number(/psnr_avg:(\S+)/.exec(l)?.[1]?.replace("inf", "Infinity"))));
};

/** A clip blended (screen) from frame 20 over the main clip, and four short clips that split the export at 15, 20, 30 and 45. */
const seamProject = (a: string, b: string): Project =>
  ({
    format: "uncut/0",
    name: "Seams",
    canvas: { width: 320, height: 180, fps: 30 },
    media: [a, b].map((path, i) => ({
      id: `m${i}`,
      kind: "video",
      name: `${i}.mp4`,
      path,
      probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: true },
    })),
    tracks: [
      {
        id: "top",
        kind: "video",
        name: "Top",
        items: [
          {
            id: "t",
            type: "clip",
            media: "m1",
            start: 20,
            in: 0,
            duration: 40,
            transform: { scale: 0.6 },
            effects: [{ module: "effect.blend", params: { mode: "screen" } }],
          },
        ],
      },
      {
        id: "mid",
        kind: "video",
        name: "Mid",
        items: [0, 1, 2, 3].map((i) => ({ id: `s${i}`, type: "clip", media: "m0", start: i * 15, in: i * 5, duration: 15, transform: { scale: 0.3 } })),
      },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "u", type: "clip", media: "m0", in: 0, duration: 60 }] },
    ],
  }) as unknown as Project;

/** The seam project exported in one run and in chunks of two layers, with `video` options; the files are in `root`. */
async function seamExports(root: string, video: { readonly fps?: number } = {}) {
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", "-threads", "2", ...args]);
  const clip = (name: string, hue: number) => {
    const file = join(root, name);
    ff(
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=320x180:rate=30:d=10,hue=h=${hue}`,
      "-f",
      "lavfi",
      "-i",
      "sine=r=48000:d=10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      file,
    );
    return file;
  };
  const background = join(root, "bg.png");
  ff("-f", "lavfi", "-i", "color=c=black:s=320x180", "-frames:v", "1", background);
  const plan = planExport(seamProject(clip("a.mp4", 0), clip("b.mp4", 120)), { mediaPath: (m) => m.path, width: 320, height: 180 }) as ExportPlan;
  assert.deepEqual(
    chunkRanges(plan.visuals, plan.frames, 2).map((r) => r.start),
    [0, 15, 20, 30, 45],
  );
  const caps = await capsOf("ffmpeg");
  const encode = async (name: string, maxLayers: number) => {
    const output = join(root, `${name}.mp4`);
    const options = { background, rasters: new Map(), caps, quality: "high" as const, output, video: { ...video, encoder: "software" as const } };
    const temp = mkdtempSync(join(root, `${name}-`));
    const r = await encodeChunked({ bin: "ffmpeg", caps, plan, options, temp, signal: new AbortController().signal, progress: () => () => {}, maxLayers });
    assert.equal(r.code, 0, r.stderr.slice(-500));
    return output;
  };
  return { whole: await encode("whole", 100), chunked: await encode("chunked", 2) };
}

test("a blend mode that starts inside a chunk is drawn as in the one-run export", { skip: hasFfmpeg ? false : "needs ffmpeg", timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-seams-")));
  try {
    const { whole, chunked } = await seamExports(root);
    const worst = worstFramePsnr(chunked, whole);
    assert.ok(worst > 35, `worst frame PSNR ${worst}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a chunked export at another frame rate keeps the one-run export's frames", { skip: hasFfmpeg ? false : "needs ffmpeg", timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-seams-")));
  try {
    const { whole, chunked } = await seamExports(root, { fps: 25 });
    assert.equal(frameCount(whole), 50);
    assert.equal(frameCount(chunked), 50);
    const worst = worstFramePsnr(chunked, whole);
    assert.ok(worst > 35, `worst frame PSNR ${worst}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
