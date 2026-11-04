// D327 on the packaged app: a speed ramp and a reversed clip in the preview, paused at chosen frames,
// show the source frame the export shows there (and core's sourceAt says). The source (640×360,
// 30 fps, 150 frames) shows its frame number as an 8-bit barcode (8 black or white columns, bit k in
// column k), read back from preview screenshots and export frames alike. The reversed clip's copy is
// made in the background ("Preparing the reversed clip" until then). Then the Inspector: a ramp
// preset and Play backwards are one edit each. Screenshots test-output/speed-ramp-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { layout, presetKeys, RAMP_PRESETS, sourceAt, type Item, type Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { viewerPrefs } from "../helpers/viewer-prefs.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test clip") : `packaged app not built: run pnpm dist to create ${APP}`;
const W = 640;
const H = 360;
const FPS = 30;
const FRAMES = 150;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

const ramp: Item = { id: "c0", type: "clip", media: "m", in: 10, duration: 60, speedKeys: presetKeys(RAMP_PRESETS.hero!, 60) };
const reversed: Item = { id: "c1", type: "clip", media: "m", in: 20, duration: 45, reverse: true };
const project = (media: string): Project => ({
  format: "uncut/0",
  name: "Ramp",
  canvas: { width: W, height: H, fps: FPS, background: "#000000" },
  media: [
    { id: "m", kind: "video", name: "Bars.mp4", path: join(media, "Bars.mp4"), probe: { frames: FRAMES, fps: FPS, width: W, height: H, hasAudio: false } },
  ],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [ramp, reversed] }],
});

/** The frame number a picture shows: its barcode's 8 columns, sampled across its middle half. */
function barcode(file: string): number {
  const px = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    "crop=iw:ih/2:0:ih/4,scale=8:1:flags=area,format=gray",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
  return [...px].reduce((n, v, k) => n + (v > 128 ? 1 << k : 0), 0);
}

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const itemOf = (id: string) => onDisk().tracks[0]!.items.find((i) => i.id === id)!;
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r,
    { timeout: 10000 },
    n,
  );
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
async function goTo(frame: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)),
    { timeout: 10000 },
  );
  await sleep(400);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ramp-app-")));
  mkdirSync(join(root, "media"), { recursive: true });
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${W}x${H}:r=${FPS}:d=${FRAMES / FPS},format=yuv420p,geq=lum='if(mod(floor(N/pow(2\\,floor(X*8/W)))\\,2)\\,235\\,16)':cb=128:cr=128`,
    "-c:v",
    "libx264",
    "-qp",
    "0",
    "-g",
    "10",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "4",
    join(root, "media", "Bars.mp4"),
  ]);
  dir = writeProject(root, "Ramp", project(join(root, "media")));
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "D327: a speed ramp and a reversed clip, paused, show in the preview the source frames the export shows; the Inspector sets them",
  { skip, timeout: 600000 },
  async () => {
    const saveAs = join(root, "out", "Ramp.mp4");
    app = await launchApp({
      command: APP,
      env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") },
    });
    page = app.page;
    await waitForWelcome(page);
    await viewerPrefs(page, { gpu: false });
    await page.click("[data-testid=open-project]");
    await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
    await page.waitForSelector("[data-testid=timeline-item][data-item=c1]");
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("Escape");

    // The reversed clip says it's being prepared until its copy is made, then plays it.
    const start1 = layout(project(root)).starts.get("c1")!;
    await goTo(start1 + 5);
    const note = await page.$eval("[data-reverse-pending=c1]", (el) => el.textContent ?? "").catch(() => "");
    if (note) assert.match(note, /Preparing the reversed clip/);
    await page.waitForFunction(() => !document.querySelector("[data-reverse-pending]") && !!document.querySelector("video[data-item=c1]"), { timeout: 60000 });
    console.log(`  before its copy was made the reversed clip said: ${note || "(already made)"}`);

    const p = project(root);
    const frames = [2, 17, 25, 33, 41, 58, start1 + 0, start1 + 14, start1 + 44];
    const preview = new Map<number, number>();
    for (const f of frames) {
      await goTo(f);
      const path = out(`speed-ramp-preview-${f}.png`);
      await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
      preview.set(f, barcode(path));
    }
    const want = (f: number) => {
      const item = f < start1 ? ramp : reversed;
      const local = f - (f < start1 ? 0 : start1);
      if (!item.reverse) return Math.floor((sourceAt(p, item, local) + 0.0001) * FPS + 1e-9);
      return FRAMES - 1 - (20 + local);
    };

    await meta("e");
    await page.waitForSelector("[data-testid=export-form]");
    await page.click("[data-testid=quality-standard]");
    await page.click("[data-testid=loudness-off]");
    await page.click("[data-testid=export-change]");
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Ramp.mp4");
    await page.click("[data-testid=export-start]");
    await page.waitForSelector("[data-testid=export-job]");
    let phase = "";
    for (let i = 0; i < 3000 && phase !== "done" && phase !== "failed"; i++) {
      phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
      await sleep(100);
    }
    assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
    const rows: Array<string> = [];
    for (const f of frames) {
      const file = out(`speed-ramp-export-${f}.png`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", file]);
      const exported = barcode(file);
      rows.push(`${f}: preview ${preview.get(f)}, export ${exported}, core ${want(f)}`);
      assert.equal(preview.get(f), exported, `frame ${f}: preview ${preview.get(f)} vs export ${exported}`);
      assert.equal(exported, want(f), `frame ${f}: export ${exported} vs core ${want(f)}`);
    }
    console.log(`  source frames shown:\n    ${rows.join("\n    ")}`);
    await page.keyboard.press("Escape");

    // The Inspector: a preset is one edit; Play backwards is one edit.
    await page.click("[data-testid=timeline-item][data-item=c0]");
    await page.click("[data-testid=tab-inspector]");
    await page.waitForSelector("[data-testid=insp-sec-speed]");
    if (await page.$("[data-testid=insp-sec-speed][data-open=false]")) await page.click("[data-testid=insp-sec-speed-toggle]");
    await page.waitForSelector("[data-testid=speed-ramp-editor]");
    let r = await revision();
    await page.click("[data-testid=insp-ramp-bullet]");
    await waitRevision(r + 1);
    const bullet = itemOf("c0");
    assert.deepEqual(bullet.speedKeys, presetKeys(RAMP_PRESETS.bullet!, bullet.duration));
    await page.waitForSelector("[data-testid=insp-ramp-bullet][aria-pressed=true]");
    assert.equal((await page.$$("[data-testid=insp-ramp-key]")).length, 4);
    // A constant speed and Keep pitch mean nothing on a ramp: they're hidden.
    assert.equal(await page.$("[data-testid=insp-keep-pitch]"), null);
    assert.equal(await page.$("[data-testid=insp-speed-custom]"), null);
    r = await revision();
    await page.click("[data-testid=insp-reverse]");
    await waitRevision(r + 1);
    assert.equal(itemOf("c0").reverse, true);
    await page.waitForSelector("[data-testid=timeline-item][data-item=c0] [data-testid=clip-reverse]");
    await page.screenshot({ path: out("speed-ramp-inspector.png") });
    r = await revision();
    await page.click("[data-testid=insp-ramp-none]");
    await waitRevision(r + 1);
    assert.equal(itemOf("c0").speedKeys, undefined);
  },
);
