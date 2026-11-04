// D328: what an export does when a clip's vision result can't be made, through the real job: face
// blur stops it with an error naming the clip and no output (faces are never shown unblurred);
// background removal warns and draws the clip without the cutout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExportJob } from "../../packages/contracts/src/index.ts";
import type { Item, Project } from "../../packages/core/src/index.ts";
import { requestId, unblurredClips, visionPinned } from "../../apps/server/src/analysis/vision/clipVision.ts";
import type { VisionAnalysis } from "../../apps/server/src/analysis/vision/vision.ts";
import { planExport, type ExportPlan } from "../../apps/server/src/export/exportPlan.ts";
import { makeRunJob } from "../../apps/server/src/export/exporter/runJob.ts";
import type { VisionLookup } from "../../apps/server/src/export/plan/vision.ts";
import { afterRunSettled, CUTOUT_PERSON, FACE_BLUR_ON, fakeVision, oneClipProject, visionFolder } from "../helpers/fakeVision.ts";

const skip = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error ? "needs ffmpeg" : false;
const T = { skip, timeout: 60000 };

const NAMED = { name: "Interview" };
const SIZE = { width: 1080, height: 1920 };

const jobOf = (projectDir: string, output: string): ExportJob => ({
  id: "j",
  projectDir,
  name: "Film",
  output,
  quality: "high",
  loudness: "off",
  phase: "queued",
  progress: 0,
  ...SIZE,
  fps: 30,
  seconds: 2,
  startedAt: new Date().toISOString(),
});

interface JobRun {
  readonly end: Partial<ExportJob>;
  readonly plans: ReadonlyArray<ExportPlan>;
  readonly lookups: ReadonlyArray<VisionLookup | undefined>;
}

/** Runs the job with `planExport` as its planner, up to the plan with the vision results when `stopAtWarnings`. */
async function runExport(f: ReturnType<typeof visionFolder>, p: Project, vision: VisionAnalysis | undefined, stopAtWarnings = false): Promise<JobRun> {
  const mediaPath = (m: Project["media"][number]) => m.path;
  const planOf = (seen?: VisionLookup) => {
    const plan = planExport(p, { mediaPath, ...SIZE, vision: seen });
    if ("problem" in plan) throw new Error(plan.problem);
    return plan;
  };
  const stop = new AbortController();
  let end: Partial<ExportJob> = {};
  const plans: Array<ExportPlan> = [];
  const lookups: Array<VisionLookup | undefined> = [];
  const runJob = makeRunJob({
    patch: (_id, change) => {
      end = { ...end, ...change };
      if (stopAtWarnings && change.warnings?.length) stop.abort();
    },
    ffmpegBin: async () => "ffmpeg",
    missingMedia: async () => undefined,
    duckEnvelopes: async () => new Map(),
    vision,
  });
  const replan = (_envelopes: unknown, seen?: VisionLookup) => {
    lookups.push(seen);
    const plan = planOf(seen);
    plans.push(plan);
    return plan;
  };
  await runJob(jobOf(f.dir, join(f.root, "film.mp4")), planOf(), p, mediaPath, true, stop.signal, replan, new Map());
  return { end, plans, lookups };
}

const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const log = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = log;
  }
};

const faceBlurClip = (path: string) => oneClipProject(path, { ...NAMED, effects: [FACE_BLUR_ON] });

function assertStopped(f: ReturnType<typeof visionFolder>, run: JobRun, why: RegExp) {
  assert.equal(run.end.phase, "failed");
  assert.match(run.end.error!, /The export stopped so faces aren't shown unblurred/);
  assert.match(run.end.error!, /"Interview"/);
  assert.match(run.end.error!, why);
  assert.deepEqual(run.plans, [], "nothing was planned to be drawn without the blur");
  assert.equal(existsSync(join(f.root, "film.mp4")), false);
}

test("D328: face blur with no vision module here stops the export, naming the clip, with no output", T, async () => {
  const f = visionFolder();
  try {
    const run = await quietly(() => runExport(f, faceBlurClip(f.media), fakeVision({ noModule: true }).vision));
    assertStopped(f, run, /Face detection needs a vision module/);
  } finally {
    f.cleanup();
  }
});

test("D328: face blur where the app has no vision at all stops the export the same way", T, async () => {
  const f = visionFolder();
  try {
    const run = await quietly(() => runExport(f, faceBlurClip(f.media), undefined));
    assertStopped(f, run, /Vision isn't available here/);
  } finally {
    f.cleanup();
  }
});

test("D328: face blur with a module that isn't allowed stops the export, saying to allow it", T, async () => {
  const f = visionFolder();
  try {
    const run = await quietly(() => runExport(f, faceBlurClip(f.media), fakeVision({ disallowed: true }).vision));
    assertStopped(f, run, /Fake is installed but not allowed: allow it in Settings, Plugins/);
  } finally {
    f.cleanup();
  }
});

test("D328: face blur whose module fails stops the export, with the module's reason", T, async () => {
  const f = visionFolder();
  try {
    const run = await quietly(() => runExport(f, faceBlurClip(f.media), fakeVision({ refuse: { faces: "The helper crashed." } }).vision));
    assertStopped(f, run, /The helper crashed/);
  } finally {
    f.cleanup();
  }
});

test("D328: face blur on offline media stops the export, saying the file isn't there", T, async () => {
  const f = visionFolder();
  try {
    const run = await quietly(() => runExport(f, faceBlurClip(join(f.root, "offline.mp4")), fakeVision().vision));
    assertStopped(f, run, /file isn't there/);
  } finally {
    f.cleanup();
  }
});

test("D328: a stopped export lets go of the results it had already made", T, async () => {
  const f = visionFolder();
  try {
    const clips: Array<Item> = [
      { id: "a", type: "clip", media: "m", name: "Cut", in: 0, duration: 30, effects: [CUTOUT_PERSON] } as Item,
      { id: "b", type: "clip", media: "m", name: "Interview", in: 30, duration: 30, effects: [FACE_BLUR_ON] } as Item,
    ];
    const base = oneClipProject(f.media);
    const p = { ...base, tracks: [{ ...base.tracks[0]!, items: clips }] };
    const { vision } = fakeVision({ refuse: { faces: "The helper crashed." } });
    const run = await quietly(() => runExport(f, p, vision));
    assertStopped(f, run, /The helper crashed/);
    await afterRunSettled();
    const made = await vision.matte({ dir: f.dir, path: f.media }, { start: 0, end: 2, mode: "person" }, { signal: new AbortController().signal });
    assert.equal(made.cached, true);
    assert.equal(visionPinned(made.video), false);
  } finally {
    f.cleanup();
  }
});

test("D328: background removal with no module warns and draws the clip without the cutout, and the export goes on", T, async () => {
  const f = visionFolder();
  try {
    const p = oneClipProject(f.media, { ...NAMED, effects: [CUTOUT_PERSON] });
    const run = await runExport(f, p, fakeVision({ noModule: true }).vision, true);
    assert.equal(run.end.phase, "cancelled", run.end.error);
    const plan = run.plans.at(-1)!;
    assert.ok(plan.warnings.some((w) => /without its background removed: Background removal needs a vision module/.test(w)), plan.warnings.join("\n"));
    assert.deepEqual(run.end.warnings, plan.warnings);
    const layer = plan.visuals.find((l) => l.item.id === "c")!;
    assert.ok(layer.kind === "video" && !layer.matte);
    assert.equal(layer.fx?.fx.cutout, undefined);
  } finally {
    f.cleanup();
  }
});

test("D328: unblurredClips names only clips whose blur is on and whose faces are missing", () => {
  const p = (bypass: boolean) => oneClipProject("/tmp/talk.mp4", { ...NAMED, effects: [{ ...FACE_BLUR_ON, bypass }] });
  const id = requestId("m", { output: "faces", start: 0, end: 2 });
  const none = { made: new Map(), failed: new Map() };
  assert.deepEqual(unblurredClips(p(false), { ...none, failed: new Map([[id, "No module."]]) }), ['"Interview" (No module)']);
  assert.deepEqual(unblurredClips(p(false), none), ['"Interview" (it wasn\'t analysed)']);
  assert.deepEqual(unblurredClips(p(true), none), []);
  const found = { output: "faces" as const, key: "k", file: "f", result: { start: 0, end: 2, fps: 30, width: 1, height: 1, frames: [] } as never };
  assert.deepEqual(unblurredClips(p(false), { made: new Map([[id, found]]), failed: new Map() }), []);
});
