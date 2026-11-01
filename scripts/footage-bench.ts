// Benchmarks the footage index on synthetic footage: 12 five-minute clips of macOS `say` speech over
// a test pattern, each with one planted phrase, through the real transcript analyzer, then the index
// and its search; and the index alone on 100 hours of made-up transcripts.
//   node scripts/footage-bench.ts <work folder> <path to a ggml model>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { analyzeTranscript, transcribeDirect, type TranscriptResult } from "../apps/server/src/analysis/transcription.ts";
import { FootageStore, speechPassages, type Place } from "../apps/server/src/footage/footageStore.ts";
import { frameArgs } from "../apps/server/src/footage/footageThumbs.ts";

const CLIPS = 12;
const CLIP_SECONDS = 300;
const WORDS_PER_CLIP = 900;
const SCALE_HOURS = 100;
const QUERIES_PER_RUN = 200;

const VOCABULARY =
  "the camera moves across a quiet street while people talk about the new release and how it changes every morning for the team that builds small tools with careful hands near the river under bright light after long days of work on simple ideas".split(
    " ",
  );
const phraseOf = (clip: number) =>
  `orange ${["falcon", "harbor", "signal", "meadow", "copper", "lantern", "glacier", "pepper", "violet", "thunder", "marble", "cactus"][clip]} protocol`;

const seeded = (seed: number) => {
  let state = seed;
  return (limit: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % limit;
  };
};

function clipText(clip: number) {
  const pick = seeded(clip + 1);
  const words = Array.from({ length: WORDS_PER_CLIP }, (_, i) => `${VOCABULARY[pick(VOCABULARY.length)]}${i % 14 === 13 ? "." : ""}`);
  words.splice(WORDS_PER_CLIP / 2, 0, `${phraseOf(clip)}.`);
  return words.join(" ");
}

function makeClip(folder: string, clip: number) {
  const file = join(folder, `clip-${clip}.mp4`);
  if (existsSync(file)) return file;
  const speech = join(folder, `clip-${clip}.aiff`);
  execFileSync("say", ["-o", speech, clipText(clip)]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x180:rate=10:duration=${CLIP_SECONDS}`,
    "-i",
    speech,
    "-af",
    "apad",
    "-t",
    String(CLIP_SECONDS),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    file,
  ]);
  return file;
}

const seconds = (from: number) => (performance.now() - from) / 1000;
const percentile = (sorted: ReadonlyArray<number>, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

function timeQueries(store: FootageStore, queries: ReadonlyArray<string>) {
  const times = queries.map((query) => {
    const from = performance.now();
    store.search({ query, limit: 30 });
    return performance.now() - from;
  });
  times.sort((a, b) => a - b);
  return { queries: times.length, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), maxMs: times.at(-1) };
}

const place = (fingerprint: string, path: string): Place => ({
  dir: "/bench",
  project: "Bench",
  mediaId: fingerprint,
  fingerprint,
  path,
  stamp: "1:1",
  name: fingerprint,
  kind: "video",
});

async function realFootage(folder: string, model: string) {
  const db = join(folder, "real.db");
  await rm(db, { force: true });
  const store = new FootageStore(db);
  const whisper = { bin: execFileSync("sh", ["-c", "command -v whisper-cli"], { encoding: "utf8" }).trim(), model, modelId: "bench" };
  const ffmpeg = execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim();
  const makeFrom = performance.now();
  const files = Array.from({ length: CLIPS }, (_, clip) => makeClip(folder, clip));
  const made = seconds(makeFrom);
  const cacheFile = (clip: number) => join(folder, `clip-${clip}.words.json`);
  const transcribeFrom = performance.now();
  const results: Array<TranscriptResult> = [];
  for (const [clip, file] of files.entries()) {
    const result = await analyzeTranscript(ffmpeg, whisper, file, {
      signal: new AbortController().signal,
      seconds: CLIP_SECONDS,
      transcribe: transcribeDirect,
      language: "en",
    });
    writeFileSync(cacheFile(clip), JSON.stringify(result.words ?? []));
    results.push(result);
  }
  const transcribed = seconds(transcribeFrom);
  const ingestFrom = performance.now();
  store.setPlaces(
    "/bench",
    files.map((file, clip) => place(`clip${clip}`, file)),
  );
  for (const [clip, result] of results.entries()) store.putSpeech(`clip${clip}`, speechPassages(result.words ?? []));
  const ingested = seconds(ingestFrom);
  const found = Array.from({ length: CLIPS }, (_, clip) =>
    store.search({ query: `"${phraseOf(clip)}"`, limit: 5 }).some((hit) => hit.fingerprint === `clip${clip}`),
  );
  const words = results.reduce((sum, result) => sum + (result.words?.length ?? 0), 0);
  const queries = Array.from({ length: QUERIES_PER_RUN }, (_, i) =>
    i % 2 ? VOCABULARY[i % VOCABULARY.length]! : `${VOCABULARY[i % VOCABULARY.length]} ${VOCABULARY[(i * 7) % VOCABULARY.length]}`,
  );
  const thumbFrom = performance.now();
  const thumb = join(folder, "thumb.jpg");
  execFileSync(ffmpeg, frameArgs(files[0]!, CLIP_SECONDS / 2, thumb));
  const report = {
    footageHours: (CLIPS * CLIP_SECONDS) / 3600,
    makeSeconds: made,
    words,
    transcribeSeconds: transcribed,
    realtimeFactor: (CLIPS * CLIP_SECONDS) / transcribed,
    ingestSeconds: ingested,
    plantedPhrasesFound: `${found.filter(Boolean).length} of ${CLIPS}`,
    search: timeQueries(store, queries),
    thumbSeconds: seconds(thumbFrom),
  };
  store.close();
  return { ...report, indexBytes: statSync(db).size };
}

async function atScale(folder: string) {
  const db = join(folder, "scale.db");
  await rm(db, { force: true });
  const store = new FootageStore(db);
  const pick = seeded(7);
  const wordsPerHour = 9000;
  const ingestFrom = performance.now();
  store.setPlaces(
    "/bench",
    Array.from({ length: SCALE_HOURS }, (_, hour) => place(`hour${hour}`, `/bench/${hour}.mp4`)),
  );
  for (let hour = 0; hour < SCALE_HOURS; hour++) {
    const words = Array.from({ length: wordsPerHour }, (_, i) => ({
      text: `${VOCABULARY[pick(VOCABULARY.length)]}${pick(50)}`,
      start: i * 0.4,
      end: i * 0.4 + 0.3,
    }));
    store.putSpeech(`hour${hour}`, speechPassages(words));
  }
  const ingested = seconds(ingestFrom);
  const queries = Array.from({ length: QUERIES_PER_RUN }, (_, i) => `${VOCABULARY[i % VOCABULARY.length]}${i % 50} ${VOCABULARY[(i * 3) % VOCABULARY.length]}`);
  const report = { hours: SCALE_HOURS, words: SCALE_HOURS * wordsPerHour, ingestSeconds: ingested, search: timeQueries(store, queries) };
  store.close();
  return { ...report, indexBytes: statSync(db).size };
}

const [folder, model] = process.argv.slice(2);
if (!folder || !model) throw new Error("Usage: node scripts/footage-bench.ts <work folder> <path to a ggml model>");
mkdirSync(folder, { recursive: true });
console.log(JSON.stringify({ real: await realFootage(folder, model), scale: await atScale(folder) }, null, 2));
