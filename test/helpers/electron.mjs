// Launches the editor in Electron with DevTools exposed and connects puppeteer to it.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

export async function launchEditor({ project, port = 9400 + Math.floor(Math.random() * 400) } = {}) {
  const env = { ...process.env, UNCUT_CDP: String(port) };
  if (project) env.UNCUT_PROJECT = resolve(project);
  const proc = spawn(resolve("node_modules/.bin/electron"), ["spikes/editor/main.cjs"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  let browser;
  for (let i = 0; i < 75 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 200));
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }).catch(() => null);
  }
  if (!browser) throw new Error(`Electron didn't start: ${stderr}`);
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().includes("spikes/editor/index.html"));
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.waitForFunction(() => document.body.dataset.ready, { timeout: 20000 });
  const close = async () => { await browser.disconnect(); proc.kill(); };
  return { page, browser, proc, errors, close, stderr: () => stderr };
}
