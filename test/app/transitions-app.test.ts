// Transitions UI (D73) on the packaged app (background window): four solid-colour clips on main
// (red | blue | red | blue, cuts at 60, 120, 180; test/helpers/transition-fixture.ts).
// - The Transitions rail tab is on: six tiles (crossfade, dip to black, wipe, iris, push, zoom) with defaults.
// - Dragging the crossfade tile over the timeline highlights the cuts it fits; dropping it on the
//   cut at 60 adds a 15-frame crossfade (one edit, "Added crossfade" in history.db); the marker
//   straddles the cut and the Inspector shows it.
// - The Inspector's frames field and the marker's edge change its length ("Changed transition to
//   0.8 s"); ⌘Z / ⇧⌘Z step through them; the type picker changes the type.
// - Select the cut at 120 and click Dip to black; + on Wipe puts one on the cut nearest the playhead.
// - The preview at frames inside each transition shows the blend core says (opacity, wipe, the
//   dip's black), blending the clips' colours as the screen shows them (Chromium composites in the
//   display's encoding, Display P3 on a Mac; the export test holds the export to core's sRGB blend).
// - ⌫ with a transition selected removes it.
// Screenshots: test-output/transitions-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/timeline/types.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { close, expectedColour, makeTransitionMedia, transitionProject, type Rgb } from "../helpers/transition-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test clips") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const transitionOf = (id: string) => onDisk().tracks.find((t) => t.role === "main")!.items.find((i) => i.id === id)!.transitionIn;
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 10000 }, n);
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const frameNow = () => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
const marker = (id: string) => `[data-testid=transition-marker][data-item="${id}"]`;
const markerAttr = (id: string, key: "module" | "duration") => page.$eval(marker(id), (el, k) => (el as HTMLElement).dataset[k], key);
const box = async (selector: string) => {
  const b = await (await page.$(selector))?.boundingBox();
  assert.ok(b, `no box for ${selector}`);
  return b;
};
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0], shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
/** The labels history.db has for the edits after the first revision, oldest first. */
const historyLabels = () => {
  const db = new DatabaseSync(join(dir, "history.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT label FROM revisions WHERE kind = 'edit' ORDER BY revision").all() as Array<{ label: string }>).map((r) => r.label);
  } finally {
    db.close();
  }
};
/** Seek by keyboard (Home, ⇧→ for seconds, → for frames) and wait for the videos to settle. */
async function goTo(frame: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)), { timeout: 10000 });
  await sleep(250);
}
/** A screenshot's colour at x (a fraction of its width), mid-height, as 8-bit RGB. */
const colourIn = (path: string, x: number): Rgb => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", `crop=8:8:iw*${x}-4:ih/2-4,scale=1:1:flags=area,format=rgb24`, "-f", "rawvideo", "-"]);
  return [raw[0]!, raw[1]!, raw[2]!];
};
/** The preview's colour at x (a fraction of its width), mid-height, as the screenshot has it; kept as `name`. */
async function previewColour(name: string, x: number): Promise<Rgb> {
  const path = out(`transitions-${name}.png`);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
  return colourIn(path, x);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-transitions-app-")));
  makeTransitionMedia(join(root, "media"));
  dir = writeProject(root, "Transitions", transitionProject(join(root, "media"), {}));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("transitions: the panel, drag onto a cut, the marker and Inspector, length by field and edge, undo/redo, the other paths, the preview, delete", { skip, timeout: 240000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await page.waitForSelector("[data-testid=welcome]", { timeout: 15000 });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

  // The panel: six tiles, each with its default length.
  await page.click("[data-testid=rail-transitions]");
  await page.waitForSelector("[data-testid=transitions-library]");
  const tiles = await page.$$eval("[data-testid=transition-tile]", (els) => els.map((e) => [(e as HTMLElement).dataset.module, e.querySelector(".tile-name")!.textContent, e.querySelector("[data-testid=transition-default]")!.textContent]));
  assert.deepEqual(tiles, [
    ["transition.crossfade", "Crossfade", "0.5 s"],
    ["transition.dip-to-black", "Dip to black", "0.8 s"],
    ["transition.wipe", "Wipe", "0.5 s"],
    ["transition.iris", "Iris", "0.5 s"],
    ["transition.push-left", "Push", "0.5 s"],
    ["transition.zoom", "Zoom", "0.5 s"],
  ]);
  assert.equal(await page.$$eval("[data-testid=cut-point]", (els) => els.map((e) => Number((e as HTMLElement).dataset.frame)).join()), "60,120,180");
  await page.screenshot({ path: out("transitions-panel.png") });

  // Drag the crossfade tile over the timeline: every cut fits it (30 frames of handle each side).
  await page.setDragInterception(true);
  const tile = await box("[data-testid=transition-tile][data-module='transition.crossfade']");
  const cut = await box("[data-testid=cut-point][data-frame='60']");
  const target = { x: cut.x + cut.width / 2 + 6, y: cut.y + cut.height / 2 };
  const data = await page.mouse.drag({ x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 }, target);
  await page.mouse.dragEnter(target, data);
  await page.mouse.dragOver(target, data);
  await page.waitForSelector("[data-testid=cut-point][data-frame='60'].target");
  assert.deepEqual(await page.$$eval("[data-testid=cut-point]", (els) => els.map((e) => (e as HTMLElement).dataset.drop)), ["valid", "valid", "valid"]);
  await page.screenshot({ path: out("transitions-dragging.png") });
  const r0 = await revision();
  await page.mouse.drop(target, data);
  await page.setDragInterception(false);
  // puppeteer's intercepted drag leaves its button down.
  await page.mouse.up();
  await waitRevision(r0 + 1);
  assert.deepEqual(transitionOf("blue"), { module: "transition.crossfade", duration: 15 });
  await page.waitForSelector(marker("blue"));
  assert.equal(await markerAttr("blue", "duration"), "15");
  assert.equal(await page.$$eval("[data-testid=cut-point]", (els) => els.length), 2, "the cut at 60 is a marker now");
  // The marker straddles the cut: centred on frame 60, 15 frames wide.
  const k = await ppf();
  const m = await box(marker("blue"));
  const lanes = await box("[data-testid=ruler]");
  assert.ok(Math.abs(m.x + m.width / 2 - (lanes.x + 60 * k)) < 2, "centred on the cut");
  assert.ok(Math.abs(m.width - Math.max(14, 15 * k)) < 2, `width ${m.width} for 15 frames at ${k} px/frame`);
  // The clips' trim edges at the cut stay reachable under the marker (their middle isn't covered).
  for (const sel of ['[data-testid=timeline-item][data-item="red"] [data-edge=end]', '[data-testid=timeline-item][data-item="blue"] [data-edge=start]']) {
    const e = await box(sel);
    const hit = await page.evaluate((x, y) => (document.elementFromPoint(x, y) as HTMLElement | null)?.dataset.edge, e.x + e.width / 2, e.y + e.height * 0.75);
    assert.ok(hit, `${sel} is reachable`);
  }
  // The incoming clip's name starts after the marker, so it stays readable.
  const nameLeft = await page.$eval('[data-testid=timeline-item][data-item="blue"] .nm', (el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
  assert.ok(nameLeft >= m.x + m.width, `name at ${nameLeft}, marker ends at ${m.x + m.width}`);
  const counts = await page.$$eval(".bottom-toolbar .muted.small", (els) => els.map((e) => e.textContent));
  assert.ok(counts.includes("1 track"), `track count: ${counts}`);
  // The Inspector shows it.
  await page.waitForSelector("[data-testid=inspector-transition][data-item=blue]");
  assert.equal(await page.$eval("[data-testid=insp-transition-type]", (el) => (el as HTMLSelectElement).value), "transition.crossfade");
  assert.equal(await page.$eval("[data-testid=insp-transition-frames]", (el) => (el as HTMLInputElement).value), "15");
  // Seconds with a ".", whatever the system's locale.
  assert.equal(await page.$eval("[data-testid=insp-transition-seconds]", (el) => (el as HTMLInputElement).value), "0.5");
  assert.match(await page.$eval("[data-testid=insp-transition-range]", (el) => el.textContent ?? ""), /0\.07–1 s \(2–30 frames\)/);
  await page.screenshot({ path: out("transitions-marker.png") });
  await (await page.$("aside.side"))!.screenshot({ path: out("transitions-inspector.png") });

  // Length by the frames field: 24 frames, "Changed transition to 0.8 s".
  const frames = await page.$("[data-testid=insp-transition-frames]");
  await frames!.click({ clickCount: 3 });
  await page.keyboard.type("24");
  await page.keyboard.press("Enter");
  await waitRevision(r0 + 2);
  assert.equal(transitionOf("blue")?.duration, 24);
  await page.waitForFunction((sel) => document.querySelector<HTMLElement>(sel)?.dataset.duration === "24", {}, marker("blue"));
  assert.equal(await page.$eval("[data-testid=insp-transition-seconds]", (el) => (el as HTMLInputElement).value), "0.8");

  // Length by the marker's edge: the end edge 3 frames left of where it is (72 → 69) makes it ~18.
  const edge = await box(`${marker("blue")} [data-testid=transition-edge-end]`);
  const ex = edge.x + edge.width / 2;
  await page.mouse.move(ex, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(ex - 1.5 * k, edge.y + edge.height / 2, { steps: 3 });
  await page.mouse.move(ex - 3 * k, edge.y + edge.height / 2, { steps: 6 });
  await sleep(120);
  assert.match(await page.$eval("[data-testid=drag-tip]", (el) => el.textContent ?? ""), /frames\)/);
  await page.mouse.up();
  await waitRevision(r0 + 3);
  const dragged = transitionOf("blue")!.duration;
  assert.ok(dragged >= 16 && dragged <= 20, `dragged to ${dragged} frames`);
  await page.waitForFunction((sel, d) => document.querySelector<HTMLElement>(sel)?.dataset.duration === String(d), {}, marker("blue"), dragged);

  // ⌘Z twice: back to 24, then 15; ⇧⌘Z twice: 24, then the dragged length.
  await page.click("[data-testid=timeline]");
  await meta("KeyZ");
  await waitRevision(r0 + 4);
  assert.equal(transitionOf("blue")?.duration, 24);
  await meta("KeyZ");
  await waitRevision(r0 + 5);
  assert.equal(transitionOf("blue")?.duration, 15);
  await meta("KeyZ", true);
  await waitRevision(r0 + 6);
  await meta("KeyZ", true);
  await waitRevision(r0 + 7);
  assert.equal(transitionOf("blue")?.duration, dragged);
  await page.waitForFunction((sel, d) => document.querySelector<HTMLElement>(sel)?.dataset.duration === String(d), {}, marker("blue"), dragged);

  // Select the cut at 120, click Dip to black: 0.8 s (24 frames).
  await page.click("[data-testid=cut-point][data-frame='120']");
  await page.waitForSelector("[data-testid=inspector-transition][data-item=red-2]");
  await page.click("[data-testid=transition-tile][data-module='transition.dip-to-black']");
  await waitRevision(r0 + 8);
  assert.deepEqual(transitionOf("red-2"), { module: "transition.dip-to-black", duration: 24 });
  await page.waitForSelector(marker("red-2"));

  // + on Wipe with the playhead at 175: the nearest cut is 180.
  await goTo(175);
  await page.hover("[data-testid=transition-tile][data-module='transition.wipe']");
  await page.click("[data-testid=transition-tile][data-module='transition.wipe'] [data-testid=transition-add]");
  await waitRevision(r0 + 9);
  assert.deepEqual(transitionOf("blue-2"), { module: "transition.wipe", duration: 15 });
  await page.waitForSelector("[data-testid=inspector-transition][data-item=blue-2]");

  // Everything went to history.db with a readable label.
  assert.deepEqual(historyLabels().slice(-5), ["Added crossfade", "Changed transition to 0.8 s", `Changed transition to ${Math.round((dragged / 30) * 100) / 100} s`, "Added dip to black", "Added wipe"]);

  // The preview inside each transition shows what core says (the export test holds the export to the same).
  const project = onDisk();
  const half = dragged / 2;
  const checks: Array<[number, number, string]> = [
    [60, 0.5, "mid-crossfade"],
    [Math.ceil(60 - half / 2), 0.5, "crossfade-early"],
    [114, 0.5, "mid-dip-down"],
    [120, 0.5, "dip-cut"],
    [126, 0.5, "mid-dip-up"],
    [180, 0.25, "mid-wipe"],
    [180, 0.75, "mid-wipe"],
  ];
  // Chromium blends the layers in the display's encoding (Display P3 on a Mac screen), so the
  // reference blends the clips' colours as the screen shows them (pure red and blue, captured the
  // same way); on an sRGB screen that's the export's sRGB blend. What's checked is the
  // compositor's maths (opacity, wipe, the dip's black) against core's.
  await goTo(30);
  const red = await previewColour("red", 0.5);
  await goTo(90);
  const blue = await previewColour("blue", 0.5);
  for (const [f, x, name] of checks) {
    await goTo(f);
    const want = expectedColour(project, f, x, { red, blue });
    const got = await previewColour(name, x);
    console.log(`  preview frame ${f} at x ${x} (${name}): ${got.join(",")}; core ${expectedColour(project, f, x).join(",")}, on this screen ${want.join(",")}`);
    assert.ok(close(got, want, 6), `preview frame ${f} at ${x} (${name}): ${got} vs ${want}`);
  }

  // A transition selected, ⌫ removes it.
  await page.click(marker("red-2"));
  await page.waitForSelector("[data-testid=inspector-transition][data-item=red-2]");
  const r1 = await revision();
  await page.keyboard.press("Backspace");
  await waitRevision(r1 + 1);
  assert.equal(transitionOf("red-2"), undefined);
  await page.waitForFunction((sel) => !document.querySelector(sel), {}, marker("red-2"));
  assert.equal(historyLabels().at(-1), "Removed dip to black");
  // The cut stays selected, as a hard cut now.
  assert.match(await page.$eval("[data-testid=inspector-transition] .insp-title", (el) => el.textContent ?? ""), /Cut/);
  await page.screenshot({ path: out("transitions-final.png") });
  assert.deepEqual(app.errors, []);
});
