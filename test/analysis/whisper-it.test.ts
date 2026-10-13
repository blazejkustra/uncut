// Phase 5 chunk 4 (D68), integration tier, only with UNCUT_WHISPER_IT=1: real speech (macOS `say`)
// in an mp4, transcribed by the real whisper-cli through the analysis queue with the small English
// model (ggml-tiny.en.bin, 78 MB) downloaded and checked by Uncut's own downloader into a test
// cache (test-output/whisper-models, or UNCUT_WHISPER_IT_MODELS), never the user's Application
// Support. Needs `brew install whisper-cpp`, ffmpeg and network for the first run.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AnalysisQueue, type AnalysisTarget } from "../../apps/server/src/analysis/analysis.ts";
import { fillersOf, pausesOf, transcribeDirect, type TranscriptResult } from "../../apps/server/src/analysis/transcription.ts";
import { DEFAULT_MODEL_URL, downloadFile, modelInfo } from "../../apps/server/src/analysis/whisperModels.ts";

const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const WHISPER = which("whisper-cli");
const FFMPEG = which("ffmpeg");
const skip = process.env.UNCUT_WHISPER_IT !== "1" ? "set UNCUT_WHISPER_IT=1 to run (real whisper-cli, downloads ggml-tiny.en.bin once)" : !WHISPER ? "whisper-cli isn't installed (brew install whisper-cpp)" : !FFMPEG || !which("say") ? "needs ffmpeg and macOS say" : false;
const SENTENCE = "Hello world, this is a test. Um, the quick brown fox jumps over the lazy dog.";
let root = "";

before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-whisper-it-")));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("real speech: whisper-cli hears the sentence, words in order within the clip, the filler and pauses", { skip, timeout: 600000 }, async () => {
  const info = modelInfo("tiny.en")!;
  const modelsDir = resolve(process.env.UNCUT_WHISPER_IT_MODELS ?? "test-output/whisper-models");
  const model = join(modelsDir, info.file);
  if (!existsSync(model)) {
    mkdirSync(modelsDir, { recursive: true });
    const t = Date.now();
    await downloadFile({ url: `${DEFAULT_MODEL_URL}/${info.file}`, dest: model, bytes: info.bytes, sha256: info.sha256, signal: new AbortController().signal });
    console.log(`downloaded ${info.file} (${Math.round(info.bytes / 1e6)} MB, checked) in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
  // say → AIFF → an mp4 with a picture and AAC sound, like footage.
  execFileSync("say", ["-o", join(root, "speech.aiff"), SENTENCE]);
  const clip = join(root, "Talk.mp4");
  execFileSync(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=gray:size=320x180:rate=30", "-i", join(root, "speech.aiff"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  const project = join(root, "Test.uncut");
  mkdirSync(project);
  const q = new AnalysisQueue({ ffmpeg: async () => FFMPEG, whisper: async () => ({ bin: WHISPER!, model, modelId: "tiny.en" }), transcribe: transcribeDirect });
  const target: AnalysisTarget = { dir: project, mediaId: "m-talk", path: clip, kind: "video", hasAudio: true };
  const t0 = Date.now();
  const r = await q.request(target, "transcript");
  const outcome = await r.done;
  const ms = Date.now() - t0;
  assert.equal(outcome.state, "done", JSON.stringify(outcome));
  const result = (outcome as { result: TranscriptResult }).result;
  const words = result.words!;
  console.log(`${result.seconds} s of speech in ${(ms / 1000).toFixed(2)} s (${(result.seconds! / (ms / 1000)).toFixed(1)}× realtime, model load included), language ${result.language}`);
  console.log(words.map((w) => `${w.text}@${w.start.toFixed(2)}–${w.end.toFixed(2)}(${w.p.toFixed(2)})`).join(" "));
  const heard = words.map((w) => w.text.toLowerCase().replace(/[^a-z']/g, ""));
  const expected = ["hello", "world", "this", "is", "a", "test", "the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog"];
  const found = expected.filter((w) => heard.includes(w));
  console.log(`recognised ${found.length}/${expected.length} expected words; fillers ${JSON.stringify(fillersOf(words, result.language))}; pauses ${JSON.stringify(pausesOf(words, result.seconds))}`);
  assert.ok(found.length >= 12, `heard: ${heard.join(" ")}`);
  assert.equal(result.language, "en");
  for (let i = 0; i < words.length; i++) {
    assert.ok(words[i]!.end >= words[i]!.start, `word ${i} ends after it starts`);
    assert.ok(words[i]!.start >= 0 && words[i]!.end <= result.seconds! + 1e-9, `word ${i} within the clip`);
    if (i) assert.ok(words[i]!.start >= words[i - 1]!.start, `word ${i} in order`);
  }
  // The order of what was said is kept.
  const order = ["hello", "test", "quick", "fox", "dog"].map((w) => heard.indexOf(w)).filter((i) => i >= 0);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});
