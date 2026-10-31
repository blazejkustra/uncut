// A graphic's frame stays hidden until its first render(t) finishes, so the document's undrawn
// markup never shows on the canvas and a press then can't pick one of its elements.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : "packaged app not built: run pnpm dist";
const RENDER_MS = 3000;

const GRAPHIC = `<style>html,body{background:#141414}.b{position:absolute;left:100px;top:100px;width:300px;height:200px;background:#e5534b}</style>
<div id="a" class="b"></div>
<script>
async function render(t) {
  await new Promise((r) => setTimeout(r, ${RENDER_MS}));
  document.getElementById("a").style.visibility = t >= 100 ? "visible" : "hidden";
}
</script>`;

const project = (): Project =>
  ({
    format: "uncut/0",
    name: "First render",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src: "graphics/scene.html", duration: 90 }] }],
  }) as Project;

let root = "";
let app: LaunchedApp | undefined;
let page: Page;

before(async () => {
  if (skip) return;
  await lockApps();
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-first-render-app-")));
  const dir = writeProject(root, "FirstRender", project());
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "scene.html"), GRAPHIC);
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
});

after(async () => {
  if (skip) return;
  await app?.close();
  unlockApps();
  rmSync(root, { recursive: true, force: true });
});

test("a graphic's frame is hidden until its first render finishes", { skip }, async () => {
  const frame = ".pv-graphic iframe";
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(frame, { timeout: 60000 });
  assert.equal(await page.$eval(frame, (e) => getComputedStyle(e).opacity), "0");
  await page.waitForFunction((s: string) => getComputedStyle(document.querySelector(s)!).opacity === "1", { timeout: RENDER_MS * 4 }, frame);
});
