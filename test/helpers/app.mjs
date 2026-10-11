// Launches an Uncut desktop build with DevTools exposed and connects puppeteer to its window.
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchApp({ command, args = [], env: extra = {}, port = 9800 + Math.floor(Math.random() * 400) }) {
  const env = { ...process.env, ...extra, UNCUT_CDP: String(port) };
  delete env.VITE_DEV_SERVER_URL;
  const proc = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((r) => proc.once("exit", r));
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  let browser;
  const kill = async () => {
    await browser?.disconnect().catch(() => {});
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    // A quit that hangs is a bug the tests should see, not wait on forever.
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(timer);
  };
  try {
    for (let i = 0; i < 100 && !browser; i++) {
      await sleep(200);
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }).catch(() => null);
    }
    if (!browser) throw new Error(`Uncut didn't start:\n${output}`);
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      page = (await browser.pages()).find((p) => p.url().endsWith("index.html"));
      if (!page) await sleep(100);
    }
    if (!page) throw new Error(`no index.html page; pages: ${(await browser.pages()).map((p) => p.url())}`);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.waitForFunction(() => document.body.dataset.ready, { timeout: 20000 });
    return { page, browser, proc, errors, close: kill, exited, output: () => output };
  } catch (error) {
    await kill();
    throw error;
  }
}
