// App settings that outlive a session, in the data dir next to recents.json: whether onboarding
// has been finished or skipped, the speech model transcripts use (D68), and the plugins the user
// allowed to run (D97).
import { join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { writeFileAtomic } from "./atomicWrite.ts";
import { ServerConfig } from "./config.ts";

export interface SettingsShape {
  readonly onboarded: Effect.Effect<boolean>;
  readonly setOnboarded: Effect.Effect<void>;
  readonly whisperModel: Effect.Effect<string | undefined>;
  readonly setWhisperModel: (id: string) => Effect.Effect<void>;
  /** Plugins the user allowed (D97), by plugin id. */
  readonly pluginApprovals: Effect.Effect<Readonly<Record<string, PluginApproval>>>;
  /** Saves (or, with undefined, removes) one plugin's approval. */
  readonly setPluginApproval: (id: string, approval: PluginApproval | undefined) => Effect.Effect<void, Error>;
}

/** What the user allowed: that folder, with those capabilities (more later asks again). */
export interface PluginApproval {
  readonly dir: string;
  readonly version: string;
  // How it starts: another command or other arguments need allowing again.
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<string>;
  readonly approvedAt: string;
}

const isApproval = (x: unknown): x is PluginApproval => {
  const a = x as PluginApproval | null;
  return !!a && typeof a === "object" && typeof a.dir === "string" && typeof a.version === "string" && typeof a.command === "string" && Array.isArray(a.args) && a.args.every((x) => typeof x === "string") && Array.isArray(a.capabilities) && a.capabilities.every((c) => typeof c === "string") && typeof a.approvedAt === "string";
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
      pluginApprovals: Effect.map(read, approvalsOf),
      setPluginApproval: (id, approval) =>
        updateOrFail((settings) => {
          const approvals = approvalsOf(settings);
          if (approval) approvals[id] = approval;
          else delete approvals[id];
          return { pluginApprovals: approvals };
        }),
    });
  }),
);
