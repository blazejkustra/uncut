// Issue #43 (D220) on the packaged app, run invisibly: with a title over footage selected, the
// Elements tab's Background + offers Behind this and Whole edit; Behind this puts the background on
// a track right under the title's, for the title's time, drawn over the footage and under the
// title; the canvas menu offers its layer order like any item's; it drags to another track and
// trims like any item; with nothing selected + still covers the whole edit under Main.
// Screenshots: test-output/issue43-*.png.
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
const out = (name: string) => resolve("test-output", `issue43-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
type Saved = { id: string; type: string; start?: number; duration: number; component?: string };
type SavedTrack = { id: string; kind: string; name: string; role?: string; items: Array<Saved> };
const onDisk = (): { tracks: Array<SavedTrack> } => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const placed = (id: string) => {
  const tracks = onDisk().tracks;
  const at = tracks.findIndex((t) => t.items.some((i) => i.id === id));
  const i = tracks[at]?.items.find((x) => x.id === id);
  return i && { index: at, track: tracks[at]!.id, start: i.start, duration: i.duration };
};
const solids = () => onDisk().tracks.flatMap((t) => t.items.filter((i) => i.component === "component.solid").map((i) => i.id));
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
const centre = async (selector: string) => {
  const r = await rect(selector);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await sleep(120);
  await page.mouse.up();
};
const seek = async (frame: number) => {
  const ruler = await rect("[data-testid=ruler]");
  await page.mouse.click(await xOf(frame), ruler.top + ruler.height - 6);
  await page.waitForFunction(
    (f) => Math.abs(Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) - f) <= 1,
    { timeout: 5000 },
    frame,
  );
};
const menuIds = () =>
  page.$$eval("[data-testid=context-menu] .ctx-item", (els) =>
    els.map((e) => `${(e as HTMLElement).dataset.testid}${e.classList.contains("disabled") ? ":off" : ""}`),
  );
const zOf = (selector: string) => page.$eval(selector, (el) => Number((el as HTMLElement).style.zIndex));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue43-")));
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
  dir = join(root, "Issue43.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Issue43",
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
        { id: "overlay", kind: "video", name: "Overlay", items: [] },
        {
          id: "text",
          kind: "text",
          name: "Text",
          items: [
            {
              id: "t1",
              type: "text",
              start: 30,
              duration: 60,
              text: "Launch day",
              transform: { x: 160, y: 440 },
              style: { preset: "text.title", size: 140, weight: 700 },
            },
          ],
        },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "m-shot", in: 0, duration: 300 }] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "issue #43: a background behind a selected title, over the footage; layer menu, drag to another track, trim; Whole edit by default",
  { skip, timeout: 240000 },
  async () => {
    app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
    page = app.page;
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await waitFor("[data-testid=editor]");
    await waitFor(item("t1"));
    await page.click("[data-testid=bottom-timeline]");
    await page.$eval("[data-testid=rail-elements]", (el) => (el as HTMLElement).click());
    await waitFor("[data-testid=background-add]");

    // ---- Behind this: the title selected, + offers both ----
    await seek(200);
    await page.click(item("t1"));
    await page.click("[data-testid=background-add]");
    await waitFor("[data-testid=context-menu]");
    assert.deepEqual(await menuIds(), ["menu-background-behind", "menu-background-whole"]);
    await page.screenshot({ path: out("menu") });
    let rev = await revision();
    await page.click("[data-testid=menu-background-behind]");
    await waitRevision(rev + 1);
    const [bg] = solids();
    assert.ok(bg, "a background was added");
    const tracks = onDisk().tracks;
    const at = placed(bg)!;
    assert.equal(at.index, tracks.findIndex((t) => t.id === "text") + 1, "right under the title's track");
    assert.ok(at.index < tracks.findIndex((t) => t.role === "main"), "above Main: it covers the footage");
    assert.deepEqual([at.start, at.duration], [30, 60], "the title's time");
    // Drawn over the footage and under the title.
    await seek(60);
    await waitFor(`.pv-solid[data-item="${bg}"]`);
    const z = [await zOf(".pv-box[data-item=a]"), await zOf(`.pv-solid[data-item="${bg}"]`), await zOf(".pv-text[data-item=t1]")];
    assert.ok(z[0]! < z[1]! && z[1]! < z[2]!, `footage < background < title (z ${z})`);
    await sleep(300);
    await page.screenshot({ path: out("behind") });

    // ---- The canvas menu: its layer order like any item's ----
    const frame = await rect("[data-testid=preview-frame]");
    const corner = { x: frame.left + frame.width * 0.92, y: frame.top + frame.height * 0.9 };
    assert.equal(
      await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>("[data-item]")?.dataset.item, corner),
      bg,
      "the background is what's under the pointer there",
    );
    await page.mouse.click(corner.x, corner.y, { button: "right" });
    await waitFor("[data-testid=context-menu]");
    const ids = await menuIds();
    assert.ok(ids.includes("menu-bring-forward") && ids.includes("menu-send-backward"), ids.join(" | "));
    await page.screenshot({ path: out("canvas-menu") });
    rev = await revision();
    await page.click("[data-testid=menu-send-backward]");
    await waitRevision(rev + 1);
    assert.ok(placed(bg)!.index > onDisk().tracks.findIndex((t) => t.id === "text"), "sent back a layer");

    // ---- Drag it to the Overlay track, then trim its end like any item ----
    rev = await revision();
    const from = await centre(item(bg));
    await drag(from, { x: from.x, y: await laneY("overlay") });
    await waitRevision(rev + 1);
    assert.equal(placed(bg)!.track, "overlay");
    assert.equal(placed(bg)!.start, 30);
    rev = await revision();
    const edge = await centre(`${item(bg)} [data-testid=trim-end]`);
    await drag(edge, { x: edge.x - 20 * (await ppf()), y: edge.y });
    await waitRevision(rev + 1);
    const trimmed = placed(bg)!;
    assert.ok(trimmed.duration < 60 && trimmed.duration > 30, `trimmed to ${trimmed.duration}`);
    await sleep(300);
    await page.screenshot({ path: out("moved-trimmed") });

    // ---- Nothing selected: no question, the whole edit under Main ----
    await page.keyboard.press("Escape");
    await seek(150);
    await page.keyboard.press("Escape");
    rev = await revision();
    await page.click("[data-testid=background-add]");
    await waitRevision(rev + 1);
    assert.equal(await page.$("[data-testid=context-menu]"), null, "no menu without a selection");
    const whole = solids().find((id) => id !== bg)!;
    const w = placed(whole)!;
    assert.equal(w.index, onDisk().tracks.findIndex((t) => t.role === "main") + 1, "right under Main");
    assert.deepEqual([w.start, w.duration], [0, 300]);
    await page.screenshot({ path: out("whole-edit") });
    assert.deepEqual(app.errors, []);
  },
);
