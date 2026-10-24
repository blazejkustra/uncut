// D291 review: a streamed layer is one lossless video, not a PNG per frame:
// - the layer's output is a single FFV1 file in the temp folder (no PNGs, no folder per layer),
//   with every frame, each the frame the PNG path draws (alpha exact, colour within 1);
// - the encoder settings are lossless: raw straight BGRA (every alpha, colour under alpha 0 too)
//   comes back byte for byte, at a size too small for 16 slices too;
// - free space is checked before anything is drawn: too little refuses with a plain sentence;
// - an ffmpeg stopping on a full disk is said as a full disk, not as the rasteriser's broken pipe.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicDocument, graphicInfo, type Project } from "../../packages/core/src/index.ts";
import { planExport, type ExportPlan } from "../../apps/server/src/export/exportPlan.ts";
import { ffv1Args, rasterise } from "../../apps/server/src/export/exporter/rasterise.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { rgbaOf } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const needsFfmpeg = hasFfmpeg ? false : "needs ffmpeg";
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : needsFfmpeg;
const FFMPEG = hasFfmpeg ? execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() : "ffmpeg";

const W = 160;
const H = 200;
const FPS = 60;
const FRAMES = 400;

/** A white square moving on transparency, a half-transparent red bar, and an alpha ramp. */
const MOVER = `<canvas id="c" width="${W}" height="${H}"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
window.render = (t, info) => {
  const n = Math.round(t * info.fps);
  ctx.clearRect(0, 0, ${W}, ${H});
  ctx.fillStyle = "#ffffff"; ctx.fillRect((n * 7) % 120, 20, 40, 40);
  ctx.fillStyle = "rgba(255, 0, 0, 0.5)"; ctx.fillRect(0, 120, ${W}, 30);
  for (let x = 0; x < ${W}; x++) { ctx.fillStyle = "rgba(30, 200, " + (n % 256) + ", " + (x / ${W}).toFixed(3) + ")"; ctx.fillRect(x, 160, 1, 30); }
};
</script>`;

const project: Project = {
  format: "uncut/0",
  name: "Stream",
  canvas: { width: W, height: H, fps: FPS },
  media: [],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src: "graphics/mover.html", duration: FRAMES }] }],
} as unknown as Project;

const planOf = (): ExportPlan => {
  const plan = planExport(project, { mediaPath: () => "", width: W, height: H, graphic: () => MOVER });
  if ("problem" in plan) throw new Error(plan.problem);
  return plan;
};

let root: string;
let raster: Rasterizer | undefined;

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-stream-video-")));
  if (skip) return;
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

const fresh = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
};

test("a streamed layer is one lossless video: every frame, each the PNG path's frame, alpha exact", { skip, timeout: 180000 }, async () => {
  const plan = planOf();
  const dir = fresh("one-video");
  const heard: Array<[number, number]> = [];
  const { rasters } = await rasterise(
    raster!,
    plan,
    project,
    () => "",
    dir,
    new AbortController().signal,
    undefined,
    { bin: FFMPEG },
    (done, total) => heard.push([done, total]),
  );
  // Each streamed frame heard as done of total (the export dialog's "frame 312 of 1680").
  assert.equal(heard.length, FRAMES);
  assert.deepEqual(heard.at(-1), [FRAMES, FRAMES]);
  const layer = plan.visuals.find((l) => l.kind === "graphic")!;
  const out = rasters.get(layer);
  assert.ok(out?.kind === "video", `streamed into one video, not ${out?.kind}`);
  assert.equal(out.frames, FRAMES);
  const files = readdirSync(dir).sort();
  assert.deepEqual(
    files.filter((f) => f !== "background.png" && !f.endsWith(".fifo")),
    ["l0.mkv"],
    `one file for the layer, no PNG per frame: ${files.join(", ")}`,
  );
  const frames = rgbaOf(out.file);
  assert.equal(frames.length, FRAMES * W * H * 4, "every frame there");
  for (const i of [0, 5, 199, 399]) {
    const png = join(root, `png-${i}.png`);
    await raster!.render({
      kind: "graphic",
      width: W,
      height: H,
      doc: graphicDocument(MOVER, { width: W, height: H }),
      t: i / FPS,
      info: graphicInfo({ duration: FRAMES, props: {} }, { width: W, height: H, fps: FPS }, i),
      out: png,
    });
    const want = rgbaOf(png);
    const got = frames.subarray(i * W * H * 4, (i + 1) * W * H * 4);
    let alpha = 0;
    let colour = 0;
    for (let k = 0; k < want.length; k++) {
      const d = Math.abs(want[k]! - got[k]!);
      if (k % 4 === 3) alpha = Math.max(alpha, d);
      else if (want[k - (k % 4) + 3]! > 0) colour = Math.max(colour, d);
    }
    assert.equal(alpha, 0, `frame ${i}: alpha exact`);
    assert.ok(colour <= 1, `frame ${i}: colour within 1 of the PNG path (worst ${colour})`);
  }
});

test("the stream's encoder settings are lossless: raw straight BGRA back byte for byte", { skip: needsFfmpeg, timeout: 60000 }, () => {
  for (const [w, h] of [
    [W, H],
    [3, 2],
  ] as const) {
    const n = 5;
    const raw = Buffer.alloc(w * h * 4 * n);
    // Every byte value in every channel, alpha 0 with colour under it included.
    for (let k = 0; k < raw.length; k++) raw[k] = (k * 37 + Math.floor(k / 7)) & 255;
    const dir = fresh(`lossless-${w}x${h}`);
    const input = join(dir, "in.raw");
    writeFileSync(input, raw);
    const file = join(dir, "out.mkv");
    execFileSync(FFMPEG, [
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "-s",
      `${w}x${h}`,
      "-framerate",
      String(FPS),
      "-i",
      input,
      ...ffv1Args(w, h),
      "-pix_fmt",
      "bgra",
      "-f",
      "matroska",
      file,
    ]);
    const back = execFileSync(FFMPEG, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "bgra", "-"], { maxBuffer: 64 * 1024 * 1024 });
    assert.ok(back.equals(raw), `${w}×${h}: byte for byte`);
  }
});

test("too little free space refuses before anything is drawn, in a plain sentence", { timeout: 30000 }, async () => {
  const plan = planOf();
  let drawn = 0;
  const stub = {
    render: async () => {
      drawn++;
      throw new Error("drawn");
    },
    close: async () => {},
  } as unknown as Rasterizer;
  const dir = fresh("no-space");
  await assert.rejects(
    rasterise(stub, plan, project, () => "", dir, new AbortController().signal, undefined, { bin: FFMPEG, freeBytes: async () => 5_000_000 }),
    (e: Error) => {
      assert.match(
        e.message,
        new RegExp(`^This export needs about \\d+\\.\\d+ GB free in ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} for its graphics; there's 0\\.01 GB\\.$`),
      );
      return true;
    },
  );
  assert.equal(drawn, 0, "nothing drawn");
  // Enough space: past the check (to the stub's first drawing).
  await assert.rejects(
    rasterise(stub, plan, project, () => "", fresh("space"), new AbortController().signal, undefined, { bin: FFMPEG, freeBytes: async () => 1e12 }),
    /drawn/,
  );
});

test("an ffmpeg that stops on a full disk is said as a full disk", { skip, timeout: 60000 }, async () => {
  const fake = join(root, "ffmpeg-full");
  writeFileSync(fake, `#!/bin/sh\necho "Error writing trailer: No space left on device" >&2\nexit 1\n`);
  chmodSync(fake, 0o755);
  const dir = fresh("full-disk");
  await assert.rejects(
    rasterise(raster!, planOf(), project, () => "", dir, new AbortController().signal, undefined, { bin: fake }),
    (e: Error) => {
      assert.equal(e.message, `The disk filled up in ${root} while the export drew its graphics. Free some space, then export again.`);
      return true;
    },
  );
});
