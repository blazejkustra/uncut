// The background indexing: cached transcripts come in for free, a run goes clip by clip with
// progress, cancel stops it and keeps what's done, and started projects pick up new media.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalysisJob, FootageStatus } from "../../packages/contracts/src/index.ts";

import { fingerprint, writeCached, type AnalysisTarget, type Outcome, type Requested } from "../../apps/server/src/analysis/analysis.ts";
import type { TranscriptResult } from "../../apps/server/src/analysis/transcription.ts";
import { FootageStore } from "../../apps/server/src/footage/footageStore.ts";
import { FootageIndexer, projectMedia, type ProjectMedia } from "../../apps/server/src/footage/indexer.ts";

const transcript = (text: string): TranscriptResult => ({
  hasAudio: true,
  segments: [],
  words: text.split(" ").map((word, i) => ({ text: word, start: i, end: i + 0.5, p: 1 })),
});

interface Pending {
  readonly target: AnalysisTarget;
  readonly finish: (outcome: Outcome) => void;
  readonly job: AnalysisJob;
}

function setup(refuse?: Error) {
  const root = mkdtempSync(join(tmpdir(), "uncut-footage-"));
  const dir = join(root, "demo.uncut");
  mkdirSync(dir);
  const media: Array<ProjectMedia["media"][number] & { source?: unknown }> = [];
  const addClip = (id: string, kind = "video") => {
    const path = join(root, `${id}.mp4`);
    writeFileSync(path, `the bytes of ${id}`);
    media.push({ id, kind, path, name: `${id}.mp4`, probe: { frames: 300, hasAudio: true } });
    return path;
  };
  const statuses: Array<FootageStatus> = [];
  const requests: Array<Pending> = [];
  const cancelled: Array<string> = [];
  const store = new FootageStore(":memory:");
  let open: ProjectMedia | undefined = { dir, name: "Demo", fps: 30, media };
  const indexer = new FootageIndexer({
    store,
    delayMs: 1,
    open: () => open && { ...open, media: [...media] },
    recentDirs: async () => [],
    request: async (target): Promise<Requested> => {
      if (refuse) throw refuse;
      const job = {
        id: `job-${requests.length}`,
        mediaId: target.mediaId,
        mediaIds: [target.mediaId],
        projectDir: dir,
        analyzer: "transcript",
        phase: "running",
        progress: 0,
      } as unknown as AnalysisJob;
      let finish: (outcome: Outcome) => void = () => {};
      const done = new Promise<Outcome>((resolve) => (finish = resolve));
      requests.push({ target, finish, job });
      return { job, done };
    },
    cancelJob: (jobId) => cancelled.push(jobId),
    onStatus: (status) => statuses.push(status),
  });
  const close = async () => {
    await indexer.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, dir, media, addClip, indexer, store, statuses, requests, cancelled, close, closeProject: () => (open = undefined) };
}

const until = async (ready: () => boolean) => {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((done) => setTimeout(done, 5));
  assert.ok(ready(), "timed out");
};
const search = (indexer: FootageIndexer, query: string) => indexer.search({ query, thisProject: false, limit: 10 });

test("a scan takes in cached transcripts and starts no transcription by itself", async () => {
  const t = setup();
  try {
    const path = t.addClip("talk");
    t.addClip("silent");
    await writeCached(t.dir, await fingerprint(path), "transcript", transcript("hello from the cache"));
    t.indexer.schedule();
    await t.indexer.settled();
    assert.equal(t.requests.length, 0);
    const status = t.indexer.status();
    assert.equal(status.clips, 2);
    assert.equal(status.indexed, 1);
    const [hit] = await search(t.indexer, "cache");
    assert.equal(hit!.media, "talk");
    assert.equal(hit!.path, path);
    assert.equal(hit!.project.name, "Demo");
  } finally {
    await t.close();
  }
});

test("a started run goes clip by clip with progress, and new media joins by itself", async () => {
  const t = setup();
  try {
    t.addClip("one");
    t.addClip("two");
    t.addClip("still", "image");
    t.indexer.schedule();
    await t.indexer.settled();
    t.indexer.start();
    await until(() => t.requests.length === 1);
    assert.equal(t.indexer.status().phase, "running");
    assert.equal(t.indexer.status().current, "one.mp4");
    t.indexer.onJobs([{ ...t.requests[0]!.job, progress: 0.5 }]);
    assert.equal(t.indexer.status().progress, 0.25);
    t.requests[0]!.finish({ state: "done", result: transcript("alpha words"), cached: false });
    await until(() => t.requests.length === 2);
    assert.equal(t.indexer.status().indexed, 1);
    t.requests[1]!.finish({ state: "done", result: { hasAudio: false }, cached: false });
    await until(() => t.indexer.status().phase === "idle");
    assert.equal(t.indexer.status().indexed, 2);
    assert.equal((await search(t.indexer, "alpha")).length, 1);

    t.addClip("three");
    t.indexer.projectChanged();
    await until(() => t.requests.length === 3);
    assert.equal(t.requests[2]!.target.mediaId, "three");
    t.requests[2]!.finish({ state: "done", result: transcript("gamma"), cached: false });
    await until(() => t.indexer.status().phase === "idle" && t.indexer.status().indexed === 3);
  } finally {
    await t.close();
  }
});

test("cancel stops the job, keeps what's indexed and stays off until asked again", async () => {
  const t = setup();
  try {
    t.addClip("one");
    t.addClip("two");
    t.addClip("three");
    t.indexer.schedule();
    await t.indexer.settled();
    t.indexer.start();
    await until(() => t.requests.length === 1);
    t.requests[0]!.finish({ state: "done", result: transcript("kept"), cached: false });
    await until(() => t.requests.length === 2);
    await until(() => t.indexer.status().current === "two.mp4");
    t.indexer.cancel();
    assert.deepEqual(t.cancelled, ["job-1"]);
    t.requests[1]!.finish({ state: "cancelled" });
    await until(() => t.indexer.status().phase === "idle");
    assert.equal(t.indexer.status().indexed, 1);

    t.addClip("four");
    t.indexer.projectChanged();
    await t.indexer.settled();
    assert.equal(t.requests.length, 2);
    assert.equal((await search(t.indexer, "kept")).length, 1);

    t.indexer.start();
    await until(() => t.requests.length === 3);
    assert.equal(t.requests[2]!.target.mediaId, "two");
  } finally {
    await t.close();
  }
});

test("a clip that fails is reported and the run goes on without retrying it", async () => {
  const t = setup();
  try {
    t.addClip("bad");
    t.addClip("good");
    t.indexer.schedule();
    await t.indexer.settled();
    t.indexer.start();
    await until(() => t.requests.length === 1);
    t.requests[0]!.finish({ state: "failed", error: "whisper-cli isn't installed" });
    await until(() => t.requests.length === 2);
    t.requests[1]!.finish({ state: "done", result: transcript("fine"), cached: false });
    await until(() => t.indexer.status().phase === "idle");
    const status = t.indexer.status();
    assert.equal(status.failed, 1);
    assert.equal(status.error, "whisper-cli isn't installed");
    t.indexer.schedule();
    await t.indexer.settled();
    assert.equal(t.requests.length, 2);
  } finally {
    await t.close();
  }
});

test("a transcript made elsewhere replaces what's indexed, and a run's own job isn't taken twice", async () => {
  const t = setup();
  try {
    const path = t.addClip("talk");
    const fp = await fingerprint(path);
    await writeCached(t.dir, fp, "transcript", transcript("first words"));
    t.indexer.schedule();
    await t.indexer.settled();
    await writeCached(t.dir, fp, "transcript", transcript("redone words"));
    const job = { id: "agent", analyzer: "transcript", phase: "done", projectDir: t.dir, mediaId: "talk", mediaIds: ["talk"] } as unknown as AnalysisJob;
    t.indexer.onJobs([job]);
    await t.indexer.settled();
    assert.equal((await search(t.indexer, "first")).length, 0);
    assert.equal((await search(t.indexer, "redone")).length, 1);
  } finally {
    await t.close();
  }
});

test("descriptions are searchable at once; a hit whose file is gone isn't shown", async () => {
  const t = setup();
  try {
    const path = t.addClip("drone");
    t.indexer.schedule();
    await t.indexer.settled();
    const before = t.indexer.status().revision;
    await t.indexer.describe(path, [{ start: 1, end: 3, text: "lighthouse at dusk" }]);
    assert.ok(t.indexer.status().revision > before);
    const [hit] = await search(t.indexer, "lighthouse");
    assert.equal(hit!.source, "visual");
    assert.equal(hit!.media, "drone");
    rmSync(path);
    assert.deepEqual(await search(t.indexer, "lighthouse"), []);
  } finally {
    await t.close();
  }
});

test("an unplugged drive keeps places and passages: the hit is back when the file is", async () => {
  const t = setup();
  try {
    const path = t.addClip("drone");
    t.indexer.schedule();
    await t.indexer.settled();
    await t.indexer.describe(path, [{ start: 1, end: 3, text: "lighthouse at dusk" }]);
    const fingerprint = t.store.search({ query: "lighthouse", limit: 1 })[0]!.fingerprint;

    const unplugged = `${path}.away`;
    renameSync(path, unplugged);
    t.indexer.schedule();
    await t.indexer.settled();
    assert.equal(t.store.places(fingerprint).length, 1, "the file's place stays");
    assert.equal(t.store.search({ query: "lighthouse", limit: 1 }).length, 1, "its passages stay");
    assert.deepEqual(await search(t.indexer, "lighthouse"), [], "it isn't offered while it's away");

    renameSync(unplugged, path);
    t.indexer.schedule();
    await t.indexer.settled();
    assert.equal((await search(t.indexer, "lighthouse")).length, 1);
  } finally {
    await t.close();
  }
});

test("the top matches being missing files doesn't use up the limit", async () => {
  const t = setup();
  try {
    const gone = [t.addClip("gone-1"), t.addClip("gone-2")];
    const kept = t.addClip("kept");
    t.indexer.schedule();
    await t.indexer.settled();
    for (const path of gone) await t.indexer.describe(path, [{ start: 1, end: 3, text: "lighthouse" }]);
    await t.indexer.describe(kept, [{ start: 1, end: 3, text: "a lighthouse far away over the water at the end of a long evening" }]);
    for (const path of gone) rmSync(path);
    assert.notEqual(t.store.search({ query: "lighthouse", limit: 1 })[0]!.places[0]!.path, kept);
    const hits = await t.indexer.search({ query: "lighthouse", thisProject: false, limit: 1 });
    assert.deepEqual(
      hits.map((hit) => hit.path),
      [kept],
    );
  } finally {
    await t.close();
  }
});

test("a deleted project goes from the index, with its transcripts and descriptions", async () => {
  const t = setup();
  try {
    const path = t.addClip("drone");
    const fp = await fingerprint(path);
    await writeCached(t.dir, fp, "transcript", transcript("spoken words"));
    t.indexer.schedule();
    await t.indexer.settled();
    await t.indexer.describe(path, [{ start: 1, end: 3, text: "lighthouse at dusk" }]);

    t.closeProject();
    rmSync(t.dir, { recursive: true });
    t.indexer.schedule();
    await t.indexer.settled();
    assert.deepEqual(t.store.places(fp), []);
    assert.deepEqual(t.store.search({ query: "spoken", limit: 1 }), []);
    assert.deepEqual(t.store.search({ query: "lighthouse", limit: 1 }), []);
    assert.equal(t.store.isIndexed(fp), false);
  } finally {
    await t.close();
  }
});

test("a project folder that can't be reached keeps its clips; media taken out of a project goes", async () => {
  const t = setup();
  try {
    const path = t.addClip("drone");
    t.indexer.schedule();
    await t.indexer.settled();
    await t.indexer.describe(path, [{ start: 1, end: 3, text: "lighthouse at dusk" }]);
    const fingerprint = t.store.search({ query: "lighthouse", limit: 1 })[0]!.fingerprint;

    t.closeProject();
    rmSync(t.root, { recursive: true });
    t.indexer.schedule();
    await t.indexer.settled();
    assert.equal(t.store.search({ query: "lighthouse", limit: 1 }).length, 1);
    assert.equal(t.store.places(fingerprint).length, 1);
  } finally {
    await t.close();
  }

  const other = setup();
  try {
    const path = other.addClip("drone");
    other.indexer.schedule();
    await other.indexer.settled();
    await other.indexer.describe(path, [{ start: 1, end: 3, text: "lighthouse at dusk" }]);
    other.media.length = 0;
    other.indexer.schedule();
    await other.indexer.settled();
    assert.deepEqual(other.store.search({ query: "lighthouse", limit: 1 }), []);
  } finally {
    await other.close();
  }
});

test("a run whose job can't be started stops and can run again", async () => {
  const t = setup(new Error("the queue is closed"));
  try {
    t.addClip("drone");
    t.indexer.start();
    await t.indexer.settled();
    await until(() => t.indexer.status().phase === "idle" && t.statuses.some((s) => s.phase === "running"));
    assert.equal(t.indexer.status().phase, "idle");
  } finally {
    await t.close();
  }
});

test("a project's bundled sounds aren't indexed, and its name comes from the document", () => {
  const project = projectMedia(
    {
      name: "My film",
      canvas: { fps: 25 },
      media: [
        { id: "a", kind: "video", path: "a.mp4", name: "a" },
        { id: "b", kind: "audio", path: "b.m4a", name: "b", source: { module: "library.sfx" } },
      ],
    },
    "/p",
    "fallback",
  );
  assert.equal(project.name, "My film");
  assert.equal(project.fps, 25);
  assert.deepEqual(
    project.media.map((m) => m.id),
    ["a"],
  );
});
