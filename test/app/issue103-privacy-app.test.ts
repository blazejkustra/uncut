// Issue #103 (D278) on the packaged app, against a local collector (never the real endpoint):
// usage data is opt-in. First launch: the setup wizard's last step has the question, unticked; a
// skipped wizard is a no and sends nothing, not even app:start. An install that never answered is
// asked once on launch ("Share usage data" / "Don't share"); a no is never asked again, a yes sends
// this run's app:start with a random install id. Screenshots: test-output/issue103-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const T = { skip, timeout: 120000 };
const TOKEN = "app-test-token-0123456789";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let root: string, collector: Server | undefined, endpoint = "";
const bodies: Array<string> = [];
const apps = new Set<LaunchedApp>();
const launch = async (data: string, firstLaunch = false) => {
  // UNCUT_TELEMETRY "on" on purpose: the environment can't say yes for the user.
  const app = await launchApp({ command: APP, firstLaunch, env: { UNCUT_DATA_DIR: data, UNCUT_TELEMETRY: "on", UNCUT_TELEMETRY_ENDPOINT: endpoint, UNCUT_TELEMETRY_TOKEN: TOKEN, DO_NOT_TRACK: "" } });
  apps.add(app);
  return app;
};
const close = async (app: LaunchedApp) => {
  await app.close();
  apps.delete(app);
};
const events = () =>
  bodies.flatMap((body) => {
    const json = JSON.parse(body) as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string }; attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> };
    return json.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((r) => ({ name: r.body.stringValue, attrs: Object.fromEntries(r.attributes.map((a) => [a.key, Object.values(a.value)[0]])) }))));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms: number, what: string) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (check()) return;
  assert.fail(`timed out: ${what}`);
};
const settings = (data: string) => (existsSync(join(data, "settings.json")) ? (JSON.parse(readFileSync(join(data, "settings.json"), "utf8")) as { telemetry?: { enabled?: boolean } }) : {});
const dataDir = (name: string) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const toLastStep = async (page: Page) => {
  await page.waitForSelector("[data-testid=onboarding]", { timeout: 20000 });
  await page.click("[data-testid=wizard-step-2]");
  await page.waitForSelector("[data-testid=wizard-telemetry]:not([disabled])", { timeout: 10000 });
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue103-")));
  collector = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/logs") bodies.push(body);
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((r) => collector!.listen(0, "127.0.0.1", () => r()));
  endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}/v1/logs`;
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  collector?.closeAllConnections();
  collector?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("first launch: the wizard asks, unticked; skipping it is a no and nothing is sent", T, async () => {
  const data = dataDir("first");
  const app = await launch(data, true);
  await toLastStep(app.page);
  assert.equal(await app.page.$eval("[data-testid=wizard-telemetry]", (el) => (el as HTMLInputElement).checked), false, "unticked until the user says yes");
  const row = await app.page.$eval("[data-testid=wizard-telemetry-row]", (el) => (el as HTMLElement).innerText);
  assert.match(row, /Send usage data and crash reports/);
  assert.match(row, /isn't linked to your name/);
  assert.doesNotMatch(row, /anonymous/i);
  assert.ok(await app.page.$("[data-testid=wizard-telemetry-row] [data-testid=privacy-link]"), "a Privacy link");
  await app.page.screenshot({ path: "test-output/issue103-wizard.png" });
  await app.page.click("[data-testid=wizard-skip]");
  await app.page.waitForFunction(() => !document.querySelector("[data-testid=onboarding]"));
  await waitForWelcome(app.page);
  await until(() => settings(data).telemetry?.enabled === false, 5000, "a skipped wizard saved as no");
  await sleep(500);
  assert.equal(await app.page.$("[data-testid=usage-data-prompt]"), null, "not asked again right after");
  await sleep(11000);
  await close(app);
  await sleep(1000);
  assert.equal(bodies.length, 0, "nothing sent, not even app:start");
  assert.ok(!existsSync(join(data, "install-id")), "no id made");
});

test("first launch: ticking the box sends this run's app:start with a random install id", T, async () => {
  const data = dataDir("tick");
  const app = await launch(data, true);
  await toLastStep(app.page);
  await app.page.click("[data-testid=wizard-telemetry]");
  await until(() => settings(data).telemetry?.enabled === true, 5000, "the yes saved");
  await app.page.screenshot({ path: "test-output/issue103-wizard-ticked.png" });
  await until(() => events().some((e) => e.name === "app:start"), 20000, "app:start");
  const id = String(events().find((e) => e.name === "app:start")!.attrs.distinct_id);
  assert.match(id, UUID);
  assert.equal(readFileSync(join(data, "install-id"), "utf8").trim(), id);
  await close(app);
});

test("an install that never answered is asked once; Don't share holds, Share usage data sends", T, async () => {
  const before = bodies.length;
  const data = dataDir("existing");
  // An install from before opt-in: set up, never asked (D223 counted that as yes).
  writeFileSync(join(data, "settings.json"), JSON.stringify({ onboarded: true }));
  writeFileSync(join(data, "telemetry-id"), `${"a".repeat(64)}\n`);
  let app = await launch(data);
  await waitForWelcome(app.page);
  await app.page.waitForSelector("[data-testid=usage-data-prompt]", { timeout: 15000 });
  const text = await app.page.$eval("[data-testid=usage-data-prompt]", (el) => (el as HTMLElement).innerText);
  assert.match(text, /Share usage data\?/);
  assert.match(text, /Don't share/);
  assert.doesNotMatch(text, /anonymous/i);
  await sleep(300);
  await app.page.screenshot({ path: "test-output/issue103-prompt.png" });
  await app.page.click("[data-testid=usage-data-decline]");
  await app.page.waitForFunction(() => !document.querySelector("[data-testid=usage-data-prompt]"));
  await until(() => settings(data).telemetry?.enabled === false, 5000, "the no saved");
  await close(app);
  assert.equal(bodies.length, before, "nothing sent before or after a no");

  // A no is never asked again.
  app = await launch(data);
  await waitForWelcome(app.page);
  await sleep(2500);
  assert.equal(await app.page.$("[data-testid=usage-data-prompt]"), null);
  await close(app);

  // Another install that never answered: yes.
  const data2 = dataDir("existing-yes");
  writeFileSync(join(data2, "settings.json"), JSON.stringify({ onboarded: true }));
  writeFileSync(join(data2, "telemetry-id"), `${"a".repeat(64)}\n`);
  app = await launch(data2);
  await waitForWelcome(app.page);
  await app.page.waitForSelector("[data-testid=usage-data-prompt]", { timeout: 15000 });
  await app.page.click("[data-testid=usage-data-accept]");
  await until(() => settings(data2).telemetry?.enabled === true, 5000, "the yes saved");
  await until(() => events().filter((e) => e.name === "app:start").length >= 2, 20000, "app:start after the yes");
  assert.match(String(events().filter((e) => e.name === "app:start").at(-1)!.attrs.distinct_id), UUID);
  assert.ok(!existsSync(join(data2, "telemetry-id")), "the hardware-derived id is deleted");
  await close(app);
});
