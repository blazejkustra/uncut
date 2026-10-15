// Phase 4 chunk 3 on the packaged app (D52): editing the timeline by hand with real mouse drags.
// Select (the Inspector shows the item), move a text item (and onto another item: it lands on the
// nearest free spot), reorder main clips, trim both edges of a clip (the next clip ripples, the
// preview shows the new in-point) and a text item, split at the playhead (the picture doesn't
// change across the cut), delete (leaving a gap on main, D224), snap to the playhead, hide and lock tracks. Every
// action is one ⌘Z. The agent (a scripted stand-in for claude) is refused on a locked track, and
// its prompt lists the manual edits in words (D6). Screenshots: test-output/timeline-edit-*.png.
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
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test clips") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FPS = 30;

type Saved = { id: string; start?: number; duration: number; in?: number; [k: string]: unknown };
type SavedTrack = { id: string; hidden?: boolean; locked?: boolean; items: Array<Saved> };
const onDisk = (): { tracks: Array<SavedTrack> } => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const saved = (id: string) => onDisk().tracks.flatMap((t) => t.items).find((i) => i.id === id);
const mainIds = () => onDisk().tracks.find((t) => t.id === "main")!.items.map((i) => i.id);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 10000 }, n);
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const frameOf = () => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
const itemSel = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const box = async (selector: string) => {
  const b = await (await page.$(selector))?.boundingBox();
  assert.ok(b, `no box for ${selector}`);
  return b;
};
const shown = (id: string) => page.$eval(itemSel(id), (el) => ({ start: Number((el as HTMLElement).dataset.start), duration: Number((el as HTMLElement).dataset.duration) }));
const notice = () => page.$eval("[data-testid=editor-error]", (el) => (el.textContent ?? "").trim()).catch(() => "");
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0], shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
/** ⌘Z, and the revision goes up by one (undo is one step). */
async function undo() {
  const r = await revision();
  await meta("KeyZ");
  await waitRevision(r + 1);
}

/**
 * A real mouse drag: press at `from`, move in steps to `to`, run `during` (the drag is still
 * held), release. ⌘ held (`meta`) turns snapping off, so numeric results are exact.
 */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }, { meta = false, during }: { meta?: boolean; during?: () => Promise<void> } = {}) {
  if (meta) await page.keyboard.down("Meta");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) / 3, from.y + (to.y - from.y) / 3, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await sleep(120);
  await during?.();
  await page.mouse.up();
  if (meta) await page.keyboard.up("Meta");
}
/** Drag an item's body (its middle) by `frames` to the right, optionally onto the lane of `toTrack`. */
async function dragItem(id: string, frames: number, options: { meta?: boolean; during?: () => Promise<void>; toTrack?: string } = {}) {
  const b = await box(itemSel(id));
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const lane = options.toTrack ? await box(`[data-testid=lane][data-track="${options.toTrack}"]`) : undefined;
  await drag(from, { x: from.x + frames * (await ppf()), y: lane ? lane.y + lane.height / 2 : from.y }, options);
}
/** Drag an item's edge handle by `frames`. */
async function dragEdge(id: string, edge: "start" | "end", frames: number, options: { meta?: boolean; during?: () => Promise<void> } = {}) {
  const b = await box(`${itemSel(id)} [data-edge=${edge}]`);
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await drag(from, { x: from.x + frames * (await ppf()), y: from.y }, options);
}

/** Put the playhead on exactly `target`: click the ruler near it, then step with the arrow keys. */
async function seekTo(target: number) {
  const ruler = await box("[data-testid=ruler]");
  await page.mouse.click(ruler.x + target * (await ppf()) + 1, ruler.y + ruler.height / 2);
  for (let i = 0; i < 200; i++) {
    const f = await frameOf();
    if (f === target) return;
    await page.keyboard.press(target > f ? "ArrowRight" : "ArrowLeft");
  }
  assert.fail(`couldn't put the playhead on ${target}`);
}
async function settle() {
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => !v.seeking && v.readyState >= 2), { timeout: 10000 });
  await sleep(150);
}
const visibleVideo = () =>
  page.$$eval("video[data-item]", (els) => {
    const v = (els as Array<HTMLVideoElement>).find((e) => e.style.opacity === "1" && e.style.visibility !== "hidden");
    return v ? { id: v.dataset.item, time: v.currentTime } : undefined;
  });
/** Average colour of the middle of the preview, [r, g, b]. */
async function previewColour(name: string) {
  await settle();
  const path = resolve("test-output", `timeline-edit-${name}.png`);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
  return [...execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "crop=iw/4:ih/4,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];
}
const isColour = (name: "red" | "blue" | "green" | "black", [r, g, b]: Array<number>) =>
  name === "red" ? r! > 150 && g! < 90 && b! < 90 : name === "blue" ? b! > 150 && r! < 90 && g! < 90 : name === "green" ? g! > 100 && r! < 90 && b! < 90 : r! < 30 && g! < 30 && b! < 30;

const plan = () => join(root, "plan.json");
const promptLog = () => join(root, "prompts.jsonl");

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-timeline-edit-")));
  // Two 4 s clips at 30 fps: red then blue, and green then yellow (120 frames each).
  const clip = (path: string, a: string, b: string) =>
    execFileSync("ffmpeg", ["-v", "error", "-y", "-filter_complex", `color=c=${a}:s=320x180:r=30:d=2[a];color=c=${b}:s=320x180:r=30:d=2[b];[a][b]concat=n=2:v=1:a=0`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
  clip(join(root, "rb.mp4"), "red", "blue");
  clip(join(root, "gy.mp4"), "green", "yellow");
  const probe = { frames: 120, fps: 30, width: 320, height: 180, hasAudio: false };
  dir = join(root, "Edit.uncut");
  mkdirSync(dir);
  const text = (id: string, start: number, duration: number, words: string) => ({ id, type: "text", start, duration, text: words, transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Edit",
      canvas: { width: 1920, height: 1080, fps: FPS },
      media: [
        { id: "m-rb", kind: "video", name: "rb.mp4", path: join(root, "rb.mp4"), probe },
        { id: "m-gy", kind: "video", name: "gy.mp4", path: join(root, "gy.mp4"), probe },
      ],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [text("title-1", 0, 60, "Title"), text("end-1", 150, 30, "End")] },
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: [
            { id: "clip-1", type: "clip", media: "m-rb", in: 0, duration: 120 },
            { id: "clip-2", type: "clip", media: "m-gy", in: 0, duration: 120 },
          ],
        },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
  writeFileSync(promptLog(), "");
  writeFileSync(plan(), "[]");
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan(), FAKE_PROMPT_LOG: promptLog() },
  });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(itemSel("clip-2"), { timeout: 15000 });
  await settle();
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("select: the Inspector shows the item; Esc and an empty lane clear it", { skip, timeout: 60000 }, async () => {
  await page.click(itemSel("title-1"));
  await page.waitForSelector("[data-testid=inspector-item][data-item=title-1]");
  assert.equal(await page.$eval("[data-testid=insp-type]", (e) => e.textContent), "Text");
  assert.equal(await page.$eval("[data-testid=insp-duration]", (e) => e.textContent), "2.00s");
  assert.ok(await page.$eval(itemSel("title-1"), (e) => e.classList.contains("selected")));
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-testid=inspector-item]", { hidden: true });
  await page.click(itemSel("clip-2"));
  await page.waitForSelector("[data-testid=inspector-item][data-item=clip-2]");
  assert.equal(await page.$eval("[data-testid=insp-start]", (e) => e.textContent), "00:00:04:00");
  assert.equal(await page.$eval("[data-testid=insp-in]", (e) => e.textContent), "00:00:00:00");
  assert.equal(await page.$eval("[data-testid=insp-out]", (e) => e.textContent), "00:00:04:00");
  // An empty spot on the audio lane.
  const lane = await box("[data-testid=lane][data-track=audio]");
  await page.mouse.click(lane.x + lane.width - 20, lane.y + lane.height / 2);
  await page.waitForSelector("[data-testid=inspector-item]", { hidden: true });
  await page.screenshot({ path: "test-output/timeline-edit-select.png" });
});

test("move a text item: the saved start changes; onto another item it lands on the nearest free spot", { skip, timeout: 60000 }, async () => {
  const r = await revision();
  await dragItem("title-1", 30, { meta: true });
  await waitRevision(r + 1);
  assert.equal(saved("title-1")!.start, 30);
  assert.deepEqual(await shown("title-1"), { start: 30, duration: 60 });
  await undo();
  assert.equal(saved("title-1")!.start, 0, "one ⌘Z takes the move back");

  // Dropped at 130 it would cover end-1 (150–180): it lands at 90, right before it, and the
  // landing spot shows while dragging.
  await dragItem("title-1", 130, {
    meta: true,
    during: async () => {
      const left = await page.$eval(`${itemSel("title-1")}.landing`, (e) => parseFloat((e as HTMLElement).style.left));
      assert.ok(Math.abs(left - 90 * (await ppf())) < 1, `landing at ${left}px`);
      assert.ok(await page.$("[data-testid=drag-float]"), "the item follows the pointer");
      await page.screenshot({ path: "test-output/timeline-edit-moving.png" });
    },
  });
  await waitRevision(r + 3);
  assert.equal(saved("title-1")!.start, 90);
  assert.equal(saved("end-1")!.start, 150, "the other item didn't move");
  assert.equal(await page.$("[data-testid=drag-float]"), null);
  await undo();
  assert.equal(saved("title-1")!.start, 0);
});

test("reorder two main clips by dragging", { skip, timeout: 60000 }, async () => {
  const r = await revision();
  // D224: dropped at 150, its middle past clip-2's: after clip-2, which stays at 120 (a gap
  // before it), and it can't start before clip-2's end.
  await dragItem("clip-1", 150, { meta: true });
  await waitRevision(r + 1);
  assert.deepEqual(mainIds(), ["clip-2", "clip-1"]);
  assert.deepEqual(await shown("clip-2"), { start: 120, duration: 120 });
  assert.deepEqual(await shown("clip-1"), { start: 240, duration: 120 });
  assert.equal(saved("clip-1")!.start, undefined, "main items have no start");
  assert.equal(saved("clip-2")!.gap, 120);
  await undo();
  assert.deepEqual(mainIds(), ["clip-1", "clip-2"]);
});

test("trim both edges of a clip: in and duration saved, the next clip ripples, the preview shows the new in-point", { skip, timeout: 90000 }, async () => {
  await seekTo(0);
  assert.ok(isColour("red", await previewColour("trim-before")), "red first");
  const r = await revision();
  await dragEdge("clip-1", "start", 75, {
    meta: true,
    during: async () => assert.equal(await page.$eval("[data-testid=drag-tip]", (e) => e.textContent), "1.50s", "the length shows while trimming"),
  });
  await waitRevision(r + 1);
  assert.deepEqual([saved("clip-1")!.in, saved("clip-1")!.duration], [75, 45]);
  assert.deepEqual(await shown("clip-2"), { start: 45, duration: 120 }, "clip-2 ripples left");
  // Frame 0 now shows source frame 75 of red→blue: blue, at 75 / fps.
  await seekTo(0);
  assert.ok(isColour("blue", await previewColour("trim-left")), "the new in-point shows");
  const v = await visibleVideo();
  assert.equal(v?.id, "clip-1");
  assert.ok(Math.abs(v!.time - 75 / FPS) < 0.5 / FPS, `video at ${v!.time}`);
  await undo();
  assert.deepEqual([saved("clip-1")!.in, saved("clip-1")!.duration], [0, 120]);

  // The right edge: 30 frames shorter, clip-2 follows.
  await dragEdge("clip-1", "end", -30, { meta: true });
  await waitRevision(r + 3);
  assert.deepEqual([saved("clip-1")!.in, saved("clip-1")!.duration], [0, 90]);
  assert.deepEqual(await shown("clip-2"), { start: 90, duration: 120 });
  // Not past the media's end: extending by 60 is clamped to the 120 frames there are.
  await dragEdge("clip-1", "end", 60, { meta: true });
  await waitRevision(r + 4);
  assert.equal(saved("clip-1")!.duration, 120);
  await undo();
  await undo();
  assert.equal(saved("clip-1")!.duration, 120);
  assert.deepEqual(await shown("clip-2"), { start: 120, duration: 120 });

  // With snapping on, a trim smaller than the snap distance still happens: the clip's own edge
  // and the clip after it (which ripples) aren't snap targets.
  await seekTo(10);
  await dragEdge("clip-1", "end", -1.2);
  await waitRevision(r + 7);
  assert.equal(saved("clip-1")!.duration, 119);
  await undo();
});

test("trim a text item: the right edge changes the length, the left edge the start", { skip, timeout: 60000 }, async () => {
  const r = await revision();
  await dragEdge("end-1", "end", 30, { meta: true });
  await waitRevision(r + 1);
  assert.deepEqual([saved("end-1")!.start, saved("end-1")!.duration], [150, 60]);
  await dragEdge("end-1", "start", -20, { meta: true });
  await waitRevision(r + 2);
  assert.deepEqual([saved("end-1")!.start, saved("end-1")!.duration], [130, 80]);
  await undo();
  await undo();
  assert.deepEqual([saved("end-1")!.start, saved("end-1")!.duration], [150, 30]);
});

test("split at the playhead: two items with the right in and duration, the picture unchanged across the cut", { skip, timeout: 90000 }, async () => {
  await page.keyboard.press("Escape");
  await seekTo(39);
  const before39 = await previewColour("split-39-before");
  await seekTo(40);
  const before40 = await previewColour("split-40-before");
  const r = await revision();
  // Nothing selected: S splits the main clip under the playhead.
  await page.keyboard.press("s");
  await waitRevision(r + 1);
  assert.deepEqual(mainIds(), ["clip-1", "clip-3", "clip-2"]);
  assert.deepEqual([saved("clip-1")!.in, saved("clip-1")!.duration], [0, 40]);
  assert.deepEqual([saved("clip-3")!.in, saved("clip-3")!.duration], [40, 80]);
  assert.ok(await page.$eval(itemSel("clip-3"), (e) => e.classList.contains("selected")), "the part after the playhead is selected");
  const v = await visibleVideo();
  assert.equal(v?.id, "clip-3");
  assert.ok(Math.abs(v!.time - 40 / FPS) < 0.5 / FPS, `the second part plays from 40: ${v!.time}`);
  assert.deepEqual(await previewColour("split-40-after"), before40);
  await seekTo(39);
  assert.deepEqual(await previewColour("split-39-after"), before39);
  await undo();
  assert.deepEqual(mainIds(), ["clip-1", "clip-2"]);

  // A selected text item, with the toolbar button.
  await page.click(itemSel("title-1"));
  await seekTo(30);
  await page.click("[data-testid=split]");
  await waitRevision(r + 3);
  assert.deepEqual([saved("title-1")!.duration, saved("title-2")!.start, saved("title-2")!.duration], [30, 30, 30]);
  await undo();
  assert.equal(saved("title-2"), undefined);
});

test("delete: Backspace removes the selected item and leaves its space on main (D224); the toolbar button too", { skip, timeout: 60000 }, async () => {
  const r = await revision();
  await page.click(itemSel("clip-1"));
  await page.keyboard.press("Backspace");
  await waitRevision(r + 1);
  assert.deepEqual(mainIds(), ["clip-2"]);
  assert.deepEqual(await shown("clip-2"), { start: 120, duration: 120 });
  assert.equal(await page.$("[data-testid=inspector-item]"), null, "nothing selected after a delete");
  await undo();
  assert.deepEqual(mainIds(), ["clip-1", "clip-2"]);
  await page.click(itemSel("end-1"));
  await page.click("[data-testid=delete-item]");
  await waitRevision(r + 3);
  assert.equal(saved("end-1"), undefined);
  await undo();
  assert.equal(saved("end-1")!.start, 150);
});

test("snapping: a moved item sticks to the playhead (with a snap line); ⌘ turns it off", { skip, timeout: 60000 }, async () => {
  await page.keyboard.press("Escape");
  await seekTo(70);
  const r = await revision();
  const px = await ppf();
  // 4 px short of the playhead.
  const offset = -4 / px;
  await dragItem("title-1", 70 + offset, {
    during: async () => {
      assert.equal(await page.$eval("[data-testid=snap-line]", (e) => Number((e as HTMLElement).dataset.frame)), 70);
      await page.screenshot({ path: "test-output/timeline-edit-snap.png" });
    },
  });
  await waitRevision(r + 1);
  assert.equal(saved("title-1")!.start, 70);
  await undo();
  await dragItem("title-1", 70 + offset, { meta: true, during: async () => assert.equal(await page.$("[data-testid=snap-line]"), null) });
  await waitRevision(r + 3);
  assert.equal(saved("title-1")!.start, Math.round(70 + offset));
  await undo();
});

test("hide a track: the preview skips it; one ⌘Z shows it again", { skip, timeout: 60000 }, async () => {
  await seekTo(10);
  assert.ok(isColour("red", await previewColour("hide-before")));
  assert.ok(await page.$('.pv-text[data-item="title-1"]'));
  const r = await revision();
  await page.click("[data-testid=track][data-id=main] [data-testid=track-hide]");
  await waitRevision(r + 1);
  assert.equal(onDisk().tracks.find((t) => t.id === "main")!.hidden, true);
  assert.ok(isColour("black", await previewColour("hide-main")), "no video in the preview");
  await page.click("[data-testid=track][data-id=text] [data-testid=track-hide]");
  await waitRevision(r + 2);
  await page.waitForSelector(".pv-text", { hidden: true });
  await page.screenshot({ path: "test-output/timeline-edit-hidden.png" });
  await undo();
  await page.waitForSelector('.pv-text[data-item="title-1"]');
  await undo();
  assert.ok(isColour("red", await previewColour("hide-after")));
  assert.equal(onDisk().tracks.find((t) => t.id === "main")!.hidden, undefined);
});

test("lock a track: drags, split and delete refuse by hand, the agent is refused too, and its prompt lists the manual edits", { skip, timeout: 120000 }, async () => {
  // Edits that stay (undone ones leave the log; the note says "Used undo" for those).
  let r = await revision();
  await page.keyboard.press("Escape");
  await dragItem("title-1", 30, { meta: true });
  await waitRevision(++r);
  await dragEdge("clip-1", "end", -30, { meta: true });
  await waitRevision(++r);
  await page.keyboard.press("Escape");
  await seekTo(150);
  await page.keyboard.press("s");
  await waitRevision(++r);
  assert.deepEqual(mainIds(), ["clip-1", "clip-2", "clip-3"]);
  await page.keyboard.press("Delete");
  await waitRevision(++r);
  assert.deepEqual(mainIds(), ["clip-1", "clip-2"]);
  await page.click("[data-testid=track][data-id=audio] [data-testid=track-mute]");
  await waitRevision(++r);
  assert.equal((onDisk().tracks.find((t) => t.id === "audio") as { mixer?: { mute?: boolean } }).mixer?.mute, true);

  await page.click("[data-testid=track][data-id=text] [data-testid=track-lock]");
  await waitRevision(++r);
  assert.equal(onDisk().tracks.find((t) => t.id === "text")!.locked, true);
  assert.equal(await page.$(`${itemSel("title-1")} [data-edge]`), null, "no trim handles on a locked track");
  await dragItem("title-1", 40, { meta: true });
  await sleep(500);
  assert.equal(await revision(), r, "the drag sent nothing");
  assert.equal(saved("title-1")!.start, 30);
  await seekTo(40);
  await page.click(itemSel("title-1"));
  await page.keyboard.press("s");
  await page.waitForFunction(() => /locked/.test(document.querySelector("[data-testid=editor-error]")?.textContent ?? ""));
  await page.keyboard.press("Backspace");
  await sleep(300);
  assert.match(await notice(), /locked/);
  assert.equal(await revision(), r);
  assert.equal(saved("title-1")!.duration, 60);
  await page.screenshot({ path: "test-output/timeline-edit-locked.png" });

  // The agent tries to trim the title on the locked track: refused by the server.
  writeFileSync(
    plan(),
    JSON.stringify([[{ tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Trim the title", ops: [{ op: "trim_item", item: "title-1", edge: "end", frames: 10 }] } }, { text: "The text track is locked." }]]),
  );
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 30000 });
  await page.click("[data-testid=agent-input]");
  await page.type("[data-testid=agent-input]", "shorten the title");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 30000 });
  assert.deepEqual(
    await page.$$eval("[data-testid=agent-step]", (els) => els.map((e) => (e as HTMLElement).dataset.status)),
    ["done", "error"],
  );
  assert.equal(saved("title-1")!.duration, 60, "the agent couldn't edit the locked track");

  // Its prompt told it about the manual edits, in words.
  const [first] = readFileSync(promptLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { prompt: string });
  const prompt = first!.prompt;
  for (const line of [
    /by hand/,
    /Moved text "Title" \(title-1\) to 1\.0s/,
    /Trimmed rb\.mp4 \(clip-1\) by 1\.0s at the end/,
    /Split gy\.mp4 \(clip-2\) at 2\.0s/,
    /Deleted clip-3/,
    /Muted track audio/,
    /Locked track text/,
    /Used undo/,
  ]) {
    assert.match(prompt, line);
  }
  await page.click("[data-testid=tab-inspector]");
  assert.deepEqual(app!.errors, []);
});
