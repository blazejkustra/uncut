// #77 (D264) on the packaged app: Add to chat from everywhere something can be referenced. A media
// tile's hover button (and its menu), a timeline item by ⌘L (the keymap's addToChat), a track
// head's menu and words picked in the Transcript ("Add these words to chat") each put a chip in the
// composer; sent, a scripted claude (helpers/fake-claude.ts) gets a <context> line with the real id
// for each, the same lines the composer's @ picker would give.
// Screenshots: test-output/issue77-tile.png, test-output/issue77-chips.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { fingerprint, writeCached } from "../../apps/server/src/analysis/analysis.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : !FFMPEG ? "needs ffmpeg" : false;

const WORDS = [
  { text: "Hello", start: 0.5, end: 1.0, p: 0.9 },
  { text: "there", start: 1.2, end: 1.5, p: 0.9 },
  { text: "this", start: 1.6, end: 2.0, p: 0.9 },
  { text: "is", start: 2.1, end: 2.3, p: 0.9 },
  { text: "a", start: 2.4, end: 2.5, p: 0.9 },
  { text: "test.", start: 2.6, end: 3.0, p: 0.9 },
];
const TRANSCRIPT = { hasAudio: true, seconds: 6, language: "en", requestedLanguage: "auto", model: "base", segments: [{ start: 0.5, end: 3, text: "Hello there this is a test.", words: [0, 6] }], words: WORDS };

let root = "";
let app: LaunchedApp | undefined;
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const value = (page: Page) => page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value);
const waitDraftEnds = (page: Page, tail: string) => page.waitForFunction((tail: string) => (document.querySelector("[data-testid=agent-input]") as HTMLTextAreaElement | null)?.value.endsWith(tail) === true, { timeout: 10000 }, tail);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue77-")));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Add to chat (#77): a media tile, a timeline item (⌘L), a track and transcript words become four chips, and the turn gets their ids", { skip, timeout: 180000 }, async () => {
  const media = join(root, "media");
  mkdirSync(media);
  execFileSync(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(media, "Talk.mp4")]);
  execFileSync(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(media, "Harbour.mp4")]);
  const dir = join(root, "Refs.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Refs",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [
        { id: "m-talk", kind: "video", name: "Talk.mp4", path: join(media, "Talk.mp4"), probe: { frames: 180, fps: 30, width: 320, height: 180, hasAudio: true } },
        { id: "m-harbour", kind: "video", name: "Harbour.mp4", path: join(media, "Harbour.mp4"), probe: { frames: 120, fps: 30, width: 320, height: 180, hasAudio: false } },
      ],
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 180 }] }],
    }),
  );
  await writeCached(dir, await fingerprint(join(media, "Talk.mp4")), "transcript", TRANSCRIPT);
  const log = join(root, "prompts.jsonl");
  const plan = join(root, "plan.json");
  writeFileSync(log, "");
  writeFileSync(plan, JSON.stringify([[{ text: "Got the four references." }]]));

  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log } });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, '[data-testid=timeline-item][data-item="clip-1"]');
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"));
  await page.click("[data-testid=agent-input]");
  await page.type("[data-testid=agent-input]", "compare");

  // 1. A media tile: its menu has Add to chat, and the hover button adds it.
  await page.click("[data-testid=rail-media]");
  const tile = '[data-testid=media-tile][data-id="m-harbour"]';
  await waitFor(page, tile);
  await page.click(tile, { button: "right" });
  await waitFor(page, "[data-testid=menu-media-add-to-chat]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=context-menu]"));
  await page.hover(tile);
  await page.waitForFunction((sel: string) => getComputedStyle(document.querySelector(`${sel} [data-testid=media-add-to-chat]`)!).opacity === "1", {}, tile);
  await page.screenshot({ path: "test-output/issue77-tile.png" });
  await page.click(`${tile} [data-testid=media-add-to-chat]`);
  await waitDraftEnds(page, "compare @Harbour.mp4 ");
  assert.equal(await page.$eval("[data-testid=tab-agent]", (el) => el.classList.contains("active")), true, "the Agent tab opened");

  // 2. A timeline item: selected, then ⌘L (the keymap's "Add the selection to the agent chat").
  await page.click('[data-testid=timeline-item][data-item="clip-1"]');
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyL");
  await page.keyboard.up("Meta");
  await waitDraftEnds(page, "@Harbour.mp4 @Talk.mp4 ");

  // 3. A track head's menu.
  await page.click('[data-testid=track][data-id="main"]', { button: "right" });
  await waitFor(page, "[data-testid=menu-add-to-chat]");
  await page.click("[data-testid=menu-add-to-chat]");
  await waitDraftEnds(page, "@Talk.mp4 @Main ");

  // 4. Words in the Transcript: "this is" (1.6 s–2.3 s, frames 48–69).
  await page.click("[data-testid=rail-transcript]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word]").length === 6, { timeout: 15000 });
  await page.click("[data-testid=tx-word][data-index='2']");
  await page.keyboard.down("Shift");
  await page.click("[data-testid=tx-word][data-index='3']");
  await page.keyboard.up("Shift");
  await waitFor(page, "[data-testid=tx-add-to-chat]");
  await page.click("[data-testid=tx-add-to-chat]");
  await waitDraftEnds(page, '@Main @"this is" 0:01.6 ');

  // Four chips in the composer.
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=composer] [data-testid=agent-chip]").length === 4);
  assert.deepEqual(await page.$$eval("[data-testid=composer] [data-testid=agent-chip]", (els) => els.map((e) => e.textContent)), ["@Harbour.mp4", "@Talk.mp4", "@Main", '@"this is" 0:01.6']);
  assert.equal(await value(page), 'compare @Harbour.mp4 @Talk.mp4 @Main @"this is" 0:01.6 ');
  await page.screenshot({ path: "test-output/issue77-chips.png" });

  // Sent: the fake claude got each reference with its real id.
  await page.focus("[data-testid=agent-input]");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 30000 });
  assert.equal((await page.$$("[data-testid=agent-prompt] [data-testid=agent-chip]")).length, 4, "the turn card shows the four chips");
  const sent = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).prompt as string)
    .find((p) => p.includes("<context>"));
  assert.ok(sent, "a prompt with a <context> block");
  assert.match(sent, /@Harbour\.mp4 = media m-harbour \(video/);
  assert.match(sent, /@Talk\.mp4 = item clip-1 \(clip on track main.*\), frames 0–180/);
  assert.match(sent, /@Main = track main \(video, main, 1 item\)/);
  assert.match(sent, /@"this is" 0:01\.6 = the stretch from frame 48 to 69 .*clip-1/);
  assert.deepEqual(app.errors, []);
});
