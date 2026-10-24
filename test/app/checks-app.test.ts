// Phase 6 chunk 8 (D90, D91) on the packaged app, run invisibly and muted:
// - K1 (D121): the Checks tab and the export dialog's checks line are gone; the checks stay in
//   core (projectChecks) and with the agent (project_check); Export is never blocked;
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { projectChecks, type Project } from "../../packages/core/src/index.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-checks-")));
  // 8 s of silent test footage, portrait.
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=540x676:rate=30",
    "-t",
    "8",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(root, "Shot.mp4"),
  ]);
  const dir = join(root, "Taste.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Taste",
      canvas: { width: 1080, height: 1350, fps: 30 },
      textLooks: 1,
      media: [
        {
          id: "m-shot",
          kind: "video",
          name: "Shot.mp4",
          path: join(root, "Shot.mp4"),
          probe: { frames: 240, fps: 30, width: 540, height: 676, hasAudio: false },
        },
      ],
      tracks: [
        {
          id: "text",
          kind: "text",
          name: "Text",
          items: [
            {
              id: "title",
              type: "text",
              start: 60,
              duration: 30,
              text: "We built it seven times.",
              transform: { x: 90, y: 300 },
              style: { preset: "text.title", size: 88 },
            },
            {
              id: "langs",
              type: "text",
              start: 150,
              duration: 90,
              text: "Swift · Kotlin · Dart",
              transform: { x: 90, y: 900 },
              style: { preset: "text.header", size: 56 },
            },
          ],
        },
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: [{ id: "clip-1", type: "clip", media: "m-shot", in: 0, duration: 240, animation: { in: { module: "move.fade", duration: 15 } } }],
        },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "plan.json"), JSON.stringify([[{ text: "Noted." }]]));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("no Checks tab or export checks line (K1)", { skip, timeout: 300000 }, async () => {
  const dir = join(root, "Taste.uncut");
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
    },
  });
  apps.add(app);
  const { page } = app;
  const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");

    // K1 (D121): no Checks tab and no checks line in the export dialog; the project still has
    // warnings (core projectChecks, what the agent's project_check returns) and Export isn't blocked.
    const warnings = projectChecks(onDisk()).filter((c) => c.severity === "warn");
    for (const id of ["trailing-period", "dot-separators", "text-read-time", "frame-one"])
      assert.ok(
        warnings.some((c) => c.id === id),
        id,
      );
    assert.equal(await page.$("[data-testid=tab-checks]"), null);
    assert.equal(await page.$("[data-testid=checks-count]"), null);
    await page.click("[data-testid=export-button]");
    await waitFor(page, "[data-testid=export-form]");
    assert.equal(await page.$("[data-testid=export-checks]"), null);
    assert.equal(await page.$eval("[data-testid=export-start]", (el) => (el as HTMLButtonElement).disabled), false);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"), { timeout: 5000 });
  } finally {
    await app.close();
    apps.delete(app);
  }
});
