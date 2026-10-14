// Feedback round 1, chunk B (planning/FEEDBACK.md, D122–D128) on the packaged app, run invisibly
// and muted:
// - T2: ⌘ + wheel and a pinch (ctrl + wheel) zoom around the pointer; ⇧ + wheel scrolls sideways.
// - T1: a media tile dropped on the overlay lane lands there at the drop frame; a clip moves from
//   main to the overlay and back.
// - T7: right-click menus on clips (and the keyboard: ⇧F10, arrows, type-ahead, Enter, Esc), track
//   heads and empty timeline; rename in place.
// - T3: Detach audio makes an audio item, the clip muted, in one edit.
// - G9: speed from the Inspector and from the menu; the length follows; keep pitch.
// - T6: sounds added at the playhead each get a free audio track.
// - T8: marquee, ⇧/⌘-click, group move with offsets kept and the snap line.
// - T9: a file dropped from Finder is imported and placed where it was dropped, in one edit.
// - G4: a media item renamed in the Media panel shows its new name on the timeline and in the Inspector.
// - G7: the Export dialog's range: In to Out, Selected clips, Custom.
// Screenshots: test-output/timeline-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CDPSession, Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
let cdp: CDPSession;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `timeline-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
type Saved = { id: string; type: string; start?: number; duration: number; media?: string; speed?: number; mute?: boolean; keepPitch?: boolean; name?: string; in?: number };
type SavedProject = { media: Array<{ id: string; name: string; path: string }>; tracks: Array<{ id: string; kind: string; name: string; role?: string; items: Array<Saved> }> };
const onDisk = (): SavedProject => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const itemOnDisk = (id: string) => {
  for (const t of onDisk().tracks) {
    const i = t.items.find((x) => x.id === id);
    if (i) return { ...i, track: t.id };
  }
  return undefined;
};
const until = async (check: () => boolean, what: string, timeout = 10000) => {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const rect = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const zoom = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.zoom));
const scrollLeft = () => page.$eval(".bottom-body", (el) => el.scrollLeft);
/** The client x of a frame on the lanes. */
const xOf = async (frame: number) => (await rect("[data-testid=lanes]")).left + frame * (await ppf());
const laneY = async (track: string) => {
  const r = await rect(`[data-testid=lane][data-track="${track}"]`);
  return r.top + r.height / 2;
};
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const selectedIds = () => page.$$eval(".clip.selected[data-testid=timeline-item]", (els) => els.map((e) => (e as HTMLElement).dataset.item!).sort());
const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, hold?: () => Promise<void>) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await sleep(80);
  if (hold) await hold();
  await page.mouse.up();
};
const centre = async (selector: string) => {
  const r = await rect(selector);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
const rightClick = async (selector: string, dx = 0) => {
  const c = await centre(selector);
  await page.mouse.click(c.x + dx, c.y, { button: "right" });
  await waitFor("[data-testid=context-menu]");
};
const menuItem = async (id: string) => {
  await waitFor(`[data-testid="menu-${id}"]`);
  await page.click(`[data-testid="menu-${id}"]`);
};
/** Point at a menu entry (a real move: the first position only arms the menu's hover). */
const hoverMenu = async (selector: string) => {
  const c = await centre(selector);
  await page.mouse.move(c.x - 2, c.y);
  await page.mouse.move(c.x, c.y, { steps: 2 });
};
/** A synthetic drag-and-drop onto a point (a media tile's data, or files from Finder). */
const dropAt = async (x: number, y: number, data: { items?: Array<{ mimeType: string; data: string }>; files?: Array<string> }) => {
  const payload = { items: data.items ?? [], ...(data.files ? { files: data.files } : {}), dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) await cdp.send("Input.dispatchDragEvent", { type, x, y, data: payload } as never);
};
const wheel = async (x: number, y: number, deltaY: number, modifiers: number, deltaX = 0) => {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, modifiers });
  await sleep(120);
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-timeline-pro-")));
  const lavfi = (args: Array<string>, file: string) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args, join(root, file)]);
  lavfi(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"], "Shot.mp4");
  lavfi(["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "8", "-c:a", "aac"], "Tone.m4a");
  lavfi(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p"], "Extra.mp4");
  dir = join(root, "Pro.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Pro",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [
        { id: "m-shot", kind: "video", name: "DJI_0042.mp4", path: join(root, "Shot.mp4"), probe: { frames: 300, fps: 30, width: 640, height: 360, hasAudio: true } },
        { id: "m-tone", kind: "audio", name: "Tone.m4a", path: join(root, "Tone.m4a"), probe: { frames: 240, hasAudio: true } },
      ],
      tracks: [
        { id: "overlay", kind: "video", name: "Overlay", items: [] },
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
        { id: "music", kind: "audio", name: "Music", items: [{ id: "s1", type: "audio", media: "m-tone", in: 0, start: 0, duration: 150 }] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("timeline chunk B: zoom, any track, menus, detach audio, speed, audio tracks, multi-select, Finder drop, rename media, export range", { skip, timeout: 300000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor(item("a"));
  cdp = await page.createCDPSession();
  await page.click("[data-testid=bottom-timeline]");

  // ---- T2: ⌘ + wheel zooms around the pointer, a pinch too; ⇧ + wheel scrolls sideways ----
  const z0 = await zoom();
  const lanes = await rect("[data-testid=lanes]");
  const px = lanes.left + 300;
  const py = await laneY("main");
  const frameUnder = async () => (px - (await rect("[data-testid=lanes]")).left) / (await ppf());
  const f0 = await frameUnder();
  await wheel(px, py, -120, 4); // ⌘ (meta)
  const z1 = await zoom();
  assert.ok(z1 > z0 * 1.5, `⌘ + wheel zoomed in (${z0} → ${z1})`);
  assert.ok(Math.abs((await frameUnder()) - f0) < 1.5, `the frame under the pointer stays (${f0} → ${await frameUnder()})`);
  await wheel(px, py, -40, 2); // ctrl: a trackpad pinch
  assert.ok((await zoom()) > z1, "a pinch zooms in too");
  assert.ok(Math.abs((await frameUnder()) - f0) < 1.5, "around the pointer");
  const s0 = await scrollLeft();
  await wheel(px, py, 200, 8); // ⇧: sideways
  assert.ok((await scrollLeft()) > s0 + 50, `⇧ + wheel scrolls sideways (${s0} → ${await scrollLeft()})`);
  await page.screenshot({ path: out("zoomed") });
  await page.click("[data-testid=zoom-fit]");
  await sleep(200);

  // ---- T1: a tile dropped on the overlay lane lands there, at the drop frame ----
  let rev = await revision();
  await dropAt(await xOf(60), await laneY("overlay"), { items: [{ mimeType: "application/x-uncut-media", data: "m-shot" }] });
  await until(() => (onDisk().tracks.find((t) => t.id === "overlay")?.items.length ?? 0) === 1, "the clip on the overlay track");
  const dropped = onDisk().tracks.find((t) => t.id === "overlay")!.items[0]!;
  assert.ok(Math.abs(dropped.start! - 60) <= 2, `dropped at ${dropped.start}`);
  assert.equal(await revision(), rev + 1, "one edit");
  // Move "a" from main to the overlay (after the dropped clip), then back.
  await drag(await centre(item("a")), { x: await xOf(400 + 60), y: await laneY("overlay") });
  await until(() => itemOnDisk("a")?.track === "overlay", "a on the overlay");
  assert.ok(itemOnDisk("a")!.start !== undefined);
  assert.deepEqual(onDisk().tracks.find((t) => t.role === "main")!.items.map((i) => i.id), ["b"]);
  await drag(await centre(item("a")), { x: await xOf(100), y: await laneY("main") });
  await until(() => itemOnDisk("a")?.track === "main", "a back on main");
  assert.equal(itemOnDisk("a")!.start, undefined, "main clips have no start");
  // The dropped overlay clip goes away for the rest.
  await page.click(item(dropped.id));
  await page.keyboard.press("Backspace");
  await until(() => !itemOnDisk(dropped.id), "the overlay clip deleted");

  // ---- T7 + T3: the clip menu, Detach audio ----
  await rightClick(item("b"));
  const menuLabels = await page.$$eval("[data-testid=context-menu] [role^=menuitem]", (els) => els.map((e) => e.textContent!.replace(/\s+/g, " ").trim()));
  for (const want of ["Split", "Copy", "Paste", "Duplicate", "Delete", "Ripple delete", "Detach audio", "Speed", "Rename", "Replace media", "Show in Media", "Reveal in Finder", "Mute", "Lock"]) assert.ok(menuLabels.some((l) => l.startsWith(want)), `the menu has ${want}: ${menuLabels.join(" | ")}`);
  for (const l of menuLabels) assert.doesNotMatch(l, /[·•*]/);
  await hoverMenu("[data-testid=menu-speed]");
  await waitFor("[data-testid=context-submenu]");
  await sleep(150);
  await page.screenshot({ path: out("menu") });
  rev = await revision();
  await hoverMenu("[data-testid=menu-detach-audio]");
  await menuItem("detach-audio");
  await until(() => itemOnDisk("b")?.mute === true, "b muted");
  const detached = onDisk().tracks.filter((t) => t.kind === "audio").flatMap((t) => t.items.map((i) => ({ ...i, track: t.id }))).find((i) => i.media === "m-shot")!;
  assert.ok(detached, "an audio item plays b's sound");
  assert.equal(detached.start, await page.$eval(item("b"), (el) => Number((el as HTMLElement).dataset.start)), "where b starts");
  assert.equal(detached.in, 120);
  assert.equal(detached.duration, 90);
  assert.notEqual(detached.track, "music", "the Music track is busy there");
  assert.equal(await revision(), rev + 1, "one edit");
  await waitFor(`${item("b")}[data-muted=true] [data-testid=clip-badge]`);
  await waitFor(`${item(detached.id)} .wave`);
  await page.screenshot({ path: out("detached") });
  // The detached sound moves on its own.
  await drag(await centre(item(detached.id)), { x: (await centre(item(detached.id))).x + 30 * (await ppf()), y: (await centre(item(detached.id))).y });
  await until(() => (itemOnDisk(detached.id)?.start ?? 0) >= detached.start! + 20, "the detached audio moved");
  assert.equal(itemOnDisk("b")!.duration, 90, "the clip stays");

  // ---- G9: speed from the Inspector and from the menu ----
  await page.click(item("a"));
  await waitFor("[data-testid=speed-editor]");
  await page.click("[data-testid=insp-speed-2]");
  await until(() => itemOnDisk("a")?.speed === 2 && itemOnDisk("a")?.duration === 60, "a at 2×, 60 frames");
  await waitFor(`${item("a")}[data-speed="2"]`);
  await page.click("[data-testid=insp-keep-pitch]");
  await until(() => itemOnDisk("a")?.keepPitch === false, "pitch follows the speed");
  await rightClick(item("a"));
  await hoverMenu("[data-testid=menu-speed]");
  await menuItem("speed-0.5");
  await until(() => itemOnDisk("a")?.speed === 0.5 && itemOnDisk("a")?.duration === 240, "a at 0.5×");
  await page.click("[data-testid=insp-speed-1]");
  await until(() => itemOnDisk("a")?.speed === undefined && itemOnDisk("a")?.duration === 120, "back to 1×");

  // ---- T6: sounds at the playhead each get their own track ----
  await page.click("[data-testid=rail-media]");
  await page.keyboard.press("Home");
  const audioTracks = () => onDisk().tracks.filter((t) => t.kind === "audio");
  const before = audioTracks().length;
  const tone = "[data-testid=media-tile][data-id=m-tone] [data-testid=add-to-timeline]";
  await page.hover("[data-testid=media-tile][data-id=m-tone]");
  await page.click(tone);
  await until(() => audioTracks().length === before + 1, "a new audio track");
  await page.keyboard.press("Home");
  await page.hover("[data-testid=media-tile][data-id=m-tone]");
  await page.click(tone);
  await until(() => audioTracks().length === before + 2, "another one");
  const atZero = audioTracks().flatMap((t) => t.items.filter((i) => (i.start ?? 0) === 0 && i.media === "m-tone"));
  assert.equal(atZero.length, 3, "three sounds start at 0, overlapping");
  await page.screenshot({ path: out("audio-tracks") });

  // ---- T8: marquee over the audio lanes, ⌘-click, ⇧-click, group move with a snap line ----
  const tracksNow = audioTracks().map((t) => t.id);
  const tones = audioTracks().flatMap((t) => t.items.filter((i) => i.media === "m-tone").map((i) => i.id)).sort();
  const firstAudio = await rect(`[data-testid=lane][data-track="${tracksNow[0]}"]`);
  const lastAudio = await rect(`[data-testid=lane][data-track="${tracksNow.at(-1)}"]`);
  const endX = await xOf(260);
  await page.keyboard.press("Escape");
  await drag({ x: endX, y: firstAudio.top + 4 }, { x: (await xOf(0)) + 4, y: lastAudio.bottom - 4 }, async () => {
    await waitFor("[data-testid=marquee]");
    await page.screenshot({ path: out("marquee") });
  });
  const marqueed = await selectedIds();
  for (const id of tones) assert.ok(marqueed.includes(id), `the marquee selected ${id}: ${marqueed}`);
  // ⌘-click takes one out, and back in.
  await page.keyboard.down("Meta");
  await page.click(item(tones[0]!));
  await page.keyboard.up("Meta");
  assert.ok(!(await selectedIds()).includes(tones[0]!));
  await page.keyboard.down("Meta");
  await page.click(item(tones[0]!));
  await page.keyboard.up("Meta");
  assert.ok((await selectedIds()).includes(tones[0]!));
  // The group (the three tones, without the detached sound) moves right together, snapping to the playhead.
  await page.keyboard.down("Meta");
  if ((await selectedIds()).includes(detached.id)) await page.click(item(detached.id));
  await page.keyboard.up("Meta");
  const groupIds = await selectedIds();
  const starts0 = new Map(groupIds.map((id) => [id, itemOnDisk(id)!.start!]));
  await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=ruler]"));
  // Playhead at frame 30: the group's start snaps to it.
  const ruler = await rect("[data-testid=ruler]");
  await page.mouse.click(await xOf(30), ruler.top + ruler.height - 6);
  const grab = await centre(item(tones[1]!));
  const head = await page.$eval("[data-testid=playhead]", (el) => Number((el as HTMLElement).dataset.frame));
  await drag(grab, { x: grab.x + (head + 0.6) * (await ppf()), y: grab.y }, async () => {
    await waitFor("[data-testid=snap-line]");
    await page.screenshot({ path: out("group-snap") });
  });
  await until(() => itemOnDisk(groupIds[0]!)!.start !== starts0.get(groupIds[0]!), "the group moved");
  const moved = groupIds.map((id) => itemOnDisk(id)!.start! - starts0.get(id)!);
  assert.ok(moved.every((d) => d === moved[0]), `every item moved by the same frames: ${moved}`);
  assert.equal(moved[0], head, "snapped: the group's start is on the playhead");
  // ⇧-click: a range from the selected item to another.
  // (The audio lanes scrolled the timeline down: back to the top, so main isn't under the sticky ruler.)
  await page.$eval(".bottom-body", (el) => (el.scrollTop = 0));
  await page.click(item("a"));
  await page.keyboard.down("Shift");
  await page.click(item("b"));
  await page.keyboard.up("Shift");
  const range = await selectedIds();
  assert.ok(range.includes("a") && range.includes("b"), `⇧-click range: ${range}`);

  // ---- T7 keyboard: ⇧F10 opens the menu, type-ahead + Enter renames in place ----
  await page.click(item("a"));
  await page.keyboard.down("Shift");
  await page.keyboard.press("F10");
  await page.keyboard.up("Shift");
  await waitFor("[data-testid=context-menu]");
  await page.keyboard.press("ArrowDown");
  assert.ok(await page.$("[data-testid=context-menu] .ctx-item.active"), "an entry is active");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=context-menu]"));
  await page.keyboard.down("Shift");
  await page.keyboard.press("F10");
  await page.keyboard.up("Shift");
  await waitFor("[data-testid=context-menu]");
  await page.keyboard.press("r");
  await page.keyboard.press("r"); // Ripple delete, then Rename
  const active = await page.$eval("[data-testid=context-menu] .ctx-item.active", (el) => el.textContent);
  assert.match(active ?? "", /Rename/);
  await page.keyboard.press("Enter");
  await sleep(200);
  await waitFor("[data-testid=item-rename]");
  await page.keyboard.type("Opening");
  await page.keyboard.press("Enter");
  await until(() => itemOnDisk("a")?.name === "Opening", "a renamed");
  // The track head menu: rename a track.
  const trackHead = "[data-testid=track][data-id=overlay]";
  await rightClick(trackHead);
  await menuItem("track-rename");
  await waitFor("[data-testid=track-rename]");
  await page.keyboard.down("Meta");
  await page.keyboard.press("a");
  await page.keyboard.up("Meta");
  await page.keyboard.type("B-roll");
  await page.keyboard.press("Enter");
  await until(() => onDisk().tracks.find((t) => t.id === "overlay")?.name === "B-roll", "the track renamed");
  // Empty timeline: its own menu.
  const overlayLane = await rect("[data-testid=lane][data-track=overlay]");
  await page.mouse.click(await xOf(10), overlayLane.top + overlayLane.height / 2, { button: "right" });
  await waitFor("[data-testid=menu-paste-here]");
  await page.keyboard.press("Escape");

  // ---- T9: a file from Finder dropped on the overlay lane: imported and placed in one edit ----
  rev = await revision();
  await dropAt(await xOf(200), await laneY("overlay"), { files: [join(root, "Extra.mp4")] });
  await until(() => onDisk().media.some((m) => m.path.endsWith("Extra.mp4")), "Extra.mp4 imported", 20000);
  const extra = onDisk().media.find((m) => m.path.endsWith("Extra.mp4"))!;
  await until(() => onDisk().tracks.find((t) => t.id === "overlay")!.items.some((i) => i.media === extra.id), "placed on the overlay");
  const placed = onDisk().tracks.find((t) => t.id === "overlay")!.items.find((i) => i.media === extra.id)!;
  assert.ok(Math.abs(placed.start! - 200) <= 3, `placed at ${placed.start}`);
  await page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) >= r, { timeout: 10000 }, rev + 1);
  assert.equal(await revision(), rev + 1, "the import and the placement are one edit");
  await page.screenshot({ path: out("finder-drop") });
  // Dropped again: not imported twice, placed again (one edit).
  rev = await revision();
  const mediaCount = onDisk().media.length;
  await dropAt(await xOf(100), await laneY("overlay"), { files: [join(root, "Extra.mp4")] });
  await until(() => onDisk().tracks.find((t) => t.id === "overlay")!.items.filter((i) => i.media === extra.id).length === 2, "placed a second time", 20000);
  assert.equal(onDisk().media.length, mediaCount, "not imported twice");
  assert.equal(await revision(), rev + 1);

  // ---- G4: rename media in the Media panel; the timeline and the Inspector show it ----
  await page.click("[data-testid=rail-media]");
  await page.click("[data-testid=media-tile][data-id=m-shot] [data-testid=tile-name]", { clickCount: 2 });
  await waitFor("[data-testid=media-rename]");
  await page.keyboard.down("Meta");
  await page.keyboard.press("a");
  await page.keyboard.up("Meta");
  await page.keyboard.type("Sunset ridge");
  await page.keyboard.press("Enter");
  await until(() => onDisk().media.find((m) => m.id === "m-shot")?.name === "Sunset ridge", "the media renamed");
  assert.equal(onDisk().media.find((m) => m.id === "m-shot")!.path, join(root, "Shot.mp4"), "the file stays");
  await page.waitForFunction(() => document.querySelector('[data-testid=timeline-item][data-item="b"] .nm')?.textContent === "Sunset ridge");
  await page.click(item("b"));
  await page.click("[data-testid=tab-inspector]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=insp-media-name]")?.value === "Sunset ridge");
  await page.screenshot({ path: out("renamed-media") });

  // ---- G7: the Export dialog's range ----
  await page.click("[data-testid=bottom-timeline]");
  await page.mouse.click(await xOf(30), ruler.top + ruler.height - 6);
  await page.keyboard.press("i");
  await page.mouse.click(await xOf(150), ruler.top + ruler.height - 6);
  await page.keyboard.press("o");
  await page.click(item("b"));
  await page.keyboard.down("Meta");
  await page.keyboard.press("e");
  await page.keyboard.up("Meta");
  await waitFor("[data-testid=export-range]");
  const rangeOf = () => page.$eval("[data-testid=export-range-text]", (el) => [Number((el as HTMLElement).dataset.from), Number((el as HTMLElement).dataset.to)]);
  await page.click("[data-testid=export-range-marks]");
  const marks = await rangeOf();
  assert.ok(Math.abs(marks[0]! - 30) <= 2 && Math.abs(marks[1]! - 150) <= 2, `In to Out ${marks}`);
  await page.click("[data-testid=export-range-selection]");
  const bBox = await page.$eval(item("b"), (el) => [Number((el as HTMLElement).dataset.start), Number((el as HTMLElement).dataset.start) + Number((el as HTMLElement).dataset.duration)]);
  assert.deepEqual(await rangeOf(), bBox, "the selected clip's span");
  await page.click("[data-testid=export-range-custom]");
  await waitFor("[data-testid=export-range-from]");
  await page.screenshot({ path: out("export-range") });
  await page.click("[data-testid=export-close]");
});
