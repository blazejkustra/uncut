// Timeline v2 phase 2 (D347) on the packaged app: an old project's linkedTo pair opens as a link
// (one edit, one ⌘Z); ⌥-dragging the sound moves it alone and both show the out-of-sync badge;
// Move into sync puts it back; a plain drag of the sound takes its clip along; Unlink and Link
// in the item menu.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the talk") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const out = (name: string) => resolve("test-output", name);
const revision = (page: Page) => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));

async function savedAfter(page: Page, after: number) {
  await page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r,
    { timeout: 10000 },
    after,
  );
  return revision(page);
}

const box = async (page: Page, id: string) => (await (await page.$(`[data-testid=timeline-item][data-item="${id}"]`))!.boundingBox())!;

/** Drag an item by `dx` pixels from its middle, ⌥ held when `alone`. */
async function drag(page: Page, id: string, dx: number, alone = false) {
  const b = await box(page, id);
  const y = b.y + b.height / 2;
  const x = b.x + b.width / 2;
  if (alone) await page.keyboard.down("Alt");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
  if (alone) await page.keyboard.up("Alt");
}

async function menu(page: Page, id: string, entry: string) {
  await page.click(`[data-testid=timeline-item][data-item="${id}"]`, { button: "right" });
  await page.waitForSelector(`[data-testid=menu-${entry}]`, { timeout: 5000 });
  await page.click(`[data-testid=menu-${entry}]`);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-links-")));
  execFileSync("ffmpeg", [
    ...["-v", "error", "-y", "-threads", "2"],
    ...["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:d=6", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:d=6"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "Talk.mp4")],
  ]);
  const dir = join(root, "Old.uncut");
  mkdirSync(dir);
  const probe = { frames: 180, fps: 30, width: 320, height: 240, hasAudio: true };
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Old",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path: join(root, "Talk.mp4"), probe }],
      tracks: [
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "cam", type: "clip", media: "m-talk", in: 0, duration: 120, mute: true }] },
        {
          id: "audio",
          kind: "audio",
          name: "Audio",
          items: [{ id: "cam-sound", type: "audio", media: "m-talk", in: 0, start: 0, duration: 120, linkedTo: "cam" }],
        },
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

test(
  "timeline v2 phase 2: linkedTo opens as a link, ⌥ moves one side, the drift badge, Move into sync, Unlink and Link",
  { skip, timeout: 180000 },
  async () => {
    const dir = join(root, "Old.uncut");
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
    type Saved = { tracks: Array<{ id: string; items: Array<{ id: string; start?: number; gap?: number; link?: string; linkedTo?: string }> }> };
    const item = (id: string) =>
      (JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Saved).tracks.flatMap((t) => t.items).find((i) => i.id === id)!;

    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

    // Opening converted the legacy pair: both carry the same link, linkedTo is gone, and it's one edit.
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=saved]")?.title.includes("revision 1"), { timeout: 10000 });
    assert.ok(item("cam").link && item("cam").link === item("cam-sound").link, JSON.stringify([item("cam"), item("cam-sound")]));
    assert.equal(item("cam-sound").linkedTo, undefined);
    assert.equal(await page.$("[data-testid=link-drift]"), null, "in sync: no badge");

    // ⌥-drag the sound 30 px right: the clip stays, both show how far apart they are.
    const ppf = (await box(page, "cam")).width / 120;
    let rev = await revision(page);
    await drag(page, "cam-sound", Math.round(15 * ppf), true);
    rev = await savedAfter(page, rev);
    const moved = item("cam-sound").start!;
    assert.ok(moved > 0, `the sound moved (${moved})`);
    assert.equal(item("cam").gap, undefined, "the clip stayed");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=link-drift]").length === 2);
    const badges = await page.$$eval("[data-testid=link-drift]", (els) => els.map((e) => (e as HTMLElement).innerText.trim()).sort());
    assert.deepEqual(badges, [`+${moved}f`, `-${moved}f`]);

    // The menu offers Unlink and Move into sync; the screenshot shows the badge and the menu.
    await page.click('[data-testid=timeline-item][data-item="cam-sound"]', { button: "right" });
    await page.waitForSelector("[data-testid=menu-move-into-sync]");
    assert.ok(await page.$("[data-testid=menu-unlink]"));
    await page.screenshot({ path: out("timeline-v2-link-drift.png") });
    await page.click("[data-testid=menu-move-into-sync]");
    rev = await savedAfter(page, rev);
    assert.equal(item("cam-sound").start, 0);
    await page.waitForFunction(() => !document.querySelector("[data-testid=link-drift]"));

    // A plain drag of the sound takes its clip along on V1.
    await drag(page, "cam-sound", Math.round(20 * ppf));
    rev = await savedAfter(page, rev);
    const start = item("cam-sound").start!;
    assert.ok(start > 0);
    assert.equal(item("cam").gap, start, "the clip moved by as much");

    // Unlink, then the sound moves alone; Link the two again from a two-item selection.
    await menu(page, "cam-sound", "unlink");
    rev = await savedAfter(page, rev);
    assert.deepEqual([item("cam").link, item("cam-sound").link], [undefined, undefined]);
    await page.click('[data-testid=timeline-item][data-item="cam"]');
    await page.keyboard.down("Meta");
    await page.click('[data-testid=timeline-item][data-item="cam-sound"]');
    await page.keyboard.up("Meta");
    await menu(page, "cam-sound", "link");
    await savedAfter(page, rev);
    assert.ok(item("cam").link && item("cam").link === item("cam-sound").link);
  },
);
