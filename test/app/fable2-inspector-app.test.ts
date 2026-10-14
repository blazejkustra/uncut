// Fable QA round 2, the Inspector chunk (planning/FEEDBACK.md F17, F18, F23; D160–D162) on the
// packaged app, run invisibly and muted, with real pointer events:
// - F17: the clip Inspector's sections fold (Transform open, Adjust and Advanced closed at first);
//   their state is this Mac's and survives a reload.
// - F18: an effect's switch turns it off and on (one edit each; project.json keeps it, marked bypass).
// - F23: a double click on a lower third on the canvas focuses its Name field in the Inspector, selected.
// Screenshots: test-output/fable2-inspector-*.png, fable2-effects-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
type Saved = { id: string; effects?: Array<{ module: string; bypass?: boolean; params?: Record<string, unknown> }> };
const onDisk = (): { tracks: Array<{ items: Array<Saved> }> } => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const itemOnDisk = (id: string) => onDisk().tracks.flatMap((t) => t.items).find((i) => i.id === id);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((want) => Number(/revision (\d+)/.exec((document.querySelector("[data-testid=saved]") as HTMLElement | null)?.title ?? "")?.[1] ?? -1) >= want, { timeout: 15000 }, n);
const rect = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const opened = async () => {
  const all = await page.$$eval("[data-testid=inspector-item] section.psec[data-section]", (els) => Object.fromEntries(els.map((e) => [(e as HTMLElement).dataset.section!, (e as HTMLElement).dataset.open === "true"])));
  return { transform: all.transform, adjust: all.adjust, effects: all.effects, speed: all.speed, advanced: all.advanced };
};
const shot = async (name: string) => page.screenshot({ path: resolve("test-output", `fable2-${name}.png`) });
const shotSide = async (name: string) => {
  const r = await rect("aside.side");
  await page.screenshot({ path: resolve("test-output", `fable2-${name}.png`), clip: { x: r.x, y: r.y, width: r.width, height: r.height } });
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-fable2-inspector-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "Shot.mp4")]);
  dir = join(root, "Inspector.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Inspector",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [{ id: "m-shot", kind: "video", name: "Shot.mp4", path: join(root, "Shot.mp4"), probe: { frames: 180, fps: 30, width: 640, height: 360, hasAudio: false } }],
      tracks: [
        { id: "overlay", kind: "video", name: "Overlay", items: [{ id: "lt", type: "component", component: "component.lower-third", start: 0, duration: 150, props: { name: "Ada Lovelace", title: "Engineer" }, transform: { x: 96, y: 780, w: 900, h: 200 } }] },
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: [{ id: "a", type: "clip", media: "m-shot", in: 0, duration: 150, effects: [{ module: "effect.posterize", params: { levels: 4 } }, { module: "effect.mirror" }] }],
        },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Fable QA round 2 Inspector: folding sections, effect switches, double click to edit an element", { skip, timeout: 240000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor(item("a"));

  // ---- F17: sections, their defaults, remembered across a reload ----
  await page.click(item("a"));
  await page.click("[data-testid=tab-inspector]");
  await waitFor("[data-testid=inspector-item][data-item=a]");
  assert.deepEqual(await opened(), { transform: true, adjust: false, effects: true, speed: true, advanced: false }, "Transform and Effects open, Adjust and Advanced closed");
  assert.equal(await page.$eval("[data-testid=insp-adjust] .psec-body", (el) => getComputedStyle(el).display), "none", "a closed section's controls are hidden");
  assert.equal(await page.$eval("[data-testid=insp-type]", (el) => el.textContent), "Clip", "but still there (readable)");
  await shotSide("inspector-default");
  await page.click("[data-testid=insp-adjust-toggle]");
  await page.click("[data-testid=insp-sec-transform-toggle]");
  await page.waitForFunction(() => document.querySelector("[data-testid=insp-adjust]")?.getAttribute("data-open") === "true");
  assert.deepEqual(await opened(), { transform: false, adjust: true, effects: true, speed: true, advanced: false });
  await waitFor("[data-testid=insp-adjust-exposure-value]", 3000);
  await shotSide("inspector-folded");
  // The same sections for another item: a lower third's Transform is closed too.
  await page.click(item("lt"));
  await waitFor("[data-testid=inspector-item][data-item=lt]");
  assert.equal((await opened()).transform, false, "the state is per section, not per item");

  await page.reload();
  await page.waitForSelector("[data-testid=editor], [data-testid=open-project]", { timeout: 30000 });
  if (await page.$("[data-testid=open-project]")) await page.click("[data-testid=open-project]");
  await waitFor(item("a"));
  await page.click(item("a"));
  await page.click("[data-testid=tab-inspector]");
  await waitFor("[data-testid=inspector-item][data-item=a]");
  assert.deepEqual(await opened(), { transform: false, adjust: true, effects: true, speed: true, advanced: false }, "remembered after a reload");
  // Back to the defaults' Transform for the rest.
  await page.click("[data-testid=insp-sec-transform-toggle]");

  // ---- F18: an effect's switch, one edit each way ----
  const posterize = "[data-testid=insp-effect][data-module='effect.posterize']";
  assert.equal(await page.$eval(`${posterize} [data-testid=insp-effect-power]`, (el) => el.getAttribute("aria-checked")), "true");
  let rev = await revision();
  await page.click(`${posterize} [data-testid=insp-effect-power]`);
  await waitRevision(rev + 1);
  await sleep(300);
  assert.equal(await revision(), rev + 1, "one edit");
  assert.deepEqual(itemOnDisk("a")!.effects, [{ module: "effect.posterize", params: { levels: 4 }, bypass: true }, { module: "effect.mirror" }], "kept in place, off");
  await waitFor(`${posterize}[data-off=true]`);
  assert.equal(await page.$eval(`${posterize} [data-testid=insp-effect-power]`, (el) => el.getAttribute("aria-checked")), "false");
  await page.$eval("[data-testid=insp-effects]", (el) => el.scrollIntoView({ block: "center" }));
  await shotSide("effects-off");
  await shot("effects-off-window");
  rev = await revision();
  await page.click(`${posterize} [data-testid=insp-effect-power]`);
  await waitRevision(rev + 1);
  await sleep(300);
  assert.equal(await revision(), rev + 1, "one edit");
  assert.deepEqual(itemOnDisk("a")!.effects, [{ module: "effect.posterize", params: { levels: 4 } }, { module: "effect.mirror" }], "on again");
  await waitFor(`${posterize}[data-off=false]`);
  await shotSide("effects-on");
  // Undo puts it back off and on (one step each).
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  await page.waitForFunction(() => document.querySelector("[data-testid=insp-effect][data-module='effect.posterize']")?.getAttribute("data-off") === "true", { timeout: 10000 });

  // ---- F23: a double click on a lower third on the canvas focuses its Name, selected ----
  await page.click(item("a"));
  await page.click("[data-testid=tab-agent]");
  const lt = await rect(".pv-comp[data-item=lt]");
  assert.ok(lt.width > 20 && lt.height > 10, `the lower third is on the canvas (${lt.width}×${lt.height})`);
  await page.mouse.click(lt.left + lt.width * 0.3, lt.top + lt.height / 2, { count: 2 });
  await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.testid === "param-name", { timeout: 5000 });
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLInputElement;
    return { value: el.value, start: el.selectionStart, end: el.selectionEnd, item: el.closest<HTMLElement>("[data-testid=component-editor]")?.dataset.item };
  });
  assert.deepEqual(focus, { value: "Ada Lovelace", start: 0, end: "Ada Lovelace".length, item: "lt" }, "the Inspector (switched to from Agent) has the lower third's Name focused, all selected");
  await shot("inspector-dblclick");
  // Typing replaces it (one edit on Enter).
  rev = await revision();
  await page.keyboard.type("Grace Hopper");
  await page.keyboard.press("Enter");
  await waitRevision(rev + 1);
  const props = (itemOnDisk("lt") as { props?: { name?: string } }).props;
  assert.equal(props?.name, "Grace Hopper");
  assert.deepEqual(app.errors, [], "no page errors");
});
