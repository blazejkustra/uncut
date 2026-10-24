// Issue #51 (D224) on the packaged app: the main track keeps gaps.
// - Three 2 s clips on Main (red, green, blue, each with a tone). The blue one is dragged from 4 s
//   to 5 s (⌘ held: no snapping): it stays there, a 1 s gap before it.
// - The middle (green) clip is deleted with ⌫: the gap stays, blue is still at 5 s; ⌘Z brings
//   green back, ⇧⌘Z deletes it again.
// - The preview in the gap is black.
// - The export: red 0–2 s, black and silent in the gap (2–5 s), blue with its tone from 5 s.
// - ⇧⌫ (ripple delete) on red closes up: blue moves left by red's length, the gap before it stays.
// Screenshots: test-output/issue51-*.png.
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
const out = (name: string) => resolve("test-output", `issue51-${name}.png`);

type Saved = { id: string; start?: number; gap?: number; duration: number };
const onDisk = (): { tracks: Array<{ id: string; role?: string; items: Array<Saved> }> } => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const mainItems = () => onDisk().tracks.find((t) => t.role === "main")!.items;
const mainIds = () => mainItems().map((i) => i.id);
const saved = (id: string) => mainItems().find((i) => i.id === id);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r,
    { timeout: 10000 },
    n,
  );
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const itemSel = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const shown = (id: string) =>
  page.$eval(itemSel(id), (el) => ({ start: Number((el as HTMLElement).dataset.start), duration: Number((el as HTMLElement).dataset.duration) }));
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
/** Drag an item's middle by `frames` to the right with ⌘ held (no snapping). */
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
  await page.mouse.up();
  await page.keyboard.up("Meta");
}
/** Seek by keyboard: Home, then ⇧→ for whole seconds and → for frames; then wait for the videos. */
async function goTo(frame: number) {
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / FPS); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % FPS; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)),
    { timeout: 10000 },
  );
  await sleep(250);
}
/** Average colour of the middle quarter of a PNG (or of one video frame), [r, g, b]. */
const colourOf = (args: ReadonlyArray<string>) => [
  ...execFileSync("ffmpeg", ["-v", "error", ...args, "-vf", "crop=iw/4:ih/4,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]),
];
const isBlack = ([r, g, b]: Array<number>) => r! < 24 && g! < 24 && b! < 24;
const isRed = ([r, g, b]: Array<number>) => r! > 150 && g! < 90 && b! < 90;
const isBlue = ([r, g, b]: Array<number>) => b! > 150 && r! < 90 && g! < 90;
/** max_volume (dB) of the export's sound between two times, -Infinity when silent. */
function maxVolume(file: string, from: number, to: number): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(from), "-to", String(to), "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], {
    encoding: "utf8",
  });
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
  assert.ok(m, `no volumedetect in ${r.stderr.slice(-400)}`);
  return m[1] === "-inf" ? -Infinity : Number(m[1]);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue51-")));
  // Three 2 s clips at 30 fps, each one colour with a 440 Hz tone.
  const clip = (name: string, colour: string) =>
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${colour}:s=320x180:r=30:d=2`,
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:sample_rate=48000:d=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      join(root, name),
    ]);
  clip("red.mp4", "red");
  clip("green.mp4", "green");
  clip("blue.mp4", "blue");
  const probe = { frames: 60, fps: 30, width: 320, height: 180, hasAudio: true };
  dir = join(root, "Gaps.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Gaps",
      canvas: { width: 1280, height: 720, fps: FPS },
      media: ["red", "green", "blue"].map((c) => ({ id: `m-${c}`, kind: "video", name: `${c}.mp4`, path: join(root, `${c}.mp4`), probe })),
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: ["red", "green", "blue"].map((c) => ({ id: c, type: "clip", media: `m-${c}`, in: 0, duration: 60 })),
        },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
  writeFileSync(join(root, "plan.json"), "[]");
  mkdirSync(join(root, "out"));
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir, join(root, "out", "gaps.mp4")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
    },
  });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(itemSel("blue"), { timeout: 15000 });
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "issue #51: a main clip dragged to 5 s stays there; deleting the middle clip leaves the gap; the gap exports black and silent; ripple delete closes up",
  { skip, timeout: 240000 },
  async () => {
    try {
      // ---- Drag blue (4 s) to 5 s: a 1 s gap before it ----
      let r = await revision();
      await dragItem("blue", 30);
      await waitRevision(r + 1);
      assert.deepEqual(mainIds(), ["red", "green", "blue"]);
      assert.deepEqual(await shown("blue"), { start: 150, duration: 60 });
      assert.equal(saved("blue")!.gap, 30);
      assert.equal(saved("blue")!.start, undefined, "main items still have no start");
      await page.screenshot({ path: out("dragged") });

      // ---- Delete the middle clip: the gap stays (blue still at 5 s) ----
      r = await revision();
      await page.click(itemSel("green"));
      await page.keyboard.press("Backspace");
      await waitRevision(r + 1);
      assert.deepEqual(mainIds(), ["red", "blue"]);
      assert.deepEqual(await shown("blue"), { start: 150, duration: 60 });
      assert.equal(saved("blue")!.gap, 90);
      await page.screenshot({ path: out("deleted") });
      // ⌘Z brings green back in one step; ⇧⌘Z deletes it again.
      r = await revision();
      await page.click("[data-testid=timeline]");
      await withKeys(["Meta"], "KeyZ");
      await waitRevision(r + 1);
      assert.deepEqual(mainIds(), ["red", "green", "blue"]);
      assert.deepEqual(await shown("blue"), { start: 150, duration: 60 });
      await withKeys(["Meta", "Shift"], "KeyZ");
      await waitRevision(r + 2);
      assert.deepEqual(mainIds(), ["red", "blue"]);
      assert.deepEqual(await shown("blue"), { start: 150, duration: 60 });

      // ---- The preview: red, black in the gap, blue ----
      const preview = async (frame: number, name: string) => {
        await goTo(frame);
        const path = out(`preview-${name}`);
        await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
        return colourOf(["-i", path]);
      };
      assert.ok(isRed(await preview(30, "red")), "red at 1 s");
      const gap = await preview(100, "gap");
      assert.ok(isBlack(gap), `black in the gap: ${gap}`);
      assert.ok(isBlue(await preview(180, "blue")), "blue at 6 s");

      // ---- Export: the gap is black and silent ----
      const file = join(root, "out", "gaps.mp4");
      await page.keyboard.down("Meta");
      await page.keyboard.press("e");
      await page.keyboard.up("Meta");
      await page.waitForSelector("[data-testid=export-form]", { timeout: 15000 });
      await page.click("[data-testid=loudness-off]");
      await page.click("[data-testid=export-change]");
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "gaps.mp4");
      await page.click("[data-testid=export-start]");
      await page.waitForSelector("[data-testid=export-job]", { timeout: 15000 });
      await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")?.dataset.phase ?? ""), {
        timeout: 120000,
      });
      assert.equal(
        await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase),
        "done",
        await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""),
      );
      assert.ok(existsSync(file));
      const exported = (f: number) => {
        const path = out(`export-${f}`);
        execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", path]);
        return colourOf(["-i", path]);
      };
      assert.ok(isRed(exported(30)), "export: red at 1 s");
      for (const f of [70, 100, 140]) assert.ok(isBlack(exported(f)), `export: black at frame ${f}: ${exported(f)}`);
      assert.ok(isBlue(exported(180)), "export: blue at 6 s");
      const loud = maxVolume(file, 0.3, 1.7);
      const quiet = maxVolume(file, 2.3, 4.7);
      const after = maxVolume(file, 5.3, 6.7);
      console.log(`export sound: red ${loud} dB, gap ${quiet} dB, blue ${after} dB`);
      assert.ok(loud > -30, `red's tone is heard (${loud} dB)`);
      assert.ok(quiet < -60, `the gap is silent (${quiet} dB)`);
      assert.ok(after > -30, `blue's tone is heard (${after} dB)`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"));

      // ---- ⇧⌫ ripple delete on red: blue moves left by red's 2 s, the gap before it stays ----
      r = await revision();
      await page.click(itemSel("red"));
      await withKeys(["Shift"], "Backspace");
      await waitRevision(r + 1);
      assert.deepEqual(mainIds(), ["blue"]);
      assert.deepEqual(await shown("blue"), { start: 90, duration: 60 });
      await page.screenshot({ path: out("ripple") });
      assert.deepEqual(app!.errors, []);
    } catch (error) {
      await page.screenshot({ path: out("failure") }).catch(() => {});
      throw error;
    }
  },
);
