// Locked cuts on the packaged app: a clip locked from its menu shows it on the timeline, ⌘Z takes
// the lock back, and the agent's edit of a locked clip is refused with what to do.
// Screenshot: test-output/locked-cuts-timeline.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/index.ts";
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
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const clip = (id: string) => onDisk().tracks[0]!.items.find((i) => i.id === id)!;
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;

async function menuOn(id: string, entry: string) {
  const box = (await (await page.$(item(id)))!.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.waitForSelector(`[data-testid=menu-${entry}]`, { timeout: 5000 });
  await page.click(`[data-testid=menu-${entry}]`);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-locked-cuts-app-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=${FPS}`, "-t", "20", "-pix_fmt", "yuv420p", join(root, "take.mp4")]);
  dir = writeProject(root, "Locks", {
    format: "uncut/0",
    name: "Locks",
    canvas: { width: 1280, height: 720, fps: FPS },
    media: [{ id: "m-a", kind: "video", name: "take.mp4", path: join(root, "take.mp4"), probe: { frames: 20 * FPS, fps: FPS, width: 640, height: 360 } }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "c1", type: "clip", media: "m-a", in: 0, duration: 150 },
          { id: "c2", type: "clip", media: "m-a", in: 200, duration: 150 },
        ],
      },
    ],
  });
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "results.jsonl"), "");
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: join(root, "results.jsonl"),
    },
  });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(item("c2"), { timeout: 30000 });
});

after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a clip's lock shows on the timeline, ⌘Z takes it back, and the agent is refused with a reason", { skip }, async () => {
  await menuOn("c2", "lock");
  await page.waitForSelector(`${item("c2")} [data-testid=clip-lock]`, { timeout: 5000 });
  assert.equal(clip("c2").locked, true);
  await page.mouse.click(5, 5);
  await (await page.$("[data-testid=timeline]"))!.screenshot({ path: resolve("test-output", "locked-cuts-timeline.png") });

  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  await page.waitForFunction((s) => !document.querySelector(s), { timeout: 5000 }, `${item("c2")} [data-testid=clip-lock]`);
  assert.equal(clip("c2").locked, undefined);

  await menuOn("c2", "lock");
  await page.waitForSelector(`${item("c2")} [data-testid=clip-lock]`, { timeout: 5000 });
  writeFileSync(
    join(root, "plan.json"),
    JSON.stringify([
      [
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Unlock it", ops: [{ op: "update_item", item: "c2", set: { locked: null } }] } },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Ripple", ops: [{ op: "trim_item", item: "c1", edge: "end", frames: 10 }] } },
        { text: "I left the locked clip alone." },
      ],
    ]),
  );
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 30000 });
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("tighten it");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 60000 });
  const edits = readFileSync(join(root, "results.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { tool?: string; result: { content: Array<{ text: string }> } })
    .filter((r) => r.tool === "timeline_edit");
  assert.match(edits[0]!.result.content[0]!.text, /only the user can unlock/);
  assert.match(edits[1]!.result.content[0]!.text, /would move it from frame 150 to 140/);
  assert.equal(clip("c2").locked, true);
  assert.equal(clip("c1").duration, 150);
  assert.match(readFileSync(join(root, "prompts.jsonl"), "utf8"), /Locked by the user[^"]*c2/);

  await menuOn("c2", "lock");
  await page.waitForFunction((s) => !document.querySelector(s), { timeout: 5000 }, `${item("c2")} [data-testid=clip-lock]`);
  assert.equal(clip("c2").locked, undefined);
});
