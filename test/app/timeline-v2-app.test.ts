// Timeline v2 phase 1 (D346) on the packaged app: tracks named V1, V2, A1; the audio lane 64 px
// tall with a full-height waveform where the talk's speech and its silences show; lanes resized by
// their head's bottom edge, ⌥ + wheel and the S/M/L toggle; ⇧⌘K splits V1, V2 and A1 at the
// playhead in one edit, one ⌘Z, and S right after splits every track again.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the talk") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const out = (name: string) => resolve("test-output", name);
const revision = (page: Page) => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));

async function savedAfter(page: Page, after: number) {
  await page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r,
    { timeout: 10000 },
    after,
  );
  return revision(page);
}

async function chord(page: Page, mods: ReadonlyArray<"Meta" | "Shift">, key: Parameters<Page["keyboard"]["press"]>[0]) {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
}

const laneHeight = (page: Page, code: string) => page.$eval(`[data-testid=lane][data-code="${code}"]`, (el) => el.getBoundingClientRect().height);

/** The share of the waveform's columns lit on its middle row between `from` and `to` (0–1 of the item). */
const litBetween = (page: Page, from: number, to: number) =>
  page.$eval(
    '[data-item="voice"] [data-testid=waveform]',
    (c, a, b) => {
      const canvas = c as HTMLCanvasElement;
      const row = canvas.getContext("2d")!.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
      const x0 = Math.floor(a * canvas.width);
      const x1 = Math.floor(b * canvas.width);
      let lit = 0;
      for (let x = x0; x < x1; x++) if (row[x * 4 + 3]! > 0) lit++;
      return lit / Math.max(1, x1 - x0);
    },
    from,
    to,
  );

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-tlv2-")));
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", "-threads", "2", ...args]);
  // A talk: 1 s of sound, 1 s of silence, for 6 s.
  ff("-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*220*t)*lt(mod(t\\,2)\\,1):s=48000:d=6", "-c:a", "aac", "-b:a", "128k", join(root, "Voice.m4a"));
  ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:d=6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(root, "Picture.mp4"));
  const dir = join(root, "Talk.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Talk",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [
        {
          id: "m-picture",
          kind: "video",
          name: "Picture.mp4",
          path: join(root, "Picture.mp4"),
          probe: { frames: 180, fps: 30, width: 320, height: 240, hasAudio: false },
        },
        { id: "m-voice", kind: "audio", name: "Voice.m4a", path: join(root, "Voice.m4a"), probe: { frames: 180, fps: 30, hasAudio: true } },
      ],
      tracks: [
        { id: "screen", kind: "video", name: "Video 2", items: [{ id: "shot", type: "clip", media: "m-picture", in: 0, start: 30, duration: 120 }] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "cam", type: "clip", media: "m-picture", in: 0, duration: 180 }] },
        { id: "audio", kind: "audio", name: "Audio", items: [{ id: "voice", type: "audio", media: "m-voice", in: 0, start: 0, duration: 180 }] },
      ],
    }),
  );
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "plan.json"), JSON.stringify([[{ text: "Noted." }]]));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "timeline v2 phase 1: V1/A1 heads, a 64 px audio lane with speech and silence, resizable lanes, ⇧⌘K splits every track",
  { skip, timeout: 180000 },
  async () => {
    const dir = join(root, "Talk.uncut");
    const app = await launchApp({
      command: APP,
      env: {
        UNCUT_DATA_DIR: join(root, "data"),
        UNCUT_TEST_DIALOG: JSON.stringify([dir]),
        UNCUT_CLAUDE: FAKE,
        FAKE_PLAN: join(root, "plan.json"),
        FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      },
    });
    apps.add(app);
    const { page } = app;
    const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { tracks: Array<{ id: string; items: Array<{ id: string }> }> };
    const counts = () => Object.fromEntries(onDisk().tracks.map((t) => [t.id, t.items.length]));

    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('[data-item="voice"] [data-testid=waveform]')?.dataset.ready === "true", {
      timeout: 20000,
    });

    // Heads: the main track is V1 (no badge, no "Main"), the overlay V2, the sound A1.
    const heads = await page.$$eval("[data-testid=track]", (els) =>
      els.map((el) => ({
        code: el.getAttribute("data-code"),
        text: (el.querySelector(".name") as HTMLElement).innerText.trim(),
        title: el.querySelector(".name")!.getAttribute("title"),
      })),
    );
    assert.deepEqual(
      heads.map((h) => [h.code, h.text]),
      [
        ["V2", "V2"],
        ["V1", "V1"],
        ["A1", "A1"],
      ],
    );
    assert.ok(!heads.some((h) => /back to back/.test(h.title ?? "")), "the stale tooltip is gone");

    // The audio lane is 64 px; its waveform fills it and shows the talk's sound and silence.
    assert.ok(Math.abs((await laneHeight(page, "A1")) - 64) <= 1, `A1 is 64 px (${await laneHeight(page, "A1")})`);
    const waveHeight = await page.$eval('[data-item="voice"] [data-testid=waveform]', (c) => c.getBoundingClientRect().height);
    assert.ok(waveHeight > 40, `the waveform is taller than 40 px (${waveHeight})`);
    const sound = await litBetween(page, 0.02, 0.15);
    const silence = await litBetween(page, 0.2, 0.31);
    assert.ok(sound > 0.9, `sound draws (${sound})`);
    assert.ok(silence < 0.05, `silence stays empty (${silence})`);
    await (await page.$("[data-testid=timeline]"))!.screenshot({ path: out("timeline-v2-lanes.png") });

    // Resize: A1's head edge dragged 40 px down; ⌥ + wheel up over V2's head; then Small for every lane.
    const edge = (await (await page.$('[data-testid=track][data-code="A1"] [data-testid=track-resize]'))!.boundingBox())!;
    await page.mouse.move(edge.x + 40, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + 40, edge.y + edge.height / 2 + 20, { steps: 4 });
    await page.mouse.move(edge.x + 40, edge.y + edge.height / 2 + 40, { steps: 4 });
    await page.mouse.up();
    assert.ok(Math.abs((await laneHeight(page, "A1")) - 104) <= 1, `A1 dragged to 104 px (${await laneHeight(page, "A1")})`);
    const v2 = (await (await page.$('[data-testid=track][data-code="V2"]'))!.boundingBox())!;
    await page.mouse.move(v2.x + 60, v2.y + v2.height / 2);
    await page.keyboard.down("Alt");
    await page.mouse.wheel({ deltaY: -100 });
    await page.keyboard.up("Alt");
    await page.waitForFunction(() => document.querySelector('[data-testid=lane][data-code="V2"]')!.getBoundingClientRect().height > 50);
    await page.click("[data-testid=lane-size-small]");
    assert.deepEqual([await laneHeight(page, "V2"), await laneHeight(page, "V1"), await laneHeight(page, "A1")], [32, 40, 40]);
    await page.click("[data-testid=lane-size-medium]");
    assert.deepEqual([await laneHeight(page, "V2"), await laneHeight(page, "V1"), await laneHeight(page, "A1")], [40, 52, 64]);

    // ⇧⌘K at 1.5 s with nothing selected: V1, V2 and A1 are cut in one edit; one ⌘Z puts them back.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Home");
    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Shift");
    for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === 45);
    let rev = await revision(page);
    await chord(page, ["Shift", "Meta"], "KeyK");
    rev = await savedAfter(page, rev);
    assert.deepEqual(counts(), { screen: 2, main: 2, audio: 2 });
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 6);
    await (await page.$("[data-testid=timeline]"))!.screenshot({ path: out("timeline-v2-split-all.png") });

    // Nothing stays selected, so S at 4 s splits every track again.
    for (let i = 0; i < 2; i++) await chord(page, ["Shift"], "ArrowRight");
    for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === 120);
    await page.keyboard.press("KeyS");
    rev = await savedAfter(page, rev);
    assert.deepEqual(counts(), { screen: 3, main: 3, audio: 3 });
    await chord(page, ["Meta"], "KeyZ");
    rev = await savedAfter(page, rev);
    assert.deepEqual(counts(), { screen: 2, main: 2, audio: 2 });
    await chord(page, ["Meta"], "KeyZ");
    await savedAfter(page, rev);
    assert.deepEqual(counts(), { screen: 1, main: 1, audio: 1 });
  },
);
