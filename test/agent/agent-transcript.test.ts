// Phase 5 chunk 4 (D68) on the bundled server: transcript_read and media_analyze "transcript"
// through the scripted stand-in for claude (helpers/fake-claude.ts) and the real MCP server, with a
// fake whisper-cli (helpers/fake-whisper.ts) first on PATH and the speech model served by a local
// HTTP server (UNCUT_WHISPER_MODEL_URL) as a small fake file, so nothing real is downloaded.
// - The first transcript downloads the model on demand (the job shows it; the agent hears
//   "running", asks again and gets the words), then the words come in project frames, with fillers
//   and pauses (aligned to the silences once loudness ran); a re-ask spawns no whisper.
// - media_analyze ["transcript"] gives a summary; refusals; step labels.
// - setup.check has the whisper row; transcription.* chooses (saved), downloads and cancels models.
// All media is made here with ffmpeg; nothing from the user's footage folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { SAY_TOKENS, whisperJson } from "../helpers/whisper-json.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const FAKE_WHISPER = resolve("test/helpers/fake-whisper.ts");
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
const WAIT_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL_BODY = randomBytes(2 * 1024 * 1024);

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
type Content = Array<{ type: string; text?: string }>;
let root = "";
let footage = "";
let shimDir = "";
let dataDir = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let analysisJobs: ReturnType<Client["subscribe"]>;
let models: ReturnType<Client["subscribe"]>;
let modelServer: HttpServer;
/** The model server holds its answers after the first 64 KB until released. */
let hold: Promise<void> = Promise.resolve();
let release: () => void = () => {};
const modelRequests: Array<string> = [];
let dir = "";
const plan = () => join(root, "plan.json");
const resultLog = () => join(root, "results.jsonl");
const whisperLog = () => join(root, "whisper.log");
const whisperRuns = () => (existsSync(whisperLog()) ? readFileSync(whisperLog(), "utf8").trim().split("\n").filter(Boolean) : []);
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

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-transcript-")));
  mkdirSync(join(root, "projects"));
  footage = join(root, "Footage");
  mkdirSync(footage);
  // A 6 s talk: picture, and a tone with a silent half second (0.7–1.2 s) under the fake transcript's first pause (0.65–1.13 s).
  ff(
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
    "-filter_complex", "sine=frequency=300:sample_rate=48000:duration=0.7,volume=2[a];anullsrc=r=48000:cl=mono:d=0.5[s];sine=frequency=300:sample_rate=48000:duration=4.8,volume=2[b];[a][s][b]concat=n=3:v=0:a=1[out]",
    "-map", "0:v", "-map", "[out]", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    join(footage, "Talk.mp4"),
  );
  ff("-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", join(footage, "Card.png"));
  writeFileSync(join(root, "say.json"), whisperJson(SAY_TOKENS, "en"));
  // PATH shims: whisper-cli is the fake; ffmpeg and ffprobe the real ones.
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "whisper-cli"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WHISPER}" "$@"\n`);
  chmodSync(join(shimDir, "whisper-cli"), 0o755);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  // The model server: any *.bin is the 2 MB fake.
  modelServer = createServer((req, res) => {
    modelRequests.push(req.url ?? "");
    if (!req.url?.endsWith(".bin")) return void res.writeHead(404).end();
    res.writeHead(200, { "content-length": String(MODEL_BODY.length) });
    res.write(MODEL_BODY.subarray(0, 64 * 1024));
    void hold.then(async () => {
      for (let at = 64 * 1024; at < MODEL_BODY.length && !res.destroyed; at += 256 * 1024) {
        res.write(MODEL_BODY.subarray(at, at + 256 * 1024));
        await sleep(30);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => modelServer.listen(0, "127.0.0.1", () => r()));
  dataDir = join(root, "data");
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  server = await startServer({
    env: {
      PATH: `${shimDir}:${dirname(FFMPEG!)}:${process.env.PATH}`,
      UNCUT_DATA_DIR: dataDir,
      UNCUT_CLAUDE: FAKE,
      UNCUT_ANALYZE_WAIT_MS: String(WAIT_MS),
      UNCUT_WHISPER_MODEL_URL: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/models`,
      FAKE_WHISPER_JSON: join(root, "say.json"),
      FAKE_WHISPER_LOG: whisperLog(),
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  analysisJobs = client.subscribe("analysis.jobs");
  models = client.subscribe("transcription.state");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Transcript test" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
  const { turn } = await ask("import the footage", [{ tool: "media_import", args: { path: footage } }]);
  assert.equal(turn.status, "done", turn.error);
});
after(async () => {
  release();
  client?.close();
  await server?.stop();
  killAll();
  modelServer?.closeAllConnections();
  modelServer?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the first transcript downloads the model on demand (running meanwhile), then the words in frames; a re-ask runs no whisper", { skip, timeout: 120000 }, async () => {
  await models.until((s) => s.selected === "large-v3-turbo-q5_0");
  assert.equal(models.values.at(-1).models.find((m: any) => m.id === "large-v3-turbo-q5_0").installed, false);
  assert.deepEqual(modelRequests, [], "nothing downloaded at start");
  hold = new Promise<void>((r) => (release = r));
  const t0 = Date.now();
  const first = await ask("what does the talk say?", [{ tool: "transcript_read", args: { media: "m-talk" } }]);
  assert.ok(Date.now() - t0 >= WAIT_MS - 200, "it waited");
  const pending = jsonOf(first.results[0]!);
  assert.equal(pending.transcript.state, "running", JSON.stringify(pending));
  assert.match(pending.transcript.stage, /downloading the speech model/);
  assert.match(pending.note, /downloading the speech model.*Call transcript_read again with the same arguments/);
  assert.deepEqual(modelRequests, ["/models/ggml-large-v3-turbo-q5_0.bin"]);
  // The Library sees the job downloading; Setup sees the download.
  await analysisJobs.until((list) => list.some((j: any) => j.mediaId === "m-talk" && j.analyzer === "transcript" && j.stage === "model"));
  await models.until((s) => s.downloads.some((d: any) => d.model === "large-v3-turbo-q5_0" && d.phase === "downloading"));
  assert.equal(whisperRuns().length, 0);
  release();
  await models.until((s) => s.models.some((m: any) => m.id === "large-v3-turbo-q5_0" && m.installed), 20000);
  assert.ok(readFileSync(join(dataDir, "models", "ggml-large-v3-turbo-q5_0.bin")).equals(MODEL_BODY));
  assert.deepEqual(readdirSync(join(dataDir, "models")), ["ggml-large-v3-turbo-q5_0.bin"], "no .part left");

  // The job finishes in the background; the next turn is then a cache hit, whatever the load.
  await analysisJobs.until((list) => list.some((j: any) => j.mediaId === "m-talk" && j.analyzer === "transcript" && j.phase === "done"), 30000);
  const second = await ask("and now?", [
    { tool: "transcript_read", args: { media: "m-talk" } },
    { tool: "transcript_read", args: { media: "m-talk", format: "words", range: { start: 60, end: 100 } } },
    { tool: "transcript_read", args: { media: "m-talk", language: "en" } },
  ]);
  assert.equal(second.turn.status, "done", second.turn.error);
  assert.deepEqual(
    second.turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text),
    ["Read the transcript of Talk.mp4", "Read the transcript of Talk.mp4 (frames 60–100)", "Read the transcript of Talk.mp4"],
  );
  const out = jsonOf(second.results[0]!);
  assert.equal(out.state, "done", JSON.stringify(out));
  assert.equal(out.media, "m-talk");
  assert.equal(out.language, "en");
  assert.equal(out.model, "large-v3-turbo-q5_0");
  assert.equal(out.words, 16);
  assert.equal(out.text.split("\n")[0], "w0 [1–58] Hello world, (pause 0.5 s) this is a test. (pause 0.4 s)");
  // "dog." ends with its sentence's segment (5.24 s, the file is 6 s), as cuts see it (D74).
  assert.match(out.text.split("\n")[1], /^w6 \[68–158\] \{Um,\} the quick/);
  assert.deepEqual(out.fillers, [{ i: 6, n: 1, text: "Um,", start: 68, end: 71, kind: "hesitation" }]);
  assert.equal(out.pauses[0].silent, undefined, "no loudness analysis yet");
  assert.match(out.note, /Frames are project frames of the media/);
  assert.equal(whisperRuns().length, 1, "one whisper run");
  const words = jsonOf(second.results[1]!);
  assert.deepEqual(words.list.map((w: any) => [w.text, w.start, w.end]), [["Um,", 68, 71], ["the", 75, 82], ["quick", 81, 87]]);
  assert.equal(words.cached, true);
  assert.equal(jsonOf(second.results[2]!).cached, true, "the language it's in: cached");
  assert.equal(whisperRuns().length, 1, "no whisper for cached answers");
  const cache = (readdirSync(join(dir, ".cache", "analysis"), { recursive: true }) as Array<string>).filter((f) => f.endsWith(".json"));
  assert.deepEqual(cache.map((f) => f.replace(/^[0-9a-f]{32}\//, "")), ["transcript.json"]);

  // Once the loudness analysis is cached, pauses say whether it's silent there (from its silences).
  const third = await ask("measure, then read again", [
    { tool: "media_analyze", args: { media: "m-talk", analyzers: ["silence"] } },
    { tool: "transcript_read", args: { media: "m-talk" } },
    { tool: "media_analyze", args: { media: "m-talk", analyzers: ["transcript"] } },
  ]);
  assert.equal(third.turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text)[2], "Transcribed Talk.mp4");
  const aligned = jsonOf(third.results[1]!);
  const pause = aligned.pauses.find((p: any) => p.after === 1);
  assert.equal(pause.silent, true, JSON.stringify(aligned.pauses));
  assert.ok(Math.abs(pause.startSeconds - 0.7) < 0.06 && Math.abs(pause.endSeconds - 1.2) < 0.06, JSON.stringify(pause));
  assert.ok(aligned.pauses.filter((p: any) => p.after !== 1).every((p: any) => p.silent === false));
  const summary = jsonOf(third.results[2]!);
  assert.equal(summary.transcript.state, "done");
  assert.equal(summary.transcript.cached, true);
  assert.deepEqual([summary.transcript.words, summary.transcript.fillers.hesitation, summary.transcript.language], [16, 1, "en"]);
  assert.match(summary.note, /transcript_read gives the words/);
  assert.equal(whisperRuns().length, 1);
  assert.equal(modelRequests.length, 1, "the model was downloaded once");
});

test("refusals: unknown media, an image, a bad language, format or from", { skip, timeout: 60000 }, async () => {
  const { results } = await ask("bad asks", [
    { tool: "transcript_read", args: { media: "m-nope" } },
    { tool: "transcript_read", args: { media: "m-card" } },
    { tool: "transcript_read", args: { media: "m-talk", language: "Polish" } },
    { tool: "transcript_read", args: { media: "m-talk", format: "srt" } },
    { tool: "transcript_read", args: { media: "m-talk", from: -1 } },
  ]);
  const [nope, card, lang, format, from] = results;
  for (const r of results) assert.ok(r.isError, textOf(r));
  assert.match(textOf(nope!), /no media "m-nope".*m-talk/);
  assert.match(textOf(card!), /still image: there's no sound/);
  assert.match(textOf(lang!), /language must be a language code/);
  assert.match(textOf(format!), /format must be "text"/);
  assert.match(textOf(from!), /from must be a word index/);
  assert.equal(whisperRuns().length, 1);
});

test("setup.check has the whisper row; transcription.* chooses a model (saved), downloads and cancels", { skip, timeout: 60000 }, async () => {
  const checks = await client.ok("setup.check");
  const row = checks.find((c: any) => c.id === "whisper");
  assert.deepEqual(row, { id: "whisper", name: "whisper.cpp", status: "ready", optional: true, version: "1.9.5", path: join(shimDir, "whisper-cli"), detail: "Transcribes speech on this Mac." });

  const unknown = await client.fail("transcription.selectModel", { model: "huge" });
  assert.equal(unknown.reason, "unknown-model");
  await client.ok("transcription.selectModel", { model: "base" });
  await models.until((s) => s.selected === "base");
  assert.equal(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).whisperModel, "base");

  // Download from Setup: the chosen model; cancel mid-way leaves nothing.
  hold = new Promise<void>((r) => (release = r));
  await client.ok("transcription.download", {});
  await models.until((s) => s.downloads.some((d: any) => d.model === "base" && d.phase === "downloading"));
  await client.ok("transcription.cancelDownload", { model: "base" });
  await models.until((s) => s.downloads.some((d: any) => d.model === "base" && d.phase === "cancelled"));
  release();
  await sleep(100);
  assert.deepEqual(readdirSync(join(dataDir, "models")), ["ggml-large-v3-turbo-q5_0.bin"]);
  // Again, to the end.
  await client.ok("transcription.download", { model: "base" });
  await models.until((s) => s.models.some((m: any) => m.id === "base" && m.installed), 20000);
  assert.deepEqual(readdirSync(join(dataDir, "models")).sort(), ["ggml-base.bin", "ggml-large-v3-turbo-q5_0.bin"]);
  const bad = await client.fail("transcription.download", { model: "huge" });
  assert.equal(bad.reason, "unknown-model");
});
