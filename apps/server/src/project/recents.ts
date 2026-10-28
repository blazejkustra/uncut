// Recently opened projects, newest first, persisted as JSON in the app's data dir. Every window's
// server shares it: each change re-reads it holding recents.json.lock, so none drops another's entry.
import { join } from "node:path";

import type { RecentProject } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { writeFileAtomic } from "./atomicWrite.ts";
import { withFileLock } from "./fileLock.ts";
import { ServerConfig } from "../app/config.ts";

const MAX_RECENTS = 20;

export interface RecentsShape {
  /** Recent projects whose project.json still exists. Drops (and forgets) the rest. */
  readonly list: Effect.Effect<ReadonlyArray<RecentProject>>;
  readonly touch: (dir: string, name: string) => Effect.Effect<void>;
}

export class Recents extends Context.Service<Recents, RecentsShape>()("uncut/Recents") {}

const isRecent = (value: unknown): value is RecentProject =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as RecentProject).dir === "string" &&
  typeof (value as RecentProject).name === "string" &&
  typeof (value as RecentProject).openedAt === "string";

export const layer = Layer.effect(
  Recents,
  Effect.gen(function* () {
    const { dataDir } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const file = join(dataDir, "recents.json");
    const semaphore = yield* Semaphore.make(1);
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => semaphore.withPermits(1)(withFileLock(file, effect));

    // A missing or corrupt file just means no recents; it is a convenience, not data.
    const read = fs.readFileString(file).pipe(
      Effect.map((text) => {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.filter(isRecent) : [];
      }),
      Effect.catch(() => Effect.succeed<Array<RecentProject>>([])),
      Effect.catchDefect(() => Effect.succeed<Array<RecentProject>>([])),
    );
    const write = (entries: ReadonlyArray<RecentProject>) =>
      fs.makeDirectory(dataDir, { recursive: true }).pipe(
        Effect.andThen(writeFileAtomic(file, `${JSON.stringify(entries, null, 2)}\n`)),
        Effect.catch((error) => Effect.logWarning(`can't save recents: ${error.message}`)),
      );

    return Recents.of({
      list: locked(
        Effect.gen(function* () {
          const entries = yield* read;
          const kept: Array<RecentProject> = [];
          for (const entry of entries) {
            if (yield* fs.exists(join(entry.dir, "project.json")).pipe(Effect.orElseSucceed(() => false))) kept.push(entry);
          }
          if (kept.length !== entries.length) yield* write(kept);
          return kept;
        }),
      ),
      touch: (rawDir, name) =>
        locked(
          Effect.gen(function* () {
            // One entry per folder, however it was reached (symlinks, /var vs /private/var).
            const real = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
            const dir = yield* real(rawDir);
            const entries: Array<RecentProject> = [];
            for (const entry of yield* read) if ((yield* real(entry.dir)) !== dir) entries.push(entry);
            yield* write([{ dir, name, openedAt: new Date().toISOString() }, ...entries].slice(0, MAX_RECENTS));
          }),
        ),
    });
  }),
);
