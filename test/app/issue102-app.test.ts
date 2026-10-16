// Issue #102 (D276) on the packaged app, against a local update feed (UNCUT_UPDATE_FEED, a generic
// feed on 127.0.0.1), never GitHub. The real electron-updater in the app checks, says "You're up
// to date", downloads a newer version and shows "Uncut 99.0.0 is ready" with Restart to update /
// Later; an automatic check is silent until the download is ready; a failing feed (as the private
// repository's 404) shows nothing. A plain test run doesn't check at all.
// Limit: the "update" is not an app, so Squirrel.Mac refuses to stage it (its error is logged, not
// shown) and Restart to update says it couldn't prepare the update instead of quitting: a real
// install needs a Developer ID build and a real newer release (see D276).
// Screenshots: test-output/issue102-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const T = { skip, timeout: 120000 };
const VERSION = (JSON.parse(readFileSync("apps/desktop/package.json", "utf8")) as { version: string }).version;
const NO_STAGING_ID = "00000000-0000-4000-8000-000000000000";

// Not an app: Squirrel must never be able to install it over the test build.
const ZIP = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(200_000, 1)]);
const ZIP_NAME = "Uncut-99.0.0-arm64-mac.zip";
const sha = (b: Buffer) => createHash("sha512").update(b).digest("base64");

let root: string, feed: Server | undefined, feedUrl = "";
// What the feed answers: the version it offers, or a 404 (the private repository).
let offer: string | "404" = VERSION;
const requests: Array<{ url: string; staging: string | undefined }> = [];
const apps = new Set<LaunchedApp>();

const yml = (version: string) =>
  [`version: ${version}`, "files:", `  - url: ${ZIP_NAME}`, `    sha512: ${sha(ZIP)}`, `    size: ${ZIP.length}`, `path: ${ZIP_NAME}`, `sha512: ${sha(ZIP)}`, `releaseDate: '2026-10-16T00:00:00.000Z'`, ""].join("\n");

const launch = async (env: NodeJS.ProcessEnv) => {
  const data = join(root, `data-${apps.size}-${Date.now()}`);
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: data, ...env } });
  apps.add(app);
  await waitForWelcome(app.page);
  return { app, data };
};
const close = async (app: LaunchedApp) => {
  await app.close();
  apps.delete(app);
};
const until = async (check: () => boolean, ms: number, what: string, app?: LaunchedApp) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (check()) return;
  assert.fail(`timed out: ${what}${app ? `\n${app.output().split("\n").filter((l) => l.includes("[updater]")).join("\n")}` : ""}`);
};
const toast = (page: Page) => page.$eval("[data-testid=update-toast]", (el) => ({ kind: el.getAttribute("data-kind"), text: el.textContent ?? "" })).catch(() => undefined);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue102-")));
  feed = createServer((req, res) => {
    requests.push({ url: req.url ?? "", staging: req.headers["x-user-staging-id"] as string | undefined });
    if (offer === "404") return void res.writeHead(404).end("Not Found");
    if (req.url?.startsWith("/feed/latest-mac.yml")) return void res.writeHead(200, { "content-type": "text/yaml" }).end(yml(offer));
    if (req.url === `/feed/${ZIP_NAME}`) {
      // Slow enough that the progress is seen.
      res.writeHead(200, { "content-type": "application/zip", "content-length": ZIP.length });
      res.write(ZIP.subarray(0, 100_000));
      return void setTimeout(() => res.end(ZIP.subarray(100_000)), 600);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => feed!.listen(0, "127.0.0.1", () => r()));
  feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/feed/`;
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  feed?.closeAllConnections();
  feed?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a plain test run never checks for updates (no feed, never GitHub)", T, async () => {
  const before = requests.length;
  const { app } = await launch({});
  await until(() => /\[updater\] off: a test run without UNCUT_UPDATE_FEED/.test(app.output()), 10000, "updater off line", app);
  assert.equal(await app.page.evaluate(() => window.uncut?.updateStatus?.().then((s: { kind: string }) => s.kind)), "idle");
  await app.page.evaluate(() => window.uncut?.checkForUpdates?.());
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await toast(app.page), undefined);
  assert.equal(requests.length, before);
  assert.doesNotMatch(app.output(), /github\.com|api\.github/);
  await close(app);
});

test("Check for Updates…: up to date, then a newer version downloads: 'Uncut 99.0.0 is ready', Later, Restart to update", T, async () => {
  offer = VERSION;
  const { app } = await launch({ UNCUT_UPDATE_FEED: feedUrl });
  await until(() => app.output().includes(`[updater] on: ${feedUrl}`), 10000, "updater on", app);
  // The same function Uncut › Check for Updates… calls.
  await app.page.evaluate(() => window.uncut?.checkForUpdates?.());
  await app.page.waitForSelector("[data-testid=update-toast][data-kind=none]", { timeout: 15000 });
  assert.match((await toast(app.page))!.text, new RegExp(`You're up to date \\(Uncut ${VERSION.replace(/\./g, "\\.")}\\)`));
  await app.page.screenshot({ path: "test-output/issue102-up-to-date.png" });
  // It goes by itself.
  await app.page.waitForSelector("[data-testid=update-toast]", { hidden: true, timeout: 8000 });

  offer = "99.0.0";
  await app.page.evaluate(() => window.uncut?.checkForUpdates?.());
  await app.page.waitForSelector("[data-testid=update-toast][data-kind=downloading]", { timeout: 15000 });
  assert.match((await toast(app.page))!.text, /Downloading Uncut 99\.0\.0… \d+%/);
  await app.page.screenshot({ path: "test-output/issue102-downloading.png" });
  await app.page.waitForSelector("[data-testid=update-toast][data-kind=downloaded]", { timeout: 20000 });
  const ready = (await toast(app.page))!.text;
  assert.match(ready, /Uncut 99\.0\.0 is ready/);
  assert.match(ready, /Restart to update/);
  assert.match(ready, /Later/);
  await app.page.screenshot({ path: "test-output/issue102-ready.png" });
  assert.ok(requests.some((r) => r.url === `/feed/${ZIP_NAME}`), "the zip came from the local feed");
  // No per-install id with the requests: the same fixed one for everyone (D223).
  assert.ok(requests.length > 0 && requests.every((r) => r.staging === undefined || r.staging === NO_STAGING_ID), JSON.stringify(requests));
  // The update is cached under UNCUT_DATA_DIR, not the user's ~/Library/Caches.
  assert.match(app.output(), /\[updater\] downloaded 99\.0\.0/);

  // Busy (an export, a recording, an agent turn): Restart to update is refused by the shell.
  assert.equal(await app.page.evaluate(() => (window.uncut?.setUpdateBusy?.(true), window.uncut?.installUpdate?.())), "busy");
  await app.page.evaluate(() => window.uncut?.setUpdateBusy?.(false));

  // Later closes it.
  await app.page.click("[data-testid=update-later]");
  await app.page.waitForSelector("[data-testid=update-toast]", { hidden: true, timeout: 5000 });
  // The menu again shows it at once (no new download).
  await app.page.evaluate(() => window.uncut?.checkForUpdates?.());
  await app.page.waitForSelector("[data-testid=update-toast][data-kind=downloaded]", { timeout: 5000 });
  // Squirrel.Mac refused the not-an-app zip (logged, not shown). Restart to update: nothing pending,
  // so it goes to the shell, which waits for Squirrel's answer and doesn't quit (or stop the server)
  // when the update wasn't staged; the toast says so.
  await until(() => app.output().includes("Squirrel.Mac could not stage the update"), 15000, "Squirrel's refusal logged", app);
  await app.page.click("[data-testid=update-restart]");
  await until(() => app.output().includes("[updater] not installing 99.0.0: Squirrel.Mac has not staged it"), 5000, "install refused", app);
  await app.page.waitForFunction(() => /Couldn't prepare the update/.test(document.querySelector("[data-testid=update-sub]")?.textContent ?? ""), { timeout: 5000 });
  await app.page.screenshot({ path: "test-output/issue102-not-staged.png" });
  assert.doesNotMatch(app.output(), /quitAndInstall skipped|restarting to install/);
  // Still running, server and all.
  assert.equal(app.proc.exitCode, null);
  assert.equal(app.errors.filter((e) => /update/i.test(e)).length, 0, app.errors.join("\n"));
  await close(app);
});

test("an automatic check is silent until the update is ready; a failing feed shows nothing at all", T, async () => {
  offer = "404";
  let { app } = await launch({ UNCUT_UPDATE_FEED: feedUrl, UNCUT_UPDATE_FIRST_CHECK_MS: "500" });
  await until(() => /\[updater\] check failed \(not shown\)/.test(app.output()), 15000, "failed check logged", app);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await toast(app.page), undefined, "no error toast for a failed check");
  await app.page.screenshot({ path: "test-output/issue102-failed-silent.png" });
  // Even a failed manual check is silent (the private repository answers 404 to everyone).
  await app.page.evaluate(() => window.uncut?.checkForUpdates?.());
  await until(() => (app.output().match(/check failed \(not shown\)/g) ?? []).length >= 2, 15000, "second failure", app);
  await app.page.waitForSelector("[data-testid=update-toast]", { hidden: true, timeout: 3000 });
  await close(app);

  offer = "99.0.0";
  ({ app } = await launch({ UNCUT_UPDATE_FEED: feedUrl, UNCUT_UPDATE_FIRST_CHECK_MS: "500" }));
  // Checking and downloading show nothing; the ready toast does.
  const seen = new Set<string>();
  for (const end = Date.now() + 20000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const t = await toast(app.page);
    if (t?.kind) seen.add(t.kind);
    if (t?.kind === "downloaded") break;
  }
  assert.deepEqual([...seen], ["downloaded"]);
  await close(app);
});
