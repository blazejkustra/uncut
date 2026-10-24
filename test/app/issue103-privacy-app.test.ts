// Issue #103 (D283) on the packaged app, against a local collector (never the real endpoint):
// usage data is anonymous and on by default. The setup wizard's last step shows one quiet line with a
// Privacy link (no question, nothing blocks New project); app:start is sent at first launch with no
// identifier; old install-id / telemetry-id files are deleted and none is made. A build that can't
// send (no token) shows no line. The Settings toggle and DO_NOT_TRACK: telemetry-app.test.ts.
// Screenshots: test-output/issue103-*.png.
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

let root: string,
  collector: Server | undefined,
  endpoint = "";
const bodies: Array<string> = [];
const apps = new Set<LaunchedApp>();
const launch = async (data: string, firstLaunch = false, token = TOKEN) => {
  // UNCUT_TELEMETRY "on" on purpose: the environment can't say yes for the user. The endpoint is
  // always the local collector; without a token it can send nothing (never the real endpoint).
  const app = await launchApp({
    command: APP,
    firstLaunch,
    env: { UNCUT_DATA_DIR: data, UNCUT_TELEMETRY: "on", UNCUT_TELEMETRY_ENDPOINT: endpoint, UNCUT_TELEMETRY_TOKEN: token, DO_NOT_TRACK: "" },
  });
  apps.add(app);
  return app;
};
const close = async (app: LaunchedApp) => {
  await app.close();
  apps.delete(app);
};
const events = () =>
  bodies.flatMap((body) => {
    const json = JSON.parse(body) as {
      resourceLogs: Array<{
        scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string }; attributes: Array<{ key: string; value: Record<string, unknown> }> }> }>;
      }>;
    };
    return json.resourceLogs.flatMap((rl) =>
      rl.scopeLogs.flatMap((sl) =>
        sl.logRecords.map((r) => ({ name: r.body.stringValue, attrs: Object.fromEntries(r.attributes.map((a) => [a.key, Object.values(a.value)[0]])) })),
      ),
    );
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms: number, what: string) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (check()) return;
  assert.fail(`timed out: ${what}`);
};
const settings = (data: string) =>
  existsSync(join(data, "settings.json")) ? (JSON.parse(readFileSync(join(data, "settings.json"), "utf8")) as { telemetry?: { enabled?: boolean } }) : {};
const dataDir = (name: string) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const toLastStep = async (page: Page) => {
  await page.waitForSelector("[data-testid=onboarding]", { timeout: 20000 });
  await page.click("[data-testid=wizard-step-2]");
  await page.waitForSelector("[data-testid=wizard-new-project]");
};
const ALLOWED = ["app_version", "arch", "event.name", "headless", "os", "runtime", "process", "error_name", "crash_fingerprint", "code", "fatal"];

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

test("first launch: one quiet line in the wizard, New project free; app:start sent with no identifier; old id files deleted", T, async () => {
  const data = dataDir("first");
  writeFileSync(join(data, "install-id"), "0b5c3c3e-1111-4222-8333-444455556666\n");
  writeFileSync(join(data, "telemetry-id"), `${"a".repeat(64)}\n`);
  const app = await launch(data, true);
  await toLastStep(app.page);
  await app.page.waitForSelector("[data-testid=wizard-telemetry-note]", { timeout: 10000 });
  const line = await app.page.$eval("[data-testid=wizard-telemetry-note]", (el) => (el as HTMLElement).innerText);
  assert.equal(line, "Uncut sends anonymous usage counts and crash types, never your footage or prompts. You can turn it off in Settings. Privacy");
  assert.ok(await app.page.$("[data-testid=wizard-telemetry-note] [data-testid=privacy-link]"), "Privacy is a link");
  assert.equal(await app.page.$("[data-testid=wizard-telemetry-accept]"), null, "no choice to make");
  assert.equal(await app.page.$eval("[data-testid=wizard-new-project]", (el) => (el as HTMLButtonElement).disabled), false);
  await new Promise((r) => setTimeout(r, 300));
  await app.page.screenshot({ path: "test-output/issue103-wizard-line.png" });
  await until(() => events().some((e) => e.name === "app:start"), 20000, "app:start without any answer");
  for (const e of events()) for (const k of Object.keys(e.attrs)) assert.ok(ALLOWED.includes(k), `unexpected attribute ${k}`);
  assert.ok(!existsSync(join(data, "install-id")), "D278's install id deleted");
  assert.ok(!existsSync(join(data, "telemetry-id")), "D223's id deleted");
  await app.page.click("[data-testid=wizard-skip]");
  await app.page.waitForFunction(() => !document.querySelector("[data-testid=onboarding]"));
  await waitForWelcome(app.page);
  await sleep(1000);
  assert.equal(await app.page.$("[data-testid=usage-data-prompt]"), null, "no dialog");
  assert.equal(settings(data).telemetry, undefined, "nothing saved: on is the default");
  assert.ok(!existsSync(join(data, "install-id")), "none made");
  await close(app);
});

test("a build that can't send shows no line", T, async () => {
  const before = bodies.length;
  const data = dataDir("no-token");
  const app = await launch(data, true, "");
  await toLastStep(app.page);
  await sleep(1500);
  assert.equal(await app.page.$("[data-testid=wizard-telemetry-note]"), null, "no usage-data line");
  await app.page.screenshot({ path: "test-output/issue103-no-token.png" });
  await close(app);
  assert.equal(bodies.length, before, "nothing sent");
});
