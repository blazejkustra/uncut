// The telemetry event catalog and its sanitizer (issue #13, D223): the last gate before anything
// leaves the machine. Every event is named here with the attributes it may carry, and each value
// must pass its validator (an enum, a bounded count, a boolean or a tight regex). Unknown events
// and unknown keys are dropped; nothing free-form (paths, file names, prompts, error messages,
// stacks) has a validator that would let it through.

export type Value = string | number | boolean;
type Validator = (value: unknown) => Value | undefined;

const oneOf =
  (...values: ReadonlyArray<string>): Validator =>
  (v) =>
    typeof v === "string" && values.includes(v) ? v : undefined;
/** A whole, non-negative number up to `max` (rounded). */
const count =
  (max: number): Validator =>
  (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : undefined;
const flag: Validator = (v) => (typeof v === "boolean" ? v : undefined);
const matching =
  (re: RegExp): Validator =>
  (v) =>
    typeof v === "string" && re.test(v) ? v : undefined;

const WEEK_MS = 7 * 24 * 3600 * 1000;
const durationMs = count(WEEK_MS);

/** An error's class name (TypeError, AbortError) or a fixed reason word (crashed, oom); never its message. */
export const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** 16 hex: SHA-256 over the de-identified top stack frames (fingerprint.ts). */
export const FINGERPRINT = /^[0-9a-f]{16}$/;

/** The export job's stage when it failed (runJob.ts). */
export const EXPORT_FAIL_CODES = ["no-ffmpeg", "measure", "missing-media", "rasterise", "shader", "loudness", "encode", "move", "unknown"] as const;
/** Why an agent turn failed, sorted from its error into a fixed word (agentFailCode). */
export const AGENT_FAIL_CODES = ["usage-limit", "rate-limit", "overloaded", "signed-out", "start", "connection", "busy", "other"] as const;
export const CRASH_PROCESSES = ["main", "renderer", "server", "gpu", "utility", "other"] as const;

/** Attributes every event carries (telemetry.ts adds them). */
export const BASE: Readonly<Record<string, Validator>> = {
  distinct_id: matching(/^[0-9a-f]{64}$/),
  session_id: matching(/^[0-9a-f-]{36}$/),
  app_version: matching(/^[0-9A-Za-z.+-]{1,40}$/),
  os: oneOf("darwin", "linux", "win32", "other"),
  arch: oneOf("arm64", "x64", "other"),
  runtime: oneOf("electron", "node"),
};

export const EVENTS = {
  /** Once per server start (desktop or headless). */
  "app:start": { headless: flag },
  /** A crash or an uncaught error in any process: what it was, never what it said. */
  "app:crash": {
    process: oneOf(...CRASH_PROCESSES),
    error_name: matching(ERROR_NAME),
    crash_fingerprint: matching(FINGERPRINT),
    // err.code (ENOENT, ERR_STREAM_DESTROYED) or a process exit code / signal.
    code: matching(/^[A-Za-z0-9_-]{1,40}$/),
    fatal: flag,
  },
  "export:complete": {
    duration_ms: durationMs,
    output_ms: count(24 * 3600 * 1000),
    quality: oneOf("draft", "standard", "high"),
    codec: oneOf("h264", "hevc"),
    encoder: oneOf("hardware", "software"),
    width: count(16384),
    height: count(16384),
    fps: count(240),
    range: flag,
    subtitles: flag,
  },
  "export:fail": { code: oneOf(...EXPORT_FAIL_CODES), duration_ms: durationMs },
  "export:cancel": { duration_ms: durationMs },
  "agent:turn": {
    outcome: oneOf("done", "error", "cancelled"),
    duration_ms: durationMs,
    edits: count(100_000),
    steps: count(100_000),
  },
  "agent:fail": { code: oneOf(...AGENT_FAIL_CODES) },
} as const satisfies Record<string, Record<string, Validator>>;

export type EventName = keyof typeof EVENTS;
type PropsOf<V extends Record<string, Validator>> = { readonly [K in keyof V]?: Value | undefined };
export type EventProps<N extends EventName> = PropsOf<(typeof EVENTS)[N]>;

export const isEventName = (name: unknown): name is EventName => typeof name === "string" && Object.hasOwn(EVENTS, name);

const clean = (validators: Readonly<Record<string, Validator>>, props: Readonly<Record<string, unknown>>, out: Record<string, Value>) => {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || !Object.hasOwn(validators, key)) continue;
    const ok = validators[key]!(value);
    if (ok !== undefined) out[key] = ok;
  }
};

/** The event's attributes that pass the allowlist; undefined for an event that isn't in the catalog. */
export function sanitize(name: string, props: Readonly<Record<string, unknown>> = {}, base: Readonly<Record<string, unknown>> = {}): Record<string, Value> | undefined {
  if (!isEventName(name)) return undefined;
  const out: Record<string, Value> = {};
  clean(BASE, base, out);
  clean(EVENTS[name], props, out);
  return out;
}

/** An agent turn's error, as one of AGENT_FAIL_CODES (the words come from agentLimits.ts / spawn.ts). */
export function agentFailCode(error: string | undefined): (typeof AGENT_FAIL_CODES)[number] {
  const e = error ?? "";
  if (/usage limit/i.test(e)) return "usage-limit";
  if (/overloaded|\b529\b/i.test(e)) return "overloaded";
  if (/rate limit|\b429\b/i.test(e)) return "rate-limit";
  if (/signed in|log ?in|invalid api key/i.test(e)) return "signed-out";
  if (/couldn't start/i.test(e)) return "start";
  if (/couldn't reach/i.test(e)) return "connection";
  if (/still on the last message/i.test(e)) return "busy";
  return "other";
}
