// Phase 3: the packaged app starts its server and media core and the window says so.
// Needs `pnpm dist` first; skipped (with the reason) when the .app isn't there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp } from "./helpers/app.mjs";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const T = { skip, timeout: 60000 };

const apps = new Set();
// Recents and test projects go to a temp dir, never the user's real app data.
// Real path: the server reports folders resolved through symlinks (/var is /private/var).
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "uncut-app-")));
const launch = async () => {
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(scratch, "data") } });
  apps.add(app);
  return app;
};
after(async () => {
  for (const app of apps) await app.close();
  rmSync(scratch, { recursive: true, force: true });
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

// Calls the packaged server from inside the window, with the connection the preload hands out.
const rpcFromPage = (page, calls) =>
  page.evaluate(async (calls) => {
    const { url, token } = await window.uncut.getServerConnection();
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
    const results = [];
    for (const [i, [tag, payload]] of calls.entries()) {
      results.push(
        await new Promise((res) => {
          ws.onmessage = (m) => {
            const msg = JSON.parse(m.data);
            if (msg._tag === "Exit" && msg.requestId === String(i)) res(msg.exit);
          };
          ws.send(JSON.stringify({ _tag: "Request", id: String(i), tag, payload, headers: [] }));
        }),
      );
    }
    ws.close();
    return results;
  }, calls);

test("the packaged server creates, edits and reopens a project (schemas and modules found)", T, async () => {
  const app = await launch();
  const dir = join(scratch, "Packaged.uncut");
  const title = { id: "t1", type: "text", start: 0, duration: 30, text: "Hi", transform: { x: 0, y: 0 }, style: { preset: "text.title", size: 100 } };
  const [created, edited, refused, reopened, recents] = await rpcFromPage(app.page, [
    ["project.create", { parentDir: scratch, name: "Packaged" }],
    ["project.edit", { ops: [{ op: "insert_item", track: "text", item: title }] }],
    // An unknown preset is only caught if the module manifests were loaded.
    ["project.edit", { ops: [{ op: "insert_item", track: "text", item: { ...title, id: "t2", start: 40, style: { preset: "text.nope", size: 100 } } }] }],
    ["project.open", { dir }],
    ["recents.list", {}],
  ]);
  assert.equal(created._tag, "Success", JSON.stringify(created));
  assert.equal(created.value.dir, dir);
  assert.equal(edited._tag, "Success", JSON.stringify(edited));
  assert.equal(refused._tag, "Failure");
  assert.ok(refused.cause[0].error.details.some((d) => d.code === "unknown-module"), JSON.stringify(refused));
  assert.deepEqual(reopened.value.project.tracks[0].items, [title]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).tracks[0].items, [title]);
  assert.deepEqual(recents.value.map((r) => r.dir), [dir]);
  assert.deepEqual(app.errors, []);
});
