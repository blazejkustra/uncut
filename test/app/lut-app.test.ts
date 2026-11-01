// A user LUT in the packaged app: imported from the Effects tab, put on a clip by hand, drawn by the
// preview and by the export. The two are compared on a clip of flat colour patches.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;
const SIZE = { width: 640, height: 360 };

let root = "";
let dir = "";
let cubePath = "";
const apps = new Set<LaunchedApp>();

/** Red and green swapped, blue halved: unmistakable, and not a look Uncut has. */
function writeCube(path: string) {
  const n = 17;
  const lines = ['TITLE "Swap test"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${g / (n - 1)} ${r / (n - 1)} ${(b / (n - 1)) * 0.5}`);
  writeFileSync(path, lines.join("\n"));
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-lut-app-")));
  cubePath = join(root, "Swap.cube");
  writeCube(cubePath);
  const clip = join(root, "patches.mp4");
  const patch = (c: string) => `color=c=${c}:s=320x180:r=30:d=3`;
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    patch("0xC04020"),
    "-f",
    "lavfi",
    "-i",
    patch("0x20A060"),
    "-f",
    "lavfi",
    "-i",
    patch("0x3050C0"),
    "-f",
    "lavfi",
    "-i",
    patch("0x808080"),
    "-filter_complex",
    "[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
    "-c:v",
    "libx264",
    "-crf",
    "12",
    clip,
  ]);
  const project = {
    format: "uncut/0",
    name: "LUT test",
    canvas: { ...SIZE, fps: 30 },
    media: [{ id: "m-p", kind: "video", name: "patches.mp4", path: clip, probe: { frames: 90, fps: 30, ...SIZE, hasAudio: false } }],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c1", type: "clip", media: "m-p", in: 0, duration: 90 }] }],
  } as unknown as Project;
  dir = writeProject(root, "Lut", project);
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The middle of each patch of an image file, as sRGB bytes. */
const patchesOf = (file: string, input: Array<string> = []) => {
  const raw = execFileSync("ffmpeg", [
    "-v",
    "error",
    ...input,
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "format=rgb24,scale=2:2:flags=area",
    "-f",
    "rawvideo",
    "-",
  ]);
  return [...raw];
};

test("a .cube imported by hand grades the clip, and the preview and the export match", { skip, timeout: 240000 }, async () => {
  const output = join(root, "graded.mp4");
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir, [cubePath], output]),
      UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts"),
    },
  });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click('[data-testid=timeline-item][data-item="c1"]');
  await page.click("[data-testid=rail-effects]");
  await page.waitForSelector("[data-testid=import-lut]");
  await page.click("[data-testid=import-lut]");
  await page.waitForSelector("[data-testid=filter-tile][title^='Swap test']", { timeout: 30000 });
  await page.click("[data-testid=filter-tile][title^='Swap test']");
  await page.waitForFunction(() => document.querySelector("[data-testid=filter-tile][data-active=true]")?.getAttribute("title")?.startsWith("Swap test"));
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: resolve("test-output", "lut-effects.png") });

  const saved = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Project;
  assert.equal(saved.luts?.length, 1, "the table is in project.json");
  const box = await page.$eval("[data-testid=preview-frame]", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const shot = join(root, "preview.png");
  await page.screenshot({ path: shot, clip: box });

  await page.click("[data-testid=export-button]");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "graded.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job][data-phase=done],[data-testid=export-job][data-phase=failed]", { timeout: 120000 });
  assert.equal(await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase), "done");

  const exported = patchesOf(output, ["-ss", "1"]);
  const preview = patchesOf(shot);
  console.log(`export ${exported.join(",")} preview ${preview.join(",")}`);
  const worst = Math.max(...exported.map((v, i) => Math.abs(v - preview[i]!)));
  assert.ok(worst <= 8, `preview and export differ by ${worst}`);
  assert.ok(exported[1]! > exported[0]!, "red and green swapped: the top left patch turned green");
});
