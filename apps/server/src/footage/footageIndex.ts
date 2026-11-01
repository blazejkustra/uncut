// The footage index as a server service: the status stream, and the indexer fed by the open project
// and the analysis queue.
import { mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { FootageHit, FootageStatus } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Analysis } from "../analysis/analysis.ts";
import { ServerConfig } from "../app/config.ts";
import { Projects } from "../project/projects.ts";
import { Recents } from "../project/recents.ts";
import { FootageStore, type Place, type VisualNote } from "./footageStore.ts";
import { FootageIndexer, projectMedia } from "./indexer.ts";

/** media_search and the Media panel show at most this many moments. */
export const MAX_FOOTAGE_HITS = 30;

export const footageFile = (dataDir: string) => join(dataDir, "footage-index.db");
export const thumbFolder = (dataDir: string) => join(dataDir, "footage-index", "thumbs");

/** Removes the thumbnails of clips that left the index. */
async function sweepThumbs(folder: string, store: FootageStore) {
  const names = await readdir(folder).catch(() => [] as Array<string>);
  const orphans = names.filter((name) => store.places(name.split("-")[0]!).length === 0);
  await Promise.all(orphans.map((name) => rm(join(folder, name), { force: true })));
}

export interface FootageIndexShape {
  readonly status: Stream.Stream<FootageStatus>;
  readonly current: Effect.Effect<FootageStatus>;
  readonly start: Effect.Effect<void>;
  readonly cancel: Effect.Effect<void>;
  readonly search: (options: { readonly query: string; readonly thisProject: boolean; readonly limit: number }) => Effect.Effect<ReadonlyArray<FootageHit>>;
  readonly describe: (path: string, notes: ReadonlyArray<VisualNote>) => Effect.Effect<void, Error>;
  /** The places of a clip, for its thumbnails. */
  readonly places: (fingerprint: string) => ReadonlyArray<Place>;
}

export class FootageIndex extends Context.Service<FootageIndex, FootageIndexShape>()("uncut/FootageIndex") {}

export const layer = Layer.effect(
  FootageIndex,
  Effect.gen(function* () {
    const { dataDir } = yield* ServerConfig;
    const projects = yield* Projects;
    const recents = yield* Recents;
    const analysis = yield* Analysis;
    mkdirSync(dataDir, { recursive: true });
    const store = new FootageStore(footageFile(dataDir));
    const open = () => {
      const current = Effect.runSync(projects.current);
      return current ? projectMedia(current.project, current.dir, "") : undefined;
    };
    const indexer = new FootageIndexer({
      store,
      open,
      recentDirs: () => Effect.runPromise(recents.list),
      request: (target) => analysis.request(target, "transcript"),
      cancelJob: (jobId) => Effect.runSync(analysis.cancel(jobId)),
      onStatus: (status) => Effect.runSync(SubscriptionRef.set(statusRef, status)),
      afterPrune: () => sweepThumbs(thumbFolder(dataDir), store),
    });
    const statusRef = yield* SubscriptionRef.make(indexer.status());
    yield* Effect.addFinalizer(() => Effect.promise(() => indexer.close().then(() => store.close())));
    yield* Effect.forkScoped(Stream.runForEach(projects.changes, () => Effect.sync(() => indexer.projectChanged())));
    yield* Effect.forkScoped(Stream.runForEach(analysis.jobs, (jobs) => Effect.sync(() => indexer.onJobs(jobs))));
    indexer.schedule();
    return FootageIndex.of({
      status: SubscriptionRef.changes(statusRef),
      current: Effect.sync(() => indexer.status()),
      start: Effect.sync(() => indexer.start()),
      cancel: Effect.sync(() => indexer.cancel()),
      search: (options) => Effect.promise(() => indexer.search(options)),
      describe: (path, notes) => Effect.tryPromise({ try: () => indexer.describe(path, notes), catch: (error) => error as Error }),
      places: (fingerprint) => store.places(fingerprint),
    });
  }),
);
