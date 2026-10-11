import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";
const port = 9334;
const proc = spawn(resolve("node_modules/.bin/electron"), ["spikes/preview/main.cjs"], { env: { ...process.env, UNCUT_CDP: String(port) }, stdio: "ignore" });
let browser;
for (let i = 0; i < 50 && !browser; i++) { await new Promise((r) => setTimeout(r, 200)); browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }).catch(() => null); }
const [page] = (await browser.pages()).filter((p) => p.url().includes("measure.html"));
const url = (f) => pathToFileURL(resolve(f)).href;
const full = "../drone/DJI_20261010132228_0005_D.MP4";
console.log("full file", JSON.stringify(await page.evaluate((s) => window.measure(s, { seeks: 40 }), url(full))));
console.log("dual 4K", JSON.stringify(await page.evaluate((a, b) => window.measureDual(a, b), url(full), url("fixtures/trim-hevc10.mp4"))));
await browser.disconnect(); proc.kill();
