// The README hero (docs/hero.png), staged in the packaged app and captured at 2x. Not a check:
// skipped unless UNCUT_HERO=1, so a normal run never rewrites docs/hero.png.
//   UNCUT_HERO=1 pnpm test:file test/app/readme-hero.test.ts
// A fresh project ("Launch film") gets five synthetic landscape clips (test/helpers/hero-clips.ts,
// drawn in Node: no footage, nothing third-party), and the scripted fake claude runs one believable
// turn: import (with a synthesised music track), brief, storyboard (approved), a graphic, the cut, a passed review. Then the
// Media panel, the playhead on the title and the thread scrolled to the end, with the composer's
// provider logo and the "Agent changed" pill hidden. Raw capture: test-output/readme-hero-raw.png;
// docs/hero.png is that, recompressed (zopflipng when it's on PATH).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";
import { makeHeroClips, makeHeroMusic } from "../helpers/hero-clips.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = process.env.UNCUT_HERO !== "1" ? "set UNCUT_HERO=1 to restage docs/hero.png" : existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

const W = 1600;
const H = 1000;
/** Where the playhead rests: after the title's rise has settled, the sun and ridges behind it. */
const FRAME = Number(process.env.HERO_FRAME ?? 45);
const CLIPS = ["Summit at sunset", "Coast at dawn", "Night peaks", "Desert dunes", "Last light"];
const fps = 30;

let root = "";
let app: LaunchedApp | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-hero-")));
  mkdirSync(join(root, "Projects"));
  // Drawing the clips takes a few minutes; hooks have no timeout.
  await makeHeroClips(join(root, "Footage"), 5, CLIPS);
  makeHeroMusic(join(root, "Footage"));
  await lockApps();
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const id = (name: string) => `m-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** The one agent turn the fake claude plays: what a real launch-film turn does, in order. */
function plan(footage: string) {
  const T = 16;
  const transitions = [undefined, "transition.crossfade", "transition.push-left", "transition.crossfade", "transition.dip-to-black"];
  const shots = CLIPS.map((c, i) => ({ media: id(c), dur: 120, t: transitions[i] }));
  const total = shots.reduce((a, s) => a + s.dur, 0);
  const main = shots.map((s, i) => ({ op: "insert_item", track: "main", item: { id: `shot-${i + 1}`, type: "clip", media: s.media, in: s.t ? 8 : 0, duration: s.dur, ...(s.t ? { transitionIn: { module: s.t, duration: T } } : {}) } }));
  const centred = (w: number) => (1920 - w) / 2;
  const texts = [
    { id: "kicker", start: 4, duration: 106, text: "Launch week", transform: { x: centred(1000), y: 214, w: 1000 }, style: { preset: "text.kicker", font: "DM Sans", size: 40, weight: 700, tracking: 0.32, uppercase: true, color: "#ffe2c2", align: "center", shadow: { y: 2, blur: 18, color: "#1d1340", opacity: 0.5 } }, animation: { in: { module: "move.rise", duration: 16 } } },
    { id: "title", start: 0, duration: 110, text: "Ship it.", transform: { x: centred(1600), y: 262, w: 1600 }, style: { preset: "text.title", font: "DM Sans", size: 240, weight: 800, tracking: -0.035, color: "#ffffff", align: "center", shadow: { y: 10, blur: 48, color: "#1d1340", opacity: 0.5 } }, animation: { in: { module: "move.rise", duration: 18 }, out: { module: "move.fade", duration: 10 } } },
    { id: "line-2", start: 130, duration: 95, text: "Cut in an afternoon", transform: { x: 140, y: 800, w: 1100 }, style: { preset: "text.title", font: "DM Sans", size: 92, weight: 700, color: "#ffffff", align: "left" }, animation: { in: { module: "move.slide-left", duration: 14 } } },
    { id: "line-3", start: 245, duration: 95, text: "Every frame, yours", transform: { x: centred(1400), y: 300, w: 1400 }, style: { preset: "text.title", font: "DM Sans", size: 92, weight: 700, color: "#ffffff", align: "center" }, animation: { in: { module: "move.rise", duration: 14 } } },
    { id: "end", start: total - 110, duration: 110, text: "uncut.video", transform: { x: centred(1200), y: 300, w: 1200 }, style: { preset: "text.title", font: "DM Mono", size: 84, weight: 500, color: "#ffffff", align: "center" }, animation: { in: { module: "move.typewriter", duration: 30 } } },
  ];
  const textOps = texts.map((t) => ({ op: "insert_item", track: t.id === "kicker" ? "titles" : "text", item: { type: "text", ...t } }));
  // A short warm rule under the title that draws itself in.
  const graphic = `<canvas id="c"></canvas><script>
const c = document.getElementById("c");
window.render = (t, info) => {
  c.width = info.width; c.height = info.height;
  const x = c.getContext("2d"), W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  const p = Math.min(1, Math.max(0, (t - 0.2) / 0.6)), e = 1 - Math.pow(1 - p, 3);
  const g = x.createLinearGradient(W * 0.42, 0, W * 0.58, 0);
  g.addColorStop(0, "#ffd6a0"); g.addColorStop(1, "#ff8fb1");
  x.fillStyle = g;
  const w = W * 0.12 * e;
  x.beginPath(); x.roundRect(W / 2 - w / 2, H * 0.505, w, H * 0.007, H * 0.0035); x.fill();
};
</script>`;
  const brief = { film: "A 20 s launch film for Uncut 1.0: big kinetic title, five shots, music under it", audience: "Developers who make their own launch videos", duration: "20 s", formats: ["16:9 1920x1080"], assets: CLIPS, visual: "Dusk palette, white DM Sans titles, warm accent", hardLines: ["Only the footage in the project"], deliverables: ["launch-film.mp4"] };
  const beats = [
    { start: 0, end: 3.5, title: "Ship it.", entry: "The title rises over the summit", exit: "Accent rule drawn", purpose: "Say it in one beat", assets: ["Summit at sunset"], sound: "music fades in" },
    { start: 3.5, end: 8, title: "The coast", entry: "Crossfade to dawn", exit: "Line settles", purpose: "Calm, then momentum", assets: ["Coast at dawn"] },
    { start: 8, end: 15, title: "Night and day", entry: "Push to the peaks", exit: "Dunes", purpose: "Range in a few seconds", assets: ["Night peaks", "Desert dunes"] },
    { start: 15, end: 20, title: "End card", entry: "Dip to last light", exit: "uncut.video types in", purpose: "Where to get it", assets: ["Last light"], sound: "music fades out" },
  ];
  return [
    [
      { tool: "media_import", args: { path: footage } },
      { tool: "brief_write", args: brief },
      { tool: "storyboard_propose", args: { summary: "Title, coast, peaks and dunes, end card", beats } },
      { tool: "graphic_write", args: { name: "title-accent.html", html: graphic } },
      { tool: "graphic_write", args: { name: "end-rule.html", html: graphic.replace("#ffd6a0", "#9ec5ff").replace("#ff8fb1", "#ffd6a0").replace("H * 0.505", "H * 0.42") } },
      { tool: "project_read" },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Cut the launch film: five shots, titles, music",
          ops: [
            ...[...CLIPS, "Launch theme"].map((c) => ({ op: "update_media", media: id(c), set: { name: c } })),
            ...main,
            { op: "add_track", track: { id: "titles", kind: "text", name: "Kicker", items: [] }, index: 0 },
            ...textOps,
            { op: "add_track", track: { id: "gfx", kind: "video", name: "Graphics", items: [] }, index: 2 },
            { op: "insert_item", track: "gfx", item: { id: "accent", type: "graphic", name: "Title accent", src: "graphics/title-accent.html", start: 0, duration: 110 } },
            { op: "insert_item", track: "gfx", item: { id: "accent-end", type: "graphic", name: "End rule", src: "graphics/end-rule.html", start: total - 110, duration: 110 } },
            { op: "update_track", track: "audio", set: { name: "Music" } },
            { op: "insert_item", track: "audio", item: { id: "music-1", type: "audio", media: id("Launch theme"), in: 0, start: 0, duration: total, fadeIn: fps, fadeOut: 2 * fps, gainDb: -4 } },
          ],
        },
      },
      { tool: "contact_sheet", args: { max: 6 } },
      { tool: "render_frames", args: { frames: [FRAME, 150, 300, total - 30], phone: true } },
      { tool: "review_submit", args: { scores: { hook: 9, readability: 9, motion: 8, variety: 9, sound: 8, brand: 9 } } },
      { text: "Cut and passed: 20 s, the title over the summit up front, music under it." },
    ],
  ];
}

test("stage the README hero and save docs/hero.png", { skip, timeout: 600000 }, async () => {
  const footage = join(root, "Footage");
  const planFile = join(root, "plan.json");
  const critic = join(root, "critic.json");
  writeFileSync(planFile, JSON.stringify(plan(footage)));
  const ev = (score: number, evidence: string) => ({ score, evidence });
  writeFileSync(
    critic,
    JSON.stringify([
      {
        scores: { hook: ev(9, "f 0: the title lands on the first beat"), readability: ev(9, "f 45: Ship it. reads at phone size"), motion: ev(8, "f 0 to f 24: the rise settles"), variety: ev(9, "f 0, f 150, f 300: five places in 20 s"), sound: ev(8, "f 0 to f 30: the music fades in under the title"), brand: ev(9, "f 45, f 150: white titles, warm accent") },
        blockers: [],
        defects: [],
        summary: "Clear hook, readable titles, the cut keeps moving. Ship it.",
      },
    ]),
  );

  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "Projects")]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: planFile, FAKE_CRITIC: critic, FAKE_RESULT_LOG: resolve("test-output/readme-hero-results.jsonl"), UNCUT_APPROVAL_MS: "120000" } });
  const { page } = app;
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  const waitFor = (selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });

  await waitFor("[data-testid=welcome]", 60000);
  await page.click("[data-testid=new-project]");
  await waitFor("[data-testid=new-project-form]");
  await page.click("[data-testid=project-name]", { clickCount: 3 });
  await page.keyboard.down("Meta");
  await page.keyboard.press("a");
  await page.keyboard.up("Meta");
  await page.keyboard.type("Launch film");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
  await page.click("[data-testid=create]");
  await waitFor("[data-testid=agent-input]");
  assert.equal(readdirSync(join(root, "Projects")).length, 1);

  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("Cut a 20 second launch film from the clips in my Footage folder. Big kinetic title up front, music under it.");
  await page.keyboard.press("Enter");
  await waitFor("[data-testid=agent-storyboard-approve]", 90000);
  await page.click("[data-testid=agent-storyboard-approve]");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=agent-turn]")].at(-1)?.getAttribute("data-status") === "done", { timeout: 240000 });

  // The look: logo and pill hidden, Media panel, the timeline a little taller so the preview's
  // area is close to 16:9, the whole edit in view.
  await page.addStyleTag({ content: "[data-testid=agent-provider], .provider-mark, .agent-change { display: none !important; }" });
  await page.click("[data-testid=rail-media]").catch(() => {});
  const lift = Number(process.env.HERO_LIFT ?? 70);
  if (lift) {
    const rz = await page.$eval(".resizer.h", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(rz.x, rz.y);
    await page.mouse.down();
    await page.mouse.move(rz.x, rz.y - lift, { steps: 8 });
    await page.mouse.up();
    await sleep(400);
  }
  await page.click("[data-testid=zoom-fit]").catch(() => {});
  await sleep(300);

  // Seek: click the ruler where FRAME is (zoom-fit shows the whole edit from the first item).
  const span = await page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>("[data-testid=timeline-item]")].map((i) => i.getBoundingClientRect());
    return { left: Math.min(...items.map((r) => r.left)), right: Math.max(...items.map((r) => r.right)) };
  });
  const ruler = await page.$eval("[data-testid=ruler]", (el) => {
    const r = el.getBoundingClientRect();
    return { y: r.y + r.height / 2 };
  });
  await page.mouse.click(span.left + ((span.right - span.left) * FRAME) / (5 * 120), ruler.y);
  // Nothing hovered: rest the mouse on the title bar.
  await page.mouse.move(W / 2, 12);

  // Thumbnails and waveforms in, the frame drawn, nothing still loading.
  await page.waitForFunction(
    () => {
      const tiles = [...document.querySelectorAll<HTMLElement>("[data-testid=media-tile]")];
      const imgs = tiles.flatMap((t) => [...t.querySelectorAll("img")]);
      return tiles.length >= 5 && imgs.every((i) => i.complete && i.naturalWidth > 0) && !document.body.innerText.includes("Checking");
    },
    { timeout: 60000 },
  ).catch(() => console.log("# media tiles not all loaded"));
  await sleep(2500);
  console.log("# timecode", await page.$eval("[data-testid=timecode]", (el) => (el as HTMLElement).innerText));
  // The review card folded (its score sheet is long), and the fake claude's own sign-off
  // ("Done: N steps.", test plumbing) hidden, then the thread at its end.
  await page.click("[data-testid=agent-card][data-type=review] .card-head").catch(() => console.log("# no review card"));
  await page.$$eval("[data-testid=agent-thread] *", (els) => {
    for (const el of els as Array<HTMLElement>) if (/^Done: \d+ steps?\.$/.test(el.innerText?.trim() ?? "") && !(el.parentElement?.innerText.trim() ?? "").startsWith("Done:")) el.style.display = "none";
  });
  await sleep(300);
  await page.$eval("[data-testid=agent-thread]", (el) => (el.scrollTop = el.scrollHeight));
  await sleep(600);
  const layout = await page.evaluate(() => {
    const box = (s: string) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : undefined;
    };
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=stage-canvas] canvas");
    return { preview: box("[data-testid=stage]"), stageCanvas: box("[data-testid=stage-canvas]"), canvas: canvas ? [canvas.width, canvas.height, canvas.getBoundingClientRect().width] : undefined };
  });
  console.log("# layout", JSON.stringify(layout));

  const raw = "test-output/readme-hero-raw.png";
  await page.screenshot({ path: raw });
  assert.deepEqual(app.errors, []);
  copyFileSync(raw, "docs/hero.png");
  try {
    execFileSync("zopflipng", ["-y", "--lossy_transparent", raw, "docs/hero.png"], { stdio: "ignore" });
  } catch {
    console.log("# zopflipng not on PATH: docs/hero.png is the raw capture");
  }
  console.log("# docs/hero.png", statSync("docs/hero.png").size, "bytes");
});
