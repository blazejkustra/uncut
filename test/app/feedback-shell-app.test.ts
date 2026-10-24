// Feedback round 1 (planning/FEEDBACK.md, D115–D121) on the packaged app, run invisibly and muted:
// - S1/T4: the timeline spans the whole window; the rail and the left panel sit above it.
// - G5: the left panel, the inspector and the timeline resize by their edges, are remembered
//   after a restart, and a double click puts the default back.
// - S2: a long press on a rail tab and a drag moves it; the order is remembered.
// - G1: buttons and clips can't be selected as text; fields and the folder path can.
// - T5/T10: scrolled right, the track heads stay on top of the clips and the playhead; with many
//   tracks the timeline scrolls down while the ruler (with the playhead) stays.
// - G3: Space, J/K/L, ↑/↓ edit points, I/O marks, ⌘A + ⌫, ⌘C/⌘V, ⌘D, ⌘B, +/−, ? (not in a
//   field), Esc closes the sheet.
// - G6/G7b: preview zoom (200 %, ⌘ + wheel around the pointer) and the hand change only the view;
//   the full-screen preview fills the window and Esc leaves it.
// - G8: Settings (⌘,) changes the canvas to 9:16 and the background colour in one edit each.
// - K1: no Checks tab.
// Screenshots: test-output/feedback-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KeyInput, Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { settled, until } from "../helpers/wait.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `feedback-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
type Saved = { id: string; start?: number; duration: number; [k: string]: unknown };
type SavedProject = {
  canvas: { width: number; height: number; fps: number; background?: string };
  tracks: Array<{ id: string; kind: string; items: Array<Saved> }>;
};
const onDisk = (): SavedProject => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const allIds = () => onDisk().tracks.flatMap((t) => t.items.map((i) => i.id));
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) >= r,
    { timeout: 10000 },
    n,
  );
const playhead = () => page.$eval("[data-testid=playhead]", (el) => Number((el as HTMLElement).dataset.frame));
const rect = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const meta = async (key: KeyInput, shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
/** Focus off any field, onto the timeline (so editor keys apply). */
const focusTimeline = async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.click("[data-testid=bottom-timeline]");
};

async function launch() {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
}
async function quit() {
  await app?.close();
  app = undefined;
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-feedback-")));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30",
    "-t",
    "10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(root, "Shot.mp4"),
  ]);
  dir = join(root, "Feedback.uncut");
  mkdirSync(dir);
  // Enough text tracks that the timeline must scroll down (T10), and a long project (T5).
  const texts = Array.from({ length: 8 }, (_, i) => ({
    id: `text-${i + 1}`,
    kind: "text",
    name: `Text ${i + 1}`,
    items: [{ id: `t${i + 1}`, type: "text", start: 30 + i * 20, duration: 60, text: `Line ${i + 1}` }],
  }));
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Feedback",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [
        {
          id: "m-shot",
          kind: "video",
          name: "Shot.mp4",
          path: join(root, "Shot.mp4"),
          probe: { frames: 300, fps: 30, width: 640, height: 360, hasAudio: false },
        },
      ],
      tracks: [
        ...texts,
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: [
            { id: "a", type: "clip", media: "m-shot", in: 0, duration: 120 },
            { id: "b", type: "clip", media: "m-shot", in: 120, duration: 90 },
          ],
        },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
});
after(async () => {
  await quit();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "feedback round 1: layout, panels, rail, selection, sticky timeline, shortcuts, preview zoom, full screen, Settings",
  { skip, timeout: 300000 },
  async () => {
    await launch();
    try {
      const win = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));

      // K1: no Checks tab.
      assert.equal(await page.$("[data-testid=tab-checks]"), null);

      // S1/T4: the bottom panel spans the window; the rail ends above it.
      const bottom = await rect(".bottom");
      assert.ok(Math.abs(bottom.left) <= 1 && Math.abs(bottom.width - win.w) <= 1, `bottom ${bottom.left} ${bottom.width} of ${win.w}`);
      assert.ok((await rect(".rail")).bottom <= bottom.top + 1);
      assert.ok((await rect(".library")).bottom <= bottom.top + 1);
      await sleep(500);
      await page.screenshot({ path: out("layout") });

      // G1: no text selection on buttons, clips or tabs; fields and the folder path select.
      const select = (sel: string) => page.$eval(sel, (el) => getComputedStyle(el).userSelect);
      assert.equal(await select("[data-testid=rail-media]"), "none");
      assert.equal(await select("[data-testid=timeline-item][data-item=a]"), "none");
      assert.equal(await select("[data-testid=tab-inspector]"), "none");
      assert.equal(await select("[data-testid=inspector-name]"), "text");
      assert.equal(await select("[data-testid=project-dir]"), "text");

      // G5: drag the left panel's edge, the inspector's and the timeline's.
      const lib0 = (await rect(".library")).width;
      const side0 = (await rect(".side")).width;
      const bottom0 = (await rect(".bottom")).height;
      const dragHandle = async (sel: string, dx: number, dy: number) => {
        const r = await rect(sel);
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
        await page.mouse.move(x + dx, y + dy, { steps: 4 });
        await page.mouse.up();
      };
      await dragHandle("[data-testid=resize-lib]", 60, 0);
      await dragHandle("[data-testid=resize-side]", -40, 0);
      await dragHandle("[data-testid=resize-bottom]", 0, -50);
      await sleep(200);
      const lib1 = (await rect(".library")).width;
      const side1 = (await rect(".side")).width;
      const bottom1 = (await rect(".bottom")).height;
      assert.ok(Math.abs(lib1 - lib0 - 60) <= 3, `library ${lib0} → ${lib1}`);
      assert.ok(Math.abs(side1 - side0 - 40) <= 3, `inspector ${side0} → ${side1}`);
      assert.ok(Math.abs(bottom1 - bottom0 - 50) <= 3, `timeline ${bottom0} → ${bottom1}`);

      // S2: long-press Audio and drag it above Media.
      const audioTab = await rect("[data-testid=rail-audio]");
      const mediaTab = await rect("[data-testid=rail-media]");
      await page.mouse.move(audioTab.left + audioTab.width / 2, audioTab.top + audioTab.height / 2);
      await page.mouse.down();
      await sleep(500);
      await page.mouse.move(mediaTab.left + mediaTab.width / 2, mediaTab.top + 4, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=rail]")!.dataset.order!.startsWith("audio,media"), { timeout: 5000 });
      // A short click still just switches tabs.
      await page.click("[data-testid=rail-text]");
      await waitFor("[data-testid=rail-text].active");

      // Restart: the sizes and the order are remembered.
      await quit();
      await launch();
      assert.ok(Math.abs((await rect(".library")).width - lib1) <= 2, "library width remembered");
      assert.ok(Math.abs((await rect(".side")).width - side1) <= 2, "inspector width remembered");
      assert.ok(Math.abs((await rect(".bottom")).height - bottom1) <= 2, "timeline height remembered");
      assert.ok((await page.$eval("[data-testid=rail]", (el) => (el as HTMLElement).dataset.order!)).startsWith("audio,media"), "rail order remembered");
      // Double click: the default again.
      const handle = await rect("[data-testid=resize-lib]");
      await page.mouse.click(handle.left + handle.width / 2, handle.top + handle.height / 2, { clickCount: 2 });
      await page.waitForFunction((w) => Math.abs(document.querySelector(".library")!.getBoundingClientRect().width - w) <= 2, { timeout: 5000 }, lib0);

      // T10: many tracks: scrolled down, the ruler and the playhead's handle stay, the heads scroll with their rows.
      const ruler0 = await rect("[data-testid=ruler]");
      const head0 = await rect("[data-testid=track][data-id=text-1]");
      await page.$eval(".bottom-body", (el) => (el.scrollTop = 200));
      await sleep(200);
      const scrolled = await page.$eval(".bottom-body", (el) => el.scrollTop);
      assert.ok(scrolled > 50, `the timeline scrolls down (${scrolled})`);
      const ruler1 = await rect("[data-testid=ruler]");
      assert.ok(Math.abs(ruler1.top - ruler0.top) <= 1, "the ruler stays at the top");
      assert.ok(Math.abs((await rect("[data-testid=playhead]")).top - ruler0.top) <= 1, "the playhead stays with the ruler");
      assert.ok((await rect("[data-testid=track][data-id=text-1]")).top < head0.top - 50, "the heads scroll with their rows");
      await page.screenshot({ path: out("timeline-scrolled-down") });
      await page.$eval(".bottom-body", (el) => (el.scrollTop = 0));

      // T5: zoomed in and scrolled right, what's under the heads' column is a head, not a clip or the playhead.
      await focusTimeline();
      for (let i = 0; i < 4; i++) await meta("Equal");
      await page.keyboard.press("End");
      await page.$eval(".bottom-body", (el) => (el.scrollLeft = 400));
      await sleep(200);
      const main = await rect("[data-testid=track][data-id=text-1]");
      const hits = await page.evaluate(
        (x: number, ys: Array<number>) =>
          ys.map((y) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest(".tl-heads, .clip, .playhead, .tr-marker")?.className ?? "none"),
        main.left + main.width - 20,
        [main.top + main.height / 2, (await rect("[data-testid=ruler]")).top + 20],
      );
      assert.deepEqual(
        hits.map((h) => h.split(" ")[0]),
        ["tl-heads", "tl-heads"],
        `under the heads: ${hits}`,
      );
      await page.screenshot({ path: out("timeline-scrolled-right") });
      await meta("Digit0");
      await page.$eval(".bottom-body", (el) => (el.scrollLeft = 0));

      // G3: shortcuts.
      await focusTimeline();
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=playhead]")!.dataset.frame === "30");
      await page.keyboard.press("ArrowDown");
      assert.equal(await playhead(), 50, "the next start");
      await page.keyboard.press("ArrowUp");
      assert.equal(await playhead(), 30);
      await page.keyboard.press("KeyI");
      await page.keyboard.down("Shift");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.up("Shift");
      assert.equal(await playhead(), 60);
      await page.keyboard.press("KeyO");
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=marks]")?.dataset.out === "60");
      assert.equal(await page.$eval("[data-testid=marks]", (el) => (el as HTMLElement).dataset.in), "30");
      // L plays, L again faster, K stops; J plays backwards.
      await page.keyboard.press("KeyL");
      await page.keyboard.press("KeyL");
      await sleep(500);
      await page.keyboard.press("KeyK");
      const afterL = await playhead();
      assert.ok(afterL > 70, `L L moved forward fast (${afterL})`);
      await page.keyboard.press("KeyJ");
      await sleep(400);
      await page.keyboard.press("KeyK");
      assert.ok((await playhead()) < afterL, "J played backwards");
      await page.keyboard.press("Space");
      await page
        .waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.playing === "true", { timeout: 10000 })
        .catch(() => {});
      assert.equal(await page.$eval("[data-testid=preview-frame]", (el) => (el as HTMLElement).dataset.playing), "true", "Space plays");
      await page.keyboard.press("Space");

      // ⌘C on a text item, ⌘V at the playhead: a copy there, in one edit, selected.
      await page.click('[data-testid=timeline-item][data-item="t1"]');
      await meta("KeyC");
      await page.keyboard.press("End");
      let rev = await revision();
      await meta("KeyV");
      await waitRevision(rev + 1);
      const pasted = allIds().filter((id) => /^t1-\d+$/.test(id));
      assert.equal(pasted.length, 1, `pasted ${allIds()}`);
      await waitFor(`[data-testid=timeline-item][data-item="${pasted[0]}"].selected`);
      // ⌘D duplicates the selection right after it.
      rev = await revision();
      await meta("KeyD");
      await waitRevision(rev + 1);
      assert.equal(allIds().filter((id) => /^t1-\d+$/.test(id)).length, 2);
      // ⌘B splits the main clip under the playhead.
      await page.keyboard.press("Escape");
      rev = await revision();
      await page.keyboard.press("Home");
      await page.keyboard.down("Shift");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.up("Shift");
      await meta("KeyB");
      await waitRevision(rev + 1);
      assert.equal(onDisk().tracks.find((t) => t.id === "main")!.items.length, 3);
      // ⌘A selects everything; ⌫ deletes it all in one edit; ⌘Z brings it back.
      const before = allIds().length;
      await meta("KeyA");
      await page.waitForFunction((n) => document.querySelectorAll("[data-testid=timeline-item].selected").length === n, { timeout: 5000 }, before);
      rev = await revision();
      await page.keyboard.press("Backspace");
      await waitRevision(rev + 1);
      assert.equal(allIds().length, 0);
      await meta("KeyZ");
      await waitRevision(rev + 2);
      assert.equal(allIds().length, before);
      // + and − zoom the timeline.
      const ppf0 = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
      await page.keyboard.press("Equal");
      assert.ok((await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf))) > ppf0);
      await page.keyboard.press("Minus");
      // ? opens the shortcuts sheet, Esc closes it; ? typed in a field is just text.
      await page.keyboard.type("?");
      await waitFor("[data-testid=shortcuts-sheet]");
      assert.ok((await page.$$("[data-testid=shortcut-row]")).length >= 15);
      await page.screenshot({ path: out("shortcuts") });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-testid=shortcuts-sheet]"));
      await page.keyboard.press("Escape");
      await page.click("[data-testid=inspector-name]");
      await page.keyboard.type("?");
      await sleep(200);
      assert.equal(await page.$("[data-testid=shortcuts-sheet]"), null);
      await page.keyboard.press("Escape");

      // G6: preview zoom and pan change only the view.
      rev = await revision();
      const fit = await rect("[data-testid=preview-frame]");
      await page.select("[data-testid=preview-zoom]", "2");
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=stage-canvas]")!.dataset.zoom === "2.000");
      const z2 = await rect("[data-testid=preview-frame]");
      assert.equal(Math.round(z2.width), 3840);
      // ⌘ + wheel zooms around the pointer and isn't the window's page zoom.
      await page.select("[data-testid=preview-zoom]", "fit");
      const area = await rect("[data-testid=stage-canvas]");
      await page.mouse.move(area.left + area.width * 0.7, area.top + area.height / 2);
      await page.keyboard.down("Meta");
      await page.mouse.wheel({ deltaY: -300 });
      await page.keyboard.up("Meta");
      // #89: the view re-renders after the wheel and pointer events (not within them), so wait for
      // the frame to get there (and stop moving) instead of reading it once after a fixed sleep.
      const frameLeft = async () => (await rect("[data-testid=preview-frame]")).left;
      const panTo = async (x: number, what: string) => {
        await until(async () => Math.abs((await frameLeft()) - x) <= 2, `${what}: the frame's left edge at ${x}`, { timeout: 5000 });
        await settled(frameLeft, what);
        assert.ok(Math.abs((await frameLeft()) - x) <= 2, what);
      };
      const zoomed = await until(
        async () => {
          const r = await rect("[data-testid=preview-frame]");
          return r.width > fit.width * 1.3 && r;
        },
        `⌘ wheel zoomed from ${fit.width}`,
        { timeout: 5000 },
      );
      // A plain wheel pans when zoomed; the hand drags.
      const x0 = (await settled(() => rect("[data-testid=preview-frame]"), "the ⌘ wheel zoom")).left;
      assert.ok(zoomed.width > fit.width * 1.3);
      await page.mouse.wheel({ deltaX: 100 });
      await panTo(x0 - 100, "wheel pans");
      await page.click("[data-testid=preview-hand]");
      await page.waitForSelector("[data-testid=preview-hand][aria-pressed=true]");
      await page.mouse.move(area.left + 100, area.top + 100);
      await page.mouse.down();
      await page.mouse.move(area.left + 160, area.top + 130, { steps: 5 });
      await page.mouse.up();
      await panTo(x0 - 40, "hand pans");
      await page.screenshot({ path: out("preview-zoomed") });
      await page.click("[data-testid=preview-hand]");
      assert.equal(await revision(), rev, "zoom and pan never touch the project");
      await page.select("[data-testid=preview-zoom]", "fit");

      // G7b: full-screen preview; Esc leaves it.
      await page.click("[data-testid=preview-fullscreen]");
      await waitFor("[data-testid=stage][data-full=true]");
      const stage = await rect("[data-testid=stage]");
      assert.ok(stage.width >= win.w - 1 && stage.height >= win.h - 1, "the preview fills the window");
      await sleep(300);
      await page.screenshot({ path: out("fullscreen") });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-testid=stage][data-full=true]"));

      // G8: Settings (⌘,): Project › 9:16 and a background colour, one edit each; App and Shortcuts.
      await focusTimeline();
      await meta("Comma");
      await waitFor("[data-testid=settings-project]");
      rev = await revision();
      await page.click('[data-testid=settings] [data-testid=canvas-aspect-option][data-aspect="9:16"]');
      await waitRevision(rev + 1);
      assert.deepEqual([onDisk().canvas.width, onDisk().canvas.height], [1080, 1920]);
      assert.equal(await page.$eval("[data-testid=canvas-fps]", (el) => (el as HTMLSelectElement).disabled), true, "fps fixed while the timeline has items");
      await page.$eval("[data-testid=settings] [data-testid=canvas-background]", (el) => {
        const input = el as HTMLInputElement;
        // Through the native setter, so React sees a change.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#223344");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await waitRevision(rev + 2);
      assert.equal(onDisk().canvas.background, "#223344");
      await sleep(300);
      await page.screenshot({ path: out("settings-project") });
      await page.click("[data-testid=settings-nav-app]");
      await waitFor("[data-testid=app-settings]");
      await page.screenshot({ path: out("settings-app") });
      await page.click("[data-testid=settings-nav-shortcuts]");
      await waitFor("[data-testid=settings] [data-testid=shortcut-list]");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-testid=settings]"));
      assert.equal(await page.$eval("[data-testid=canvas-info]", (el) => el.textContent?.trim()), "1080×1920, 30 fps");
      await sleep(400);
      await page.screenshot({ path: out("editor") });
      assert.deepEqual(app!.errors, []);
    } catch (error) {
      await page.screenshot({ path: out("failure") }).catch(() => {});
      throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app?.output().slice(-4000)}` });
    }
  },
);
