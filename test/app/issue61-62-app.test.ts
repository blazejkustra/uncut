// Issues #61 and #62 (D233) on the packaged app.
// #61: an image layer on the preview moves like a video: a press starts no native image drag (a
// ghost copy), a ⌘ drag moves it, a drag near the centre snaps, a corner handle resizes it.
// #62: with the preview panel tiny (the smallest window, the side panels and the timeline dragged
// to their largest), every transport control that's shown lies inside the window, the stage and
// the 40px bar, isn't covered by anything, doesn't overlap another; play and full screen stay.
// Screenshots: test-output/issue61-62-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/timeline/types.ts";
import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { eventually } from "../helpers/wait.ts";
import { notChecked, smallScreen } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test image") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `issue61-62-${name}.png`);

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const item = (id: string): Item => onDisk().tracks.flatMap((t) => t.items).find((i) => i.id === id)!;
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 10000 }, n);
const boxOf = async (selector: string) => {
  const b = await (await page.$(selector))?.boundingBox();
  assert.ok(b, `no box for ${selector}`);
  return b;
};
/** A press at `from`, moved by (dx, dy) screen px in steps, released; ⌘ held when `free`. */
async function drag(from: { x: number; y: number }, dx: number, dy: number, free: boolean) {
  if (free) await page.keyboard.down("Meta");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10, { steps: 2 });
  await sleep(80);
  await page.mouse.up();
  if (free) await page.keyboard.up("Meta");
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue61-62-")));
  const media = join(root, "media");
  mkdirSync(media);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:s=320x180", "-frames:v", "1", join(media, "Photo.png")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(media, "Bg.mp4")]);
  dir = writeProject(root, "Pictures", {
    format: "uncut/0",
    name: "Pictures",
    canvas: { width: 1280, height: 720, fps: 30, background: "#202020" },
    media: [
      { id: "m-photo", kind: "image", name: "Photo.png", path: join(media, "Photo.png"), probe: { width: 320, height: 180 } },
      { id: "m-bg", kind: "video", name: "Bg.mp4", path: join(media, "Bg.mp4"), probe: { frames: 90, fps: 30, width: 320, height: 180, hasAudio: false } },
    ],
    tracks: [
      { id: "top", kind: "video", name: "Top", items: [{ id: "photo", type: "clip", media: "m-photo", start: 0, duration: 90, transform: { x: 100, y: 100, w: 320, h: 180 } }] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "clip", media: "m-bg", in: 0, duration: 90 }] },
    ],
  } as Project);
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await page.setViewport({ width: 1280, height: 800 });
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('[data-testid=preview-media] img[data-item="photo"], [data-testid=preview-media] .pv-box[data-item="photo"] img');
    return !!img && img.complete && img.naturalWidth > 0;
  }, { timeout: 15000 });
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue #61: an image layer moves, snaps and resizes on the canvas; no native image drag", { skip, timeout: 120000 }, async () => {
  // A picture layer's <img> is not draggable; every <img> on the stage (an element's logo too, whose
  // draggable we don't set) has -webkit-user-drag: none; native drags on the frame are refused.
  const imgs = await page.$$eval("[data-testid=preview-frame] img", (els) => els.map((e) => ({ layer: !!e.closest(".pv-box"), draggable: (e as HTMLImageElement).draggable, userDrag: getComputedStyle(e).getPropertyValue("-webkit-user-drag") })));
  assert.ok(imgs.some((i) => i.layer), "the photo is an <img> on the stage");
  for (const i of imgs) assert.ok((!i.layer || !i.draggable) && i.userDrag === "none", `an <img> on the stage can be dragged natively: ${JSON.stringify(i)}`);
  await page.evaluate(() => {
    const w = window as unknown as { __dragstarts: Array<boolean> };
    w.__dragstarts = [];
    // Bubble phase on window: runs after the frame's own handler, so defaultPrevented tells whether it was refused.
    window.addEventListener("dragstart", (e) => w.__dragstarts.push(e.defaultPrevented));
  });

  const frame = await boxOf("[data-testid=preview-frame]");
  const k = frame.width / 1280;
  const centre = (t: { x: number; y: number; w: number; h: number }) => ({ x: frame.x + (t.x + t.w / 2) * k, y: frame.y + (t.y + t.h / 2) * k });
  // A click on the picture selects it (as a video layer).
  await page.mouse.click(centre({ x: 100, y: 100, w: 320, h: 180 }).x, centre({ x: 100, y: 100, w: 320, h: 180 }).y);
  await page.waitForSelector('[data-testid=clip-selection][data-item="photo"]');

  // ⌘ drag (no snapping): by (300, 100) canvas px.
  let r = await revision();
  await drag(centre({ x: 100, y: 100, w: 320, h: 180 }), 300 * k, 100 * k, true);
  await waitRevision(r + 1);
  let t = item("photo").transform!;
  assert.ok(Math.abs(t.x! - 400) <= 3 && Math.abs(t.y! - 200) <= 3 && t.w === 320 && t.h === 180, `moved to ${JSON.stringify(t)}`);
  const starts = await page.evaluate(() => (window as unknown as { __dragstarts: Array<boolean> }).__dragstarts);
  assert.ok(starts.every((prevented) => prevented), `a native drag started on the canvas: ${JSON.stringify(starts)}`);
  await page.screenshot({ path: out("image-moved") });

  // A drag that ends a few px off the centre line snaps onto it (x = 640 − 160).
  r = await revision();
  const now = { x: t.x!, y: t.y!, w: 320, h: 180 };
  await drag(centre(now), (480 - now.x + 5) * k, 0, false);
  await waitRevision(r + 1);
  t = item("photo").transform!;
  assert.equal(t.x, 480, `snapped to the centre: ${JSON.stringify(t)}`);

  // The south-east corner handle resizes it by 64 canvas px (shape kept).
  const handle = await boxOf("[data-testid=clip-handle][data-handle=se]");
  r = await revision();
  await drag({ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, 64 * k, 36 * k, true);
  await waitRevision(r + 1);
  t = item("photo").transform!;
  assert.ok(Math.abs(t.w! - 384) <= 4 && Math.abs(t.h! - 216) <= 4 && t.x === 480, `resized to ${JSON.stringify(t)}`);
  const starts2 = await page.evaluate(() => (window as unknown as { __dragstarts: Array<boolean> }).__dragstarts);
  assert.ok(starts2.every((prevented) => prevented), `a native drag started on the canvas: ${JSON.stringify(starts2)}`);
  await page.screenshot({ path: out("image-resized") });
});

const CONTROLS = ["timecode", "to-start", "step-back", "play", "step-forward", "to-end", "canvas-info", "preview-zoom", "preview-hand", "preview-fullscreen"];

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Control = { id: string; shown: false } | { id: string; shown: true; r: Box; onTop: boolean; hitWas: string; clipped: boolean };
type Report = { win: { width: number; height: number }; bar: Box; stage: Box; controls: Array<Control> };

/** Every shown transport control: inside the window, the stage and the bar; on top at its centre; no two overlap. */
async function checkTransport(label: string) {
  const report: Report = await page.evaluate((ids: Array<string>): Report => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const bar = document.querySelector(".transport")!;
    const stage = document.querySelector("[data-testid=stage]")!;
    const controls = ids.flatMap((id): Array<Control> => {
      const el = document.querySelector(`[data-testid=${id}]`);
      if (!el) return [];
      const r = rect(el);
      if (getComputedStyle(el).display === "none" || r.width === 0 || r.height === 0) return [{ id, shown: false as const }];
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // Content wider than the box (a clipped label) shows as scrollWidth > clientWidth; the canvas label may end in an ellipsis.
      const clipped = el instanceof HTMLElement && el.tagName !== "SELECT" && id !== "canvas-info" && el.scrollWidth > el.clientWidth + 1;
      return [{ id, shown: true as const, r, onTop: !!hit && (hit === el || el.contains(hit)), hitWas: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : "nothing", clipped }];
    });
    return { win: { width: window.innerWidth, height: window.innerHeight }, bar: rect(bar), stage: rect(stage), controls };
  }, CONTROLS);
  const shown = report.controls.filter((c): c is Extract<Control, { shown: true }> => c.shown);
  const ids = shown.map((c) => c.id);
  assert.ok(ids.includes("play") && ids.includes("preview-fullscreen"), `${label}: play and full screen are shown (${ids.join(", ")})`);
  assert.ok(Math.abs(report.bar.height - 40) <= 1, `${label}: the bar is 40px tall (${report.bar.height})`);
  const inside = (r: { left: number; top: number; right: number; bottom: number }, o: { left: number; top: number; right: number; bottom: number }) => r.left >= o.left - 0.5 && r.top >= o.top - 0.5 && r.right <= o.right + 0.5 && r.bottom <= o.bottom + 0.5;
  const winBox = { left: 0, top: 0, right: report.win.width, bottom: report.win.height };
  for (const c of shown) {
    if (!c.shown) continue;
    assert.ok(inside(c.r, winBox), `${label}: ${c.id} is outside the window ${JSON.stringify(c.r)}`);
    assert.ok(inside(c.r, report.stage), `${label}: ${c.id} is outside the stage ${JSON.stringify(c.r)} vs ${JSON.stringify(report.stage)}`);
    assert.ok(inside(c.r, report.bar), `${label}: ${c.id} is outside the bar ${JSON.stringify(c.r)} vs ${JSON.stringify(report.bar)}`);
    assert.ok(c.onTop, `${label}: ${c.id} is covered by ${c.hitWas}`);
    assert.ok(!c.clipped, `${label}: ${c.id}'s content is cut off`);
  }
  for (let i = 0; i < shown.length; i++)
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i]!;
      const b = shown[j]!;
      if (!a.shown || !b.shown) continue;
      const overlap = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left) > 0.5 && Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top) > 0.5;
      assert.ok(!overlap, `${label}: ${a.id} and ${b.id} overlap`);
    }
  return { ids, stage: report.stage };
}

/** Drags a panel's resize handle by (dx, dy) screen px. */
async function resize(panel: "lib" | "side" | "bottom", dx: number, dy: number) {
  const b = await boxOf(`[data-testid=resize-${panel}]`);
  const from = { x: b.x + b.width / 2, y: panel === "bottom" ? b.y + b.height / 2 : b.y + 60 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8, { steps: 2 });
  await page.mouse.up();
  await sleep(250);
}

test("issue #62: the transport fits a tiny preview panel: shown controls inside the window, uncovered, not overlapping", { skip, timeout: 120000 }, async () => {
  const roomy = await checkTransport("1280×800");
  assert.ok(roomy.ids.length === CONTROLS.length, `all controls shown with room: ${roomy.ids.join(", ")}`);
  await page.screenshot({ path: out("roomy") });

  await page.setViewport({ width: 1024, height: 640 });
  await sleep(400);
  await checkTransport("1024×640");
  await page.screenshot({ path: out("small-window") });

  // The timeline as tall as it goes, then the side panels as wide as they go: the preview is tiny.
  await resize("bottom", 0, -600);
  const short = await checkTransport("1024×640, tall timeline");
  await page.screenshot({ path: out("short") });
  await resize("lib", 600, 0);
  await resize("side", -600, 0);
  const tiny = await checkTransport("1024×640, tiny preview");
  await page.screenshot({ path: out("tiny") });
  assert.ok(tiny.stage.width < 260 && tiny.stage.height < 200, `the preview panel is tiny: ${JSON.stringify(tiny.stage)} (short: ${JSON.stringify(short.stage)})`);
  // The picture gave way, not the bar: the frame is inside the stage, above the bar.
  const frame = await boxOf("[data-testid=preview-frame]");
  const bar = await boxOf(".transport");
  assert.ok(frame.y + frame.height <= bar.y + 0.5, `the picture ends above the bar (${frame.y + frame.height} vs ${bar.y})`);

  // Wider again: the hidden controls come back. Back to the window's own 1280×800 rather than an
  // emulated one: Chromium keeps an emulated viewport within the screen (#89: 1024 wide on the runner).
  await page.setViewport(null);
  const small = await smallScreen(page, 1280, 800);
  if (small) return notChecked(small, "the transport's controls all come back at 1280×800");
  await page.evaluate(() => localStorage.removeItem("uncut.layout"));
  for (const p of ["lib", "side", "bottom"] as const) await page.click(`[data-testid=resize-${p}]`, { clickCount: 2 });
  // The panels animate back to their sizes: poll until the bar has room again (#89: 400 ms wasn't
  // enough on a slow runner), then check it.
  await eventually(async () => (await checkTransport("1280×800 again")).ids.length === CONTROLS.length);
  const back = await checkTransport("1280×800 again");
  assert.equal(back.ids.length, CONTROLS.length, `all controls back: ${back.ids.join(", ")}`);
});
