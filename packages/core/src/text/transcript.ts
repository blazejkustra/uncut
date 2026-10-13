// Transcripts in the editing model (D68, D69), browser-safe: the fillers and pauses derived from a
// transcript's words (the server's transcript_read and the Transcript panel derive the same ones),
// and planTextCut, which turns "remove these words / pauses / fillers" into one timeline edit. The
// transcript is in seconds of the media file; the timeline in project frames (D38).
import { applyEdit, createSession, EditError } from "../timeline/apply-ops.ts";
import { keyDbAt } from "../audio/audio.ts";
import { projectDuration, resolveStarts, timelineProblems } from "../timeline/rules.ts";
import type { Item, Op, Project, TimedModule } from "../timeline/types.ts";

/** A gap between words at least this long (seconds) is a pause. */
export const PAUSE_MIN_S = 0.3;

const ms3 = (s: number) => Math.round(s * 1000) / 1000;

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

/** A transcript segment: its span (seconds) and its words [first, end) (whisper's segments, D68). */
export interface SpeechSegment {
  readonly start: number;
  readonly end: number;
  readonly words: readonly [number, number];
}

type Span2 = { readonly start: number; readonly end: number };

/** A segment's edge counts only when at least this far (seconds) from the neighbouring word (speechWords). */
const SEGMENT_EDGE_GAP_S = 0.1;

/** The silence overlapping [start, end] the most, if one does. */
function silenceIn(silences: ReadonlyArray<Span2>, start: number, end: number): Span2 | undefined {
  let best: Span2 | undefined;
  let overlap = 0;
  for (const s of silences) {
    const o = Math.min(s.end, end) - Math.max(s.start, start);
    if (o > overlap) {
      overlap = o;
      best = s;
    }
  }
  return best;
}

// ---- the speech envelope (D74) ----

/**
 * The loudness analyzer's speech envelope as cached: the RMS level of every 1/rate s of the sound
 * (mono), in dBFS, quantised to `step` dB above `db0` (0 = at or below db0) as one byte per window,
 * base64. 10 ms windows at 0.5 dB: 100 bytes a second, ~480 kB of JSON for an hour.
 */
export interface StoredEnvelope {
  readonly rate: number;
  readonly db0: number;
  readonly step: number;
  readonly data: string;
}
/** A decoded envelope: dBFS per window of 1/rate s. */
export interface SpeechEnvelope {
  readonly rate: number;
  readonly db: ArrayLike<number>;
}
export const ENVELOPE_RATE = 100;
const ENVELOPE_DB0 = -100;
const ENVELOPE_STEP = 0.5;

/** dBFS levels (one per window) as a StoredEnvelope. */
export function encodeEnvelope(db: ArrayLike<number>, rate = ENVELOPE_RATE): StoredEnvelope {
  let bin = "";
  for (let i = 0; i < db.length; i++) {
    const v = db[i]!;
    const q = Number.isFinite(v) ? Math.round((v - ENVELOPE_DB0) / ENVELOPE_STEP) : 0;
    bin += String.fromCharCode(Math.max(0, Math.min(255, q)));
  }
  return { rate, db0: ENVELOPE_DB0, step: ENVELOPE_STEP, data: btoa(bin) };
}

/** A cached envelope decoded (undefined when it isn't one). */
export function decodeEnvelope(value: unknown): SpeechEnvelope | undefined {
  const e = value as Partial<StoredEnvelope> | undefined;
  if (!e || typeof e !== "object" || typeof e.data !== "string" || !(typeof e.rate === "number" && e.rate > 0) || typeof e.db0 !== "number" || typeof e.step !== "number") return undefined;
  let bin: string;
  try {
    bin = atob(e.data);
  } catch {
    return undefined;
  }
  const db = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) db[i] = e.db0 + bin.charCodeAt(i) * e.step;
  return { rate: e.rate, db };
}

/** Speech is at most this far (dB) below the speech level (90th percentile): breaths and room tone are further down... */
const SPEECH_RANGE_DB = 25;
/** ...and at least this far above the noise floor (10th percentile: a music or noise bed). */
const ABOVE_FLOOR_DB = 10;
/** Speech ends after this much quiet (s): a stop consonant's closure (≤ ~0.1 s) doesn't end a word. */
const QUIET_HOLD_S = 0.1;
/** The sound moves a word's edge at most this far (s) past where the transcript and silences put it (whisper's sentence ends run up to ~0.3 s early). */
const MAX_EXTEND_S = 0.35;
/** A word whisper timed shorter than this (s) is a timestamp, not a span (fillers: "Um," at 4.02–4.02). */
const SHORT_WORD_S = 0.05;
/** Without an envelope, such a word is given this long (s), centred, between its neighbours; with one, its sound is looked for this far from the timestamp... */
const SHORT_WORD_SPAN_S = 0.2;
/** ...and may last this long on each side of it (a drawn-out "ummm"). */
const SHORT_WORD_MAX_S = 1;

const thresholds = new WeakMap<SpeechEnvelope, number>();
/** The level (dBFS) speech is above: the speech level less SPEECH_RANGE_DB, or the floor plus ABOVE_FLOOR_DB. */
export function speechThreshold(env: SpeechEnvelope): number {
  const known = thresholds.get(env);
  if (known !== undefined) return known;
  const sorted = Float32Array.from(env.db as ArrayLike<number>).sort();
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? -Infinity;
  const thr = Math.max(at(0.9) - SPEECH_RANGE_DB, at(0.1) + ABOVE_FLOOR_DB);
  thresholds.set(env, thr);
  return thr;
}

/**
 * Whether an envelope tells speech from quiet: some windows above the speech threshold and some
 * below (a steady tone or music bed with no gaps has neither, so it says nothing about words).
 */
export function envelopeInformative(env: SpeechEnvelope | undefined): env is SpeechEnvelope {
  if (!env?.db.length) return false;
  const thr = speechThreshold(env);
  let loud = false;
  let quiet = false;
  for (let k = 0; k < env.db.length && !(loud && quiet); k++) env.db[k]! > thr ? (loud = true) : (quiet = true);
  return loud && quiet;
}

type SpeechOptions = { readonly segments?: ReadonlyArray<SpeechSegment> | undefined; readonly silences?: ReadonlyArray<Span2> | undefined; readonly seconds?: number | undefined; readonly envelope?: SpeechEnvelope | undefined };

/** speechWords' words, and which of their edges the sound measured (a silence, or the envelope going quiet). */
export interface HeardWords<W> {
  readonly words: Array<W>;
  /** Per word: its end / start is where the sound stops / starts (a cut there needs no margin into a removed neighbour). */
  readonly endMeasured: ReadonlyArray<boolean>;
  readonly startMeasured: ReadonlyArray<boolean>;
}

/**
 * Where each word is heard, as best the transcript and the sound tell (D74): whisper's word edges
 * are early at the end of a sentence (its last word's end is 0.15–0.65 s before the sound stops,
 * measured on real large-v3-turbo output), while its segments' edges (timestamp tokens) are close.
 * - A word whisper put wholly inside a silence (no sound there) moves to the silence's nearer edge
 *   (and the words after it start no earlier than it).
 * - A segment's last word ends no earlier than the segment and its first word starts no later than
 *   it (unless that edge is within SEGMENT_EDGE_GAP_S of the next / previous word: punctuation timed
 *   at the next word, D68).
 * - With the loudness analyzer's silences, a word before a silence lasts until it starts and a word
 *   after one starts when it ends.
 * - With its speech envelope (when it tells speech from quiet): a word's end follows the sound while
 *   it's above the speech threshold until QUIET_HOLD_S of quiet, its start back the same way, at most
 *   MAX_EXTEND_S, never into a silence or past a neighbour. When two words' sound runs together the
 *   gap between them is split at its quietest window. A word whisper gave no length (a timestamp,
 *   often a filler) takes the sound within SHORT_WORD_SPAN_S of it (up to SHORT_WORD_MAX_S long on
 *   each side); without the envelope it gets SHORT_WORD_SPAN_S around it.
 * Words with sound only get longer here; idempotent (running it on its own output changes nothing).
 */
export function speechEdges<W extends { readonly start: number; readonly end: number }>(words: ReadonlyArray<W>, { segments, silences, seconds, envelope }: SpeechOptions = {}): HeardWords<W> {
  // Copies with writable edges (W's own fields kept).
  const out = words.map((w) => ({ ...w })) as Array<W & { start: number; end: number }>;
  const n = out.length;
  const endMeasured = Array<boolean>(n).fill(false);
  const startMeasured = Array<boolean>(n).fill(false);
  if (!n) return { words: out, endMeasured, startMeasured };
  const limit = seconds ?? Infinity;
  // 1. Words the silences placed (no sound where whisper put them): judged on whisper's own span.
  const moved = new Set<number>();
  if (silences?.length) {
    out.forEach((w, i) => {
      const s = silences.find((x) => x.start <= w.start && w.end <= x.end && x.end - x.start > 0);
      if (!s || (w.start === w.end && (w.start === s.start || w.start === s.end))) return;
      const at = (w.start + w.end) / 2 - s.start < s.end - (w.start + w.end) / 2 ? s.start : s.end;
      w.start = at;
      w.end = at;
      moved.add(i);
    });
  }
  // In order: no word starts before the one before it ends (a moved word can land before its
  // predecessor's end, and push the ones after it).
  for (let i = 1; i < n; i++) {
    const w = out[i]!;
    if (!moved.has(i) && !moved.has(i - 1)) continue;
    if (w.start < out[i - 1]!.end) {
      w.start = out[i - 1]!.end;
      w.end = Math.max(w.end, w.start);
      moved.add(i);
    }
  }
  // 2. Segment edges.
  const lastAt = new Map<number, number>();
  const firstAt = new Map<number, number>();
  for (const s of segments ?? []) {
    const [a, b] = s.words;
    if (!(b > a) || a < 0 || b > n) continue;
    if (Number.isFinite(s.end)) lastAt.set(b - 1, Math.max(lastAt.get(b - 1) ?? -Infinity, s.end));
    if (Number.isFinite(s.start)) firstAt.set(a, Math.min(firstAt.get(a) ?? Infinity, s.start));
  }
  // A segment edge inside a silence is where the silence says the sound stops / starts.
  const outOfSilence = (t: number | undefined, side: "start" | "end") => {
    const s = t === undefined ? undefined : silences?.find((x) => x.start < t && t < x.end);
    return s ? (side === "end" ? s.start : s.end) : t;
  };
  for (let i = 0; i < n; i++) {
    const w = out[i]!;
    const nextStart = i + 1 < n ? out[i + 1]!.start : limit;
    const prevEnd = i > 0 ? out[i - 1]!.end : 0;
    const segEnd = outOfSilence(lastAt.get(i), "end");
    if (segEnd !== undefined && segEnd > w.end && nextStart - segEnd >= SEGMENT_EDGE_GAP_S) w.end = segEnd;
    const segStart = outOfSilence(firstAt.get(i), "start");
    if (segStart !== undefined && segStart < w.start && segStart - prevEnd >= SEGMENT_EDGE_GAP_S) w.start = segStart;
  }
  // 3. The silences in the gaps: before the first word, between words, after the last.
  if (silences?.length) {
    for (let i = -1; i < n; i++) {
      const gapStart = i >= 0 ? out[i]!.end : 0;
      const gapEnd = i + 1 < n ? out[i + 1]!.start : limit;
      if (!(gapEnd >= gapStart) || !Number.isFinite(gapEnd)) continue;
      const s = silenceIn(silences, gapStart, gapEnd);
      if (!s) continue;
      if (i >= 0) {
        if (s.start > out[i]!.end) out[i]!.end = Math.min(s.start, gapEnd);
        endMeasured[i] = true;
      }
      if (i + 1 < n) {
        if (s.end < out[i + 1]!.start) out[i + 1]!.start = Math.max(s.end, i >= 0 ? out[i]!.end : 0);
        startMeasured[i + 1] = true;
      }
    }
  }
  // 4. The sound.
  const short = out.map((w) => w.end - w.start < SHORT_WORD_S - 1e-9);
  if (envelopeInformative(envelope)) {
    const { rate, db } = envelope;
    const thr = speechThreshold(envelope);
    const loud = (k: number) => k >= 0 && k < db.length && db[k]! > thr;
    const end = db.length / rate;
    const silenceAfter = (t: number) => Math.min(...(silences ?? []).filter((x) => x.end > t + 1e-9).map((x) => Math.max(x.start, t)), Infinity);
    const silenceBefore = (t: number) => Math.max(...(silences ?? []).filter((x) => x.start < t - 1e-9).map((x) => Math.min(x.end, t)), -Infinity);
    // Ends, left to right.
    for (let i = 0; i < n; i++) {
      const w = out[i]!;
      if (endMeasured[i]) continue;
      const next = i + 1 < n ? out[i + 1]!.start : Math.min(limit, end);
      const cap = w.end + (short[i] ? SHORT_WORD_MAX_S : MAX_EXTEND_S);
      const silence = silenceAfter(w.end);
      const hold = Math.round(QUIET_HOLD_S * rate);
      // The quiet after the sound may run past the cap; sound past the cap may not.
      const bound = Math.min(next, cap + hold / rate, silence, end);
      let k = Math.floor(w.end * rate + 1e-6);
      // A timestamp in the quiet: its sound may start a little after it, so quiet before the first
      // loud window doesn't end it (not once its end follows sound: then it's an ordinary edge).
      const search = Math.round((short[i] && !loud(k - 1) ? SHORT_WORD_SPAN_S : QUIET_HOLD_S) * rate);
      let lastLoud = -1;
      let quiet = 0;
      let capped = false;
      for (; k < bound * rate - 1e-6 && quiet < (lastLoud < 0 ? search : hold); k++) {
        if (loud(k) && k >= cap * rate - 1e-6) {
          capped = true;
          break;
        }
        if (loud(k)) (lastLoud = k), (quiet = 0);
        else quiet++;
      }
      if (!capped && (quiet >= (lastLoud < 0 ? search : hold) || bound === silence || bound === end)) {
        // The sound went quiet (or a silence or the file's end came first): its end, measured.
        if (lastLoud >= 0) w.end = Math.max(w.end, Math.min(bound, (lastLoud + 1) / rate));
        endMeasured[i] = true;
      } else if (!capped && bound === next) {
        // The sound runs into the next word: split the gap at its quietest window.
        let best = -1;
        for (let j = Math.floor(w.end * rate + 1e-6); j < next * rate - 1e-6; j++) if (best < 0 || db[j]! < db[best]!) best = j;
        if (best >= 0) w.end = Math.max(w.end, Math.min(next, best / rate));
      }
      // Still loud at the cap: not this word's tail (music, another voice); left as it was.
    }
    // Starts, right to left.
    for (let i = n - 1; i >= 0; i--) {
      const w = out[i]!;
      if (startMeasured[i]) continue;
      const prev = i > 0 ? out[i - 1]!.end : 0;
      const cap = w.start - (short[i] ? SHORT_WORD_MAX_S : MAX_EXTEND_S);
      const silence = silenceBefore(w.start);
      const hold = Math.round(QUIET_HOLD_S * rate);
      const bound = Math.max(prev, cap - hold / rate, silence, 0);
      let k = Math.ceil(w.start * rate - 1e-6) - 1;
      const search = Math.round((short[i] && !loud(k + 1) ? SHORT_WORD_SPAN_S : QUIET_HOLD_S) * rate);
      let firstLoud = -1;
      let quiet = 0;
      let capped = false;
      for (; k >= bound * rate - 1e-6 && k >= 0 && quiet < (firstLoud < 0 ? search : hold); k--) {
        if (loud(k) && k < cap * rate - 1e-6) {
          capped = true;
          break;
        }
        if (loud(k)) (firstLoud = k), (quiet = 0);
        else quiet++;
      }
      if (!capped && (quiet >= (firstLoud < 0 ? search : hold) || bound === silence || bound === 0)) {
        if (firstLoud >= 0) w.start = Math.min(w.start, Math.max(bound, firstLoud / rate));
        startMeasured[i] = true;
      } else if (!capped && bound === prev && firstLoud >= 0) {
        // Runs into the word before (its end was split at the quietest window): start there or at the sound.
        w.start = Math.min(w.start, Math.max(prev, firstLoud / rate));
      }
    }
  } else {
    // No envelope: a timestamp gets SHORT_WORD_SPAN_S around it, between its neighbours, not into a silence.
    for (let i = 0; i < n; i++) {
      if (!short[i]) continue;
      const w = out[i]!;
      const mid = (w.start + w.end) / 2;
      const prevEnd = Math.max(i > 0 ? out[i - 1]!.end : 0, ...(silences ?? []).filter((x) => x.start < mid && x.end > mid - SHORT_WORD_SPAN_S / 2).map((x) => Math.min(x.end, mid)));
      const nextStart = Math.min(i + 1 < n ? out[i + 1]!.start : limit, ...(silences ?? []).filter((x) => x.end > mid && x.start < mid + SHORT_WORD_SPAN_S / 2).map((x) => Math.max(x.start, mid)));
      w.start = Math.min(w.start, Math.max(prevEnd, mid - SHORT_WORD_SPAN_S / 2));
      w.end = Math.max(w.end, Math.min(nextStart, mid + SHORT_WORD_SPAN_S / 2));
    }
  }
  for (const w of out) {
    w.start = ms3(w.start);
    w.end = ms3(Math.max(w.end, w.start));
  }
  return { words: out, endMeasured, startMeasured };
}

/** speechEdges' words (where each word is heard, D74). */
export const speechWords = <W extends { readonly start: number; readonly end: number }>(words: ReadonlyArray<W>, options: SpeechOptions = {}): Array<W> => speechEdges(words, options).words;

/**
 * Gaps of at least `min` seconds between words, and before the first and after the last, between
 * where the words are heard (speechWords: whisper's words, its segments' edges and the silences).
 * With `silences` (loudness analyzer, seconds), a pause overlapping one starts where the word
 * before it ends or the silence starts, whichever is later (a −40 dB silence can start in a word's
 * quiet decay), and ends where the silence ends (onsets are sharp; it may take the start of a word
 * whisper timed too early, never past its end), and says silent; one overlapping none says
 * silent: false (breath, noise or music there).
 */
export function pausesOf(words: ReadonlyArray<{ readonly start: number; readonly end: number }>, seconds: number | undefined, silences?: ReadonlyArray<{ readonly start: number; readonly end: number }>, min = PAUSE_MIN_S, segments?: ReadonlyArray<SpeechSegment>, envelope?: SpeechEnvelope): Array<Pause> {
  const out: Array<Pause> = [];
  if (!words.length) return out;
  const heard = speechWords(words, { segments, silences, seconds, envelope });
  const gaps: Array<{ start: number; end: number; after: number; edge?: "start" | "end"; hi: number }> = [];
  gaps.push({ start: 0, end: heard[0]!.start, after: -1, edge: "start", hi: heard[0]!.end });
  for (let i = 1; i < heard.length; i++) gaps.push({ start: heard[i - 1]!.end, end: heard[i]!.start, after: i - 1, hi: heard[i]!.end });
  const last = heard.at(-1)!;
  if (seconds !== undefined) gaps.push({ start: last.end, end: Math.max(seconds, last.end), after: heard.length - 1, edge: "end", hi: seconds });
  for (const g of gaps) {
    let { start, end } = g;
    let silent: boolean | undefined;
    if (silences) {
      const best = silenceIn(silences, start, end);
      silent = best !== undefined;
      if (best) {
        start = Math.max(best.start, g.start);
        end = Math.max(start, Math.min(best.end, g.hi));
      }
    }
    if (end - start < min - 1e-9) continue;
    out.push({ start: ms3(start), end: ms3(end), after: g.after, ...(g.edge ? { edge: g.edge } : {}), ...(silent !== undefined ? { silent } : {}) });
  }
  return out;
}

// ---- cutting by text (D69) ----

/** Seconds of sound kept before a word that stays, at a cut (onsets are sharp; ~67 ms). */
export const HEAD_S = 0.06;
/** Seconds kept after a word that stays (its decay and final consonant fade slowly, D74). */
export const TAIL_S = 0.15;

/**
 * Frames kept before a word that stays, on each cut next to it: 2 at 24–30 fps, 3 at 50, 4 at 60
 * (HEAD_S, at least 2). A removed pause keeps this much before the word after it too.
 */
export const handleFrames = (fps: number) => Math.max(2, Math.ceil(HEAD_S * fps - 1e-6));

/**
 * Frames kept after a word that stays (D74): TAIL_S, at least 3: 5 at 30 fps, 4 at 24–25, 8 at 50,
 * 9 at 60. Longer than the head: a word's end fades out slowly (below a −40 dB silence's start)
 * and whisper's ends run early, so a cut right after one clips its tail.
 */
export const tailFrames = (fps: number) => Math.max(3, Math.ceil(TAIL_S * fps - 1e-6));

/** Removing pauses: those at least this long (seconds) by default (the panel's threshold). */
export const DEFAULT_PAUSE_MIN_S = 0.5;

export interface CutWord {
  readonly text: string;
  /** Seconds of the media file. */
  readonly start: number;
  readonly end: number;
}

export interface CutTranscript {
  readonly words: ReadonlyArray<CutWord>;
  /** The spoken language (fillers are recognised for en and pl). */
  readonly language?: string | undefined;
  /** The file's length in seconds (for the pause after the last word). */
  readonly seconds?: number | undefined;
  /** Whisper's segments (their edges extend the words at the ends of a sentence, speechWords). */
  readonly segments?: ReadonlyArray<SpeechSegment> | undefined;
}

export interface TextCutRequest {
  /**
   * Word index ranges to remove, both ends included (transcript_read's w12 is index 12). With
   * `clip`, only from that main-track clip (the panel: where the words were selected); otherwise
   * from every clip that plays them.
   */
  readonly remove?: ReadonlyArray<{ readonly from: number; readonly to: number; readonly clip?: string | undefined }>;
  /** Remove pauses at least `min` seconds long (keeping tailFrames after a kept word and handleFrames before one). */
  readonly pauses?: { readonly min: number };
  /** Remove the hesitation fillers (um, uh, yyy, eee); "maybe" fillers are never removed here. */
  readonly fillers?: boolean;
  /** The loudness analyzer's silences (seconds), when known: pauses take their edges (as transcript_read does). */
  readonly silences?: ReadonlyArray<{ readonly start: number; readonly end: number }> | undefined;
  /** The loudness analyzer's speech envelope, when known: words end where their sound does (D74). */
  readonly envelope?: SpeechEnvelope | undefined;
  /** Only these main-track clips (the panel cuts where the words were selected); default: every main clip using the media. */
  readonly clips?: ReadonlyArray<string>;
}

/** One stretch of the media that was cut, wherever it is on the main track. */
export interface TextCut {
  /** Project frames of the media: [from, to). */
  readonly from: number;
  readonly to: number;
  /** The removed words: the first and last index, and their text ("" for a pause). */
  readonly words?: readonly [number, number];
  readonly text: string;
  readonly pauses: number;
  readonly fillers: number;
  /** Timeline frames it removed (all clips together) and the clips it came out of. */
  readonly frames: number;
  readonly clips: ReadonlyArray<string>;
}

export interface TextCutPlan {
  /** One edit: send all of it as one project.edit / agent edit, so one undo restores it. */
  readonly ops: ReadonlyArray<Op>;
  readonly summary: string;
  readonly cuts: ReadonlyArray<TextCut>;
  /** Timeline frames the main track got shorter by. */
  readonly framesRemoved: number;
  /** The project's length before and after, in frames. */
  readonly before: number;
  readonly after: number;
  /** What was asked for but not done, and other things worth saying (sentences). */
  readonly notes: ReadonlyArray<string>;
  /** The project after the edit (checked with the timeline rules). */
  readonly project: Project;
}

interface Span {
  from: number;
  to: number;
  words: Array<number>;
  pauses: number;
  fillers: number;
}

/** A piece shorter than this (frames) is a sliver: a cut doesn't leave one between itself and an earlier cut. */
const MIN_PIECE = 3;
const floorF = (x: number) => Math.floor(x + 1e-6);
const ceilF = (x: number) => Math.ceil(x - 1e-6);
const quote = (text: string, max = 48) => `"${text.length > max ? `${text.slice(0, max - 1)}…` : text}"`;
const wordsText = (words: ReadonlyArray<CutWord>, ids: ReadonlyArray<number>) => ids.map((i) => words[i]!.text.trim()).join(" ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const wordIds = (ids: ReadonlyArray<number>) => `w${ids[0]}${ids.length > 1 ? `–w${ids.at(-1)}` : ""}`;

/** An id nothing in the project (or `taken`) uses yet: base-1, base-2, … */
function freeId(project: Project, base: string, taken: Set<string>) {
  const ids = new Set([...taken, ...project.media.map((m) => m.id), ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]), ...(project.scenes ?? []).map((s) => s.id)]);
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!ids.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** Runs of consecutive indices. */
function runsOf(ids: Iterable<number>): Array<Array<number>> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const runs: Array<Array<number>> = [];
  for (const i of sorted) {
    const last = runs.at(-1);
    if (last && last.at(-1) === i - 1) last.push(i);
    else runs.push([i]);
  }
  return runs;
}

/**
 * The stretches of the media to cut from one clip, in project frames of the media, merged. A word
 * counts as kept when it isn't removed and the clip still plays it (its middle frame); only kept
 * words get a handle. Words: a run of removed words, widened over neighbours that aren't kept but
 * of which the clip still plays a few frames (the sliver an earlier cut's handle left), from the frame its first word starts in to the frame
 * after its last one ends (the transcript's covering convention), pulled back to keep tailFrames after
 * the kept word before it and handleFrames before the kept word after it. So deleting touching words one by one ends like deleting them
 * together, and a selection across a clip seam leaves no slivers. Pauses: inward (both ends inside
 * the gap), keeping tailFrames after a kept word and handleFrames before one (none next to one that goes). Edge pauses
 * (before the first word, after the last) run to the media's start or end.
 */
function spansFor(words: ReadonlyArray<CutWord>, removed: ReadonlySet<number>, fillerWords: ReadonlySet<number>, kept: (i: number) => boolean, sliver: (i: number) => boolean, pauses: ReadonlyArray<Pause>, fps: number, length: number, tight: Set<number>, measured: { readonly endMeasured: ReadonlyArray<boolean>; readonly startMeasured: ReadonlyArray<boolean> } = { endMeasured: [], startMeasured: [] }): Array<Span> {
  const n = words.length;
  // Kept after a kept word (its tail) and before one (its head), D74.
  const T = tailFrames(fps);
  const H = handleFrames(fps);
  const f = (s: number) => s * fps;
  const clamp = (v: number) => Math.min(length, Math.max(0, v));
  const spans: Array<Span> = [];
  // Words a removed run took with it (slivers of words mostly cut): no pause handle next to them.
  const absorbed = new Set<number>();
  for (const run of runsOf(removed)) {
    let a = run[0]!;
    let b = run.at(-1)!;
    while (a > 0 && !kept(a - 1) && sliver(a - 1)) a--;
    while (b + 1 < n && !kept(b + 1) && sliver(b + 1)) b++;
    let from = floorF(f(words[a]!.start));
    let to = ceilF(f(words[b]!.end));
    // A neighbour that's gone from the clip (an earlier cut took it): a sliver of the gap up to it
    // (under MIN_PIECE frames) goes too, so cutting words one by one leaves no blip between the cuts.
    if (a > 0 && !kept(a - 1) && !sliver(a - 1)) {
      const gapFrom = ceilF(f(words[a - 1]!.end));
      if (from - gapFrom < MIN_PIECE) from = Math.min(from, gapFrom);
    }
    if (b + 1 < n && !kept(b + 1) && !sliver(b + 1)) {
      const gapTo = floorF(f(words[b + 1]!.start));
      if (gapTo - to < MIN_PIECE) to = Math.max(to, gapTo);
    }
    // A kept word's edge the sound measured (D74: the envelope went quiet, or a silence): the
    // removed words' sound goes whole, the margin only takes the gap. Otherwise (whisper's edges,
    // or two words whose sound runs together) the kept word's margin wins.
    if (a > 0 && kept(a - 1)) {
      const keptEnd = ceilF(f(words[a - 1]!.end));
      from = measured.endMeasured[a - 1] ? Math.max(from, keptEnd) : Math.max(from, keptEnd + T);
    }
    if (b + 1 < n && kept(b + 1)) {
      const keptStart = floorF(f(words[b + 1]!.start));
      to = measured.startMeasured[b + 1] ? Math.min(to, keptStart) : Math.min(to, keptStart - H);
    }
    from = clamp(from);
    to = clamp(to);
    if (to - from < 1) {
      for (const i of run) tight.add(i);
      continue;
    }
    for (let k = a; k <= b; k++) absorbed.add(k);
    spans.push({ from, to, words: [...run], pauses: 0, fillers: run.filter((i) => fillerWords.has(i)).length });
  }
  // A pause keeps a handle next to a word that isn't removed and still has frames in the clip, even
  // when its middle frame doesn't play there: a pause aligned to a silence can take the middle of a
  // word whisper timed too late, and the next plan (Remove pauses again, after a cut) must not then
  // cut the handle that was left (D72).
  // A word a removed run took with it isn't near: a handle there would leave a sliver (D72 review).
  const near = (i: number) => kept(i) || (!removed.has(i) && !absorbed.has(i) && sliver(i));
  for (const p of pauses) {
    const before = p.after >= 0 && near(p.after) ? T : 0;
    const after = p.after + 1 < n && near(p.after + 1) ? H : 0;
    const from = clamp(p.edge === "start" ? 0 : ceilF(f(p.start)) + before);
    const to = clamp(p.edge === "end" ? length : floorF(f(p.end)) - after);
    if (to - from >= 1) spans.push({ from, to, words: [], pauses: 1, fillers: 0 });
  }
  spans.sort((x, y) => x.from - y.from);
  const merged: Array<Span> = [];
  for (const sp of spans) {
    const last = merged.at(-1);
    if (last && sp.from <= last.to) {
      last.to = Math.max(last.to, sp.to);
      last.words.push(...sp.words);
      last.pauses += sp.pauses;
      last.fillers += sp.fillers;
    } else merged.push({ ...sp, words: [...sp.words] });
  }
  return merged;
}

/** Local frames [a, b) of a clip that show media frames [from, to) (at the clip's speed). */
function localRange(item: Item, from: number, to: number): [number, number] {
  const inF = item.in ?? 0;
  const speed = item.speed ?? 1;
  const a = Math.max(0, Math.ceil((from - inF) / speed - 1e-9));
  const b = Math.min(item.duration, Math.ceil((to - inF) / speed - 1e-9));
  return [a, b];
}

/** update_item fixes for a piece a cut made shorter: fades, animations and keys that no longer fit. */
function fitPiece(item: Item): Op | undefined {
  const d = item.duration;
  const set: Record<string, unknown> = {};
  const fi = item.fadeIn ?? 0;
  const fo = item.fadeOut ?? 0;
  if (fi + fo > d) {
    const nfi = Math.min(fi, d);
    const nfo = Math.min(fo, d - nfi);
    if (nfi !== fi) set.fadeIn = nfi || null;
    if (nfo !== fo) set.fadeOut = nfo || null;
  }
  if (item.animation && Object.values(item.animation).some((a) => a && a.duration > d)) {
    const fitted: Record<string, TimedModule> = {};
    for (const [k, a] of Object.entries(item.animation)) if (a) fitted[k] = { ...a, duration: Math.min(a.duration, d) };
    set.animation = fitted;
  }
  if (item.keys?.some((k) => k.frame > d)) {
    const kept = item.keys.filter((k) => k.frame <= d);
    set.keys = kept.length ? kept : null;
  }
  if (item.gainKeys?.some((k) => k.frame > d)) {
    // The envelope keeps its value at the new end.
    const kept = item.gainKeys.filter((k) => k.frame <= d);
    if (!kept.some((k) => k.frame === d)) kept.push({ frame: d, db: keyDbAt(item.gainKeys, d) });
    set.gainKeys = kept;
  }
  return Object.keys(set).length ? { op: "update_item", item: item.id, set } : undefined;
}

/**
 * Cut words (ranges of word indices), pauses (at least `min` seconds) and/or hesitation fillers of
 * a media file out of the edit: from every main-track clip that uses the media (or only
 * `request.clips`, or a range's own `clip`), respecting each clip's in-point, length and speed. The
 * main track is magnetic, so the clips after a cut close up; items on other tracks don't move (as
 * deleting on main, D52). Each clip's stretches are merged and snapped to frames (words cover their
 * frames, pauses go inward, tailFrames stay after and handleFrames before every word that's kept), a cut
 * never leaves an empty clip, and transitions at the cuts that change are removed (D52). All of it
 * is one edit. Words that aren't in the edit any more (already cut) change nothing and come back
 * as a note.
 */
export function planTextCut(project: Project, mediaId: string, transcript: CutTranscript, request: TextCutRequest): TextCutPlan | { readonly problem: string } {
  const media = project.media.find((m) => m.id === mediaId);
  if (!media) return { problem: `There's no media "${mediaId}" in this project.` };
  if (!request.remove?.length && !request.pauses && !request.fillers) return { problem: "Say what to remove: word ranges, pauses or fillers." };
  const main = project.tracks.find((t) => t.role === "main");
  if (!main) return { problem: "This project has no main track." };
  if (main.locked) return { problem: "The main track is locked. Unlock it to cut by text." };
  const fps = project.canvas.fps;
  // Where the words are heard (whisper's words widened to its segments' edges and the silences, D74):
  // every rule below (kept, handles, pauses) works on these.
  const heard = speechEdges(transcript.words, { segments: transcript.segments, silences: request.silences, seconds: transcript.seconds, envelope: request.envelope });
  const { words } = heard;
  const n = words.length;
  const length = media.probe?.frames ?? ceilF((transcript.seconds ?? words.at(-1)?.end ?? 0) * fps);
  const notes: Array<string> = [];

  // What's asked: words for every clip, words for one clip, fillers, pauses.
  const everywhere = new Set<number>();
  const perClipWords = new Map<string, Set<number>>();
  for (const r of request.remove ?? []) {
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 0 || r.to < r.from) return { problem: `A word range must go from a word to the same or a later one (got ${r.from}–${r.to}).` };
    if (r.to >= n) return { problem: `The transcript has ${plural(n, "word")} (w0–w${n - 1}); there's no w${r.to}.` };
    const into = r.clip === undefined ? everywhere : (perClipWords.get(r.clip) ?? perClipWords.set(r.clip, new Set()).get(r.clip)!);
    for (let i = r.from; i <= r.to; i++) into.add(i);
  }
  const fillerWords = new Set<number>();
  if (request.fillers) {
    if (transcript.language !== "en" && transcript.language !== "pl") notes.push(`Fillers are only recognised in English and Polish (this transcript is ${transcript.language ?? "in an unknown language"}).`);
    for (const fl of fillersOf(words, transcript.language)) if (fl.kind === "hesitation") for (let k = 0; k < fl.n; k++) (everywhere.add(fl.i + k), fillerWords.add(fl.i + k));
  }
  let pauses: Array<Pause> = [];
  if (request.pauses) {
    const min = request.pauses.min;
    if (!(typeof min === "number" && Number.isFinite(min) && min > 0)) return { problem: "pauses.min must be a number of seconds above 0." };
    pauses = pausesOf(words, transcript.seconds, request.silences, Math.max(min, 0.05), undefined, request.envelope);
  }

  const only = request.clips ? new Set(request.clips) : undefined;
  const starts = resolveStarts(project);
  const before = projectDuration(project);
  const mainBefore = main.items.reduce((s, i) => s + i.duration, 0);
  const clips = main.items.filter((i) => i.type === "clip" && i.media === mediaId && (!only || only.has(i.id) || perClipWords.has(i.id)));
  const lockedClips = clips.filter((i) => i.locked);
  if (lockedClips.length) notes.push(`${lockedClips.map((i) => i.id).join(", ")} ${lockedClips.length === 1 ? "is" : "are"} locked, so nothing was cut from ${lockedClips.length === 1 ? "it" : "them"}.`);
  const cuttable = clips.filter((i) => !i.locked);
  /** Whether a clip plays any frame word i covers. */
  const touches = (item: Item, i: number) => {
    const inF = item.in ?? 0;
    return floorF(words[i]!.start * fps) < inF + item.duration * (item.speed ?? 1) && ceilF(words[i]!.end * fps) > inF;
  };
  /** Whether a clip plays word i (its middle frame). */
  const plays = (item: Item, i: number) => {
    const mid = floorF(((words[i]!.start + words[i]!.end) / 2) * fps);
    const inF = item.in ?? 0;
    return mid >= inF && mid < inF + item.duration * (item.speed ?? 1);
  };

  // Each clip's stretches, as local frames; the same media stretch in several clips is one cut.
  const byStretch = new Map<string, { from: number; to: number; words: Set<number>; pauses: number; fillers: number; frames: number; clips: Array<string> }>();
  const perClip = new Map<string, Array<[number, number]>>();
  const tight = new Set<number>();
  const cutWords = new Set<number>();
  const slowWords = new Set<number>();
  for (const item of cuttable) {
    const removed = new Set([...everywhere, ...(perClipWords.get(item.id) ?? [])]);
    if (!removed.size && !pauses.length) continue;
    const kept = (i: number) => !removed.has(i) && plays(item, i);
    const ranges: Array<[number, number]> = [];
    for (const sp of spansFor(words, removed, fillerWords, kept, (i) => touches(item, i), pauses, fps, length, tight, heard)) {
      const [a, b] = localRange(item, sp.from, sp.to);
      if (b <= a) {
        if ((item.speed ?? 1) !== 1) for (const i of sp.words) if (plays(item, i)) slowWords.add(i);
        continue;
      }
      ranges.push([a, b]);
      for (const i of sp.words) cutWords.add(i);
      // Reported as the media frames really removed, one entry per set of words (or pause).
      const inF = item.in ?? 0;
      const speed = item.speed ?? 1;
      const mFrom = Math.round(inF + a * speed);
      const mTo = Math.round(inF + b * speed);
      const key = sp.words.length ? `w${[...new Set(sp.words)].sort((x, y) => x - y).join(",")}` : `${sp.from}-${sp.to}`;
      const entry = byStretch.get(key) ?? byStretch.set(key, { from: mFrom, to: mTo, words: new Set(), pauses: sp.pauses, fillers: sp.fillers, frames: 0, clips: [] }).get(key)!;
      entry.from = Math.min(entry.from, mFrom);
      entry.to = Math.max(entry.to, mTo);
      for (const i of sp.words) entry.words.add(i);
      entry.frames += b - a;
      entry.clips.push(item.id);
    }
    // Touching local ranges (rounding at a speed) are one cut.
    const merged: Array<[number, number]> = [];
    for (const r of ranges.sort((x, y) => x[0] - y[0])) {
      const last = merged.at(-1);
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    if (merged.length) perClip.set(item.id, merged);
  }

  const ops: Array<Op> = [];
  const drops = new Set<string>();
  const taken = new Set<string>();
  const pieces: Array<string> = [];
  for (const item of cuttable) {
    const ranges = perClip.get(item.id);
    if (!ranges) continue;
    // What's kept of the clip, for the transitions at its ends.
    const keptParts: Array<[number, number]> = [];
    let at = 0;
    for (const [a, b] of ranges) {
      if (a > at) keptParts.push([at, a]);
      at = b;
    }
    if (at < item.duration) keptParts.push([at, item.duration]);
    const index = main.items.indexOf(item);
    const next = main.items[index + 1];
    const first = keptParts[0];
    const last = keptParts.at(-1);
    if (item.transitionIn && !(first && first[0] === 0 && first[1] - first[0] >= 2 * item.transitionIn.duration)) drops.add(item.id);
    if (next?.transitionIn && !(last && last[1] === item.duration && last[1] - last[0] >= 2 * next.transitionIn.duration)) drops.add(next.id);
    // Right to left, so the left part keeps its id and its local frames. A new id only for a real
    // split (a cut inside the clip), handed out left to right (clip-2 before clip-3 on the timeline).
    const base = item.id.replace(/-\d+$/, "") || "clip";
    const newIds = ranges.filter(([a, b]) => a > 0 && b < item.duration).map(() => freeId(project, base, taken));
    let end = item.duration;
    const clipOps: Array<Op> = [];
    for (const [a, b] of [...ranges].reverse()) {
      if (b >= end) {
        if (a === 0) clipOps.push({ op: "delete_item", item: item.id });
        else clipOps.push({ op: "trim_item", item: item.id, edge: "end", frames: end - a });
      } else if (a === 0) {
        clipOps.push({ op: "trim_item", item: item.id, edge: "start", frames: b });
      } else {
        const newId = newIds.pop()!;
        clipOps.push({ op: "split_item", item: item.id, at: b, newId }, { op: "trim_item", item: item.id, edge: "end", frames: b - a });
        pieces.push(newId);
      }
      end = a;
    }
    ops.push(...clipOps);
    if (keptParts.length) pieces.push(item.id);
  }
  // A transition goes before the ops that cut its clip (it may be deleted).
  ops.unshift(...[...drops].map((id): Op => ({ op: "set_transition", item: id, transition: null })));

  // Asked-for words that weren't cut, and why: not played by any clip (already cut), too tight
  // between the words around them, or too short at a clip's speed.
  const asked = new Map<number, Array<Item>>();
  for (const i of everywhere) asked.set(i, cuttable);
  for (const [clip, ids] of perClipWords) for (const i of ids) asked.set(i, [...(asked.get(i) ?? []), ...cuttable.filter((c) => c.id === clip)]);
  for (const run of runsOf([...asked.keys()].filter((i) => !cutWords.has(i)))) {
    const where = `${quote(wordsText(words, run))} (${wordIds(run)})`;
    if (!run.some((i) => asked.get(i)!.some((c) => plays(c, i)))) notes.push(`${where} isn't in the edit${lockedClips.length ? " (or only in a locked clip)" : " any more (already cut)"}, so nothing changed there.`);
    else if (run.some((i) => slowWords.has(i))) notes.push(`${where} is too short to cut at the clip's speed: it lasts less than a frame there.`);
    else if (run.some((i) => tight.has(i))) notes.push(`${where} runs into the words around it, so it can't be cut without clipping them.`);
  }
  if (request.pauses && ![...byStretch.values()].some((c) => c.pauses)) {
    if (!pauses.length || !cuttable.length) notes.push("There are no pauses that long in the edit.");
    else notes.push(`The ${plural(pauses.length, "pause")} of that length ${pauses.length === 1 ? "isn't" : "aren't"} in the edit, or leave nothing to cut after keeping ${tailFrames(fps)} frames after the words and ${handleFrames(fps)} before them.`);
  }
  if (!clips.length) notes.push(`No clip on the main track uses ${media.name}${only ? " (among the clips asked for)" : ""}.`);
  const elsewhere = project.tracks.filter((t) => t.role !== "main").flatMap((t) => t.items.filter((i) => i.media === mediaId).map((i) => i.id));
  if (elsewhere.length && perClip.size) notes.push(`${elsewhere.join(", ")} on other tracks also ${elsewhere.length === 1 ? "uses" : "use"} ${media.name} and weren't cut: only the main track is cut by text.`);

  let draft: Project;
  try {
    draft = applyEdit(createSession(project), { actor: "user", ops }).project;
    // Shorter pieces: fades, animations and keys that no longer fit are shortened in the same edit.
    for (const id of pieces) {
      const piece = draft.tracks.flatMap((t) => t.items).find((i) => i.id === id);
      const fix = piece && fitPiece(piece);
      if (fix) ops.push(fix);
    }
    draft = applyEdit(createSession(project), { actor: "user", ops }, timelineProblems).project;
  } catch (error) {
    const first = error instanceof EditError ? (error.details[0] as { message?: string } | undefined) : undefined;
    return { problem: `That cut doesn't work: ${first?.message ?? (error as Error).message}.` };
  }
  const draftMain = draft.tracks.find((t) => t.role === "main")!;
  const framesRemoved = mainBefore - draftMain.items.reduce((s, i) => s + i.duration, 0);
  const after = projectDuration(draft);
  // Free-track items after the first cut don't move with the main track: worth a look.
  if (framesRemoved > 0) {
    let firstCut = Infinity;
    for (const item of cuttable) {
      const r = perClip.get(item.id);
      if (r) firstCut = Math.min(firstCut, (starts.get(item.id) ?? 0) + r[0]![0]);
    }
    const shifted = project.tracks.filter((t) => t.role !== "main").flatMap((t) => t.items.filter((i) => (i.start ?? 0) + i.duration > firstCut));
    if (shifted.length) notes.push(`Items on other tracks (${shifted.slice(0, 4).map((i) => i.id).join(", ")}${shifted.length > 4 ? ", …" : ""}) didn't move with the main track; check they still line up.`);
  }

  const cuts: Array<TextCut> = [...byStretch.values()]
    .sort((x, y) => x.from - y.from)
    .map((c) => {
      const ids = [...c.words].sort((x, y) => x - y);
      return { from: c.from, to: c.to, ...(ids.length ? { words: [ids[0]!, ids.at(-1)!] as const } : {}), text: wordsText(words, ids), pauses: c.pauses, fillers: c.fillers, frames: c.frames, clips: c.clips };
    });
  const wordCount = new Set(cuts.flatMap((c) => (c.words ? Array.from({ length: c.words[1] - c.words[0] + 1 }, (_, k) => c.words![0] + k) : []))).size;
  const pauseCount = cuts.reduce((m, c) => m + c.pauses, 0);
  const fillerCount = cuts.reduce((m, c) => m + c.fillers, 0);
  const secs = `${(framesRemoved / fps).toFixed(1)} s`;
  const onlyPauses = !request.remove?.length && !request.fillers;
  const onlyFillers = !request.remove?.length && !request.pauses;
  const summary = !ops.length
    ? ""
    : onlyPauses
      ? `Removed ${plural(pauseCount, "pause")} (${secs})`
      : onlyFillers
        ? `Removed ${plural(fillerCount, "filler")} (${secs})`
        : cuts.length === 1 && !pauseCount && cuts[0]!.text
          ? `Cut ${quote(cuts[0]!.text, 40)} (${secs})`
          : `Cut ${[wordCount ? plural(wordCount, "word") : "", pauseCount ? plural(pauseCount, "pause") : ""].filter(Boolean).join(" and ")} (${secs})`;
  if (!ops.length && !notes.length) notes.push(onlyFillers ? "There are no hesitation fillers in the edit." : "Nothing to cut.");
  return { ops, summary, cuts, framesRemoved, before, after, notes, project: draft };
}

/** The words under the main track in edit order, as the Transcript panel lists them (what you'd hear). */
export interface EditWord {
  /** The main-track clip it's heard in, and the word's index in its media's transcript. */
  readonly clip: string;
  readonly media: string;
  readonly index: number;
  /** Timeline frames it's heard over: [start, end). */
  readonly start: number;
  readonly end: number;
}

/**
 * Every word heard on the main track, clip by clip in edit order: a word belongs to a clip when its
 * middle is inside the stretch of the media the clip plays; its timeline frames are where its
 * covering frames land (clipped to the clip). `transcripts` maps media ids to their words.
 */
export function editWords(project: Pick<Project, "tracks" | "canvas">, transcripts: ReadonlyMap<string, ReadonlyArray<CutWord>>): Array<EditWord> {
  const fps = project.canvas.fps;
  const main = project.tracks.find((t) => t.role === "main");
  const out: Array<EditWord> = [];
  if (!main) return out;
  // Each word list's middles, and whether they only go up (whisper's do): then each clip finds its
  // first word by binary search and stops at the first one past its stretch, so a long edit of many
  // clips over an hour of words costs O(clips · log words + words heard), not O(clips · words).
  const mids = new Map<ReadonlyArray<CutWord>, { mid: Float64Array; sorted: boolean }>();
  const midsOf = (words: ReadonlyArray<CutWord>) => {
    let m = mids.get(words);
    if (!m) {
      const mid = Float64Array.from(words, (w) => (w.start + w.end) / 2);
      let sorted = true;
      for (let i = 1; i < mid.length && sorted; i++) if (mid[i]! < mid[i - 1]!) sorted = false;
      m = { mid, sorted };
      mids.set(words, m);
    }
    return m;
  };
  let t = 0;
  for (const item of main.items) {
    const words = item.type === "clip" && item.media ? transcripts.get(item.media) : undefined;
    if (words) {
      const inF = item.in ?? 0;
      const speed = item.speed ?? 1;
      const lo = inF / fps;
      const hi = (inF + item.duration * speed) / fps;
      const { mid, sorted } = midsOf(words);
      let first = 0;
      if (sorted) {
        let a = 0;
        let b = mid.length;
        while (a < b) {
          const m = (a + b) >> 1;
          if (mid[m]! < lo) a = m + 1;
          else b = m;
        }
        first = a;
      }
      for (let index = first; index < words.length; index++) {
        const w = words[index]!;
        const c = mid[index]!;
        if (c >= hi) {
          if (sorted) break;
          continue;
        }
        if (c < lo) continue;
        const start = Math.max(0, Math.floor((floorF(w.start * fps) - inF) / speed));
        const end = Math.min(item.duration, Math.max(start + 1, Math.ceil((ceilF(w.end * fps) - inF) / speed)));
        out.push({ clip: item.id, media: item.media!, index, start: t + start, end: t + end });
      }
    }
    t += item.duration;
  }
  return out;
}


