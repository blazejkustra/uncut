// #59 (D231) on the packaged app, in the background: the Transcript tab's redesign. With the left
// panel dragged to its narrowest, the tool rows (Fillers, Pauses over [x s], Captions) and
// their buttons lie inside the panel, and the Captions popover (the shared, window-clamped Popover)
// lies fully inside the window. The actions still work: the threshold changes the pause count, a
// selection shows its bar (Cut, clear), Remove fillers, Remove pauses and Make captions each edit.
// Screenshots: test-output/issue59-narrow.png, test-output/issue59-captions.png, test-output/issue59-selected.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { fingerprint, writeCached } from "../../apps/server/src/analysis/analysis.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : !FFMPEG ? "needs ffmpeg" : false;

// As in transcript-app: "um" is a hesitation, pauses of 0.5 s (lead-in), 1 s (after "test.") and 1 s (tail).
const WORDS = [
  { text: "Hello", start: 0.5, end: 1.0, p: 0.9 },
  { text: "um", start: 1.2, end: 1.5, p: 0.8 },
  { text: "this", start: 1.6, end: 2.0, p: 0.9 },
  { text: "is", start: 2.1, end: 2.3, p: 0.9 },
  { text: "a", start: 2.4, end: 2.5, p: 0.9 },
  { text: "test.", start: 2.6, end: 3.0, p: 0.9 },
  { text: "Second", start: 4.0, end: 4.5, p: 0.9 },
  { text: "part.", start: 4.6, end: 5.0, p: 0.9 },
];
const TRANSCRIPT = {
  hasAudio: true,
  seconds: 6,
  language: "en",
  requestedLanguage: "auto",
  model: "base",
  segments: [{ start: 0.5, end: 5, text: "Hello um this is a test. Second part.", words: [0, 8] }],
  words: WORDS,
};

let root = "";
let app: LaunchedApp | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (page: Page, id: string) => page.$eval(`[data-testid=${id}]`, (el) => Number((el as HTMLElement).dataset.count));
const rect = (page: Page, selector: string) =>
  page.$eval(
    selector,
    (el) => el.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number; width: number; height: number },
  );
const savedProject = (dir: string) => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const revision = async (page: Page) => Number(/revision (\d+)/.exec(await page.$eval("[data-testid=saved]", (el) => (el as HTMLElement).title))![1]);
const waitRevision = (page: Page, n: number) =>
  page.waitForFunction(
    (n: number) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")?.title ?? "")?.[1] ?? -1) >= n,
    { timeout: 15000 },
    n,
  );

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue59-")));
  mkdirSync(join(root, "projects"));
  execFileSync(FFMPEG!, [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=48000",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    join(root, "Talk.mp4"),
  ]);
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "Transcript tab (#59): tools and the Captions popover stay inside a narrow panel and the window; every action still works",
  { skip, timeout: 180000 },
  async () => {
    app = await launchApp({
      command: APP,
      env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects"), [join(root, "Talk.mp4")]]) },
    });
    const { page } = app;
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, join(root, "projects"));
    await page.click("[data-testid=create]");
    await page.waitForSelector("[data-testid=media-empty]", { timeout: 20000 });
    await page.click("[data-testid=import]");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 1, { timeout: 60000 });
    const dir = await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);
    await page.$eval("[data-testid=media-tile] [data-testid=add-to-timeline]", (el) => (el as HTMLElement).click());
    await page.waitForSelector("[data-testid=timeline-item][data-duration='180']", { timeout: 20000 });
    await writeCached(dir, await fingerprint(join(root, "Talk.mp4")), "transcript", TRANSCRIPT);

    await page.click("[data-testid=rail-transcript]");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word]").length === 8, { timeout: 15000 });

    // The left panel at its narrowest (180 px): drag its handle far to the left.
    const handle = await rect(page, "[data-testid=resize-lib]");
    await page.mouse.move(handle.left + handle.width / 2, handle.top + 200);
    await page.mouse.down();
    await page.mouse.move(handle.left - 400, handle.top + 200, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("[data-testid=transcript-panel]")!.getBoundingClientRect().width <= 190);
    await sleep(200);
    const panel = await rect(page, "[data-testid=transcript-panel]");
    for (const id of ["tx-tools", "remove-fillers", "pause-threshold", "remove-pauses", "make-captions"]) {
      const r = await rect(page, `[data-testid=${id}]`);
      assert.ok(
        r.width > 0 && r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5,
        `${id} inside the panel: ${JSON.stringify(r)} in ${JSON.stringify(panel)}`,
      );
    }
    // No tool row spills: each row's content fits its width.
    assert.deepEqual(
      await page.$$eval("[data-testid=tx-tools] .tx-tool", (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length),
      0,
      "no row overflows",
    );
    // "Pauses over [0.5 s]" reads as one control: the select on the label's line, even this narrow.
    const label = await rect(page, ".tx-pause-label");
    const select = await rect(page, "[data-testid=pause-threshold]");
    assert.ok(label.height <= select.height + 4, `the pause label is one line: ${JSON.stringify(label)}`);
    await page.screenshot({ path: "test-output/issue59-narrow.png" });

    // The Captions popover: fully inside the window, every control in it too.
    await page.click("[data-testid=make-captions]");
    await page.waitForSelector("[data-testid=captions-menu]");
    await sleep(100);
    const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    const inside = (r: { left: number; right: number; top: number; bottom: number }) => r.left >= 0 && r.top >= 0 && r.right <= win.w && r.bottom <= win.h;
    const menu = await rect(page, "[data-testid=captions-menu]");
    assert.ok(inside(menu), `the popover is inside the window: ${JSON.stringify(menu)} in ${JSON.stringify(win)}`);
    const parts = await page.$$eval("[data-testid=captions-menu] button, [data-testid=captions-menu] select", (els) =>
      els.map((e) => ({
        id: (e as HTMLElement).dataset.testid,
        text: e.textContent,
        ...e.getBoundingClientRect().toJSON(),
        clipped: e.scrollWidth > e.clientWidth + 1,
      })),
    );
    assert.equal(parts.length, 5, "three modes, the look and Make captions");
    for (const p of parts) {
      assert.ok(inside(p), `${p.id} inside the window`);
      assert.ok(p.left >= menu.left - 0.5 && p.right <= menu.right + 0.5, `${p.id} inside the popover`);
      if (p.id !== "captions-look") assert.equal(p.clipped, false, `${p.id} ("${p.text}") isn't cut off`);
    }
    assert.deepEqual(
      parts.slice(0, 3).map((p) => p.text),
      ["Line by line", "Word by word", "One word at a time"],
    );
    await page.click("[data-testid=captions-mode-word]");
    await page.waitForSelector("[data-testid=captions-mode-word].active");
    await page.screenshot({ path: "test-output/issue59-captions.png" });
    // Escape closes it; nothing was made.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=captions-menu]"));

    // The pause threshold, read as "Pauses over [x s]": 1 s leaves out the 0.5 s lead-in.
    assert.equal(await count(page, "remove-pauses"), 3);
    assert.equal(await count(page, "remove-fillers"), 1);
    await page.select("[data-testid=pause-threshold]", "1");
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=remove-pauses]")?.dataset.count) < 3);
    await page.select("[data-testid=pause-threshold]", "0.5");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=remove-pauses]")?.dataset.count === "3");

    // A selection: its bar says how many words, clear empties it, Cut cuts them as one edit.
    await page.click("[data-testid=tx-word][data-index='2']");
    await page.keyboard.down("Shift");
    await page.click("[data-testid=tx-word][data-index='3']");
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => document.querySelector("[data-testid=tx-status]")?.textContent === "2 words selected");
    const bar = await rect(page, "[data-testid=tx-cut]");
    assert.ok(bar.right <= panel.right + 0.5, "Cut is inside the panel");
    await page.screenshot({ path: "test-output/issue59-selected.png" });
    await page.click("[data-testid=tx-clear]");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word].sel").length === 0 && !document.querySelector("[data-testid=tx-cut]"));
    await page.click("[data-testid=tx-word][data-index='2']");
    await page.keyboard.down("Shift");
    await page.click("[data-testid=tx-word][data-index='3']");
    await page.keyboard.up("Shift");
    await page.waitForSelector("[data-testid=tx-cut]");
    let r = await revision(page);
    await page.click("[data-testid=tx-cut]");
    await waitRevision(page, r + 1);
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word]").length === 6);

    // Remove fillers: "um" goes.
    r = await revision(page);
    await page.click("[data-testid=remove-fillers]");
    await waitRevision(page, r + 1);
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=remove-fillers]")?.dataset.count === "0");
    assert.deepEqual(await page.$$eval("[data-testid=tx-word]", (els) => els.map((e) => e.textContent)), ["Hello", "a", "test.", "Second", "part."]);

    // Remove pauses: none left.
    r = await revision(page);
    await page.click("[data-testid=remove-pauses]");
    await waitRevision(page, r + 1);
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=remove-pauses]")?.dataset.count === "0");

    // Make captions, word by word, as one edit; the button then offers to remake them.
    r = await revision(page);
    await page.click("[data-testid=make-captions]");
    await page.waitForSelector("[data-testid=captions-menu]");
    await page.click("[data-testid=captions-mode-word]");
    await page.click("[data-testid=captions-make]");
    await waitRevision(page, r + 1);
    await page.waitForFunction(() => !document.querySelector("[data-testid=captions-menu]"));
    const deadline = Date.now() + 10000;
    let made: any;
    while (
      !(made = savedProject(dir)
        .tracks.flatMap((t: any) => t.items)
        .find((i: any) => i.type === "captions")) &&
      Date.now() < deadline
    )
      await sleep(100);
    assert.ok(made, "a captions item is saved");
    assert.equal(made.mode, "word");
    await page.waitForFunction(() => /Remake/.test(document.querySelector("[data-testid=make-captions]")?.textContent ?? ""));
    assert.deepEqual(app.errors, []);
  },
);
