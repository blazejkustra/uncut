// Phase 5 chunk 2 (D66) on the bundled server: media_analyze through the scripted stand-in for
// claude (helpers/fake-claude.ts) and the real MCP server, and the analysis.* RPCs.
// ffmpeg is reached through a shell shim first on PATH that logs every run and, when told to,
// sleeps before running the real one, so the tests can count spawns and make a job last.
// - media_analyze of a generated clip (a tone with silent gaps, plus a DJI-like mjpeg stream):
//   loudness and silences; a re-ask comes from the cache without ffmpeg; no-audio and refusals.
// - A slow job answers "running" (the agent asks again), a cancel from the Library leaves nothing
//   in .cache/analysis and the job says cancelled.
// - Analysis waits while an export renders.
// All media is made here with ffmpeg's lavfi sources; nothing from ~/Documents/devrel/drone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "./helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : !FFMPEG || !FFPROBE ? "ffmpeg isn't installed" : false;
const WAIT_MS = 6000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
type Content = Array<{ type: string; text?: string }>;
let root = "";
let footage = "";
let shimDir = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let analysisJobs: ReturnType<Client["subscribe"]>;
let dir = "";
const plan = () => join(root, "plan.json");
const resultLog = () => join(root, "results.jsonl");
const callLog = () => join(shimDir, "calls.log");
/** ffmpeg runs of the loudness analyzer so far (the shim logs every run's arguments). */
const loudnessRuns = () => (existsSync(callLog()) ? readFileSync(callLog(), "utf8").split("\n").filter((l) => l.includes("ebur128")) : []);
const slow = (pattern: string, seconds: number) => writeFileSync(join(shimDir, "slow"), `${pattern} ${seconds}\n`);
const fast = () => rmSync(join(shimDir, "slow"), { force: true });
const analysisFiles = () => (existsSync(join(dir, ".cache", "analysis")) ? (readdirSync(join(dir, ".cache", "analysis"), { recursive: true }) as Array<string>).sort() : []);
const ff = (...args: Array<string>) => execFileSync(FFMPEG!, ["-v", "error", "-y", ...args]);

const turns: Array<unknown> = [];
async function ask(prompt: string, steps: Array<unknown>) {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
  const before = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).length;
  const { turnId } = await client.ok("agent.send", { prompt });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 120000);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  const results = readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l).result as { isError?: boolean; content: Content });
  return { turn, results };
}
const textOf = (r: { content: Content }) => r.content.find((c) => c.type === "text")!.text!;
const jsonOf = (r: { content: Content }) => JSON.parse(textOf(r));

// 1 s tone, 0.8 s silence, 1.2 s tone, 0.5 s silence, 1 s tone, 0.6 s silence (to the end).
const GAPS = [
  [1.0, 1.8],
  [3.0, 3.5],
  [4.5, 5.1],
];
const gapped = (freq: number) =>
  [
    `sine=frequency=${freq}:sample_rate=48000:duration=1,volume=2[a]`,
    "anullsrc=r=48000:cl=mono:d=0.8[s1]",
    `sine=frequency=${freq}:sample_rate=48000:duration=1.2,volume=2[b]`,
    "anullsrc=r=48000:cl=mono:d=0.5[s2]",
    `sine=frequency=${freq}:sample_rate=48000:duration=1,volume=2[c]`,
    "anullsrc=r=48000:cl=mono:d=0.6[s3]",
    "[a][s1][b][s2][c][s3]concat=n=6:v=0:a=1[out]",
  ].join(";");
/** A 5.1 s clip: test pattern, the gapped tone (AAC), and a larger default mjpeg stream like a DJI cover. */
const talk = (file: string, freq: number) =>
  ff(
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
    "-f", "lavfi", "-i", "color=blue:size=640x360:rate=30",
    "-filter_complex", gapped(freq),
    "-t", "5.1",
    "-map", "0:v", "-map", "1:v", "-map", "[out]",
    "-c:v:0", "libx264", "-pix_fmt:v:0", "yuv420p", "-c:v:1", "mjpeg", "-pix_fmt:v:1", "yuvj420p", "-disposition:v:0", "0", "-disposition:v:1", "default",
    "-c:a", "aac", "-b:a", "128k",
    file,
  );

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-analysis-")));
  mkdirSync(join(root, "projects"));
  mkdirSync(join(root, "out"));
  footage = join(root, "Footage");
  mkdirSync(footage);
  talk(join(footage, "Talk.mp4"), 440);
  talk(join(footage, "Talk2.mp4"), 550);
  talk(join(footage, "Talk3.mp4"), 660);
  talk(join(footage, "Gone.mp4"), 770);
  ff("-f", "lavfi", "-i", "color=0x00A000:size=320x180:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(footage, "Still.mp4"));
  // The shim: logs, sleeps when its arguments contain the pattern in ./slow, then runs ffmpeg.
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  writeFileSync(
    join(shimDir, "ffmpeg"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${callLog()}"\nif [ -f "${shimDir}/slow" ]; then\n  read pat secs < "${shimDir}/slow"\n  case "$*" in *"$pat"*) sleep "$secs";; esac\nfi\nexec "${FFMPEG}" "$@"\n`,
  );
  chmodSync(join(shimDir, "ffmpeg"), 0o755);
  // The exporter finds ffprobe next to ffmpeg.
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  server = await startServer({
    env: {
      PATH: `${shimDir}:${dirname(FFMPEG!)}:${process.env.PATH}`,
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_CLAUDE: FAKE,
      UNCUT_ANALYZE_WAIT_MS: String(WAIT_MS),
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  analysisJobs = client.subscribe("analysis.jobs");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Analysis test" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
  const { turn } = await ask("import the footage", [{ tool: "media_import", args: { path: footage } }]);
  assert.equal(turn.status, "done", turn.error);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("media_analyze: loudness and silences of a clip (first audio stream); a re-ask is cached with no ffmpeg; no-audio and refusals", { skip, timeout: 120000 }, async () => {
  const runsBefore = loudnessRuns().length;
  const { turn, results } = await ask("how loud is the talk, and where are the pauses?", [
    { tool: "media_analyze", args: { media: "m-talk" } },
    { tool: "media_analyze", args: { media: "m-talk", analyzers: ["silence"] } },
    { tool: "media_analyze", args: { media: "m-still" } },
    { tool: "media_analyze", args: { media: "m-talk", analyzers: ["shots"] } },
    { tool: "media_analyze", args: { media: "m-nope" } },
    { tool: "media_analyze", args: { media: "m-talk", range: { start: 80, end: 120 } } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  assert.deepEqual(
    turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text),
    ["Analysed the sound of m-talk", "Found the silences in m-talk", "Analysed the sound of m-still", "Analysed the sound of m-talk", "Analysed the sound of m-nope", "Analysed the sound of m-talk"],
  );
  const [first, again, still, shots, nope, ranged] = results;
  assert.ok(!first!.isError, textOf(first!));
  const out = jsonOf(first!);
  const l = out.loudness;
  assert.equal(l.state, "done");
  assert.equal(l.cached, false);
  assert.equal(l.hasAudio, true);
  assert.equal(l.silence.thresholdDb, -40);
  assert.equal(l.silence.minSeconds, 0.3);
  assert.equal(l.silence.ranges.length, GAPS.length, JSON.stringify(l.silence));
  for (const [i, [start, end]] of GAPS.entries()) {
    const r = l.silence.ranges[i];
    assert.ok(Math.abs(r.startSeconds - start!) <= 0.05 && Math.abs(r.endSeconds - end!) <= 0.05, `silence ${i}: ${JSON.stringify(r)}`);
    // Project frames of the media (30 fps), inside the silence.
    assert.equal(r.start, Math.ceil(r.startSeconds * 30 - 1e-6));
    assert.equal(r.end, Math.min(Math.floor(r.endSeconds * 30 + 1e-6), 153));
  }
  // ffmpeg's own measurement of the same sound (loudnorm, another filter).
  const measured = spawnSync(FFMPEG!, ["-hide_banner", "-nostdin", "-i", join(footage, "Talk.mp4"), "-map", "0:a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-"], { encoding: "utf8" });
  const input = JSON.parse([...measured.stderr.matchAll(/\{[^{}]*\}/g)].at(-1)![0]) as { input_i: string };
  assert.ok(Math.abs(l.integratedLufs - Number(input.input_i)) <= 0.5, `${l.integratedLufs} vs ${input.input_i}`);
  assert.equal(loudnessRuns().length, runsBefore + 1, "one ffmpeg run");
  assert.ok(loudnessRuns().at(-1)!.includes("-map 0:a:0"), "the first audio stream, mapped explicitly");
  const cached = analysisFiles().filter((f) => f.endsWith(".json"));
  assert.equal(cached.length, 1);
  assert.match(cached[0]!, /^[0-9a-f]{32}\/loudness\.json$/);

  // The re-ask ("silence" is the same job) comes from the cache: no ffmpeg.
  const second = jsonOf(again!);
  assert.equal(second.loudness.cached, true);
  assert.deepEqual(second.loudness.silence, l.silence);
  assert.equal(loudnessRuns().length, runsBefore + 1, "no ffmpeg for the cached re-ask");

  // A clip without sound: a result, from the probe.
  assert.ok(!still!.isError);
  assert.equal(jsonOf(still!).loudness.hasAudio, false);
  assert.equal(loudnessRuns().length, runsBefore + 1);
  assert.ok(shots!.isError);
  assert.match(textOf(shots!), /shots \(shot detection\) isn't available yet/);
  assert.ok(nope!.isError);
  assert.match(textOf(nope!), /no media "m-nope".*m-talk/);
  // A range lists only the silences that overlap it.
  const r = jsonOf(ranged!).loudness.silence;
  assert.equal(r.count, 1);
  assert.ok(Math.abs(r.ranges[0].startSeconds - 3.0) <= 0.05);
});

test("a slow job answers running and the agent can ask again; a cancel from the Library leaves nothing in .cache/analysis", { skip, timeout: 120000 }, async () => {
  const filesBefore = analysisFiles();
  slow("ebur128", 40);
  try {
    const t0 = Date.now();
    const { results } = await ask("analyse talk 2", [{ tool: "media_analyze", args: { media: "m-talk2" } }]);
    assert.ok(Date.now() - t0 >= WAIT_MS - 200, "it waited");
    const out = jsonOf(results[0]!);
    assert.equal(out.loudness.state, "running", JSON.stringify(out));
    assert.match(out.note, /call media_analyze again with the same arguments/i);
    // The job carries on after the turn; the Library shows it and can stop it.
    await analysisJobs.until((list) => list.some((j: any) => j.mediaId === "m-talk2" && j.phase === "running"));
    const job = analysisJobs.values.at(-1).find((j: any) => j.mediaId === "m-talk2" && j.phase === "running");
    const runs = loudnessRuns().length;
    // Asked again while it runs: it joins the same job (no second job, no second ffmpeg).
    const { results: again } = await ask("still going?", [{ tool: "media_analyze", args: { media: "m-talk2" } }]);
    assert.equal(jsonOf(again[0]!).loudness.state, "running");
    const talk2Jobs = new Set(analysisJobs.values.flat().filter((j: any) => j.mediaId === "m-talk2").map((j: any) => j.id));
    assert.deepEqual([...talk2Jobs], [job.id], "one job for m-talk2");
    assert.equal(loudnessRuns().length, runs, "no second ffmpeg");
    assert.equal(job.projectDir, dir);
    assert.equal(job.analyzer, "loudness");
    await client.ok("analysis.cancel", { jobId: job.id });
    await analysisJobs.until((list) => list.some((j: any) => j.id === job.id && j.phase === "cancelled"), 5000);
    assert.deepEqual(analysisFiles(), filesBefore, "nothing new in .cache/analysis");
    // Asked again (now quick): a new run, done.
  } finally {
    fast();
  }
  const { results } = await ask("try again", [{ tool: "media_analyze", args: { media: "m-talk2" } }]);
  const out = jsonOf(results[0]!);
  assert.equal(out.loudness.state, "done", JSON.stringify(out));
  assert.equal(out.loudness.cached, false);
  assert.equal(analysisFiles().filter((f) => f.endsWith(".json")).length, filesBefore.filter((f) => f.endsWith(".json")).length + 1);
});

test("analysis.start waits while an export renders, then runs; refusals are typed", { skip, timeout: 180000 }, async () => {
  const unknown = await client.fail("analysis.start", { mediaId: "m-nope" });
  assert.equal(unknown.reason, "unknown-media");
  const later = await client.fail("analysis.start", { mediaId: "m-talk", analyzers: ["beats"] });
  assert.equal(later.reason, "unknown-analyzer");
  // A file that went missing since the import: a typed failure the Library shows.
  rmSync(join(footage, "Gone.mp4"));
  const gone = await client.fail("analysis.start", { mediaId: "m-gone" });
  assert.equal(gone.reason, "failed");
  assert.match(gone.message, /Couldn't analyse m-gone: The file isn't there any more/);
  // Cached: done at once, no job.
  assert.deepEqual(await client.ok("analysis.start", { mediaId: "m-talk" }), [{ analyzer: "loudness", state: "done" }]);

  const snap = await client.ok("project.get");
  await client.ok("project.edit", { baseRevision: snap.revision, summary: "clip", ops: [{ op: "insert_item", track: "main", item: { id: "still", type: "clip", media: "m-still", in: 0, duration: 60 } }] });
  const exportJobs = client.subscribe("export.jobs");
  slow("-stats_period", 6);
  try {
    const { jobId: exportId } = await client.ok("export.start", { output: join(root, "out", "Still.mp4"), quality: "draft", loudness: "off" });
    await exportJobs.until((list) => list.some((j: any) => j.id === exportId && j.phase === "rendering"), 60000);
    const runsBefore = loudnessRuns().length;
    const [started] = await client.ok("analysis.start", { mediaId: "m-talk3" });
    assert.equal(started.state, "queued");
    await analysisJobs.until((list) => list.some((j: any) => j.id === started.jobId && j.waiting === "export"), 5000);
    await sleep(1500);
    const exportNow = exportJobs.values.at(-1).find((j: any) => j.id === exportId);
    assert.equal(exportNow.phase, "rendering", "the export is still going");
    const waiting = analysisJobs.values.at(-1).find((j: any) => j.id === started.jobId);
    assert.equal(waiting.phase, "queued");
    assert.equal(waiting.waiting, "export");
    assert.equal(loudnessRuns().length, runsBefore, "no analysis ffmpeg while the export renders");
    await exportJobs.until((list) => list.some((j: any) => j.id === exportId && j.phase === "done"), 120000);
    await analysisJobs.until((list) => list.some((j: any) => j.id === started.jobId && j.phase === "done"), 30000);
    assert.equal(loudnessRuns().length, runsBefore + 1);
    // It only ran after the export: every state it had while the export rendered was "queued".
    const states = analysisJobs.values.map((list: Array<any>) => list.find((j) => j.id === started.jobId)?.phase).filter(Boolean);
    assert.deepEqual([...new Set(states)], ["queued", "running", "done"]);
  } finally {
    fast();
  }
});
