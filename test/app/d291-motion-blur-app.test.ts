// D291 on the packaged app: the Export dialog's Motion blur switch for a project with a graphic.
// - The Motion section shows (only) when the project has graphics: on at Standard and High, off at
//   Draft, and the switch overrides it.
// - Exported with it on, then off (60 fps, 2.5 s, past nothing but the frame count): both have every
//   frame; the job's summary says "motion blur"; the fast-moving square is smeared with it (more
//   partly lit pixels along its path) and sharp without it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

const W = 540;
const H = 676;
const FRAMES = 150;
let root = "";
let dir = "";
const apps = new Set<LaunchedApp>();
const out = (name: string) => resolve("test-output", name);
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const checked = (page: Page) => page.$eval("[data-testid=export-motion-blur]", (el) => (el as HTMLInputElement).checked);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-motion-blur-app-")));
  const project = {
    format: "uncut/0",
    name: "Motion",
    canvas: { width: W, height: H, fps: 60 },
    media: [],
    tracks: [
      { id: "gfx", kind: "video", name: "Graphics", items: [{ id: "square", type: "graphic", src: "graphics/square.html", start: 0, duration: FRAMES }] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: FRAMES, props: { color: "#000000" } }] },
    ],
  } as unknown as Project;
  dir = writeProject(root, "Motion", project);
  mkdirSync(join(dir, "graphics"));
  // A white square crossing the canvas 30 px a frame.
  writeFileSync(join(dir, "graphics", "square.html"), `<canvas id="c" width="${W}" height="${H}"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
window.render = (t, info) => { ctx.clearRect(0, 0, ${W}, ${H}); ctx.fillStyle = "#fff"; ctx.fillRect((t * info.fps * 30) % ${W}, 300, 60, 60); };
</script>`);
  mkdirSync(join(root, "out"));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Partly lit pixels in the square's row at frame `f` (a smear has many, a sharp square almost none). */
function partly(file: string, f: number): number {
  const rows = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${f}),crop=${W}:2:0:330,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"]);
  return [...rows.subarray(0, W)].filter((v) => v > 40 && v < 215).length;
}

/** Export at High with blur on or off, saved where the save panel (UNCUT_TEST_DIALOG) says: `file`. */
async function exportOnce(page: Page, file: string, blur: boolean) {
  await page.click("[data-testid=export-button]");
  // After an export the dialog opens on it: Export again for the form.
  await waitFor(page, "[data-testid=export-form], [data-testid=export-again]");
  if (await page.$("[data-testid=export-again]")) await page.click("[data-testid=export-again]");
  await waitFor(page, "[data-testid=export-form]");
  await page.click("[data-testid=quality-high]");
  if ((await checked(page)) !== blur) await page.click("[data-testid=export-motion-blur]");
  assert.equal(await checked(page), blur);
  await page.click("[data-testid=export-change]");
  await page.waitForFunction((name) => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === name, {}, file.slice(file.lastIndexOf("/") + 1));
  await page.click("[data-testid=loudness-off]");
  if (blur) await page.screenshot({ path: out("d291-export-dialog.png") });
  await page.click("[data-testid=export-start]");
  await waitFor(page, "[data-testid=export-job]");
  await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")!.dataset.phase ?? ""), { timeout: 180000 });
  const text = await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? "");
  assert.equal(await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase), "done", text);
  if (blur) {
    assert.match(text, /60 fps.*motion blur/);
    await page.screenshot({ path: out("d291-export-done.png") });
  } else assert.doesNotMatch(text, /motion blur/);
  await page.click("[data-testid=export-done]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"));
}

test("Export dialog: Motion blur on by default (not at Draft), the exports smeared with it and sharp without", { skip, timeout: 420000 }, async () => {
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, join(root, "out", "blurred.mp4"), join(root, "out", "sharp.mp4")]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=editor]");
  await page.click("[data-testid=timeline]");
  await page.click("[data-testid=export-button]");
  await waitFor(page, "[data-testid=export-form]");
  await waitFor(page, "[data-testid=export-motion]");
  assert.match(await page.$eval("[data-testid=export-motion]", (el) => el.textContent ?? ""), /4 sub-frames a frame, a 90° shutter/);
  assert.equal(await checked(page), true, "on at Standard");
  await page.click("[data-testid=quality-draft]");
  assert.equal(await checked(page), false, "off at Draft");
  await page.click("[data-testid=quality-high]");
  assert.equal(await checked(page), true, "on at High");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"));

  const [blurred, sharp] = [join(root, "out", "blurred.mp4"), join(root, "out", "sharp.mp4")];
  await exportOnce(page, blurred, true);
  await exportOnce(page, sharp, false);
  assert.ok(existsSync(blurred) && existsSync(sharp));
  for (const f of [blurred, sharp]) {
    const n = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,r_frame_rate", "-of", "csv=p=0", f], { encoding: "utf8" }).trim();
    assert.equal(n, `60/1,${FRAMES}`, `${f}: every frame at 60 fps`);
  }
  for (const f of [20, 75]) {
    const [b, s] = [partly(blurred, f), partly(sharp, f)];
    console.log(`  frame ${f}: partly lit pixels in the square's row: ${b} blurred, ${s} sharp`);
    assert.ok(b >= 15 && s <= 6, `frame ${f}: blurred ${b}, sharp ${s}`);
  }
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", blurred, "-vf", "select=eq(n\\,20)", "-frames:v", "1", "-update", "1", out("d291-blurred-frame.png")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", sharp, "-vf", "select=eq(n\\,20)", "-frames:v", "1", "-update", "1", out("d291-sharp-frame.png")]);
  assert.deepEqual(app.errors, []);
  await app.close();
  apps.delete(app);
});
