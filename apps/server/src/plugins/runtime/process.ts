import { type ChildProcess, spawn } from "node:child_process";
import { stat, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { which } from "../../app/setup.ts";
import { pluginEnv } from "../../app/shellEnv.ts";
import { besideServer } from "../../paths.ts";
import { type ProcessSpec, messageOf } from "../discovery/manifest.ts";

const START_TIMEOUT_MS = 20_000;
const KILL_AFTER_MS = 500;
// One JSON-RPC line (a tool result with images) can be big, but not unbounded: a plugin that
// sends more without a newline is stopped.
export const MAX_LINE = 16 * 1024 * 1024;

// ---- one plugin process ----

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** MCP progress for this request (its progressToken is the request id). */
  readonly onProgress?: ((progress: number, total: number | undefined, message?: string) => void) | undefined;
}

/**
 * Answers a request from a plugin (`uncut/fetch`, #107): resolves with the result, rejects with a
 * sentence; undefined when Uncut doesn't offer `method`.
 */
export type PluginRequestHandler = (pluginId: string, method: string, params: unknown) => Promise<unknown> | undefined;

/** The most requests from one plugin Uncut works on at once. */
const MAX_PLUGIN_REQUESTS = 8;

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
    if (
      !(await stat(register).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      throw new Error(`Uncut's plugin SDK is missing at ${sdkDir}`);
    return {
      file: process.execPath,
      env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      flags: ["--import", pathToFileURL(join(sdkDir, "register.ts")).href],
    };
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
  private readonly onRequest: PluginRequestHandler | undefined;
  private serving = 0;

  private constructor(spec: ProcessSpec, command: Command, live?: Set<PluginProcess>, onRequest?: PluginRequestHandler) {
    this.spec = spec;
    this.onRequest = onRequest;
    // Its own process group, so stopping it also stops whatever it started.
    this.child = spawn(command.file, [...command.flags, ...spec.args], {
      cwd: spec.dir,
      env: { ...pluginEnv(process.env), ...command.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
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
          const params = (msg as { params?: { progressToken?: unknown; progress?: unknown; total?: unknown; message?: unknown } }).params;
          const p = typeof params?.progressToken === "number" ? this.pending.get(params.progressToken) : undefined;
          // D280: the optional message (a step in words, e.g. Import from link's), at most 200 characters.
          const message = typeof params?.message === "string" && params.message.trim() ? params.message.trim().slice(0, 200) : undefined;
          if (p?.onProgress && typeof params!.progress === "number" && Number.isFinite(params!.progress))
            p.onProgress(params!.progress, typeof params!.total === "number" && params!.total > 0 ? params!.total : undefined, message);
          return;
        }
        // A request from the plugin: ping is answered, nothing else is offered. Notifications need no answer.
        if (m.id === undefined || m.id === null || (typeof m.id !== "number" && typeof m.id !== "string")) return;
        if (m.method === "ping") return this.write({ id: m.id, result: {} });
        const reqId = m.id;
        const answer = m.method.startsWith("uncut/") ? this.onRequest?.(this.spec.id, m.method, (msg as { params?: unknown }).params) : undefined;
        if (!answer) return this.write({ id: reqId, error: { code: -32601, message: `Uncut doesn't offer ${m.method.slice(0, 100)}` } });
        if (this.serving >= MAX_PLUGIN_REQUESTS) {
          answer.catch(() => {});
          return this.write({ id: reqId, error: { code: -32000, message: `Uncut works on at most ${MAX_PLUGIN_REQUESTS} requests from a plugin at once.` } });
        }
        this.serving++;
        answer
          .then(
            (result) => this.write({ id: reqId, result: result ?? {} }),
            (error) => this.write({ id: reqId, error: { code: -32000, message: messageOf(error).slice(0, 2000) } }),
          )
          .finally(() => this.serving--);
        return;
      }
      if (typeof m.id !== "number") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error !== undefined && m.error !== null) {
        const message =
          typeof m.error === "object" && typeof (m.error as { message?: unknown }).message === "string"
            ? (m.error as { message: string }).message
            : JSON.stringify(m.error);
        p.reject(new Error(`${this.spec.name} answered with an error: ${message.slice(0, 2000)}`));
      } else p.resolve(m.result);
    } catch (error) {
      console.error(`[uncut] plugin ${this.spec.id}: ${messageOf(error)}`);
    }
  }

  /** Starts the plugin and does the MCP handshake; rejects with a sentence. */
  static async start(spec: ProcessSpec, live?: Set<PluginProcess>, sdkDir: string = DEFAULT_SDK_DIR, onRequest?: PluginRequestHandler): Promise<PluginProcess> {
    let command: Command;
    try {
      command = await resolveCommand(spec, sdkDir);
    } catch (error) {
      throw new Error(`Couldn't start ${spec.name}: ${messageOf(error)}.`);
    }
    const proc = new PluginProcess(spec, command, live, onRequest);
    try {
      await proc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "uncut", version: "0.0.1" } }, START_TIMEOUT_MS);
      proc.notify("notifications/initialized");
      return proc;
    } catch (error) {
      proc.kill("SIGKILL");
      throw new Error(
        `Couldn't start ${spec.name}: ${error instanceof PluginTimeout ? `it didn't answer within ${START_TIMEOUT_MS / 1000} s` : messageOf(error)}.`,
      );
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
  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    onProgress?: (progress: number, total: number | undefined, message?: string) => void,
  ): Promise<unknown> {
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
        onProgress && params && typeof params === "object"
          ? { ...(params as Record<string, unknown>), _meta: { ...(params as { _meta?: Record<string, unknown> })._meta, progressToken: id } }
          : params;
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
