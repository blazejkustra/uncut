// Fable QA round 2, Export / Settings / Shell (planning/FEEDBACK.md F4, F25, F29–F32; D171–D175) on
// the packaged app, run invisibly and muted:
// - F4: every quality card says its codec (H.264); High exports H.264 (ffprobe); Advanced HEVC with
//   720p at 24 fps exports exactly that.
// - F29: the done dialog names the folder (the path in its tooltip); Copy path copies the file's path.
// - F30: Settings › App › New items: a transition, a photo and a text added afterwards get the lengths set there.
// - F31: a panel edge shows its grip line under the pointer, with the resize cursor.
// - F25: the Transcript tab has no how-to line.
// - F32: first launch: Skip setup on the first step lands in the app; Settings reopens the wizard.
// Screenshots: test-output/fable2-export-*.png, fable2-settings-*.png, fable2-shell-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;
const encoders = hasFfmpeg ? execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }) : "";
const hevcHere = /\b(hevc_videotoolbox|libx265)\b/.test(encoders);

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `fable2-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const textOf = (selector: string) => page.$eval(selector, (el) => el.textContent ?? "");
type Saved = { id: string; type: string; duration: number; media?: string; transitionIn?: { module: string; duration: number } };
const onDisk = (): { tracks: Array<{ id: string; role?: string; items: Array<Saved> }> } => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const allItems = () => onDisk().tracks.flatMap((t) => t.items);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((want) => Number(/revision (\d+)/.exec((document.querySelector("[data-testid=saved]") as HTMLElement | null)?.title ?? "")?.[1] ?? -1) >= want, { timeout: 15000 }, n);
const key = async (k: Parameters<Page["keyboard"]["press"]>[0], mod?: "Shift" | "Meta") => {
  if (mod) await page.keyboard.down(mod);
  await page.keyboard.press(k);
  if (mod) await page.keyboard.up(mod);
};
const rail = (id: string) => page.$eval(`[data-testid=rail-${id}]`, (el) => (el as HTMLElement).click());
const probe = (file: string) =>
  JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate", "-of", "json", file], { encoding: "utf8" })).streams[0] as { codec_name: string; width: number; height: number; r_frame_rate: string };
const waitExport = async () => {
  await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")?.dataset.phase ?? ""), { timeout: 180000 });
  assert.equal(await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase), "done", await textOf("[data-testid=export-job]"));
};
const typeInto = async (selector: string, value: string) => {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.type(value);
  await key("Enter");
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-fable2-shell-")));
  mkdirSync(join(root, "out"));
  const ff = (args: Array<string>, file: string) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args, join(root, file)]);
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"], "Shot.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360", "-frames:v", "1"], "Still.png");
  dir = join(root, "Shell.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Shell",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [
        { id: "m-shot", kind: "video", name: "Shot.mp4", path: join(root, "Shot.mp4"), probe: { frames: 180, fps: 30, width: 640, height: 360, hasAudio: true } },
        { id: "m-still", kind: "image", name: "Still.png", path: join(root, "Still.png"), probe: { width: 640, height: 360, hasAudio: false } },
      ],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "m-shot", in: 0, duration: 60 }, { id: "b", type: "clip", media: "m-shot", in: 60, duration: 60 }] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Fable QA round 2 (export, settings, shell): codecs, Advanced, the done dialog, default lengths, grips, transcript copy, Skip setup", { skip, timeout: 600000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, join(root, "out", "High.mp4")]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor("[data-testid=timeline-item][data-item=b]");

  // ---- F4: the cards say their codec; High is H.264 ----
  await page.click("[data-testid=export-button]");
  await waitFor("[data-testid=export-form]");
  // D212: Draft and Standard on the hardware encoder, High on the software one.
  for (const [q, enc] of [["draft", "hardware"], ["standard", "hardware"], ["high", "software"]]) assert.equal(await textOf(`[data-testid=quality-codec-${q}]`), `H.264, ${enc}`, q);
  assert.equal(await page.$("[data-testid=export-advanced-body]"), null, "Advanced starts collapsed");
  await page.click("[data-testid=quality-high]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "High.mp4");
  await page.screenshot({ path: out("export-dialog") });
  await page.click("[data-testid=export-start]");
  await waitExport();
  const high = join(root, "out", "High.mp4");
  assert.deepEqual(probe(high), { codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30/1" });

  // ---- F29: the folder by name, the path in the tooltip; Copy path ----
  assert.equal(await textOf("[data-testid=export-job-folder]"), "out");
  assert.equal(await page.$eval("[data-testid=export-job-folder]", (el) => el.getAttribute("title")), join(root, "out"));
  assert.equal(await page.$eval("[data-testid=export-job-where]", (el) => el.getAttribute("title")), high);
  assert.match(await textOf("[data-testid=export-job-where]"), /High\.mp4 in out, 1920×1080, 30 fps, H\.264/);
  const where = await page.$eval("[data-testid=export-job-where]", (el) => el.getBoundingClientRect().height);
  assert.ok(where < 50, `one line, not a wrapped path (${where} px)`);
  await waitFor("[data-testid=export-reveal]");
  await page.click("[data-testid=export-copy-path]");
  await page.waitForFunction(() => /Copied/.test(document.querySelector("[data-testid=export-copy-path]")?.textContent ?? ""), { timeout: 5000 });
  for (let i = 0; i < 50 && !app.output().includes(`[test] copied ${high}`); i++) await sleep(100);
  assert.ok(app.output().includes(`[test] copied ${high}`), "the path went to the clipboard");
  await page.screenshot({ path: out("export-done") });

  // ---- F4: Advanced: HEVC at 720p, 24 fps ----
  await page.click("[data-testid=export-again]");
  await waitFor("[data-testid=export-form]");
  await page.click("[data-testid=export-name]", { clickCount: 3 });
  await page.keyboard.type("Advanced");
  await page.click("[data-testid=export-advanced]");
  await waitFor("[data-testid=export-advanced-body]");
  // D212: the encoder row shows the preset's (High: software); Hardware moves High to VideoToolbox.
  assert.equal(await page.$eval("[data-testid=export-encoder-software]", (el) => el.getAttribute("aria-checked")), "true");
  await page.click("[data-testid=export-encoder-hardware]");
  assert.equal(await textOf("[data-testid=quality-codec-high]"), "H.264, hardware");
  await page.click("[data-testid=export-codec-hevc]");
  assert.match(await textOf("[data-testid=quality-codec-high]"), /^HEVC, /);
  await page.select("[data-testid=export-size]", "720");
  await page.select("[data-testid=export-fps]", "24");
  assert.match(await textOf("[data-testid=quality-high]"), /1280×720, 24 fps/);
  await page.screenshot({ path: out("export-advanced") });
  if (hevcHere) {
    await page.click("[data-testid=export-start]");
    await waitExport();
    assert.deepEqual(probe(join(root, "out", "Advanced.mp4")), { codec_name: "hevc", width: 1280, height: 720, r_frame_rate: "24/1" });
    assert.match(await textOf("[data-testid=export-job-where]"), /1280×720, 24 fps, HEVC/);
  } else console.log("# no HEVC encoder in this ffmpeg: the Advanced export wasn't run");
  await key("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"));

  // ---- F30: Settings › App › New items ----
  await key("Comma", "Meta");
  await waitFor("[data-testid=settings]");
  await page.click("[data-testid=settings-nav-app]");
  await waitFor("[data-testid=settings-defaults]");
  assert.equal(await page.$eval("[data-testid=settings-still-seconds]", (el) => (el as HTMLInputElement).value), "5");
  assert.equal(await page.$eval("[data-testid=settings-text-seconds]", (el) => (el as HTMLInputElement).value), "3");
  await page.select("[data-testid=settings-transition-length]", "1");
  await typeInto("[data-testid=settings-still-seconds]", "2");
  await typeInto("[data-testid=settings-text-seconds]", "4");
  await page.waitForFunction(() => localStorage.getItem("uncut.defaults.textSeconds") === "4" && localStorage.getItem("uncut.defaults.stillSeconds") === "2" && localStorage.getItem("uncut.transitionSeconds") === "1");
  assert.match(await textOf("[data-testid=settings-autosave]"), /Every change/);
  await page.screenshot({ path: out("settings-app") });
  await page.click("[data-testid=settings-close]");

  // A transition on the cut at 60 gets 1 s.
  await page.click("[data-testid=cut-point][data-frame='60']");
  await rail("transitions");
  await waitFor("[data-testid=transition-tile][data-module='transition.dip-to-black']");
  let rev = await revision();
  await page.click("[data-testid=transition-tile][data-module='transition.dip-to-black']");
  await waitRevision(rev + 1);
  assert.deepEqual(allItems().find((i) => i.id === "b")!.transitionIn, { module: "transition.dip-to-black", duration: 30 });
  // A photo gets 2 s.
  await key("Escape");
  await rail("media");
  rev = await revision();
  await page.click("[data-testid=media-tile][data-id=m-still] [data-testid=add-to-timeline]");
  await waitRevision(rev + 1);
  assert.equal(allItems().find((i) => i.media === "m-still")!.duration, 60);
  // A text gets 4 s.
  await rail("text");
  rev = await revision();
  await page.click("[data-testid=text-preset][data-preset=title]");
  await waitRevision(rev + 1);
  assert.equal(allItems().find((i) => i.type === "text")!.duration, 120);
  await sleep(300);
  await page.screenshot({ path: out("settings-applied") });

  // ---- F31: the grip line under the pointer ----
  const grip = (id: string) => page.$eval(`[data-testid=resize-${id}]`, (el) => ({ opacity: getComputedStyle(el, "::after").opacity, cursor: getComputedStyle(el).cursor }));
  await page.mouse.move(5, 5);
  await sleep(250);
  assert.equal((await grip("side")).opacity, "0", "no grip until the pointer is there");
  await page.hover("[data-testid=resize-side]");
  await sleep(250);
  assert.deepEqual(await grip("side"), { opacity: "1", cursor: "col-resize" });
  await page.screenshot({ path: out("shell-resizer") });
  await page.hover("[data-testid=resize-bottom]");
  await sleep(250);
  assert.deepEqual(await grip("bottom"), { opacity: "1", cursor: "row-resize" });

  // ---- F25: no how-to line in the Transcript tab ----
  await page.click("[data-testid=rail-transcript]");
  await waitFor("[data-testid=transcript-panel]");
  const panel = await textOf("[data-testid=transcript-panel]");
  assert.doesNotMatch(panel, /Click a word|⇧-click|drag or|cuts (it|them)|by deleting words/);
  await page.screenshot({ path: out("shell-transcript") });
  assert.deepEqual(app.errors, []);
  await app.close();
  app = undefined;

  // ---- F32: first launch: Skip setup on the first step; Settings reopens the wizard ----
  app = await launchApp({
    command: APP,
    cleanEnv: true,
    firstLaunch: true,
    env: { HOME: homedir(), USER: process.env.USER, LOGNAME: process.env.USER, TMPDIR: process.env.TMPDIR, SHELL: process.env.SHELL || "/bin/zsh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", UNCUT_DATA_DIR: join(root, "first"), UNCUT_TEST_DIALOG: "[]" },
  });
  page = app.page;
  await waitFor("[data-testid=onboarding]", 30000);
  assert.equal(await page.$$eval("[data-testid=wizard-skip]", (els) => els.length), 1);
  assert.equal(await textOf("[data-testid=wizard-skip]"), "Skip setup");
  await page.screenshot({ path: out("shell-wizard") });
  await page.click("[data-testid=wizard-skip]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=onboarding]"));
  await waitForWelcome(page);
  for (let i = 0; i < 20 && !existsSync(join(root, "first", "settings.json")); i++) await sleep(100);
  assert.equal(JSON.parse(readFileSync(join(root, "first", "settings.json"), "utf8")).onboarded, true);
  await page.screenshot({ path: out("shell-skipped") });
  await key("Comma", "Meta");
  await waitFor("[data-testid=settings-app]");
  await page.click("[data-testid=settings-setup]");
  await waitFor("[data-testid=onboarding]");
  await waitFor("[data-testid=wizard-skip]");
  await page.screenshot({ path: out("shell-wizard-again") });
});
