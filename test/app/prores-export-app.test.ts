// ProRes masters in the packaged app: Advanced picks ProRes 4444 with a transparent background, the
// file name follows it to .mov, and what's saved has an alpha plane that a decode reads back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { exportProject, makeExportFixture, writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test media") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
const apps = new Set<LaunchedApp>();

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-prores-app-")));
  makeExportFixture(join(root, "media"));
  const p = exportProject(join(root, "media"));
  dir = writeProject(root, "Master", {
    ...p,
    tracks: p.tracks.filter((t) => t.id === "text" || t.id === "main").map((t) => (t.id === "main" ? { ...t, items: [] } : t)),
  });
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("export dialog: ProRes 4444 with a transparent background saves a .mov with alpha", { skip, timeout: 240000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") },
  });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=export-button]");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=export-advanced]");
  await page.click("[data-testid=export-codec-prores4444]");
  await page.click("[data-testid=export-alpha]");
  assert.equal(await page.$eval("[data-testid=export-name]", (el) => (el as HTMLInputElement).value), "Export test.mov");
  assert.equal(await page.$("[data-testid=export-encoder]"), null);
  assert.equal(await page.$("[data-testid=export-bitrate]"), null);
  await page.screenshot({ path: resolve("test-output", "prores-dialog.png") });

  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job][data-phase=done],[data-testid=export-job][data-phase=failed]", { timeout: 120000 });
  const job = await page.$eval("[data-testid=export-job]", (el) => ({
    phase: (el as HTMLElement).dataset.phase,
    output: (el as HTMLElement).dataset.output!,
    text: el.textContent ?? "",
  }));
  assert.equal(job.phase, "done", job.text);
  assert.match(job.text, /ProRes 4444.*transparent/);
  await page.screenshot({ path: resolve("test-output", "prores-done.png") });

  assert.match(job.output, /\.mov$/);
  const stream = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,pix_fmt", "-of", "csv=p=0", job.output],
    {
      encoding: "utf8",
    },
  );
  assert.match(stream, /prores,4444,yuva444p/);
  const alpha = execFileSync(
    "ffmpeg",
    ["-v", "error", "-ss", "0.5", "-i", job.output, "-frames:v", "1", "-vf", "alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
    {
      maxBuffer: 1 << 26,
    },
  );
  assert.equal(alpha[0], 0, "the corner is transparent");
  assert.ok(
    alpha.some((a) => a > 200),
    "the text is drawn",
  );
  rmSync(job.output, { force: true });
});
