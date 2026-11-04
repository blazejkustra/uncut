// D328 on the packaged app: background removal and face blur in the preview match the export, and
// Text behind subject is one edit. The vision results are a known matte (a white square moving
// right, a soft edge) and known face boxes written into the project's vision cache under the keys
// the bundled Apple Vision module's requests have, so nothing is analysed and the frames are
// exact. Colours.mp4 (test/helpers/fx-fixture.ts) with the cutout over a blue clip at frame 15 and
// with face blur at frame 45: preview screenshot vs a Standard export, SSIM on luma and the mean
// colour difference. Screenshots test-output/vision-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/timeline/types.ts";
import { fingerprint } from "../../apps/server/src/analysis/analysis.ts";
import { visionFiles } from "../../apps/server/src/analysis/vision/visionCache.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { viewerPrefs } from "../helpers/viewer-prefs.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { makeColours } from "../helpers/fx-fixture.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const HELPER = resolve("dist/mac-arm64/Uncut.app/Contents/Resources/bin/uncut-vision");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(APP) || !existsSync(HELPER) ? `packaged app not built: run pnpm dist to create ${APP}` : hasFfmpeg ? false : "needs ffmpeg";

const W = 1280;
const H = 720;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

const FACES = {
  start: 0,
  end: 2,
  fps: 30,
  width: W,
  height: H,
  frames: Array.from({ length: 60 }, (_, i) => ({ t: i / 30, faces: [{ id: 3, x: 0.3 + i * 0.004, y: 0.25, w: 0.22, h: 0.4, confidence: 0.9 }] })),
};

function project(media: string): Project {
  const colours = {
    id: "m-colours",
    kind: "video" as const,
    name: "Colours.mp4",
    path: join(media, "Colours.mp4"),
    probe: { frames: 60, fps: 30, width: W, height: H, hasAudio: false },
  };
  const blue = {
    id: "m-blue",
    kind: "video" as const,
    name: "Blue.mp4",
    path: join(media, "Blue.mp4"),
    probe: { frames: 60, fps: 30, width: W, height: H, hasAudio: false },
  };
  const main: Array<Item> = [
    { id: "under", type: "clip", media: "m-blue", in: 0, duration: 30 },
    {
      id: "faces",
      type: "clip",
      media: "m-colours",
      in: 30,
      duration: 30,
      effects: [{ module: "effect.face-blur", params: { amount: 16, shape: "ellipse", feather: 20, padding: 0.1 } }],
    },
  ];
  return {
    format: "uncut/0",
    name: "Vision",
    canvas: { width: W, height: H, fps: 30, background: "#808080" },
    media: [colours, blue],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ id: "title", type: "text", text: "BEHIND", start: 0, duration: 30 }] },
      {
        id: "top",
        kind: "video",
        name: "Top",
        items: [
          {
            id: "cut",
            type: "clip",
            media: "m-colours",
            start: 0,
            in: 0,
            duration: 30,
            effects: [{ module: "effect.cutout", params: { mode: "person", softness: 1, shrink: 0 } }],
          },
        ],
      },
      { id: "main", kind: "video", role: "main", name: "Main", items: main },
    ],
  };
}

/** The matte and faces in the vision cache, under the keys the bundled module's requests have here. */
async function seedVision(projectDir: string, file: string) {
  const manifest = JSON.parse(readFileSync(resolve("plugins/apple-vision/uncut.module.json"), "utf8")) as { id: string; version: string };
  const helper = execFileSync(HELPER, ["version"], { encoding: "utf8" }).trim();
  const module = { id: manifest.id, version: `${manifest.version}+${helper}` };
  const fp = await fingerprint(file);
  const matte = visionFiles(projectDir, fp, { output: "matte", start: 0, end: 2, mode: "person", module });
  mkdirSync(join(matte.video, ".."), { recursive: true });
  execFileSync("ffmpeg", [
    ...["-v", "error", "-y", "-threads", "4", "-f", "lavfi", "-i"],
    `color=c=black:s=${W}x${H}:r=30:d=2,format=gray,geq=lum='255*clip(min(min(X-(240+8*N),720+8*N-X),min(Y-160,560-Y))/12+0.5,0,1)'`,
    ...["-c:v", "ffv1", "-level", "3", "-g", "1", matte.video],
  ]);
  const times = Array.from({ length: 60 }, (_, i) => Math.round((i / 30) * 1e6) / 1e6);
  writeFileSync(
    matte.json,
    JSON.stringify({ format: "uncut.matte/1", mode: "person", start: 0, end: 2, fps: 30, width: W, height: H, frames: 60, times, module }),
  );
  const faces = visionFiles(projectDir, fp, { output: "faces", start: 0, end: 2, module });
  writeFileSync(faces.json, JSON.stringify({ ...FACES, module }));
}

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r,
    { timeout: 15000 },
    n,
  );
async function goTo(frame: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLVideoElement>("video[data-item], video[data-matte]")].every(
        (v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2),
      ),
    { timeout: 15000 },
  );
  await sleep(500);
}
function compare(a: string, b: string) {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const ssim = Number(/All:([\d.]+)/.exec(r.stderr)![1]);
  const pa = rgb(a, 48, 27);
  const pb = rgb(b, 48, 27);
  let d = 0;
  for (let i = 0; i < pa.length; i++) d += Math.abs(pa[i]! - pb[i]!);
  return { ssim, colour: d / pa.length };
}
const rgb = (file: string, w: number, h: number) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${w}:${h}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], {
    maxBuffer: 64 << 20,
  });

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-vision-app-")));
  mkdirSync(join(root, "media"), { recursive: true });
  makeColours(join(root, "media", "Colours.mp4"), W, H, 2);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x2040d0:s=${W}x${H}:r=30:d=2`,
    "-c:v",
    "libx264",
    "-crf",
    "6",
    "-pix_fmt",
    "yuv420p",
    join(root, "media", "Blue.mp4"),
  ]);
  dir = writeProject(root, "Vision", project(join(root, "media")));
  await seedVision(dir, join(root, "media", "Colours.mp4"));
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("D328: background removal and face blur in the preview match the export; Text behind subject is one edit", { skip, timeout: 600000 }, async () => {
  const saveAs = join(root, "out", "Vision.mp4");
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") },
  });
  page = app.page;
  await waitForWelcome(page);
  await viewerPrefs(page, { gpu: false });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.waitForSelector("[data-testid=timeline-item][data-item=faces]");
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");

  // The seeded results are found and the notes go; the cutout draws through the clip's canvas with its matte.
  const preview = new Map<string, string>();
  for (const [name, frame, id] of [
    ["cutout", 15, "cut"],
    ["faceblur", 45, "faces"],
  ] as const) {
    await goTo(frame);
    await page.waitForFunction((i) => document.querySelector<HTMLCanvasElement>(`canvas[data-fx=${i}]`)?.style.visibility === "", { timeout: 20000 }, id);
    await page.waitForFunction((i) => !document.querySelector(`[data-vision-note=${i}]`), { timeout: 60000 }, id);
    if (name === "cutout") await page.waitForSelector("video[data-matte=cut]");
    await goTo(frame);
    const path = out(`vision-${name}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    preview.set(name, path);
  }

  // Export (Standard, loudness off) and compare.
  await page.keyboard.down("Meta");
  await page.keyboard.press("e");
  await page.keyboard.up("Meta");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Vision.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 3000 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  await page.keyboard.press("Escape");
  const scores: Array<string> = [];
  const low: Array<string> = [];
  for (const [name, frame] of [
    ["cutout", 15],
    ["faceblur", 45],
  ] as const) {
    const file = out(`vision-${name}-export.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-update", "1", file]);
    const r = compare(preview.get(name)!, file);
    scores.push(`${name} ${r.ssim.toFixed(4)} Δ${r.colour.toFixed(2)}`);
    if (!(r.ssim >= 0.96) || !(r.colour <= 4)) low.push(`${name}: SSIM ${r.ssim}, colour Δ ${r.colour.toFixed(2)}`);
  }
  console.log(`  preview vs export, luma SSIM and mean colour Δ:\n    ${scores.join("\n    ")}`);
  check(NO_REAL_GPU, low.length === 0, `preview vs export: ${low.join("; ")}`);
  // The export: blue where the matte is black, the clip inside the square.
  const frame = rgb(out("vision-cutout-export.png"), W, H);
  const at = (x: number, y: number) => [...frame.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
  assert.ok(at(60, 650)[2]! > 160 && at(60, 650)[0]! < 80, `outside the matte is the blue clip: ${at(60, 650)}`);

  // Text behind subject: select the title, one click, one edit; ⌘Z takes it back.
  await page.click("[data-testid=timeline-item][data-item=title]");
  await page.waitForSelector("[data-testid=insp-behind-subject-run]:not([disabled])");
  const before = await revision();
  await page.click("[data-testid=insp-behind-subject-run]");
  await waitRevision(before + 1);
  const p = onDisk();
  const top = p.tracks[0]!;
  assert.equal(top.kind, "video");
  assert.equal(p.tracks[1]!.id, "text");
  assert.equal(top.items[0]!.mute, true);
  assert.ok(top.items[0]!.effects!.some((e) => e.module === "effect.cutout"));
  await page.waitForSelector("[data-testid=preview-frame]");
  await goTo(15);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out("vision-behind.png") });
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  await waitRevision(before + 2);
  assert.equal(onDisk().tracks[0]!.id, "text");
});
