// Phase 2: the editor on real drone footage. These tests drive the Electron app and
// check pixels against frames ffmpeg pulls from the source file, so "it plays" means
// the right frame is on screen, not just that a <video> exists.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchEditor } from "./helpers/electron.mjs";

const DEMO = "fixtures/drone-demo.uncut/project.json";
const skip = !existsSync(DEMO) && "needs fixtures/drone-demo.uncut (node spikes/editor/make-demo.mjs)";
const dir = resolve("test-output/editor-test.uncut");
const out = (f) => resolve("test-output", f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app, page, src;

const onDisk = () => JSON.parse(readFileSync(`${dir}/project.json`, "utf8"));
const item = (p, id) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id);

/** SSIM between two images, both scaled to 480×270 grey. 1 means identical. */
function ssimOf(a, b) {
  const r = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i "${a}" -i "${b}" -lavfi "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim" -f null - 2>&1`]).toString();
  return Number(r.match(/All:([\d.]+)/)[1]);
}
/** Best SSIM between the preview and any source frame within ±0.1 s of `seconds`. */
function bestMatch(shot, seconds, tag) {
  const pattern = out(`win-${tag}-%02d.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, seconds - 0.1)), "-i", src, "-t", "0.2", "-map", "0:v:0", "-vf", "scale=480:270", pattern]);
  let best = 0;
  for (let i = 1; existsSync(pattern.replace("%02d", String(i).padStart(2, "0"))); i++) best = Math.max(best, ssimOf(shot, pattern.replace("%02d", String(i).padStart(2, "0"))));
  return best;
}
async function settle() {
  await page.waitForFunction(() => window.__uncut.videos().every((v) => !v.seeking && v.ready >= 2), { timeout: 5000 });
  await sleep(120);
}

before(async () => {
  if (skip) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/project.json`, readFileSync(DEMO));
  src = onDisk().media[0].path;
  app = await launchEditor({ project: dir });
  page = app.page;
});
after(async () => app?.close());

test("opens the project with no errors and draws every clip", { skip }, async () => {
  assert.equal(await page.evaluate(() => document.body.dataset.ready), "true");
  const clips = await page.$$eval(".tl-lane .clip", (els) => els.map((e) => e.dataset.item));
  assert.deepEqual(clips, ["txt-title", "txt-city", "reveal", "city", "above", "quarry", "orbit", "bench"]);
  assert.equal(await page.$$eval(".trans", (els) => els.length), 2);
  assert.deepEqual(app.errors, []);
});

test("the preview shows the right moment of the source file", { skip }, async (t) => {
  const p = onDisk();
  for (const [id, offset] of [["reveal", 100], ["above", 150], ["bench", 200]]) {
    const it = item(p, id);
    const start = await page.evaluate((i) => window.__uncut.project.tracks.find((t) => t.role === "main").items.find((x) => x.id === i)._start, id);
    await page.evaluate((f) => window.__uncut.setFrame(f), start + offset);
    await settle();
    const shot = out(`pv-${id}.png`);
    await (await page.$("#frame")).screenshot({ path: shot });
    const secs = (it.in + offset) / 60;
    const right = bestMatch(shot, secs, id);
    const wrong = bestMatch(shot, (item(p, id === "reveal" ? "orbit" : "reveal").in + offset) / 60, `${id}-other`);
    t.diagnostic(`${id}: SSIM ${right} own shot, ${wrong} other shot`);
    assert.ok(right > 0.6, `${id}: preview doesn't match the source at ${secs.toFixed(2)}s (SSIM ${right})`);
    assert.ok(right > wrong + 0.1, `${id}: preview matches another shot as well as its own (${right} vs ${wrong})`);
  }
});

test("scrubbing the ruler lands every seek in under 150 ms (median)", { skip }, async (t) => {
  const ruler = await (await page.$("#ruler")).boundingBox();
  const times = [];
  for (let i = 0; i < 12; i++) {
    const x = ruler.x + 10 + ((i * 7919) % 97) / 97 * (ruler.width - 300);
    const t0 = Date.now();
    await page.mouse.click(x, ruler.y + ruler.height / 2);
    await settle();
    times.push(Date.now() - t0 - 120);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1];
  t.diagnostic(`settle ms: ${times.join(", ")}`);
  assert.ok(median < 150, `median settle ${median} ms (${times.join(", ")})`);
});

test("playback runs in real time across a crossfade, with both shots mixed mid-way", { skip }, async (t) => {
  await page.evaluate(() => window.__uncut.setFrame(300)); // 1 s before the city cut at 360
  await settle();
  const t0 = Date.now();
  await page.evaluate(() => window.__uncut.play());
  await page.waitForFunction(() => window.__uncut.frame >= 360);
  const mid = await page.evaluate(() => window.__uncut.videos());
  await sleep(1500);
  const frame = await page.evaluate(() => window.__uncut.frame);
  const elapsed = (Date.now() - t0) / 1000;
  await page.evaluate(() => window.__uncut.pause());
  const rate = (frame - 300) / elapsed;
  t.diagnostic(`rate ${rate.toFixed(1)} fps; at the cut: ${JSON.stringify(mid)}`);
  assert.ok(rate > 54 && rate < 66, `played ${rate.toFixed(1)} frames per second`);
  const visible = mid.filter((v) => v.opacity > 0);
  assert.deepEqual(visible.map((v) => v.id).sort(), ["city", "reveal"], "both clips are on screen at the cut");
  assert.ok(visible.find((v) => v.id === "city").opacity < 1, "the incoming clip is still fading in");
  assert.ok(visible.every((v) => !v.paused), "both clips are playing");
});

test("transition maths: half before the cut, half after", { skip }, async () => {
  const at = (f) => page.evaluate((x) => window.__uncut.visualsAt(x), f);
  assert.deepEqual((await at(344)).map((v) => v.id), ["reveal"]);
  const mid = await at(360);
  assert.deepEqual(mid.map((v) => v.id), ["reveal", "city"]);
  assert.equal(mid[1].opacity, 0.5);
  assert.ok(Math.abs(mid[1].source - (item(onDisk(), "city").in - 0) / 60) < 0.001, "city starts at its in-point on the cut");
  assert.deepEqual((await at(376)).map((v) => v.id), ["city"]);
});

test("dragging a clip's end edge trims it, saves, and undo/redo work", { skip }, async () => {
  const before = item(onDisk(), "above").duration;
  await page.click('[data-side="inspector"]');
  const edge = await (await page.$('.clip[data-item="above"] .edge.r')).boundingBox();
  const ppf = await page.evaluate(() => document.querySelector('.clip[data-item="above"]').offsetWidth / 300);
  const y = edge.y + edge.height * 0.75; // below the transition chip
  await page.mouse.move(edge.x + 3, y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 3 - 60 * ppf, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((d) => window.__uncut.project.tracks.find((t) => t.role === "main").items.find((i) => i.id === "above").duration < d, {}, before);
  const trimmed = item(onDisk(), "above").duration;
  assert.ok(before - trimmed > 50 && before - trimmed < 70, `trimmed ${before - trimmed} frames, wanted about 60`);
  assert.equal(await page.evaluate(() => window.__uncut.duration), 2100 - (before - trimmed), "the main track closed the gap");
  await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
  await page.waitForFunction((d) => window.__uncut.project.tracks.find((t) => t.role === "main").items.find((i) => i.id === "above").duration === d, {}, before);
  assert.equal(item(onDisk(), "above").duration, before, "undo is saved");
  await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("z"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta");
  await page.waitForFunction((d) => window.__uncut.project.tracks.find((t) => t.role === "main").items.find((i) => i.id === "above").duration === d, {}, trimmed);
});

test("S splits at the playhead and Backspace deletes the selection", { skip }, async () => {
  const orbit = await page.evaluate(() => window.__uncut.project.tracks.find((t) => t.role === "main").items.find((i) => i.id === "orbit"));
  await page.evaluate((f) => window.__uncut.setFrame(f), orbit._start + 120);
  await page.click('.clip[data-item="orbit"] .nm');
  await page.evaluate((f) => window.__uncut.setFrame(f), orbit._start + 120);
  await page.keyboard.press("s");
  await page.waitForFunction(() => window.__uncut.project.tracks.find((t) => t.role === "main").items.some((i) => i.id === "orbit-2"));
  const p = onDisk();
  assert.equal(item(p, "orbit").duration, 120);
  assert.equal(item(p, "orbit-2").in, orbit.in + 120);
  await page.click('.clip[data-item="orbit-2"] .nm');
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => !window.__uncut.project.tracks.find((t) => t.role === "main").items.some((i) => i.id === "orbit-2"));
  assert.equal(item(onDisk(), "orbit-2"), undefined);
});

test("editing text in the inspector updates the preview and the file", { skip }, async () => {
  await page.evaluate(() => window.__uncut.setFrame(120));
  await page.click('.clip[data-item="txt-title"] .nm');
  await page.waitForSelector("[data-text]");
  await page.$eval("[data-text]", (el) => { el.value = "Over Kraków"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#text-layer [data-item="txt-title"]')?.textContent === "Over Kraków");
  assert.equal(item(onDisk(), "txt-title").text, "Over Kraków");
});

test("an invalid edit is refused with a message and changes nothing", { skip }, async () => {
  const before = readFileSync(`${dir}/project.json`, "utf8");
  await page.click('.trans[data-transition="city"]');
  await page.waitForSelector("[data-transition-duration]");
  await page.$eval("[data-transition-duration]", (el) => { el.value = "100000"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForSelector("#toast:not([hidden])");
  assert.match(await page.$eval("#toast", (e) => e.textContent), /invalid/);
  assert.equal(readFileSync(`${dir}/project.json`, "utf8"), before);
  await (await page.$("#frame")).screenshot({ path: out("editor-final-frame.png") });
  await page.screenshot({ path: out("editor.png") });
  assert.deepEqual(app.errors, []);
});
