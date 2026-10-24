#!/usr/bin/env node
// Stands in for whisper-cli in tests (the real one needs a model and takes seconds).
//   whisper-cli --version: answers like whisper.cpp 1.9.5.
//   whisper-cli -m <model> -f <wav> -ojf -of <out> -l <lang> -pp ...: like the real 1.9.5, a missing
//   model exits 3, a missing or unreadable audio file 2, with no JSON; otherwise it prints
//   progress lines on stderr and copies $FAKE_WHISPER_JSON to <out>.json (result.language set to
//   -l when that isn't auto).
// $FAKE_WHISPER_LOG: every run's arguments, one JSON line each (with how many UNCUT_* variables it
// got: none when the Whisper plugin started it, D100, since plugins don't get Uncut's own). $FAKE_WHISPER_SLEEP_MS: take that
// long (with progress meanwhile), so a test can cancel mid-run.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("whisper.cpp version: 1.9.5");
  process.exit(0);
}
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (process.env.FAKE_WHISPER_LOG)
  appendFileSync(
    process.env.FAKE_WHISPER_LOG,
    `${JSON.stringify({ argv, pid: process.pid, env: Object.keys(process.env).filter((k) => k.startsWith("ANTHROPIC")), uncutEnv: Object.keys(process.env).filter((k) => k.startsWith("UNCUT_")).length })}\n`,
  );
const model = opt("-m");
const wav = opt("-f");
const out = opt("-of");
const language = opt("-l") ?? "en";
if (!model || !existsSync(model)) {
  console.error(`whisper_init_from_file_with_params_no_state: failed to open '${model}'`);
  console.error("error: failed to initialize whisper context");
  process.exit(3);
}
if (!wav || !existsSync(wav) || statSync(wav).size < 44 || readFileSync(wav).subarray(0, 4).toString() !== "RIFF") {
  console.error(`error: failed to read audio file '${wav}'`);
  process.exit(2);
}
const sleepMs = Number(process.env.FAKE_WHISPER_SLEEP_MS ?? 0);
const steps = 5;
for (let i = 1; i <= steps; i++) {
  if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs / steps));
  console.error(`whisper_print_progress_callback: progress = ${Math.round((i / steps) * 100)}%`);
}
const source = process.env.FAKE_WHISPER_JSON;
if (!source || !out) {
  console.error("error: no transcript to give (FAKE_WHISPER_JSON)");
  process.exit(0);
}
let json = readFileSync(source).toString("latin1");
if (language !== "auto") {
  const doc = JSON.parse(json);
  doc.result.language = language;
  json = JSON.stringify(doc, null, "\t");
}
writeFileSync(`${out}.json`, Buffer.from(json, "latin1"));
console.log("[00:00:00.000 --> 00:00:01.000]   (the transcript, as whisper-cli prints it)");
