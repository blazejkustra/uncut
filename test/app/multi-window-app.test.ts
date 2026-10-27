// Several projects at once on the packaged app (background windows): one window per project, each
// with its own server. A second launch given a project opens it in a new window (the first shows
// one already); an edit there leaves the first project as it was; giving the open project again
// brings its window forward instead of a third; closing a window ends its server and the other
// window keeps working; quitting ends every server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { clickWhenReady, freePort, launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = "";
let app: LaunchedApp | undefined;
const projectA = () => join(root, "Alpha.uncut");
const projectB = () => join(root, "Beta.uncut");
const env = () => ({ UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([projectA()]) });

const until = async (check: () => boolean, what: string, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

const texts = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "project.json"), "utf8"))
    .tracks.filter((t: { kind: string }) => t.kind === "text")
    .flatMap((t: { items: Array<{ text: string }> }) => t.items.map((i) => i.text));

function writeProject(dir: string, name: string) {
  mkdirSync(dir);
  const tracks = [
    { id: "text", kind: "text", name: "Text", items: [] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    { id: "audio", kind: "audio", name: "Audio", items: [] },
  ];
  writeFileSync(join(dir, "project.json"), JSON.stringify({ format: "uncut/0", name, canvas: { width: 1920, height: 1080, fps: 30 }, media: [], tracks }));
}

/** The app's server processes (children running the server bundle). */
function serverPids(appPid: number) {
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && Number(m[2]) === appPid && m[3]!.includes("server.mjs"))
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts Uncut again with `args`, as a second launch does: it hands them to the running app and quits. */
async function secondLaunch(args: ReadonlyArray<string>) {
  const port = await freePort();
  const child = spawn(APP, [...args], {
    env: { ...process.env, ...env(), UNCUT_TEST_BACKGROUND: "1", UNCUT_TELEMETRY: "off", UNCUT_CDP: String(port) },
    stdio: "ignore",
  });
  const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  assert.equal(code, 0, "the second launch steps aside");
}

const appPages = async () => (await app!.browser.pages()).filter((p) => p.url().endsWith("index.html"));

/** The app windows' pages once `check` holds for them. */
async function pagesWhen(check: (pages: Array<Page>) => boolean, what: string) {
  const end = Date.now() + 30000;
  let pages = await appPages();
  while (!check(pages)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
    pages = await appPages();
  }
  return pages;
}

async function addTitle(page: Page) {
  await page.click("[data-testid=rail-text]");
  await page.click('[data-testid=text-preset][data-preset="title"]');
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-multi-window-")));
  writeProject(projectA(), "Alpha");
  writeProject(projectB(), "Beta");
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("two projects in two windows, each with its own server; closing one ends only its server", { skip, timeout: 240000 }, async () => {
  app = await launchApp({ command: APP, env: env() });
  const first = app.page;
  await waitForWelcome(first);
  await first.click("[data-testid=open-project]");
  await first.waitForSelector("[data-testid=editor]", { timeout: 20000 });
  await until(() => serverPids(app!.proc.pid!).length === 1, "the first window's server");
  const [firstServer] = serverPids(app.proc.pid!);

  // A second launch with the other project: the first window shows one already, so a new window opens it.
  await secondLaunch([projectB()]);
  const second = (await pagesWhen((pages) => pages.length === 2, "the second window")).find((p) => p !== first)!;
  await (await second.createCDPSession()).send("Emulation.setFocusEmulationEnabled", { enabled: true });
  second.on("pageerror", (e) => app!.errors.push((e as Error).message));
  await second.waitForSelector("[data-testid=editor]", { timeout: 30000 });
  assert.equal(await second.evaluate(() => document.title), "Beta");
  assert.equal(await first.evaluate(() => document.title), "Alpha");
  await until(() => serverPids(app!.proc.pid!).length === 2, "two servers");
  const servers = serverPids(app.proc.pid!);
  const secondServer = servers.find((pid) => pid !== firstServer)!;
  assert.ok(servers.includes(firstServer!) && secondServer, `two server processes: ${servers}`);

  // An edit in Beta leaves Alpha as it was, on disk and on screen.
  const alphaBefore = readFileSync(join(projectA(), "project.json"), "utf8");
  await addTitle(second);
  await until(() => texts(projectB()).length === 1, "Beta's title");
  await sleep(500);
  assert.equal(readFileSync(join(projectA(), "project.json"), "utf8"), alphaBefore, "Alpha unchanged");
  assert.equal(await first.$$eval(".pv-text", (els) => els.length), 0, "Alpha's viewer has no text");

  // Alpha again (a second launch, as Finder's open does): its window comes forward, no third window.
  const printed = app.output().length;
  await secondLaunch([projectA()]);
  await until(() => app!.output().slice(printed).includes(`[test] window forward: ${projectA()}`), "Alpha's window brought forward");
  // The page's own Open (the Open dialog or Recents) in Beta's window does the same.
  const moved = await second.evaluate(
    (dir) => (window as unknown as { uncut: { focusProjectWindow: (d: string) => Promise<boolean> } }).uncut.focusProjectWindow(dir),
    projectA(),
  );
  assert.equal(moved, true);
  // A server refusing a project as open in another server's window (open-elsewhere) names its pid: that window comes forward.
  const afterRefusal = app.output().length;
  const byHolder = await second.evaluate(
    (dir, pid) => (window as unknown as { uncut: { focusProjectWindow: (d: string, p: number) => Promise<boolean> } }).uncut.focusProjectWindow(dir, pid),
    join(root, "Elsewhere.uncut"),
    firstServer!,
  );
  assert.equal(byHolder, true);
  await until(() => app!.output().slice(afterRefusal).includes(`[test] window forward: ${projectA()}`), "the holder's window brought forward");
  await sleep(500);
  assert.equal((await appPages()).length, 2, "still two windows");
  assert.equal(await second.evaluate(() => document.title), "Beta", "Beta's window kept its project");

  // Closing Beta's window (nothing pending: it closes at once) ends its server; Alpha's keeps working.
  await second.evaluate(() => window.close());
  await until(() => !alive(secondServer), "Beta's server to stop");
  assert.ok(alive(firstServer!), "Alpha's server still runs");
  await pagesWhen((pages) => pages.length === 1, "Beta's window to close");
  await addTitle(first);
  await until(() => texts(projectA()).length === 1, "Alpha's title after the other window closed");
  assert.deepEqual(texts(projectB()), ["Title"]);

  assert.deepEqual(app.errors, []);

  // Quitting ends every server.
  await app.close();
  app = undefined;
  await until(() => !alive(firstServer!), "Alpha's server to stop with the app", 5000);
});

test("quitting with two windows open ends both servers", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, env: env() });
  await waitForWelcome(app.page);
  await clickWhenReady(app.page, "[data-testid=recent]");
  await app.page.waitForSelector("[data-testid=editor]", { timeout: 20000 });
  // The newest recent is whichever the first test opened last: the other one goes to a second window.
  const open = await app.page.evaluate(() => document.title);
  await secondLaunch([open === "Alpha" ? projectB() : projectA()]);
  await pagesWhen((pages) => pages.length === 2, "the second window");
  await until(() => serverPids(app!.proc.pid!).length === 2, "two servers");
  const servers = serverPids(app.proc.pid!);
  await app.close();
  app = undefined;
  await until(() => servers.every((pid) => !alive(pid)), "both servers to stop with the app", 5000);
});
