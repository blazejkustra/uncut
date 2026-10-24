// Issues #24, #38, #39 (D204–D206) on the packaged app run invisibly and muted, with the stand-in
// claude and the fake argent (never the real one), and a data folder of the test's own:
// - #39: Media › Recent from other projects shows another project's Argent capture with its poster;
//   Add copies it into this project;
// - #24: the agent's argent_boot waits on a Boot card (device, kind, what happens); nothing boots
//   until Boot, then argent_record opens the app and records it into Media;
// - #38: at the end of a turn the agent's unused graphic goes to the trash and its empty track goes;
//   the turn says so and Restore puts the graphic back.
// Screenshots: test-output/issue39-*.png, issue24-*.png, issue38-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const FAKE_ARGENT = resolve("test/helpers/fake-argent/argent");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let other = "";
const apps = new Set<LaunchedApp>();
const shot = (name: string) => resolve("test-output", `${name}.png`);
const boots = () =>
  existsSync(join(root, "argent.jsonl"))
    ? readFileSync(join(root, "argent.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.boot).length
    : 0;

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue24-38-39-")));
  mkdirSync(join(root, "projects"), { recursive: true });
  // Another project ("test argent") with an Argent capture and its poster, in the recents.
  other = join(root, "projects", "test argent.uncut");
  mkdirSync(join(other, "media", "captures"), { recursive: true });
  mkdirSync(join(other, ".cache", "thumbs"), { recursive: true });
  const take = join(other, "media", "captures", "Argent Demo.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=390x844:rate=30",
    "-t",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    take,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    "0.5",
    "-i",
    take,
    "-frames:v",
    "1",
    "-vf",
    "scale=160:-2",
    join(other, ".cache", "thumbs", "m-take--0123456789ab.jpg"),
  ]);
  writeFileSync(
    join(other, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "test argent",
      canvas: { width: 1080, height: 1350, fps: 30 },
      media: [
        {
          id: "m-take",
          kind: "video",
          name: "Argent Demo",
          path: "media/captures/Argent Demo.mp4",
          source: { module: "argent.capture", device: "iPhone 16" },
          probe: { frames: 60, fps: 30, width: 390, height: 844, hasAudio: false },
        },
      ],
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }],
    }),
  );
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "recents.json"), JSON.stringify([{ dir: other, name: "test argent", openedAt: "2026-10-14T09:16:00.000Z" }]));
  writeFileSync(join(root, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "results.jsonl"), "");
  writeFileSync(join(root, "argent.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "issues 24, 38, 39: recent captures from another project, a Boot card before argent boots, the turn-end clean-up with Restore",
  { skip, timeout: 300000 },
  async () => {
    const plan = join(root, "plan.json");
    writeFileSync(
      plan,
      JSON.stringify([
        [
          { tool: "argent_boot", args: { device: "iPad Air", bundleId: "com.example.app" } },
          { tool: "argent_record", args: { device: "SIM-IPAD-OFF", bundleId: "com.example.app", seconds: 1 } },
          { text: "Booted the iPad and recorded the app." },
        ],
        [
          {
            tool: "graphic_write",
            args: { name: "keep.html", html: "<div style='color:#fff;font:700 120px sans-serif'>Argent</div><script>window.render=()=>{}</script>" },
          },
          { tool: "graphic_write", args: { name: "spare.html", html: "<div>spare</div><script>window.render=()=>{}</script>" } },
          { tool: "project_read" },
          {
            tool: "timeline_edit",
            args: {
              baseRevision: "$rev",
              summary: "The title graphic",
              ops: [
                { op: "add_track", track: { id: "gfx", kind: "video", name: "Graphics" }, index: 0 },
                { op: "add_track", track: { id: "spare-track", kind: "video", name: "Spare" }, index: 0 },
                { op: "place_item", track: "gfx", item: { id: "g-1", type: "graphic", src: "graphics/keep.html", duration: 60 }, start: 0, place: "after" },
              ],
            },
          },
          { text: "Added the title." },
        ],
      ]),
    );
    const app = await launchApp({
      command: APP,
      env: {
        UNCUT_DATA_DIR: join(root, "data"),
        UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
        UNCUT_CLAUDE: join(root, "claude"),
        FAKE_PLAN: plan,
        FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
        FAKE_RESULT_LOG: join(root, "results.jsonl"),
        ARGENT_BIN: FAKE_ARGENT,
        FAKE_ARGENT_NODE: process.execPath,
        FAKE_ARGENT_LOG: join(root, "argent.jsonl"),
        UNCUT_APPROVAL_MS: "60000",
      },
    });
    apps.add(app);
    const { page } = app;
    const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
    try {
      await waitForWelcome(page);
      await page.click("[data-testid=new-project]");
      await waitFor("[data-testid=new-project-form]");
      await page.click("[data-testid=choose-folder]");
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
      await page.click("[data-testid=create]");
      await waitFor("[data-testid=agent-panel]");
      const dir = join(
        root,
        "projects",
        readdirSync(join(root, "projects")).find((n) => n.endsWith(".uncut") && n !== "test argent.uncut")!,
      );

      // #39: the other project's capture, with its poster.
      await page.click("[data-testid=rail-media]");
      await waitFor("[data-testid=recent-media-item]", 20000);
      assert.equal(await page.$eval("[data-testid=recent-media-item] .gen-title", (el) => (el as HTMLElement).innerText.trim()), "Argent Demo");
      assert.equal(
        await page.$eval("[data-testid=recent-media-meta]", (el) => (el as HTMLElement).innerText.trim()),
        "Recording from test argent, 2 s, iPhone 16",
      );
      await page.waitForFunction(
        () => {
          const img = document.querySelector<HTMLImageElement>("[data-testid=recent-media-item] .gen-thumb img");
          return !!img && img.complete && img.naturalWidth > 0;
        },
        { timeout: 10000 },
      );
      await page.$eval("[data-testid=recent-media]", (el) => el.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: shot("issue39-recent-media") });
      await page.click("[data-testid=recent-media-add]");
      await page.waitForFunction(() => document.querySelector("[data-testid=recent-media-added]")?.textContent === "Copied into this project", {
        timeout: 20000,
      });
      await page.waitForFunction(
        () => [...document.querySelectorAll("[data-testid=media-grid] *")].some((el) => (el as HTMLElement).innerText?.includes("Argent Demo")),
        { timeout: 20000 },
      );
      assert.ok(existsSync(join(dir, "media", "imports", "Argent Demo.mp4")), "copied into this project");
      assert.ok(existsSync(join(other, "media", "captures", "Argent Demo.mp4")), "the other project's file stays");
      await page.screenshot({ path: shot("issue39-added") });

      // #24: Boot card; nothing boots until Boot.
      await page.click("[data-testid=agent-input]");
      await page.keyboard.type("Record the app on the iPad");
      await page.keyboard.press("Enter");
      await waitFor("[data-testid=agent-approval][data-kind=boot]", 30000);
      assert.equal(await page.$eval("[data-testid=agent-approval] .approval-text", (el) => (el as HTMLElement).innerText.trim()), "Boot iPad Air?");
      const lines = await page.$$eval("[data-testid=agent-boot-lines] > div", (els) => els.map((el) => (el as HTMLElement).innerText.trim()));
      assert.deepEqual(lines, [
        "iOS simulator",
        "Argent starts it on this Mac, which can take a minute. Then the agent opens com.example.app and records it into Media.",
      ]);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(boots(), 0, "nothing boots while the card waits");
      await page.$eval("[data-testid=agent-approval]", (el) => el.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: shot("issue24-boot-card") });
      await page.click("[data-testid=agent-allow]");
      await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=agent-turn]")].at(-1)?.getAttribute("data-status") === "done", {
        timeout: 60000,
      });
      assert.equal(boots(), 1, "one boot, after Boot");
      const recorded = readFileSync(join(root, "results.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.tool === "argent_record")
        .at(-1);
      assert.ok(recorded && !recorded.result.isError, JSON.stringify(recorded));
      await page.screenshot({ path: shot("issue24-recorded") });

      // #38: the clean-up line and Restore.
      await page.click("[data-testid=agent-input]");
      await page.keyboard.type("Add the title graphic");
      await page.keyboard.press("Enter");
      await waitFor("[data-testid=agent-cleanup]", 60000);
      assert.equal(
        await page.$eval("[data-testid=agent-cleanup] span", (el) => (el as HTMLElement).innerText.trim()),
        "Moved 1 unused graphic to the trash, removed an empty track",
      );
      assert.ok(!existsSync(join(dir, "graphics", "spare.html")));
      assert.ok(existsSync(join(dir, "graphics", "keep.html")));
      await page.$eval("[data-testid=agent-cleanup]", (el) => el.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: shot("issue38-cleanup") });
      await page.click("[data-testid=agent-cleanup-restore]");
      await page.waitForFunction(() => document.querySelector(".turn-cleanup-done")?.textContent === "Restored", { timeout: 15000 });
      assert.ok(existsSync(join(dir, "graphics", "spare.html")), "Restore put it back");
      await page.screenshot({ path: shot("issue38-restored") });
    } catch (error) {
      await page.screenshot({ path: shot("issue24-38-39-failure") }).catch(() => {});
      throw error;
    }
  },
);
