// App settings that outlive a session, in the data dir next to recents.json: whether onboarding
// has been finished or skipped, the speech model transcripts use (D68), and the plugins the user
// allowed to run (D97) and where installed plugins came from (D102).
import { join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { writeFileAtomic } from "../project/atomicWrite.ts";
import { ServerConfig } from "./config.ts";

export interface SettingsShape {
  readonly onboarded: Effect.Effect<boolean>;
  readonly setOnboarded: Effect.Effect<void>;
  readonly whisperModel: Effect.Effect<string | undefined>;
  readonly setWhisperModel: (id: string) => Effect.Effect<void>;
  /** The usage-data answer (D223, opt-in since D278; never answered = no): "telemetry": { "enabled": boolean }. */
  readonly setTelemetryEnabled: (enabled: boolean) => Effect.Effect<void>;
  /** Plugins the user allowed (D97), by plugin id. */
  readonly pluginApprovals: Effect.Effect<Readonly<Record<string, PluginApproval>>>;
  /** Saves (or, with undefined, removes) one plugin's approval. */
  readonly setPluginApproval: (id: string, approval: PluginApproval | undefined) => Effect.Effect<void, Error>;
  /** Where the plugins Uncut installed came from (D102), by plugin id. */
  readonly pluginInstalls: Effect.Effect<Readonly<Record<string, PluginInstall>>>;
  /** Records (or, with undefined, forgets) one installed plugin; its approval is removed in the same write. */
  readonly setPluginInstall: (id: string, install: PluginInstall | undefined) => Effect.Effect<void, Error>;
}

/** An installed plugin's origin (D102): a folder, or a git URL with the ref asked for and the commit cloned. */
export interface PluginInstall {
  readonly dir: string;
  readonly source: string;
  // "catalog": enabled from the plugins that ship with Uncut but aren't on by default (D103).
  readonly kind: "folder" | "git" | "catalog";
  readonly ref?: string;
  readonly commit?: string;
  readonly installedAt: string;
}

const isInstall = (x: unknown): x is PluginInstall => {
  const a = x as PluginInstall | null;
  return !!a && typeof a === "object" && typeof a.dir === "string" && typeof a.source === "string" && (a.kind === "folder" || a.kind === "git" || a.kind === "catalog") && (a.ref === undefined || typeof a.ref === "string") && (a.commit === undefined || typeof a.commit === "string") && typeof a.installedAt === "string";
};

const installsOf = (settings: Record<string, unknown>): Record<string, PluginInstall> => {
  const raw = settings.pluginInstalls;
  const out: Record<string, PluginInstall> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) if (isInstall(value) && id !== "__proto__") out[id] = value;
  return out;
};

/** What the user allowed: that folder, with those capabilities (more later asks again). */
export interface PluginApproval {
  readonly dir: string;
  readonly version: string;
  // How it starts: another command or other arguments need allowing again.
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<string>;
  // D248: a hash of the skills it had (infos skillsHash): other skills need allowing again.
  readonly skills?: string;
  readonly approvedAt: string;
}

const isApproval = (x: unknown): x is PluginApproval => {
  const a = x as PluginApproval | null;
  return !!a && typeof a === "object" && typeof a.dir === "string" && typeof a.version === "string" && typeof a.command === "string" && Array.isArray(a.args) && a.args.every((x) => typeof x === "string") && Array.isArray(a.capabilities) && a.capabilities.every((c) => typeof c === "string") && (a.skills === undefined || typeof a.skills === "string") && typeof a.approvedAt === "string";
};

const approvalsOf = (settings: Record<string, unknown>): Record<string, PluginApproval> => {
  const raw = settings.pluginApprovals;
  const out: Record<string, PluginApproval> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) if (isApproval(value) && id !== "__proto__") out[id] = value;
  return out;
};

export class Settings extends Context.Service<Settings, SettingsShape>()("uncut/Settings") {}

export const layer = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const { dataDir } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const file = join(dataDir, "settings.json");
    // Missing or unreadable means defaults: onboarding shows again, nothing worse.
    const read = fs.readFileString(file).pipe(
      Effect.map((text) => JSON.parse(text) as Record<string, unknown>),
      Effect.catch(() => Effect.succeed<Record<string, unknown>>({})),
      Effect.catchDefect(() => Effect.succeed<Record<string, unknown>>({})),
    );
    // One write at a time: each reads the file and writes it back, so two at once could drop one's change.
    const writeLock = yield* Semaphore.make(1);
    // The patch is worked out from the settings as read under the lock (approvals are one object).
    // A failure is the caller's to handle (an approval must not look saved when it isn't).
    const updateOrFail = (patchOf: (settings: Record<string, unknown>) => Record<string, unknown>) =>
      writeLock.withPermits(1)(Effect.gen(function* () {
        const settings = yield* read;
        yield* fs.makeDirectory(dataDir, { recursive: true });
        yield* writeFileAtomic(file, `${JSON.stringify({ ...settings, ...patchOf(settings) }, null, 2)}\n`);
      })).pipe(Effect.mapError((error) => new Error(error.message)));
    const updateWith = (patchOf: (settings: Record<string, unknown>) => Record<string, unknown>) =>
      updateOrFail(patchOf).pipe(Effect.catch((error) => Effect.logWarning(`can't save settings: ${error.message}`)));
    const update = (patch: Record<string, unknown>) => updateWith(() => patch);
    return Settings.of({
      onboarded: Effect.map(read, (s) => s.onboarded === true),
      setOnboarded: update({ onboarded: true }),
      whisperModel: Effect.map(read, (s) => (typeof s.whisperModel === "string" ? s.whisperModel : undefined)),
      setWhisperModel: (id) => update({ whisperModel: id }),
      setTelemetryEnabled: (enabled) => update({ telemetry: { enabled } }),
      pluginApprovals: Effect.map(read, approvalsOf),
      setPluginApproval: (id, approval) =>
        updateOrFail((settings) => {
          const approvals = approvalsOf(settings);
          if (approval) approvals[id] = approval;
          else delete approvals[id];
          return { pluginApprovals: approvals };
        }),
      pluginInstalls: Effect.map(read, installsOf),
      setPluginInstall: (id, install) =>
        updateOrFail((settings) => {
          const installs = installsOf(settings);
          const approvals = approvalsOf(settings);
          if (install) installs[id] = install;
          else delete installs[id];
          // Installed (or reinstalled) or removed: allowing it again is the user's call (D97).
          delete approvals[id];
          return { pluginInstalls: installs, pluginApprovals: approvals };
        }),
    });
  }),
);
