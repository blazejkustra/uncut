// The transcript analyzer (D68): speech to words, on this Mac, with whisper.cpp (Homebrew's
// whisper-cpp, binary whisper-cli). One job: ffmpeg writes the first audio stream (0:a:0) as a
// 16 kHz mono WAV into a temp folder, whisper-cli transcribes it to full JSON (-ojf: segments with
// their tokens, each token timed), and the tokens are joined into words. The temp folder goes
// whatever happens (done, failed, cancelled). Cached through the analysis queue (D66) as
// <fp>/transcript.json. Fillers and pauses are derived from the words when they're read (pure,
// so tuning the lists needs no re-run), pauses aligned to the loudness analyzer's silences when
// those are cached.
import { availableParallelism, tmpdir } from "node:os";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { Cancelled, ffmpegError, NO_AUDIO_STREAM, spawnRunner, type Runner } from "./analysisRunner.ts";

/** Bumped when the transcript's shape or the way words are made changes, so older cache files are redone. */
export const TRANSCRIPT_VERSION = 1;
/** A gap between words at least this long (seconds) is a pause. */
export const PAUSE_MIN_S = 0.3;
/** Temp folders are uncut-transcript-<server pid>-XXXXXX, so a sweep can tell whose they are. */
export const TEMP_PREFIX = "uncut-transcript-";

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Removes transcript temp folders a server left behind (a crash, a forced quit): those whose server (the pid in the name) is gone, or over an hour old without one. */
export async function sweepStaleTranscriptTemp(dir = tmpdir(), now = Date.now()) {
  const names = await readdir(dir).catch(() => [] as Array<string>);
  await Promise.all(
    names.map(async (name) => {
      const m = /^uncut-transcript-(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(name);
      if (!m) return;
      const pid = m[1] ? Number(m[1]) : undefined;
      if (pid === process.pid) return;
      if (pid !== undefined ? pidAlive(pid) : now - (await stat(join(dir, name)).then((s) => s.mtimeMs, () => now)) < 3600_000) return;
      await rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
    }),
  );
}

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
export interface TranscriptResult {
  readonly hasAudio: boolean;
  readonly seconds?: number;
  /** The spoken language (detected, or the one asked for), ISO 639-1. */
  readonly language?: string;
  /** What was asked: "auto" or a language code. */
  readonly requestedLanguage?: string;
  /** The model that made it (a whisperModels id). */
  readonly model?: string;
  readonly segments?: ReadonlyArray<TranscriptSegment>;
  readonly words?: ReadonlyArray<TranscriptWord>;
}

export const NO_SPEECH_AUDIO: TranscriptResult = { hasAudio: false };

/** A language whisper accepts: "auto" or a 2–3 letter code. */
export const isLanguage = (v: unknown): v is string => typeof v === "string" && /^(auto|[a-z]{2,3})$/.test(v);

// ---- the commands ----

export const extractArgs = (path: string, wav: string) => [
  "-hide_banner",
  "-nostdin",
  "-nostats",
  "-progress",
  "pipe:1",
  "-i",
  path,
  "-map",
  "0:a:0",
  "-vn",
  "-sn",
  "-dn",
  "-ac",
  "1",
  "-ar",
  "16000",
  "-c:a",
  "pcm_s16le",
  "-f",
  "wav",
  "-y",
  wav,
];

/** whisper-cli: full JSON (timed tokens), progress on stderr, Metal by default (whisper.cpp's default). */
export const whisperArgs = (model: string, wav: string, out: string, language: string) => [
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
  String(Math.max(1, Math.min(8, availableParallelism()))),
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
export function parseWhisperJson(latin1: string, seconds?: number): { language?: string; segments: Array<TranscriptSegment>; words: Array<TranscriptWord> } {
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

// ---- running it ----

export interface TranscribeOptions {
  readonly signal: AbortSignal;
  readonly runner?: Runner | undefined;
  /** "auto" (default) or a language code. */
  readonly language?: string | undefined;
  /** The media's length (seconds), for progress and the timeout. */
  readonly seconds?: number | undefined;
  readonly onProgress?: (fraction: number) => void;
  /** Where the temp folder goes (tests). */
  readonly tmpRoot?: string;
}

/** Transcribes the first audio stream of `path` with whisper-cli and `model` (a ggml file). */
export async function analyzeTranscript(ffmpeg: string, whisper: { readonly bin: string; readonly model: string; readonly modelId: string }, path: string, options: TranscribeOptions): Promise<TranscriptResult> {
  const runner = options.runner ?? spawnRunner;
  const language = options.language ?? "auto";
  const timeoutMs = Math.max(60 * 60_000, (options.seconds ?? 0) * 4000);
  const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
  try {
    const wav = join(dir, "audio.wav");
    let duration: number | undefined;
    let decoded = 0;
    const extract = await runner(ffmpeg, extractArgs(path, wav), {
      signal: options.signal,
      timeoutMs,
      onStderr: (line) => {
        const m = /^\s*Duration:\s*(\d+):(\d+):([\d.]+)/.exec(line);
        if (m && duration === undefined) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      },
      onStdout: (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (!m) return;
        decoded = Number(m[1]) / 1e6;
        const total = options.seconds ?? duration;
        if (total) options.onProgress?.(Math.min(0.05, (0.05 * decoded) / total));
      },
    });
    if (extract.code !== 0) {
      if (NO_AUDIO_STREAM.test(extract.stderrTail)) return NO_SPEECH_AUDIO;
      throw new Error(`ffmpeg couldn't read the sound: ${ffmpegError(extract.stderrTail) || `it exited with ${extract.code}`}`);
    }
    if (options.signal.aborted) throw new Cancelled();
    const seconds = decoded > 0 ? decoded : (options.seconds ?? duration);
    const out = join(dir, "transcript");
    // whisper-cli exits non-zero when it can't load the model (3), find the audio (2) or decode it
    // (11); the JSON file is the proof either way (and its error lines say why).
    const run = await runner(whisper.bin, whisperArgs(whisper.model, wav, out, language), {
      signal: options.signal,
      timeoutMs,
      onStderr: (line) => {
        const m = /progress\s*=\s*(\d+)%/.exec(line);
        if (m) options.onProgress?.(Math.min(0.99, 0.05 + 0.94 * (Number(m[1]) / 100)));
      },
    });
    if (options.signal.aborted) throw new Cancelled();
    let json: string;
    try {
      json = (await readFile(`${out}.json`)).toString("latin1");
    } catch {
      throw new Error(`whisper-cli couldn't transcribe it: ${whisperError(run.stderrTail) || `it exited with ${run.code}`}`);
    }
    const parsed = parseWhisperJson(json, seconds);
    return {
      hasAudio: true,
      ...(seconds !== undefined ? { seconds: ms3(seconds) } : {}),
      ...(parsed.language ? { language: parsed.language } : language !== "auto" ? { language } : {}),
      requestedLanguage: language,
      model: whisper.modelId,
      segments: parsed.segments,
      words: parsed.words,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** whisper's last error-looking lines (it logs a lot of model details). */
const whisperError = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /error|failed|cannot|can't|unable|invalid|not found/i.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 400) || ffmpegError(stderr);

// ---- the cache's shape ----

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
/** Whether a cached value has the transcript's shape (anything else is a miss, redone and rewritten). */
export function isTranscriptResult(value: unknown): value is TranscriptResult {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r.hasAudio !== "boolean") return false;
  if (!r.hasAudio) return true;
  if (r.seconds !== undefined && !num(r.seconds)) return false;
  if (r.language !== undefined && typeof r.language !== "string") return false;
  if (!Array.isArray(r.words) || !Array.isArray(r.segments)) return false;
  const wordsOk = r.words.every((w) => w && typeof w === "object" && typeof (w as TranscriptWord).text === "string" && num((w as TranscriptWord).start) && num((w as TranscriptWord).end) && num((w as TranscriptWord).p));
  const n = r.words.length;
  const segmentsOk = r.segments.every((s) => {
    const x = s as TranscriptSegment;
    return x && typeof x === "object" && typeof x.text === "string" && num(x.start) && num(x.end) && Array.isArray(x.words) && x.words.length === 2 && Number.isInteger(x.words[0]) && Number.isInteger(x.words[1]) && x.words[0] >= 0 && x.words[1] <= n && x.words[0] <= x.words[1];
  });
  return wordsOk && segmentsOk;
}

// ---- fillers and pauses (derived when read) ----

// Conservative on purpose: hesitation sounds are safe to cut; discourse words ("no", "znaczy",
// "you know") often carry meaning, so they're marked "maybe" for the agent to judge in context.
// A list applies only to its language ("no" is a Polish filler and an English word).
const HESITATIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  en: ["um", "umm", "uh", "uhh", "uhm", "er", "erm", "hmm", "mm", "mmm"],
  pl: ["yyy", "yy", "yyyy", "eee", "ee", "eeee", "eem", "yyym", "hmm", "mmm", "mhm"],
};
const DISCOURSE: Readonly<Record<string, ReadonlyArray<string>>> = {
  en: ["you know", "i mean"],
  pl: ["no", "znaczy", "jakby", "tak jakby", "wiesz"],
};
export const FILLERS = { hesitation: HESITATIONS, discourse: DISCOURSE } as const;

const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, "").trim();

export interface Filler {
  /** Index of its first word, and how many words. */
  readonly i: number;
  readonly n: number;
  readonly kind: "hesitation" | "maybe";
}

/** The fillers among `words` for `language` (other languages: none; whisper rarely writes them anyway). */
export function fillersOf(words: ReadonlyArray<{ readonly text: string }>, language: string | undefined): Array<Filler> {
  const lang = language === "en" || language === "pl" ? language : undefined;
  if (!lang) return [];
  const hes = new Set(HESITATIONS[lang]);
  const phrases = DISCOURSE[lang]!.map((p) => p.split(" ")).sort((a, b) => b.length - a.length);
  const out: Array<Filler> = [];
  for (let i = 0; i < words.length; i++) {
    const w = bare(words[i]!.text);
    if (hes.has(w)) {
      out.push({ i, n: 1, kind: "hesitation" });
      continue;
    }
    for (const phrase of phrases) {
      if (phrase.every((part, k) => i + k < words.length && bare(words[i + k]!.text) === part)) {
        // A discourse word only counts when it stands apart: "no" ending a clause or followed by a comma.
        const lastText = words[i + phrase.length - 1]!.text;
        const prevText = i > 0 ? words[i - 1]!.text : ".";
        if (phrase.length > 1 || /[,.?!…]$/.test(lastText) || /[,.?!…]$/.test(prevText)) {
          out.push({ i, n: phrase.length, kind: "maybe" });
          i += phrase.length - 1;
        }
        break;
      }
    }
  }
  return out;
}

export interface Pause {
  /** Seconds of the file. */
  readonly start: number;
  readonly end: number;
  /** The word before it (index), or -1 before the first word. */
  readonly after: number;
  readonly edge?: "start" | "end";
  /** With the loudness analysis cached: whether the sound is below its silence threshold here (start/end then come from the silence). */
  readonly silent?: boolean;
}

/**
 * Gaps of at least `min` seconds between words, and before the first and after the last. With
 * `silences` (loudness analyzer, seconds), a pause overlapping one takes the silence's edges
 * (accurate, where whisper's word edges are ±0.1 s), kept between the neighbouring words' starts and
 * ends, and says silent; one overlapping none says silent: false (breath, noise or music there).
 */
export function pausesOf(words: ReadonlyArray<{ readonly start: number; readonly end: number }>, seconds: number | undefined, silences?: ReadonlyArray<{ readonly start: number; readonly end: number }>, min = PAUSE_MIN_S): Array<Pause> {
  const out: Array<Pause> = [];
  if (!words.length) return out;
  const gaps: Array<{ start: number; end: number; after: number; edge?: "start" | "end"; lo: number; hi: number }> = [];
  gaps.push({ start: 0, end: words[0]!.start, after: -1, edge: "start", lo: 0, hi: words[0]!.end });
  for (let i = 1; i < words.length; i++) gaps.push({ start: words[i - 1]!.end, end: words[i]!.start, after: i - 1, lo: words[i - 1]!.start, hi: words[i]!.end });
  const last = words.at(-1)!;
  if (seconds !== undefined) gaps.push({ start: last.end, end: seconds, after: words.length - 1, edge: "end", lo: last.start, hi: seconds });
  for (const g of gaps) {
    let { start, end } = g;
    let silent: boolean | undefined;
    if (silences) {
      let best: { start: number; end: number } | undefined;
      let overlap = 0;
      for (const s of silences) {
        const o = Math.min(s.end, end) - Math.max(s.start, start);
        if (o > overlap) {
          overlap = o;
          best = s;
        }
      }
      silent = best !== undefined;
      if (best) {
        start = Math.max(best.start, g.lo);
        end = Math.min(best.end, g.hi);
      }
    }
    if (end - start < min) continue;
    out.push({ start: ms3(start), end: ms3(end), after: g.after, ...(g.edge ? { edge: g.edge } : {}), ...(silent !== undefined ? { silent } : {}) });
  }
  return out;
}
