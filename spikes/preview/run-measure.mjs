// Launches the harness, measures each clip given on the command line, prints JSON.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const port = 9333;
const electron = resolve("node_modules/.bin/electron");
const proc = spawn(electron, ["spikes/preview/main.cjs"], { env: { ...process.env, UNCUT_CDP: String(port) }, stdio: "inherit" });
let browser;
for (let i = 0; i < 50 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 200));
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }).catch(() => null);
}
const [page] = (await browser.pages()).filter((p) => p.url().includes("measure.html"));
for (const f of process.argv.slice(2)) {
  const r = await page.evaluate((src) => window.measure(src), pathToFileURL(resolve(f)).href);
  console.log(JSON.stringify(r));
}
await browser.disconnect();
proc.kill();
