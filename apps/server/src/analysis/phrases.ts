// Phrase transcription: a long take is split at its silences into phrases, each phrase is
// transcribed on its own (whisper carries no text between them, so a loop can't spread past one
// phrase), and the answers are merged back into one transcript in seconds of the take.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ENVELOPE_RATE } from "@uncut/core/transcript";

import type { Speech, TranscriptSegment, TranscriptWord } from "../../../../plugins/whisper-transcribe/whisper.ts";
import type { SpeechRequest, Transcribe } from "./transcription.ts";

/** Takes longer than this (seconds) are transcribed phrase by phrase. */
export const PHRASE_TAKE_MIN_S = 90;

export interface PhraseOptions {
  /** A quiet stretch at least this long (seconds) ends a phrase. */
  readonly minGap: number;
  /** Phrases shorter than this join a neighbour when they can. */
  readonly minPhrase: number;
  /** Longer phrases are split at their deepest dip (whisper hears 30 s at a time). */
  readonly maxPhrase: number;
  /** Sound kept around each phrase (seconds), at most half the gap to the next. */
  readonly pad: number;
  /** Sound with less than this (seconds) near the voice's level (a click, a breath, the room) is no phrase. */
  readonly minVoiced: number;
  /** Two phrases further apart than this never join. */
  readonly maxJoinGap: number;
}

export const PHRASE_DEFAULTS: PhraseOptions = { minGap: 0.5, minPhrase: 1.5, maxPhrase: 20, pad: 0.25, minVoiced: 0.3, maxJoinGap: 1.5 };

export interface Span {
  readonly start: number;
  readonly end: number;
}

const ms3 = (s: number) => Math.round(s * 1000) / 1000;

const percentile = (sorted: ReadonlyArray<number>, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]!;

/**
 * The take's levels (dBFS): `threshold` tells sound from the room (well above the floor, not far
 * below the loud parts), `voiced` is near the voice's own level (a phrase has to reach it).
 */
export function takeLevels(db: ArrayLike<number>): { readonly threshold: number; readonly voiced: number } {
  const sorted = Array.from(db).sort((a, b) => a - b);
  if (!sorted.length) return { threshold: -40, voiced: -40 };
  const loud = percentile(sorted, 95);
  return { threshold: Math.max(percentile(sorted, 10) + 8, loud - 35), voiced: loud - 25 };
}

const voicedWindows = (db: ArrayLike<number>, span: { start: number; end: number }, voiced: number) => {
  let n = 0;
  for (let i = span.start; i < span.end; i++) if (db[i]! >= voiced) n++;
  return n;
};

/** Runs of windows at or above the threshold, joined across quiet shorter than minGap (window indices, end exclusive). */
function islands(db: ArrayLike<number>, threshold: number, minGapWindows: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < db.length; i++) {
    if (db[i]! < threshold) continue;
    const last = out.at(-1);
    if (last && i - last.end < minGapWindows) last.end = i + 1;
    else out.push({ start: i, end: i + 1 });
  }
  return out;
}

/** The quietest moment of a phrase away from its edges (a 0.2 s average), where a long phrase is split. */
function deepestDip(db: ArrayLike<number>, start: number, end: number, margin: number): number {
  const half = Math.round(0.1 * ENVELOPE_RATE);
  let best = Math.round((start + end) / 2);
  let lowest = Infinity;
  for (let i = start + margin; i < end - margin; i++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(start, i - half); k < Math.min(end, i + half); k++) {
      sum += db[k]!;
      n++;
    }
    const level = sum / Math.max(1, n);
    if (level < lowest) {
      lowest = level;
      best = i;
    }
  }
  return best;
}

function capLength(db: ArrayLike<number>, phrase: { start: number; end: number }, maxWindows: number, margin: number): Array<{ start: number; end: number }> {
  if (phrase.end - phrase.start <= maxWindows) return [phrase];
  const at = deepestDip(db, phrase.start, phrase.end, Math.min(margin, Math.floor((phrase.end - phrase.start) / 4)));
  return [...capLength(db, { start: phrase.start, end: at }, maxWindows, margin), ...capLength(db, { start: at, end: phrase.end }, maxWindows, margin)];
}

/** Joins each too-short phrase to the nearer neighbour while the gap is small and the result fits. */
function joinShort(phrases: Array<{ start: number; end: number }>, minWindows: number, maxWindows: number, maxGapWindows: number) {
  let i = 0;
  while (i < phrases.length) {
    const p = phrases[i]!;
    if (p.end - p.start >= minWindows) {
      i++;
      continue;
    }
    const prev = phrases[i - 1];
    const next = phrases[i + 1];
    const gapPrev = prev ? p.start - prev.end : Infinity;
    const gapNext = next ? next.start - p.end : Infinity;
    const fitsPrev = prev && gapPrev <= maxGapWindows && p.end - prev.start <= maxWindows;
    const fitsNext = next && gapNext <= maxGapWindows && next.end - p.start <= maxWindows;
    if (fitsPrev && (!fitsNext || gapPrev <= gapNext)) {
      prev.end = p.end;
      phrases.splice(i, 1);
    } else if (fitsNext) {
      next.start = p.start;
      phrases.splice(i, 1);
    } else i++;
  }
}

/**
 * Splits a take into phrases from its 10 ms level envelope (dBFS): sound is what's above
 * takeLevels' threshold, and a phrase has some of it near the voice's level; quiet of at least minGap ends a phrase; short phrases join a close neighbour;
 * long ones are split at their deepest dip; each keeps `pad` of sound around it (never more than
 * half the gap to the next). Seconds of the take.
 */
export function splitPhrases(db: ArrayLike<number>, options: Partial<PhraseOptions> = {}): Array<Span> {
  const o = { ...PHRASE_DEFAULTS, ...options };
  const w = (seconds: number) => Math.round(seconds * ENVELOPE_RATE);
  const levels = takeLevels(db);
  const found = islands(db, levels.threshold, w(o.minGap)).filter((p) => voicedWindows(db, p, levels.voiced) >= w(o.minVoiced));
  const padWindows = w(o.pad);
  const maxCore = w(o.maxPhrase) - 2 * padWindows;
  joinShort(found, w(o.minPhrase), maxCore, w(o.maxJoinGap));
  const capped = found.flatMap((p) => capLength(db, p, maxCore, w(o.minPhrase)));
  return capped.map((p, i) => {
    const prev = capped[i - 1];
    const next = capped[i + 1];
    const before = prev ? Math.min(padWindows, Math.floor((p.start - prev.end) / 2)) : padWindows;
    const after = next ? Math.min(padWindows, Math.floor((next.start - p.end) / 2)) : padWindows;
    return { start: ms3(Math.max(0, p.start - before) / ENVELOPE_RATE), end: ms3(Math.min(db.length, p.end + after) / ENVELOPE_RATE) };
  });
}

// ---- the WAV ----

export interface Pcm {
  readonly rate: number;
  /** Mono 16-bit samples, little endian. */
  readonly data: Buffer;
}

/** The samples of a mono 16-bit PCM WAV (as ffmpeg writes it for whisper). */
export function readPcmWav(wav: Buffer): Pcm {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("The extracted sound isn't a WAV file.");
  let rate = 16000;
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") rate = wav.readUInt32LE(at + 12);
    if (id === "data") return { rate, data: wav.subarray(at + 8, Math.min(wav.length, at + 8 + size)) };
    at += 8 + size + (size % 2);
  }
  throw new Error("The extracted sound has no samples.");
}

/** A stretch of the samples as a WAV of its own. */
export function pcmWav(pcm: Pcm, span: Span): Buffer {
  const first = Math.max(0, Math.floor(span.start * pcm.rate)) * 2;
  const last = Math.min(pcm.data.length, Math.ceil(span.end * pcm.rate) * 2);
  const data = pcm.data.subarray(first, Math.max(first, last));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(pcm.rate, 24);
  header.writeUInt32LE(pcm.rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The level of every 10 ms of the samples (dBFS). */
export function pcmLevels(pcm: Pcm): Float32Array {
  const per = Math.round(pcm.rate / ENVELOPE_RATE);
  const samples = Math.floor(pcm.data.length / 2);
  const db = new Float32Array(Math.ceil(samples / per));
  for (let w = 0; w < db.length; w++) {
    let sum = 0;
    const end = Math.min(samples, (w + 1) * per);
    for (let i = w * per; i < end; i++) sum += (pcm.data.readInt16LE(i * 2) / 32768) ** 2;
    db[w] = 10 * Math.log10(sum / Math.max(1, end - w * per) + 1e-12);
  }
  return db;
}

// ---- the loop guard ----

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** A line said this many times in one phrase is whisper looping, not the speaker. */
export const REPEAT_LINES = 3;
/** Words this many times in a row (the same run of 2 to 6 words) are a loop too. */
export const REPEAT_RUNS = 4;
/** More words a second than anyone speaks: whisper made them up. */
export const MAX_WORDS_PER_S = 7;

/** What whisper says to a breath or the room ("Thank you."), believed only when it's sure. */
const NOISE_ANSWERS = new Set(["thank you", "thanks", "thanks for watching", "thank you for watching", "you", "bye", "bye bye"]);

export type Guarded = { readonly speech: Speech; readonly dropped?: "repeats" | "outside" | "too-many-words" | "noise" };

const nothing = (speech: Speech): Speech => ({ ...(speech.language ? { language: speech.language } : {}), segments: [], words: [] });

/** A short answer whisper isn't sure of: a stock answer to noise, or one or two words all below 0.3. */
function noiseAnswer(words: ReadonlyArray<TranscriptWord>) {
  if (!words.length || words.length > 4) return false;
  const lowest = Math.min(...words.map((w) => w.p));
  if (NOISE_ANSWERS.has(norm(words.map((w) => w.text).join(" "))) && lowest < 0.5) return true;
  return words.length <= 2 && Math.max(...words.map((w) => w.p)) < 0.3;
}

/** Where a run of 2 to 6 words starts repeating REPEAT_RUNS times in a row (the first copy stays), if one does. */
function loopStart(texts: ReadonlyArray<string>): { at: number; end: number } | undefined {
  for (let n = 2; n <= 6; n++) {
    for (let i = 0; i + n * REPEAT_RUNS <= texts.length; i++) {
      let copies = 1;
      while (i + (copies + 1) * n <= texts.length && texts.slice(i + copies * n, i + (copies + 1) * n).join(" ") === texts.slice(i, i + n).join(" ")) copies++;
      if (copies >= REPEAT_RUNS) return { at: i + n, end: i + copies * n };
    }
  }
  return undefined;
}

function keepWords(speech: Speech, keep: (i: number) => boolean): Speech {
  const words: Array<TranscriptWord> = [];
  const segments: Array<TranscriptSegment> = [];
  for (const s of speech.segments) {
    const first = words.length;
    for (let i = s.words[0]; i < s.words[1]; i++) if (keep(i)) words.push(speech.words[i]!);
    if (words.length === first) continue;
    const text =
      s.words[1] - s.words[0] === words.length - first
        ? s.text
        : words
            .slice(first)
            .map((w) => w.text)
            .join(" ");
    segments.push({ ...s, text, words: [first, words.length] });
  }
  return { ...(speech.language ? { language: speech.language } : {}), segments, words };
}

/**
 * What of one phrase's answer to believe (times in seconds of the phrase, `seconds` long): words
 * timed outside the phrase go; a line said REPEAT_LINES times or more keeps only its first time;
 * a run of words repeated REPEAT_RUNS times in a row keeps one copy; an answer with more than
 * MAX_WORDS_PER_S words a second is dropped whole, and so is whisper's unsure answer to noise.
 */
export function guardPhrase(speech: Speech, seconds: number): Guarded {
  let dropped: Guarded["dropped"];
  const outside = new Set<number>();
  speech.words.forEach((w, i) => {
    if (w.start >= seconds || w.end < 0) outside.add(i);
  });
  if (outside.size) dropped = "outside";
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const s of speech.segments) counts.set(norm(s.text), (counts.get(norm(s.text)) ?? 0) + 1);
  for (const s of speech.segments) {
    const key = norm(s.text);
    if ((counts.get(key) ?? 0) < REPEAT_LINES) continue;
    const times = (seen.get(key) ?? 0) + 1;
    seen.set(key, times);
    if (times === 1) continue;
    dropped = "repeats";
    for (let i = s.words[0]; i < s.words[1]; i++) outside.add(i);
  }
  const kept = speech.words.map((w, i) => (outside.has(i) ? undefined : norm(w.text)));
  const texts = kept.filter((t): t is string => t !== undefined);
  const index = kept.flatMap((t, i) => (t === undefined ? [] : [i]));
  for (let loop = loopStart(texts); loop; loop = loopStart(texts)) {
    dropped = "repeats";
    for (const i of index.splice(loop.at, loop.end - loop.at)) outside.add(i);
    texts.splice(loop.at, loop.end - loop.at);
  }
  const speechOut = outside.size ? keepWords(speech, (i) => !outside.has(i)) : speech;
  if (speechOut.words.length > MAX_WORDS_PER_S * Math.max(seconds, 0.5)) return { speech: nothing(speech), dropped: "too-many-words" };
  if (noiseAnswer(speechOut.words)) return { speech: nothing(speech), dropped: "noise" };
  const clamp = (s: number) => ms3(Math.min(seconds, Math.max(0, s)));
  const clamped = {
    ...speechOut,
    words: speechOut.words.map((w) => ({ ...w, start: clamp(w.start), end: clamp(w.end) })),
    segments: speechOut.segments.map((s) => ({ ...s, start: clamp(s.start), end: clamp(s.end) })),
  };
  return dropped ? { speech: clamped, dropped } : { speech: clamped };
}

// ---- merging ----

/** One phrase of the take as the transcript keeps it: its span (seconds of the take, padded), its words [first, end). */
export interface TranscriptPhrase {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly words: readonly [number, number];
  /** What the loop guard took out of whisper's answer, when it did. */
  readonly dropped?: Guarded["dropped"];
}

/** The phrases' answers (seconds of each phrase) as one transcript in seconds of the take; phrases with no words stay out. */
export function mergePhrases(parts: ReadonlyArray<{ readonly span: Span; readonly guarded: Guarded }>): {
  words: Array<TranscriptWord>;
  segments: Array<TranscriptSegment>;
  phrases: Array<TranscriptPhrase>;
} {
  const words: Array<TranscriptWord> = [];
  const segments: Array<TranscriptSegment> = [];
  const phrases: Array<TranscriptPhrase> = [];
  let lastStart = 0;
  for (const { span, guarded } of parts) {
    const { speech } = guarded;
    if (!speech.words.length) continue;
    const offset = words.length;
    const at = (s: number) => ms3(Math.min(span.end, span.start + s));
    for (const w of speech.words) {
      const start = Math.max(lastStart, at(w.start));
      lastStart = start;
      words.push({ ...w, start, end: Math.max(start, at(w.end)) });
    }
    for (const s of speech.segments) segments.push({ ...s, start: at(s.start), end: at(s.end), words: [s.words[0] + offset, s.words[1] + offset] });
    const text = speech.segments.map((s) => s.text.trim()).join(" ");
    phrases.push({ start: span.start, end: span.end, text, words: [offset, words.length], ...(guarded.dropped ? { dropped: guarded.dropped } : {}) });
  }
  return { words, segments, phrases };
}

/** The language most of the speech is in (by phrase length), from each phrase's detected one. */
export function mainLanguage(parts: ReadonlyArray<{ readonly span: Span; readonly language?: string | undefined }>): string | undefined {
  const weight = new Map<string, number>();
  for (const p of parts) if (p.language) weight.set(p.language, (weight.get(p.language) ?? 0) + p.span.end - p.span.start);
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// ---- running it ----

export interface PhraseSpeech extends Speech {
  readonly phrases: Array<TranscriptPhrase>;
}

type TranscribeCall = Parameters<Transcribe>[1];

/** Writes each phrase of the take's WAV beside it as a WAV of its own. */
async function writePhraseWavs(wav: string, pcm: Pcm, spans: ReadonlyArray<Span>) {
  const files = spans.map((_, i) => join(dirname(wav), `phrase-${String(i).padStart(4, "0")}.wav`));
  await Promise.all(spans.map((span, i) => writeFile(files[i]!, pcmWav(pcm, span))));
  return files;
}

/**
 * Transcribes a take (`request.audio`, a 16 kHz mono WAV) phrase by phrase: split at its silences,
 * each phrase transcribed on its own in one model run, phrases whose detected language isn't the
 * take's main one transcribed again in it (when the language is "auto"), each answer through the
 * loop guard, all merged in seconds of the take.
 */
export async function transcribeByPhrases(
  request: SpeechRequest,
  transcribe: Transcribe,
  call: TranscribeCall,
  options: Partial<PhraseOptions> = {},
): Promise<PhraseSpeech> {
  const pcm = readPcmWav(await readFile(request.audio));
  const spans = splitPhrases(pcmLevels(pcm), options);
  if (!spans.length) return { ...(request.language !== "auto" ? { language: request.language } : {}), segments: [], words: [], phrases: [] };
  const files = await writePhraseWavs(request.audio, pcm, spans);
  const first = await transcribe({ ...request, files }, call);
  const answers = [...(first.files ?? [])];
  const language = request.language !== "auto" ? request.language : mainLanguage(spans.map((span, i) => ({ span, language: answers[i]?.language })));
  const strays = request.language === "auto" && language ? answers.flatMap((a, i) => (a.language && a.language !== language ? [i] : [])) : [];
  if (strays.length && language) {
    const again = await transcribe({ ...request, language, files: strays.map((i) => files[i]!) }, { ...call, onProgress: () => {} });
    strays.forEach((i, k) => (answers[i] = again.files?.[k] ?? answers[i]!));
  }
  const merged = mergePhrases(spans.map((span, i) => ({ span, guarded: guardPhrase(answers[i] ?? { segments: [], words: [] }, ms3(span.end - span.start)) })));
  return { ...(language ? { language } : {}), ...merged };
}
