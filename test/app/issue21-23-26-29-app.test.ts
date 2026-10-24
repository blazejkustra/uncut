// Issues #21, #23, #26 and #29 (D209) on the packaged app, run invisibly, with the stand-in claude:
// - #21: dragging an Inspector number field's label scrubs it (one step a pixel, ⇧ ten), the
//   preview follows while it drags and nothing is saved until the release; the release is one
//   edit (one ⌘Z); a click still focuses for typing; ⇧↑ steps by ten.
// - #26: a plain drag moves a rail tab (a line shows where it lands); right-click: Move up, Hide,
//   Reset order; hidden tabs are in More.
// - #29: scroll areas have no gutter; a thin bar shows over the content while scrolling or
//   hovering, can be dragged, and fades; the timeline's horizontal one too.
// - #23: the provider menu and the model menu show each provider's mark and name (#50: the real marks),
//   model rows with NEW and ⌘1 to ⌘4, and ⌘2 picks the second model.
// Screenshots: test-output/issue21-scrub.png, issue26-drag.png, issue26-more.png,
// issue29-scrollbar.png, issue29-timeline.png, issue23-provider.png, issue23-models.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { eventually } from "../helpers/wait.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { makeClipMedia, PATTERN_PROBE } from "../helpers/clip-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: resolve("test-output", `${name}.png`) });

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue21-29-")));
  makeClipMedia(join(root, "media"));
  dir = writeProject(root, "Scrub", {
    format: "uncut/0",
    name: "Scrub",
    canvas: { width: 1280, height: 720, fps: 30, background: "#808080" },
    media: [{ id: "m-pattern", kind: "video", name: "Pattern.mp4", path: join(root, "media", "Pattern.mp4"), probe: PATTERN_PROBE }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [] },
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [{ id: "left", type: "clip", media: "m-pattern", in: 0, duration: 240, transform: { x: 100, y: 50, w: 640, h: 360 } }],
      },
    ],
  } as never);
  writeFileSync(join(root, "plan.json"), "[]");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issues 21, 23, 26, 29: scrubbing number fields, the rail's drag and menu, overlay scrollbars, provider marks", { skip, timeout: 300000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json") },
  });
  apps.add(app);
  const { page } = app;
  const box = async (sel: string) => (await (await page.$(sel))!.boundingBox())!;
  const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const x = () => onDisk().tracks.find((t: { id: string }) => t.id === "main").items[0].transform.x as number;
  const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
  const waitRevision = (n: number) =>
    page.waitForFunction(
      (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r,
      { timeout: 10000 },
      n,
    );
  const field = () => page.$eval("[data-testid=insp-box-x]", (el) => (el as HTMLInputElement).value);
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await page.waitForSelector("[data-testid=editor]");

    // ---- #21: scrub X by its label ----
    const item = await box('[data-testid=timeline-item][data-item="left"]');
    await page.mouse.click(item.x + item.width - 12, item.y + item.height / 2);
    await page.click("[data-testid=tab-inspector]").catch(() => {});
    await page.waitForSelector('[data-testid=inspector-item][data-item="left"] [data-testid=clip-box-editor]');
    const rev0 = await revision();
    const video0 = await box('video[data-item="left"]');
    const label = await box("[data-scrub=insp-box-x] .k");
    await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
    await page.mouse.down();
    await page.mouse.move(label.x + label.width / 2 + 40, label.y + label.height / 2, { steps: 10 });
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=insp-box-x]")!.value === "140");
    // Mid-drag: the preview moved, nothing saved yet.
    await page.waitForFunction((left) => document.querySelector('video[data-item="left"]')!.getBoundingClientRect().x > left + 1, { timeout: 5000 }, video0.x);
    assert.equal(x(), 100, "not saved while dragging");
    assert.equal(await revision(), rev0);
    assert.equal(await page.$eval("[data-testid=insp-box-x]", (el) => el === document.activeElement), false, "a drag doesn't focus the field");
    await shot(page, "issue21-scrub");
    await page.mouse.up();
    await waitRevision(rev0 + 1);
    assert.equal(x(), 140);
    // ⇧ is ten a pixel.
    await page.keyboard.down("Shift");
    await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
    await page.mouse.down();
    await page.mouse.move(label.x + label.width / 2 + 6, label.y + label.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await waitRevision(rev0 + 2);
    assert.equal(x(), 200);
    // One ⌘Z takes a whole drag back.
    await page.click("[data-testid=timeline]");
    await page.keyboard.down("Meta");
    await page.keyboard.press("z");
    await page.keyboard.up("Meta");
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=insp-box-x]")!.value === "140");
    assert.equal(x(), 140);
    // A click focuses it for typing; ⇧↑ steps by ten; Enter saves.
    await page.click("[data-testid=insp-box-x]");
    assert.equal(await page.$eval("[data-testid=insp-box-x]", (el) => el === document.activeElement), true);
    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.up("Shift");
    assert.equal(await field(), "150");
    const rev1 = await revision();
    await page.keyboard.press("Enter");
    await waitRevision(rev1 + 1);
    assert.equal(x(), 150);

    // ---- #26: a plain drag moves Brand above Media, with a drop line ----
    const brand = await box("[data-testid=rail-brand]");
    const media = await box("[data-testid=rail-media]");
    await page.mouse.move(brand.x + brand.width / 2, brand.y + brand.height / 2);
    await page.mouse.down();
    await page.mouse.move(media.x + media.width / 2, media.y + 6, { steps: 12 });
    await page.waitForSelector("[data-testid=rail] .drop-before[data-rail=media]", { timeout: 3000 });
    await shot(page, "issue26-drag");
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=rail]")!.dataset.order!.startsWith("brand,media"));
    assert.equal(await page.$eval("[data-testid=rail-brand]", (el) => el.classList.contains("active")), false, "a drag doesn't switch tabs");
    await page.click("[data-testid=rail-text]");
    await page.waitForSelector("[data-testid=rail-text].active");
    // Right-click: Move up, Move down, Hide, Reset order.
    const textTab = await box("[data-testid=rail-text]");
    await page.mouse.click(textTab.x + textTab.width / 2, textTab.y + textTab.height / 2, { button: "right" });
    await page.waitForSelector("[data-testid=context-menu]");
    for (const id of ["rail-up", "rail-down", "rail-hide", "rail-reset"]) assert.ok(await page.$(`[data-testid=menu-${id}]`), id);
    await page.click("[data-testid=menu-rail-up]");
    await page.waitForFunction(() => /,text,transcript,/.test(document.querySelector<HTMLElement>("[data-testid=rail]")!.dataset.order!));
    await page.mouse.click(textTab.x + textTab.width / 2, textTab.y - 10, { button: "right" });
    await page.waitForSelector("[data-testid=menu-rail-hide]");
    await page.click("[data-testid=menu-rail-hide]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=rail-text]") && !!document.querySelector("[data-testid=rail-more]"));
    assert.equal(await page.$eval("[data-testid=rail]", (el) => (el as HTMLElement).dataset.hidden), "text");
    await page.click("[data-testid=rail-media]");
    await page.click("[data-testid=rail-more]");
    await page.waitForSelector("[data-testid=menu-rail-open-text]");
    await shot(page, "issue26-more");
    await page.click("[data-testid=menu-rail-open-text]");
    await page.waitForSelector("[data-testid=rail-more].active");
    // Reset order brings the default order and the hidden tab back.
    const mediaTab = await box("[data-testid=rail-media]");
    await page.mouse.click(mediaTab.x + mediaTab.width / 2, mediaTab.y + mediaTab.height / 2, { button: "right" });
    await page.click("[data-testid=menu-rail-reset]");
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>("[data-testid=rail]")!.dataset.order!.startsWith("media,transcript,text") &&
        !document.querySelector("[data-testid=rail-more]"),
    );

    // ---- #29: overlay scrollbars ----
    await page.click("[data-testid=rail-sfx]");
    await page.waitForSelector("[data-testid=library-source]");
    await page.select("[data-testid=library-source]", "pack");
    await page.waitForSelector("[data-testid=sfx-included]");
    await page.waitForFunction(
      () => {
        const lib = document.querySelector(".library");
        const all = lib ? [lib, ...lib.querySelectorAll<HTMLElement>("*")] : [];
        const hit = all.find((el) => {
          const s = getComputedStyle(el);
          return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 40;
        });
        if (hit) (hit as HTMLElement).dataset.testScroll = "1";
        return !!hit;
      },
      { timeout: 15000 },
    );
    const area = (await page.$("[data-test-scroll]"))!;
    const gutter = await area.evaluate((el) => {
      const s = getComputedStyle(el as HTMLElement);
      return (el as HTMLElement).offsetWidth - (el as HTMLElement).clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
    });
    assert.equal(gutter, 0, "the scroll area keeps its whole width (no scrollbar gutter)");
    const areaBox = await area.evaluate((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.mouse.move(areaBox.x + areaBox.width / 2, areaBox.y + areaBox.height / 2);
    await page.mouse.wheel({ deltaY: 300 });
    // The bar of this area: over its right edge (others, like the Inspector's, may show too).
    const areaBar = () =>
      page.evaluate((a) => {
        for (const t of document.querySelectorAll<HTMLElement>("[data-testid=scrollbar][data-axis=y][data-visible=true] [data-testid=scrollbar-thumb]")) {
          const r = t.getBoundingClientRect();
          if (r.x >= a.x + a.width - 12 && r.x + r.width <= a.x + a.width + 1) return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return null;
      }, areaBox);
    await page.waitForFunction(
      (a) =>
        [...document.querySelectorAll<HTMLElement>("[data-testid=scrollbar][data-axis=y][data-visible=true] [data-testid=scrollbar-thumb]")].some(
          (t) => Math.abs(t.getBoundingClientRect().right - (a.x + a.width)) < 12,
        ),
      { timeout: 5000 },
      areaBox,
    );
    const bar = (await areaBar())!;
    assert.ok(
      bar.width <= 9 && bar.x + bar.width <= areaBox.x + areaBox.width + 1 && bar.x >= areaBox.x + areaBox.width - 12,
      `a thin bar over the area's right edge: ${JSON.stringify(bar)}`,
    );
    await shot(page, "issue29-scrollbar");
    // Dragging the thumb scrolls the area.
    // The wheel scrolls smoothly: let it settle, then take the thumb where it is now.
    let settled = -1;
    for (let i = 0; i < 20; i++) {
      const now = await area.evaluate((el) => (el as HTMLElement).scrollTop);
      if (now === settled) break;
      settled = now;
      await sleep(100);
    }
    await page.mouse.move(areaBox.x + areaBox.width / 2, areaBox.y + areaBox.height / 2);
    const thumb = (await areaBar())!;
    const top0 = await area.evaluate((el) => (el as HTMLElement).scrollTop);
    assert.ok(top0 > 30, `the wheel scrolled it: ${top0}`);
    // Up, back towards the top (the wheel may have reached the end).
    // The thumb takes the pointer once it has rested there.
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
    await page.waitForSelector("[data-testid=scrollbar-thumb][data-armed]", { timeout: 3000 });
    await page.mouse.down();
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 - 60, { steps: 6 });
    await page.mouse.up();
    const top1 = await area.evaluate((el) => (el as HTMLElement).scrollTop);
    assert.ok(top1 < top0 - 20, `the thumb drags the list: ${top0} → ${top1}`);
    // Away from it, it fades.
    const stage = await box("[data-testid=preview-frame]");
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await eventually(async () => !(await areaBar()));
    assert.equal(await areaBar(), null, "the bar fades once the pointer has left");
    // The timeline's horizontal bar.
    await page.click("[data-testid=timeline]");
    for (let i = 0; i < 6; i++) await page.keyboard.press("=");
    // The middle of the part that shows: zoomed in, the timeline itself is far wider than the window.
    const tl = await box(".bottom-body");
    await page.mouse.move(tl.x + tl.width / 2, tl.y + tl.height / 2);
    await page.mouse.wheel({ deltaX: 200 });
    await page.waitForSelector("[data-testid=scrollbar][data-axis=x][data-visible=true]", { timeout: 5000 });
    await shot(page, "issue29-timeline");

    // ---- #23: provider and model marks ----
    await page.click("[data-testid=tab-agent]");
    await page.waitForSelector("[data-testid=agent-provider]");
    assert.equal(await page.$eval("[data-testid=agent-provider] [data-testid=provider-mark]", (el) => (el as HTMLElement).dataset.provider), "claude");
    await page.click("[data-testid=agent-provider]");
    await page.waitForSelector("[data-testid=agent-provider-menu]");
    assert.deepEqual(await page.$$eval("[data-testid=agent-provider-menu] [data-testid=provider-wordmark]", (els) => els.map((e) => e.textContent)), [
      "Claude",
      "Codex",
    ]);
    // #50 superseded D209's no-logo rule: the real marks (issue50-app.test.ts checks them closely).
    assert.deepEqual(
      await page.$$eval("[data-testid=agent-provider-menu] [data-testid=provider-mark] svg.provider-logo", (els) =>
        els.map((e) => (e.parentElement as HTMLElement).dataset.provider),
      ),
      ["claude", "codex"],
    );
    await shot(page, "issue23-provider");
    await page.click("[data-testid=agent-provider]");
    await page.click("[data-testid=agent-model]");
    await page.waitForSelector("[data-testid=agent-model-menu] [data-testid=agent-model-rail]");
    assert.equal(await page.$$eval("[data-testid=agent-model-option] [data-testid=provider-mark]", (els) => els.length), 5);
    assert.deepEqual(await page.$$eval("[data-testid=agent-model-option]", (els) => els.map((e) => !!e.querySelector("[data-testid=agent-model-new]"))), [
      false,
      true,
      true,
      false,
      true,
    ]);
    assert.deepEqual(await page.$$eval("[data-testid=agent-model-key]", (els) => els.map((e) => e.textContent)), ["⌘1", "⌘2", "⌘3", "⌘4"]);
    await shot(page, "issue23-models");
    await page.keyboard.down("Meta");
    await page.keyboard.press("2");
    await page.keyboard.up("Meta");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-model]")!.dataset.model === "claude-sonnet-5-5");
    assert.equal(await page.$("[data-testid=agent-model-menu]"), null, "the menu closes");
    assert.ok(!/[·•∙⋅*]/.test(await page.$eval(".composer-choices", (el) => (el as HTMLElement).innerText)), "no dots or stars between words");
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await shot(page, "issue21-29-failure").catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
