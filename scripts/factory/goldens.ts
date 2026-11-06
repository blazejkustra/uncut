// Exports the golden projects through the packaged app's own server, Electron-as-Node like the
// desktop app starts it, so its rasteriser and media core are the ones that ship.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ssim } from "../../test/helpers/image-compare.ts";
import { writeProject } from "../../test/helpers/export-fixture.ts";
import { connect, startServer } from "../../test/helpers/server.ts";
import { GOLDEN_ITEMS, type GoldenItem } from "./golden-manifest.ts";
import { compareExport, ssimProblems, streamProblems, syncOffsetsMs, syncProblems, type Measured } from "./golden-compare.ts";
import { audioLevels, beepTimes, flashFrames, framePng, frameHashes, probeOf } from "./media.ts";
import { Blocked, breachReason, ensureRoom, watchTree, type GuardLimits } from "./memory-guard.ts";
import { skippedCheck, type Check } from "./report.ts";
import { ffmpegVersion } from "./verify-env.ts";

const EXPORT_TIMEOUT_MS = 180000;

interface GoldensMeta {
  readonly sha: string;
  readonly blessedAt: string;
  readonly ffmpeg: string | undefined;
  /** Test file to why it's left out of the verdict: it fails on this very commit. */
  readonly quarantine?: Readonly<Record<string, string>>;
}

export interface Exporter {
  readonly render: (item: GoldenItem, name: string) => Promise<string>;
  readonly stop: () => Promise<void>;
}

const TERMINAL_PHASES = ["done", "failed", "cancelled"];
interface ExportJob {
  readonly id: string;
  readonly phase: string;
  readonly error?: string;
}

/** The packaged app's server, in a data folder of its own. */
export async function startExporter(appBundle: string, footageDir: string, limits: GuardLimits): Promise<Exporter> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-goldens-")));
  const resources = join(appBundle, "Contents/Resources");
  const binary = join(appBundle, "Contents/MacOS/Uncut");
  const entry = join(resources, "server/server.mjs");
  const server = await startServer({
    command: binary,
    args: [entry],
    captureStderr: true,
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_MEDIA_BIN: join(resources, "bin/uncut-media"),
      UNCUT_MODULES_DIR: join(resources, "modules/builtin"),
      UNCUT_SFX_DIR: join(resources, "sfx"),
      UNCUT_GRAPHIC_LIBS_DIR: join(resources, "graphic-libs"),
      UNCUT_FONTS_DIR: join(resources, "fonts"),
      UNCUT_BUNDLED_PLUGINS_DIR: join(resources, "plugins"),
      UNCUT_PLUGIN_SDK_DIR: join(resources, "plugin-sdk"),
      UNCUT_RENDER_BIN: binary,
      UNCUT_RENDER_ENTRY: "",
    },
  });
  const client = await connect(server.ready.port, server.ready.token);
  const jobs = client.subscribe("export.jobs");
  const waitForJob = async (jobId: string) => {
    const watch = watchTree(server.proc.pid!, limits.capBytes);
    const ended = (list: ReadonlyArray<ExportJob>) => list.some((j) => j.id === jobId && TERMINAL_PHASES.includes(j.phase));
    const serverGone = new Promise<void>((done) => server.exited.then(() => done()));
    try {
      const finished = jobs.until(ended, EXPORT_TIMEOUT_MS);
      finished.catch(() => {});
      await Promise.race([finished, serverGone]);
    } finally {
      watch.stop();
    }
    const breach = watch.breach();
    if (breach) throw new Blocked(breachReason(breach), breach);
  };
  const render = async (item: GoldenItem, name: string) => {
    await ensureRoom(limits, root);
    const mediaRoot = join(root, "media", item.id);
    const project = item.project(mediaRoot, footageDir);
    await client.ok("project.open", { dir: writeProject(join(root, "projects"), name, project) });
    const output = join(root, `${name}.mp4`);
    const { jobId } = await client.ok("export.start", { output, quality: item.quality, loudness: "off" });
    await waitForJob(jobId);
    const job = (jobs.values.at(-1) as ReadonlyArray<ExportJob>).find((j) => j.id === jobId)!;
    if (job.phase !== "done") throw new Error(`export ${job.phase}: ${job.error ?? "no reason given"}\n${server.stderr().slice(-1000)}`);
    return output;
  };
  const stop = async () => {
    client.close();
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  };
  return { render, stop };
}

function measure(file: string, item: GoldenItem): Measured {
  const probe = probeOf(file);
  const { video, audio } = probe;
  const syncMs =
    item.flashes !== undefined && video && audio ? syncOffsetsMs(flashFrames(file), beepTimes(file), video.fps, video.startS, audio.startS) : undefined;
  return { probe, frameHashes: frameHashes(file), audioLevelsDb: probe.audio ? audioLevels(file) : [], ...(syncMs && { syncMs }) };
}

const frameName = (frame: number) => `f${String(frame).padStart(4, "0")}.png`;

function keyFramesOf(file: string, item: GoldenItem, dir: string) {
  mkdirSync(dir, { recursive: true });
  return item.keyFrames.map((frame) => framePng(file, frame, join(dir, frameName(frame))));
}

function ssimAgainst(item: GoldenItem, dir: string, goldenDir: string) {
  const { width, height } = probeOf(join(dir, frameName(item.keyFrames[0]!))).video!;
  const scores: Record<string, number> = {};
  for (const frame of item.keyFrames) scores[frame] = ssim(join(dir, frameName(frame)), join(goldenDir, frameName(frame)), width, height);
  return scores;
}

const ruleOf = (item: GoldenItem) => ({
  compare: item.compare,
  expectedFrames: item.frames,
  hasAudio: item.hasAudio,
  ...(item.flashes !== undefined && { expectedFlashes: item.flashes }),
});

const footageMissing = (item: GoldenItem, footageDir: string) => Boolean(item.footage) && !existsSync(join(footageDir, item.footage!));

const goldenCheckId = (item: GoldenItem) => `golden:${item.id}`;

function readMeta(goldens: string): GoldensMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(goldens, "meta.json"), "utf8")) as GoldensMeta;
  } catch {
    return undefined;
  }
}

export const goldensSha = (goldens: string) => readMeta(goldens)?.sha;

export function quarantinedFiles(goldens: string) {
  const meta = readMeta(goldens);
  return new Map(Object.entries(meta?.quarantine ?? {}).map(([file, why]) => [file, `${why} (on ${meta!.sha.slice(0, 12)})`]));
}

export interface GoldenRun {
  readonly exporter: Exporter;
  readonly goldens: string;
  readonly evidenceDir: string;
  readonly footageDir: string;
}

type ItemBase = Pick<Check, "id" | "title" | "required">;

/** A blocked export says so in its reason, and with `blocked` set the items after it don't start. */
function failedItem(base: ItemBase, error: unknown, started: number): Check {
  const durationMs = Date.now() - started;
  if (error instanceof Blocked && error.breach)
    return { ...base, status: "fail", reason: error.message, values: { blocked: true, memoryBreach: true }, durationMs };
  if (error instanceof Blocked) return { ...base, status: "skipped", required: true, reason: error.message, values: { blocked: true }, durationMs };
  return { ...base, status: "fail", problems: [String(error).slice(0, 1500)], durationMs };
}

const removeOutputs = (files: ReadonlyArray<string | undefined>) => {
  for (const file of files) if (file) rmSync(file, { force: true });
};

const isBlocked = (check: Check) => check.values?.blocked === true;

const afterBlock = (item: GoldenItem) => skippedCheck(goldenCheckId(item), item.title, "not started: an earlier export was blocked");

async function checkItem(item: GoldenItem, { exporter, goldens, evidenceDir }: GoldenRun): Promise<Check> {
  const started = Date.now();
  const goldenDir = join(goldens, item.id);
  const golden = JSON.parse(readFileSync(join(goldenDir, "golden.json"), "utf8")) as Measured;
  const base = { id: goldenCheckId(item), title: item.title, required: !item.footage };
  let file: string | undefined;
  try {
    file = await exporter.render(item, `verify-${item.id}`);
    const measured = measure(file, item);
    const dir = join(evidenceDir, item.id);
    const evidence = keyFramesOf(file, item, dir);
    const scores = ssimAgainst(item, dir, goldenDir);
    const problems = [...compareExport(measured, golden, ruleOf(item)), ...ssimProblems(scores, item.minSsim)];
    const { durationS, video, audio } = measured.probe;
    const values = {
      durationS,
      frames: video?.frames,
      codec: video?.codec,
      audioCodec: audio?.codec,
      ssim: scores,
      syncMs: measured.syncMs,
      compare: item.compare,
    };
    return { ...base, status: problems.length ? "fail" : "pass", ...(problems.length && { problems }), values, evidence, durationMs: Date.now() - started };
  } catch (error) {
    return failedItem(base, error, started);
  } finally {
    removeOutputs([file]);
  }
}

/** Why the goldens can't judge this Mac's exports at all, if they can't. */
export function goldensProblem(goldens: string) {
  const meta = readMeta(goldens);
  if (!meta) return `no goldens in ${goldens}: record them with --bless`;
  const ffmpeg = ffmpegVersion();
  return meta.ffmpeg === ffmpeg ? undefined : `the goldens were blessed with ${meta.ffmpeg}, this Mac has ${ffmpeg}: bless again from a trusted commit`;
}

export async function checkGoldens(run: GoldenRun): Promise<Array<Check>> {
  const checks: Array<Check> = [];
  for (const item of GOLDEN_ITEMS) {
    const id = goldenCheckId(item);
    if (footageMissing(item, run.footageDir)) checks.push(skippedCheck(id, item.title, `${item.footage} is not in ${run.footageDir}`, false));
    else if (!existsSync(join(run.goldens, item.id, "golden.json"))) checks.push(skippedCheck(id, item.title, "no golden blessed for it", !item.footage));
    else if (checks.some(isBlocked)) checks.push(afterBlock(item));
    else checks.push(await checkItem(item, run));
  }
  return checks;
}

/** Two exports of one commit must agree before they become the bar for every later commit. */
async function blessItem(item: GoldenItem, exporter: Exporter, target: string): Promise<Check> {
  const started = Date.now();
  const base = { id: goldenCheckId(item), title: item.title, required: !item.footage };
  const outputs: Array<string> = [];
  try {
    const first = await exporter.render(item, `bless-${item.id}-1`);
    outputs.push(first);
    const second = await exporter.render(item, `bless-${item.id}-2`);
    outputs.push(second);
    const measured = measure(first, item);
    const again = measure(second, item);
    const goldenDir = join(target, item.id);
    keyFramesOf(first, item, goldenDir);
    keyFramesOf(second, item, join(goldenDir, "second"));
    const scores = ssimAgainst(item, goldenDir, join(goldenDir, "second"));
    rmSync(join(goldenDir, "second"), { recursive: true, force: true });
    writeFileSync(join(goldenDir, "golden.json"), JSON.stringify(measured, null, 2));
    const problems = [
      ...streamProblems(measured.probe, measured.probe, ruleOf(item)),
      ...compareExport(again, measured, ruleOf(item)),
      ...ssimProblems(scores, item.minSsim),
      ...(item.flashes === undefined ? [] : syncProblems(measured.syncMs ?? [], item.flashes)),
    ];
    return {
      ...base,
      status: problems.length ? "fail" : "pass",
      ...(problems.length && { problems }),
      values: { ssimBetweenRuns: scores, syncMs: measured.syncMs, framesHashed: measured.frameHashes.length },
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return failedItem(base, error, started);
  } finally {
    removeOutputs(outputs);
  }
}

export async function blessGoldens(
  { exporter, goldens, footageDir }: Omit<GoldenRun, "evidenceDir">,
  sha: string,
  quarantine: Readonly<Record<string, string>>,
): Promise<Array<Check>> {
  const target = `${goldens}.new`;
  rmSync(target, { recursive: true, force: true });
  const checks: Array<Check> = [];
  for (const item of GOLDEN_ITEMS) {
    if (footageMissing(item, footageDir)) checks.push(skippedCheck(goldenCheckId(item), item.title, `${item.footage} is not in ${footageDir}`, false));
    else if (checks.some(isBlocked)) checks.push(afterBlock(item));
    else checks.push(await blessItem(item, exporter, target));
  }
  if (checks.some((c) => c.status !== "pass" && c.required)) return checks;
  const kept = readMeta(goldens);
  const footage = GOLDEN_ITEMS.filter((item) => item.footage && footageMissing(item, footageDir) && existsSync(join(goldens, item.id)));
  for (const item of footage) cpSync(join(goldens, item.id), join(target, item.id), { recursive: true });
  writeFileSync(
    join(target, "meta.json"),
    JSON.stringify({ sha, blessedAt: new Date().toISOString(), ffmpeg: ffmpegVersion(), quarantine } satisfies GoldensMeta, null, 2),
  );
  if (kept) renameSync(goldens, `${goldens}.${kept.sha.slice(0, 12)}-${Date.now()}`);
  renameSync(target, goldens);
  return checks;
}
