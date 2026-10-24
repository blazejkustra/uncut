// Fable QA round 2, the Text chunk (F21, F22, F24; D163–D166) on the packaged app, run invisibly
// and muted, with real pointer and key events:
// - F21: the Animation tab's In list has the new moves, the Out list their out names, Loop pulse
//   and wiggle; typewriter in, blur out and a pulse loop saved in project.json.
// - F22: the Elements tab's sticker search finds an emoji and a drawn sticker and adds them; the
//   image frame's fit switches to contain and its crop zoom saves.
// - F24: a caption style from the gallery (karaoke) saved on the captions item with word mode; the
//   default caption style in Settings › App is remembered.
// Screenshots: test-output/fable2-text-*.png, fable2-stickers-*.png, fable2-captions-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `fable2-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
type Saved = {
  id: string;
  type: string;
  component?: string;
  mode?: string;
  name?: string;
  props?: Record<string, unknown>;
  style?: Record<string, unknown>;
  animation?: Record<string, { module: string; duration: number; params?: Record<string, unknown> }>;
};
type SavedProject = { tracks: Array<{ id: string; items: Array<Saved> }> };
const onDisk = (): SavedProject => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const itemOnDisk = (id: string) =>
  onDisk()
    .tracks.flatMap((t) => t.items)
    .find((i) => i.id === id);
const items = () => onDisk().tracks.flatMap((t) => t.items);
const until = async (check: () => boolean, what: string, timeout = 10000) => {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const rect = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const xOf = async (frame: number) => (await rect("[data-testid=lanes]")).left + frame * (await ppf());
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const seek = async (frame: number) => {
  const ruler = await rect("[data-testid=ruler]");
  await page.mouse.click(await xOf(frame), ruler.top + ruler.height - 6);
  await page.waitForFunction(
    (f) => Math.abs(Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) - f) <= 1,
    { timeout: 5000 },
    frame,
  );
};
const rail = (id: string) => page.$eval(`[data-testid=rail-${id}]`, (el) => (el as HTMLElement).click());
const select = async (selector: string, value: string) => {
  await page.select(selector, value);
  await sleep(150);
};
const optionTexts = (selector: string) => page.$eval(selector, (el) => [...(el as HTMLSelectElement).options].map((o) => o.textContent ?? ""));
/** Screenshot of one element (the Inspector, a panel). */
const shot = async (selector: string, name: string) => {
  const el = await page.$(selector);
  assert.ok(el, selector);
  await el.screenshot({ path: out(name) });
};

// Words of the speech in the clip (seconds of the media): "Make it pop right now" over 0.5–2.5 s.
const WORDS = ["Make", "it", "pop", "right", "now"].map((text, i) => ({ text, start: 0.5 + i * 0.4, end: 0.8 + i * 0.4 }));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-fable2-text-")));
  const lavfi = (args: Array<string>, file: string) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args, join(root, file)]);
  lavfi(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
    ],
    "Talk.mp4",
  );
  lavfi(["-f", "lavfi", "-i", "testsrc2=size=600x400", "-frames:v", "1"], "Photo.png");
  dir = join(root, "Text.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Text",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [
        {
          id: "m-talk",
          kind: "video",
          name: "Talk.mp4",
          path: join(root, "Talk.mp4"),
          probe: { frames: 180, fps: 30, width: 640, height: 360, hasAudio: true },
        },
        { id: "m-photo", kind: "image", name: "Photo.png", path: join(root, "Photo.png"), probe: { width: 600, height: 400 } },
      ],
      tracks: [
        {
          id: "captions-track",
          kind: "text",
          name: "Captions",
          items: [
            {
              id: "captions-1",
              type: "captions",
              source: "m-talk",
              start: 0,
              duration: 180,
              coversMain: true,
              mode: "line",
              words: WORDS,
              style: { preset: "text.caption", size: 49, weight: 600 },
              transform: { x: 72, y: 864, w: 1776 },
            },
          ],
        },
        {
          id: "text",
          kind: "text",
          name: "Text",
          items: [
            {
              id: "t1",
              type: "text",
              start: 0,
              duration: 90,
              text: "Typewriter title",
              transform: { x: 160, y: 160 },
              style: { preset: "text.title", size: 110, weight: 700 },
            },
          ],
        },
        {
          id: "overlay",
          kind: "video",
          name: "Overlay",
          items: [
            {
              id: "frame-1",
              type: "component",
              component: "component.image-frame",
              start: 90,
              duration: 60,
              props: { image: { media: "m-photo" }, fit: "cover", radius: 24, border: "#FFFFFF", borderWidth: 0, shadow: true },
              transform: { x: 1000, y: 300, w: 800, h: 300 },
            },
          ],
        },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "m-talk", in: 0, duration: 180 }] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Fable QA round 2, text: new animations, stickers, image frame fit, caption styles", { skip, timeout: 300000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor(item("t1"));
  await page.click("[data-testid=bottom-timeline]").catch(() => {});

  // ---- F21: the Animation tab ----
  await page.click(item("t1"));
  await waitFor('[data-testid=inspector-item][data-item="t1"]');
  await page.click("[data-testid=insp-tab-animation]");
  await waitFor("[data-testid=insp-anim-in]");
  const ins = await optionTexts("[data-testid=insp-anim-in]");
  const outs = await optionTexts("[data-testid=insp-anim-out]");
  const loops = await optionTexts("[data-testid=insp-anim-loop]");
  for (const name of ["Typewriter", "Bounce", "Blur in", "Scale in", "Pop"]) assert.ok(ins.includes(name), `In has ${name}: ${ins.join(", ")}`);
  for (const name of ["Erase", "Bounce out", "Blur out", "Scale out", "Pop out"]) assert.ok(outs.includes(name), `Out has ${name}: ${outs.join(", ")}`);
  assert.ok(!outs.includes("Typewriter") && !outs.includes("Blur in"), "the Out list names them for leaving");
  assert.deepEqual(loops, ["None", "Pulse", "Wiggle"]);
  await select("[data-testid=insp-anim-in]", "move.typewriter");
  await until(() => itemOnDisk("t1")?.animation?.in?.module === "move.typewriter", "typewriter in saved");
  await select("[data-testid=insp-anim-out]", "move.blur");
  await until(() => itemOnDisk("t1")?.animation?.out?.module === "move.blur", "blur out saved");
  await select("[data-testid=insp-anim-loop]", "move.pulse");
  await until(() => itemOnDisk("t1")?.animation?.loop?.module === "move.pulse", "pulse loop saved");
  assert.equal(itemOnDisk("t1")!.animation!.loop!.duration, 30, "a loop every second by default");
  await waitFor("[data-testid=insp-anim-loop-amount]");
  await shot("[data-testid=text-animation]", "text-animation");
  // Mid typewriter: part of the title shows on the canvas.
  const typeFrames = itemOnDisk("t1")!.animation!.in!.duration;
  await seek(Math.round(typeFrames / 2));
  await sleep(300);
  const shown = await page.$eval('.pv-text[data-item="t1"]', (el) =>
    [...el.querySelectorAll("span")]
      .filter((s) => s.style.opacity === "0")
      .map((s) => s.textContent)
      .join(""),
  );
  assert.ok(shown.length > 0 && shown.length < "Typewriter title".length, `the rest of the title is hidden mid-move: "${shown}"`);
  await shot("[data-testid=preview-frame]", "text-typewriter");

  // ---- F22: stickers ----
  await rail("elements");
  await waitFor("[data-testid=sticker-search]");
  await page.click("[data-testid=sticker-search]");
  await page.keyboard.type("rocket");
  await page.waitForFunction(() => (document.querySelector("[data-testid=sticker]") as HTMLElement | null)?.dataset.key === "emoji:🚀", { timeout: 5000 });
  await shot("[data-testid=stickers]", "stickers-search");
  const before = items().length;
  await page.click('[data-testid=sticker][data-key="emoji:🚀"]');
  await until(() => items().some((i) => i.component === "component.sticker" && i.props?.emoji === "🚀"), "the rocket sticker saved");
  await page.click("[data-testid=sticker-search]", { clickCount: 3 });
  await page.keyboard.type("heart");
  await page.waitForSelector('[data-testid=sticker][data-key="art:heart"]', { timeout: 5000 });
  await page.click('[data-testid=sticker][data-key="art:heart"]');
  await until(() => items().some((i) => i.component === "component.sticker" && i.props?.art === "heart"), "the drawn heart saved");
  assert.equal(items().length, before + 2);
  assert.equal(items().find((i) => i.props?.art === "heart")!.name, "Heart");
  await sleep(400);
  await page.waitForSelector('.pv-comp [data-art="heart"] svg', { timeout: 5000 });
  await shot("[data-testid=preview-frame]", "stickers-added");

  // ---- F22: the image frame's fit and crop ----
  await page.click(item("frame-1"));
  await waitFor('[data-testid=component-editor][data-item="frame-1"]');
  await page.click('[data-testid=param-fit][data-value="contain"]');
  await until(() => itemOnDisk("frame-1")?.props?.fit === "contain", "fit contain saved");
  await seek(100);
  await page
    .waitForFunction(() => /contain/.test(document.querySelector<HTMLElement>('[data-item="frame-1"] img')?.style.objectFit ?? ""), { timeout: 10000 })
    .catch(() => {});
  assert.match(await page.$eval('[data-item="frame-1"] img', (el) => (el as HTMLElement).style.objectFit), /contain/);
  await shot("[data-testid=preview-frame]", "stickers-frame-contain");
  await page.click('[data-testid=param-fit][data-value="cover"]');
  await until(() => itemOnDisk("frame-1")?.props?.fit === "cover", "fit cover saved");
  const zoom = "input[data-testid=param-zoom]";
  await page.click(zoom, { clickCount: 3 });
  await page.keyboard.type("2");
  await page.keyboard.press("Enter");
  await until(() => itemOnDisk("frame-1")?.props?.zoom === 2, "crop zoom saved");
  await page
    .waitForFunction(() => /scale\(2\)/.test(document.querySelector<HTMLElement>('[data-item="frame-1"] img')?.style.transform ?? ""), { timeout: 10000 })
    .catch(() => {});
  assert.match(await page.$eval('[data-item="frame-1"] img', (el) => (el as HTMLElement).style.transform), /scale\(2\)/);
  await shot("[data-testid=inspector-item]", "stickers-frame-inspector");

  // ---- F24: caption styles ----
  await page.click(item("captions-1"));
  await waitFor('[data-testid=inspector-item][data-item="captions-1"] [data-testid=captions-editor]');
  await page.click("[data-testid=insp-tab-style]");
  await waitFor("[data-testid=cap-styles]");
  assert.equal((await page.$$("[data-testid=cap-style]")).length, 8);
  await page.click('[data-testid=cap-style][data-style="karaoke"]');
  await until(() => itemOnDisk("captions-1")?.style?.captionStyle === "karaoke", "karaoke saved");
  const cap = itemOnDisk("captions-1")!;
  assert.equal(cap.mode, "word");
  assert.equal(cap.style!.karaoke, true);
  assert.equal(cap.style!.accent, "#FFD23F");
  await page.waitForSelector('[data-testid=cap-style][data-style="karaoke"][aria-pressed="true"]');
  await page.waitForSelector('[data-testid=cap-fill][data-value="karaoke"].active');
  // Third word speaking (frame ~40): the words said so far are one accent run.
  await seek(40);
  await sleep(300);
  const filled = await page.$eval('.pv-text[data-item="captions-1"]', (el) => el.querySelector(".accent")?.textContent ?? "");
  assert.equal(filled, "Make it pop");
  await shot("[data-testid=preview-frame]", "captions-karaoke");
  await shot("[data-testid=inspector-item]", "captions-gallery");
  // The word box: on, then saved.
  await page.click("[data-testid=cap-box]");
  await until(() => typeof itemOnDisk("captions-1")?.style?.accentBox === "string", "word box saved");

  // ---- F30 part: the default caption style in Settings › App ----
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("Meta");
  await page.keyboard.press("Comma");
  await page.keyboard.up("Meta");
  await waitFor("[data-testid=settings]");
  await page.click("[data-testid=settings-nav-app]");
  await waitFor("[data-testid=settings-caption-style]");
  await select("[data-testid=settings-caption-style]", "big-yellow");
  assert.equal(await page.evaluate(() => localStorage.getItem("uncut.captions.style")), "big-yellow");
  await shot("[data-testid=settings]", "captions-settings");
  await select("[data-testid=settings-caption-style]", "");
  assert.equal(await page.evaluate(() => localStorage.getItem("uncut.captions.style")), null);
});
