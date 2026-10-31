// D290 on the packaged app (background window): a graphic that draws the project's own video
// (await uncut.frame("m-clip", 0.5 + t)) and a still by marker (<img src="uncut:media/m-still">).
// In the editor's preview its sandboxed iframe asks the editor for the pictures (postMessage), the
// editor fetches them from the server's graphic-media route; the export (⌘E, Standard) gets them
// through the rasteriser. The preview at two moments is the export's frame (SSIM ≥ 0.97) and the
// two moments differ (the footage plays inside the graphic). No errors in the app.
// Screenshots: test-output/d290-app-{preview,export}-{f}.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test media") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

const GRAPHIC = `<style>#still { position: absolute; right: 40px; top: 40px; width: 320px; height: 180px; }</style>
<canvas id="c" width="1280" height="720"></canvas>
<img id="still" src="uncut:media/m-still">
<script>
const ctx = document.getElementById("c").getContext("2d");
window.render = async (t, info) => {
  const frame = await uncut.frame("m-clip", 0.5 + t, { width: info.width });
  ctx.drawImage(frame, 0, 0, info.width, info.height);
};
</script>`;

function project(media: string): Project {
  return {
    format: "uncut/0",
    name: "Graphic media",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [
      {
        id: "m-clip",
        kind: "video",
        name: "Clip.mp4",
        path: join(media, "Clip.mp4"),
        probe: { frames: 150, fps: 30, width: 1280, height: 720, hasAudio: false },
      },
      { id: "m-still", kind: "image", name: "Still.png", path: join(media, "Still.png"), probe: { width: 320, height: 180 } },
    ],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src: "graphics/footage.html", duration: 90 }] }],
  } as Project;
}

const meta = async (key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
async function goTo(frame: number) {
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".pv-graphic iframe")!).opacity === "1", { timeout: 30000 });
  // The graphic asks for its picture and draws it: give it the round trip.
  await sleep(1500);
}
const ssim = (a: string, b: string) => {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-d290-app-")));
  const media = join(root, "media");
  mkdirSync(media);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=1280x720:r=30",
    "-t",
    "5",
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
    "16",
    join(media, "Clip.mp4"),
  ]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "smptebars=s=320x180", "-frames:v", "1", join(media, "Still.png")]);
  dir = writeProject(root, "GraphicMedia", project(media));
  mkdirSync(join(dir, "graphics"));
  writeFileSync(join(dir, "graphics", "footage.html"), GRAPHIC);
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a graphic drawing the project's video and a still: the editor's preview is the export", { skip, timeout: 300000 }, async () => {
  const saveAs = join(root, "out", "GraphicMedia.mp4");
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") },
  });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.waitForSelector('.pv-graphic[data-item="g"] iframe', { timeout: 15000 });

  const shots = new Map<number, string>();
  for (const f of [10, 50]) {
    await goTo(f);
    const path = out(`d290-app-preview-${f}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    shots.set(f, path);
  }
  const moved = ssim(shots.get(10)!, shots.get(50)!);
  assert.ok(moved < 0.97, `the footage plays inside the graphic (frames 10 and 50: SSIM ${moved})`);

  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "GraphicMedia.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 1800 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  for (const f of [10, 50]) {
    const exported = out(`d290-app-export-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(shots.get(f)!, exported);
    console.log(`  frame ${f}: export vs preview SSIM ${score.toFixed(4)}`);
    check(NO_REAL_GPU, score >= 0.97, `frame ${f}: SSIM ${score}`);
  }
  assert.deepEqual(app.errors, []);
});
