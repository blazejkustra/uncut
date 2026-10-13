// The plugin host (D97). A plugin is a folder with an uncut.module.json (the module manifest,
// spec/schema/module.schema.json) whose runtime is "process": a stdio MCP server Uncut starts on
// the first call to one of its tools. The manifest's agentTools are what the agent sees (listed
// before the process exists); a call is forwarded 1:1 as an MCP tools/call and its result passed
// back. Folders are searched in order (config.pluginDirs): UNCUT_PLUGINS_DIR, <dataDir>/plugins,
// then the app's own (Resources/plugins); the first plugin with an id wins.
//
// A process plugin runs with the user's rights, so a user plugin's tools are refused until the
// user allows it (settings.json pluginApprovals: that folder, those capabilities); plugins shipped
// with the app are allowed. Plugins return data; changes to the project go through the agent's
// timeline_edit, never by a plugin writing project.json.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PluginError, type PluginInfo } from "@uncut/contracts";
import { validateModule, type ModuleManifest } from "@uncut/core";
import { API_VERSION, API_VERSIONS } from "@uncut/plugin-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import type { McpResult } from "../agent/agent.ts";
import { TOOL_NAMES, type McpTool } from "../agent/agentTools.ts";
import { ServerConfig } from "../app/config.ts";
import { ProjectFormat } from "../project/format.ts";
import { Settings, type PluginApproval, type PluginInstall } from "../app/settings.ts";
import { which } from "../app/setup.ts";
import { pluginEnv } from "../app/shellEnv.ts";
import { besideServer } from "../paths.ts";
import { InstallError, installPlugin, isRemovable, removePluginFolder, sweepLeftovers } from "./install.ts";

export const MANIFEST_FILE = "uncut.module.json";
export const DEFAULT_TIMEOUT_S = 120;
const START_TIMEOUT_MS = 20_000;
const KILL_AFTER_MS = 500;
// A plugin that crashes again and again: wait a little longer before each restart, and stop
// trying for a while after this many crashes in a minute.
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 5;
const backoffMs = (recent: number) => (recent ? Math.min(8000, 250 * 2 ** (recent - 1)) : 0);
// One JSON-RPC line (a tool result with images) can be big, but not unbounded: a plugin that
// sends more without a newline is stopped.
export const MAX_LINE = 16 * 1024 * 1024;
// Images passed on to the agent (D97): these types, at most this many bytes decoded.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Claude's tool names: [A-Za-z0-9_-], at most 64 characters with the "mcp__uncut__" prefix.
const TOOL_NAME = /^[A-Za-z0-9_-]{1,52}$/;

export type PluginSource = "user" | "bundled";

/** How to start a process plugin. */
export interface ProcessSpec {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
}

export interface FoundPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | undefined;
  readonly kind: string;
  readonly source: PluginSource;
  readonly dir: string;
  readonly manifest: ModuleManifest;
  readonly capabilities: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<McpTool>;
  readonly warnings: ReadonlyArray<string>;
  readonly spec: ProcessSpec;
}

export interface BrokenPlugin {
  readonly source: PluginSource;
  readonly dir: string;
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly problem: string;
}

export interface Discovery {
  readonly plugins: ReadonlyArray<FoundPlugin>;
  readonly broken: ReadonlyArray<BrokenPlugin>;
}

const str = (x: unknown) => (typeof x === "string" ? x : undefined);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A plugin's parsed uncut.module.json, checked as discovery and install check it: a protocol
 * version this Uncut speaks (D102: missing means uncut.module/1; a newer one is refused before the
 * schema, whose fields it may not know), the module schema, a process plugin with a command, and
 * not a built-in module's id. Else one sentence (and the id and name, when it has them).
 */
export function checkManifest(raw: unknown, builtinIds: ReadonlySet<string>): { readonly manifest: ModuleManifest } | { readonly problem: string; readonly id: string | undefined; readonly name: string | undefined } {
  const loose = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fail = (problem: string, manifest?: { id?: unknown; name?: unknown }) => ({ problem, id: str((manifest ?? loose).id), name: str((manifest ?? loose).name) });
  const api = loose.apiVersion;
  if (typeof api === "string" && /^uncut\.module\/[0-9]+$/.test(api) && !API_VERSIONS.includes(api)) {
    return fail(`It's written for the plugin format ${api}, which is newer than this Uncut understands (${API_VERSION}). Update Uncut to use it.`);
  }
  const problems = validateModule(raw);
  if (problems.length) {
    const list = problems.slice(0, 3).map((p) => `${p.path} ${p.message}`).join("; ");
    return fail(`Its ${MANIFEST_FILE} doesn't match the module format: ${list}${problems.length > 3 ? `, and ${problems.length - 3} more` : ""}.`);
  }
  const manifest = raw as ModuleManifest;
  const runtime = manifest.runtime as { type: string; command?: string };
  if (runtime.type !== "process") return fail(`It's a "${runtime.type}" module; only "process" plugins run from a plugin folder for now.`);
  if (!runtime.command) return fail(`Its runtime has no command, so Uncut can't start it.`);
  if (builtinIds.has(manifest.id)) return fail(`Its id ${manifest.id} belongs to a built-in module.`);
  return { manifest };
}

/**
 * Every plugin folder under `roots`, in order: a subfolder with an uncut.module.json. A manifest
 * that isn't JSON, doesn't match the schema, isn't a process plugin, takes a built-in module's id
 * or an id found earlier is skipped and reported (never thrown). A tool whose name Uncut or an
 * earlier plugin already has is left out with a warning; the plugin's other tools stay.
 */
export async function discoverPlugins(
  roots: ReadonlyArray<{ readonly source: PluginSource; readonly dir: string }>,
  reserved: { readonly moduleIds: ReadonlySet<string>; readonly toolNames: ReadonlySet<string> },
): Promise<Discovery> {
  const plugins: Array<FoundPlugin> = [];
  const broken: Array<BrokenPlugin> = [];
  const seenRoots = new Set<string>();
  const byId = new Map<string, string>();
  const toolOwner = new Map<string, string>();
  for (const root of roots) {
    let rootDir: string;
    try {
      rootDir = await realpath(root.dir);
    } catch {
      continue; // a missing folder means no plugins there
    }
    if (seenRoots.has(rootDir)) continue;
    seenRoots.add(rootDir);
    let names: Array<string>;
    try {
      names = (await readdir(rootDir)).filter((n) => !n.startsWith(".")).sort();
    } catch (error) {
      broken.push({ source: root.source, dir: rootDir, id: undefined, name: undefined, problem: `Uncut can't read this plugin folder (${messageOf(error)}).` });
      continue;
    }
    for (const name of names) {
      let dir: string;
      try {
        dir = await realpath(join(rootDir, name));
        if (!(await stat(dir)).isDirectory()) continue;
      } catch {
        continue;
      }
      const file = join(dir, MANIFEST_FILE);
      if (!existsSync(file)) continue;
      const skip = (problem: string, id?: string, title?: string) => broken.push({ source: root.source, dir, id, name: title, problem });
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        skip(`Its ${MANIFEST_FILE} isn't valid JSON (${messageOf(error)}).`);
        continue;
      }
      const checked = checkManifest(raw, reserved.moduleIds);
      if ("problem" in checked) {
        skip(checked.problem, checked.id, checked.name);
        continue;
      }
      const manifest = checked.manifest;
      const runtime = manifest.runtime as { type: string; command?: string; args?: Array<string>; timeoutSeconds?: number };
      const earlier = byId.get(manifest.id);
      if (earlier) {
        skip(`Another plugin with the id ${manifest.id} comes first (${earlier}), so this one is skipped.`, manifest.id, manifest.name);
        continue;
      }
      byId.set(manifest.id, dir);
      const warnings: Array<string> = [];
      const tools: Array<McpTool> = [];
      const declared = (manifest.agentTools ?? []) as ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      for (const tool of declared) {
        if (!TOOL_NAME.test(tool.name)) {
          warnings.push(`Its tool ${tool.name.slice(0, 80)} is left out: a tool name can have at most 52 letters, digits, _ or -.`);
          continue;
        }
        if (!tool.inputSchema || tool.inputSchema.type !== "object") {
          warnings.push(`Its tool ${tool.name} is left out: its inputSchema must be an object schema ({"type":"object", ...}).`);
          continue;
        }
        const taken = reserved.toolNames.has(tool.name) ? "Uncut has a tool with that name" : toolOwner.has(tool.name) ? `the plugin ${toolOwner.get(tool.name)} has one with that name` : undefined;
        if (taken) {
          warnings.push(`Its tool ${tool.name} is left out: ${taken}.`);
          continue;
        }
        toolOwner.set(tool.name, manifest.id);
        tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      }
      // An analyzer is called by Uncut itself (the analysis queue, D100), not by the agent.
      if (!declared.length && manifest.kind !== "analyzer") warnings.push("It has no agent tools, so the agent can't use it.");
      plugins.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: str(manifest.description),
        kind: manifest.kind,
        source: root.source,
        dir,
        manifest,
        capabilities: (manifest.capabilities ?? []) as ReadonlyArray<string>,
        tools,
        warnings,
        spec: {
          id: manifest.id,
          name: manifest.name,
          dir,
          command: runtime.command!,
          args: runtime.args ?? [],
          timeoutMs: Math.round((runtime.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000),
        },
      });
    }
  }
  return { plugins, broken };
}

// ---- approval (D97) ----

const CAPABILITY_WORDS: Record<string, string> = {
  network: "use the network",
  "project:read": "read your project",
  "project:write": "suggest changes to your project",
  "media:read": "read your media files",
  "media:write": "add media files",
  "process:spawn": "start other programs",
  gpu: "use the graphics card",
  microphone: "use the microphone",
  screen: "record the screen",
  "api-key": "use an API key",
};

/** What allowing a plugin means, in plain sentences (shown before the user allows it). */
export function pluginAsks(plugin: Pick<FoundPlugin, "capabilities" | "source">): Array<string> {
  const asks = [
    plugin.source === "bundled"
      ? "It ships with Uncut and runs as a program on this Mac."
      : "It runs as a program on this Mac with your rights: it can do anything you can, including reading and changing your files. Allow it only if you trust where it came from.",
  ];
  const words = plugin.capabilities.map((c) => CAPABILITY_WORDS[c] ?? c);
  if (words.length) asks.push(`It says it will ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0]}.`);
  return asks;
}

/** Shipped with the app, or allowed by the user for this folder and at least these capabilities. */
export const isApproved = (plugin: Pick<FoundPlugin, "source" | "dir" | "capabilities" | "spec">, approval: PluginApproval | undefined) =>
  plugin.source === "bundled" ||
  (!!approval &&
    approval.dir === plugin.dir &&
    approval.command === plugin.spec.command &&
    JSON.stringify(approval.args) === JSON.stringify(plugin.spec.args) &&
    plugin.capabilities.every((c) => approval.capabilities.includes(c)));

export function pluginInfos(
  discovery: Discovery,
  approvals: Readonly<Record<string, PluginApproval>>,
  installs: Readonly<Record<string, PluginInstall>> = {},
  removable: ReadonlySet<string> = new Set(),
): Array<PluginInfo> {
  const originOf = (id: string | undefined, dir: string) => {
    const i = id ? installs[id] : undefined;
    return i && i.dir === dir ? { origin: { kind: i.kind, source: i.source, ...(i.ref ? { ref: i.ref } : {}), ...(i.commit ? { commit: i.commit } : {}) } } : {};
  };
  return [
    ...discovery.plugins.map((p): PluginInfo => ({
      id: p.id,
      name: p.name,
      version: p.version,
      ...(p.description ? { description: p.description } : {}),
      source: p.source,
      dir: p.dir,
      status: isApproved(p, approvals[p.id]) ? "ready" : "needs-approval",
      capabilities: [...p.capabilities],
      asks: pluginAsks(p),
      tools: p.tools.map((t) => t.name),
      warnings: [...p.warnings],
      ...originOf(p.id, p.dir),
      ...(removable.has(p.dir) ? { removable: true } : {}),
    })),
    ...discovery.broken.map((b): PluginInfo => ({
      id: b.id ?? b.dir.split("/").at(-1) ?? b.dir,
      name: b.name ?? b.dir.split("/").at(-1) ?? b.dir,
      source: b.source,
      dir: b.dir,
      status: "broken",
      capabilities: [],
      asks: [],
      tools: [],
      warnings: [],
      problem: b.problem,
      ...originOf(b.id, b.dir),
      ...(removable.has(b.dir) ? { removable: true } : {}),
    })),
  ];
}

// ---- one plugin process ----

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** MCP progress for this request (its progressToken is the request id). */
  readonly onProgress?: ((progress: number, total: number | undefined) => void) | undefined;
}

/** Thrown when a call ran out of time (the process is then stopped). */
export class PluginTimeout extends Error {}
/** Thrown when the agent turn ended before the call finished. */
export class PluginCancelled extends Error {}

/** The plugin SDK shipped with this Uncut (D102): Resources/plugin-sdk, or the repo's packages/plugin-sdk/src. */
export const DEFAULT_SDK_DIR = besideServer("../../../packages/plugin-sdk/src");

interface Command {
  readonly file: string;
  readonly env: Record<string, string>;
  /** Runtime flags before the plugin's own arguments. */
  readonly flags: ReadonlyArray<string>;
}

/**
 * Where `command` is: "node" is our own runtime, with the SDK's resolve hook so the plugin can
 * import "@uncut/plugin-sdk" (D102); a path is the plugin folder's; else PATH.
 */
async function resolveCommand(spec: ProcessSpec, sdkDir: string): Promise<Command> {
  if (spec.command === "node") {
    const register = join(sdkDir, "register.ts");
    if (!(await stat(register).then((s) => s.isFile(), () => false))) throw new Error(`Uncut's plugin SDK is missing at ${sdkDir}`);
    return { file: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}, flags: ["--import", pathToFileURL(join(sdkDir, "register.ts")).href] };
  }
  if (spec.command.includes("/")) {
    const outside = new Error(`its command ${spec.command} is outside its folder`);
    const isInside = (dir: string, file: string) => {
      const inside = relative(dir, file);
      return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
    };
    if (isAbsolute(spec.command) || !isInside(spec.dir, resolve(spec.dir, spec.command))) throw outside;
    // A symlink inside the folder that points out of it is outside too.
    let file: string;
    try {
      file = await realpath(resolve(spec.dir, spec.command));
    } catch {
      throw new Error(`its command ${spec.command} isn't in its folder`);
    }
    if (!isInside(await realpath(spec.dir), file)) throw outside;
    return { file, env: {}, flags: [] };
  }
  const found = await which(spec.command, process.env.PATH ?? "");
  if (!found) throw new Error(`${spec.command} isn't installed (not found on PATH)`);
  return { file: found, env: {}, flags: [] };
}

/** A running stdio MCP server: newline-delimited JSON-RPC 2.0 over its stdin/stdout. */
export class PluginProcess {
  readonly spec: ProcessSpec;
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stderr = "";
  private gone = false;
  /** Set when Uncut stopped it on purpose (a timeout, a stop): not a crash. */
  stoppedByUs = false;

  private constructor(spec: ProcessSpec, command: Command, live?: Set<PluginProcess>) {
    this.spec = spec;
    // Its own process group, so stopping it also stops whatever it started.
    this.child = spawn(command.file, [...command.flags, ...spec.args], { cwd: spec.dir, env: { ...pluginEnv(process.env), ...command.env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.exited = new Promise((done) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.gone) return;
        this.gone = true;
        live?.delete(this);
        // What it started may still run (its own process group): stop that too.
        try {
          if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
        } catch {}
        const why = this.stoppedByUs ? `${spec.name} was stopped` : `${spec.name} stopped (${signal ?? `exit code ${code}`})${this.lastError()}`;
        for (const p of this.pending.values()) p.reject(new Error(why));
        this.pending.clear();
        done({ code, signal });
      };
      this.child.once("exit", finish);
      this.child.once("error", (error) => {
        this.stderr += `\n${error.message}`;
        finish(null, null);
      });
    });
    this.child.stdin!.on("error", () => {});
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-4000)));
    live?.add(this);
    // Our own line reader (not readline): a running byte count, so a line that never ends
    // stops the plugin instead of filling memory.
    let parts: Array<Buffer> = [];
    let pending = 0;
    this.child.stdout!.on("data", (chunk: Buffer) => {
      let at = 0;
      for (let nl = chunk.indexOf(10, at); nl !== -1; nl = chunk.indexOf(10, at)) {
        parts.push(chunk.subarray(at, nl));
        const line = Buffer.concat(parts).toString("utf8");
        parts = [];
        pending = 0;
        at = nl + 1;
        this.onLine(line);
      }
      if (at < chunk.length) {
        parts.push(chunk.subarray(at));
        pending += chunk.length - at;
        if (pending > MAX_LINE) {
          parts = [];
          pending = 0;
          this.stderr += `\nit sent more than ${MAX_LINE / 1024 / 1024} MB in one message`;
          this.kill("SIGKILL", false);
        }
      }
    });
  }

  /** One line from the plugin. Never throws: whatever it sends, it can't take the server down. */
  private onLine(line: string) {
    try {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // a stray log line on stdout: not ours to read
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      const m = msg as { id?: unknown; result?: unknown; error?: unknown; method?: unknown };
      if (typeof m.method === "string") {
        // MCP progress for a call that asked for it (D100: a transcript's progress).
        if (m.method === "notifications/progress" && (m.id === undefined || m.id === null)) {
          const params = (msg as { params?: { progressToken?: unknown; progress?: unknown; total?: unknown } }).params;
          const p = typeof params?.progressToken === "number" ? this.pending.get(params.progressToken) : undefined;
          if (p?.onProgress && typeof params!.progress === "number" && Number.isFinite(params!.progress)) p.onProgress(params!.progress, typeof params!.total === "number" && params!.total > 0 ? params!.total : undefined);
          return;
        }
        // A request from the plugin: ping is answered, nothing else is offered. Notifications need no answer.
        if (m.id === undefined || m.id === null || (typeof m.id !== "number" && typeof m.id !== "string")) return;
        if (m.method === "ping") this.write({ id: m.id, result: {} });
        else this.write({ id: m.id, error: { code: -32601, message: `Uncut doesn't offer ${m.method.slice(0, 100)}` } });
        return;
      }
      if (typeof m.id !== "number") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error !== undefined && m.error !== null) {
        const message = typeof m.error === "object" && typeof (m.error as { message?: unknown }).message === "string" ? (m.error as { message: string }).message : JSON.stringify(m.error);
        p.reject(new Error(`${this.spec.name} answered with an error: ${message.slice(0, 2000)}`));
      } else p.resolve(m.result);
    } catch (error) {
      console.error(`[uncut] plugin ${this.spec.id}: ${messageOf(error)}`);
    }
  }

  /** Starts the plugin and does the MCP handshake; rejects with a sentence. */
  static async start(spec: ProcessSpec, live?: Set<PluginProcess>, sdkDir: string = DEFAULT_SDK_DIR): Promise<PluginProcess> {
    let command: Command;
    try {
      command = await resolveCommand(spec, sdkDir);
    } catch (error) {
      throw new Error(`Couldn't start ${spec.name}: ${messageOf(error)}.`);
    }
    const proc = new PluginProcess(spec, command, live);
    try {
      await proc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "uncut", version: "0.0.1" } }, START_TIMEOUT_MS);
      proc.notify("notifications/initialized");
      return proc;
    } catch (error) {
      proc.kill("SIGKILL");
      throw new Error(`Couldn't start ${spec.name}: ${error instanceof PluginTimeout ? `it didn't answer within ${START_TIMEOUT_MS / 1000} s` : messageOf(error)}.`);
    }
  }

  get pid() {
    return this.child.pid;
  }

  get alive() {
    return !this.gone;
  }

  private lastError() {
    const line = this.stderr.trim().split("\n").at(-1)?.trim();
    return line ? `: ${line.slice(0, 300)}` : "";
  }

  private write(msg: Record<string, unknown>) {
    if (this.gone || this.child.stdin!.destroyed) return;
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  }

  notify(method: string, params?: unknown) {
    if (this.alive) this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /**
   * One JSON-RPC request. Rejects with PluginTimeout after timeoutMs, or when `signal` aborts.
   * With `onProgress`, the request carries `_meta.progressToken` (its id) and the plugin's
   * notifications/progress for it are passed on.
   */
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal, onProgress?: (progress: number, total: number | undefined) => void): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`${this.spec.name} isn't running`));
    // A turn that ended before the call got here (during a cold start or a backoff wait).
    if (signal?.aborted) return Promise.reject(new PluginCancelled("The call was cancelled: the agent turn ended."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new PluginTimeout(`${this.spec.name} didn't answer within ${Math.round(timeoutMs / 100) / 10} s`));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        this.notify("notifications/cancelled", { requestId: id, reason: "The agent turn ended." });
        reject(new PluginCancelled("The call was cancelled: the agent turn ended."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => (cleanup(), resolve(value)),
        reject: (error) => (cleanup(), reject(error)),
        onProgress,
      });
      const withToken =
        onProgress && params && typeof params === "object" ? { ...(params as Record<string, unknown>), _meta: { ...((params as { _meta?: Record<string, unknown> })._meta ?? {}), progressToken: id } } : params;
      this.write({ id, method, ...(withToken === undefined ? {} : { params: withToken }) });
    });
  }

  /** Signals the whole process group (it may have started programs of its own). */
  kill(signal: NodeJS.Signals, byUs = true) {
    if (byUs) this.stoppedByUs = true;
    if (this.gone) return;
    try {
      if (this.child.pid) process.kill(-this.child.pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {}
    }
  }

  /** Close its stdin (MCP's "please exit"), then SIGTERM, then SIGKILL. */
  async stop() {
    this.stoppedByUs = true;
    if (this.gone) return;
    this.child.stdin!.end();
    this.kill("SIGTERM");
    const timer = setTimeout(() => this.kill("SIGKILL"), KILL_AFTER_MS);
    await this.exited;
    clearTimeout(timer);
  }
}

/** An MCP tools/call result as Uncut passes it on: text and images; anything else as JSON text. */
export function toMcpResult(raw: unknown): McpResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  const content: Array<McpResult["content"][number]> = [];
  for (const c of Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : []) {
    if (c?.type === "text" && typeof c.text === "string") content.push({ type: "text", text: c.text });
    else if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
      const bytes = Math.floor((c.data.length * 3) / 4);
      if (!IMAGE_TYPES.has(c.mimeType)) content.push({ type: "text", text: `(The plugin sent an image of type ${c.mimeType.slice(0, 60)}; only PNG, JPEG, GIF and WebP are passed on, so it was left out.)` });
      else if (bytes > MAX_IMAGE_BYTES) content.push({ type: "text", text: `(The plugin sent a ${Math.round(bytes / 1024 / 1024)} MB image; images over ${MAX_IMAGE_BYTES / 1024 / 1024} MB are left out.)` });
      else content.push({ type: "image", data: c.data, mimeType: c.mimeType });
    }
    else content.push({ type: "text", text: JSON.stringify(c) });
  }
  if (!content.length && r.structuredContent !== undefined) content.push({ type: "text", text: JSON.stringify(r.structuredContent) });
  if (!content.length) content.push({ type: "text", text: Array.isArray(r.content) ? "(The plugin returned nothing.)" : JSON.stringify(raw ?? null) });
  return { content, ...(r.isError === true ? { isError: true } : {}) };
}

const errorResult = (text: string): McpResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * A tool result as the host returns it: what the agent sees, plus what the plugin declared for
 * Uncut itself (D98): `structuredContent.uncut`, e.g. a recording to import ({ media }) or a file
 * to swap in ({ replace }). Uncut acts on it only for a plugin allowed to add media.
 */
export type PluginResult = McpResult & { readonly declared?: Record<string, unknown>; readonly structured?: unknown };

/** What Uncut tells a plugin about the call (D98), as MCP `_meta` on tools/call. */
export interface PluginContext {
  /** The open project's folder (plugins that read the project). */
  readonly "uncut/projectDir"?: string;
  /** Where a plugin that adds media writes its files: <project>/media/captures (D12). */
  readonly "uncut/captureDir"?: string;
  /** The project's saved flows (capture sources): <project>/flows. */
  readonly "uncut/flowsDir"?: string;
}

export const CAPTURE_DIR = join("media", "captures");
export const FLOWS_DIR = "flows";

/** The context a plugin gets for a project, by what it may do; the capture folder is created. */
export async function pluginContext(plugin: Pick<FoundPlugin, "capabilities" | "kind">, projectDir: string | undefined): Promise<PluginContext> {
  if (!projectDir) return {};
  const reads = plugin.capabilities.includes("project:read");
  const writes = plugin.capabilities.includes("media:write");
  const context: Record<string, string> = {};
  if (reads) context["uncut/projectDir"] = projectDir;
  if (writes) {
    const dir = join(projectDir, CAPTURE_DIR);
    await mkdir(dir, { recursive: true });
    context["uncut/captureDir"] = dir;
  }
  if (plugin.kind === "capture-source" && (reads || writes)) context["uncut/flowsDir"] = join(projectDir, FLOWS_DIR);
  return context;
}

/** The plugin's declaration for Uncut in a raw tools/call result, if any. */
const declaredOf = (raw: unknown): Record<string, unknown> | undefined => {
  const structured = (raw as { structuredContent?: unknown } | null)?.structuredContent;
  const uncut = structured && typeof structured === "object" ? (structured as { uncut?: unknown }).uncut : undefined;
  return uncut && typeof uncut === "object" && !Array.isArray(uncut) ? (uncut as Record<string, unknown>) : undefined;
};

/** Per call (Uncut's own calls, D100): its own time limit instead of the manifest's, and MCP progress. */
export interface CallExtra {
  readonly timeoutMs?: number | undefined;
  readonly onProgress?: ((progress: number, total: number | undefined) => void) | undefined;
}

interface Slot {
  spec: ProcessSpec;
  proc: PluginProcess | undefined;
  starting: Promise<PluginProcess> | undefined;
  crashes: Array<number>;
}

const sameSpec = (a: ProcessSpec, b: ProcessSpec) => a.dir === b.dir && a.command === b.command && a.args.join("\0") === b.args.join("\0");

/**
 * The plugin processes, by plugin id: started on the first call, restarted after a crash (with
 * a growing wait, and not at all for a while after MAX_CRASHES in a minute), stopped after a
 * call that times out, and all stopped with the server.
 */
export class PluginHost {
  private readonly slots = new Map<string, Slot>();
  // Every plugin process alive, also those still starting (for killAllNow).
  private readonly live = new Set<PluginProcess>();

  private readonly sdkDir: string;

  /** `sdkDir`: the folder with the plugin SDK's index.ts and register.ts (D102). */
  constructor(sdkDir: string = DEFAULT_SDK_DIR) {
    this.sdkDir = sdkDir;
  }

  /** The process of a running plugin (tests, diagnostics). */
  processOf(id: string) {
    const proc = this.slots.get(id)?.proc;
    return proc?.alive ? proc : undefined;
  }

  private ensure(slot: Slot): Promise<PluginProcess> {
    if (slot.proc?.alive) return Promise.resolve(slot.proc);
    if (slot.starting) return slot.starting;
    const now = Date.now();
    slot.crashes = slot.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (slot.crashes.length >= MAX_CRASHES) {
      return Promise.reject(new Error(`${slot.spec.name} stopped unexpectedly ${slot.crashes.length} times in the last minute, so Uncut isn't starting it again for now. Try again in a minute.`));
    }
    const wait = Math.max(0, backoffMs(slot.crashes.length) - (now - (slot.crashes.at(-1) ?? 0)));
    const spec = slot.spec;
    const starting = (async () => {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const proc = await PluginProcess.start(spec, this.live, this.sdkDir);
      void proc.exited.then(() => {
        if (!proc.stoppedByUs) slot.crashes.push(Date.now());
        if (slot.proc === proc) slot.proc = undefined;
      });
      return proc;
    })();
    slot.starting = starting;
    const settle = () => {
      if (slot.starting === starting) slot.starting = undefined;
    };
    starting.then(
      (proc) => {
        settle();
        // Stopped (or replaced) while it was starting: don't keep it.
        if (this.slots.get(spec.id) !== slot || !sameSpec(slot.spec, spec)) void proc.stop();
        else slot.proc = proc;
      },
      () => {
        settle();
        // A start that fails counts like a crash, so a broken plugin isn't started in a tight loop.
        slot.crashes.push(Date.now());
      },
    );
    return starting;
  }

  /**
   * Runs one tool of a plugin. Never rejects: a failure is a tool error the agent can read.
   * `allowed` is asked again once the process is up, right before the call (it may have been
   * revoked meanwhile); `signal` is the agent turn's.
   */
  async call(spec: ProcessSpec, tool: string, args: unknown, signal?: AbortSignal, allowed?: () => Promise<string | undefined>, context?: PluginContext, extra: CallExtra = {}): Promise<PluginResult> {
    let slot = this.slots.get(spec.id);
    if (slot && !sameSpec(slot.spec, spec)) {
      await this.stop(spec.id);
      slot = undefined;
    }
    if (!slot) {
      slot = { spec, proc: undefined, starting: undefined, crashes: [] };
      this.slots.set(spec.id, slot);
    }
    slot.spec = spec;
    let proc: PluginProcess;
    try {
      proc = await this.ensure(slot);
    } catch (error) {
      return errorResult(messageOf(error));
    }
    if (signal?.aborted) return errorResult("The call was cancelled: the agent turn ended.");
    const refusal = await allowed?.();
    if (refusal) return errorResult(refusal);
    try {
      const raw = await proc.request("tools/call", { name: tool, arguments: args ?? {}, ...(context && Object.keys(context).length ? { _meta: context } : {}) }, extra.timeoutMs ?? spec.timeoutMs, signal, extra.onProgress);
      const declared = declaredOf(raw);
      const structured = (raw as { structuredContent?: unknown } | null)?.structuredContent;
      return { ...toMcpResult(raw), ...(declared ? { declared } : {}), ...(structured !== undefined ? { structured } : {}) };
    } catch (error) {
      if (error instanceof PluginTimeout) {
        // A plugin that doesn't answer may be stuck: stop it; the next call starts it afresh.
        proc.kill("SIGKILL");
        return errorResult(`${error.message}, so Uncut stopped it. It starts again on the next call.`);
      }
      if (error instanceof PluginCancelled) return errorResult(error.message);
      return errorResult(`${messageOf(error)}.${proc.alive ? "" : " It starts again on the next call."}`);
    }
  }

  async stop(id: string) {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    const starting = slot.starting;
    await Promise.all([slot.proc?.stop(), starting?.then((p) => p.stop(), () => {})]);
  }

  /** Stops every plugin except those in `keep` (ids with the same spec). */
  async retain(keep: ReadonlyMap<string, ProcessSpec>) {
    await Promise.all([...this.slots].filter(([id, slot]) => !keep.has(id) || !sameSpec(keep.get(id)!, slot.spec)).map(([id]) => this.stop(id)));
  }

  stopAll() {
    return Promise.all([...this.slots.keys()].map((id) => this.stop(id))).then(() => {});
  }

  /** For process exit: SIGKILL every process group now, synchronously. */
  killAllNow() {
    for (const proc of this.live) proc.kill("SIGKILL");
  }
}

// ---- the service ----

export interface PluginsShape {
  /** Scans the plugin folders again (and stops plugins that went away or changed). */
  readonly refresh: Effect.Effect<void>;
  /** Every plugin found, with its status (after a fresh scan). */
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>;
  readonly approve: (input: { readonly id: string; readonly dir: string; readonly capabilities: ReadonlyArray<string> }) => Effect.Effect<ReadonlyArray<PluginInfo>, PluginError>;
  readonly revoke: (id: string) => Effect.Effect<ReadonlyArray<PluginInfo>, PluginError>;
  /** Installs a plugin from a folder or git URL into <dataDir>/plugins/<id> (D102); it needs allowing afterwards. */
  readonly install: (input: { readonly source: string; readonly ref?: string | undefined; readonly replaceBundled?: boolean | undefined }) => Effect.Effect<{ readonly id: string; readonly note?: string; readonly plugins: ReadonlyArray<PluginInfo> }, PluginError>;
  /** Stops and removes a plugin Uncut installed (one in <dataDir>/plugins), with its approval. */
  readonly uninstall: (id: string) => Effect.Effect<ReadonlyArray<PluginInfo>, PluginError>;
  /** The allowed plugins' agent tools, from the last scan. */
  readonly tools: Effect.Effect<ReadonlyArray<McpTool>>;
  /** The plugin that owns a tool name, from the last scan. */
  readonly owner: (tool: string) => { readonly id: string; readonly name: string } | undefined;
  /**
   * Runs a plugin's tool; undefined when no plugin has a tool by that name. `projectDir` is the
   * open project's folder, passed to the plugin as context (D98) by what it may do.
   */
  readonly call: (tool: string, args: unknown, turn?: AbortSignal, projectDir?: string) => Effect.Effect<(PluginResult & { readonly plugin: PluginCaller }) | undefined>;
  /**
   * Runs a tool of the plugin `id` for Uncut itself (the Capture tab): any tool the process serves,
   * also those it doesn't list for the agent. Refused (an error result) when it isn't allowed.
   */
  readonly callPlugin: (id: string, tool: string, args: unknown, options?: { readonly projectDir?: string | undefined; readonly signal?: AbortSignal | undefined } & CallExtra) => Effect.Effect<PluginResult & { readonly plugin: PluginCaller | undefined }>;
  /** modules_list entries for the plugins (D97). */
  readonly modules: (kind?: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>>;
  /** The running process of a plugin (tests). */
  readonly host: PluginHost;
}

/** Who answered a plugin call: what Uncut needs to decide what to do with its declaration. */
export interface PluginCaller {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly capabilities: ReadonlyArray<string>;
}

const callerOf = (p: FoundPlugin): PluginCaller => ({ id: p.id, name: p.name, kind: p.kind, capabilities: p.capabilities });

export class Plugins extends Context.Service<Plugins, PluginsShape>()("uncut/Plugins") {}

export const layer = Layer.effect(
  Plugins,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* Settings;
    const format = yield* ProjectFormat;
    const host = new PluginHost(config.pluginSdkDir);
    const reserved = { moduleIds: new Set(format.modules.keys()), toolNames: new Set<string>(TOOL_NAMES) };
    let discovery: Discovery = { plugins: [], broken: [] };
    const scanLock = yield* Semaphore.make(1);
    // Plugins being installed right now: their calls are refused until the new copy is in place.
    const installing = new Set<string>();
    const busy = (id: string) => (installing.has(id) ? `The plugin ${id} is being installed right now. Try again in a moment.` : undefined);
    // One install or removal at a time (they rename folders in <dataDir>/plugins).
    const installLock = yield* Semaphore.make(1);
    const reported = new Set<string>();

    const refresh = scanLock.withPermits(1)(
      Effect.gen(function* () {
        discovery = yield* Effect.promise(() => discoverPlugins(config.pluginDirs, reserved));
        const approvals = yield* settings.pluginApprovals;
        // Plugins that went away, changed how they start or lost their approval stop now.
        const keep = new Map(discovery.plugins.filter((p) => isApproved(p, approvals[p.id])).map((p) => [p.id, p.spec]));
        yield* Effect.promise(() => host.retain(keep));
        // stderr: stdout carries the ready line. Each problem once, not on every scan.
        for (const b of discovery.broken) {
          const line = `[uncut] plugin skipped (${b.dir}): ${b.problem}`;
          if (!reported.has(line)) console.error(line);
          reported.add(line);
        }
      }),
    );
    const userRoot = config.pluginDirs.find((r) => r.source === "user" && r.dir === join(config.dataDir, "plugins"))?.dir ?? join(config.dataDir, "plugins");
    const removableDirs = () =>
      Effect.promise(async () => {
        const dirs = [...discovery.plugins.filter((p) => p.source === "user").map((p) => p.dir), ...discovery.broken.filter((b) => b.source === "user").map((b) => b.dir)];
        const ok = await Promise.all(dirs.map((d) => isRemovable(userRoot, d)));
        return new Set(dirs.filter((_, i) => ok[i]));
      });
    const infos = Effect.gen(function* () {
      const approvals = yield* settings.pluginApprovals;
      const installs = yield* settings.pluginInstalls;
      return pluginInfos(discovery, approvals, installs, yield* removableDirs());
    });
    const list = Effect.andThen(refresh, infos);
    const find = (id: string) =>
      Effect.gen(function* () {
        yield* refresh;
        const plugin = discovery.plugins.find((p) => p.id === id);
        if (plugin) return plugin;
        if (discovery.broken.some((b) => b.id === id)) return yield* new PluginError({ reason: "broken", message: `The plugin ${id} can't be used: ${discovery.broken.find((b) => b.id === id)!.problem}` });
        return yield* new PluginError({ reason: "unknown-plugin", message: `There's no plugin ${id}.` });
      });

    const byTool = (tool: string) => discovery.plugins.find((p) => p.tools.some((t) => t.name === tool));

    // What an interrupted install or removal left behind (D102).
    yield* Effect.promise(() => sweepLeftovers(userRoot));
    yield* refresh;
    // Plugins stop with the server: on a normal shutdown (the finalizer) and on any exit that
    // skips it, synchronously. A plugin also exits when its stdin closes (the MCP stdio
    // contract), which covers a server that was killed outright.
    const killAll = () => host.killAllNow();
    process.on("exit", killAll);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => host.stopAll()).pipe(
        Effect.ensuring(Effect.sync(() => process.off("exit", killAll))),
      ),
    );

    const refusal = (plugin: FoundPlugin, approval: PluginApproval | undefined) =>
      isApproved(plugin, approval)
        ? undefined
        : `${plugin.name} (${plugin.id}) isn't allowed to run yet.${approval ? " It changed since the user allowed it (another folder or command, or it asks for more), so it needs allowing again." : ""} The user has to allow it first: Uncut > Settings…, the Capture step, Plugins, Allow. Ask them to, and say it runs as a program on their Mac with their rights. Don't retry until they have.`;

    return Plugins.of({
      host,
      refresh,
      list,
      approve: ({ id, dir, capabilities }) =>
        Effect.gen(function* () {
          const plugin = yield* find(id);
          // Only what the user was shown: the same folder, and nothing asked for beyond it.
          if (plugin.dir !== dir || plugin.capabilities.some((c) => !capabilities.includes(c))) {
            return yield* new PluginError({ reason: "changed", message: `${plugin.name} changed since it was shown (another folder, or it asks for more). Look at it again before allowing it.` });
          }
          if (plugin.source !== "bundled") {
            yield* settings
              .setPluginApproval(id, { dir: plugin.dir, version: plugin.version, command: plugin.spec.command, args: [...plugin.spec.args], capabilities: [...plugin.capabilities], approvedAt: new Date().toISOString() })
              .pipe(Effect.mapError((error) => new PluginError({ reason: "io", message: `Couldn't save that ${plugin.name} is allowed: ${error.message}` })));
          }
          return yield* infos;
        }),
      revoke: (id) =>
        Effect.gen(function* () {
          const plugin = yield* find(id);
          if (plugin.source === "bundled") return yield* new PluginError({ reason: "bundled", message: `${plugin.name} ships with Uncut and is always allowed.` });
          yield* settings
            .setPluginApproval(id, undefined)
            .pipe(Effect.mapError((error) => new PluginError({ reason: "io", message: `Couldn't save that ${plugin.name} is no longer allowed: ${error.message}` })));
          yield* Effect.promise(() => host.stop(id));
          return yield* infos;
        }),
      install: (input) =>
        installLock.withPermits(1)(Effect.gen(function* () {
          // The plugins that ship with Uncut, found on their own (a user plugin may shadow one).
          const shipped = yield* Effect.promise(() => discoverPlugins(config.pluginDirs.filter((r) => r.source === "bundled"), { moduleIds: reserved.moduleIds, toolNames: new Set() }));
          const bundled = new Map(shipped.plugins.map((p) => [p.id, p.name]));
          // Right before the new copy replaces the old (D102 review M1): no calls start it from now
          // on, its approval goes (a failed write aborts the install) and the old process stops.
          let swapping: string | undefined;
          const beforeSwap = async (id: string) => {
            swapping = id;
            installing.add(id);
            await Effect.runPromise(settings.setPluginApproval(id, undefined));
            await host.stop(id);
          };
          const installed = yield* Effect.tryPromise({
            try: () => installPlugin(input, { pluginsRoot: userRoot, builtinIds: reserved.moduleIds, bundled, git: () => which("git", process.env.PATH ?? ""), beforeSwap }),
            catch: (error) =>
              error instanceof InstallError
                ? new PluginError({ reason: error.reason, message: error.message })
                : new PluginError({ reason: "io", message: `Couldn't install it: ${messageOf(error)}` }),
          }).pipe(Effect.ensuring(Effect.sync(() => swapping && installing.delete(swapping))));
          // A new copy: the user allows it again (D97), whatever was allowed before.
          yield* settings
            .setPluginInstall(installed.id, { dir: installed.dir, source: installed.source, kind: installed.kind, ...(installed.ref ? { ref: installed.ref } : {}), ...(installed.commit ? { commit: installed.commit } : {}), installedAt: new Date().toISOString() })
            .pipe(Effect.mapError((error) => new PluginError({ reason: "io", message: `${installed.name} was copied, but Uncut couldn't record where it came from: ${error.message}` })));
          yield* refresh;
          const winner = discovery.plugins.find((p) => p.id === installed.id);
          const note = winner && winner.dir !== installed.dir ? `Another plugin with the id ${installed.id} comes first (${winner.dir}), so the one you installed isn't used until that one is removed.` : undefined;
          return { id: installed.id, ...(note ? { note } : {}), plugins: yield* infos };
        })),
      uninstall: (id) =>
        installLock.withPermits(1)(Effect.gen(function* () {
          yield* refresh;
          const dir = discovery.plugins.find((p) => p.id === id && p.source === "user")?.dir ?? discovery.broken.find((b) => b.id === id && b.source === "user")?.dir;
          if (!dir) {
            if (discovery.plugins.some((p) => p.id === id && p.source === "bundled")) return yield* new PluginError({ reason: "bundled", message: `That plugin ships with Uncut and can't be removed.` });
            return yield* new PluginError({ reason: "unknown-plugin", message: `There's no plugin ${id}.` });
          }
          if (!(yield* Effect.promise(() => isRemovable(userRoot, dir)))) {
            return yield* new PluginError({ reason: "not-removable", message: `Uncut didn't install that plugin (it's in ${dir}), so it doesn't remove it: delete the folder yourself.` });
          }
          yield* Effect.promise(() => host.stop(id));
          yield* Effect.tryPromise({ try: () => removePluginFolder(userRoot, dir), catch: (error) => new PluginError({ reason: "io", message: `Couldn't remove it: ${messageOf(error)}` }) });
          yield* settings.setPluginInstall(id, undefined).pipe(Effect.mapError((error) => new PluginError({ reason: "io", message: `It was removed, but Uncut couldn't update its settings: ${error.message}` })));
          yield* refresh;
          return yield* infos;
        })),
      // Only allowed plugins' tools reach the agent's list (D97): an unapproved plugin's manifest
      // text never gets into the prompt; modules_list says it's installed and waits for approval.
      tools: Effect.map(settings.pluginApprovals, (approvals) =>
        discovery.plugins.filter((p) => isApproved(p, approvals[p.id])).flatMap((p) => p.tools.map((t) => ({ ...t, description: `${t.description} (Plugin: ${p.name}.)` }))),
      ),
      owner: (tool) => {
        const p = byTool(tool);
        return p ? { id: p.id, name: p.name } : undefined;
      },
      call: (tool, args, turn, projectDir) =>
        Effect.gen(function* () {
          const plugin = byTool(tool);
          if (!plugin) return undefined;
          const installingNow = busy(plugin.id);
          if (installingNow) return { ...errorResult(installingNow), plugin: callerOf(plugin) };
          // Read now, so allowing it mid-turn counts at once.
          const refused = refusal(plugin, (yield* settings.pluginApprovals)[plugin.id]);
          if (refused) return { ...errorResult(refused), plugin: callerOf(plugin) };
          // ...and again once the process is up, in case it was revoked while it started.
          const allowed = () => Effect.runPromise(Effect.map(settings.pluginApprovals, (approvals) => busy(plugin.id) ?? refusal(plugin, approvals[plugin.id])));
          const context = yield* Effect.promise(() => pluginContext(plugin, projectDir).catch(() => ({})));
          const result = yield* Effect.promise((signal) => host.call(plugin.spec, tool, args, turn ? AbortSignal.any([signal, turn]) : signal, allowed, context));
          return { ...result, plugin: callerOf(plugin) };
        }),
      callPlugin: (id, tool, args, options = {}) =>
        Effect.gen(function* () {
          yield* refresh;
          const plugin = discovery.plugins.find((p) => p.id === id);
          if (!plugin) {
            const broken = discovery.broken.find((b) => b.id === id);
            return { ...errorResult(broken ? `The plugin ${id} can't be used: ${broken.problem}` : `There's no plugin ${id}.`), plugin: undefined };
          }
          const installingNow = busy(plugin.id);
          if (installingNow) return { ...errorResult(installingNow), plugin: callerOf(plugin) };
          const refused = refusal(plugin, (yield* settings.pluginApprovals)[plugin.id]);
          if (refused) return { ...errorResult(`${plugin.name} isn't allowed to run yet: allow it in Settings, the Capture step.`), plugin: callerOf(plugin) };
          const allowed = () => Effect.runPromise(Effect.map(settings.pluginApprovals, (approvals) => busy(plugin.id) ?? (refusal(plugin, approvals[plugin.id]) ? `${plugin.name} isn't allowed to run.` : undefined)));
          const context = yield* Effect.promise(() => pluginContext(plugin, options.projectDir).catch(() => ({})));
          const result = yield* Effect.promise((signal) => host.call(plugin.spec, tool, args, options.signal ? AbortSignal.any([signal, options.signal]) : signal, allowed, context, { timeoutMs: options.timeoutMs, onProgress: options.onProgress }));
          return { ...result, plugin: callerOf(plugin) };
        }),
      modules: (kind) =>
        Effect.map(settings.pluginApprovals, (approvals) => [
          ...discovery.plugins
            .filter((p) => !kind || p.kind === kind || kind === "plugin")
            .map((p) =>
              isApproved(p, approvals[p.id])
                ? {
                    id: p.id,
                    kind: p.kind,
                    name: p.name,
                    ...(p.description ? { description: p.description } : {}),
                    version: p.version,
                    source: p.source,
                    plugin: true,
                    approved: true,
                    capabilities: p.capabilities,
                    tools: p.tools.map((t) => t.name),
                    ...(p.warnings.length ? { warnings: p.warnings } : {}),
                  }
                : { id: p.id, kind: p.kind, name: p.name.slice(0, 80), source: p.source, plugin: true, approved: false, note: "Installed, but the user hasn't allowed it yet: its tools aren't available until they do (Uncut > Settings…, the Capture step, Plugins)." },
            ),
          ...(!kind || kind === "plugin"
            ? discovery.broken.map((b) => ({ id: (b.id ?? b.dir.split("/").at(-1))?.slice(0, 80), source: b.source, plugin: true, skipped: true, warnings: [b.problem.slice(0, 300)] }))
            : []),
        ]),
    });
  }),
);
