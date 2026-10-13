// Iris, push and zoom (D79) on the packaged app (background window), through the UI only. Four
// clips on main, 1280×720 with a grey canvas: pattern | split | pattern | split (testsrc2 and the
// 4:3 red/blue split clip, test/helpers/clip-fixture.ts), cuts at 60, 120 and 180.
// - The Transitions panel offers the three new tiles; selecting each cut and clicking a tile puts
//   an iris on 60, a push on 120 and a zoom on 180 (15 frames each, one labelled edit each).
// - Scrubbed to the middle of each, the preview draws it: the incoming clip's box clipped to a
//   circle (iris), both boxes moved half the width (push), the outgoing picture 1.1× (zoom).
//   Screenshots test-output/transitions-{iris,push,zoom}.png.
// - The preview vs a Standard export (⌘E) at a quarter and the middle of each: SSIM ≥ 0.97
//   (screenshots converted from Display P3 to sRGB when the screen is P3), as clip-transform-app does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../packages/core/src/types.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "./helpers/app.ts";
import { writeProject } from "./helpers/export-fixture.ts";
import { makeClipMedia, PATTERN_PROBE, SPLIT_PROBE } from "./helpers/clip-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test clips") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

function project(media: string): Project {
  return {
    format: "uncut/0",
    name: "Moves",
    canvas: { width: 1280, height: 720, fps: 30, background: "#808080" },
    media: [
      { id: "m-pattern", kind: "video", name: "Pattern.mp4", path: join(media, "Pattern.mp4"), probe: PATTERN_PROBE },
      { id: "m-split", kind: "video", name: "Split.mp4", path: join(media, "Split.mp4"), probe: SPLIT_PROBE },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "p1", type: "clip", media: "m-pattern", in: 30, duration: 60 },
          { id: "s1", type: "clip", media: "m-split", in: 30, duration: 60 },
          { id: "p2", type: "clip", media: "m-pattern", in: 100, duration: 60 },
          { id: "s2", type: "clip", media: "m-split", in: 100, duration: 60 },
        ],
      },
    ],
  };
}

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const transitionOf = (id: string) => onDisk().tracks[0]!.items.find((i) => i.id === id)!.transitionIn;
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 10000 }, n);
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
const historyLabels = () => {
  const db = new DatabaseSync(join(dir, "history.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT label FROM revisions WHERE kind = 'edit' ORDER BY revision").all() as Array<{ label: string }>).map((r) => r.label);
  } finally {
    db.close();
  }
};
/** Seek by keyboard (Home, ⇧→ for seconds, → for frames) and wait for the videos to settle. */
async function goTo(frame: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)), { timeout: 10000 });
  await sleep(250);
}
const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
async function screenshotSpace(): Promise<"srgb" | "p3"> {
  await page.evaluate(() => {
    const e = document.createElement("div");
    e.id = "red-probe";
    e.style.cssText = "position:fixed;left:0;top:0;width:40px;height:40px;background:#f00;z-index:99999";
    document.body.append(e);
  });
  const path = out("transitions-red-probe.png");
  await (await page.$("#red-probe"))!.screenshot({ path });
  await page.evaluate(() => document.getElementById("red-probe")!.remove());
  const [r, g] = [...execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "crop=8:8:16:16,scale=1:1,format=rgb24", "-f", "rawvideo", "-"])];
  return r! > 245 && g! < 10 ? "srgb" : "p3";
}
function toSrgb(png: string) {
  const outPath = png.replace(/\.png$/, "-srgb.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", png, "-vf", "scale=out_color_matrix=bt709:out_range=pc,format=yuv444p,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=pc,colorspace=primaries=bt709:trc=iec61966-2-1:space=bt709:range=pc:format=yuv444p,scale=in_color_matrix=bt709:in_range=pc,format=rgb24", outPath]);
  return outPath;
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-moves-app-")));
  makeClipMedia(join(root, "media"));
  dir = writeProject(root, "Moves", project(join(root, "media")));
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("iris, push and zoom: applied from the panel, drawn in the preview mid-way, the export matches (D79)", { skip, timeout: 300000 }, async () => {
  const saveAs = join(root, "out", "Moves.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await page.waitForSelector("[data-testid=welcome]", { timeout: 15000 });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

  // The panel offers them.
  await page.click("[data-testid=rail-transitions]");
  await page.waitForSelector("[data-testid=transitions-library]");
  const tiles = await page.$$eval("[data-testid=transition-tile]", (els) => els.map((e) => (e as HTMLElement).dataset.module));
  for (const m of ["transition.iris", "transition.push-left", "transition.zoom"]) assert.ok(tiles.includes(m), `${m} offered: ${tiles}`);

  // Select each cut, click the tile: one edit each, the default 0.5 s (15 frames).
  for (const [cut, id, module] of [
    [60, "s1", "transition.iris"],
    [120, "p2", "transition.push-left"],
    [180, "s2", "transition.zoom"],
  ] as const) {
    await page.click(`[data-testid=cut-point][data-frame='${cut}']`);
    await page.waitForSelector(`[data-testid=inspector-transition][data-item=${id}]`);
    const rev = await revision();
    await page.click(`[data-testid=transition-tile][data-module='${module}']`);
    await waitRevision(rev + 1);
    assert.deepEqual(transitionOf(id), { module, duration: 15 });
    await page.waitForSelector(`[data-testid=transition-marker][data-item="${id}"][data-module="${module}"]`);
    assert.equal(await page.$eval("[data-testid=insp-transition-type]", (el) => (el as HTMLSelectElement).value), module);
  }
  assert.deepEqual(historyLabels().slice(-3), ["Added iris", "Added push", "Added zoom"]);

  // The preview mid-way through each (frames 60, 120, 180: share 0.5).
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  const space = await screenshotSpace();
  const frames = [56, 60, 116, 120, 176, 180];
  const names: Record<number, string> = { 60: "transitions-iris.png", 120: "transitions-push.png", 180: "transitions-zoom.png" };
  const preview = new Map<number, string>();
  for (const f of frames) {
    await goTo(f);
    if (f === 60) {
      // The incoming split clip's box is clipped to a circle of radius 0.5 · hypot(1280, 720) / 2 = 367.2 px at the canvas's centre.
      const clip = await page.$eval(".pv-box[data-item=s1]", (el) => (el as HTMLElement).style.clipPath);
      assert.match(clip, /^circle\(367\.\d+px at 640px 360px\)$/, `iris clip ${clip}`);
      assert.equal(await page.$eval(".pv-box[data-item=p1]", (el) => (el as HTMLElement).style.clipPath), "");
    }
    if (f === 120) {
      // Both boxes moved half the width: the outgoing one to −640, the incoming one to 640.
      assert.equal(await page.$eval(".pv-box[data-item=s1]", (el) => (el as HTMLElement).style.left), "-640px");
      assert.equal(await page.$eval(".pv-box[data-item=p2]", (el) => (el as HTMLElement).style.left), "640px");
    }
    if (f === 180) {
      // The outgoing picture 1.1× about the centre (its box stays the canvas), the incoming one half faded in.
      assert.equal(await page.$eval(".pv-box[data-item=p2]", (el) => (el as HTMLElement).style.left), "0px");
      assert.equal(await page.$eval("video[data-item=p2]", (el) => (el as HTMLElement).style.width), "1408px");
      assert.equal(await page.$eval("video[data-item=p2]", (el) => (el as HTMLElement).style.left), "-64px");
      assert.equal(await page.$eval("video[data-item=s2]", (el) => (el as HTMLElement).style.opacity), "0.5");
    }
    const path = out(names[f] ?? `transitions-moves-${f}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    preview.set(f, space === "p3" ? toSrgb(path) : path);
  }

  // Export (Standard, loudness as mixed) and compare.
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Moves.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 1200 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  for (const f of frames) {
    const exported = out(`transitions-moves-${f}-export.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(preview.get(f)!, exported);
    console.log(`  frame ${f}: export vs preview SSIM ${score.toFixed(4)} (screenshots in ${space})`);
    assert.ok(score >= 0.97, `frame ${f}: SSIM ${score}`);
  }
  assert.deepEqual(app.errors, []);
});
