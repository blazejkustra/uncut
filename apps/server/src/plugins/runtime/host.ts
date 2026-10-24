import { type ProcessSpec, messageOf } from "../discovery/manifest.ts";
import { PluginProcess, DEFAULT_SDK_DIR, PluginTimeout, PluginCancelled, type PluginRequestHandler } from "./process.ts";
import { type PluginContext, type PluginResult, errorResult, declaredOf, toMcpResult } from "./result.ts";

// A plugin that crashes again and again: wait a little longer before each restart, and stop
// trying for a while after this many crashes in a minute.
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 5;
const backoffMs = (recent: number) => (recent ? Math.min(8000, 250 * 2 ** (recent - 1)) : 0);

/** Per call (Uncut's own calls, D100): its own time limit instead of the manifest's, and MCP progress. */
export interface CallExtra {
  readonly timeoutMs?: number | undefined;
  readonly onProgress?: ((progress: number, total: number | undefined, message?: string) => void) | undefined;
  /** More of the call's context (a generator's grant, #107). */
  readonly meta?: PluginContext | undefined;
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
  private onRequest: PluginRequestHandler | undefined;

  /** `sdkDir`: the folder with the plugin SDK's index.ts and register.ts (D102). */
  constructor(sdkDir: string = DEFAULT_SDK_DIR) {
    this.sdkDir = sdkDir;
  }

  /** Who answers the plugins' own requests (uncut/fetch, #107); processes started from now on. */
  serveRequests(handler: PluginRequestHandler) {
    this.onRequest = handler;
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
      const proc = await PluginProcess.start(spec, this.live, this.sdkDir, (id, method, params) => this.onRequest?.(id, method, params));
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
      const meta = { ...context, ...extra.meta };
      const raw = await proc.request("tools/call", { name: tool, arguments: args ?? {}, ...(Object.keys(meta).length ? { _meta: meta } : {}) }, extra.timeoutMs ?? spec.timeoutMs, signal, extra.onProgress);
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
