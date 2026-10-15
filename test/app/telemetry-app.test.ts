// Issue #13 (D223) on the packaged app: telemetry pointed at a local collector (never the real
// endpoint) sends app:start with the anonymous id; Settings › App › Usage data turns it off and
// that holds across launches; DO_NOT_TRACK locks it off. Screenshots: test-output/telemetry-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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
const TOKEN = "app-test-token-0123456789";

let root: string, data: string, collector: Server | undefined, endpoint = "";
const bodies: Array<{ auth: string | undefined; body: string }> = [];
const apps = new Set<LaunchedApp>();
const launch = async (extra: NodeJS.ProcessEnv = {}) => {
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: data, UNCUT_TELEMETRY: "on", UNCUT_TELEMETRY_ENDPOINT: endpoint, UNCUT_TELEMETRY_TOKEN: TOKEN, DO_NOT_TRACK: "", ...extra } });
  apps.add(app);
  await waitForWelcome(app.page);
  return app;
};
const close = async (app: LaunchedApp) => {
  await app.close();
  apps.delete(app);
};
const events = () =>
  bodies.flatMap(({ body }) => {
    const json = JSON.parse(body) as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string }; attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> };
    return json.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((r) => ({ name: r.body.stringValue, attrs: Object.fromEntries(r.attributes.map((a) => [a.key, Object.values(a.value)[0]])) }))));
  });
const until = async (check: () => boolean, ms: number, what: string) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (check()) return;
  assert.fail(`timed out: ${what}`);
};
const openUsageData = async (page: Page) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press("Comma");
  await page.keyboard.up("Meta");
  await page.waitForSelector("[data-testid=settings]", { timeout: 10000 });
  await page.click("[data-testid=settings-nav-app]");
  await page.waitForSelector("[data-testid=settings-telemetry]:not([disabled]), [data-testid=settings-telemetry][disabled]", { timeout: 10000 });
  // The state comes from the server: wait until it has answered (the note then says more, or the box is enabled).
  await page.waitForFunction(() => {
    const box = document.querySelector<HTMLInputElement>("[data-testid=settings-telemetry]");
    return box && (!box.disabled || /DO_NOT_TRACK|UNCUT_TELEMETRY|no telemetry token/.test(document.querySelector("[data-testid=settings-telemetry-note]")?.textContent ?? ""));
  }, { timeout: 10000 });
};
const checkbox = (page: Page) => page.$eval("[data-testid=settings-telemetry]", (el) => ({ checked: (el as HTMLInputElement).checked, disabled: (el as HTMLInputElement).disabled }));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-telemetry-app-")));
  data = join(root, "data");
  collector = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/logs") bodies.push({ auth: req.headers.authorization, body });
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

test("app:start reaches the collector; the Settings toggle turns telemetry off for good", T, async () => {
  let app = await launch();
  // The first batch goes out within the SDK's 10 s delay (or at quit).
  await until(() => events().some((e) => e.name === "app:start"), 20000, "app:start");
  assert.ok(bodies.every((b) => b.auth === `Bearer ${TOKEN}`));
  const start = events().find((e) => e.name === "app:start")!;
  assert.match(String(start.attrs.distinct_id), /^[0-9a-f]{64}$/);
  assert.equal(start.attrs.runtime, "electron");
  assert.equal(start.attrs.headless, false);
  assert.ok(existsSync(join(data, "telemetry-id")));
  for (const { body } of bodies) assert.doesNotMatch(body, new RegExp(root.replace(/[/.]/g, "\\$&")));

  await openUsageData(app.page);
  assert.deepEqual(await checkbox(app.page), { checked: true, disabled: false });
  assert.match(await app.page.$eval("[data-testid=settings-telemetry-note]", (el) => el.textContent ?? ""), /Never your footage, prompts, file names or paths/);
  await app.page.screenshot({ path: "test-output/telemetry-settings-on.png" });
  await app.page.click("[data-testid=settings-telemetry]");
  await app.page.waitForFunction(() => !document.querySelector<HTMLInputElement>("[data-testid=settings-telemetry]")!.checked);
  await until(() => JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).telemetry?.enabled === false, 5000, "settings.json telemetry.enabled false");
  await close(app);

  // Off across launches: nothing at all from the next run.
  const before = bodies.length;
  app = await launch();
  await openUsageData(app.page);
  assert.deepEqual(await checkbox(app.page), { checked: false, disabled: false });
  await app.page.screenshot({ path: "test-output/telemetry-settings-off.png" });
  await new Promise((r) => setTimeout(r, 12000));
  await close(app);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(bodies.length, before, "nothing sent while off");
});

test("DO_NOT_TRACK locks the toggle off and sends nothing", T, async () => {
  const before = bodies.length;
  const app = await launch({ DO_NOT_TRACK: "1" });
  await openUsageData(app.page);
  assert.deepEqual(await checkbox(app.page), { checked: false, disabled: true });
  assert.match(await app.page.$eval("[data-testid=settings-telemetry-note]", (el) => el.textContent ?? ""), /DO_NOT_TRACK/);
  await app.page.screenshot({ path: "test-output/telemetry-settings-dnt.png" });
  await close(app);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(bodies.length, before);
});
