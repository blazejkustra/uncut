// The Argent capture plugin (D98): plugins/argent-capture against the fake `argent`
// (test/helpers/fake-argent.ts, through ARGENT_BIN; never the real one, which would start the
// shared tool-server). Directly over stdio: the device list and what is recordable, a timed take
// checked with ffprobe, a flow take (copied into the project's flows/), cancel and exit mid-take
// both stop the recording, Argent missing or too old, a device that can't be recorded. Then on the
// bundled server: the Capture tab's RPCs (one ⌘Z removes the take) and an agent turn with the
// scripted claude (record, place, re-shoot with a shorter take that trims the clip, Undo turn).
// Every test checks the fake's log: never a server stop or a stop-all, and no boot except D143's
// argent_capture_boot test (the Capture tab's "Boot and record" click), which asserts exactly one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { toDevice, compareVersions, prepOf } from "../../plugins/argent-capture/server.ts";
import { BUNDLE, connect, killAll, startServer } from "../helpers/server.ts";

const PLUGIN_DIR = resolve("plugins/argent-capture");
const FAKE_ARGENT = resolve("test/helpers/fake-argent/argent");
const FAKE_CLAUDE = resolve("test/helpers/fake-claude.ts");
const skip = !existsSync(BUNDLE) ? "the server bundle isn't built (pnpm --filter @uncut/server build)" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-argent-")));
});
after(() => {
  killAll();
  rmSync(root, { recursive: true, force: true });
});

const logOf = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: Array<string>; forbidden?: boolean }) : []);
const calls = (file: string, tool: string) => logOf(file).filter((e) => e.argv[0] === "run" && e.argv[1] === tool && !(e as { completed?: string }).completed);
const completedStops = (file: string) => logOf(file).filter((e) => (e as { completed?: string }).completed === "screen-recording-stop");
const assertNothingForbidden = (file: string, boots = 0) => {
  const bad = logOf(file).filter((e) => e.forbidden);
  assert.deepEqual(bad, [], "never a server stop or a stop-all");
  assert.equal(logOf(file).filter((e) => (e as { boot?: boolean }).boot).length, boots, `${boots} boots`);
};
const seconds = (file: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());

/** A fresh folder with a project-like layout and the fake's log. */
const setup = (name: string) => {
  const dir = join(root, name);
  const project = join(dir, "P.uncut");
  mkdirSync(join(project, "media", "captures"), { recursive: true });
  mkdirSync(join(project, "flows"), { recursive: true });
  const log = join(dir, "argent.jsonl");
  writeFileSync(log, "");
  return { dir, project, captureDir: join(project, "media", "captures"), flowsDir: join(project, "flows"), log, state: join(dir, "fake-argent-state") };
};

/** The plugin over stdio, as Uncut's host talks to it. */
function startPlugin(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["server.ts"], { cwd: PLUGIN_DIR, env: { ...process.env, FAKE_ARGENT_NODE: process.execPath, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: any) => void>();
  let id = 0;
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const m = JSON.parse(line);
    waiting.get(m.id)?.(m);
  });
  const request = (method: string, params: unknown, timeout = 30000) =>
    new Promise<any>((done, fail) => {
      const n = ++id;
      const timer = setTimeout(() => fail(new Error(`${method}: no answer in ${timeout} ms; stderr ${stderr}`)), timeout);
      timer.unref();
      waiting.set(n, (m) => (clearTimeout(timer), done(m)));
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  const call = async (name: string, args: unknown, meta: Record<string, string> = {}) => (await request("tools/call", { name, arguments: args, _meta: meta })).result;
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  return { child, request, call, exited, nextId: () => id + 1, stderr: () => stderr };
}
const metaOf = (s: ReturnType<typeof setup>) => ({ "uncut/projectDir": s.project, "uncut/captureDir": s.captureDir, "uncut/flowsDir": s.flowsDir });
const textOf = (r: any) => r.content.map((c: any) => c.text).join(" ");

test("device list: what can be recorded and why not", () => {
  assert.deepEqual(toDevice({ platform: "ios", udid: "A", name: "iPhone 16", state: "Booted", runtimeKind: "mobile" }), { id: "A", platform: "ios", name: "iPhone 16", state: "Booted", recordable: true });
  assert.equal(toDevice({ platform: "ios", udid: "B", name: "iPad", state: "Shutdown", runtimeKind: "mobile" })!.reason, "Not booted");
  assert.match(toDevice({ platform: "ios", udid: "C", name: "Apple TV", state: "Booted", runtimeKind: "tv" })!.reason!, /tvOS/);
  assert.match(toDevice({ platform: "ios", kind: "device", udid: "D", name: "Blaze's iPhone", state: "connected" })!.reason!, /Physical/);
  assert.equal(toDevice({ platform: "android", serial: "emulator-5554", state: "device", avdName: "Pixel_8_API_35" })!.name, "Pixel 8 API 35");
  assert.equal(toDevice({ platform: "android", serial: "emulator-5556", state: "offline" })!.recordable, false);
  assert.match(toDevice({ platform: "chromium", id: "chromium-cdp-9222", state: "Running", browser: "Chrome/140" })!.reason!, /Chromium/);
  assert.match(toDevice({ platform: "chromium", id: "chromium-cdp-9333", state: "Running", browser: "Electron/44" })!.reason!, /Electron/);
  assert.match(toDevice({ platform: "vega", serial: "amazon-1", state: "running" })!.reason!, /Vega/);
  assert.equal(toDevice({ platform: "ios", name: "no id" }), undefined);
  assert.ok(compareVersions("0.28.0", "0.19.0") > 0 && compareVersions("0.18.9", "0.19.0") < 0 && compareVersions("0.19.0", "0.19.0") === 0);
});

test("the plugin: list, a timed take, a flow take, refusals, cancel and exit stop the recording", { timeout: 120000 }, async () => {
  const s = setup("direct");
  const plugin = startPlugin({ ARGENT_BIN: FAKE_ARGENT, FAKE_ARGENT_LOG: s.log });
  try {
    const init = await plugin.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(init.result.serverInfo.name, "argent.capture");

    // The list: Argent's version, every device with recordable and a reason.
    const list = await plugin.call("argent_list_devices", {});
    assert.ok(!list.isError, textOf(list));
    assert.equal(list.structuredContent.argent.installed, true);
    assert.equal(list.structuredContent.argent.version, "0.28.0");
    const byId = Object.fromEntries(list.structuredContent.devices.map((d: any) => [d.id, d]));
    assert.equal(byId["SIM-IPHONE-16"].recordable, true);
    assert.equal(byId["emulator-5554"].recordable, true);
    assert.equal(byId["SIM-IPAD-OFF"].reason, "Not booted");
    for (const id of ["SIM-APPLE-TV", "chromium-cdp-9222", "amazon-vvd-1"]) assert.equal(byId[id].recordable, false, id);

    // A device that can't be recorded is refused before anything starts.
    const tv = await plugin.call("argent_record", { device: "SIM-APPLE-TV", seconds: 1 }, metaOf(s));
    assert.equal(tv.isError, true);
    assert.match(textOf(tv), /can't be recorded: tvOS/);
    const nowhere = await plugin.call("argent_record", { device: "SIM-IPHONE-16", seconds: 1 }, {});
    assert.match(textOf(nowhere), /No project is open/);
    const both = await plugin.call("argent_record", { device: "SIM-IPHONE-16", seconds: 1, flow: "x" }, metaOf(s));
    assert.match(textOf(both), /flow or seconds, not both/);
    assert.equal(calls(s.log, "screen-recording-start").length, 0);

    // A timed take: a real mp4 in the capture folder, declared for Uncut to import.
    const timed = await plugin.call("argent_record", { device: "SIM-IPHONE-16", seconds: 1.2, name: "home screen" }, metaOf(s));
    assert.ok(!timed.isError, textOf(timed));
    const take = timed.structuredContent;
    assert.equal(take.path, join(s.captureDir, "home screen.mp4"));
    assert.ok(statSync(take.path).size === take.bytes && take.bytes > 1000);
    assert.ok(Math.abs(seconds(take.path) - 1.2) < 0.6, `about 1.2 s: ${seconds(take.path)}`);
    assert.deepEqual(take.uncut, { media: { path: take.path, name: "home screen", source: { module: "argent.capture", device: "SIM-IPHONE-16" } } });
    const start = JSON.parse(calls(s.log, "screen-recording-start")[0]!.argv[3]!);
    assert.deepEqual(start, { udid: "SIM-IPHONE-16", timeLimitSeconds: 7, trimStatic: false, showTouches: false });
    assert.equal(calls(s.log, "screen-recording-stop").length, 1);
    // Argent's scratch folder is gone; only the take is left.
    assert.deepEqual(readdirSync(s.captureDir), ["home screen.mp4"]);

    // A flow take: the flow under flows/ is saved again as saveFlow's name and named in the source.
    const flowFile = join(s.flowsDir, "login.yaml");
    writeFileSync(flowFile, "# fake-seconds: 1.5\nlaunch: com.example.app\n");
    const flowed = await plugin.call("argent_record", { device: "emulator-5554", flow: "flows/login.yaml", saveFlow: "sign in", showTouches: true }, metaOf(s));
    assert.ok(!flowed.isError, textOf(flowed));
    assert.equal(flowed.structuredContent.flow, "flows/sign-in.yaml");
    assert.equal(readFileSync(join(s.flowsDir, "sign-in.yaml"), "utf8"), readFileSync(flowFile, "utf8"));
    assert.deepEqual(flowed.structuredContent.uncut.media.source, { module: "argent.capture", device: "emulator-5554", flow: "flows/sign-in.yaml" });
    assert.ok(seconds(flowed.structuredContent.path) >= 1.4, "as long as the flow");
    const flowRun = logOf(s.log).find((e) => e.argv[0] === "flow")!;
    assert.deepEqual(flowRun.argv.slice(0, 5), ["flow", "run", flowFile, "--device", "emulator-5554"]);
    assert.equal(JSON.parse(calls(s.log, "screen-recording-start")[1]!.argv[3]!).showTouches, true);
    // A saved flow by name, from the project's flows/.
    writeFileSync(join(s.flowsDir, "quick.yaml"), "# fake-seconds: 0.5\n");
    const byName = await plugin.call("argent_record", { device: "emulator-5554", flow: "quick" }, metaOf(s));
    assert.equal(byName.structuredContent.flow, "flows/quick.yaml");

    // A flow that fails: the recording is stopped and the take dropped.
    writeFileSync(join(s.flowsDir, "broken.yaml"), "# fake-seconds: 0.3\n# fake-fail\n");
    const before = readdirSync(s.captureDir).length;
    const broken = await plugin.call("argent_record", { device: "SIM-IPHONE-16", flow: "flows/broken.yaml" }, metaOf(s));
    assert.equal(broken.isError, true);
    assert.match(textOf(broken), /the flow failed/);
    assert.equal(readdirSync(s.captureDir).length, before);
    assert.equal(calls(s.log, "screen-recording-start").length, calls(s.log, "screen-recording-stop").length);

    // Cancelled mid-take (the agent turn stopped): the recording stops, nothing is kept, no answer.
    const id = plugin.nextId();
    void plugin.request("tools/call", { name: "argent_record", arguments: { device: "SIM-IPHONE-16", seconds: 60 }, _meta: metaOf(s) }, 120000).catch(() => {});
    const stopsBefore = calls(s.log, "screen-recording-stop").length;
    for (let i = 0; i < 100 && calls(s.log, "screen-recording-start").length < 5; i++) await sleep(50);
    await sleep(300);
    plugin.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "turn ended" } })}\n`);
    for (let i = 0; i < 100 && calls(s.log, "screen-recording-stop").length === stopsBefore; i++) await sleep(50);
    assert.equal(calls(s.log, "screen-recording-stop").length, stopsBefore + 1, "cancel stops the recording");
    await sleep(500);
    assert.equal(readdirSync(s.captureDir).length, before, "a cancelled take isn't kept");
    // The device is free again.
    const again = await plugin.call("argent_record", { device: "SIM-IPHONE-16", seconds: 0.5 }, metaOf(s));
    assert.ok(!again.isError, textOf(again));

    // The Capture tab's start and stop (not agent tools).
    const started = await plugin.call("argent_capture_start", { device: "emulator-5554" }, metaOf(s));
    assert.ok(!started.isError, textOf(started));
    assert.match(textOf(await plugin.call("argent_capture_start", { device: "emulator-5554" }, metaOf(s))), /already being recorded/);
    await sleep(800);
    const stopped = await plugin.call("argent_capture_stop", { device: "emulator-5554" }, metaOf(s));
    assert.ok(!stopped.isError, textOf(stopped));
    assert.equal(stopped.structuredContent.uncut.media.source.device, "emulator-5554");
    assert.match(stopped.structuredContent.path, /Pixel 8 API 35 \d{8}-\d{6}\.mp4$/);

    // Uncut stops the plugin mid-take: the recording is stopped on the way out (a detached argent).
    await plugin.call("argent_capture_start", { device: "SIM-IPHONE-16" }, metaOf(s));
    const stops = calls(s.log, "screen-recording-stop").length;
    plugin.child.stdin!.end();
    await plugin.exited;
    for (let i = 0; i < 100 && calls(s.log, "screen-recording-stop").length === stops; i++) await sleep(50);
    assert.equal(calls(s.log, "screen-recording-stop").length, stops + 1, "exiting stops the recording");
    assertNothingForbidden(s.log);
  } finally {
    plugin.child.kill("SIGKILL");
  }
});

test("D143: bootable devices, Boot (only when asked), and the options: rotate, open an app, max length, trim", { timeout: 120000 }, async () => {
  assert.equal(toDevice({ platform: "ios", udid: "B", name: "iPad", state: "Shutdown", runtimeKind: "mobile" })!.bootable, true);
  assert.equal(toDevice({ platform: "ios", udid: "C", name: "Apple TV", state: "Shutdown", runtimeKind: "tv" })!.bootable, undefined);
  assert.equal(toDevice({ platform: "ios", udid: "D", name: "iPhone", state: "Booting", runtimeKind: "mobile" })!.bootable, undefined);
  assert.deepEqual(prepOf({ orientation: "LandscapeLeft", bundleId: "com.example.app" }), { orientation: "LandscapeLeft", bundleId: "com.example.app" });
  assert.throws(() => prepOf({ orientation: "Sideways" }), /orientation must be one of/);
  assert.throws(() => prepOf({ bundleId: "com.x; rm -rf /" }), /bundleId must look like/);

  const s = setup("boot");
  const plugin = startPlugin({ ARGENT_BIN: FAKE_ARGENT, FAKE_ARGENT_LOG: s.log, FAKE_ARGENT_STATE: s.state });
  try {
    await plugin.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    // Listing boots nothing: the shut-down iPad and the AVD that isn't running are bootable; the
    // AVD whose emulator runs (Pixel_8_API_35, emulator-5554) isn't listed twice.
    const list = await plugin.call("argent_list_devices", {});
    const byId = Object.fromEntries(list.structuredContent.devices.map((d: any) => [d.id, d]));
    assert.equal(byId["SIM-IPAD-OFF"].bootable, true);
    assert.deepEqual(byId["avd:Pixel_Tablet_API_35"], { id: "avd:Pixel_Tablet_API_35", platform: "android", name: "Pixel Tablet API 35", state: "stopped", recordable: false, reason: "Not running", bootable: true });
    assert.equal(byId["avd:Pixel_8_API_35"], undefined);
    assert.equal(byId["SIM-APPLE-TV"].bootable, undefined);
    assertNothingForbidden(s.log, 0);
    // The agent can't boot: it's not one of its tools, and recording a shut-down simulator is refused.
    const off = await plugin.call("argent_record", { device: "SIM-IPAD-OFF", seconds: 1 }, metaOf(s));
    assert.match(textOf(off), /can't be recorded: Not booted/);
    const tools = await plugin.request("tools/list", {});
    assert.ok(!JSON.stringify(tools).includes("boot-device"));
    // Booting something not bootable is refused without a boot.
    const tv = await plugin.call("argent_capture_boot", { device: "SIM-APPLE-TV" });
    assert.equal(tv.isError, true);
    assert.match(textOf(tv), /can't be booted/);
    // Booting a device that's already running boots nothing and returns it.
    const already = await plugin.call("argent_capture_boot", { device: "SIM-IPHONE-16" });
    assert.equal(already.structuredContent.device, "SIM-IPHONE-16");
    assertNothingForbidden(s.log, 0);

    // The click: the iPad boots (one boot-device with its udid), then records with every option.
    const booted = await plugin.call("argent_capture_boot", { device: "SIM-IPAD-OFF" });
    assert.ok(!booted.isError, textOf(booted));
    assert.deepEqual(booted.structuredContent, { device: "SIM-IPAD-OFF", name: "iPad Air" });
    assert.deepEqual(JSON.parse(calls(s.log, "boot-device")[0]!.argv[3]!), { udid: "SIM-IPAD-OFF" });
    const started = await plugin.call("argent_capture_start", { device: "SIM-IPAD-OFF", orientation: "LandscapeLeft", bundleId: "com.example.app", maxSeconds: 30, trimStatic: true, showTouches: true }, metaOf(s));
    assert.ok(!started.isError, textOf(started));
    assert.equal(started.structuredContent.limitSeconds, 30);
    await sleep(1100);
    const stopped = await plugin.call("argent_capture_stop", { device: "SIM-IPAD-OFF" }, metaOf(s));
    assert.ok(!stopped.isError, textOf(stopped));
    assert.ok(existsSync(stopped.structuredContent.path));
    // In order: boot, rotate, open the app, start (with the options), stop.
    const order = logOf(s.log).filter((e) => e.argv[0] === "run" && e.argv[1] !== "list-devices" && !(e as { completed?: string }).completed).map((e) => e.argv[1]);
    assert.deepEqual(order, ["boot-device", "rotate", "launch-app", "screen-recording-start", "screen-recording-stop"]);
    assert.deepEqual(JSON.parse(calls(s.log, "rotate")[0]!.argv[3]!), { udid: "SIM-IPAD-OFF", orientation: "LandscapeLeft" });
    assert.deepEqual(JSON.parse(calls(s.log, "launch-app")[0]!.argv[3]!), { udid: "SIM-IPAD-OFF", bundleId: "com.example.app" });
    assert.deepEqual(JSON.parse(calls(s.log, "screen-recording-start")[0]!.argv[3]!), { udid: "SIM-IPAD-OFF", timeLimitSeconds: 30, trimStatic: true, showTouches: true });

    // An AVD: boot-device with its name; the emulator's new serial comes back to record.
    const avd = await plugin.call("argent_capture_boot", { device: "avd:Pixel_Tablet_API_35" });
    assert.deepEqual(avd.structuredContent, { device: "emulator-5556", name: "Pixel Tablet API 35" });
    assert.deepEqual(JSON.parse(calls(s.log, "boot-device")[1]!.argv[3]!), { avdName: "Pixel_Tablet_API_35" });
    const after = await plugin.call("argent_list_devices", {});
    const now = Object.fromEntries(after.structuredContent.devices.map((d: any) => [d.id, d]));
    assert.equal(now["emulator-5556"].recordable, true);
    assert.equal(now["avd:Pixel_Tablet_API_35"], undefined);
    assert.equal(now["SIM-IPAD-OFF"].recordable, true);

    // An app that isn't installed: the take doesn't start, and says why.
    const missing = await plugin.call("argent_capture_start", { device: "emulator-5556", bundleId: "com.missing.app" }, metaOf(s));
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /launch-app failed: App com\.missing\.app is not installed/);
    assert.equal(calls(s.log, "screen-recording-start").length, 1);

    // The agent's argent_record takes orientation and bundleId too (a flow take here).
    writeFileSync(join(s.flowsDir, "tour.yaml"), "# fake-seconds: 0.6\nsteps: []\n");
    const flowTake = await plugin.call("argent_record", { device: "emulator-5556", flow: "tour", orientation: "Portrait", bundleId: "com.example.app" }, metaOf(s));
    assert.ok(!flowTake.isError, textOf(flowTake));
    assert.deepEqual(JSON.parse(calls(s.log, "rotate")[1]!.argv[3]!), { udid: "emulator-5556", orientation: "Portrait" });
    assert.deepEqual(JSON.parse(calls(s.log, "launch-app").at(-1)!.argv[3]!), { udid: "emulator-5556", bundleId: "com.example.app" });
    assertNothingForbidden(s.log, 2);
  } finally {
    plugin.child.kill("SIGKILL");
  }
});

test("Argent missing or too old: the install command, nothing recorded", { timeout: 30000 }, async () => {
  const s = setup("missing");
  const missing = startPlugin({ ARGENT_BIN: join(s.dir, "no-argent-here"), FAKE_ARGENT_LOG: s.log });
  try {
    const list = await missing.call("argent_list_devices", {});
    assert.equal(list.isError, true);
    assert.equal(list.structuredContent.argent.installed, false);
    assert.equal(list.structuredContent.argent.install, "npm i -g @swmansion/argent@latest");
    assert.match(textOf(list), /isn't installed.*npm i -g @swmansion\/argent@latest/);
    const record = await missing.call("argent_record", { device: "SIM-IPHONE-16", seconds: 1 }, metaOf(s));
    assert.equal(record.isError, true);
    assert.match(textOf(record), /isn't installed/);
  } finally {
    missing.child.kill("SIGKILL");
  }
  const old = startPlugin({ ARGENT_BIN: FAKE_ARGENT, FAKE_ARGENT_LOG: s.log, FAKE_ARGENT_VERSION: "0.16.1" });
  try {
    const list = await old.call("argent_list_devices", {});
    assert.equal(list.isError, true);
    assert.match(textOf(list), /0\.16\.1 is too old: recording needs 0\.19\.0/);
    assert.equal(calls(s.log, "list-devices").length, 0);
  } finally {
    old.child.kill("SIGKILL");
  }
  assertNothingForbidden(s.log);
});

test("on the server: the Capture tab records into the Library (one ⌘Z), the agent records, places, re-shoots and undoes", { skip, timeout: 180000 }, async () => {
  const base = join(root, "server");
  mkdirSync(join(base, "projects"), { recursive: true });
  const files = { plan: join(base, "plan.json"), prompts: join(base, "prompts.jsonl"), results: join(base, "results.jsonl"), log: join(base, "argent.jsonl") };
  for (const f of [files.prompts, files.results, files.log]) writeFileSync(f, "");
  const server = await startServer({
    env: {
      UNCUT_DATA_DIR: join(base, "data"),
      UNCUT_PLUGINS_DIR: "",
      UNCUT_BUNDLED_PLUGINS_DIR: resolve("plugins"),
      UNCUT_CLAUDE: FAKE_CLAUDE,
      ANTHROPIC_API_KEY: "",
      ARGENT_BIN: FAKE_ARGENT,
      FAKE_ARGENT_NODE: process.execPath,
      FAKE_ARGENT_LOG: files.log,
      FAKE_PLAN: files.plan,
      FAKE_PROMPT_LOG: files.prompts,
      FAKE_RESULT_LOG: files.results,
    },
  });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    // Shipped with the app, so allowed without asking (D97).
    const listed = await client.ok("plugins.list");
    const argent = listed.find((p: any) => p.id === "argent.capture");
    assert.equal(argent.status, "ready");
    assert.equal(argent.source, "bundled");
    assert.deepEqual(argent.tools, ["argent_list_devices", "argent_record", "argent_reshoot"]);

    const agent = client.subscribe("agent.subscribe");
    const project = client.subscribe("project.subscribe");
    const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Capture" });
    await agent.until((s) => s?.dir === snap.dir);

    // The Capture tab: the devices, then Record and Stop.
    const state = await client.ok("capture.devices");
    assert.equal(state.installed, true);
    assert.equal(state.devices.find((d: any) => d.id === "SIM-APPLE-TV").recordable, false);
    assert.equal((await client.fail("capture.start", { device: "SIM-APPLE-TV" })).message.includes("can't be recorded"), true);
    await client.ok("capture.start", { device: "SIM-IPHONE-16" });
    assert.deepEqual((await client.ok("capture.devices")).recording.map((r: any) => r.device), ["SIM-IPHONE-16"]);
    await sleep(1000);
    const stopped = await client.ok("capture.stop", { device: "SIM-IPHONE-16" });
    assert.ok(stopped.seconds > 0.5, JSON.stringify(stopped));
    await project.until((p) => p?.project.media.some((m: any) => m.id === stopped.mediaId));
    const recorded = project.values.at(-1).project.media.find((m: any) => m.id === stopped.mediaId);
    assert.match(recorded.path, /^media\/captures\/iPhone 16 \d{8}-\d{6}\.mp4$/);
    assert.deepEqual(recorded.source, { module: "argent.capture", device: "SIM-IPHONE-16" });
    // One user edit: one ⌘Z removes it.
    const undone = await client.ok("project.undo");
    assert.equal(undone.project.media.length, 0);

    // The agent: list, record from a flow, place the take, then re-shoot it with a shorter flow.
    const flows = join(snap.dir, "flows");
    mkdirSync(flows, { recursive: true });
    writeFileSync(join(flows, "login.yaml"), "# fake-seconds: 3\nlaunch: com.example.app\n");
    writeFileSync(join(flows, "login-short.yaml"), "# fake-seconds: 1\nlaunch: com.example.app\n");
    const turns: Array<unknown> = [];
    const ask = async (prompt: string, steps: Array<unknown>) => {
      turns.push(steps);
      writeFileSync(files.plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt });
      await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 90000);
      return agent.values.at(-1).turns.find((t: any) => t.id === turnId);
    };
    const results = () => readFileSync(files.results, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const resultText = (tool: string) => results().filter((r) => r.tool === tool).at(-1)!.result.content.map((c: any) => c.text).join("\n");

    const recordTurn = await ask("Record the login on the iPhone and put it in", [
      { tool: "argent_list_devices", args: {} },
      { tool: "argent_record", args: { device: "SIM-IPHONE-16", flow: "login", name: "login" } },
      { tool: "project_read", args: {} },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Place the login", ops: [{ op: "insert_item", track: "main", item: { id: "clip-login", type: "clip", media: "m-login", in: 0, duration: 80 } }] } },
      { text: "Recorded the login (real time) and put it on the main track." },
    ]);
    assert.equal(recordTurn.status, "done", JSON.stringify(recordTurn));
    assert.match(resultText("argent_list_devices"), /SIM-IPHONE-16/);
    const recordedText = resultText("argent_record");
    assert.match(recordedText, /"imported"/);
    assert.match(recordedText, /"id": "m-login"/);
    assert.ok(recordTurn.edits.some((e: any) => e.summary === "Recorded login"), JSON.stringify(recordTurn.edits));
    await project.until((p) => p?.project.tracks.some((t: any) => t.items.some((i: any) => i.id === "clip-login")));
    let now = project.values.at(-1).project;
    const login = now.media.find((m: any) => m.id === "m-login");
    assert.equal(login.path, "media/captures/login.mp4");
    assert.deepEqual(login.source, { module: "argent.capture", device: "SIM-IPHONE-16", flow: "flows/login.yaml" });
    assert.ok(login.probe.frames >= 80, `a 3 s take: ${login.probe.frames}`);

    // Re-shoot with a shorter flow: the file is swapped in place and the clip trimmed to fit.
    const reshootTurn = await ask("The app changed: re-shoot the login with the short flow", [
      { tool: "argent_reshoot", args: { mediaId: "m-login", flow: "flows/login-short.yaml" } },
      { text: "Re-shot the login; the clip got shorter." },
    ]);
    assert.equal(reshootTurn.status, "done", JSON.stringify(reshootTurn));
    const reshotText = resultText("argent_reshoot");
    assert.match(reshotText, /"replaced"/);
    assert.match(reshotText, /trimmed by/);
    await project.until((p) => p?.project.media.some((m: any) => m.id === "m-login" && m.path !== "media/captures/login.mp4"));
    now = project.values.at(-1).project;
    const reshot = now.media.find((m: any) => m.id === "m-login");
    assert.equal(reshot.path, "media/captures/login reshoot.mp4");
    assert.equal(reshot.source.flow, "flows/login-short.yaml");
    assert.ok(reshot.probe.frames < 80, `a shorter take: ${reshot.probe.frames}`);
    const clip = now.tracks.flatMap((t: any) => t.items).find((i: any) => i.id === "clip-login");
    assert.equal(clip.duration, reshot.probe.frames, "trimmed to the new end");
    assert.ok(existsSync(join(snap.dir, "media/captures/login.mp4")), "the old take is kept (Undo brings it back)");

    // Undo turn on the re-shoot: the old file and the clip's length are back, in one step.
    const afterReshoot = await client.ok("agent.undoTurn", { turnId: reshootTurn.id });
    const back = afterReshoot.project.media.find((m: any) => m.id === "m-login");
    assert.equal(back.path, "media/captures/login.mp4");
    assert.equal(afterReshoot.project.tracks.flatMap((t: any) => t.items).find((i: any) => i.id === "clip-login").duration, 80);
    // Undo turn on the recording: the take and its clip are gone.
    const afterRecord = await client.ok("agent.undoTurn", { turnId: recordTurn.id });
    assert.equal(afterRecord.project.media.length, 0);
    assert.equal(afterRecord.project.tracks.flatMap((t: any) => t.items).length, 0);

    // Every recording that started was stopped, and Argent's server was never touched.
    assert.equal(calls(files.log, "screen-recording-start").length, calls(files.log, "screen-recording-stop").length);
    assertNothingForbidden(files.log);
  } finally {
    client.close();
    await server.stop();
  }
});

test("review fixes: failed stops, cancel while starting, a stop running at exit, stale scratch, flow paths", { timeout: 120000 }, async () => {
  const s = setup("fixes");
  mkdirSync(s.state, { recursive: true });
  const ctl = (name: string, value: number | undefined) => (value === undefined ? rmSync(join(s.state, name), { force: true }) : writeFileSync(join(s.state, name), String(value)));
  let plugin = startPlugin({ ARGENT_BIN: FAKE_ARGENT, FAKE_ARGENT_LOG: s.log, FAKE_ARGENT_STATE: s.state });
  const waitUntil = async (check: () => boolean, ms = 8000) => {
    for (let i = 0; i < ms / 50 && !check(); i++) await sleep(50);
    return check();
  };
  try {
    // A stale scratch folder (a killed plugin's) goes when a take starts; a fresh one stays.
    const old = join(s.captureDir, ".argent-take-old");
    const fresh = join(s.captureDir, ".argent-take-fresh");
    mkdirSync(old);
    mkdirSync(fresh);
    const longAgo = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);
    assert.ok(!(await plugin.call("argent_record", { device: "SIM-IPHONE-16", seconds: 0.3 }, metaOf(s))).isError);
    assert.ok(!existsSync(old) && existsSync(fresh), "only the stale scratch folder is swept");
    rmSync(fresh, { recursive: true });

    // A stop that fails is tried again; when that fails too, a detached stop finishes it, and the
    // device is free again.
    await plugin.call("argent_capture_start", { device: "SIM-IPHONE-16" }, metaOf(s));
    ctl("stop-fail", 2);
    let stops = calls(s.log, "screen-recording-stop").length;
    const failed = await plugin.call("argent_capture_stop", { device: "SIM-IPHONE-16" }, metaOf(s));
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /didn't answer/);
    assert.ok(await waitUntil(() => calls(s.log, "screen-recording-stop").length === stops + 3), "two tries, then a detached stop");
    assert.ok(await waitUntil(() => !existsSync(join(s.state, "SIM-IPHONE-16.json"))), "the recording did stop");
    ctl("stop-fail", undefined);
    // One failure: the retry works and the take is kept.
    await plugin.call("argent_capture_start", { device: "SIM-IPHONE-16" }, metaOf(s));
    ctl("stop-fail", 1);
    const retried = await plugin.call("argent_capture_stop", { device: "SIM-IPHONE-16" }, metaOf(s));
    assert.ok(!retried.isError, textOf(retried));
    // A failing flow's error isn't hidden by a failing stop.
    writeFileSync(join(s.flowsDir, "broken.yaml"), "# fake-seconds: 0.2\n# fake-fail\n");
    ctl("stop-fail", 2);
    const broken = await plugin.call("argent_record", { device: "SIM-IPHONE-16", flow: "broken" }, metaOf(s));
    assert.match(textOf(broken), /the flow failed: .*and stopping the recording failed too/);
    assert.ok(await waitUntil(() => !existsSync(join(s.state, "SIM-IPHONE-16.json"))));
    ctl("stop-fail", undefined);

    // Cancelled while the start is still running: the start is stopped, so is the recording, and nothing is kept.
    ctl("start-delay", 1500);
    const id = plugin.nextId();
    void plugin.request("tools/call", { name: "argent_record", arguments: { device: "emulator-5554", seconds: 30 }, _meta: metaOf(s) }, 60000).catch(() => {});
    assert.ok(await waitUntil(() => existsSync(join(s.state, "emulator-5554.json"))), "the recording began");
    stops = calls(s.log, "screen-recording-stop").length;
    plugin.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } })}\n`);
    assert.ok(await waitUntil(() => !existsSync(join(s.state, "emulator-5554.json"))), `cancel during start stops the recording: ${readFileSync(s.log, "utf8").split("\n").slice(-6).join("\n")} ${plugin.stderr()}`);
    assert.equal(calls(s.log, "screen-recording-stop").length, stops + 1);
    ctl("start-delay", undefined);
    const takes = () => readdirSync(s.captureDir).filter((f) => f.endsWith(".mp4")).length;
    const kept = takes();
    await sleep(300);
    assert.equal(takes(), kept);
    assert.ok(!(await plugin.call("argent_record", { device: "emulator-5554", seconds: 0.3 }, metaOf(s))).isError, "the device is free again");

    // Flow paths: a name or a path under flows/ only; stored ones stay inside the project; no symlinks out.
    const outside = join(s.dir, "outside.yaml");
    writeFileSync(outside, "# fake-seconds: 0.1\n");
    for (const flow of [outside, "flows/../../outside.yaml", "../outside.yaml", "elsewhere/x.yaml"]) {
      const r = await plugin.call("argent_record", { device: "SIM-IPHONE-16", flow }, metaOf(s));
      assert.equal(r.isError, true, flow);
      assert.match(textOf(r), /has to be a saved flow's name or a path under the project's flows\/ folder/, flow);
    }
    symlinkSync(outside, join(s.flowsDir, "escape.yaml"));
    assert.match(textOf(await plugin.call("argent_record", { device: "SIM-IPHONE-16", flow: "escape" }, metaOf(s))), /leads outside the project's flows\/ folder/);
    writeFileSync(join(s.flowsDir, "quick.yaml"), "# fake-seconds: 0.1\n");
    symlinkSync(outside, join(s.flowsDir, "dest.yaml"));
    assert.match(textOf(await plugin.call("argent_record", { device: "SIM-IPHONE-16", flow: "quick", saveFlow: "dest" }, metaOf(s))), /is a symbolic link/);
    assert.equal(readFileSync(outside, "utf8"), "# fake-seconds: 0.1\n", "nothing written through the link");
    // A stored source.flow that leads out is refused too.
    const media = (flow: string) => ({ id: "m-x", kind: "video", name: "x", path: "media/captures/x.mp4", source: { module: "argent.capture", device: "SIM-IPHONE-16", flow } });
    for (const flow of ["../outside.yaml", outside, "flows/escape.yaml"]) {
      writeFileSync(join(s.project, "project.json"), JSON.stringify({ media: [media(flow)] }));
      const r = await plugin.call("argent_reshoot", { mediaId: "m-x" }, metaOf(s));
      assert.equal(r.isError, true, flow);
      assert.match(textOf(r), /has to be a path inside the project|leads outside the project's folder/, flow);
    }

    // A stop still running when Uncut stops the plugin isn't killed: it finishes the recording.
    await plugin.call("argent_capture_start", { device: "SIM-IPHONE-16" }, metaOf(s));
    ctl("stop-delay", 1500);
    stops = calls(s.log, "screen-recording-stop").length;
    const done = completedStops(s.log).length;
    void plugin.call("argent_capture_stop", { device: "SIM-IPHONE-16" }, metaOf(s)).catch(() => {});
    assert.ok(await waitUntil(() => calls(s.log, "screen-recording-stop").length === stops + 1));
    plugin.child.stdin!.end();
    await plugin.exited;
    assert.ok(await waitUntil(() => completedStops(s.log).length === done + 1), "the running stop finished");
    assert.equal(calls(s.log, "screen-recording-stop").length, stops + 1, "no second stop for a recording whose stop was running");
    ctl("stop-delay", undefined);
    assertNothingForbidden(s.log);
  } finally {
    plugin.child.kill("SIGKILL");
  }
});
