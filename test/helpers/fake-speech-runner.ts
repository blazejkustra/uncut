#!/usr/bin/env node
// Stands in for the offline voice's runner (apps/desktop/src/speech.ts, Electron with
// --uncut-speech) in tests: the same JSON lines, no GPU. A speak writes half a second of silence as
// a 24 kHz WAV at out (after a loading 0.5 line); a clone writes a voice of 100 frames saying the
// transcript. A text or transcript with FAIL answers ok: false.
// $FAKE_SPEECH_LOG: every request, one JSON line each, with the runner's pid and whether it got
// ELECTRON_RUN_AS_NODE. $FAKE_SPEECH_SLEEP_MS: take that long before answering, so a test can cancel.
import { appendFileSync, writeFileSync } from "node:fs";
import * as readline from "node:readline";

const reply = (msg: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ uncut: "speech", ...msg })}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function silence(seconds: number, rate = 24000) {
  const samples = Math.round(seconds * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

async function answer(r: Record<string, any>) {
  if (process.env.FAKE_SPEECH_LOG)
    appendFileSync(process.env.FAKE_SPEECH_LOG, `${JSON.stringify({ ...r, pid: process.pid, electronAsNode: "ELECTRON_RUN_AS_NODE" in process.env })}\n`);
  reply({ id: r.id, loading: 0.5 });
  await sleep(Number(process.env.FAKE_SPEECH_SLEEP_MS ?? 0));
  if (String(r.text ?? r.transcript).includes("FAIL")) return reply({ id: r.id, ok: false, error: "the GPU went away" });
  if (r.kind === "speak") {
    writeFileSync(r.out, silence(0.5));
    return reply({ id: r.id, ok: true, seconds: 0.5 });
  }
  writeFileSync(
    r.out,
    JSON.stringify({ language: r.language, transcript: r.transcript, frames: 100, duration: 4, codes: Array.from({ length: 800 }, (_, i) => i % 1024) }),
  );
  reply({ id: r.id, ok: true });
}

reply({ ready: true });
readline.createInterface({ input: process.stdin }).on("line", (line) => void answer(JSON.parse(line)));
