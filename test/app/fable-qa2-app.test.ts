// Fable QA round 2 (planning/FEEDBACK.md "Fable QA round 2", D146–D158) on the packaged app, run
// invisibly and muted, with real key and pointer events:
// - F3: ⇧⌫ and ⇧Delete ripple delete from the keyboard.
// - F14: an unselected clip shows its trim handles under the pointer and trims from them.
// - F5: key diamonds on a timeline clip, a click jumps there, [ and ], an ease per key.
// - F11: 2× on a main clip: the overlay and the sound over the clips follow their footage.
// - F2: a filter on three selected clips in one edit; the multi-selection Inspector removes it from all.
// - F6: a Main clip dragged onto a text lane: the new-track line, then a new video track.
// - F12: a marquee from the track heads and from the empty space under the lanes.
// - F15: the canvas menu: Split, Detach audio, Bring forward / Send backward, Reset position.
// - F9 / F16: transition tiles say whether they fit the selected cut; a tile dragged with the
//   pointer shows the target cut and a ghost, and lands there.
// - F19: Kicker and title selected, moved and deleted together; Ungroup.
// - F20: a text added from the Text tab is selected with handles and edits in place on a double click.
// - F13: a camera-named file imports as "DJI 0042".
// - F10 / F7: 16:9 → 9:16 in Settings rescales the PiP in the same edit; a lower third lands bottom-left.
// - F1: a background goes on a track under Main and covers the whole edit, behind the footage.
// Screenshots: test-output/fable-*.png.
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
const out = (name: string) => resolve("test-output", `fable-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
type Saved = {
  id: string;
  type: string;
  start?: number;
  duration: number;
  media?: string;
  speed?: number;
  group?: string;
  text?: string;
  effects?: Array<{ module: string; params?: { look?: string } }>;
  keys?: Array<{ frame: number; ease?: string }>;
  transform?: { x?: number; y?: number; w?: number; h?: number };
  transitionIn?: { module: string; duration: number };
  component?: string;
};
type SavedTrack = { id: string; kind: string; name: string; role?: string; items: Array<Saved> };
type SavedProject = { canvas: { width: number; height: number }; media: Array<{ id: string; name: string; path: string }>; tracks: Array<SavedTrack> };
const onDisk = (): SavedProject => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const itemOnDisk = (id: string) => {
  for (const t of onDisk().tracks) {
    const i = t.items.find((x) => x.id === id);
    if (i) return { ...i, track: t.id };
  }
  return undefined;
};
const mainIds = () =>
  onDisk()
    .tracks.find((t) => t.role === "main")!
    .items.map((i) => i.id);
const until = async (check: () => boolean, what: string, timeout = 10000) => {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (want) => Number(/revision (\d+)/.exec((document.querySelector("[data-testid=saved]") as HTMLElement | null)?.title ?? "")?.[1] ?? -1) >= want,
    { timeout: 15000 },
    n,
  );
const rect = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const xOf = async (frame: number) => (await rect("[data-testid=lanes]")).left + frame * (await ppf());
const laneY = async (track: string) => {
  const r = await rect(`[data-testid=lane][data-track="${track}"]`);
  return r.top + r.height / 2;
};
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const selectedIds = () => page.$$eval(".clip.selected[data-testid=timeline-item]", (els) => els.map((e) => (e as HTMLElement).dataset.item!).sort());
const centre = async (selector: string) => {
  const r = await rect(selector);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, hold?: () => Promise<void>) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await sleep(120);
  if (hold) await hold();
  await page.mouse.up();
};
const key = async (k: Parameters<Page["keyboard"]["press"]>[0], mod?: "Shift" | "Meta") => {
  if (mod) await page.keyboard.down(mod);
  await page.keyboard.press(k);
  if (mod) await page.keyboard.up(mod);
};
const undo = async () => {
  const r = await revision();
  await key("z", "Meta");
  await page.waitForFunction(
    (was) => Number(/revision (\d+)/.exec((document.querySelector("[data-testid=saved]") as HTMLElement | null)?.title ?? "")?.[1] ?? -1) !== was,
    { timeout: 10000 },
    r,
  );
};
/** Click on the ruler at a frame (moves the playhead there). */
const seek = async (frame: number) => {
  const ruler = await rect("[data-testid=ruler]");
  await page.mouse.click(await xOf(frame), ruler.top + ruler.height - 6);
  await page.waitForFunction(
    (f) => Math.abs(Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) - f) <= 1,
    { timeout: 5000 },
    frame,
  );
};
/** A rail tab (the taller timeline leaves the lower ones scrolled out of the rail). */
const rail = (id: string) => page.$eval(`[data-testid=rail-${id}]`, (el) => (el as HTMLElement).click());
const menuLabels = () => page.$$eval("[data-testid=context-menu] .ctx-item", (els) => els.map((e) => (e as HTMLElement).dataset.testid ?? ""));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-fable-qa2-")));
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
      "10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
    ],
    "Shot.mp4",
  );
  lavfi(["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "3", "-c:a", "aac"], "Tone.m4a");
  lavfi(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"], "DJI_20261013182112_0042_D.mp4");
  dir = join(root, "Fable.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Fable",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [
        {
          id: "m-shot",
          kind: "video",
          name: "Shot.mp4",
          path: join(root, "Shot.mp4"),
          probe: { frames: 300, fps: 30, width: 640, height: 360, hasAudio: true },
        },
        { id: "m-tone", kind: "audio", name: "Tone.m4a", path: join(root, "Tone.m4a"), probe: { frames: 90, hasAudio: true } },
      ],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        {
          id: "overlay",
          kind: "video",
          name: "Overlay",
          items: [
            {
              id: "o1",
              type: "clip",
              media: "m-shot",
              in: 0,
              start: 30,
              duration: 60,
              transform: { x: 1200, y: 600, w: 640, h: 360 },
              keys: [
                { frame: 5, scale: 1 },
                { frame: 20, scale: 1.5 },
              ],
            },
          ],
        },
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: [
            { id: "a", type: "clip", media: "m-shot", in: 0, duration: 120 },
            { id: "b", type: "clip", media: "m-shot", in: 120, duration: 90 },
            { id: "c", type: "clip", media: "m-shot", in: 0, duration: 60 },
          ],
        },
        { id: "sfx", kind: "audio", name: "Sounds", items: [{ id: "tone", type: "audio", media: "m-tone", in: 0, start: 150, duration: 30 }] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Fable QA round 2: keys, multi-select, drags, menus, transitions, groups, text, import, canvas, background", { skip, timeout: 420000 }, async () => {
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, [join(root, "DJI_20261013182112_0042_D.mp4")]]) },
  });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor(item("a"));
  await page.click("[data-testid=bottom-timeline]");
  // A taller timeline: room under the lanes for the marquee (F12).
  const resizer = await centre("[data-testid=resize-bottom]");
  await drag(resizer, { x: resizer.x, y: resizer.y - 220 });
  await sleep(200);

  // ---- F3: ⇧⌫ and ⇧Delete ripple delete ----
  await page.click(item("c"));
  let rev = await revision();
  await key("Backspace", "Shift");
  await waitRevision(rev + 1);
  assert.deepEqual(mainIds(), ["a", "b"], "⇧⌫ ripple-deleted c");
  await undo();
  await waitFor(item("c"));
  await page.click(item("b"));
  rev = await revision();
  await key("Delete", "Shift");
  await waitRevision(rev + 1);
  assert.deepEqual(mainIds(), ["a", "c"], "⇧Delete ripple-deleted b");
  await undo();
  await waitFor(item("b"));
  assert.deepEqual(mainIds(), ["a", "b", "c"]);

  // ---- F14: an unselected clip's trim handle under the pointer ----
  await key("Escape");
  assert.deepEqual(await selectedIds(), []);
  const endEdge = `${item("c")} [data-testid=trim-end]`;
  const edge = await centre(endEdge);
  await page.mouse.move(edge.x, edge.y);
  await sleep(150);
  const look = await page.$eval(endEdge, (el) => ({ bg: getComputedStyle(el).backgroundColor, cursor: getComputedStyle(el).cursor }));
  assert.equal(look.cursor, "ew-resize");
  assert.notEqual(look.bg, "rgba(0, 0, 0, 0)", `the handle shows under the pointer (${look.bg})`);
  await page.screenshot({ path: out("hover-trim") });
  rev = await revision();
  await drag(edge, { x: edge.x - 15 * (await ppf()), y: edge.y });
  await waitRevision(rev + 1);
  assert.equal(itemOnDisk("c")!.duration, 45, "trimmed from the unselected clip's edge");
  await undo();

  // ---- F5: key diamonds, a click goes there, [ and ], the ease ----
  const marks = await page.$$eval(`${item("o1")} [data-testid=key-mark]`, (els) => els.map((e) => Number((e as HTMLElement).dataset.frame)));
  assert.deepEqual(marks, [35, 50], "a diamond per key on the clip");
  await page.click(`${item("o1")} [data-testid=key-mark][data-frame='50']`);
  await page.waitForFunction(() => Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) === 50);
  assert.deepEqual(await selectedIds(), ["o1"]);
  await key("BracketLeft");
  await page.waitForFunction(() => Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) === 35);
  await key("BracketRight");
  await page.waitForFunction(() => Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) === 50);
  await page.click("[data-testid=tab-inspector]");
  await page.click("[data-testid=insp-key-prev]");
  await page.waitForFunction(() => Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) === 35);
  await waitFor("[data-testid=insp-key-ease][data-ease=linear]");
  rev = await revision();
  await page.click("[data-testid=insp-ease][data-ease=inOut]");
  await waitRevision(rev + 1);
  assert.equal(itemOnDisk("o1")!.keys![0]!.ease, "inOut");
  await waitFor("[data-testid=insp-key-ease][data-ease=inOut]");
  await page.screenshot({ path: out("keyframes") });

  // ---- F11: 2× on a, the overlay and the sound over the clips follow their footage ----
  await page.click(item("a"));
  await waitFor("[data-testid=insp-speed-2]");
  rev = await revision();
  await page.click("[data-testid=insp-speed-2]");
  await waitRevision(rev + 1);
  assert.equal(itemOnDisk("a")!.duration, 60);
  assert.equal(itemOnDisk("o1")!.start, 15, "the PiP over a keeps its moment of a's footage");
  assert.equal(itemOnDisk("tone")!.start, 90, "the sound over b moves with b");
  assert.equal(await revision(), rev + 1, "one edit");
  await page.screenshot({ path: out("speed-overlays") });
  await undo();
  await until(() => itemOnDisk("o1")!.start === 30, "undone");

  // ---- F2: a filter on three selected clips, one edit; the multi-selection Inspector ----
  await page.click(item("a"));
  await page.keyboard.down("Shift");
  await page.click(item("c"));
  await page.keyboard.up("Shift");
  assert.deepEqual(await selectedIds(), ["a", "b", "c"]);
  await waitFor("[data-testid=inspector-multi][data-count='3']");
  assert.equal(await page.$eval("[data-testid=inspector-multi-sub]", (el) => el.textContent), "3 clips");
  await rail("effects");
  await waitFor("[data-testid=filter-tile][data-look=teal-orange]");
  rev = await revision();
  await page.click("[data-testid=filter-tile][data-look=teal-orange]");
  await waitRevision(rev + 1);
  for (const id of ["a", "b", "c"])
    assert.equal(itemOnDisk(id)!.effects?.find((e) => e.module === "effect.look")?.params?.look, "teal-orange", `${id} has the filter`);
  assert.equal(await revision(), rev + 1, "one edit for all three");
  await waitFor("[data-testid=multi-filter-intensity]");
  await waitFor("[data-testid=multi-speed]");
  await waitFor("[data-testid=multi-volume]");
  await waitFor("[data-testid=multi-opacity]");
  await page.screenshot({ path: out("multi-inspector") });
  rev = await revision();
  await page.click("[data-testid=multi-filter-remove]");
  await waitRevision(rev + 1);
  for (const id of ["a", "b", "c"]) assert.equal(itemOnDisk(id)!.effects?.length ?? 0, 0, `${id} without the filter`);

  // ---- F6: a Main clip dragged onto the text lane: the new-track line, then a new video track ----
  await key("Escape");
  rev = await revision();
  const from = await centre(item("b"));
  await drag(from, { x: from.x, y: await laneY("text") }, async () => {
    await waitFor("[data-testid=new-track-line][data-side=between]");
    await page.screenshot({ path: out("new-track") });
  });
  await waitRevision(rev + 1);
  const moved = onDisk().tracks.find((t) => t.items.some((i) => i.id === "b"))!;
  assert.equal(moved.kind, "video");
  assert.notEqual(moved.role, "main");
  assert.deepEqual(
    onDisk()
      .tracks.map((t) => t.id)
      .slice(0, 2),
    ["text", moved.id],
    "a new video track right under the text track",
  );
  await undo();
  await until(() => mainIds().includes("b"), "b back on main");

  // ---- F12: a marquee from the track heads and from the empty space under the lanes ----
  const head = await rect("[data-testid=track][data-id=overlay] [data-testid=track-name]");
  await drag({ x: head.left + 4, y: head.top + head.height / 2 }, { x: await xOf(100), y: await laneY("main") }, async () => {
    await waitFor("[data-testid=marquee]");
  });
  assert.deepEqual(await selectedIds(), ["a", "o1"], "from the heads: what the box touches");
  const lanes = await rect("[data-testid=lanes]");
  const lastLane = await rect("[data-testid=lane][data-track=sfx]");
  assert.ok(lanes.bottom > lastLane.bottom + 30, `room under the lanes (${lanes.bottom} vs ${lastLane.bottom})`);
  await key("Escape");
  await drag({ x: await xOf(140), y: lastLane.bottom + 20 }, { x: await xOf(220), y: await laneY("main") }, async () => {
    await waitFor("[data-testid=marquee]");
    await page.screenshot({ path: out("marquee") });
  });
  assert.deepEqual(await selectedIds(), ["b", "c", "tone"], "from under the lanes");

  // ---- F15: the canvas menu ----
  await key("Escape");
  await seek(40);
  const pip = await centre(".pv-box[data-item=o1]");
  await page.mouse.click(pip.x, pip.y, { button: "right" });
  await waitFor("[data-testid=context-menu]");
  const labels = await menuLabels();
  for (const want of [
    "menu-add-to-chat",
    "menu-split",
    "menu-detach-audio",
    "menu-bring-forward",
    "menu-send-backward",
    "menu-reset-position",
    "menu-copy",
    "menu-duplicate",
    "menu-delete",
  ])
    assert.ok(labels.includes(want), `the canvas menu has ${want}: ${labels.join(" | ")}`);
  await page.screenshot({ path: out("canvas-menu") });
  rev = await revision();
  await page.click("[data-testid=menu-bring-forward]");
  await waitRevision(rev + 1);
  assert.equal(onDisk().tracks[0]!.items[0]?.id, "o1", "on a new track on top, over the text track");
  assert.ok(!onDisk().tracks.some((t) => t.id === "overlay"), "the empty Overlay track went");
  await undo();
  await until(() => itemOnDisk("o1")?.track === "overlay", "back on Overlay");

  // ---- F9: transition tiles say whether they fit the selected cut ----
  await page.click("[data-testid=cut-point][data-frame='210']");
  await rail("transitions");
  await waitFor("[data-testid=transition-tile][data-module='transition.crossfade'][data-fit=no]");
  assert.match(
    await page.$eval("[data-testid=transition-tile][data-module='transition.crossfade'] [data-testid=transition-unfit]", (el) => el.textContent ?? ""),
    /^Needs .* more footage$/,
  );
  assert.equal(await page.$eval("[data-testid=transition-tile][data-module='transition.dip-to-black']", (el) => (el as HTMLElement).dataset.fit), "yes");
  await page.click("[data-testid=tab-inspector]");
  assert.equal(
    await page.$eval("[data-testid=insp-transition-type] option[value='transition.crossfade']", (el) => (el as HTMLOptionElement).disabled),
    true,
    "listed but not pickable",
  );
  await page.screenshot({ path: out("transition-fit") });

  // ---- F16: a tile dragged with the pointer onto the cut at 120: target, ghost, then it's there ----
  const tile = await centre("[data-testid=transition-tile][data-module='transition.dip-to-black']");
  const cut = await centre("[data-testid=cut-point][data-frame='120']");
  rev = await revision();
  await page.mouse.move(tile.x, tile.y);
  await page.mouse.down();
  await page.mouse.move(tile.x + 20, tile.y + 10, { steps: 3 });
  await waitFor("[data-testid=transition-drag-chip]");
  await page.mouse.move(cut.x + 4, cut.y, { steps: 10 });
  await waitFor("[data-testid=cut-point][data-frame='120'].target");
  await waitFor("[data-testid=transition-drop-ghost][data-item=b]");
  await page.screenshot({ path: out("transition-drag") });
  await page.mouse.up();
  await waitRevision(rev + 1);
  assert.equal(itemOnDisk("b")!.transitionIn?.module, "transition.dip-to-black");
  assert.equal(await page.$("[data-testid=transition-drop-ghost]"), null);

  // ---- F19: Kicker and title move and delete together; Ungroup ----
  await key("Escape");
  await seek(0);
  await rail("text");
  rev = await revision();
  await page.click("[data-testid=text-preset][data-preset=kicker-title]");
  await waitRevision(rev + 1);
  const texts = onDisk()
    .tracks.flatMap((t) => t.items)
    .filter((i) => i.type === "text");
  assert.equal(texts.length, 2);
  assert.ok(texts[0]!.group && texts[0]!.group === texts[1]!.group, "one group");
  const [t1, t2] = [texts[0]!.id, texts[1]!.id];
  await waitFor(item(t2));
  await page.click(item(t2));
  assert.deepEqual(await selectedIds(), [t1, t2].sort(), "a click selects the group");
  const s0 = itemOnDisk(t1)!.start!;
  rev = await revision();
  const grab = await centre(item(t2));
  await drag(grab, { x: grab.x + 30 * (await ppf()), y: grab.y });
  await waitRevision(rev + 1);
  assert.ok(itemOnDisk(t1)!.start! > s0 && itemOnDisk(t1)!.start === itemOnDisk(t2)!.start, "moved together");
  rev = await revision();
  await key("Backspace");
  await waitRevision(rev + 1);
  assert.ok(!itemOnDisk(t1) && !itemOnDisk(t2), "deleted together");
  await undo();
  await waitFor(item(t1));
  await page.click(item(t1), { button: "right" });
  await waitFor("[data-testid=menu-ungroup]");
  rev = await revision();
  await page.click("[data-testid=menu-ungroup]");
  await waitRevision(rev + 1);
  assert.equal(itemOnDisk(t1)!.group, undefined);
  assert.equal(itemOnDisk(t2)!.group, undefined);

  // ---- F20: a text from the Text tab is selected with handles; a double click edits it ----
  await key("Escape");
  await seek(150);
  rev = await revision();
  await page.click("[data-testid=text-preset][data-preset=title]");
  await waitRevision(rev + 1);
  const title = onDisk()
    .tracks.flatMap((t) => t.items)
    .find((i) => i.type === "text" && i.id !== t1 && i.id !== t2)!;
  await page.waitForFunction((id) => document.querySelectorAll(`[data-testid=text-handle][data-item="${id}"]`).length === 4, { timeout: 5000 }, title.id);
  assert.deepEqual(await selectedIds(), [title.id]);
  await page.screenshot({ path: out("text-added") });
  const at = await centre(`.pv-text[data-item="${title.id}"]`);
  await page.mouse.click(at.x, at.y, { clickCount: 2 });
  await waitFor("[data-testid=inline-editor]");
  await key("a", "Meta");
  await page.keyboard.type("Fable");
  rev = await revision();
  await key("Enter");
  await waitRevision(rev + 1);
  assert.equal(itemOnDisk(title.id)!.text, "Fable");

  // ---- F13: a camera-named file imports with a short name ----
  await rail("media");
  await page.click("[data-testid=import-plus]");
  await until(() => onDisk().media.length === 3, "the import");
  const imported = onDisk().media.find((m) => m.path.endsWith("DJI_20261013182112_0042_D.mp4"))!;
  assert.equal(imported.name, "DJI 0042");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=tile-name]")].some((e) => e.textContent?.includes("DJI 0042")), {
    timeout: 10000,
  });

  // ---- F10: 16:9 → 9:16 rescales the PiP in the same edit; the frame rate says why it's fixed ----
  await key("Escape");
  await key("Comma", "Meta");
  await waitFor("[data-testid=settings-project]");
  assert.match((await page.$eval("[data-testid=settings] [data-testid=canvas-fps-why]", (el) => el.getAttribute("title"))) ?? "", /frames/);
  await waitFor("[data-testid=settings] [data-testid=canvas-keep-positions]");
  rev = await revision();
  await page.click('[data-testid=settings] [data-testid=canvas-aspect-option][data-aspect="9:16"]');
  await waitRevision(rev + 1);
  assert.equal(await revision(), rev + 1, "one edit");
  assert.deepEqual([onDisk().canvas.width, onDisk().canvas.height], [1080, 1920]);
  const box = itemOnDisk("o1")!.transform!;
  assert.deepEqual([box.w, box.h], [360, 203], `the PiP scaled with the canvas: ${JSON.stringify(box)}`);
  assert.ok(box.x! + box.w! <= 1080, "and inside it");
  await page.click("[data-testid=settings-close]");

  // ---- F7: a lower third on 9:16 lands bottom-left in the safe area ----
  await seek(150);
  await rail("elements");
  rev = await revision();
  await page.click("[data-testid=component-tile][data-component='component.lower-third'] [data-testid=component-add]");
  await waitRevision(rev + 1);
  const lt = onDisk()
    .tracks.flatMap((t) => t.items)
    .find((i) => i.component === "component.lower-third")!;
  assert.equal(lt.transform!.x, 72, "at the left safe margin");
  assert.ok(
    lt.transform!.y! + lt.transform!.h! / 2 > 1920 * 0.6 && lt.transform!.y! + lt.transform!.h! <= 1920 - 72,
    `low, inside the safe area: ${JSON.stringify(lt.transform)}`,
  );
  await sleep(300);
  await page.screenshot({ path: out("lower-third-9x16") });

  // ---- F1: a background goes under Main, over the whole edit, behind the footage ----
  await key("Escape");
  await seek(20);
  rev = await revision();
  await page.click("[data-testid=background-add]");
  await waitRevision(rev + 1);
  const tracks = onDisk().tracks;
  const mainAt = tracks.findIndex((t) => t.role === "main");
  const bgTrack = tracks.findIndex((t) => t.items.some((i) => i.component === "component.solid"));
  assert.equal(bgTrack, mainAt + 1, "the Background track is right under Main");
  const bg = tracks[bgTrack]!.items[0]!;
  assert.equal(bg.start, 0);
  // The edit's end before the background (main 270 frames; the title and lower third run past it).
  const ends = tracks.flatMap((t) =>
    t.role === "main" ? [t.items.reduce((n, i) => n + i.duration, 0)] : t.items.filter((i) => i.id !== bg.id).map((i) => i.start! + i.duration),
  );
  assert.equal(bg.duration, Math.max(...ends), "as long as the edit");
  const laneTop = async (id: string) => (await rect(`[data-testid=lane][data-track="${id}"]`)).top;
  assert.ok((await laneTop(tracks[bgTrack]!.id)) > (await laneTop("main")), "its lane is under Main");
  await page.waitForSelector(`.pv-solid[data-item="${bg.id}"]`);
  const z = await page.evaluate(
    (id) => [
      Number((document.querySelector(`.pv-solid[data-item="${id}"]`) as HTMLElement).style.zIndex),
      Number((document.querySelector(".pv-box[data-item=a]") as HTMLElement).style.zIndex),
    ],
    bg.id,
  );
  assert.ok(z[0]! < z[1]!, `drawn under the footage (z ${z})`);
  await sleep(300);
  await page.screenshot({ path: out("background") });
  assert.deepEqual(app.errors, []);
});
