// App settings that outlive a session, in the data dir next to recents.json. For now only
// whether onboarding has been finished or skipped.
import { join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { writeFileAtomic } from "./atomicWrite.ts";
import { ServerConfig } from "./config.ts";

export interface SettingsShape {
  readonly onboarded: Effect.Effect<boolean>;
  readonly setOnboarded: Effect.Effect<void>;
}

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
    return Settings.of({
      onboarded: Effect.map(read, (s) => s.onboarded === true),
      setOnboarded: Effect.gen(function* () {
        const settings = yield* read;
        yield* fs.makeDirectory(dataDir, { recursive: true });
        yield* writeFileAtomic(file, `${JSON.stringify({ ...settings, onboarded: true }, null, 2)}\n`);
      }).pipe(Effect.catch((error) => Effect.logWarning(`can't save settings: ${error.message}`))),
    });
  }),
);
