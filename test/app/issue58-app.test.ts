// Issue #58 (D229) on the packaged app: a selection with a main clip moves together.
// - Red, green and blue 2 s clips on Main; green's sound is an audio item linked to it (D123).
// - Green and its sound are selected and dragged 0.5 s right: no refusal, green leaves a 0.5 s gap,
//   blue is pushed after it, the sound follows and stays linked, one edit.
// - Dragged on past blue's middle: green goes after blue, its sound under it.
// - ⌘Z undoes each move in one step.
// Screenshots: test-output/issue58-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test clips") : `packaged app not built: run pnpm dist to create ${APP}`;
const FPS = 30;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `issue58-${name}.png`);

type Saved = { id: string; start?: number; gap?: number; duration: number; linkedTo?: string };
const onDisk = (): { tracks: Array<{ id: string; role?: string; items: Array<Saved> }> } => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const mainItems = () => onDisk().tracks.find((t) => t.role === "main")!.items;
const mainIds = () => mainItems().map((i) => i.id);
const saved = (id: string) => mainItems().find((i) => i.id === id);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 10000 }, n);
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const itemSel = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const shown = (id: string) => page.$eval(itemSel(id), (el) => ({ start: Number((el as HTMLElement).dataset.start), duration: Number((el as HTMLElement).dataset.duration) }));
const box = async (selector: string) => {
  const b = await (await page.$(selector))?.boundingBox();
  assert.ok(b, `no box for ${selector}`);
  return b;
};
const withKeys = async (keys: ReadonlyArray<"Meta" | "Shift">, press: Parameters<Page["keyboard"]["press"]>[0]) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.keyboard.press(press);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};
/** Drag an item's middle by `frames` to the right with ⌘ held (no snapping; ⌘ at the press keeps the selection). */
async function dragItem(id: string, frames: number) {
  const b = await box(itemSel(id));
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const to = { x: from.x + frames * (await ppf()), y: from.y };
  await page.keyboard.down("Meta");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) / 3, from.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await sleep(120);
  // While dragging: no refusal (the old "Main clips move one at a time").
  const tip = await page.$eval("[data-testid=drag-tip]", (el) => ({ refused: (el as HTMLElement).dataset.refused, text: el.textContent ?? "" })).catch(() => undefined);
  await page.mouse.up();
  await page.keyboard.up("Meta");
  return tip;
}
const audioItem = (id: string) => onDisk().tracks.find((t) => t.id === "audio")!.items.find((i) => i.id === id);
const selectedIds = () => page.$$eval("[data-testid=timeline-item].selected", (els) => els.map((el) => (el as HTMLElement).dataset.item));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue58-")));
  // Three 2 s clips at 30 fps, each one colour with a tone; green's sound is a linked audio item (D123).
  const clip = (name: string, colour: string) =>
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=320x180:r=30:d=2`, "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, name)]);
  clip("red.mp4", "red");
  clip("green.mp4", "green");
  clip("blue.mp4", "blue");
  const probe = { frames: 60, fps: 30, width: 320, height: 180, hasAudio: true };
  dir = join(root, "Group.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Group",
      canvas: { width: 1280, height: 720, fps: FPS },
      media: ["red", "green", "blue"].map((c) => ({ id: `m-${c}`, kind: "video", name: `${c}.mp4`, path: join(root, `${c}.mp4`), probe })),
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: ["red", "green", "blue"].map((c) => ({ id: c, type: "clip", media: `m-${c}`, in: 0, duration: 60, ...(c === "green" ? { mute: true } : {}) })) },
        { id: "audio", kind: "audio", name: "Audio", items: [{ id: "mic", type: "audio", media: "m-green", in: 0, start: 60, duration: 60, linkedTo: "green" }] },
      ],
    }),
  );
  writeFileSync(join(root, "plan.json"), "[]");
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json") },
  });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(itemSel("mic"), { timeout: 15000 });
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue #58: a main clip and its linked sound selected together move as one, in order, the sound still linked; ⌘Z undoes it in one step", { skip, timeout: 120000 }, async () => {
  try {
    // ---- Select green, ⌘-click its sound: two selected ----
    await page.click(itemSel("green"));
    await page.keyboard.down("Meta");
    await page.click(itemSel("mic"));
    await page.keyboard.up("Meta");
    assert.deepEqual((await selectedIds()).sort(), ["green", "mic"]);

    // ---- Drag green 0.5 s right: it leaves a gap, blue is pushed, the sound follows, one edit ----
    let r = await revision();
    const tip = await dragItem("green", 15);
    assert.ok(tip && tip.refused !== "true", `the drag isn't refused: ${tip?.text}`);
    assert.doesNotMatch(tip!.text, /one at a time/);
    await waitRevision(r + 1);
    assert.deepEqual(mainIds(), ["red", "green", "blue"]);
    assert.deepEqual(await shown("green"), { start: 75, duration: 60 });
    assert.deepEqual(await shown("blue"), { start: 135, duration: 60 });
    assert.equal(saved("green")!.gap, 15);
    assert.equal(audioItem("mic")!.start, 75);
    assert.equal(audioItem("mic")!.linkedTo, "green", "the sound is still linked");
    await page.screenshot({ path: out("moved") });

    // ---- On right past blue's middle: green goes after blue (which stays), still with its sound ----
    r = await revision();
    await page.click(itemSel("green"));
    await page.keyboard.down("Meta");
    await page.click(itemSel("mic"));
    await page.keyboard.up("Meta");
    await dragItem("green", 70);
    await waitRevision(r + 1);
    assert.deepEqual(mainIds(), ["red", "blue", "green"]);
    assert.deepEqual(await shown("blue"), { start: 135, duration: 60 });
    assert.deepEqual(await shown("green"), { start: 195, duration: 60 });
    assert.equal(audioItem("mic")!.start, 195);
    assert.equal(audioItem("mic")!.linkedTo, "green");

    // ---- ⌘Z: one step back to the first move, another to the start ----
    r = await revision();
    await page.click("[data-testid=timeline]");
    await withKeys(["Meta"], "KeyZ");
    await waitRevision(r + 1);
    assert.deepEqual(mainIds(), ["red", "green", "blue"]);
    assert.equal(audioItem("mic")!.start, 75);
    await withKeys(["Meta"], "KeyZ");
    await waitRevision(r + 2);
    assert.deepEqual(await shown("green"), { start: 60, duration: 60 });
    assert.deepEqual(await shown("blue"), { start: 120, duration: 60 });
    assert.equal(audioItem("mic")!.start, 60);
    assert.equal(audioItem("mic")!.linkedTo, "green");
    await page.screenshot({ path: out("undone") });
    assert.deepEqual(app!.errors, []);
  } catch (error) {
    await page.screenshot({ path: out("failure") }).catch(() => {});
    throw error;
  }
});
