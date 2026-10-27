// Long takes phrase by phrase: the splitter on synthetic sound (tones and silences), the merge's
// offsets, the loop guard, the language check, names from the brief, and a long take through the
// analysis queue with the fake whisper-cli (one run, one -f/-of pair per phrase).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AnalysisQueue, type AnalysisTarget } from "../../apps/server/src/analysis/analysis.ts";
import { correctNames, namesIn } from "../../apps/server/src/analysis/names.ts";
import {
  guardPhrase,
  mainLanguage,
  mergePhrases,
  pcmLevels,
  pcmWav,
  readPcmWav,
  splitPhrases,
  transcribeByPhrases,
  type Pcm,
} from "../../apps/server/src/analysis/phrases.ts";
import { transcribeDirect, type Speech, type SpeechRequest, type Transcribe, type TranscriptResult } from "../../apps/server/src/analysis/transcription.ts";
import { transcriptOut } from "../../apps/server/src/agent/agentTranscript.ts";
import { SAY_TOKENS, whisperJson } from "../helpers/whisper-json.ts";

const RATE = 16000;
const FAKE = resolve("test/helpers/fake-whisper.ts");
const ffmpegPath = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();

/** Sound made of pieces: a tone at `level` (0–1) or quiet (a faint hiss), each `seconds` long. */
function synth(pieces: ReadonlyArray<{ readonly seconds: number; readonly level: number }>): Pcm {
  const total = Math.round(pieces.reduce((s, p) => s + p.seconds, 0) * RATE);
  const data = Buffer.alloc(total * 2);
  let at = 0;
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.0005;
  for (const p of pieces) {
    const n = Math.round(p.seconds * RATE);
    for (let i = 0; i < n && at < total; i++, at++)
      data.writeInt16LE(Math.round((p.level * Math.sin((2 * Math.PI * 220 * at) / RATE) + noise()) * 32767), at * 2);
  }
  return { rate: RATE, data };
}
const tone = (seconds: number, level = 0.3) => ({ seconds, level });
const quiet = (seconds: number) => ({ seconds, level: 0 });

/** A Speech whose words are `texts`, one every `step` seconds from `start`, one segment per line. */
function speech(
  lines: ReadonlyArray<string>,
  { start = 0.1, step = 0.4, p = 0.9, language }: { start?: number; step?: number; p?: number; language?: string } = {},
): Speech {
  const words: Speech["words"] = [];
  const segments: Speech["segments"] = [];
  let t = start;
  for (const line of lines) {
    const first = words.length;
    for (const text of line.split(" ")) {
      words.push({ text, start: Math.round(t * 1000) / 1000, end: Math.round((t + step * 0.8) * 1000) / 1000, p });
      t += step;
    }
    segments.push({ start: words[first]!.start, end: words.at(-1)!.end, text: line, words: [first, words.length] });
  }
  return { ...(language ? { language } : {}), words, segments };
}

const near = (a: number, b: number, tolerance = 0.06) => Math.abs(a - b) <= tolerance;

test("the splitter: phrases at the silences, short gaps kept inside, clicks ignored, a long phrase split at its deepest dip, padded", () => {
  const pcm = synth([
    quiet(1),
    tone(2),
    quiet(1),
    tone(1.5),
    quiet(0.3),
    tone(1.5),
    quiet(2),
    { seconds: 0.08, level: 0.5 },
    quiet(2),
    tone(12),
    { seconds: 0.4, level: 0.05 },
    tone(12),
    quiet(1),
  ]);
  const spans = splitPhrases(pcmLevels(pcm));
  assert.equal(spans.length, 4, JSON.stringify(spans));
  const [a, b, c, d] = spans as [(typeof spans)[0], (typeof spans)[0], (typeof spans)[0], (typeof spans)[0]];
  assert.ok(near(a.start, 0.75) && near(a.end, 3.25), JSON.stringify(a));
  // The 0.3 s gap stays inside the phrase; the 0.08 s click two seconds later is no phrase.
  assert.ok(near(b.start, 3.75) && near(b.end, 7.55), JSON.stringify(b));
  // 24 s of sound is longer than a phrase may be: split where it dips (12 s in), not in the middle of a tone.
  assert.ok(near(c.start, 11.13) && near(c.end, 23.58, 0.25), JSON.stringify(c));
  assert.ok(near(d.start, 23.58, 0.25) && near(d.end, 36.03), JSON.stringify(d));
  assert.ok(
    spans.every((s) => s.end - s.start <= 20),
    "no phrase over the 20 s cap",
  );
});

test("the splitter: a short phrase joins its close neighbour; silence is no phrase; the WAV round-trips", () => {
  const pcm = synth([tone(0.6), quiet(0.8), tone(3), quiet(3), tone(3)]);
  const spans = splitPhrases(pcmLevels(pcm));
  assert.equal(spans.length, 2, JSON.stringify(spans));
  assert.ok(near(spans[0]!.start, 0) && near(spans[0]!.end, 4.65), JSON.stringify(spans[0]));
  assert.deepEqual(splitPhrases(pcmLevels(synth([quiet(5)]))), []);
  const wav = pcmWav(pcm, { start: 1, end: 2.5 });
  const back = readPcmWav(wav);
  assert.equal(back.rate, RATE);
  assert.equal(back.data.length, 1.5 * RATE * 2);
  assert.deepEqual(back.data, pcm.data.subarray(RATE * 2, 2.5 * RATE * 2));
});

test("merging: words, segments and phrases in seconds of the take, word indices running on, empty phrases left out", () => {
  const first = speech(["Step one.", "Run it."], { start: 0.2 });
  const second = speech(["Step two."], { start: 0.1 });
  const merged = mergePhrases([
    { span: { start: 10, end: 13 }, guarded: { speech: first } },
    { span: { start: 14, end: 14.6 }, guarded: { speech: { segments: [], words: [] }, dropped: "noise" } },
    { span: { start: 20, end: 22 }, guarded: { speech: second } },
  ]);
  assert.deepEqual(
    merged.words.map((w) => [w.text, w.start]),
    [
      ["Step", 10.2],
      ["one.", 10.6],
      ["Run", 11],
      ["it.", 11.4],
      ["Step", 20.1],
      ["two.", 20.5],
    ],
  );
  assert.deepEqual(
    merged.segments.map((s) => [s.text, s.start, s.words]),
    [
      ["Step one.", 10.2, [0, 2]],
      ["Run it.", 11, [2, 4]],
      ["Step two.", 20.1, [4, 6]],
    ],
  );
  assert.deepEqual(merged.phrases, [
    { start: 10, end: 13, text: "Step one. Run it.", words: [0, 4] },
    { start: 20, end: 22, text: "Step two.", words: [4, 6] },
  ]);
  // A word whisper timed past its phrase's end stays inside the phrase.
  const late = mergePhrases([{ span: { start: 5, end: 6 }, guarded: { speech: speech(["a b c d"], { start: 0.5 }) } }]);
  assert.ok(late.words.every((w) => w.end <= 6 && w.start <= 6));
});

test("the loop guard: a line said over and over keeps its first time; a run of words repeating, words past the end, a flood of words and stock noise answers go", () => {
  const looping = guardPhrase(
    speech(["Step 2. Ask your agent.", "Step 2. Ask your agent.", "Step 2. Ask your agent.", "Step 2. Ask your agent.", "I asked mine."], { step: 0.25 }),
    8,
  );
  assert.equal(looping.dropped, "repeats");
  assert.deepEqual(
    looping.speech.segments.map((s) => s.text),
    ["Step 2. Ask your agent.", "I asked mine."],
  );
  assert.equal(looping.speech.words.length, 8);
  // Said twice is a retake, not a loop.
  const twice = guardPhrase(speech(["I renamed one label.", "I renamed one label."]), 5);
  assert.equal(twice.dropped, undefined);
  assert.equal(twice.speech.words.length, 8);
  const run = guardPhrase(speech(["run agent run agent run agent run agent run agent to record"], { step: 0.2 }), 4);
  assert.equal(run.dropped, "repeats");
  assert.equal(run.speech.words.map((w) => w.text).join(" "), "run agent to record");
  const outside = guardPhrase(speech(["one two three four five six"], { step: 0.5 }), 2);
  assert.equal(outside.dropped, "outside");
  assert.deepEqual(
    outside.speech.words.map((w) => w.text),
    ["one", "two", "three", "four"],
  );
  assert.ok(outside.speech.words.every((w) => w.end <= 2));
  assert.equal(guardPhrase(speech(["a b c d e f g h i j k l m n o p q r s t u v w x"], { step: 0.05 }), 2).dropped, "too-many-words");
  assert.equal(guardPhrase(speech(["Thank you."], { p: 0.3 }), 2).dropped, "noise");
  assert.equal(guardPhrase(speech(["Thank you."], { p: 0.95 }), 2).dropped, undefined);
  assert.equal(guardPhrase(speech(["Okay."], { p: 0.07 }), 3).dropped, "noise");
});

test("the take's language: the one most of its time is in", () => {
  assert.equal(
    mainLanguage([
      { span: { start: 0, end: 10 }, language: "en" },
      { span: { start: 10, end: 11 }, language: "de" },
      { span: { start: 11, end: 12 }, language: "de" },
    ]),
    "en",
  );
  assert.equal(mainLanguage([{ span: { start: 0, end: 1 } }]), undefined);
});

test("names from the brief: whisper's near misses written as the name, punctuation kept, segment and phrase text too", () => {
  assert.deepEqual(namesIn("Developers on X who use coding agents (Claude Code, Codex, Cursor), in DM Sans and DM Mono. Same look as before."), [
    "Claude Code",
    "DM Sans",
    "DM Mono",
  ]);
  const t = {
    ...speech(["It connects to Cloud Code, Codex or Cursor.", "claude code is fine.", "A cloud coder."]),
    phrases: [{ start: 0, end: 9, text: "It connects to Cloud Code, Codex or Cursor. claude code is fine. A cloud coder.", words: [0, 15] as const }],
  };
  const fixed = correctNames(t, ["Claude Code", "DM Sans"]);
  assert.deepEqual(
    fixed.words.map((w) => w.text),
    ["It", "connects", "to", "Claude", "Code,", "Codex", "or", "Cursor.", "Claude", "Code", "is", "fine.", "A", "cloud", "coder."],
  );
  assert.equal(fixed.segments[0]!.text, "It connects to Claude Code, Codex or Cursor.");
  assert.equal(fixed.phrases[0]!.text, "It connects to Claude Code, Codex or Cursor. Claude Code is fine. A cloud coder.");
  assert.equal(correctNames(t, []), t);
});

test("transcribing by phrases: one model run with a WAV per phrase, times back in the take, a phrase heard in another language redone in the take's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-phrases-"));
  try {
    const pcm = synth([quiet(1), tone(4), quiet(2), tone(4), quiet(2), tone(1.6), quiet(1)]);
    const audio = join(dir, "audio.wav");
    writeFileSync(audio, pcmWav(pcm, { start: 0, end: pcm.data.length / 2 / RATE }));
    const calls: Array<SpeechRequest> = [];
    const fake: Transcribe = async (request) => {
      calls.push(request);
      const files = await Promise.all(
        (request.files ?? []).map(async (file, i) => {
          const seconds = readPcmWav(await readFile(file)).data.length / 2 / RATE;
          const language = request.language !== "auto" ? request.language : i === 2 ? "de" : "en";
          return speech([`phrase ${i} said in ${language}`], { start: 0.3, step: Math.min(0.4, (seconds - 0.4) / 5), language });
        }),
      );
      return { segments: [], words: [], files };
    };
    const progress: Array<number> = [];
    const out = await transcribeByPhrases({ audio, bin: "whisper-cli", model: "m.bin", modelId: "m", language: "auto", timeoutMs: 60000 }, fake, {
      signal: new AbortController().signal,
      onProgress: (f) => progress.push(f),
    });
    assert.equal(calls.length, 2, "the first run, then the stray phrase again");
    assert.equal(calls[0]!.files!.length, 3);
    assert.deepEqual(calls[1]!.files, [calls[0]!.files![2]]);
    assert.equal(calls[1]!.language, "en");
    assert.equal(out.language, "en");
    assert.deepEqual(
      out.phrases.map((p) => p.text),
      ["phrase 0 said in en", "phrase 1 said in en", "phrase 0 said in en"],
    );
    assert.ok(near(out.phrases[1]!.start, 6.75) && near(out.words[out.phrases[1]!.words[0]]!.start, 7.05), JSON.stringify(out.phrases[1]));
    assert.ok(
      out.words.every((w, i) => i === 0 || w.start >= out.words[i - 1]!.start),
      "monotonic",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcript_read on a phrase transcript: one text line per phrase, phrases counted and listed with the words", () => {
  const merged = mergePhrases([
    { span: { start: 1, end: 4 }, guarded: { speech: speech(["Step one.", "Run it."]) } },
    { span: { start: 6, end: 8 }, guarded: { speech: speech(["Step two."]) } },
  ]);
  const result: TranscriptResult = { hasAudio: true, seconds: 10, language: "en", model: "m", ...merged };
  const text = transcriptOut(result, { cached: true, fps: 30, length: 300 }) as Record<string, unknown>;
  assert.equal(text.phrases, 2);
  assert.deepEqual((text.text as string).split("\n"), [
    "(pause 1.1 s before the first word)",
    "w0 [33–79] Step one. Run it. (pause 3.5 s)",
    "w4 [183–205] Step two. (pause 3.2 s)",
  ]);
  const words = transcriptOut(result, { cached: true, fps: 30, length: 300, format: "words" }) as Record<string, unknown>;
  assert.deepEqual(words.phrases, [
    { from: "w0", to: "w3", start: 33, end: 79 },
    { from: "w4", to: "w5", start: 183, end: 205 },
  ]);
});

let root = "";
before(() => {
  if (!ffmpegPath) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-phrases-queue-")));
  mkdirSync(join(root, "Test.uncut"));
  mkdirSync(join(root, "tmp"));
  writeFileSync(join(root, "model.bin"), "not really a model");
  writeFileSync(join(root, "say.json"), whisperJson(SAY_TOKENS, "en"));
  writeFileSync(join(root, "Test.uncut", "brief.json"), JSON.stringify({ film: "A demo of Quick Brown." }));
  // 102 s: a tone for 6 s in every 8 s (13 phrases), quiet between.
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.3*sin(2*PI*300*t)*lt(mod(t\\,8)\\,6):s=48000:d=102",
    "-c:a",
    "aac",
    join(root, "take.m4a"),
  ]);
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "a long take through the queue: one whisper run with a -f/-of pair per phrase, phrases in the cached transcript, names from the brief",
  { skip: ffmpegPath ? false : "ffmpeg isn't installed", timeout: 60000 },
  async () => {
    process.env.FAKE_WHISPER_JSON = join(root, "say.json");
    process.env.FAKE_WHISPER_LOG = join(root, "whisper.log");
    try {
      const q = new AnalysisQueue({
        ffmpeg: async () => ffmpegPath,
        whisper: async () => ({ bin: FAKE, model: join(root, "model.bin"), modelId: "tiny.en" }),
        transcribe: transcribeDirect,
        tmpRoot: join(root, "tmp"),
      });
      const target: AnalysisTarget = {
        dir: join(root, "Test.uncut"),
        mediaId: "m-take",
        path: join(root, "take.m4a"),
        kind: "audio",
        hasAudio: true,
        seconds: 102,
      };
      const r = await q.request(target, "transcript");
      const outcome = await r.done;
      assert.equal(outcome.state, "done", JSON.stringify(outcome));
      const result = (outcome as { result: TranscriptResult }).result;
      const runs = (await readFile(join(root, "whisper.log"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { argv: Array<string> });
      assert.equal(runs.length, 1, "one whisper run");
      assert.equal(runs[0]!.argv.filter((a) => a === "-f").length, 13);
      assert.equal(runs[0]!.argv.filter((a) => a === "-of").length, 13);
      assert.equal(result.phrases?.length, 13);
      assert.equal(result.words?.length, 13 * 16);
      result.phrases!.forEach((p, k) => {
        assert.ok(near(p.start, Math.max(0, k * 8 - 0.25), 0.05), `phrase ${k} starts at ${p.start}`);
        assert.ok(result.words![p.words[0]]!.start >= p.start && result.words![p.words[1] - 1]!.end <= p.end);
      });
      assert.ok(result.words!.some((w) => w.text === "Quick") && result.words!.some((w) => w.text === "Brown"), "the brief's name");
      q.shutdown();
    } finally {
      delete process.env.FAKE_WHISPER_JSON;
      delete process.env.FAKE_WHISPER_LOG;
    }
  },
);
