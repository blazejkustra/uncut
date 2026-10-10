// Phase 1.4: the architecture page renders, its boxes don't collide, and every
// label fits inside its box.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { serve } from "../scripts/serve.mjs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let server, browser, page;
const errors = [];

before(async () => {
  server = await serve(0);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 900 } });
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}/spec/architecture/`, { waitUntil: "networkidle0" });
  await mkdir("test-output", { recursive: true });
  await page.screenshot({ path: "test-output/architecture.png", fullPage: true });
});
after(async () => {
  await browser?.close();
  server?.close();
});

test("renders without errors and shows all four flows", async () => {
  assert.deepEqual(errors, []);
  const flows = await page.$$eval("[data-flow]", (els) => els.map((e) => e.dataset.flow));
  assert.deepEqual(flows, ["open", "scrub", "agent", "export"]);
});

test("boxes don't overlap and every label fits in its box", async () => {
  const r = await page.$$eval("g.node", (nodes) =>
    nodes.map((g) => {
      const box = g.querySelector("rect").getBBox();
      const overflow = [...g.querySelectorAll("text")]
        .map((t) => ({ text: t.textContent, b: t.getBBox() }))
        .filter(({ b }) => b.x < box.x || b.y < box.y || b.x + b.width > box.x + box.width - 6 || b.y + b.height > box.y + box.height)
        .map((o) => o.text);
      return { id: g.dataset.node, box: { x: box.x, y: box.y, w: box.width, h: box.height }, overflow };
    }),
  );
  for (const n of r) assert.deepEqual(n.overflow, [], `labels spill out of "${n.id}"`);
  for (let i = 0; i < r.length; i++) {
    for (let j = i + 1; j < r.length; j++) {
      const a = r[i].box, b = r[j].box;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `"${r[i].id}" overlaps "${r[j].id}"`);
    }
  }
});

test("edge labels don't collide with each other or with boxes", async () => {
  const r = await page.evaluate(() => {
    const box = (b) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
    const labels = [...document.querySelectorAll("text.t-edge")].map((t) => ({ text: t.textContent, b: box(t.getBBox()) }));
    const nodes = [...document.querySelectorAll("g.node rect")].map((r) => ({ text: r.parentElement.dataset.node, b: box(r.getBBox()) }));
    const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const clashes = [];
    labels.forEach((l, i) => {
      labels.slice(i + 1).forEach((m) => hit(l.b, m.b) && clashes.push(`${l.text} / ${m.text}`));
      nodes.forEach((n) => hit(l.b, n.b) && clashes.push(`${l.text} / box ${n.text}`));
    });
    return clashes;
  });
  assert.deepEqual(r, []);
});

test("works at phone width without page scroll", async () => {
  await page.setViewport({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  await page.setViewport({ width: 1280, height: 900 });
});
