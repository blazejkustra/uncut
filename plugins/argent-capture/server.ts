#!/usr/bin/env node
// Uncut's Argent capture plugin (D19, D20, D98): a stdio MCP server, one JSON-RPC message per line,
// that records iOS simulators and Android emulators/devices through the `argent` CLI. No
// dependencies: it runs on Uncut's own Node (D97), from this folder.
//
// Argent is found at $ARGENT_BIN, else on PATH. It's only ever asked for its version, the device
// list, a recording's start and stop, and a flow run: never to start, stop or reset its shared
// tool-server (other agents on this Mac use it), never to boot or shut down a device.
//
// Uncut passes the project in each tools/call's _meta (D98): uncut/projectDir, uncut/captureDir
// (<project>/media/captures, where takes are written) and uncut/flowsDir (<project>/flows). A
// finished take is declared for Uncut to import in structuredContent.uncut ({ media } or, for a
// re-shoot, { replace }); the plugin itself never edits the project.
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const MODULE_ID = "argent.capture";
export const MIN_VERSION = "0.19.0";
export const INSTALL = "npm i -g @swmansion/argent@latest";
// Argent's own cap for a recording (screen-recording-start's timeLimitSeconds, max 600): a take
// the plugin couldn't stop (it was killed) ends there by itself.
const MAX_SECONDS = 600;
// How long a flow may run before the plugin gives up on it (and stops the recording).
const FLOW_TIMEOUT_MS = (MAX_SECONDS + 20) * 1000;
const CALL_TIMEOUT_MS = 60_000;

// ---- small helpers ----

type Json = Record<string, unknown>;
const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

class Refusal extends Error {}

export const compareVersions = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

function findArgent(): string | undefined {
  const given = process.env.ARGENT_BIN;
  if (given) return existsSync(given) ? given : undefined;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "argent");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

/** Argent's environment: ours without Electron's run-as-node switch (it's a Node CLI of its own). */
const argentEnv = () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

/**
 * Runs argent and collects its output. Its own process group (detached), so stopping this plugin
 * never takes an argent call with it half-way, and an aborted flow can be stopped as a whole.
 */
function runArgent(args: ReadonlyArray<string>, options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Run> {
  const bin = findArgent();
  if (!bin) return Promise.reject(new Refusal(`Argent isn't installed. Install it with: ${INSTALL}`));
  // Cancelled before it started: don't start it.
  if (options.signal?.aborted) return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let child: ChildProcess;
    try {
      child = spawn(bin, [...args], { cwd: options.cwd ?? process.cwd(), env: argentEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      return done({ code: null, stdout, stderr: messageOf(error), timedOut, aborted });
    }
    running.set(child, args[1] === "screen-recording-stop");
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 2000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? CALL_TIMEOUT_MS);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => (stdout = (stdout + d).slice(-2_000_000)));
    child.stderr!.on("data", (d: string) => (stderr = (stderr + d).slice(-20_000)));
    const finish = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      running.delete(child);
      done({ code, stdout, stderr, timedOut, aborted });
    };
    child.once("error", (error) => {
      stderr += messageOf(error);
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}
// Every argent call in flight; true for a stop call (never killed on the way out: it's what
// finishes a recording).
const running = new Map<ChildProcess, boolean>();

/** The last meaningful line argent printed, for an error sentence. */
const lastLine = (run: Run) => (run.stderr.trim() || run.stdout.trim()).split("\n").filter(Boolean).at(-1)?.slice(0, 400) ?? `exit code ${run.code}`;

/** `argent run <tool> --args <json> --json`, parsed. */
async function argentTool(tool: string, payload: Json, options: { cwd?: string; signal?: AbortSignal } = {}): Promise<Json> {
  const run = await runArgent(["run", tool, "--args", JSON.stringify(payload), "--json"], options);
  if (run.aborted) throw new Error("cancelled");
  if (run.timedOut) throw new Error(`argent ${tool} didn't answer within ${CALL_TIMEOUT_MS / 1000} s`);
  if (run.code !== 0) throw new Error(`argent ${tool} failed: ${lastLine(run)}`);
  try {
    const parsed = JSON.parse(run.stdout) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Json) : { value: parsed };
  } catch {
    throw new Error(`argent ${tool} printed something that isn't JSON: ${run.stdout.trim().slice(0, 200)}`);
  }
}

// ---- Argent and its devices ----

interface ArgentInfo {
  readonly installed: boolean;
  readonly version?: string;
  readonly problem?: string;
}

async function argentInfo(): Promise<ArgentInfo> {
  if (!findArgent()) return { installed: false, problem: "Argent isn't installed." };
  const run = await runArgent(["--version"], { timeoutMs: 15_000 }).catch((error) => ({ code: 1, stdout: "", stderr: messageOf(error), timedOut: false, aborted: false }));
  const version = /\d+\.\d+\.\d+/.exec(run.stdout)?.[0];
  if (run.code !== 0 || !version) return { installed: true, problem: `Argent didn't say its version: ${lastLine(run)}` };
  if (compareVersions(version, MIN_VERSION) < 0) return { installed: true, version, problem: `Argent ${version} is too old: recording needs ${MIN_VERSION} or newer. Update it with: ${INSTALL}` };
  return { installed: true, version };
}

export interface Device {
  readonly id: string;
  readonly platform: string;
  readonly name: string;
  readonly state: string;
  readonly recordable: boolean;
  readonly reason?: string;
}

/** One entry of `argent run list-devices` as Uncut shows it, and whether it can be recorded. */
export function toDevice(raw: Json): Device | undefined {
  const platform = str(raw.platform) ?? "unknown";
  const id = str(raw.udid) ?? str(raw.serial) ?? str(raw.id);
  if (!id) return undefined;
  const state = str(raw.state) ?? "unknown";
  const name = str(raw.name) ?? str(raw.model) ?? str(raw.avdName) ?? str(raw.title) ?? id;
  const no = (reason: string): Device => ({ id, platform, name, state, recordable: false, reason });
  if (platform === "ios") {
    if (raw.kind === "device") return no("Physical iPhones can't be recorded yet");
    if (id.startsWith("remote:") || raw.remote === true) return no("Remote simulators can't be recorded yet");
    if (raw.runtimeKind === "tv" || /tvOS/i.test(String(raw.runtime ?? ""))) return no("tvOS simulators can't be recorded yet");
    if (state !== "Booted") return no("Not booted");
    return { id, platform, name, state, recordable: true };
  }
  if (platform === "android") {
    if (state !== "device") return no(state === "offline" ? "Offline" : state === "unauthorized" ? "Not authorised for USB debugging" : "Not ready");
    return { id, platform, name: str(raw.avdName)?.replace(/_/g, " ") ?? name, state, recordable: true };
  }
  if (platform === "chromium") return no(raw.electron === true || /electron/i.test(String(raw.browser ?? "")) ? "Electron apps can't be recorded yet" : "Chromium apps can't be recorded yet");
  if (platform === "vega") return no("Fire TV (Vega) can't be recorded yet");
  return no(`${platform} devices can't be recorded yet`);
}

async function listDevices(): Promise<{ argent: ArgentInfo; devices: ReadonlyArray<Device> }> {
  const argent = await argentInfo();
  if (!argent.installed || argent.problem) return { argent, devices: [] };
  const result = await argentTool("list-devices", {});
  const raw = Array.isArray(result.devices) ? (result.devices as Array<Json>) : [];
  return { argent, devices: raw.map(toDevice).filter((d): d is Device => !!d) };
}

async function recordableDevice(id: string): Promise<Device> {
  const { argent, devices } = await listDevices();
  if (!argent.installed) throw new Refusal(`Argent isn't installed, so nothing can be recorded. The user can install it with: ${INSTALL}`);
  if (argent.problem) throw new Refusal(argent.problem);
  const device = devices.find((d) => d.id === id);
  if (!device) throw new Refusal(`There's no device ${id}. argent_list_devices lists the ones Argent sees${devices.length ? `: ${devices.map((d) => d.id).join(", ")}` : " (none right now)"}.`);
  if (!device.recordable) throw new Refusal(`${device.name} (${device.id}) can't be recorded: ${device.reason}.`);
  return device;
}

// ---- recordings ----

interface Context {
  readonly projectDir?: string;
  readonly captureDir?: string;
  readonly flowsDir?: string;
}

const contextOf = (meta: unknown): Context => {
  const m = (meta && typeof meta === "object" ? meta : {}) as Json;
  return { projectDir: str(m["uncut/projectDir"]), captureDir: str(m["uncut/captureDir"]), flowsDir: str(m["uncut/flowsDir"]) };
};

interface Recording {
  readonly device: string;
  readonly startedAt: number;
  /** argent runs here (it saves the take under <scratch>/.argent/recordings). */
  readonly scratch: string;
  readonly captureDir: string;
  /** The device's name, for the file name. */
  readonly label: string;
  readonly name?: string;
  /** A stop was asked for (it stays listed until a stop worked). */
  stopping?: boolean;
  /** A stop call is running right now. */
  stopInFlight?: boolean;
}

/** Recordings running now, by device: one per device (Argent's own rule). */
const recordings = new Map<string, Recording>();

const safeName = (name: string) => name.replace(/\.mp4$/i, "").replace(/[^A-Za-z0-9 _.-]+/g, "-").replace(/^[-. ]+|[-. ]+$/g, "").slice(0, 80) || "recording";
const stamp = (at: Date) => at.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");

async function uniqueFile(dir: string, name: string) {
  for (let n = 1; ; n++) {
    const file = join(dir, `${name}${n > 1 ? `-${n}` : ""}.mp4`);
    if (!existsSync(file)) return file;
  }
}

/** A stop on its own: detached, so it finishes even when this process is killed right after. */
function detachedStop(device: string, cwd: string) {
  const bin = findArgent();
  if (!bin) return;
  try {
    spawn(bin, ["run", "screen-recording-stop", "--args", JSON.stringify({ udid: device }), "--json"], { cwd: existsSync(cwd) ? cwd : process.cwd(), env: argentEnv(), stdio: "ignore", detached: true }).unref();
  } catch {}
}

// Scratch folders older than a take can last (Argent's 600 s cap, plus a minute) are leftovers of a
// plugin that was killed: removed when the next take starts.
const STALE_SCRATCH_MS = (MAX_SECONDS + 60) * 1000;
async function sweepScratch(captureDir: string) {
  const live = new Set([...recordings.values()].map((r) => r.scratch));
  for (const name of await readdir(captureDir).catch(() => [] as Array<string>)) {
    if (!name.startsWith(".argent-take-")) continue;
    const dir = join(captureDir, name);
    if (live.has(dir)) continue;
    const s = await stat(dir).catch(() => undefined);
    if (s && Date.now() - s.mtimeMs > STALE_SCRATCH_MS) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function startRecording(device: Device, context: Context, options: { showTouches: boolean; limitSeconds: number; name?: string | undefined }, signal?: AbortSignal): Promise<Recording> {
  if (!context.captureDir) throw new Refusal("No project is open, so there's nowhere to save a recording. Open a project first.");
  if (recordings.has(device.id)) throw new Refusal(`${device.name} is already being recorded. Stop that recording first.`);
  await mkdir(context.captureDir, { recursive: true });
  await sweepScratch(context.captureDir);
  // A scratch folder with an .argent folder: argent saves a take under the nearest folder that has
  // one, so this keeps its file out of the user's own projects.
  const scratch = await mkdtemp(join(context.captureDir, ".argent-take-"));
  await mkdir(join(scratch, ".argent"), { recursive: true });
  const recording: Recording = { device: device.id, startedAt: Date.now(), scratch, captureDir: context.captureDir, label: device.name, ...(options.name ? { name: options.name } : {}) };
  recordings.set(device.id, recording);
  try {
    await argentTool("screen-recording-start", { udid: device.id, timeLimitSeconds: Math.max(1, Math.min(MAX_SECONDS, Math.ceil(options.limitSeconds))), trimStatic: false, showTouches: options.showTouches }, { cwd: scratch, ...(signal ? { signal } : {}) });
  } catch (error) {
    recordings.delete(device.id);
    // Cancelled (or it failed) while starting: it may have started anyway, so stop it.
    // (Its scratch folder stays: the stop runs and saves there; the next take's sweep removes it.)
    if (signal?.aborted) detachedStop(device.id, scratch);
    else await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  return recording;
}

interface Take {
  readonly path: string;
  readonly seconds: number;
  readonly bytes: number;
  readonly warning?: string;
}

/** Stops a device's recording and moves the take into the capture folder (or deletes it: discard). */
async function stopRecording(id: string, options: { discard?: boolean; name?: string | undefined } = {}): Promise<Take | undefined> {
  const recording = recordings.get(id);
  if (!recording) throw new Refusal(`${id} isn't being recorded.`);
  if (recording.stopping) throw new Refusal(`${id} is being stopped already.`);
  // Listed (as stopping) until a stop worked: a failed stop must not leave a recording running
  // that nothing knows about. Tried twice; then a detached stop is left to finish it.
  recording.stopping = true;
  let result: Json | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    recording.stopInFlight = true;
    try {
      result = await argentTool("screen-recording-stop", { udid: id }, { cwd: recording.scratch });
    } catch (error) {
      lastError = error;
    } finally {
      recording.stopInFlight = false;
    }
  }
  recordings.delete(id);
  if (!result) {
    detachedStop(id, recording.scratch);
    throw lastError;
  }
  try {
    const video = typeof result.video === "string" ? result.video : str((result.video as Json | undefined)?.path) ?? str((result.video as Json | undefined)?.hostPath);
    if (!video || !existsSync(video)) throw new Error(`argent didn't hand over the recording${result.warning ? ` (${String(result.warning)})` : ""}`);
    const inScratch = !relative(recording.scratch, video).startsWith("..");
    if (options.discard) {
      if (inScratch) await rm(video, { force: true });
      return undefined;
    }
    const name = safeName(options.name ?? recording.name ?? `${recording.label} ${stamp(new Date(recording.startedAt))}`);
    const file = await uniqueFile(recording.captureDir, name);
    // Its own take is moved; one argent saved elsewhere (the user's recordings.directory) is copied.
    if (inScratch) await rename(video, file).catch(async () => (await copyFile(video, file), await rm(video, { force: true })));
    else await copyFile(video, file);
    const bytes = (await stat(file)).size;
    const seconds = typeof result.durationMs === "number" ? Math.round(result.durationMs / 100) / 10 : Math.round((Date.now() - recording.startedAt) / 100) / 10;
    return { path: file, seconds, bytes, ...(str(result.warning) ? { warning: str(result.warning)! } : {}) };
  } finally {
    await rm(recording.scratch, { recursive: true, force: true });
  }
}

/**
 * On the way out (stdin closed, SIGTERM, a crash): every recording still running is stopped by a
 * detached argent of its own, so it finishes even though this process (and its group) is about to
 * be killed. Argent's own time limit is the last resort if even that can't run.
 */
function stopAllOnExit() {
  // A recording whose stop is running now is left to it (that call isn't killed below).
  for (const recording of recordings.values()) if (!recording.stopInFlight) detachedStop(recording.device, recording.scratch);
  recordings.clear();
  for (const [child, isStop] of running) {
    if (isStop) continue;
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}

// ---- flows ----

const isInside = (dir: string, file: string) => {
  const rel = relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * A flow by name (flows/<name>.yaml) or a path under the project's flows/ folder ("arg": what the
 * agent passes), or a media's stored source.flow ("stored": relative to the project, inside it).
 * Resolved with realpath, so a symlink can't lead out. Anything else is refused with a sentence.
 */
async function resolveFlow(flow: string, context: Context, origin: "arg" | "stored"): Promise<string> {
  const { projectDir, flowsDir } = context;
  if (!projectDir || !flowsDir) throw new Refusal("No project is open, so there are no flows to replay.");
  if (isAbsolute(flow) || flow.split(/[\\/]/).includes("..")) throw new Refusal(`The flow ${flow} has to be ${origin === "arg" ? "a saved flow's name or a path under the project's flows/ folder (flows/login.yaml); copy the flow there first" : "a path inside the project"}.`);
  let file: string;
  if (!flow.includes("/") && !/\.ya?ml$/i.test(flow)) file = join(flowsDir, `${flow}.yaml`);
  else if (origin === "arg" && !flow.startsWith("flows/")) throw new Refusal(`The flow ${flow} has to be a saved flow's name or a path under the project's flows/ folder (flows/login.yaml).`);
  else file = resolve(projectDir, flow);
  if (!/\.ya?ml$/i.test(file)) throw new Refusal(`The flow ${flow} isn't a .yaml file.`);
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    throw new Refusal(`There's no flow at ${relative(projectDir, file)}.`);
  }
  const root = await realpath(origin === "arg" ? flowsDir : projectDir).catch(() => undefined);
  if (!root || !isInside(root, real)) throw new Refusal(`The flow ${flow} leads outside the project's ${origin === "arg" ? "flows/ folder" : "folder"}, so it isn't replayed.`);
  return real;
}

/** Keeps the flow inside the project's flows/ (copied there when it's elsewhere) and returns its project-relative path. */
async function keepFlow(file: string, context: Context, saveAs: string | undefined): Promise<string | undefined> {
  if (!context.flowsDir || !context.projectDir) return undefined;
  await mkdir(context.flowsDir, { recursive: true });
  const [flowsDir, projectDir, real] = await Promise.all([realpath(context.flowsDir), realpath(context.projectDir), realpath(file)]);
  let kept = real;
  if (saveAs || !isInside(flowsDir, real)) {
    const name = (saveAs ?? basename(real)).replace(/\.ya?ml$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
    kept = join(flowsDir, `${name}.yaml`);
    if (kept !== real) {
      // Never write through a symlink someone left in flows/.
      const there = await lstat(kept).catch(() => undefined);
      if (there?.isSymbolicLink()) throw new Refusal(`flows/${name}.yaml is a symbolic link, so the flow isn't saved over it. Pick another name.`);
      await copyFile(real, kept);
    }
  }
  return relative(projectDir, kept);
}

async function runFlow(file: string, device: string, cwd: string, signal: AbortSignal): Promise<void> {
  const run = await runArgent(["flow", "run", file, "--device", device, "--json"], { cwd, timeoutMs: FLOW_TIMEOUT_MS, signal });
  if (run.aborted) throw new Error("cancelled");
  if (run.timedOut) throw new Error(`the flow didn't finish within ${FLOW_TIMEOUT_MS / 60000} minutes`);
  if (run.code !== 0) throw new Error(`the flow failed: ${lastLine(run)}`);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    if (signal.aborted) return fail(new Error("cancelled"));
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), fail(new Error("cancelled"))), { once: true });
  });

/**
 * One take: start the recording, play the flow or wait the seconds, stop it. The recording is
 * stopped whatever happens (a failed flow, a cancelled call); only a finished take is kept.
 */
async function recordTake(device: Device, context: Context, plan: { seconds?: number; flowFile?: string; showTouches: boolean; name?: string | undefined }, signal: AbortSignal): Promise<Take> {
  const recording = await startRecording(device, context, { showTouches: plan.showTouches, limitSeconds: plan.flowFile ? MAX_SECONDS : (plan.seconds ?? 0) + 5, name: plan.name }, signal);
  let failure: unknown;
  try {
    if (signal.aborted) throw new Error("cancelled");
    if (plan.flowFile) await runFlow(plan.flowFile, device.id, recording.scratch, signal);
    else await sleep((plan.seconds ?? 0) * 1000, signal);
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    // The flow's (or the cancel's) error is the one that counts; a failed stop is only added to it.
    const stopped = await stopRecording(device.id, { discard: true }).then(() => undefined, (error: unknown) => error);
    if (stopped && failure instanceof Error) failure.message += ` (and stopping the recording failed too: ${messageOf(stopped)}; it was asked to stop again in the background)`;
    throw failure;
  }
  return (await stopRecording(device.id, { name: plan.name }))!;
}

// ---- the tools ----

interface Call {
  readonly args: Json;
  readonly context: Context;
  readonly signal: AbortSignal;
}

type Result = { content: Array<Json>; structuredContent?: Json; isError?: boolean };
const text = (value: string, structured?: Json, isError = false): Result => ({
  content: [{ type: "text", text: value }],
  ...(structured ? { structuredContent: structured } : {}),
  ...(isError ? { isError: true } : {}),
});

const bool = (x: unknown, fallback: boolean) => (typeof x === "boolean" ? x : fallback);

async function listTool(): Promise<Result> {
  const { argent, devices } = await listDevices();
  const structured = { argent: { ...argent, install: INSTALL, minVersion: MIN_VERSION }, devices };
  if (!argent.installed) return text(`Argent isn't installed, so there are no devices to record. The user can install it with: ${INSTALL}`, structured, true);
  if (argent.problem) return text(argent.problem, structured, true);
  return text(JSON.stringify({ devices, note: devices.some((d) => d.recordable) ? "Record a device whose recordable is true with argent_record." : "Nothing can be recorded right now: boot an iOS simulator or Android emulator first (the user does that, or Argent's own tools)." }), structured);
}

function takeResult(take: Take, device: Device, flow: string | undefined, declare: Json): Result {
  const info = { path: take.path, seconds: take.seconds, bytes: take.bytes, device: device.id, ...(flow ? { flow } : {}), ...(take.warning ? { warning: take.warning } : {}) };
  return text(JSON.stringify(info), { ...info, uncut: declare });
}

async function recordTool({ args, context, signal }: Call): Promise<Result> {
  const deviceId = str(args.device);
  if (!deviceId) throw new Refusal("Pass device: an id from argent_list_devices.");
  const flowArg = str(args.flow);
  const seconds = typeof args.seconds === "number" ? args.seconds : undefined;
  if (flowArg && seconds !== undefined) throw new Refusal("Pass flow or seconds, not both: a flow's take lasts as long as the flow.");
  if (!flowArg && seconds === undefined) throw new Refusal("Pass flow (a saved flow to replay while recording) or seconds (how long to record).");
  if (seconds !== undefined && !(seconds > 0 && seconds <= MAX_SECONDS)) throw new Refusal(`seconds must be more than 0 and at most ${MAX_SECONDS}.`);
  const saveFlow = str(args.saveFlow);
  if (saveFlow && !flowArg) throw new Refusal("saveFlow names a copy of the flow you replay; pass flow too.");
  if (!context.captureDir) throw new Refusal("No project is open, so there's nowhere to save a recording.");
  const flowFile = flowArg ? await resolveFlow(flowArg, context, "arg") : undefined;
  const device = await recordableDevice(deviceId);
  const flow = flowFile ? await keepFlow(flowFile, context, saveFlow) : undefined;
  const take = await recordTake(device, context, { ...(seconds !== undefined ? { seconds } : {}), ...(flowFile ? { flowFile } : {}), showTouches: bool(args.showTouches, false), name: str(args.name) }, signal);
  const source = { module: MODULE_ID, device: device.id, ...(flow ? { flow } : {}) };
  return takeResult(take, device, flow, { media: { path: take.path, ...(str(args.name) ? { name: str(args.name) } : {}), source } });
}

async function reshootTool({ args, context, signal }: Call): Promise<Result> {
  const mediaId = str(args.mediaId);
  if (!mediaId) throw new Refusal("Pass mediaId: the media to re-shoot.");
  if (!context.projectDir || !context.captureDir) throw new Refusal("No project is open.");
  const project = JSON.parse(await readFile(join(context.projectDir, "project.json"), "utf8")) as { media?: Array<Json> };
  const media = project.media?.find((m) => m.id === mediaId);
  if (!media) throw new Refusal(`There's no media ${mediaId} in the project.`);
  const source = (media.source && typeof media.source === "object" ? media.source : {}) as Json;
  if (source.module !== MODULE_ID) throw new Refusal(`${mediaId} wasn't recorded with Argent, so it can't be re-shot. Record a new take with argent_record instead.`);
  const deviceId = str(source.device);
  if (!deviceId) throw new Refusal(`${mediaId} doesn't say which device it was recorded on.`);
  const flowArg = str(args.flow) ?? str(source.flow);
  if (!flowArg) throw new Refusal(`${mediaId} was recorded on a timer, not from a flow, so there's nothing to replay. Pass flow (a saved flow) to re-shoot it from one.`);
  const overrun = args.overrun === "hold" ? "hold" : "trim";
  const flowFile = await resolveFlow(flowArg, context, str(args.flow) ? "arg" : "stored");
  const device = await recordableDevice(deviceId);
  const flow = await keepFlow(flowFile, context, undefined);
  const name = safeName(`${String(media.name ?? mediaId).replace(/\.mp4$/i, "")} reshoot`);
  const take = await recordTake(device, context, { flowFile, showTouches: bool(args.showTouches, false), name }, signal);
  return takeResult(take, device, flow, { replace: { media: mediaId, path: take.path, overrun, source: { ...source, module: MODULE_ID, device: device.id, ...(flow ? { flow } : {}) } } });
}

// The Capture tab's Record and Stop (D98): not listed for the agent, called by Uncut itself.
async function captureStartTool({ args, context }: Call): Promise<Result> {
  const deviceId = str(args.device);
  if (!deviceId) throw new Refusal("Pass device.");
  const device = await recordableDevice(deviceId);
  const recording = await startRecording(device, context, { showTouches: bool(args.showTouches, false), limitSeconds: MAX_SECONDS });
  const info = { device: device.id, startedAt: new Date(recording.startedAt).toISOString(), limitSeconds: MAX_SECONDS };
  return text(JSON.stringify(info), info);
}
async function captureStopTool({ args }: Call): Promise<Result> {
  const deviceId = str(args.device);
  if (!deviceId) throw new Refusal("Pass device.");
  const take = (await stopRecording(deviceId))!;
  const info = { path: take.path, seconds: take.seconds, bytes: take.bytes, device: deviceId, ...(take.warning ? { warning: take.warning } : {}) };
  return text(JSON.stringify(info), { ...info, uncut: { media: { path: take.path, source: { module: MODULE_ID, device: deviceId } } } });
}

async function captureListTool(): Promise<Result> {
  const list = [...recordings.values()].map((r) => ({ device: r.device, startedAt: new Date(r.startedAt).toISOString() }));
  return text(JSON.stringify({ recording: list }), { recording: list });
}

const TOOLS: Record<string, (call: Call) => Promise<Result>> = {
  argent_list_devices: listTool,
  argent_record: recordTool,
  argent_reshoot: reshootTool,
  argent_capture_start: captureStartTool,
  argent_capture_stop: captureStopTool,
  argent_capture_list: captureListTool,
};

// ---- MCP over stdio ----

const send = (msg: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const inFlight = new Map<number | string, AbortController>();

async function onMessage(msg: Json) {
  const { id, method } = msg as { id?: number | string; method?: string };
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Json;
  if (method === "notifications/cancelled") {
    inFlight.get(params.requestId as number | string)?.abort();
    return;
  }
  if (method === "initialize") return send({ id, result: { protocolVersion: str(params.protocolVersion) ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "uncut-argent-capture", version: "0.1.0" } } });
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: [] } });
  if (method !== "tools/call") {
    if (id !== undefined && method !== undefined) send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
    return;
  }
  const name = String(params.name ?? "");
  const tool = TOOLS[name];
  if (!tool) return send({ id, result: text(`No tool ${name}`, undefined, true) });
  const abort = new AbortController();
  if (id !== undefined) inFlight.set(id, abort);
  let result: Result;
  try {
    result = await tool({ args: (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json, context: contextOf(params._meta), signal: abort.signal });
  } catch (error) {
    result = text(error instanceof Refusal ? error.message : `The recording didn't work: ${messageOf(error)}.`, undefined, true);
  } finally {
    if (id !== undefined) inFlight.delete(id);
  }
  // A cancelled call gets no answer (MCP): its recording was stopped and the take dropped.
  if (!abort.signal.aborted) send({ id, result });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && typeof msg === "object" && !Array.isArray(msg)) void onMessage(msg as Json);
  });
  const quit = (code: number) => {
    stopAllOnExit();
    process.exit(code);
  };
  // stdin closed: Uncut is done with us (MCP stdio). SIGTERM: Uncut is stopping.
  process.stdin.on("end", () => quit(0));
  process.on("SIGTERM", () => quit(0));
  process.on("SIGINT", () => quit(0));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`argent-capture: ${messageOf(error)}\n`);
    quit(1);
  });
}
