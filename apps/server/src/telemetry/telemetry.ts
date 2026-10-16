// Usage data and crash reports (issue #13, D223), the way Argent does it; opt-in (issue #103, D278).
//
// - Inert without a token: the token is put in at build time (UNCUT_TELEMETRY_TOKEN, the CI
//   secret, through esbuild's define); dev builds and forks have none, so nothing is constructed,
//   no id is made and nothing is sent.
// - Opt-in, checked on every track(): DO_NOT_TRACK, then UNCUT_TELEMETRY=0/false/no/off, then the
//   user's answer (the setup wizard's checkbox or Settings › App, settings.json "telemetry":
//   { "enabled": true }). Never answered is no: nothing is sent, not even app:start, and no id is
//   made. Saying yes sends this run's app:start then.
// - The id is a random UUID in the app's data (identity.ts), never derived from the machine.
// - Only catalogued events with allowlisted attributes (events.ts) leave the machine.
// - Never breaks the app: every call is wrapped, track() only queues, sending is batched and
//   bounded (client.ts), and nothing here delays startup or exit.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sanitize, type EventName, type EventProps, type Value } from "./events.ts";
import { createOtlpSink, type Sink, type SinkOptions } from "./client.ts";
import { crashFingerprint, errorNameOf } from "./fingerprint.ts";
import { loadOrCreateId } from "./identity.ts";
import { crashOf, takeSpooledCrashes } from "./spool.ts";

/** Uncut's telemetry proxy (infra/telemetry-proxy), in front of Grafana Cloud. */
export const ENDPOINT = "https://uncut-telemetry.blazejkustra.workers.dev/v1/logs";

declare const __UNCUT_TELEMETRY_TOKEN__: string | undefined;
const builtInToken = (): string => (typeof __UNCUT_TELEMETRY_TOKEN__ === "string" ? __UNCUT_TELEMETRY_TOKEN__ : "");

const MAX_PENDING = 100;
const MAX_CRASHES = 25;
const SPOOL_EVERY_MS = 60_000;

export type ConsentSource = "do-not-track" | "env" | "settings" | "default";
export interface TelemetryStatus {
  readonly enabled: boolean;
  readonly source: ConsentSource;
  /** This build has a token (and so would send anything at all). */
  readonly configured: boolean;
}

const OFF_WORDS = ["0", "false", "no", "off"];

/** Whether telemetry may send, and why. `choice` is the user's answer (undefined: never asked or never answered, which is no). */
export function consentOf(env: NodeJS.ProcessEnv, choice: boolean | undefined): { enabled: boolean; source: ConsentSource } {
  const dnt = (env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt && !OFF_WORDS.includes(dnt)) return { enabled: false, source: "do-not-track" };
  if (OFF_WORDS.includes((env.UNCUT_TELEMETRY ?? "").trim().toLowerCase())) return { enabled: false, source: "env" };
  if (choice === true) return { enabled: true, source: "settings" };
  return { enabled: false, source: choice === false ? "settings" : "default" };
}

const isLoopback = (url: string) => {
  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === "http:" || protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
};

/**
 * Where events go and with which token, or undefined (inert). Tests point UNCUT_TELEMETRY_ENDPOINT
 * at a local server with their own UNCUT_TELEMETRY_TOKEN; only a loopback URL is accepted, and only
 * with its own token, so neither a dev build nor a stray variable ever reaches the real endpoint.
 */
export function targetOf(env: NodeJS.ProcessEnv, token: string = builtInToken()): { endpoint: string; token: string } | undefined {
  const override = env.UNCUT_TELEMETRY_ENDPOINT;
  if (override) return isLoopback(override) && env.UNCUT_TELEMETRY_TOKEN ? { endpoint: override, token: env.UNCUT_TELEMETRY_TOKEN } : undefined;
  return token ? { endpoint: ENDPOINT, token } : undefined;
}

/** The Settings toggle as stored in settings.json (read directly: this runs before the Settings layer). */
export function storedChoice(dataDir: string): boolean | undefined {
  try {
    const enabled = (JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")) as { telemetry?: { enabled?: unknown } }).telemetry?.enabled;
    return typeof enabled === "boolean" ? enabled : undefined;
  } catch {
    return undefined;
  }
}

export interface TelemetryOptions {
  readonly dataDir: string;
  readonly version: string;
  readonly headless?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /** Tests: the built-in token, the sink's batch timing. */
  readonly token?: string;
  readonly sink?: Partial<Pick<SinkOptions, "scheduledDelayMillis" | "maxExportBatchSize">>;
}

interface State {
  readonly options: TelemetryOptions;
  readonly env: NodeJS.ProcessEnv;
  target: { endpoint: string; token: string } | undefined;
  readonly base: Record<string, Value>;
  choice: boolean | undefined;
  id: string | undefined;
  idLoading: Promise<void> | undefined;
  pending: Array<{ name: string; attributes: Record<string, Value> }>;
  sink: Sink | undefined;
  crashes: Set<string>;
  spoolTimer: ReturnType<typeof setInterval> | undefined;
}

let state: State | undefined;

const osOf = (): string => (["darwin", "linux", "win32"].includes(process.platform) ? process.platform : "other");
const archOf = (): string => (["arm64", "x64"].includes(process.arch) ? process.arch : "other");

/** Starts telemetry for this process. Never throws; without a token it only empties the crash spool. */
export function initTelemetry(options: TelemetryOptions): void {
  try {
    const env = options.env ?? process.env;
    const target = targetOf(env, options.token ?? builtInToken());
    state = {
      options,
      env,
      target,
      base: { session_id: randomUUID(), app_version: options.version, os: osOf(), arch: archOf(), runtime: process.versions.electron ? "electron" : "node" },
      choice: storedChoice(options.dataDir),
      id: undefined,
      idLoading: undefined,
      pending: [],
      sink: undefined,
      crashes: new Set(),
      spoolTimer: undefined,
    };
    track("app:start", { headless: options.headless === true });
    sendSpooled();
    state.spoolTimer = setInterval(sendSpooled, SPOOL_EVERY_MS);
    state.spoolTimer.unref();
  } catch {}
}

const enabledNow = (s: State) => s.target !== undefined && consentOf(s.env, s.choice).enabled;

function sendSpooled(): void {
  try {
    const s = state;
    if (!s) return;
    // Always taken (and so deleted), even when nothing may be sent.
    for (const crash of takeSpooledCrashes(s.options.dataDir)) track("app:crash", crash);
  } catch {}
}

function sinkOf(s: State): Sink | undefined {
  if (!s.sink && s.target) {
    try {
      s.sink = createOtlpSink({ endpoint: s.target.endpoint, token: s.target.token, version: s.options.version, ...s.options.sink });
    } catch {
      // The SDK refused to start: stay quiet for this run rather than retry on every event.
      s.target = undefined;
    }
  }
  return s.sink;
}

function flush(s: State): void {
  if (!s.id || !enabledNow(s)) return void (s.pending = []);
  const sink = sinkOf(s);
  const pending = s.pending;
  s.pending = [];
  for (const { name, attributes } of pending) sink?.emit(name, { ...attributes, distinct_id: s.id });
}

function loadId(s: State): void {
  if (s.id || s.idLoading) return;
  s.idLoading = loadOrCreateId(s.options.dataDir)
    .then((id) => {
      s.id = id;
      flush(s);
    })
    .catch(() => {})
    .finally(() => (s.idLoading = undefined));
}

/** Queues one event (dropped unless telemetry is on, the build has a token and it passes the allowlist). Never throws. */
export function track<N extends EventName>(name: N, props: EventProps<N> | Readonly<Record<string, unknown>> = {}): void {
  try {
    const s = state;
    if (!s || !enabledNow(s)) return;
    const attributes = sanitize(name, props, s.base);
    if (!attributes) return;
    if (!s.id) {
      if (s.pending.length < MAX_PENDING) s.pending.push({ name, attributes });
      return loadId(s);
    }
    sinkOf(s)?.emit(name, { ...attributes, distinct_id: s.id });
  } catch {}
}

/** A crash or uncaught error: its class name, err.code and stack fingerprint; each fingerprint once per run. */
export function trackCrash(process: string, error: unknown, fatal?: boolean): void {
  try {
    const crash = crashOf(process, error, fatal);
    noteCrash(crash as unknown as Record<string, unknown>);
  } catch {}
}

/** The renderer's uncaught error (telemetry.crash RPC): only its name and stack arrive, and only the fingerprint leaves. */
export function trackRendererCrash(name: string, stack: string | undefined): void {
  try {
    const errorName = errorNameOf({ name });
    noteCrash({ process: "renderer", error_name: errorName, crash_fingerprint: crashFingerprint(errorName, stack?.slice(0, 16_384)) });
  } catch {}
}

function noteCrash(crash: Record<string, unknown>) {
  const s = state;
  if (!s) return;
  const key = `${String(crash.process)}/${String(crash.crash_fingerprint ?? crash.error_name)}`;
  if (s.crashes.has(key) || s.crashes.size >= MAX_CRASHES) return;
  s.crashes.add(key);
  track("app:crash", crash);
}

/** The user answered (the wizard's checkbox or Settings › App; the caller has saved it). Yes sends this run's app:start; no drops whatever is queued. */
export function setTelemetryChoice(enabled: boolean): void {
  try {
    const s = state;
    if (!s) return;
    const was = enabledNow(s);
    s.choice = enabled;
    if (!enabled) s.pending = [];
    else if (!was) track("app:start", { headless: s.options.headless === true });
  } catch {}
}

export function telemetryStatus(): TelemetryStatus {
  const s = state;
  const consent = consentOf(s?.env ?? process.env, s?.choice);
  return { enabled: consent.enabled && s?.target !== undefined, source: consent.source, configured: s?.target !== undefined };
}

/** Sends what's queued, bounded (about 1.75 s at most). Never rejects. */
export async function shutdownTelemetry(): Promise<void> {
  const s = state;
  if (!s) return;
  try {
    if (s.spoolTimer) clearInterval(s.spoolTimer);
    await s.sink?.shutdown();
  } catch {}
}

/** Tests: forget this process's telemetry. */
export async function resetTelemetry(): Promise<void> {
  await shutdownTelemetry();
  state = undefined;
}
