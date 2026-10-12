// Transcripts in the editing model (D68, D69), browser-safe: the fillers and pauses derived from a
// transcript's words (the server's transcript_read and the Transcript panel derive the same ones),
// and planTextCut, which turns "remove these words / pauses / fillers" into one timeline edit. The
// transcript is in seconds of the media file; the timeline in project frames (D38).
import { applyEdit, createSession, EditError } from "./apply-ops.ts";
import { keyDbAt } from "./audio.ts";
import { projectDuration, resolveStarts, timelineProblems } from "./rules.ts";
import type { Item, Op, Project, TimedModule } from "./types.ts";

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

// ---- cutting by text (D69) ----

/**
 * Frames kept next to a word that stays, on each side of a cut: whisper's word edges are good to
 * about 0.1 s, so a cut right on them can clip a phoneme. 2 frames at 24–30 fps, 3 at 50, 4 at 60
 * (about 67 ms). A pause that's removed keeps this much on each side of it too, so speech isn't
 * glued together.
 */
export const handleFrames = (fps: number) => Math.max(2, Math.round(fps / 15));

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
}

export interface TextCutRequest {
  /**
   * Word index ranges to remove, both ends included (transcript_read's w12 is index 12). With
   * `clip`, only from that main-track clip (the panel: where the words were selected); otherwise
   * from every clip that plays them.
   */
  readonly remove?: ReadonlyArray<{ readonly from: number; readonly to: number; readonly clip?: string | undefined }>;
  /** Remove pauses at least `min` seconds long (keeping handleFrames of quiet next to the words). */
  readonly pauses?: { readonly min: number };
  /** Remove the hesitation fillers (um, uh, yyy, eee); "maybe" fillers are never removed here. */
  readonly fillers?: boolean;
  /** The loudness analyzer's silences (seconds), when known: pauses take their edges (as transcript_read does). */
  readonly silences?: ReadonlyArray<{ readonly start: number; readonly end: number }> | undefined;
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
 * after its last one ends (the transcript's covering convention), pulled back to keep handleFrames
 * next to the nearest kept word. So deleting touching words one by one ends like deleting them
 * together, and a selection across a clip seam leaves no slivers. Pauses: inward (both ends inside
 * the gap), keeping handleFrames next to a kept word (none next to one that goes). Edge pauses
 * (before the first word, after the last) run to the media's start or end.
 */
function spansFor(words: ReadonlyArray<CutWord>, removed: ReadonlySet<number>, fillerWords: ReadonlySet<number>, kept: (i: number) => boolean, sliver: (i: number) => boolean, pauses: ReadonlyArray<Pause>, fps: number, length: number, tight: Set<number>): Array<Span> {
  const n = words.length;
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
    if (a > 0 && kept(a - 1)) from = Math.max(from, ceilF(f(words[a - 1]!.end)) + H);
    if (b + 1 < n && kept(b + 1)) to = Math.min(to, floorF(f(words[b + 1]!.start)) - H);
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
    const before = p.after >= 0 && near(p.after) ? H : 0;
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
 * frames, pauses go inward, a handle of handleFrames stays next to every word that's kept), a cut
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
  const { words } = transcript;
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
    pauses = pausesOf(words, transcript.seconds, request.silences, Math.max(min, 0.05));
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
    for (const sp of spansFor(words, removed, fillerWords, kept, (i) => touches(item, i), pauses, fps, length, tight)) {
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
    else notes.push(`The ${plural(pauses.length, "pause")} of that length ${pauses.length === 1 ? "isn't" : "aren't"} in the edit, or leave nothing to cut after keeping ${handleFrames(fps)} frames next to the words.`);
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
  let t = 0;
  for (const item of main.items) {
    const words = item.type === "clip" && item.media ? transcripts.get(item.media) : undefined;
    if (words) {
      const inF = item.in ?? 0;
      const speed = item.speed ?? 1;
      const lo = inF / fps;
      const hi = (inF + item.duration * speed) / fps;
      words.forEach((w, index) => {
        const mid = (w.start + w.end) / 2;
        if (mid < lo || mid >= hi) return;
        const start = Math.max(0, Math.floor((floorF(w.start * fps) - inF) / speed));
        const end = Math.min(item.duration, Math.max(start + 1, Math.ceil((ceilF(w.end * fps) - inF) / speed)));
        out.push({ clip: item.id, media: item.media!, index, start: t + start, end: t + end });
      });
    }
    t += item.duration;
  }
  return out;
}


