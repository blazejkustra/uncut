// A user LUT on the bundled server: imported into project.json, drawn by the export, and the export's
// colours are what core's table says they should be.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { colourFn } from "../../packages/core/src/visual/fx/colour.ts";
import { clipFx } from "../../packages/core/src/visual/fx/clipFx.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const skip = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "not built (run pnpm build)" : false;

type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let dir = "";
let cubeFile = "";
let client: Client;

/** Red and green swapped, blue halved. */
function cubeText() {
  const n = 9;
  const lines = ['TITLE "Swap"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${g / (n - 1)} ${r / (n - 1)} ${(b / (n - 1)) * 0.5}`);
  return lines.join("\n");
}

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-lut-")));
  for (const d of ["out", "tmp"]) mkdirSync(join(root, d));
  cubeFile = join(root, "Swap.cube");
  writeFileSync(cubeFile, cubeText());
  const clip = join(root, "flat.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xC04020:s=320x180:r=30:d=2",
    "-vf",
    "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-c:v",
    "libx264",
    "-crf",
    "10",
    clip,
  ]);
  const project = {
    format: "uncut/0",
    name: "LUT",
    canvas: { width: 320, height: 180, fps: 30 },
    media: [{ id: "m-f", kind: "video", name: "flat.mp4", path: clip, probe: { frames: 60, fps: 30, width: 320, height: 180, hasAudio: false } }],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c1", type: "clip", media: "m-f", in: 0, duration: 60 }] }],
  } as unknown as Project;
  dir = writeProject(root, "Lut", project);
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), TMPDIR: join(root, "tmp") } });
  client = await connect(server.ready.port, server.ready.token);
  await client.ok("project.open", { dir });
});

after(async () => {
  if (skip) return;
  await killAll();
  rmSync(root, { recursive: true, force: true });
});

const middlePixel = (file: string) => [
  ...execFileSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "1",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "crop=8:8,scale=1:1:flags=area,format=rgb24",
    "-f",
    "rawvideo",
    "-",
  ]),
];

test("a .cube joins project.json, an effect.look draws it in the export, and a second import is one LUT", { skip, timeout: 120000 }, async () => {
  const jobs = client.subscribe("media.jobs");
  const finish = async () => {
    const { jobId } = await client.ok("media.import", { paths: [cubeFile] });
    await jobs.until((list: ReadonlyArray<{ id: string; phase: string }>) => list.some((j) => j.id === jobId && ["done", "failed"].includes(j.phase)), 30000);
    return jobs.values.at(-1)!.find((j: { id: string }) => j.id === jobId);
  };
  const job = await finish();
  const opened = await client.ok("project.open", { dir });
  const luts = (opened.project as Project).luts ?? [];
  assert.equal(luts.length, 1, JSON.stringify({ phase: job.phase, failed: job.failed }));
  assert.equal(luts[0]!.name, "Swap");
  await finish();
  assert.equal(((await client.ok("project.open", { dir })).project as Project).luts?.length, 1);
  assert.ok(readFileSync(join(dir, "project.json"), "utf8").includes(luts[0]!.id));

  const effects = [{ module: "effect.look", params: { look: luts[0]!.id, intensity: 1 } }];
  await client.ok("project.edit", { ops: [{ op: "update_item", item: "c1", set: { effects } }] });
  const exports = client.subscribe("export.jobs");
  const output = join(root, "out", "Graded.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "high", loudness: "off" });
  await exports.until((list: ReadonlyArray<{ id: string; phase: string }>) => list.some((j) => j.id === jobId && ["done", "failed"].includes(j.phase)), 90000);
  assert.equal(exports.values.at(-1)!.find((j: { id: string }) => j.id === jobId).phase, "done");

  const expected = colourFn(clipFx({ type: "clip", effects }, luts)!.colour!)(0xc0 / 255, 0x40 / 255, 0x20 / 255).map((v) => v * 255);
  const pixel = middlePixel(output);
  pixel.forEach((v, i) => assert.ok(Math.abs(v - expected[i]!) <= 4, `${pixel} vs ${expected}`));
});
