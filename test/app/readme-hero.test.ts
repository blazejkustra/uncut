// The README hero (docs/hero.png), staged in the packaged app and captured at 2x. Not a check:
// skipped unless UNCUT_HERO=1 and UNCUT_HERO_FOOTAGE is set, so a normal run never rewrites docs/hero.png.
//   UNCUT_HERO=1 UNCUT_HERO_FOOTAGE=/path/to/croatia-day-4 pnpm test:file test/app/readme-hero.test.ts
// A fresh project ("Croatia, day four") in a temp folder imports six real drone clips from
// UNCUT_HERO_FOOTAGE (the owner's footage: referenced in place, read only, nothing written next to
// it) and a synthesised music bed, and the scripted fake claude runs one believable turn: import,
// brief, storyboard, a graphic, the cut, a passed review. Then the Media panel, the
// playhead on the title and the thread scrolled to the end, with the composer's provider logo, the
// "Agent changed" pill and the proxy badges hidden, and the preview playing the originals (not
// the 1280 px proxies). Raw capture: test-output/readme-hero-raw.png; docs/hero.png is that,
// palette-quantised and recompressed (pngquant and zopflipng when they're on PATH).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const FOOTAGE = process.env.UNCUT_HERO_FOOTAGE;

/** The six shots, in cut order: the file in UNCUT_HERO_FOOTAGE, the name it gets, and where it starts (s). */
const SHOTS = [
  { file: "DJI_20261014180908_0055_D.MP4", name: "The coast road", from: 11 },
  { file: "DJI_20261014175404_0052_D.MP4", name: "Sun over the bay", from: 92 },
  { file: "DJI_20261014181226_0063_D.MP4", name: "Shoreline from above", from: 22 },
  { file: "DJI_20261014183542_0068_D.MP4", name: "The lighthouse", from: 4 },
  { file: "DJI_20261014181119_0062_D.MP4", name: "Sunset at sea", from: 41 },
  { file: "DJI_20261014183804_0069_D.MP4", name: "Blue hour", from: 3 },
];
const MUSIC = "Evening theme";

const missing = FOOTAGE ? SHOTS.find((s) => !existsSync(join(FOOTAGE, s.file))) : undefined;
const skip =
  process.env.UNCUT_HERO !== "1"
    ? "set UNCUT_HERO=1 to restage docs/hero.png"
    : !FOOTAGE
      ? "set UNCUT_HERO_FOOTAGE to the folder with the croatia-day-4 drone clips"
      : missing
        ? `${missing.file} isn't in UNCUT_HERO_FOOTAGE`
        : existsSync(APP)
          ? false
          : `packaged app not built: run pnpm dist to create ${APP}`;

const W = 1600;
const H = 1000;
/** Where the playhead rests: the title settled over the coast road. */
const FRAME = Number(process.env.HERO_FRAME ?? 45);
const fps = 30;
const SHOT = 105;
const TOTAL = SHOTS.length * SHOT;

let root = "";
let app: LaunchedApp | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The footage folder's listing (names, sizes, times), to prove the run wrote nothing there. */
const listing = () =>
  FOOTAGE
    ? readdirSync(FOOTAGE)
        .filter((n) => n !== ".DS_Store")
        .map((n) => `${n} ${statSync(join(FOOTAGE, n)).size} ${statSync(join(FOOTAGE, n)).mtimeMs}`)
        .join("\n")
    : "";
let before0 = "";

/** "<MUSIC>.m4a": a soft synthesised bed (a slow D major pad, a gentle pentatonic pluck every 0.75 s), faded in and out. */
function makeMusic(dir: string, seconds = TOTAL / fps) {
  mkdirSync(dir, { recursive: true });
  const pad = "0.09*(sin(2*PI*146.83*t)+0.8*sin(2*PI*185*t)+0.7*sin(2*PI*220*t)+0.3*sin(2*PI*293.66*t))*(0.7+0.3*sin(2*PI*0.125*t))";
  const step = "mod(floor(t/0.75),6)";
  const note = `(587.33*eq(${step},0)+659.25*eq(${step},1)+880*eq(${step},2)+739.99*eq(${step},3)+659.25*eq(${step},4)+493.88*eq(${step},5))`;
  const pluck = `0.11*exp(-mod(t,0.75)*5)*sin(2*PI*${note}*t)`;
  const fade = `min(1,t/2)*min(1,(${seconds}-t)/2.5)`;
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='(${pad}+${pluck})*${fade}':s=48000:d=${seconds}`,
    "-af",
    "aecho=0.8:0.7:240:0.3",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    join(dir, `${MUSIC}.m4a`),
  ]);
}

before(async () => {
  if (skip) return;
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-hero-")));
  mkdirSync(join(root, "Projects"));
  makeMusic(join(root, "Music"));
  before0 = listing();
  await lockApps();
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The media id an import gives a file: "DJI_…_0055_D.MP4" is named "DJI 0055" (m-dji-0055), anything else by its stem. */
const id = (file: string) => {
  const dji = /^DJI_\d+_(\d{4})_D\./.exec(file);
  return dji
    ? `m-dji-${dji[1]}`
    : `m-${file
        .replace(/\.[^.]+$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`;
};

/** The one agent turn the fake claude plays: what a real travel-edit turn does, in order. */
function plan() {
  const T = 16;
  const transitions = [undefined, "transition.crossfade", "transition.crossfade", "transition.push-left", "transition.crossfade", "transition.dip-to-black"];
  const main = SHOTS.map((s, i) => ({
    op: "insert_item",
    track: "main",
    item: {
      id: `shot-${i + 1}`,
      type: "clip",
      media: id(s.file),
      in: s.from * fps,
      duration: SHOT,
      ...(transitions[i] ? { transitionIn: { module: transitions[i], duration: T } } : {}),
    },
  }));
  const centred = (w: number) => (1920 - w) / 2;
  const shadow = { color: "#06141c", opacity: 0.55 };
  const texts = [
    {
      id: "kicker",
      start: 4,
      duration: 96,
      text: "Croatia",
      transform: { x: centred(1000), y: 214, w: 1000 },
      style: {
        preset: "text.kicker",
        font: "DM Sans",
        size: 40,
        weight: 700,
        tracking: 0.42,
        uppercase: true,
        color: "#ffe2c2",
        align: "center",
        shadow: { y: 2, blur: 18, ...shadow },
      },
      animation: { in: { module: "move.rise", duration: 16 } },
    },
    {
      id: "title",
      start: 0,
      duration: 100,
      text: "Day four",
      transform: { x: centred(1600), y: 262, w: 1600 },
      style: {
        preset: "text.title",
        font: "DM Sans",
        size: 240,
        weight: 800,
        tracking: -0.035,
        color: "#ffffff",
        align: "center",
        shadow: { y: 10, blur: 48, ...shadow },
      },
      animation: { in: { module: "move.rise", duration: 18 }, out: { module: "move.fade", duration: 10 } },
    },
    {
      id: "line-2",
      start: 120,
      duration: 85,
      text: "Golden hour on the coast",
      transform: { x: 140, y: 800, w: 1300 },
      style: { preset: "text.title", font: "DM Sans", size: 84, weight: 700, color: "#ffffff", align: "left", shadow: { y: 4, blur: 24, ...shadow } },
      animation: { in: { module: "move.slide-left", duration: 14 } },
    },
    {
      id: "line-3",
      start: 330,
      duration: 85,
      text: "The lighthouse at dusk",
      transform: { x: centred(1400), y: 140, w: 1400 },
      style: { preset: "text.title", font: "DM Sans", size: 84, weight: 700, color: "#ffffff", align: "center", shadow: { y: 4, blur: 24, ...shadow } },
      animation: { in: { module: "move.rise", duration: 14 } },
    },
    {
      id: "end",
      start: TOTAL - 95,
      duration: 95,
      text: "Until tomorrow",
      transform: { x: centred(1200), y: 300, w: 1200 },
      style: { preset: "text.title", font: "DM Mono", size: 80, weight: 500, color: "#ffffff", align: "center" },
      animation: { in: { module: "move.typewriter", duration: 30 } },
    },
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
  g.addColorStop(0, "#ffd6a0"); g.addColorStop(1, "#ff9f7a");
  x.fillStyle = g;
  const w = W * 0.12 * e;
  x.beginPath(); x.roundRect(W / 2 - w / 2, H * 0.505, w, H * 0.007, H * 0.0035); x.fill();
};
</script>`;
  const names = SHOTS.map((s) => s.name);
  const brief = {
    film: "A 21 s travel film of day four in Croatia: a quiet title, six drone shots from golden hour to blue hour, soft music under it",
    audience: "Friends and family, and the trip's group chat",
    duration: "21 s",
    formats: ["16:9 1920x1080"],
    assets: names,
    visual: "Natural grade, white DM Sans titles, warm accent",
    hardLines: ["Only the day's drone footage", "No faces"],
    deliverables: ["croatia-day-4.mp4"],
  };
  const beats = [
    {
      start: 0,
      end: 3.5,
      title: "Day four",
      entry: "The title rises over the coast road",
      exit: "Accent rule drawn",
      purpose: "Set the place in one beat",
      assets: ["The coast road"],
      sound: "music fades in",
    },
    {
      start: 3.5,
      end: 10.5,
      title: "Golden hour",
      entry: "Crossfade to the bay",
      exit: "Straight down on the shore",
      purpose: "Warm light, then the water",
      assets: ["Sun over the bay", "Shoreline from above"],
    },
    {
      start: 10.5,
      end: 17.5,
      title: "The lighthouse",
      entry: "Push to the lighthouse",
      exit: "Sun on the horizon",
      purpose: "The evening's walk",
      assets: ["The lighthouse", "Sunset at sea"],
    },
    {
      start: 17.5,
      end: 21,
      title: "Blue hour",
      entry: "Dip to the last light",
      exit: "Until tomorrow types in",
      purpose: "A soft end",
      assets: ["Blue hour"],
      sound: "music fades out",
    },
  ];
  return [
    [
      { tool: "media_import", args: { paths: [...SHOTS.map((s) => join(FOOTAGE!, s.file)), join(root, "Music", `${MUSIC}.m4a`)] } },
      { tool: "brief_write", args: brief },
      { tool: "storyboard_propose", args: { summary: "Title over the coast road, golden hour, the lighthouse, blue hour", beats } },
      { tool: "graphic_write", args: { name: "title-accent.html", html: graphic } },
      { tool: "project_read" },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Cut the travel film: six shots, titles, music",
          ops: [
            ...SHOTS.map((s) => ({ op: "update_media", media: id(s.file), set: { name: s.name } })),
            { op: "update_media", media: id(`${MUSIC}.m4a`), set: { name: MUSIC } },
            ...main,
            { op: "add_track", track: { id: "titles", kind: "text", name: "Kicker", items: [] }, index: 0 },
            ...textOps,
            { op: "add_track", track: { id: "gfx", kind: "video", name: "Graphics", items: [] }, index: 2 },
            {
              op: "insert_item",
              track: "gfx",
              item: { id: "accent", type: "graphic", name: "Title accent", src: "graphics/title-accent.html", start: 0, duration: 100 },
            },
            { op: "update_track", track: "audio", set: { name: "Music" } },
            {
              op: "insert_item",
              track: "audio",
              item: { id: "music-1", type: "audio", media: id(`${MUSIC}.m4a`), in: 0, start: 0, duration: TOTAL, fadeIn: fps, fadeOut: 2 * fps, gainDb: -4 },
            },
          ],
        },
      },
      { tool: "contact_sheet", args: { max: 6 } },
      { tool: "render_frames", args: { frames: [FRAME, 160, 360, TOTAL - 30], phone: true } },
      { tool: "review_submit", args: { scores: { hook: 9, readability: 9, motion: 8, variety: 9, sound: 8, brand: 9 } } },
      { text: "Cut and passed: 21 s, the title over the coast road up front, six shots from golden hour to blue hour, soft music under it." },
    ],
  ];
}

test("stage the README hero and save docs/hero.png", { skip, timeout: 600000 }, async () => {
  const planFile = join(root, "plan.json");
  const critic = join(root, "critic.json");
  writeFileSync(planFile, JSON.stringify(plan()));
  const ev = (score: number, evidence: string) => ({ score, evidence });
  writeFileSync(
    critic,
    JSON.stringify([
      {
        scores: {
          hook: ev(9, "f 0: the title rises over the coast road on the first beat"),
          readability: ev(9, "f 45: Day four reads at phone size over the sea"),
          motion: ev(8, "f 0 to f 24: the rise settles, the drone keeps drifting"),
          variety: ev(9, "f 45, f 160, f 360: road, shore, lighthouse"),
          sound: ev(8, "f 0 to f 30: the music fades in under the title"),
          brand: ev(9, "f 45, f 160: white titles, warm accent, natural grade"),
        },
        blockers: [],
        defects: [],
        summary: "A calm open, readable titles, the light carries the cut from gold to blue.",
      },
    ]),
  );

  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "Projects")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: planFile,
      FAKE_CRITIC: critic,
      FAKE_RESULT_LOG: resolve("test-output/readme-hero-results.jsonl"),
      UNCUT_APPROVAL_MS: "120000",
    },
  });
  const { page } = app;
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  const waitFor = (selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });

  await waitFor("[data-testid=welcome]", 60000);
  // The preview plays the 4K originals, not the 1280 px proxies (the setting is read at load).
  await page.evaluate(() => localStorage.setItem("uncut.preview.proxies", "off"));
  await page.reload();
  await waitFor("[data-testid=welcome]", 60000);
  await page.click("[data-testid=new-project]");
  await waitFor("[data-testid=new-project-form]");
  await page.click("[data-testid=project-name]", { clickCount: 3 });
  await page.keyboard.down("Meta");
  await page.keyboard.press("a");
  await page.keyboard.up("Meta");
  await page.keyboard.type("Croatia, day four");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
  await page.click("[data-testid=create]");
  await waitFor("[data-testid=agent-input]");
  assert.equal(readdirSync(join(root, "Projects")).length, 1);

  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("Cut a 20 second travel film from today's drone clips. Golden hour to blue hour, a quiet title up front, soft music under it.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=agent-turn]")].at(-1)?.getAttribute("data-status") === "done", {
    timeout: 240000,
  });

  // The look: logo, pill and proxy badges hidden, Media panel, the timeline a little taller so the preview's
  // area is close to 16:9, the whole edit in view.
  await page.addStyleTag({ content: "[data-testid=agent-provider], .provider-mark, .agent-change, .tile-proxy { display: none !important; }" });
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
  await page.mouse.click(span.left + ((span.right - span.left) * FRAME) / TOTAL, ruler.y);
  // Nothing hovered: rest the mouse on the title bar.
  await page.mouse.move(W / 2, 12);

  // Thumbnails and waveforms in, the frame drawn, nothing still loading.
  await page
    .waitForFunction(
      () => {
        const tiles = [...document.querySelectorAll<HTMLElement>("[data-testid=media-tile]")];
        const imgs = tiles.flatMap((t) => [...t.querySelectorAll("img")]);
        return tiles.length >= 6 && imgs.every((i) => i.complete && i.naturalWidth > 0) && !document.body.innerText.includes("Checking");
      },
      { timeout: 60000 },
    )
    .catch(() => console.log("# media tiles not all loaded"));
  await sleep(2500);
  console.log("# timecode", await page.$eval("[data-testid=timecode]", (el) => (el as HTMLElement).innerText));
  // The review card folded (its score sheet is long), and the fake claude's own sign-off
  // ("Done: N steps.", test plumbing) hidden, then the thread at its end.
  await page.click("[data-testid=agent-card][data-type=review] .card-head").catch(() => console.log("# no review card"));
  await page.$$eval("[data-testid=agent-thread] *", (els) => {
    for (const el of els as Array<HTMLElement>)
      if (/^Done: \d+ steps?\.$/.test(el.innerText?.trim() ?? "") && !(el.parentElement?.innerText.trim() ?? "").startsWith("Done:")) el.style.display = "none";
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
    return {
      preview: box("[data-testid=stage]"),
      stageCanvas: box("[data-testid=stage-canvas]"),
      canvas: canvas ? [canvas.width, canvas.height, canvas.getBoundingClientRect().width] : undefined,
    };
  });
  console.log("# layout", JSON.stringify(layout));

  const raw = "test-output/readme-hero-raw.png";
  await page.screenshot({ path: raw });
  assert.deepEqual(app.errors, []);
  assert.equal(listing(), before0, "nothing written in the footage folder");
  // Real footage doesn't compress like flat colour: a 256-colour palette (pngquant, visually the
  // same at this size) and then zopflipng keep docs/hero.png near 1.3 MB instead of 4.
  copyFileSync(raw, "docs/hero.png");
  try {
    execFileSync("pngquant", ["--quality=90-100", "--speed", "1", "-f", "-o", "docs/hero.png", raw], { stdio: "ignore" });
  } catch {
    console.log("# pngquant not on PATH: docs/hero.png keeps every colour");
  }
  try {
    execFileSync("zopflipng", ["-y", "--lossy_transparent", "docs/hero.png", "docs/hero.png"], { stdio: "ignore" });
  } catch {
    console.log("# zopflipng not on PATH: docs/hero.png isn't recompressed");
  }
  console.log("# docs/hero.png", statSync("docs/hero.png").size, "bytes");
});
