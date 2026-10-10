// Opens the wireframe in real Chrome, checks every state and the main clicks,
// and saves screenshots to test-output/ for a human look.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { serve } from "../scripts/serve.mjs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STATES = ["editor", "text", "agent", "mixer", "transcript", "capture", "generate", "onboarding", "export"];
let server, browser, base;

before(async () => {
  server = await serve(0);
  base = `http://127.0.0.1:${server.address().port}/wireframe/`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1440, height: 900 } });
  await mkdir("test-output", { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.close();
});

async function open(state) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()}`));
  await page.goto(`${base}#${state}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("body[data-ready=true]", { timeout: 5000 });
  return { page, errors };
}

for (const state of STATES) {
  test(`state ${state} renders cleanly`, async () => {
    const { page, errors } = await open(state);
    const r = await page.evaluate(() => ({
      unrenderedIcons: [...document.querySelectorAll("i[data-lucide]")].map((i) => i.dataset.lucide),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      clips: document.querySelectorAll(".clip").length,
      frameChildren: document.querySelector("#frame").children.length,
      modal: !document.querySelector("#modal-layer").hidden,
      side: document.querySelector("[data-side].active")?.dataset.side,
      bottom: document.querySelector("[data-bottom].active")?.dataset.bottom,
    }));
    await page.screenshot({ path: `test-output/wireframe-${state}.png` });
    assert.deepEqual(errors, [], "no console or page errors");
    assert.deepEqual(r.unrenderedIcons, [], "every lucide icon name exists");
    assert.equal(r.overflowX, false, "no horizontal page scroll");
    assert.ok(r.frameChildren > 0, "preview shows something at the playhead");
    if (r.bottom === "timeline") assert.equal(r.clips, 12, "all 12 items from the example project are on the timeline");
    assert.equal(r.modal, state === "onboarding" || state === "export");
    if (state === "agent") assert.equal(r.side, "agent");
    if (state === "mixer") assert.equal(r.bottom, "mixer");
    await page.close();
  });
}

test("main track clips sit back to back with no gaps", async () => {
  const { page } = await open("editor");
  const boxes = await page.$$eval('[data-track="main"] .clip', (els) => els.map((e) => [e.offsetLeft, e.offsetWidth]));
  assert.equal(boxes.length, 5);
  for (let i = 1; i < boxes.length; i++) {
    const prevEnd = boxes[i - 1][0] + boxes[i - 1][1];
    assert.ok(Math.abs(boxes[i][0] - prevEnd) <= 3, `clip ${i} starts where clip ${i - 1} ends`);
  }
  await page.close();
});

test("clicking works: rail, tabs, clips, text subtabs", async () => {
  const { page, errors } = await open("editor");
  await page.click('[data-lib="transitions"]');
  assert.match(await page.$eval("#library", (e) => e.textContent), /Crossfade/);
  await page.click('[data-side="agent"]');
  assert.ok(await page.$('[data-testid="agent-thread"]'));
  await page.click('.clip[data-item="txt-result"]');
  assert.equal(await page.$eval("[data-side].active", (e) => e.dataset.side), "inspector", "selecting a clip opens the inspector");
  assert.match(await page.$eval(".insp-title", (e) => e.textContent), /Text/);
  assert.match(await page.$eval("#frame", (e) => e.textContent), /Found the bug/, "playhead moved to the clicked text");
  await page.click('[data-text-tab="Animation"]');
  assert.match(await page.$eval("#side-body", (e) => e.textContent), /Per word/);
  await page.click('[data-bottom="mixer"]');
  assert.equal((await page.$$('[data-testid="mixer-strip"]')).length, 3);
  await page.click('[data-state-link="onboarding"]');
  await page.waitForSelector('[data-testid="onboarding"]');
  await page.click('.wiz-steps [data-ob-step="2"]');
  await page.click(".wiz-foot [data-close]");
  assert.equal(await page.$eval("#modal-layer", (e) => e.hidden), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("no generic suggestion chips anywhere (premise 14h)", async () => {
  for (const state of ["editor", "agent"]) {
    const { page } = await open(state);
    const text = await page.$eval("body", (e) => e.innerText);
    for (const banned of ["Tighten the pacing", "Make the hook punchier", "Cut the scenes to the beat", "Image #1", "Dark (Expo)"]) {
      assert.ok(!text.includes(banned), `"${banned}" must not appear`);
    }
    await page.close();
  }
});

test("onboarding walks through all three steps", async () => {
  const { page, errors } = await open("onboarding");
  assert.match(await page.$eval(".wiz-panel h1", (e) => e.textContent), /Connect your agents/);
  await page.click('.wiz-foot [data-ob-step="1"]');
  assert.match(await page.$eval(".wiz-panel h1", (e) => e.textContent), /Record your apps/);
  await page.click('.wiz-foot .btn.primary[data-ob-step="2"]');
  assert.match(await page.$eval(".wiz-panel h1", (e) => e.textContent), /Start a video/);
  await page.screenshot({ path: "test-output/wireframe-onboarding-3.png" });
  await page.click(".wiz-foot [data-close]");
  assert.equal(await page.$eval("#modal-layer", (e) => e.hidden), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("generate covers image, video and audio, and says where results go", async () => {
  const { page } = await open("generate");
  for (const mode of ["video", "audio"]) {
    await page.click(`[data-gen-mode="${mode}"]`);
    const text = await page.$eval("#library", (e) => e.innerText);
    assert.match(text, /After generating/);
    assert.match(text, /lands in Media/);
  }
  await page.screenshot({ path: "test-output/wireframe-generate-audio.png" });
  await page.close();
});

test("transcript lives in the bottom panel, not in the Text library", async () => {
  const { page } = await open("text");
  assert.doesNotMatch(await page.$eval("#library", (e) => e.innerText), /transcript/i);
  await page.click('[data-bottom="transcript"]');
  assert.ok(await page.$('[data-testid="transcript"]'));
  assert.equal(await page.$$eval(".tr-word.filler", (els) => els.length), 2);
  await page.close();
});

test("audio tab shows project tracks and a free library", async () => {
  const { page } = await open("mixer");
  const text = await page.$eval("#library", (e) => e.innerText);
  assert.match(text, /In this project/);
  assert.match(text, /Voiceover/);
  assert.match(text, /royalty free/i);
  await page.click('[data-audio-mode="sfx"]');
  assert.match(await page.$eval("#library", (e) => e.innerText), /Whoosh/);
  await page.close();
});
