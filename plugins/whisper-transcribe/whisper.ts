// whisper.cpp as a speech model (D26, D68, D100): runs whisper-cli on a 16 kHz mono WAV and turns its
// full JSON (-ojf: segments with timed tokens) into words. Shared by the plugin's MCP server
// (server.ts, how Uncut calls it) and Uncut's in-process runner for tests (the server imports this
// file; the plugin can't import the server). No dependencies beyond Node.
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const WHISPER_BIN = "whisper-cli";

export interface TranscriptWord {
  readonly text: string;
  /** Seconds of the file. */
  readonly start: number;
  readonly end: number;
  /** whisper's confidence, 0–1 (the lowest of the word's pieces). */
  readonly p: number;
}
export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Its words: indices [first, end) into words. */
  readonly words: readonly [number, number];
}
/** What a speech model answers (the transcribe call's result). */
export interface Speech {
  /** The spoken language (detected, or the one asked for), ISO 639-1. */
  readonly language?: string;
  readonly segments: Array<TranscriptSegment>;
  readonly words: Array<TranscriptWord>;
}

/** whisper-cli: full JSON (timed tokens), progress on stderr, Metal by default (whisper.cpp's default). */
export const whisperArgs = (model: string, wav: string, out: string, language: string, threads = Math.max(1, Math.min(8, availableParallelism()))) => [
  "-m",
  model,
  "-f",
  wav,
  "-ojf",
  "-of",
  out,
  "-l",
  language,
  "-pp",
  "-np",
  "-t",
  String(threads),
];

// ---- whisper's JSON into words ----

interface WhisperToken {
  readonly text: string;
  readonly offsets: { readonly from: number; readonly to: number };
  readonly p?: number;
}
interface WhisperSegment {
  readonly offsets: { readonly from: number; readonly to: number };
  readonly text: string;
  readonly tokens?: ReadonlyArray<WhisperToken>;
}

/** Special tokens: [_BEG_], [_TT_123], [_SOT_]… */
const SPECIAL = /^\[_[A-Za-z0-9_]*\]$/;
/** Only ASCII punctuation and spaces (non-ASCII bytes count as letters: Polish letters are two bytes). */
const PUNCT_ONLY = /^[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+$/;
/** Annotations, not speech: [BLANK_AUDIO], (music), *laughs*, ♪. */
const ANNOTATION = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+)\s*$/;
const OPENS = /^[[(*]/;
const CLOSES = /[\])*]$/;

/** whisper's token texts are raw bytes (a Polish letter can be split over two tokens): read as latin1, decoded once joined. */
const utf8 = (bytes: string) => Buffer.from(bytes, "latin1").toString("utf8");
const ms3 = (s: number) => Math.round(s * 1000) / 1000;

/**
 * Parses whisper-cli's full JSON (read as latin1, so each char is one byte). A token starting with
 * a space starts a word; other tokens (word pieces, punctuation) join the word before. A word runs
 * from its first piece to the end of its last letter piece: punctuation is timed where the next
 * word starts, so it would swallow the pause after the word. Annotations and punctuation-only words
 * are dropped; times are made monotonic and kept within `seconds`.
 */
export function parseWhisperJson(latin1: string, seconds?: number): Speech {
  let doc: { result?: { language?: unknown }; transcription?: ReadonlyArray<WhisperSegment> };
  try {
    // Raw control characters (a stray byte in a token) aren't valid JSON: drop them.
    doc = JSON.parse(latin1.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""));
  } catch {
    throw new Error("whisper-cli wrote a transcript Uncut can't read.");
  }
  const words: Array<TranscriptWord> = [];
  const segments: Array<TranscriptSegment> = [];
  const clamp = (s: number) => Math.max(0, seconds !== undefined ? Math.min(seconds, s) : s);
  let lastStart = 0;
  for (const seg of doc.transcription ?? []) {
    const segText = utf8(seg.text ?? "").trim();
    if (!segText || ANNOTATION.test(segText)) continue;
    const first = words.length;
    // Words of this segment, as byte strings with their times.
    const raw: Array<{ text: string; start: number; end: number | undefined; p: number }> = [];
    for (const t of seg.tokens ?? []) {
      if (typeof t.text !== "string" || SPECIAL.test(t.text) || !t.offsets) continue;
      const from = t.offsets.from / 1000;
      const to = t.offsets.to / 1000;
      const letters = !PUNCT_ONLY.test(t.text);
      const p = typeof t.p === "number" ? t.p : 1;
      const current = raw.at(-1);
      if (!current || t.text.startsWith(" ")) raw.push({ text: t.text, start: from, end: letters ? to : undefined, p: letters ? p : 1 });
      else {
        current.text += t.text;
        if (letters) {
          current.end = to;
          current.p = Math.min(current.p, p);
        }
      }
    }
    let skipping = false;
    for (const w of raw) {
      const text = utf8(w.text).trim();
      if (!text) continue;
      // An annotation spread over several words: from "[" or "(" to its closer.
      if (skipping || (OPENS.test(text) && !/^\(?\d/.test(text))) {
        skipping = !CLOSES.test(text);
        continue;
      }
      if (PUNCT_ONLY.test(w.text) || text === "♪") continue;
      const start = Math.max(lastStart, clamp(w.start));
      const end = Math.max(start, clamp(w.end ?? w.start));
      lastStart = start;
      words.push({ text, start: ms3(start), end: ms3(end), p: Math.round(w.p * 1000) / 1000 });
    }
    if (words.length === first) continue;
    segments.push({ start: ms3(clamp(seg.offsets.from / 1000)), end: ms3(clamp(seg.offsets.to / 1000)), text: segText, words: [first, words.length] });
  }
  const language = typeof doc.result?.language === "string" ? doc.result.language : undefined;
  return { ...(language ? { language } : {}), segments, words };
}

/** The last useful lines of a tool's stderr. */
const lastLines = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(size=|frame=|Press \[q\])/.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 400);

/** whisper's last error-looking lines (it logs a lot of model details). */
export const whisperError = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /error|failed|cannot|can't|unable|invalid|not found/i.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 400) || lastLines(stderr);

// ---- running it ----

export class Stopped extends Error {
  constructor() {
    super("cancelled");
  }
}

/** Runs a program to the end (Uncut's analysis runner has this shape, so its tests can watch the spawn). */
export type Run = (
  bin: string,
  args: ReadonlyArray<string>,
  options: { readonly signal: AbortSignal; readonly onStderr?: (line: string) => void; readonly timeoutMs?: number },
) => Promise<{ readonly code: number | null; readonly stderrTail: string }>;

/** The plugin's own runner: whisper-cli in the plugin's process group (so Uncut stopping the plugin stops it too), SIGKILLed on abort or timeout. */
export const spawnRun: Run = (bin, args, { signal, onStderr, timeoutMs }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Stopped());
    const child = spawn(bin, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    let partial = "";
    child.stderr!.on("data", (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-16384);
      const lines = (partial + s).split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const line of lines) onStderr?.(line);
    });
    const kill = () => child.kill("SIGKILL");
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), kill()), timeoutMs) : undefined;
    signal.addEventListener("abort", kill, { once: true });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      fn();
    };
    child.once("error", (error) => done(() => reject(signal.aborted ? new Stopped() : error)));
    child.once("close", (code) =>
      done(() => {
        if (partial) onStderr?.(partial);
        if (signal.aborted) reject(new Stopped());
        else if (timedOut) reject(new Error("The transcription took too long and was stopped."));
        else resolve({ code, stderrTail: tail });
      }),
    );
  });

export interface TranscribeInput {
  /** A 16 kHz mono WAV. whisper's JSON is written next to it (the caller owns that folder). */
  readonly audio: string;
  /** The ggml model file. */
  readonly model: string;
  /** whisper-cli (found by Uncut's Setup); none: looked up on PATH. */
  readonly bin?: string | undefined;
  /** "auto" or a language code. */
  readonly language: string;
  /** The audio's length, to keep word times within it. */
  readonly seconds?: number | undefined;
}

/** Looks a program up on PATH. */
export async function onPath(name: string, path = process.env.PATH ?? ""): Promise<string | undefined> {
  const { access, stat } = await import("node:fs/promises");
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, 1);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

export const NO_WHISPER = "whisper.cpp isn't installed. Uncut transcribes speech on this Mac with it: brew install whisper-cpp (then ask again).";

/**
 * Transcribes a WAV with whisper-cli. Progress is 0–1 (whisper's `progress = N%` lines). Rejects
 * with Stopped when `signal` aborts (whisper is killed), else with a sentence.
 */
export async function transcribeWav(input: TranscribeInput, options: { readonly signal: AbortSignal; readonly run?: Run | undefined; readonly onProgress?: ((fraction: number) => void) | undefined; readonly timeoutMs?: number | undefined }): Promise<Speech> {
  const bin = input.bin ?? (await onPath(WHISPER_BIN));
  if (!bin) throw new Error(NO_WHISPER);
  const out = join(dirname(input.audio), "transcript");
  // An older answer next to the audio would pass for this one.
  await rm(`${out}.json`, { force: true });
  // whisper-cli exits non-zero when it can't load the model (3), find the audio (2) or decode it
  // (11); the JSON file is the proof either way (and its error lines say why).
  const run = await (options.run ?? spawnRun)(bin, whisperArgs(input.model, input.audio, out, input.language), {
    signal: options.signal,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    onStderr: (line) => {
      const m = /progress\s*=\s*(\d+)%/.exec(line);
      if (m) options.onProgress?.(Math.min(1, Number(m[1]) / 100));
    },
  });
  if (options.signal.aborted) throw new Stopped();
  let json: string;
  try {
    json = (await readFile(`${out}.json`)).toString("latin1");
  } catch {
    throw new Error(`whisper-cli couldn't transcribe it: ${whisperError(run.stderrTail) || `it exited with ${run.code}`}`);
  }
  return parseWhisperJson(json, input.seconds);
}
