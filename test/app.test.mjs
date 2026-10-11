// Phase 3: the packaged app starts its server and media core and the window says so.
// Needs `pnpm dist` first; skipped (with the reason) when the .app isn't there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { launchApp } from "./helpers/app.mjs";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const T = { skip, timeout: 60000 };

const apps = new Set();
const launch = async () => {
  const app = await launchApp({ command: APP });
  apps.add(app);
  return app;
};
after(async () => {
  for (const app of apps) await app.close();
});

// The server is the app's child running server.mjs (pgrep -P alone also matches Electron helpers).
const serverPid = (app) => {
  const out = execFileSync("pgrep", ["-P", String(app.proc.pid), "-f", "server/server.mjs"], { encoding: "utf8" }).trim();
  const pids = out.split("\n").filter(Boolean).map(Number);
  assert.equal(pids.length, 1, `expected one server process, got ${out}`);
  return pids[0];
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid, ms) => {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};
// Opens an authenticated socket from the page, like a client that is still connected at quit.
const holdSocket = (page) =>
  page.evaluate(async () => {
    const { url, token } = await window.uncut.getServerConnection();
    await new Promise((res, rej) => {
      window.__held = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
      window.__held.onopen = res;
      window.__held.onerror = rej;
    });
  });
const status = (page) => page.$eval("[data-testid=status]", (el) => ({ state: el.dataset.state, text: el.textContent }));

test("window shows the server and media core versions, from the bundle, without console errors", T, async () => {
  const app = await launch();
  const s = await status(app.page);
  assert.equal(s.state, "connected", `${s.text}\n${app.output()}`);
  assert.match(s.text, /^Server connected · server v0\.0\.1 · media core v0\.0\.1$/);
  assert.match(app.page.url(), /^file:\/\/.*Uncut\.app\/Contents\/Resources\/app\.asar\/dist\/renderer\/index\.html$/);
  assert.deepEqual(app.errors, []);
});

test("the window can't navigate away or open new windows", T, async () => {
  const app = await launch();
  const url = app.page.url();
  assert.equal(await app.page.evaluate(() => window.open("about:blank")), null);
  await app.page.evaluate(() => (location.href = "file:///etc/hosts"));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(app.page.url(), url);
  assert.equal((await app.browser.pages()).length, 1);
});

test("quitting with a client still connected stops the server", T, async () => {
  const app = await launch();
  const pid = serverPid(app);
  await holdSocket(app.page);
  await app.close();
  apps.delete(app);
  assert.equal(app.proc.signalCode === "SIGKILL", false, "the app had to be SIGKILLed to quit");
  assert.ok(await waitGone(pid, 2000), `server pid ${pid} still running after quit`);
});

test("if the app is killed outright, the server exits on its own", T, async () => {
  const app = await launch();
  const pid = serverPid(app);
  await holdSocket(app.page);
  await app.browser.disconnect();
  app.proc.kill("SIGKILL");
  await app.exited;
  apps.delete(app);
  assert.ok(await waitGone(pid, 2000), `server pid ${pid} outlived a SIGKILLed app`);
});

test("a server that dies after startup shows as an error in the window", T, async () => {
  const app = await launch();
  process.kill(serverPid(app), "SIGKILL");
  await app.page.waitForFunction(() => document.querySelector("[data-testid=status]").dataset.state === "error", { timeout: 5000 });
  assert.match((await status(app.page)).text, /server exited unexpectedly/);
  const quitStart = Date.now();
  await app.close();
  apps.delete(app);
  assert.notEqual(app.proc.signalCode, "SIGKILL", "the app hung on quit after its server died");
  assert.ok(Date.now() - quitStart < 5000);
});
