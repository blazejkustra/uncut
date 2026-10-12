// Phase 5 chunk 4 (D68), in process: the transcript analyzer with a fake whisper-cli
// (helpers/fake-whisper.ts, spawned for real, writing JSON shaped like whisper.cpp 1.9.5's -ojf).
// - Parsing: tokens into words (punctuation doesn't stretch a word over the pause after it),
//   special tokens and annotations dropped, a Polish letter split over two tokens, monotonic times.
// - Fillers (English and Polish lists, each only for its language) and pauses (aligned to silences).
// - Through the queue: transcript.json by content; a re-ask spawns nothing; another language reruns;
//   cancel mid-whisper leaves no temp WAV and no cache; missing binary / model / JSON fail clearly;
//   the model download shows as the job's stage; no sound = no job.
// - transcript_read's answer: frames, text lines, words, paging.
// ffmpeg makes the sound here (lavfi); nothing from ~/Documents/devrel/drone, no real model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AnalysisQueue, cacheFile, fingerprint, parseAnalyzers, spawnRunner, type AnalysisTarget, type Runner } from "../apps/server/src/analysis.ts";
import { fillersOf, isTranscriptResult, parseWhisperJson, pausesOf, sweepStaleTranscriptTemp, TEMP_PREFIX, type TranscriptResult } from "../apps/server/src/transcription.ts";
import { transcriptOut, transcriptSummary } from "../apps/server/src/agentTranscript.ts";
import { NO_WHISPER } from "../apps/server/src/whisper.ts";
import { SAY_TOKENS, whisperJson, type Token } from "./helpers/whisper-json.ts";

type AnalysisJob = ReturnType<AnalysisQueue["list"]>[number];

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
let project = "";
let temps = "";
let model = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const whisperLog = () => join(root, "whisper.log");
const whisperRuns = () => (existsSync(whisperLog()) ? readFileSync(whisperLog(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: Array<string>; env: Array<string> }) : []);
const target = (path: string, mediaId = "m-talk", extra: Partial<AnalysisTarget> = {}): AnalysisTarget => ({ dir: project, mediaId, path, kind: "video", hasAudio: true, seconds: 6, ...extra });
const resolver = (bin = FAKE) => async () => ({ bin, model, modelId: "tiny.en" });
const queue = (options: Partial<ConstructorParameters<typeof AnalysisQueue>[0]> = {}, jobs?: Array<ReadonlyArray<AnalysisJob>>) =>
  new AnalysisQueue({ ffmpeg: async () => ffmpegPath, whisper: resolver(), tmpRoot: temps, onChange: (j) => jobs?.push(j), ...options });
const leftovers = () => readdirSync(temps).filter((f) => f.startsWith(TEMP_PREFIX));

before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-transcription-")));
  project = join(root, "Test.uncut");
  temps = join(root, "tmp");
  mkdirSync(project);
  mkdirSync(temps);
  model = join(root, "models", "ggml-tiny.en.bin");
  mkdirSync(join(root, "models"));
  writeFileSync(model, "not really a model");
  writeFileSync(join(root, "say.json"), whisperJson(SAY_TOKENS, "en"));
  process.env.FAKE_WHISPER_JSON = join(root, "say.json");
  process.env.FAKE_WHISPER_LOG = whisperLog();
  // A 6 s clip: picture and a tone (stands in for speech; the fake whisper doesn't listen).
  ff("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "talk.mp4"));
  ff("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "mute.mp4"));
});
after(() => {
  delete process.env.FAKE_WHISPER_JSON;
  delete process.env.FAKE_WHISPER_LOG;
  delete process.env.FAKE_WHISPER_SLEEP_MS;
  if (root) rmSync(root, { recursive: true, force: true });
});

test("analyzers: transcript (and transcription) name the transcript job", () => {
  assert.deepEqual(parseAnalyzers(["transcript"]), { analyzers: ["transcript"] });
  assert.deepEqual(parseAnalyzers(["transcription", "silence"]), { analyzers: ["transcript", "loudness"] });
  assert.deepEqual(parseAnalyzers(undefined), { analyzers: ["loudness"] }, "still loudness by default");
});

test("parsing whisper's JSON: words from tokens, punctuation doesn't swallow a pause, specials and annotations dropped, Polish bytes joined", () => {
  const say = parseWhisperJson(whisperJson(SAY_TOKENS).toString("latin1"), 5.3);
  assert.equal(say.language, "en");
  assert.deepEqual(say.words.map((w) => w.text), ["Hello", "world,", "this", "is", "a", "test.", "Um,", "the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog."]);
  assert.deepEqual(say.segments.map((s) => [s.text, s.words]), [["Hello world, this is a test.", [0, 6]], ["Um, the quick brown fox jumps over the lazy dog.", [6, 16]]]);
  // "world" ends at 0.65 s: the comma (timed at 1.12, where "this" starts) doesn't stretch it.
  assert.deepEqual(say.words[1], { text: "world,", start: 0.46, end: 0.65, p: 0.44 });
  assert.equal(say.words[5]!.end, 1.92, "test. ends with test, not at the full stop's 2.22");
  for (let i = 1; i < say.words.length; i++) assert.ok(say.words[i]!.start >= say.words[i - 1]!.start && say.words[i]!.end >= say.words[i]!.start);

  // Polish, with "ś" split over two tokens and "ć" as a word piece; an annotation segment and a
  // (laughs) inside a sentence; a word timed past the end and one going back in time.
  const sz = Buffer.from(" Cześć", "utf8");
  const split = sz.indexOf(0xc5) + 1; // between the two bytes of ś
  const pl: Array<Array<Token>> = [
    [[" [BLANK_AUDIO]", 0, 900]],
    [
      [sz.subarray(0, split), 1000, 1200, 0.8],
      [sz.subarray(split), 1200, 1400, 0.6],
      [",", 1400, 1400],
      [" no", 1500, 1700],
      [",", 1700, 1700],
      [" to", 1800, 1900],
      [" jest", 1900, 2200],
      [" (", 2300, 2300],
      ["laughs", 2300, 2600],
      [")", 2600, 2600],
      [" żółw", 2700, 2650],
      [".", 3000, 3000],
    ],
    [[" Yyy", 3500, 3900], [" znaczy", 4100, 4500], [" koniec", 6900, 7400]],
  ];
  const r = parseWhisperJson(whisperJson(pl, "pl").toString("latin1"), 7);
  assert.equal(r.language, "pl");
  assert.deepEqual(r.words.map((w) => w.text), ["Cześć,", "no,", "to", "jest", "żółw.", "Yyy", "znaczy", "koniec"]);
  assert.equal(r.segments.length, 2, "the [BLANK_AUDIO] segment is gone");
  assert.equal(r.segments[0]!.text, "Cześć, no, to jest (laughs) żółw.", "the segment keeps its text");
  assert.deepEqual([r.words[0]!.start, r.words[0]!.end, r.words[0]!.p], [1, 1.4, 0.6], "a word spans its pieces; p is the lowest");
  assert.deepEqual([r.words[4]!.start, r.words[4]!.end], [2.7, 2.7], "an end before the start is the start");
  assert.deepEqual([r.words[7]!.start, r.words[7]!.end], [6.9, 7], "kept within the file");
  assert.throws(() => parseWhisperJson("{nope", 1), /can't read/);
});

test("fillers: hesitations and discourse words, each list only for its language", () => {
  const w = (s: string) => s.split(" ").map((text) => ({ text }));
  assert.deepEqual(fillersOf(w("Um, so you know, I think uh it works."), "en"), [
    { i: 0, n: 1, kind: "hesitation" },
    { i: 2, n: 2, kind: "maybe" },
    { i: 6, n: 1, kind: "hesitation" },
  ]);
  assert.deepEqual(fillersOf(w("No, I mean no."), "en"), [{ i: 1, n: 2, kind: "maybe" }], "English no is a word, not a filler");
  assert.deepEqual(fillersOf(w("Yyy no, to jest znaczy, dobre. Nie no tak"), "pl"), [
    { i: 0, n: 1, kind: "hesitation" },
    { i: 1, n: 1, kind: "maybe" },
    { i: 4, n: 1, kind: "maybe" },
  ], "Polish no only standing apart (a comma after it, or a sentence before)");
  assert.deepEqual(fillersOf(w("Um, yyy"), "de"), [], "no list for other languages");
  assert.deepEqual(fillersOf(w("Yyy um"), undefined), []);
});

test("pauses: gaps of 0.3 s or more, the edges, aligned to the loudness silences when known", () => {
  const words = [
    { start: 0.5, end: 1.0 },
    { start: 1.1, end: 1.6 },
    { start: 2.4, end: 3.0 },
    { start: 3.2, end: 3.5 },
  ];
  assert.deepEqual(pausesOf(words, 4), [
    { start: 0, end: 0.5, after: -1, edge: "start" },
    { start: 1.6, end: 2.4, after: 1 },
    { start: 3.5, end: 4, after: 3, edge: "end" },
  ]);
  // The silence (accurate) moves the pause's edges; a gap with no silence under it is not silent;
  // a short word gap over a long silence becomes a pause. A silence that starts before a word's end
  // (in its quiet decay) doesn't take the word: the pause starts at the word's end (D74).
  const silences = [
    { start: 0, end: 0.45 },
    { start: 1.7, end: 2.3 },
    { start: 2.95, end: 3.3 },
  ];
  assert.deepEqual(pausesOf(words, 4, silences), [
    { start: 0, end: 0.45, after: -1, edge: "start", silent: true },
    { start: 1.7, end: 2.3, after: 1, silent: true },
    { start: 3.0, end: 3.3, after: 2, silent: true },
    { start: 3.5, end: 4, after: 3, edge: "end", silent: false },
  ]);
});

test("through the queue: one ffmpeg + whisper run, cached as transcript.json; a re-ask runs nothing; the temp folder is gone", { skip, timeout: 60000 }, async () => {
  const calls: Array<string> = [];
  const runner: Runner = (bin, args, options) => (calls.push(bin), spawnRunner(bin, args, options));
  const jobs: Array<ReadonlyArray<AnalysisJob>> = [];
  const q = queue({ runner }, jobs);
  const file = join(root, "talk.mp4");
  // Slow enough for progress updates (they're published at most every 250 ms).
  process.env.FAKE_WHISPER_SLEEP_MS = "1200";
  const r = await q.request(target(file), "transcript");
  assert.ok(r.job, "a job");
  const outcome = await r.done;
  delete process.env.FAKE_WHISPER_SLEEP_MS;
  assert.equal(outcome.state, "done", JSON.stringify(outcome));
  const result = (outcome as { result: TranscriptResult }).result;
  assert.equal(result.hasAudio, true);
  assert.equal(result.language, "en");
  assert.equal(result.model, "tiny.en");
  assert.equal(result.requestedLanguage, "auto");
  assert.ok(Math.abs(result.seconds! - 6) < 0.1, String(result.seconds));
  assert.equal(result.words!.length, 16);
  assert.deepEqual(calls, [ffmpegPath, FAKE], "ffmpeg, then whisper");
  const run = whisperRuns().at(-1)!;
  for (const flag of ["-ojf", "-pp", "-np"]) assert.ok(run.argv.includes(flag), flag);
  assert.equal(run.argv[run.argv.indexOf("-l") + 1], "auto");
  assert.equal(run.argv[run.argv.indexOf("-m") + 1], model);
  assert.deepEqual(run.env, [], "no ANTHROPIC_* handed on");
  assert.ok(jobs.some((list) => list.some((j) => j.id === r.job!.id && j.phase === "running" && j.progress > 0.05)), "progress from whisper's lines");
  assert.deepEqual(leftovers(), [], "the temp WAV folder is removed");
  const fp = await fingerprint(file);
  const cached = JSON.parse(readFileSync(cacheFile(project, fp, "transcript"), "utf8"));
  assert.equal(cached.analyzer, "transcript");
  assert.equal(cached.version, 1);
  assert.ok(isTranscriptResult(cached.result));

  // The re-ask: no job, nothing spawned. Naming the language it's in is a hit too.
  const again = await q.request(target(file, "m-talk-2"), "transcript");
  assert.equal(again.job, undefined);
  assert.equal(((await again.done) as { cached: boolean }).cached, true);
  const en = await q.request(target(file), "transcript", { language: "en" });
  assert.equal(en.job, undefined);
  assert.equal(calls.length, 2, "no ffmpeg or whisper for cached answers");

  // Another language is another transcript: it runs (whisper told -l pl) and replaces the cache.
  const pl = await q.request(target(file), "transcript", { language: "pl" });
  assert.ok(pl.job);
  const plOut = (await pl.done) as { state: string; result: TranscriptResult };
  assert.equal(plOut.state, "done");
  assert.equal(plOut.result.language, "pl");
  assert.equal(plOut.result.requestedLanguage, "pl");
  assert.equal(whisperRuns().at(-1)!.argv[whisperRuns().at(-1)!.argv.indexOf("-l") + 1], "pl");
  assert.equal(calls.length, 4);
  // A broken cache file is a miss.
  writeFileSync(cacheFile(project, fp, "transcript"), JSON.stringify({ ...cached, result: { hasAudio: true, words: "nope" } }));
  const redo = await q.request(target(file), "transcript");
  assert.ok(redo.job, "redone");
  assert.equal((await redo.done).state, "done");
});

test("no sound: images and silent clips get no job; a file ffmpeg finds no audio in is a result, not an error", { skip, timeout: 60000 }, async () => {
  const q = queue();
  const image = await q.request(target(join(root, "talk.mp4"), "m-img", { kind: "image" }), "transcript");
  assert.equal(image.job, undefined);
  assert.deepEqual(await image.done, { state: "done", result: { hasAudio: false }, cached: false });
  const muted = await q.request(target(join(root, "mute.mp4"), "m-mute", { hasAudio: false }), "transcript");
  assert.equal(muted.job, undefined);
  const unknown = await q.request(target(join(root, "mute.mp4"), "m-mute", { hasAudio: undefined }), "transcript");
  assert.ok(unknown.job);
  const out = await unknown.done;
  assert.equal(out.state, "done", JSON.stringify(out));
  assert.deepEqual((out as { result: TranscriptResult }).result, { hasAudio: false });
  assert.deepEqual(leftovers(), []);
});

test("cancel mid-whisper: whisper is killed, the temp WAV is removed, nothing is cached", { skip, timeout: 60000 }, async () => {
  process.env.FAKE_WHISPER_SLEEP_MS = "20000";
  try {
    const q = queue();
    const file = join(root, "cancel.mp4");
    ff("-i", join(root, "talk.mp4"), "-c", "copy", "-metadata", "title=cancel", file);
    const r = await q.request(target(file, "m-cancel"), "transcript");
    // Wait until whisper runs (the WAV exists in the temp folder).
    for (let i = 0; i < 100 && !leftovers().some((d) => existsSync(join(temps, d, "audio.wav"))); i++) await sleep(50);
    const dir = leftovers()[0];
    assert.ok(dir && existsSync(join(temps, dir, "audio.wav")), "the WAV is there while whisper runs");
    await sleep(300);
    q.cancel(r.job!.id);
    assert.deepEqual(await r.done, { state: "cancelled" });
    for (let i = 0; i < 20 && leftovers().length; i++) await sleep(50);
    assert.deepEqual(leftovers(), [], "the temp folder is gone");
    assert.ok(!existsSync(cacheFile(project, await fingerprint(file), "transcript")));
  } finally {
    delete process.env.FAKE_WHISPER_SLEEP_MS;
  }
});

test("clear failures: no whisper-cli, a model that can't be had, whisper writing nothing; the temp folder goes each time", { skip, timeout: 60000 }, async () => {
  const file = join(root, "talk.mp4");
  const fail = async (q: AnalysisQueue, language?: string) => {
    const r = await q.request(target(file, "m-fail"), "transcript", { language: language ?? "de" });
    const out = await r.done;
    assert.equal(out.state, "failed", JSON.stringify(out));
    return (out as { error: string }).error;
  };
  assert.equal(await fail(queue({ whisper: async () => Promise.reject(new Error(NO_WHISPER)) })), NO_WHISPER);
  assert.match(NO_WHISPER, /brew install whisper-cpp/);
  assert.match(await fail(queue({ whisper: async () => Promise.reject(new Error("The speech model (Large v3 Turbo, 574 MB) couldn't be downloaded: The model server answered 404.")) })), /speech model .* couldn't be downloaded: .*404/);
  // whisper-cli exits 3 when it can't load the model and writes no JSON: the failure, in its own words.
  const noModel = await fail(queue({ whisper: async () => ({ bin: FAKE, model: join(root, "models", "missing.bin"), modelId: "base" }) }));
  assert.match(noModel, /^whisper-cli couldn't transcribe it: .*failed to (open|initialize)/);
  assert.match(await fail(queue({ ffmpeg: async () => undefined })), /ffmpeg isn't installed, and Uncut needs it to transcribe/);
  assert.match(await fail(queue({ whisper: undefined })), /isn't set up/);
  assert.deepEqual(leftovers(), []);
});

test("the model download shows as the job's stage, then transcription; one transcript runs at a time", { skip, timeout: 60000 }, async () => {
  const jobs: Array<ReadonlyArray<AnalysisJob>> = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const q = queue(
    {
      whisper: async ({ onDownload }) => {
        onDownload?.(0.4);
        await gate;
        return { bin: FAKE, model, modelId: "base" };
      },
    },
    jobs,
  );
  const a = join(root, "a.mp4");
  const b = join(root, "b.mp4");
  ff("-i", join(root, "talk.mp4"), "-c", "copy", "-metadata", "title=a", a);
  ff("-i", join(root, "talk.mp4"), "-c", "copy", "-metadata", "title=b", b);
  const ra = await q.request(target(a, "m-a"), "transcript", { language: "fr" });
  const rb = await q.request(target(b, "m-b"), "transcript", { language: "fr" });
  await sleep(100);
  assert.deepEqual([q.job(ra.job!.id)!.phase, q.job(ra.job!.id)!.stage, q.job(ra.job!.id)!.progress], ["running", "model", 0.4]);
  assert.equal(q.job(rb.job!.id)!.phase, "queued", "the second transcript waits for the first");
  release();
  assert.equal((await ra.done).state, "done");
  assert.ok(jobs.some((list) => list.some((j) => j.id === ra.job!.id && j.phase === "running" && j.stage === undefined && j.progress < 0.4)), "back to transcription progress");
  assert.equal((await rb.done).state, "done");
  assert.equal(q.job(ra.job!.id)!.stage, undefined);
});

test("transcript_read's answer: words in project frames, text lines with fillers and pauses, words format, range and paging", () => {
  const { words, segments, language } = parseWhisperJson(whisperJson(SAY_TOKENS).toString("latin1"), 5.3);
  const result: TranscriptResult = { hasAudio: true, seconds: 5.3, language, model: "tiny.en", segments, words };
  const out = transcriptOut(result, { cached: false, fps: 30, length: 159 }) as Record<string, any>;
  assert.equal(out.words, 16);
  assert.deepEqual(out.shown, { from: 0, to: 15 });
  const lines = (out.text as string).split("\n");
  assert.deepEqual(lines, [
    "w0 [1–58] Hello world, (pause 0.5 s) this is a test. (pause 0.4 s)",
    // "the" was heard as a timestamp (4.46–4.46): it gets 0.1 s on each side (D74), so the gap before it is 0.2 s.
    "w6 [68–144] {Um,} the quick (pause 0.5 s) brown fox jumps over the lazy dog. (pause 0.5 s)",
  ]);
  assert.deepEqual(out.fillers, [{ i: 6, n: 1, text: "Um,", start: 68, end: 71, kind: "hesitation" }]);
  // Pauses inward: from the first frame inside the gap to the frame after it ends.
  assert.deepEqual(out.pauses[0], { start: 20, end: 33, startSeconds: 0.65, endSeconds: 1.13, after: 1 });
  assert.equal(out.next, undefined);

  // Words: the frame a word starts in, and the frame after it ends (covers the word).
  const w = transcriptOut(result, { cached: true, fps: 30, length: 159, format: "words" }) as Record<string, any>;
  assert.deepEqual(w.list[0], { i: 0, text: "Hello", start: 1, end: 14 });
  assert.deepEqual(w.list[1], { i: 1, text: "world,", start: 13, end: 20, unsure: true });
  assert.deepEqual(w.list[6], { i: 6, text: "Um,", start: 68, end: 71, filler: "hesitation" });
  assert.equal(w.text, undefined);

  // Range: only words overlapping frames [60, 100); paging: 3 words at a time, then from next.from.
  const ranged = transcriptOut(result, { cached: true, fps: 30, length: 159, range: { start: 60, end: 100 }, format: "words" }) as Record<string, any>;
  assert.deepEqual(ranged.list.map((x: { text: string }) => x.text), ["Um,", "the", "quick"]);
  const page1 = transcriptOut(result, { cached: true, fps: 30, length: 159, maxWords: 3 }) as Record<string, any>;
  assert.deepEqual(page1.shown, { from: 0, to: 2 });
  assert.equal(page1.next.from, 3);
  assert.match(page1.text, /^w0 \[1–\d+\] Hello world, \(pause 0\.5 s\) this$/);
  const page2 = transcriptOut(result, { cached: true, fps: 30, length: 159, maxWords: 3, from: page1.next.from }) as Record<string, any>;
  assert.deepEqual(page2.shown, { from: 3, to: 5 });
  assert.match(page2.text, /^w3 \[/);
  const end = transcriptOut(result, { cached: true, fps: 30, length: 159, from: 99 }) as Record<string, any>;
  assert.equal(end.shown, null);
  assert.match(end.note, /No words/);

  // With loudness silences: pauses say silent; no sound and no speech have their own answers.
  const silent = transcriptOut(result, { cached: true, fps: 30, length: 159, silences: [{ start: 0.7, end: 1.1 }] }) as Record<string, any>;
  assert.deepEqual(silent.pauses[0], { start: 21, end: 33, startSeconds: 0.7, endSeconds: 1.1, after: 1, silent: true });
  assert.equal(silent.pauses[1].silent, false);
  assert.equal((transcriptOut({ hasAudio: false }, { cached: false, fps: 30, length: 10 }) as Record<string, any>).hasAudio, false);
  assert.match((transcriptOut({ ...result, words: [], segments: [] }, { cached: false, fps: 30, length: 10 }) as Record<string, any>).note, /No speech/);
  const summary = transcriptSummary(result, true) as Record<string, any>;
  // 4 pauses: the 0.3 s one before "the" (a timestamp, given 0.2 s) is gone (D74).
  assert.deepEqual([summary.words, summary.segments, summary.fillers, summary.pauses, summary.language], [16, 2, { hesitation: 1, maybe: 0 }, 4, "en"]);
  assert.match(summary.opening, /^Hello world, this is a test\. Um,/);
});

test("the agent's tool: transcript_read is offered over MCP with its schema; the turn card's words", async () => {
  const { mcpTools, stepLabel, TOOL_NAMES, SYSTEM_PROMPT } = await import("../apps/server/src/agentTools.ts");
  assert.ok((TOOL_NAMES as ReadonlyArray<string>).includes("transcript_read"));
  const tool = mcpTools().find((t) => t.name === "transcript_read")!;
  assert.deepEqual(Object.keys((tool.inputSchema as { properties: object }).properties).sort(), ["format", "from", "language", "media", "range"]);
  assert.match(SYSTEM_PROMPT, /transcript_read gives what's said/);
  assert.doesNotMatch(SYSTEM_PROMPT, /Transcripts and beats come later/);
  assert.equal(stepLabel("transcript_read", { media: "m-talk" }), "Read the transcript of m-talk");
  assert.equal(stepLabel("transcript_read", { media: "m-talk", from: 1500 }), "Read more of the transcript of m-talk");
  assert.equal(stepLabel("transcript_read", { media: "m-talk", range: { start: 0, end: 300 } }), "Read the transcript of m-talk (frames 0–300)");
  assert.equal(stepLabel("media_analyze", { media: "m-talk", analyzers: ["transcript"] }), "Transcribed m-talk");
  assert.equal(stepLabel("media_analyze", { media: "m-talk", analyzers: ["transcript", "loudness"] }), "Analysed m-talk");
});

test("temp folders carry the server's pid; a sweep removes a dead server's (and old unmarked ones), never a live one's; control characters don't break the JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-sweep-"));
  try {
    for (const name of [`uncut-transcript-${process.pid}-aaaaaa`, "uncut-transcript-999999-bbbbbb", "uncut-transcript-cccccc", "uncut-export-999999-dddddd", "other"]) mkdirSync(join(dir, name));
    await sweepStaleTranscriptTemp(dir, Date.now() + 2 * 3600_000);
    assert.deepEqual(readdirSync(dir).sort(), [`uncut-transcript-${process.pid}-aaaaaa`, "other", "uncut-export-999999-dddddd"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const json = whisperJson([[[" Hi\u0001", 0, 300], [" there", 300, 600]]]).toString("latin1").replaceAll("\\u0001", "\u0001");
  assert.deepEqual(parseWhisperJson(json, 1).words.map((w) => w.text), ["Hi", "there"]);
});
