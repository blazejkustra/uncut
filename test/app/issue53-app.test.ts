// Issue #53 on the packaged app, run invisibly: video clips on the timeline show a filmstrip, each
// cell the frame at its own time. A 20 s testsrc2 clip (a moving picture with a running clock) is
// on Main three times: whole (c1), from 10 s (c2) and at speed 2 (c3). c1's cells show different
// tiles in time order and different pictures; c2 starts on the 10 s tile; c3 covers twice the
// media of a same-length clip; zooming in gives c1 more cells; the server cached one sprite.
// Screenshots: test-output/issue53-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { rgbaOf } from "../helpers/image-compare.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SECONDS = 20;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const out = (name: string) => resolve("test-output", `issue53-${name}.png`);
const strip = (id: string) => `[data-testid=timeline-item][data-item="${id}"] [data-testid=filmstrip]`;
const tiles = (id: string) => page.$eval(strip(id), (el) => ((el as HTMLElement).dataset.tiles ?? "").split(",").filter(Boolean).map(Number));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue53-")));
  dir = join(root, "Film.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1280x720:rate=${FPS}`,
    "-t",
    String(SECONDS),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(root, "Long.mp4"),
  ]);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Film",
      canvas: { width: 1280, height: 720, fps: FPS },
      textLooks: 1,
      media: [
        {
          id: "m-long",
          kind: "video",
          name: "Long.mp4",
          path: join(root, "Long.mp4"),
          probe: { frames: SECONDS * FPS, fps: FPS, width: 1280, height: 720, hasAudio: false },
        },
      ],
      tracks: [
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: [
            { id: "c1", type: "clip", media: "m-long", in: 0, duration: SECONDS * FPS },
            { id: "c2", type: "clip", media: "m-long", in: 10 * FPS, duration: 5 * FPS },
            { id: "c3", type: "clip", media: "m-long", in: 0, duration: 5 * FPS, speed: 2 },
          ],
        },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue #53: video clips show a filmstrip that follows the clip's time, trims, speed and zoom", { skip, timeout: 120000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_PROXIES: "off" } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=bottom-timeline]");
  for (const id of ["c1", "c2", "c3"]) await page.waitForSelector(`${strip(id)}[data-ready=true]`, { timeout: 60000 });
  await page.screenshot({ path: out("timeline") });

  // c1 (the whole 20 s): many different tiles, in time order, from the start.
  const t1 = await tiles("c1");
  console.log(`# issue53 c1 tiles: ${t1.join(",")}`);
  assert.ok(t1.length >= 5, `cells drawn: ${t1.length}`);
  assert.ok(new Set(t1).size >= 5, `distinct tiles: ${t1.join(",")}`);
  assert.equal(t1[0], 0);
  assert.deepEqual(
    [...t1].sort((a, b) => a - b),
    t1,
    "in time order",
  );
  assert.ok(t1.at(-1)! >= 30, `the last cells are near the end: ${t1.at(-1)}`);

  // The pictures differ, not only the numbers: the first and the last cell, as drawn.
  const cells = await page.$$(`${strip("c1")} .film-cell`);
  await cells[0]!.screenshot({ path: out("c1-first-cell") });
  await cells.at(-2)!.screenshot({ path: out("c1-late-cell") });
  const a = rgbaOf(out("c1-first-cell"));
  const b = rgbaOf(out("c1-late-cell"));
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) if (i % 4 !== 3) sum += Math.abs(a[i]! - b[i]!);
  const meanDiff = sum / ((n * 3) / 4);
  console.log(`# issue53 first vs late cell mean |Δ| per channel: ${meanDiff.toFixed(2)}`);
  assert.ok(meanDiff > 4, `first and late cells look different (${meanDiff.toFixed(2)})`);

  // c2 (from 10 s): starts on the 10 s tile (interval 0.5 s → tile 20).
  const t2 = await tiles("c2");
  assert.equal(t2[0], 20, `c2 tiles: ${t2.join(",")}`);
  // c3 (speed 2, 5 s long): covers 10 s of media, twice what c2's 5 s cover.
  const t3 = await tiles("c3");
  const range = (t: Array<number>) => t.at(-1)! - t[0]!;
  console.log(`# issue53 c2 tiles: ${t2.join(",")}; c3 tiles: ${t3.join(",")}`);
  assert.equal(t3[0], 0);
  assert.ok(range(t3) >= range(t2) * 1.6, `speed 2 spans more media (${range(t3)} vs ${range(t2)})`);

  // Zoom in: c1's visible cells cover a shorter stretch of time each (more detail).
  const ppf0 = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const lanes = (await (await page.$("[data-testid=lanes]"))!.boundingBox())!;
  await page.mouse.move(lanes.x + 60, lanes.y + 20);
  await page.keyboard.down("Meta");
  for (let i = 0; i < 6; i++) await page.mouse.wheel({ deltaY: -120 });
  await page.keyboard.up("Meta");
  await page
    .waitForFunction((p) => Number(document.querySelector<HTMLElement>("[data-testid=timeline]")?.dataset.ppf) > p * 1.5, { timeout: 5000 }, ppf0)
    .catch(() => undefined);
  const ppf1 = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  if (ppf1 > ppf0 * 1.5) {
    await page.waitForFunction((sel) => (document.querySelector<HTMLElement>(sel)?.dataset.tiles ?? "").split(",").length > 2, { timeout: 5000 }, strip("c1"));
    const zoomed = await tiles("c1");
    console.log(`# issue53 zoomed ${(ppf1 / ppf0).toFixed(1)}x, c1 visible tiles: ${zoomed.join(",")}`);
    const step = (t: Array<number>) => range(t) / Math.max(1, t.length - 1);
    assert.ok(step(zoomed) < step(t1), `tiles per cell shrink when zoomed (${step(zoomed).toFixed(2)} vs ${step(t1).toFixed(2)})`);
    await page.screenshot({ path: out("zoomed") });
  } else console.log(`# issue53 zoom gesture didn't zoom (ppf ${ppf0} → ${ppf1}); zoom covered by test/media/filmstrip.test.ts`);

  // One sprite (and its layout) for the one file, though three clips use it.
  const cached = readdirSync(join(dir, ".cache", "filmstrips"));
  assert.equal(cached.length, 2, cached.join());
  assert.ok(cached.every((f) => /^m-long--[0-9a-f]{12}\.(jpg|json)$/.test(f)));
});
