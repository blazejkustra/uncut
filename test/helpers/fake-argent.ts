#!/usr/bin/env node
// A stand-in for the `argent` CLI (D98 tests), run through the shim test/helpers/fake-argent/argent
// (point ARGENT_BIN at it). It never touches a device or Argent's tool-server. It implements:
//   --version                                   FAKE_ARGENT_VERSION, default 0.28.0
//   run list-devices --json                      FAKE_ARGENT_DEVICES (JSON) or a default set, plus
//                                                FAKE_ARGENT_AVDS (JSON) or two AVDs (one running);
//                                                devices booted by boot-device show as booted
//   run boot-device --args {udid}|{avdName} --json   marks the simulator Booted, or adds a running
//                                                emulator (emulator-5556...) for the AVD; logged
//                                                with boot: true (tests count them)
//   run rotate --args {udid, orientation} --json, run launch-app --args {udid, bundleId} --json
//                                                (fail when the device isn't booted)
//   run screen-recording-start --args {...} --json
//   run screen-recording-stop --args {...} --json   writes a real mp4 (ffmpeg testsrc) as long as
//                                                the wall time since start (capped by the limit),
//                                                under <cwd>/.argent/recordings like Argent
//   flow run <file.yaml> --device <id> --json    sleeps for the yaml's "# fake-seconds: N" (default
//                                                1), fails when it has "# fake-fail"
// Misbehaviour on request, by files in the state folder: boot-delay (ms a boot takes), stop-fail (a count: that many stops fail
// before one works), start-delay / stop-delay (ms a start waits after the recording began, a stop
// waits before it ends it). A stop that finished logs { completed: "screen-recording-stop" }.
// Every call appends { argv, cwd, pid, at } to $FAKE_ARGENT_LOG; a call that would stop Argent's
// server, stop all simulator servers or shut down a device is logged with forbidden: true (the tests
// assert there are none). A boot (D143: only on the user's click) is allowed and logged boot: true. Recording state lives in $FAKE_ARGENT_STATE (default: the
// log's folder), one file per device, since each call is its own process.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const logFile = process.env.FAKE_ARGENT_LOG;
const stateDir = process.env.FAKE_ARGENT_STATE ?? (logFile ? join(dirname(logFile), "fake-argent-state") : join(process.cwd(), ".fake-argent-state"));
const FORBIDDEN = /^(server|stop-all-simulator-servers|stop-simulator-server|shutdown|kill|reset|uninstall|remove|update|init|install)$/;
const forbidden =
  argv[0] === "server" || (argv[0] === "run" && FORBIDDEN.test(argv[1] ?? "")) || (argv[0] !== "run" && argv[0] !== "flow" && FORBIDDEN.test(argv[0] ?? ""));
if (logFile)
  appendFileSync(
    logFile,
    `${JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, at: Date.now(), ...(forbidden ? { forbidden: true } : {}), ...(argv[0] === "run" && argv[1] === "boot-device" ? { boot: true } : {}) })}\n`,
  );

const fail = (message: string, code = 1): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const payload = (): Record<string, unknown> => {
  const raw = flag("--args");
  if (!raw) return fail("--args is required by the fake", 2);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fail(`--args is not valid JSON: ${raw}`, 2);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const control = (name: string) => {
  const file = join(stateDir, name);
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
};

const DEFAULT_DEVICES = [
  { platform: "ios", udid: "SIM-IPHONE-16", name: "iPhone 16", state: "Booted", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2", runtimeKind: "mobile" },
  {
    platform: "android",
    serial: "emulator-5554",
    state: "device",
    isEmulator: true,
    kind: "emulator",
    model: "sdk_gphone64_arm64",
    avdName: "Pixel_8_API_35",
    sdkLevel: 35,
    runtimeKind: "mobile",
  },
  { platform: "ios", udid: "SIM-IPAD-OFF", name: "iPad Air", state: "Shutdown", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2", runtimeKind: "mobile" },
  { platform: "ios", udid: "SIM-APPLE-TV", name: "Apple TV", state: "Booted", runtime: "com.apple.CoreSimulator.SimRuntime.tvOS-18-2", runtimeKind: "tv" },
  { platform: "chromium", id: "chromium-cdp-9222", port: 9222, title: "Docs", url: "https://example.com", browser: "Chrome/140", state: "Running" },
  { platform: "vega", serial: "amazon-vvd-1", vvdImage: "tv", kind: "vvd", state: "running" },
];

const DEFAULT_AVDS = [
  { name: "Pixel_8_API_35", target: "android-35" },
  { name: "Pixel_Tablet_API_35", target: "android-35" },
];
const bootedFile = () => join(stateDir, "booted.json");
/** What boot-device changed: simulators now booted, emulators started for AVDs. */
const booted = (): { udids: Array<string>; emulators: Array<{ serial: string; avdName: string }> } =>
  existsSync(bootedFile()) ? JSON.parse(readFileSync(bootedFile(), "utf8")) : { udids: [], emulators: [] };
const devices = (): Array<Record<string, unknown>> => {
  const b = booted();
  const base = (process.env.FAKE_ARGENT_DEVICES ? JSON.parse(process.env.FAKE_ARGENT_DEVICES) : DEFAULT_DEVICES) as Array<Record<string, unknown>>;
  return [
    ...base.map((d) => (typeof d.udid === "string" && b.udids.includes(d.udid) ? { ...d, state: "Booted" } : d)),
    ...b.emulators.map((e) => ({
      platform: "android",
      serial: e.serial,
      state: "device",
      isEmulator: true,
      kind: "emulator",
      model: "sdk_gphone64_arm64",
      avdName: e.avdName,
      sdkLevel: 35,
      runtimeKind: "mobile",
    })),
  ];
};
const isBooted = (id: string) => devices().some((d) => (d.udid === id || d.serial === id) && (d.state === "Booted" || d.state === "device"));

async function main() {
  if (forbidden) return fail(`fake argent: ${argv.slice(0, 2).join(" ")} is not something Uncut may run`, 3);
  if (argv[0] === "--version" || argv[0] === "-v") return void process.stdout.write(`${process.env.FAKE_ARGENT_VERSION ?? "0.28.0"}\n`);
  if (argv[0] === "run") {
    const tool = argv[1];
    if (tool === "list-devices")
      return print({ devices: devices(), avds: process.env.FAKE_ARGENT_AVDS ? JSON.parse(process.env.FAKE_ARGENT_AVDS) : DEFAULT_AVDS });
    mkdirSync(stateDir, { recursive: true });
    if (tool === "boot-device") {
      const p = payload();
      if (control("boot-delay")) await sleep(control("boot-delay"));
      const b = booted();
      if (typeof p.udid === "string") {
        const sim = devices().find((d) => d.udid === p.udid);
        if (!sim) return fail(`No simulator ${p.udid}`);
        if (!b.udids.includes(p.udid)) b.udids.push(p.udid);
        writeFileSync(bootedFile(), JSON.stringify(b));
        return print({ platform: "ios", udid: p.udid, booted: true });
      }
      if (typeof p.avdName === "string") {
        const avds = (process.env.FAKE_ARGENT_AVDS ? JSON.parse(process.env.FAKE_ARGENT_AVDS) : DEFAULT_AVDS) as Array<{ name: string }>;
        if (!avds.some((a) => a.name === p.avdName)) return fail(`No AVD ${p.avdName}`);
        const serial = `emulator-${5556 + b.emulators.length * 2}`;
        b.emulators.push({ serial, avdName: p.avdName });
        writeFileSync(bootedFile(), JSON.stringify(b));
        return print({ platform: "android", serial, avdName: p.avdName, booted: true });
      }
      return fail("udid or avdName is required", 2);
    }
    if (tool === "rotate" || tool === "launch-app") {
      const p = payload();
      const udid = String(p.udid ?? "");
      if (!isBooted(udid)) return fail(`${udid} is not booted`);
      if (tool === "rotate") {
        if (!["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"].includes(String(p.orientation)))
          return fail(`orientation ${p.orientation} is not valid`, 2);
        return print({ orientation: p.orientation });
      }
      if (!p.bundleId) return fail("bundleId is required", 2);
      if (p.bundleId === "com.missing.app") return fail(`App ${p.bundleId} is not installed`);
      return print({ launched: true, bundleId: p.bundleId });
    }
    if (tool === "screen-recording-start") {
      const p = payload();
      const udid = String(p.udid ?? "");
      if (!udid) return fail("udid is required");
      const file = join(stateDir, `${encodeURIComponent(udid)}.json`);
      if (existsSync(file)) return fail(`A recording is already running on ${udid}`);
      if (!isBooted(udid)) return fail(`${udid} is not booted`);
      writeFileSync(
        file,
        JSON.stringify({
          udid,
          startedAt: Date.now(),
          timeLimitSeconds: p.timeLimitSeconds ?? 180,
          trimStatic: p.trimStatic ?? true,
          showTouches: p.showTouches ?? true,
        }),
      );
      if (control("start-delay")) await sleep(control("start-delay"));
      return print({ udid, started: true, timeLimitSeconds: p.timeLimitSeconds ?? 180 });
    }
    if (tool === "screen-recording-stop") {
      const p = payload();
      const udid = String(p.udid ?? "");
      const file = join(stateDir, `${encodeURIComponent(udid)}.json`);
      if (!existsSync(file)) return fail(`No recording is running on ${udid}`);
      const failures = control("stop-fail");
      if (failures > 0) {
        writeFileSync(join(stateDir, "stop-fail"), String(failures - 1));
        return fail("The simulator server didn't answer");
      }
      if (control("stop-delay")) await sleep(control("stop-delay"));
      const state = JSON.parse(readFileSync(file, "utf8")) as { startedAt: number; timeLimitSeconds: number };
      rmSync(file, { force: true });
      const seconds = Math.max(0.5, Math.min(state.timeLimitSeconds, (Date.now() - state.startedAt) / 1000));
      const out = join(process.cwd(), ".argent", "recordings", `screen-recording-${udid}-${Date.now()}.mp4`);
      mkdirSync(dirname(out), { recursive: true });
      const ffmpeg = spawnSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=180x320:rate=30",
        "-t",
        seconds.toFixed(2),
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        out,
      ]);
      if (ffmpeg.status !== 0) return fail(`ffmpeg failed: ${ffmpeg.stderr}`);
      if (logFile) appendFileSync(logFile, `${JSON.stringify({ argv, completed: "screen-recording-stop", pid: process.pid, at: Date.now() })}\n`);
      return print({ video: out, durationMs: Math.round(seconds * 1000) });
    }
    return fail(`fake argent doesn't know the tool ${tool}`, 2);
  }
  if (argv[0] === "flow" && argv[1] === "run") {
    const file = argv[2];
    if (!file || !existsSync(file)) return fail(`No flow at ${file}`, 2);
    const yaml = readFileSync(file, "utf8");
    const seconds = Number(/#\s*fake-seconds:\s*([\d.]+)/.exec(yaml)?.[1] ?? 1);
    await sleep(seconds * 1000);
    if (/#\s*fake-fail/.test(yaml)) {
      print({ ok: false, steps: [{ ok: false, error: "tap target not found" }] });
      return fail("Flow failed at step 1: tap target not found");
    }
    return print({ ok: true, flow: file, device: flag("--device"), steps: [{ ok: true }] });
  }
  return fail(`fake argent: unknown command ${argv.join(" ")}`, 2);
}

await main();
