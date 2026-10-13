// Phase 7 chunk C (D100): whisper as the first local-model plugin (plugins/whisper-transcribe, D26).
// - The plugin over stdio, as Uncut's host talks to it, with the fake whisper-cli
//   (helpers/fake-whisper.ts): no agent tools, a transcribe call answers words and segments with
//   MCP progress, refusals and whisper's own failure in a sentence, a cancel kills whisper and gets
//   no answer, stdin closing ends it.
// - The seam: the analysis queue with the plugin through the real host (discovered from the repo's
//   plugins/ like the app's bundled folder): one job, progress from the plugin, cached; cancel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { AnalysisQueue, cacheFile, fingerprint, type AnalysisTarget } from "../../apps/server/src/analysis/analysis.ts";
import { pluginTranscribe, TEMP_PREFIX, WHISPER_PLUGIN, WHISPER_TOOL, type TranscriptResult } from "../../apps/server/src/analysis/transcription.ts";
import { discoverPlugins, PluginHost } from "../../apps/server/src/plugins/plugins.ts";
import { SAY_TOKENS, whisperJson } from "../helpers/whisper-json.ts";

const PLUGIN_DIR = resolve("plugins/whisper-transcribe");
const FAKE = resolve("test/helpers/fake-whisper.ts");
const ffmpegPath = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();
const skip = ffmpegPath ? false : "ffmpeg isn't installed";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = "";
let model = "";
let wavDir = "";
const whisperLog = () => join(root, "whisper.log");
const whisperRuns = () => (existsSync(whisperLog()) ? readFileSync(whisperLog(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: Array<string>; pid: number }) : []);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-whisper-plugin-")));
  model = join(root, "ggml-tiny.en.bin");
  writeFileSync(model, "not really a model");
  writeFileSync(join(root, "say.json"), whisperJson(SAY_TOKENS, "en"));
  wavDir = join(root, "wav");
  mkdirSync(wavDir);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=16000", "-t", "5.3", "-ac", "1", "-c:a", "pcm_s16le", join(wavDir, "audio.wav")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "talk.mp4")]);
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The plugin over stdio, as Uncut's host talks to it. */
function startPlugin(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["server.ts"], { cwd: PLUGIN_DIR, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: any) => void>();
  const progress: Array<any> = [];
  let id = 0;
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.method === "notifications/progress") progress.push(m.params);
    else waiting.get(m.id)?.(m);
  });
  const request = (method: string, params: unknown, timeout = 30000) =>
    new Promise<any>((done, fail) => {
      const n = ++id;
      const timer = setTimeout(() => fail(new Error(`${method}: no answer in ${timeout} ms; stderr ${stderr}`)), timeout);
      timer.unref();
      waiting.set(n, (m) => (clearTimeout(timer), done(m)));
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  const call = async (args: unknown, meta: Record<string, unknown> = {}) => (await request("tools/call", { name: "transcribe", arguments: args, _meta: meta })).result;
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  return { child, request, call, exited, progress, nextId: () => id + 1 };
}
const textOf = (r: any) => r.content.map((c: any) => c.text).join(" ");

test("the plugin: no agent tools; transcribe answers words with progress; refusals; whisper's failure in its words; cancel kills whisper", { skip, timeout: 60000 }, async () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "uncut.module.json"), "utf8"));
  assert.equal(manifest.id, WHISPER_PLUGIN);
  assert.equal(manifest.kind, "analyzer");
  assert.equal(manifest.analyzer.backend, "local-model");
  assert.equal(manifest.agentTools, undefined, "the agent never calls it: transcript_read does, through the queue");
  const plugin = startPlugin({ FAKE_WHISPER_JSON: join(root, "say.json"), FAKE_WHISPER_LOG: whisperLog(), FAKE_WHISPER_SLEEP_MS: "2000" });
  try {
    const init = await plugin.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.serverInfo.name, "uncut-whisper-transcribe");
    assert.deepEqual((await plugin.request("tools/list", {})).result.tools, []);

    const wav = join(wavDir, "audio.wav");
    const ok = await plugin.call({ audio: wav, model, bin: FAKE, language: "auto", seconds: 5.3 }, { progressToken: 7 });
    assert.ok(!ok.isError, textOf(ok));
    assert.equal(ok.structuredContent.words.length, 16);
    assert.equal(ok.structuredContent.language, "en");
    assert.ok(ok.structuredContent.segments.length > 0);
    assert.match(textOf(ok), /^16 words in \d+ segments \(en\)\.$/);
    assert.deepEqual(plugin.progress.map((p) => [p.progressToken, p.progress, p.total]), [20, 40, 60, 80, 100].map((n) => [7, n, 100]), "MCP progress from whisper's lines");
    const run = whisperRuns().at(-1)!;
    assert.equal(run.argv[run.argv.indexOf("-m") + 1], model);
    assert.equal(run.argv[run.argv.indexOf("-of") + 1], join(wavDir, "transcript"), "whisper's JSON goes next to the WAV, in the folder Uncut owns");

    // Refusals and failures, as sentences.
    assert.match(textOf(await plugin.call({ model })), /Pass audio/);
    assert.match(textOf(await plugin.call({ audio: join(root, "nope.wav"), model, bin: FAKE })), /There's no audio file/);
    assert.match(textOf(await plugin.call({ audio: wav, model, bin: FAKE, language: "english!" })), /isn't a language/);
    const noModel = await plugin.call({ audio: wav, model: join(root, "missing.bin"), bin: FAKE });
    assert.equal(noModel.isError, true);
    assert.match(textOf(noModel), /^whisper-cli couldn't transcribe it: .*failed to (open|initialize)/);
    const noBin = await plugin.call({ audio: wav, model, bin: join(root, "no-whisper-here") });
    assert.equal(noBin.isError, true);
    const unknown = (await plugin.request("tools/call", { name: "whisper_anything", arguments: {} })).result;
    assert.match(textOf(unknown), /No tool whisper_anything/);

    // Cancel mid-whisper: whisper is killed and the call gets no answer.
    const before = whisperRuns().length;
    const cancelId = plugin.nextId();
    let answered = false;
    void plugin.request("tools/call", { name: "transcribe", arguments: { audio: wav, model, bin: FAKE }, _meta: {} }, 10000).then(() => (answered = true), () => {});
    for (let i = 0; i < 100 && whisperRuns().length === before; i++) await sleep(20);
    const victim = whisperRuns().at(-1)!.pid;
    assert.ok(alive(victim), "whisper runs");
    plugin.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: cancelId } })}\n`);
    for (let i = 0; i < 50 && alive(victim); i++) await sleep(20);
    assert.ok(!alive(victim), "whisper was killed");
    await sleep(300);
    assert.equal(answered, false, "a cancelled call gets no answer");

    // stdin closing (Uncut stopping it) ends the plugin.
    plugin.child.stdin!.end();
    assert.equal(await plugin.exited, 0);
  } finally {
    plugin.child.kill("SIGKILL");
  }
});

test("the seam: the analysis queue transcribes through the plugin host (bundled folder), with progress, cached; cancel leaves nothing", { skip, timeout: 60000 }, async () => {
  const discovery = await discoverPlugins([{ source: "bundled", dir: resolve("plugins") }], { moduleIds: new Set(), toolNames: new Set() });
  const found = discovery.plugins.find((p) => p.id === WHISPER_PLUGIN)!;
  assert.ok(found, JSON.stringify(discovery.broken));
  assert.deepEqual(found.warnings, [], "an analyzer without agent tools isn't warned about");
  assert.deepEqual(found.tools, []);
  const host = new PluginHost();
  const project = join(root, "Test.uncut");
  const temps = join(root, "tmp");
  mkdirSync(project, { recursive: true });
  mkdirSync(temps, { recursive: true });
  const env = { FAKE_WHISPER_JSON: process.env.FAKE_WHISPER_JSON, FAKE_WHISPER_LOG: process.env.FAKE_WHISPER_LOG, FAKE_WHISPER_SLEEP_MS: process.env.FAKE_WHISPER_SLEEP_MS };
  Object.assign(process.env, { FAKE_WHISPER_JSON: join(root, "say.json"), FAKE_WHISPER_LOG: whisperLog(), FAKE_WHISPER_SLEEP_MS: "1200" });
  const spawned: Array<string> = [];
  const jobs: Array<ReadonlyArray<{ id: string; phase: string; progress: number }>> = [];
  const q = new AnalysisQueue({
    ffmpeg: async () => ffmpegPath,
    runner: (bin, args, options) => (spawned.push(bin), import("../../apps/server/src/analysis/analysisRunner.ts").then((m) => m.spawnRunner(bin, args, options))),
    whisper: async () => ({ bin: FAKE, model, modelId: "tiny.en" }),
    transcribe: pluginTranscribe((args, { signal, timeoutMs, onProgress }) => host.call(found.spec, WHISPER_TOOL, args, signal, undefined, undefined, { timeoutMs, onProgress })),
    tmpRoot: temps,
    onChange: (j) => jobs.push(j),
  });
  try {
    const file = join(root, "talk.mp4");
    const target: AnalysisTarget = { dir: project, mediaId: "m-talk", path: file, kind: "video", hasAudio: true, seconds: 6 };
    const runsBefore = whisperRuns().length;
    const r = await q.request(target, "transcript");
    assert.ok(r.job);
    const outcome = await r.done;
    assert.equal(outcome.state, "done", JSON.stringify(outcome));
    const result = (outcome as { result: TranscriptResult }).result;
    assert.deepEqual([result.hasAudio, result.language, result.model, result.requestedLanguage, result.words!.length], [true, "en", "tiny.en", "auto", 16]);
    assert.deepEqual(spawned, [ffmpegPath], "Uncut runs ffmpeg; whisper is the plugin's");
    assert.equal(whisperRuns().length, runsBefore + 1);
    const pluginPid = host.processOf(WHISPER_PLUGIN)!.pid;
    assert.ok(pluginPid, "the plugin process ran it");
    assert.ok(jobs.some((list) => list.some((j) => j.id === r.job!.id && j.phase === "running" && j.progress > 0.05)), "the plugin's progress reaches the job");
    assert.ok(existsSync(cacheFile(project, await fingerprint(file), "transcript")), "cached as transcript.json");
    assert.deepEqual(readdirSync(temps).filter((f) => f.startsWith(TEMP_PREFIX)), [], "the temp folder is gone");

    // Cancel mid-whisper: the plugin kills whisper, the job is cancelled, nothing cached or left.
    process.env.FAKE_WHISPER_SLEEP_MS = "20000";
    const other = join(root, "other.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-c", "copy", "-metadata", "title=other", other]);
    const before = whisperRuns().length;
    const c = await q.request({ ...target, mediaId: "m-other", path: other }, "transcript");
    for (let i = 0; i < 200 && whisperRuns().length === before; i++) await sleep(25);
    const victim = whisperRuns().at(-1)!.pid;
    q.cancel(c.job!.id);
    assert.deepEqual(await c.done, { state: "cancelled" });
    for (let i = 0; i < 50 && alive(victim); i++) await sleep(20);
    assert.ok(!alive(victim), "whisper was killed");
    for (let i = 0; i < 20 && readdirSync(temps).some((f) => f.startsWith(TEMP_PREFIX)); i++) await sleep(50);
    assert.deepEqual(readdirSync(temps).filter((f) => f.startsWith(TEMP_PREFIX)), []);
    assert.ok(!existsSync(cacheFile(project, await fingerprint(other), "transcript")));
    assert.equal(host.processOf(WHISPER_PLUGIN)?.pid, pluginPid, "the plugin itself keeps running after a cancel");
  } finally {
    q.shutdown();
    await host.stopAll();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
