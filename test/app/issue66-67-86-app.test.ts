// Issues #66, #67 and #86 on the packaged app, run invisibly (D239).
// #66: an overlay scrollbar under the error toast is drawn below it, never over it.
// #67: an error toast closes itself after a time that grows with its text, stays while hovered,
//      and keeps its close button.
// #86: the timeline toolbar and the preview transport icons show the app's tooltip with the
//      action's name and its keys from the keymap; no native title tip as well.
// Screenshots: test-output/issue66-67-86-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { toastMs } from "../../apps/web/src/ui/toast.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `issue66-67-86-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const rect = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const TOAST = "[data-testid=editor-error]";
const gone = (timeout: number) => page.waitForFunction((s) => !document.querySelector(s), { timeout }, TOAST);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue66-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "Shot.mp4")]);
  dir = join(root, "Issue66.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Issue66",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [{ id: "m-shot", kind: "video", name: "Shot.mp4", path: join(root, "Shot.mp4"), probe: { frames: 300, fps: 30, width: 640, height: 360, hasAudio: false } }],
      tracks: [
        // Locked, so splitting the title is refused with an error toast.
        { id: "text", kind: "text", name: "Text", locked: true, items: [{ id: "t1", type: "text", start: 0, duration: 120, text: "Launch day", transform: { x: 160, y: 440 }, style: { preset: "text.title", size: 140, weight: 700 } }] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "m-shot", in: 0, duration: 300 }] },
      ],
    }),
  );
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor(item("a"));
  await page.click("[data-testid=bottom-timeline]");
  // The playhead inside the title, so splitting it is refused for being locked.
  const ruler = await rect("[data-testid=ruler]");
  const lanes = await rect("[data-testid=lanes]");
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  await page.mouse.click(lanes.left + 45 * ppf, ruler.top + ruler.height - 6);
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) > 20, { timeout: 5000 });
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Splitting the locked title: refused with an error toast. Returns its text. */
const refuse = async () => {
  await page.mouse.move(5, 300);
  await page.click(item("t1"));
  await page.keyboard.press("s");
  await waitFor(TOAST);
  await page.waitForFunction((s) => /locked/i.test(document.querySelector(s)?.textContent ?? ""), {}, TOAST);
  return page.$eval(`${TOAST} .banner-text`, (el) => (el.textContent ?? "").trim());
};
const centre = async (selector: string) => {
  const r = await rect(selector);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

test("issue #67: the error toast closes itself, stays while hovered, keeps its close button", { skip, timeout: 120000 }, async () => {
  const text = await refuse();
  const ms = toastMs(text);
  assert.equal(await page.$eval(TOAST, (el) => Number((el as HTMLElement).dataset.autoClose)), ms, "the toast's time comes from its text");
  assert.ok(ms > 5000, `a full sentence stays more than the minimum (${ms} ms)`);
  assert.ok(await page.$(`${TOAST} button`), "the close button is there");
  await page.screenshot({ path: out("toast") });

  // Left alone, it closes after about `ms`, not long before.
  const t0 = Date.now();
  await gone(ms + 3000);
  const took = Date.now() - t0;
  assert.ok(took > ms - 1500, `closed after ${took} ms, expected about ${ms}`);

  // Hovered, it stays well past its time; let go, it closes.
  await refuse();
  const c = await centre(TOAST);
  await page.mouse.move(c.x, c.y);
  await page.waitForFunction((s) => document.querySelector<HTMLElement>(s)?.dataset.paused === "true", { timeout: 3000 }, TOAST);
  await sleep(ms + 1500);
  assert.ok(await page.$(TOAST), "still there while hovered");
  await page.screenshot({ path: out("toast-hovered") });
  await page.mouse.move(5, 300);
  await gone(ms + 3000);

  // The close button closes it at once.
  await refuse();
  await page.click(`${TOAST} button`);
  await gone(2000);
  assert.deepEqual(app!.errors, []);
});

test("issue #66: an overlay scrollbar under the error toast is drawn below it", { skip, timeout: 60000 }, async () => {
  await refuse();
  const toast = await rect(TOAST);
  // A scroll area with its right edge under the middle of the toast, like a panel (Effects) under it.
  await page.evaluate((t) => {
    const area = document.createElement("div");
    area.id = "t66-area";
    area.style.cssText = `position:fixed;left:${t.left}px;top:${t.top - 20}px;width:${t.width / 2}px;height:300px;overflow-y:auto;background:#222`;
    area.innerHTML = `<div style="height:480px"></div>`;
    document.querySelector(".app")!.append(area);
  }, toast);
  await page.mouse.move(toast.left + 20, toast.top + toast.height + 100);
  await page.evaluate(() => {
    document.getElementById("t66-area")!.scrollTop = 40;
  });
  // The area's own bar: the visible one along its right edge.
  const ours = () => {
    const a = document.getElementById("t66-area")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>("[data-testid=scrollbar][data-visible=true]")].find((b) => {
      const r = b.getBoundingClientRect();
      return Math.abs(r.right - a.right) < 2 && Math.abs(r.top - a.top) < 4;
    });
  };
  await page.waitForFunction(`(${ours.toString()})() !== undefined`, { timeout: 3000 });
  const thumb = await page.evaluate(`(${ours.toString()})().querySelector("[data-testid=scrollbar-thumb]").getBoundingClientRect().toJSON()`) as DOMRect;
  const y = toast.top + toast.height / 2;
  assert.ok(thumb.top <= y && thumb.bottom >= y, "the thumb crosses the toast");
  await page.screenshot({ path: out("scrollbar-under-toast"), clip: { x: toast.left - 10, y: toast.top - 30, width: toast.width + 20, height: toast.height + 120 } });
  // Hit-test with the bars made hittable: what's on top at the thumb, inside the toast, is the toast.
  const top = await page.evaluate(
    (x, yy, s) => {
      const style = document.createElement("style");
      style.textContent = ".overlay-scrollbars-layer, .overlay-scrollbar, .overlay-thumb { pointer-events: auto !important; }";
      document.head.append(style);
      const el = document.elementFromPoint(x, yy);
      style.remove();
      const stack = document.elementsFromPoint(x, yy).slice(0, 6).map((e) => `${e.tagName}.${String(e.className)} z=${getComputedStyle(e).zIndex}`).join(" | ");
      return { inToast: !!el?.closest(s), what: `${String(el?.className ?? "")} [${stack}] x=${x} y=${yy}` };
    },
    thumb.left + thumb.width / 2,
    y,
    TOAST,
  );
  assert.ok(top.inToast, `the toast is on top of the scrollbar (got ${String(top.what)})`);
  await page.evaluate(() => document.getElementById("t66-area")!.remove());
  await page.click(`${TOAST} button`);
  await gone(2000);
});

test("issue #86: toolbar and transport icons show the tooltip with the name and the keymap's keys", { skip, timeout: 120000 }, async () => {
  // Keys as editor/keys.ts SHORTCUTS and timeline/tools.ts TOOLS list them.
  const expected: Array<[string, RegExp, string[]]> = [
    ["tool-select", /^Select/, ["V"]],
    ["tool-blade", /^Blade/, ["C"]],
    ["tool-hand", /^Hand/, ["H"]],
    ["split", /^Split at the playhead$/, ["S", "⌘B"]],
    ["delete-item", /^Delete the selected item$/, ["⌫"]],
    ["snap-toggle", /^Snapping/, []],
    ["link-overlays", /linked/i, []],
    ["zoom-out", /^Zoom out$/, ["−"]],
    ["zoom-in", /^Zoom in$/, ["+"]],
    ["zoom-fit", /^Fit the project$/, ["⌘0"]],
    ["to-start", /^Go to start$/, ["Home"]],
    ["step-back", /^Back one frame$/, ["←"]],
    ["play", /^Play$/, ["Space"]],
    ["step-forward", /^Forward one frame$/, ["→"]],
    ["to-end", /^Go to end$/, ["End"]],
    ["preview-hand", /^Hand/, []],
    ["preview-fullscreen", /^Full screen preview$/, []],
  ];
  await page.keyboard.press("Escape");
  for (const [id, label, keys] of expected) {
    const sel = `[data-testid=${id}]`;
    assert.equal(await page.$eval(sel, (el) => el.getAttribute("title")), null, `${id}: no native title tip`);
    await page.mouse.move(5, 300);
    await page.waitForFunction(() => !document.querySelector("[data-testid=tooltip]"), { timeout: 3000 });
    await sleep(700);
    const c = await centre(sel);
    await page.mouse.move(c.x, c.y);
    await waitFor("[data-testid=tooltip]", 3000).catch(() => assert.fail(`${id}: no tooltip`));
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=tooltip]")!.getBoundingClientRect().top >= 0, { timeout: 2000 });
    const tip = await page.$eval("[data-testid=tooltip]", (el) => ({
      label: (el.querySelector(".tooltip-label")?.textContent ?? "").trim(),
      keys: [...el.querySelectorAll("kbd")].map((k) => k.textContent ?? ""),
      r: el.getBoundingClientRect().toJSON() as DOMRect,
    }));
    assert.match(tip.label, label, `${id}: label`);
    assert.deepEqual(tip.keys, keys, `${id}: keys`);
    assert.ok(tip.r.left >= 0 && tip.r.right <= (await page.evaluate(() => window.innerWidth)), `${id}: inside the window`);
    assert.equal(await page.$eval(sel, (el) => el.getAttribute("aria-label")), tip.label, `${id}: the tip names the control`);
    if (id === "split" || id === "play") await sleep(250);
    if (id === "split") await page.screenshot({ path: out("tooltip-split") });
    if (id === "play") await page.screenshot({ path: out("tooltip-play") });
  }
  // A press hides it.
  await page.mouse.move(5, 300);
  await sleep(700);
  const z = await centre("[data-testid=zoom-in]");
  await page.mouse.move(z.x, z.y);
  await waitFor("[data-testid=tooltip]", 3000);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector("[data-testid=tooltip]"), { timeout: 2000 });
  assert.deepEqual(app!.errors, []);
});
