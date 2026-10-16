// Issues #68, #73 and #74 (D240) on the packaged app (background window). The D73 transition
// fixture (four solid-colour clips on main) plus Talk.mp4 (a clip with sound) and a generated
// picture (source generate.svg, with its prompt).
// - #68: the Transitions panel has its search but no kind filters and no length chips; thumbnails
//   hold a still until a tile is hovered, play while it is, and stop when the pointer leaves.
// - #73: the Analyze button on a clip with sound is a waveform (no speedometer anywhere) with a
//   tooltip saying what it does; a clip without sound has none.
// - #74: Media › Generated shows the generated picture as an ordinary media tile (same size as the
//   others) with a small Generated badge (an icon labelled Generated); the prompt is its tooltip; Edit prompt is in its menu.
// Screenshots: test-output/issue68-transitions.png, issue73-74-media.png, issue74-list.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/timeline/types.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { makeTransitionMedia, transitionProject } from "../helpers/transition-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test clips") : `packaged app not built: run pnpm dist to create ${APP}`;
const PROMPT = "A red kite on a pale sky";

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const box = async (selector: string) => {
  const b = await (await page.$(selector))?.boundingBox();
  assert.ok(b, `no box for ${selector}`);
  return b;
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue68-73-74-")));
  const media = join(root, "media");
  makeTransitionMedia(media);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=640x360:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(media, "Talk.mp4")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xdde6f0:s=640x360", "-frames:v", "1", join(media, "Kite.png")]);
  const base: Project = transitionProject(media, {});
  const project: Project = { ...base, media: [
    ...base.media,
    { id: "m-talk", kind: "video", name: "Talk.mp4", path: join(media, "Talk.mp4"), probe: { frames: 120, fps: 30, width: 640, height: 360, hasAudio: true } },
    { id: "m-kite", kind: "image", name: "Red kite", path: join(media, "Kite.png"), probe: { width: 640, height: 360 }, source: { module: "generate.svg", prompt: PROMPT, kind: "image" } } as Project["media"][number],
  ] };
  dir = writeProject(root, "Issue68", project);
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issues #68, #73, #74: transitions preview on hover only, no filters or length; a clear Analyze button; compact Generated tiles", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

    // #68: the panel has the search, no kinds, no length.
    await page.click("[data-testid=rail-transitions]");
    await page.waitForSelector("[data-testid=transitions-library]");
    assert.ok(await page.$("[data-testid=transition-search]"), "the search stays");
    for (const gone of ["transition-kinds", "transition-kind", "transition-lengths", "transition-length"]) assert.equal(await page.$(`[data-testid=${gone}]`), null, `no ${gone}`);
    assert.ok(!/\bLength\b/.test(await page.$eval("[data-testid=transitions-library]", (el) => (el as HTMLElement).innerText)), "no Length label");
    const clock = "[data-testid=transition-tile][data-module='transition.clock']";
    const styleNow = () => page.$eval(`${clock} .tr-b`, (el) => (el as HTMLElement).style.clipPath + (el as HTMLElement).style.visibility);
    const allStyles = () => page.$$eval("[data-testid=transition-tile] .tr-a, [data-testid=transition-tile] .tr-b", (els) => els.map((e) => (e as HTMLElement).style.cssText).join("|"));
    await page.mouse.move(2, 2);
    await sleep(200);
    const before = await allStyles();
    await sleep(800);
    assert.equal(await allStyles(), before, "no thumbnail moves while none is hovered");
    assert.equal(await page.$("[data-testid=transition-thumb][data-playing]"), null);
    // Hovered: only that tile plays, and its shots change over time.
    await page.hover(`${clock} .tile-name`);
    await page.waitForSelector(`${clock} [data-testid=transition-thumb][data-playing=true]`);
    assert.equal(await page.$$eval("[data-testid=transition-thumb][data-playing]", (els) => els.length), 1, "one tile plays");
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      seen.add(await styleNow());
      await sleep(250);
    }
    assert.ok(seen.size > 1, `the hovered clock thumbnail animates: ${[...seen].join(" | ")}`);
    await page.screenshot({ path: out("issue68-transitions.png") });
    // Left: it stops, back on its still.
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => !document.querySelector("[data-testid=transition-thumb][data-playing]"));
    const still = await allStyles();
    await sleep(600);
    assert.equal(await allStyles(), still, "still again after the pointer leaves");

    // #73: Media; the Analyze button is a waveform with a tooltip; no speedometer.
    await page.click("[data-testid=rail-media]");
    await page.waitForSelector("[data-testid=library] [data-testid=media-tile][data-id=m-talk]");
    const talk = "[data-testid=media-tile][data-id=m-talk]";
    await page.hover(`${talk} .thumb`);
    const analyze = await page.$eval(`${talk} [data-testid=analyze]`, (el) => ({ title: (el as HTMLElement).title, label: el.getAttribute("aria-label"), icon: el.querySelector("svg")!.getAttribute("class") }));
    assert.match(analyze.icon ?? "", /lucide-audio-waveform/);
    assert.match(analyze.title, /^Analyse the sound: find its silences and loudness/);
    assert.equal(analyze.label, "Analyse the sound");
    assert.equal(await page.$("[data-testid=media-tile][data-id=m-red] [data-testid=analyze]"), null, "no Analyze on a clip without sound");
    assert.equal(await page.$("[data-testid=library] .lucide-gauge"), null, "no speedometer icon in Media");

    // #74: the generated picture is a media tile in Generated, the same size as the others, with a small badge.
    const gen = "[data-testid=generated] [data-testid=generated-item][data-id=m-kite]";
    await page.waitForSelector(gen);
    assert.equal(await page.$("[data-testid=media-grid] [data-id=m-kite]"), null, "not also under In this project");
    assert.equal(await page.$eval("[data-testid=generated-grid]", (el) => el.className), "grid2");
    const genBox = await box(gen);
    const mediaBox = await box("[data-testid=media-tile][data-id=m-red]");
    assert.ok(Math.abs(genBox.width - mediaBox.width) <= 1, `same width: ${genBox.width} vs ${mediaBox.width}`);
    assert.ok(Math.abs(genBox.height - mediaBox.height) <= 20, `about the same height: ${genBox.height} vs ${mediaBox.height}`);
    const badge = await page.$eval(`${gen} [data-testid=generated-badge]`, (el) => ({ label: el.getAttribute("aria-label"), title: (el as HTMLElement).title, h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width }));
    assert.equal(badge.label, "Generated");
    assert.match(badge.title, /^Generated/);
    assert.ok(badge.h <= 16 && badge.w <= 16, `a small badge: ${JSON.stringify(badge)}`);
    const title = await page.$eval(gen, (el) => (el as HTMLElement).title);
    assert.ok(title.includes(PROMPT), title);
    assert.equal(await page.$(`${gen} [data-testid=analyze]`), null, "no Analyze on a generated tile");
    await page.hover(`${gen} .thumb`);
    assert.ok(await page.$(`${gen} [data-testid=generated-add]`));
    assert.ok(await page.$(`${gen} [data-testid=generated-again]`));
    await page.screenshot({ path: out("issue73-74-media.png") });
    // Its menu has Add at playhead, Make again and Edit prompt; Esc closes it.
    await page.click(gen, { button: "right" });
    await page.waitForSelector("[data-testid=context-menu] [data-testid=menu-generated-edit]");
    for (const id of ["generated-add", "generated-again", "media-rename", "media-remove"]) assert.ok(await page.$(`[data-testid=context-menu] [data-testid=menu-${id}]`), `menu has ${id}`);
    assert.equal(await page.$("[data-testid=context-menu] [data-testid=menu-media-add]"), null);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=context-menu]"));
    // The list view: generated tiles follow it too.
    await page.click("[data-testid=media-view-list]");
    await page.waitForSelector("[data-testid=generated-grid][data-view=list]");
    assert.equal(await page.$eval("[data-testid=generated-grid]", (el) => el.className), "media-list");
    await page.screenshot({ path: out("issue74-list.png") });
    await page.click("[data-testid=media-view-grid]");
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: out("issue68-73-74-failure.png") }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
