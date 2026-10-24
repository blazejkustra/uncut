// Issue #118 on the packaged app (background window), through the UI, on a short music video edit
// (three clips on Main over a song):
// - skimming: the pointer over the lanes shows its frame in the preview (the playhead stays), and a
//   media tile's video skimmed in the library shows in the preview too;
// - play from the cursor: Space while skimming, and the ruler's Play from here;
// - replace a fragment: In to Out inside the first clip replaced with another media from the
//   library's menu, nothing after it moving;
// - mark and lock sections: In to Out locked and another stretch flagged not OK from the ruler's
//   menu, drawn on the ruler and over the lanes; a ripple delete before the lock refused, and the
//   agent's ripple trim refused too, the agent told which sections are which;
// - region references: an area dragged over the preview with the Area tool goes to the chat as a
//   chip, drawn on the preview, and the agent gets its rectangle and what's in it.
// Screenshots: test-output/issue118-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { layout, type Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve(process.env.UNCUT_TEST_APP ?? "dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (name: string) => resolve("test-output", `issue118-${name}.png`);
const plan = () => join(root, "plan.json");
const prompts = () => join(root, "prompts.jsonl");
const results = () => join(root, "results.jsonl");
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const mainOf = (p: Project) => p.tracks.find((t) => t.role === "main")!.items;
const startsOf = (p: Project) => Object.fromEntries(layout(p).starts);
const frameOf = (selector: string) => page.$eval(selector, (el) => Number((el as HTMLElement).dataset.frame));
const playheadFrame = () => frameOf("[data-testid=playhead]");
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) >= r,
    { timeout: 10000 },
    n,
  );
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));

/** Screen x of timeline frame `f` (from the first clip's box), and a y on the main lane. */
async function timelineAt(f: number) {
  const box = (await (await page.$('[data-testid=timeline-item][data-item="c3"]'))!.boundingBox())!;
  const start = startsOf(onDisk()).c3!;
  const ppf = box.width / 150;
  return { x: box.x - start * ppf + f * ppf, y: box.y + box.height / 2 };
}
async function rulerAt(f: number) {
  const { x } = await timelineAt(f);
  const r = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  return { x, y: r.y + 10 };
}
/** The playhead to frame `f` with the keyboard, then mark In or Out there. */
async function goTo(f: number) {
  await page.mouse.move(5, 5);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(f / FPS); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < f % FPS; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((x) => Number(document.querySelector<HTMLElement>("[data-testid=playhead]")!.dataset.frame) === x, { timeout: 5000 }, f);
}
async function marks(from: number, to: number) {
  await goTo(from);
  await page.keyboard.press("i");
  await goTo(to);
  await page.keyboard.press("o");
  await page.waitForFunction(
    (a, b) =>
      document.querySelector<HTMLElement>("[data-testid=marks]")?.dataset.in === String(a) &&
      document.querySelector<HTMLElement>("[data-testid=marks]")?.dataset.out === String(b),
    { timeout: 5000 },
    from,
    to,
  );
}
async function rulerMenu(f: number, entry: string) {
  const { x, y } = await rulerAt(f);
  await page.mouse.click(x, y, { button: "right" });
  await page.waitForSelector(`[data-testid=menu-${entry}]`, { timeout: 5000 });
  await page.click(`[data-testid=menu-${entry}]`);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue118-app-")));
  // Two takes (20 s each, 1280×720) and the song.
  for (const [name, src] of [
    ["take-a.mp4", "testsrc2"],
    ["take-b.mp4", "smptebars"],
  ] as const) {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `${src}=s=1280x720:r=${FPS}`,
      "-t",
      "20",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "30",
      "-pix_fmt",
      "yuv420p",
      join(root, name),
    ]);
  }
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:beep_factor=4:d=20", "-c:a", "aac", join(root, "song.m4a")]);
  const probe = { frames: 20 * FPS, fps: FPS, width: 1280, height: 720, hasAudio: false };
  dir = writeProject(root, "Music video", {
    format: "uncut/0",
    name: "Music video",
    canvas: { width: 1920, height: 1080, fps: FPS },
    media: [
      { id: "m-a", kind: "video", name: "take-a.mp4", path: join(root, "take-a.mp4"), probe },
      { id: "m-b", kind: "video", name: "take-b.mp4", path: join(root, "take-b.mp4"), probe },
      { id: "m-song", kind: "audio", name: "song.m4a", path: join(root, "song.m4a"), probe: { frames: 20 * FPS, hasAudio: true } },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "c1", type: "clip", media: "m-a", in: 0, duration: 150 },
          { id: "c2", type: "clip", media: "m-b", in: 0, duration: 150 },
          { id: "c3", type: "clip", media: "m-a", in: 300, duration: 150 },
        ],
      },
      { id: "audio", kind: "audio", name: "Song", items: [{ id: "song", type: "audio", media: "m-song", in: 0, start: 0, duration: 450 }] },
    ],
  });
  writeFileSync(prompts(), "");
  writeFileSync(results(), "");
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: prompts(),
      FAKE_RESULT_LOG: results(),
    },
  });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector('[data-testid=timeline-item][data-item="c3"]', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=filmstrip][data-ready=true]"), { timeout: 60000 }).catch(() => {});
  await sleep(500);
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("skimming: the timeline's frame under the pointer, and a media tile's video, in the preview", { skip, timeout: 60000 }, async () => {
  await goTo(10);
  const { x, y } = await timelineAt(240);
  await page.mouse.move(x, y);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.hover === "true", { timeout: 5000 });
  const skimmed = await frameOf("[data-testid=skimmer]");
  assert.ok(Math.abs(skimmed - 240) <= 2, `skimmer at ${skimmed}`);
  assert.equal(await frameOf("[data-testid=preview-frame]"), skimmed, "the preview draws the skimmed frame");
  assert.equal(await playheadFrame(), 10, "the playhead stays");
  await sleep(400);
  await page.screenshot({ path: shot("skimming") });
  // Leaving the lanes shows the playhead's frame again.
  await page.mouse.move(5, 5);
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.hover &&
      document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame === "10",
    { timeout: 5000 },
  );
  // A media tile's video skimmed in the library.
  const tile = (await (await page.$('[data-testid=media-tile][data-id="m-b"]'))!.boundingBox())!;
  await page.mouse.move(tile.x + tile.width * 0.5, tile.y + tile.height * 0.3);
  await page.mouse.move(tile.x + tile.width * 0.6, tile.y + tile.height * 0.3);
  await page.waitForSelector('[data-testid=media-skim][data-media="m-b"]', { timeout: 5000 });
  await sleep(600);
  await page.screenshot({ path: shot("skimming-media") });
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector("[data-testid=media-skim]"), { timeout: 5000 });
});

test("play from the cursor: Space while skimming, and the ruler's Play from here", { skip, timeout: 60000 }, async () => {
  await goTo(0);
  const { x, y } = await timelineAt(300);
  await page.mouse.move(x, y);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.hover === "true", { timeout: 5000 });
  const from = await frameOf("[data-testid=skimmer]");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.playing === "true", { timeout: 5000 });
  await sleep(300);
  const at = await playheadFrame();
  assert.ok(at >= from && at < from + 40, `playing from ${from}: at ${at}`);
  await page.keyboard.press("k");
  await page.mouse.move(5, 5);
  await rulerMenu(90, "play-from-here");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.playing === "true", { timeout: 5000 });
  await sleep(200);
  const again = await playheadFrame();
  await page.keyboard.press("k");
  assert.ok(again >= 88 && again < 130, `played from 90: at ${again}`);
});

test("replace a fragment: In to Out in the first clip plays the other take, nothing after it moves", { skip, timeout: 60000 }, async () => {
  const before = startsOf(onDisk());
  const rev = await revision();
  await marks(30, 60);
  await page.click('[data-testid=timeline-item][data-item="c1"]');
  const tile = (await (await page.$('[data-testid=media-tile][data-id="m-b"]'))!.boundingBox())!;
  await page.mouse.move(tile.x + tile.width * 0.5, tile.y + tile.height * 0.3);
  await page.mouse.click(tile.x + tile.width * 0.5, tile.y + tile.height * 0.3, { button: "right" });
  await page.waitForSelector("[data-testid=menu-media-replace-range]", { timeout: 5000 });
  await page.click("[data-testid=menu-media-replace-range]");
  await waitRevision(rev + 1);
  const p = onDisk();
  assert.deepEqual(
    mainOf(p).map((i) => [i.media, i.duration]),
    [
      ["m-a", 30],
      ["m-b", 30],
      ["m-a", 90],
      ["m-b", 150],
      ["m-a", 150],
    ],
  );
  const now = startsOf(p);
  for (const id of ["c2", "c3", "song"]) assert.equal(now[id], before[id], id);
  await page.mouse.move(5, 5);
  await sleep(500);
  await page.screenshot({ path: shot("replace") });
});

test(
  "mark and lock: a locked stretch and a not-OK one on the timeline; a ripple before the lock refused, the user's and the agent's",
  { skip, timeout: 120000 },
  async () => {
    let rev = await revision();
    await marks(150, 300);
    await rulerMenu(200, "lock-range");
    await waitRevision(++rev);
    await page.waitForSelector('[data-testid=section][data-state="locked"]', { timeout: 5000 });
    await marks(330, 420);
    await rulerMenu(350, "redo-range");
    await waitRevision(++rev);
    await page.waitForSelector('[data-testid=section][data-state="redo"]', { timeout: 5000 });
    assert.deepEqual(
      onDisk().sections!.map((s) => [s.start, s.end, s.state]),
      [
        [150, 300, "locked"],
        [330, 420, "redo"],
      ],
    );
    // A ripple delete of the first clip would pull the locked clip earlier: refused, nothing changes.
    const before = JSON.stringify(mainOf(onDisk()));
    await page.click('[data-testid=timeline-item][data-item="c1"]');
    await page.keyboard.down("Shift");
    await page.keyboard.press("Backspace");
    await page.keyboard.up("Shift");
    await page.waitForSelector("[data-testid=editor-error]", { timeout: 5000 });
    assert.match(await page.$eval("[data-testid=editor-error]", (el) => el.textContent ?? ""), /locked/);
    await sleep(300);
    await page.screenshot({ path: shot("lock") });
    assert.equal(JSON.stringify(mainOf(onDisk())), before);
    assert.equal(await revision(), rev);
    await page.click("[data-testid=editor-error] button");
    await page.keyboard.press("Escape");
    await page.mouse.move(5, 5);

    // The agent is told, and its ripple trim before the lock is refused.
    writeFileSync(
      plan(),
      JSON.stringify([
        [
          { tool: "project_read" },
          {
            tool: "timeline_edit",
            args: { baseRevision: "$rev", summary: "Tighten the opening", ops: [{ op: "trim_item", item: "c1", edge: "end", frames: 10 }] },
          },
          { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Unlock it", ops: [{ op: "update_project", set: { sections: null } }] } },
          { text: "The opening can't be tightened without moving the locked part." },
        ],
      ]),
    );
    await page.click("[data-testid=tab-agent]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 30000 });
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("tighten the opening");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 60000 });
    const sent = readFileSync(prompts(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { prompt?: string })
      .filter((x) => x.prompt)
      .at(-1)!.prompt!;
    assert.match(sent, /Marked sections .*\n.*frames 150–300 .*LOCKED[\s\S]*frames 330–420 .*NOT OK/);
    const logged = readFileSync(results(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { tool: string; result: { isError?: boolean; content: Array<{ text: string }> } });
    assert.match(logged.find((r) => r.tool === "project_read")!.result.content[0]!.text, /"sections":"section-1: frames 150–300/);
    const edits = logged.filter((r) => r.tool === "timeline_edit");
    assert.equal(edits.length, 2);
    assert.match(edits[0]!.result.content[0]!.text, /locked/);
    assert.match(edits[1]!.result.content[0]!.text, /only the user can unlock/);
    assert.equal(JSON.stringify(mainOf(onDisk())), before, "the agent changed nothing");
    assert.equal(onDisk().sections!.length, 2);
  },
);

test("region references: an area of the preview into the chat, drawn on the frame, and the agent gets it", { skip, timeout: 120000 }, async () => {
  await goTo(200);
  await page.click("[data-testid=preview-region]");
  await page.waitForSelector("[data-testid=region-catch]");
  const frame = (await (await page.$("[data-testid=preview-frame]"))!.boundingBox())!;
  // The top right quarter of the frame.
  await page.mouse.move(frame.x + frame.width * 0.55, frame.y + frame.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.75, frame.y + frame.height * 0.3, { steps: 5 });
  await page.mouse.move(frame.x + frame.width * 0.9, frame.y + frame.height * 0.45, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector("[data-testid=region-pick]");
  await page.screenshot({ path: shot("region-pick") });
  await page.click("[data-testid=region-add-frame]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=region-catch]"));
  await page.waitForSelector('[data-testid=region-pin][data-label="Area 0:06.7"]', { timeout: 5000 });
  assert.match(await page.$eval("[data-testid=agent-input]", (el) => (el as HTMLElement).innerText || (el as HTMLTextAreaElement).value), /@Area 0:06\.7/);
  await page.click("[data-testid=agent-input]");
  await page.keyboard.press("End");
  await page.keyboard.type("make this corner brighter");
  await sleep(300);
  await page.screenshot({ path: shot("region") });
  // Off its frame the pin isn't drawn.
  await goTo(10);
  assert.equal(await page.$("[data-testid=region-pin]"), null);
  await goTo(200);
  writeFileSync(plan(), JSON.stringify([[{ text: "x" }], [{ text: "I'll brighten that corner." }]]));
  await page.click("[data-testid=agent-input]");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelectorAll("[data-testid=agent-turn]").length === 2 &&
      [...document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")].every((t) => t.dataset.status === "done"),
    { timeout: 60000 },
  );
  const sent = readFileSync(prompts(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { prompt?: string })
    .filter((x) => x.prompt)
    .at(-1)!.prompt!;
  assert.match(
    sent,
    /@Area 0:06\.7 = an area of the picture the user marked: x 10\d\d–1[67]\d\d, y 1\d\d–4\d\d of the 1920x1080 canvas .* at frame 200 \(6\.67 s\); drawn in it: c2 \(clip "take-b\.mp4", track main\)/,
  );
  assert.deepEqual(app!.errors, []);
});
