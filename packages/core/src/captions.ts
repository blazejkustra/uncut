// Captions from a transcript (D82), browser-safe. A captions item keeps a snapshot of its source
// media's transcript words (media seconds, where each word is heard: speechWords, D74) and is
// resolved at every frame through the main-track clips that play that media (the editWords rule: a
// word belongs to the clip whose played stretch holds its middle), so cuts, trims, splits and
// transcript_edit removals move the captions with the speech and removed words simply aren't there.
// Cards are grouped per clip from the words it plays; the card at a frame becomes an ordinary text
// item (the captions item's look, style and position) that core textHtml draws, so the preview, the
// export and render_frames draw the same thing. Corrections (`edits`, keyed by word index into the
// snapshot = transcript_read's w12) and forced card starts (`breaks`) survive any re-cut.
import { TEXT_STYLES, textLook } from "./looks.ts";
import { safeMargin, textDecor, textPlacement, type RenderTarget } from "./render.ts";
import { lookItem } from "./textPlan.ts";
import { editWords, fillersOf, speechWords, type CutTranscript, type SpeechEnvelope } from "./transcript.ts";
import type { FieldSet, Item, Op, Project, Track } from "./types.ts";

export type CaptionMode = "line" | "word" | "single";
export const CAPTION_MODES: ReadonlyArray<CaptionMode> = ["line", "word", "single"];
export const CAPTION_MODE_NAMES: Readonly<Record<CaptionMode, string>> = { line: "Line by line", word: "Word by word", single: "One word at a time" };

/** One word of a captions item's snapshot: seconds of the media file, where it's heard. */
export interface CaptionWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** A hesitation (um, uh, yyy): hidden when the item's hideFillers is on. */
  readonly filler?: boolean;
}

/** How words are grouped into cards. */
export interface CaptionLines {
  /** Characters per line (spaces included). */
  readonly maxChars?: number;
  /** Lines per card: 1 or 2. */
  readonly maxLines?: number;
  /** A card is at most this long (seconds, first word's start to last word's end). */
  readonly maxSeconds?: number;
  /** Words per line (no limit when absent). */
  readonly maxWords?: number;
  /** A gap between words at least this long (seconds) starts a new card. */
  readonly pause?: number;
}

export const CAPTION_DEFAULTS = { look: "text.caption", mode: "line" as CaptionMode, maxChars: 32, maxLines: 2, maxSeconds: 3, pause: 0.3 } as const;
/** The schema's bounds for `lines` (project.schema.json), checked by every planner. */
export const CAPTION_LINE_BOUNDS = {
  maxChars: { min: 4, max: 200, integer: true },
  maxLines: { min: 1, max: 2, integer: true },
  maxSeconds: { min: 0.1, max: 30, integer: false },
  maxWords: { min: 1, max: 1000, integer: true },
  pause: { min: 0, max: 10, integer: false },
} as const;
/** A card stays on screen at least this long (seconds), while the next card doesn't need the room. */
export const CAPTION_MIN_S = 0.7;
/** Words ending in a full stop that don't end a sentence. */
const ABBREVIATIONS = new Set(["mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "vs.", "e.g.", "i.e.", "etc.", "jr.", "sr.", "inc.", "approx.", "no.", "fig."]);
/** A card stays this long (seconds) after its last word ends... */
export const CAPTION_HOLD_S = 0.3;
/** ...and a gap shorter than this (seconds) to the next card is closed, so close cards don't flicker. */
export const CAPTION_BRIDGE_S = 0.5;
/** Word ends that close a sentence (a new card starts after them). */
const SENTENCE_END = /[.?!…]["'”’)\]]*$/;

/** A caption card: timeline frames [from, to), the clip it comes from and its words in lines. */
export interface CaptionCard {
  readonly from: number;
  readonly to: number;
  readonly clip: string;
  /** Its words in order: index into the snapshot, the text shown, timeline frames heard [from, to). */
  readonly words: ReadonlyArray<{ readonly index: number; readonly text: string; readonly from: number; readonly to: number }>;
  /** The card's lines as counts of its words (they add up to words.length). */
  readonly lines: ReadonlyArray<number>;
}

const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/**
 * Characters per line when the item doesn't set them: what fits the text box at the look's size
 * with a conservative average glyph width (0.58 em for the sans looks, 0.62 for mono, wider in
 * capitals and heavy weights, plus tracking), less the box's padding and outline, at most
 * CAPTION_DEFAULTS.maxChars (a readable line), at least 4 (a single word longer than the line still breaks inside it). So a 4:5 or 9:16 canvas gets shorter
 * lines and a card never wraps past its lines.
 */
export function autoMaxChars(item: Pick<Item, "style" | "transform">, target: Pick<RenderTarget, "canvas" | "theme">): number {
  const style = { preset: CAPTION_DEFAULTS.look, ...(item.style ?? {}) } as NonNullable<Item["style"]>;
  const shell = { transform: item.transform, style };
  const place = textPlacement(shell, target);
  const look = textLook(style.preset);
  const width = place.w ?? target.canvas.width - place.x - safeMargin(target as RenderTarget);
  const decor = textDecor(shell, look, place.size, {});
  const inner = width - 2 * Math.max(0, decor.background?.padding ?? 0) - 2 * (decor.stroke?.width ?? 0);
  const font = String(style.font ?? look.font);
  const weight = Number(style.weight ?? look.weight);
  const glyph = (/mono/i.test(font) ? 0.62 : 0.58) + ((style.uppercase ?? look.uppercase) ? 0.1 : 0) + (weight >= 700 ? 0.03 : 0) + Math.max(0, Number(style.tracking ?? look.tracking) || 0);
  return Math.max(4, Math.min(CAPTION_DEFAULTS.maxChars, Math.floor(inner / (place.size * glyph))));
}

/** A captions item's grouping settings with the defaults filled in (characters per line from the canvas when given). */
export function captionSettings(item: Pick<Item, "lines" | "style" | "transform">, target?: Pick<RenderTarget, "canvas" | "theme">) {
  const l = (item.lines ?? {}) as CaptionLines;
  return {
    maxChars: Math.round(num(l.maxChars, 4, 200, target ? autoMaxChars(item, target) : CAPTION_DEFAULTS.maxChars)),
    maxLines: l.maxLines === 1 ? 1 : 2,
    maxSeconds: num(l.maxSeconds, 0.3, 30, CAPTION_DEFAULTS.maxSeconds),
    maxWords: typeof l.maxWords === "number" && l.maxWords >= 1 ? Math.round(l.maxWords) : Infinity,
    pause: num(l.pause, 0, 10, CAPTION_DEFAULTS.pause),
  };
}

export const captionMode = (item: Pick<Item, "mode">): CaptionMode => (item.mode === "word" || item.mode === "single" ? item.mode : "line");

/** The text a word shows: its correction, else the transcript's (trimmed); "" = hidden. */
export function captionWordText(item: Pick<Item, "words" | "edits">, index: number): string {
  const edit = item.edits?.findLast((e) => e.word === index);
  return (edit ? edit.text : (item.words?.[index]?.text ?? "")).trim();
}

/** Word text made safe for textHtml's markup ([[accent]], **bold**, `mono` stay literal-ish). */
const plain = (text: string) => text.replace(/`/g, "'").replace(/\*\*+/g, "*").replace(/\[\[+/g, "[").replace(/\]\]+/g, "]").replace(/\s+/g, " ");

/** The main track's played words of the item's source, per clip in edit order (the editWords rule). */
function heardByClip(project: Pick<Project, "tracks" | "canvas">, item: Item) {
  const words = item.words ?? [];
  const out: Array<{ clip: string; words: Array<{ index: number; from: number; to: number }> }> = [];
  if (!item.source || !words.length) return out;
  for (const w of editWords(project, new Map([[item.source, words]]))) {
    const last = out.at(-1);
    if (last && last.clip === w.clip) last.words.push({ index: w.index, from: w.start, to: w.end });
    else out.push({ clip: w.clip, words: [{ index: w.index, from: w.start, to: w.end }] });
  }
  return out;
}

/**
 * Groups one clip's visible words into cards: a new card at a forced break, after a pause of at
 * least `pause`, after a sentence end, when the card would run past maxSeconds, or when the word
 * doesn't fit in maxLines lines of maxChars (and maxWords) — a word longer than a line gets its own.
 */
function group(words: ReadonlyArray<{ index: number; text: string; from: number; to: number; hidden: boolean }>, s: ReturnType<typeof captionSettings>, breaks: ReadonlySet<number>, fps: number) {
  const cards: Array<{ words: Array<(typeof words)[number]>; lines: Array<{ chars: number; count: number }> }> = [];
  let card: (typeof cards)[number] | undefined;
  // Where the last word heard ends, shown or not: a hidden filler is speech, not a pause.
  let heardEnd = -Infinity;
  for (const w of words) {
    const gap = (w.from - heardEnd) / fps;
    heardEnd = Math.max(heardEnd, w.to);
    if (w.hidden) continue;
    const prev = card?.words.at(-1);
    const sentence = !!prev && SENTENCE_END.test(prev.text) && !ABBREVIATIONS.has(prev.text.toLowerCase().replace(/["'”’)\]]+$/, ""));
    let fresh = !card || !prev || breaks.has(w.index) || gap >= s.pause - 1e-9 || sentence || (w.to - card.words[0]!.from) / fps > s.maxSeconds + 1e-9;
    if (!fresh && card) {
      const line = card.lines.at(-1)!;
      const fits = line.chars + 1 + w.text.length <= s.maxChars && line.count + 1 <= s.maxWords;
      if (fits) {
        line.chars += 1 + w.text.length;
        line.count += 1;
        card.words.push(w);
        continue;
      }
      if (card.lines.length < s.maxLines) {
        card.lines.push({ chars: w.text.length, count: 1 });
        card.words.push(w);
        continue;
      }
      fresh = true;
    }
    card = { words: [w], lines: [{ chars: w.text.length, count: 1 }] };
    cards.push(card);
  }
  return cards;
}

const memo = new WeakMap<Item, { main: Track | undefined; canvas: unknown; theme: unknown; cards: ReadonlyArray<CaptionCard> }>();

/**
 * Every card of a captions item, in timeline order, inside its window [start, start + duration):
 * each from its first word's first frame to its last word's end plus CAPTION_HOLD_S, never into
 * the next card, and closed up to the next card when the gap would be under CAPTION_BRIDGE_S.
 * Hidden words (a correction to "", a filler with hideFillers) aren't in any card. Memoised per
 * item object and main track, so the preview can ask on every frame.
 */
export function captionCards(project: Pick<Project, "tracks" | "canvas"> & Partial<Pick<Project, "theme">>, item: Item): ReadonlyArray<CaptionCard> {
  if (item.type !== "captions") return [];
  const main = project.tracks.find((t) => t.role === "main");
  const fps = project.canvas.fps;
  const known = memo.get(item);
  if (known && known.main === main && known.canvas === project.canvas && known.theme === project.theme) return known.cards;
  const s = captionSettings(item, project);
  const breaks = new Set(item.breaks ?? []);
  const hideFillers = item.hideFillers === true;
  const raw: Array<{ clip: string; words: Array<{ index: number; text: string; from: number; to: number }>; lines: Array<number> }> = [];
  for (const run of heardByClip(project, item)) {
    const marked = run.words.map((w) => {
      const text = plain(captionWordText(item, w.index));
      return { ...w, text, hidden: !text || (hideFillers && item.words![w.index]!.filler === true && !item.edits?.some((e) => e.word === w.index)) };
    });
    for (const c of group(marked, s, breaks, fps)) raw.push({ clip: run.clip, words: c.words.map(({ hidden: _, ...w }) => w), lines: c.lines.map((l) => l.count) });
  }
  const hold = Math.round(CAPTION_HOLD_S * fps);
  const bridge = CAPTION_BRIDGE_S * fps;
  const least = Math.round(CAPTION_MIN_S * fps);
  // Captions made by "Make captions" cover the whole main track (coversMain); others draw in their window.
  const lo = item.coversMain ? -Infinity : (item.start ?? 0);
  const hi = item.coversMain ? Infinity : lo + item.duration;
  // Where each main clip ends, and whether the next clip plays the same media (a hold may run into it).
  const clipEnds = new Map<string, { end: number; sameNext: boolean }>();
  let t = 0;
  main?.items.forEach((it, k) => {
    t += it.duration;
    const next = main.items[k + 1];
    clipEnds.set(it.id, { end: t, sameNext: next?.type === "clip" && next.media === item.source });
  });
  const cards: Array<CaptionCard> = [];
  raw.forEach((c, i) => {
    const from = c.words[0]!.from;
    const lastEnd = Math.max(...c.words.map((w) => w.to));
    let to = Math.max(from + 1, lastEnd + hold, from + least);
    const next = raw[i + 1]?.words[0]?.from;
    if (next !== undefined && (next < to || next - to < bridge)) to = Math.max(next, from + 1);
    // Not past a cut into other footage: the hold stays inside the card's clip.
    const clip = clipEnds.get(c.clip);
    if (clip && !clip.sameNext) to = Math.max(from + 1, Math.min(to, clip.end));
    const a = Math.max(from, lo);
    const b = Math.min(to, hi);
    if (b > a) cards.push({ from: a, to: b, clip: c.clip, words: c.words, lines: c.lines });
  });
  memo.set(item, { main, canvas: project.canvas, theme: project.theme, cards });
  return cards;
}

/** The frames the captions draw over: first card's start to last card's end (undefined: none). */
export function captionExtent(project: Pick<Project, "tracks" | "canvas">, item: Item): { from: number; to: number } | undefined {
  const cards = captionCards(project, item);
  return cards.length ? { from: cards[0]!.from, to: cards.at(-1)!.to } : undefined;
}

/** The card showing at frame f (whole frames), with its position in the list. */
export function captionCardAt(project: Pick<Project, "tracks" | "canvas">, item: Item, f: number): { card: CaptionCard; n: number } | undefined {
  const cards = captionCards(project, item);
  const frame = Math.floor(f + 1e-9);
  let lo = 0;
  let hi = cards.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cards[mid]!;
    if (frame < c.from) hi = mid - 1;
    else if (frame >= c.to) lo = mid + 1;
    else return { card: c, n: mid };
  }
  return undefined;
}

/** In word and single mode: the card's word speaking at frame f (from its start to the next word's start; the last one to the card's end). */
export function activeWord(card: CaptionCard, f: number): number {
  const frame = Math.floor(f + 1e-9);
  let k = 0;
  for (let i = 1; i < card.words.length; i++) if (card.words[i]!.from <= frame) k = i;
  return k;
}

/**
 * What a captions item shows at frame f, as a text item core textHtml draws (undefined: nothing):
 * the card's lines (\n between them), in word mode the speaking word as an [[accent]], in single
 * mode only that word. Its id is the captions item's, so clicking it in the preview selects the
 * captions. Placed with the captions' look and transform, bottom-anchored: a card with fewer lines
 * than maxLines moves down by the missing lines, so the last line always sits in the same place.
 */
export function captionAt(project: Pick<Project, "tracks" | "canvas" | "theme">, item: Item, f: number): Item | undefined {
  const at = captionCardAt(project, item, f);
  if (!at) return undefined;
  const { card } = at;
  const mode = captionMode(item);
  const k = mode === "line" ? -1 : activeWord(card, f);
  let text: string;
  if (mode === "single") text = card.words[k]!.text;
  else {
    const parts: Array<string> = [];
    let i = 0;
    for (const count of card.lines) {
      // A "]" right before the closing ]] would end the accent early: a zero-width space after each keeps them apart.
      parts.push(card.words.slice(i, i + count).map((w, j) => (i + j === k ? `[[${w.text.replace(/\]/g, "]\u200B")}]]` : w.text)).join(" "));
      i += count;
    }
    text = parts.join("\n");
  }
  const style = { preset: CAPTION_DEFAULTS.look, ...(item.style ?? {}) } as Item["style"] & {};
  const transform = { ...(item.transform ?? {}), ...captionBox(project, item) };
  return { id: item.id, type: "text", ...(item.name ? { name: item.name } : {}), start: card.from, duration: card.to - card.from, text, style, transform: { ...transform, y: transform.bottom }, anchor: "bottom" };
}

/**
 * Where a captions item's cards sit (canvas px): x and width from the look and transform, `y` the top
 * of a full card (maxLines lines) as the Inspector and canvas drag edit it, `bottom` its bottom edge.
 * Cards are drawn anchored at `bottom` (textHtml's anchor), so a card with fewer lines sits lower and
 * anything that wraps grows upward, never off the canvas's bottom.
 */
export function captionBox(project: Pick<Project, "canvas"> & Partial<Pick<Project, "theme">>, item: Pick<Item, "style" | "transform" | "lines">) {
  const style = { preset: CAPTION_DEFAULTS.look, ...(item.style ?? {}) } as NonNullable<Item["style"]>;
  const shell = { transform: item.transform, style };
  const place = textPlacement(shell, project);
  const look = textLook(style.preset);
  const lineHeight = typeof style.lineHeight === "number" ? style.lineHeight : look.lineHeight;
  const decor = textDecor(shell, look, place.size, {});
  const pad = decor.background && decor.background.wrap !== "lines" ? Math.max(0, decor.background.padding ?? 0) : 0;
  const height = captionSettings(item).maxLines * place.size * lineHeight + pad;
  return { x: place.x, y: place.y, ...(place.w !== undefined ? { w: place.w } : {}), height, bottom: place.y + height, size: place.size };
}

/** Pieces of the timeline where a captions item draws one unchanging look: per card, and per speaking word in word and single mode. */
export function captionSegments(project: Pick<Project, "tracks" | "canvas"> & Partial<Pick<Project, "theme">>, item: Item): Array<{ readonly from: number; readonly to: number; readonly text: Item }> {
  const out: Array<{ from: number; to: number; text: Item }> = [];
  const mode = captionMode(item);
  for (const card of captionCards(project, item)) {
    let from = card.from;
    let k = mode === "line" ? -1 : activeWord(card, from);
    for (let f = card.from + 1; f <= card.to; f++) {
      const now = f === card.to ? -2 : mode === "line" ? -1 : activeWord(card, f);
      if (now === k) continue;
      out.push({ from, to: f, text: captionAt(project, item, from)! });
      from = f;
      k = now;
    }
  }
  return out;
}

/** A `lines` value checked against the schema's bounds and keys (null for a field: its default, when `nulls`). */
export function checkCaptionLines(lines: unknown, nulls = false): { readonly lines: Record<string, number | null> } | { readonly problem: string } {
  if (typeof lines !== "object" || lines === null || Array.isArray(lines)) return { problem: "lines must be an object: maxChars, maxLines, maxSeconds, maxWords, pause." };
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(lines)) {
    const b = CAPTION_LINE_BOUNDS[k as keyof typeof CAPTION_LINE_BOUNDS];
    if (!b) return { problem: `lines has no setting ${k} (maxChars, maxLines, maxSeconds, maxWords, pause).` };
    if (v === undefined) continue;
    if (v === null && nulls) {
      out[k] = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || (b.integer && !Number.isInteger(v)) || v < b.min || v > b.max || (k === "maxSeconds" && v <= 0)) {
      return { problem: k === "maxLines" ? "lines.maxLines must be 1 or 2." : `lines.${k} must be ${b.integer ? "a whole number" : "a number"} from ${b.min} to ${b.max}.` };
    }
    out[k] = v;
  }
  return { lines: out };
}

// ---- planning (the Transcript panel's "Make captions", the agent's captions_make, the Inspector) ----

export interface MakeCaptionsRequest {
  readonly media: string;
  /** The media's transcript (whisper's words, seconds of the file). */
  readonly transcript: CutTranscript;
  /** The loudness analyzer's silences and speech envelope, when known: words are stored where they're heard (D74). */
  readonly silences?: ReadonlyArray<{ readonly start: number; readonly end: number }> | undefined;
  readonly envelope?: SpeechEnvelope | undefined;
  readonly mode?: CaptionMode;
  /** A text-style module id (default text.caption). */
  readonly look?: string;
  readonly lines?: CaptionLines;
  readonly hideFillers?: boolean;
  /** The new item's id (default captions-1, …). */
  readonly id?: string;
}

export type MakeCaptionsPlan = { readonly ops: Array<Op>; readonly itemId: string; readonly summary: string; readonly remade: boolean; readonly words: number; readonly fixesDropped: number } | { readonly problem: string };

function freeId(project: Pick<Project, "media" | "tracks">, base: string, taken: ReadonlySet<string>) {
  const ids = new Set([...taken, ...project.media.map((m) => m.id), ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)])]);
  for (let n = 1; ; n++) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The main track's length in frames (what new captions cover). */
const mainLength = (project: Pick<Project, "tracks">) => (project.tracks.find((t) => t.role === "main")?.items ?? []).reduce((n, i) => n + i.duration, 0);

/**
 * Captions for a media from its transcript: a new captions item covering the main track on a new
 * "Captions" text track on top (its own track, so it never overlaps titles), with the look's size,
 * weight and position (lower safe area). If the media already has captions they're remade in place:
 * fresh words, the window refitted to the main track, mode / look / lines as asked, and the
 * corrections and breaks kept when the words are the same transcript. One edit.
 */
export function planMakeCaptions(project: Pick<Project, "canvas" | "theme" | "tracks" | "media">, req: MakeCaptionsRequest): MakeCaptionsPlan {
  const media = project.media.find((m) => m.id === req.media);
  if (!media) return { problem: `There's no media "${req.media}".` };
  if (media.kind === "image" || !(media.kind === "audio" || media.probe?.hasAudio)) return { problem: `${media.name} has no sound, so there's nothing to caption.` };
  const main = project.tracks.find((t) => t.role === "main");
  if (!main?.items.some((i) => i.type === "clip" && i.media === media.id)) return { problem: `${media.name} isn't on the main track: captions follow the main-track clips that use it.` };
  const look = req.look ?? CAPTION_DEFAULTS.look;
  if (!TEXT_STYLES[look]) return { problem: `There's no text look called ${look}. modules_list with kind "text-style" lists them.` };
  if (req.mode !== undefined && !CAPTION_MODES.includes(req.mode)) return { problem: `mode must be one of ${CAPTION_MODES.join(", ")}.` };
  const t = req.transcript;
  if (!t.words.length) return { problem: `${media.name}'s transcript has no words.` };
  const hes = new Set(fillersOf(t.words, t.language).filter((f) => f.kind === "hesitation").flatMap((f) => Array.from({ length: f.n }, (_, k) => f.i + k)));
  const heard = speechWords(t.words, { segments: t.segments, silences: req.silences, seconds: t.seconds, envelope: req.envelope });
  const words: Array<CaptionWord> = heard.map((w, i) => ({ text: w.text.trim(), start: w.start, end: w.end, ...(hes.has(i) ? { filler: true } : {}) }));
  const duration = Math.max(1, mainLength(project));
  let lines: CaptionLines | undefined;
  if (req.lines !== undefined) {
    const checked = checkCaptionLines(req.lines);
    if ("problem" in checked) return checked;
    lines = checked.lines as CaptionLines;
  }
  const existing = project.tracks.flatMap((tr) => tr.items.map((i) => ({ item: i, track: tr }))).find((x) => x.item.type === "captions" && x.item.source === media.id);
  if (existing) {
    if (existing.track.locked || existing.item.locked) return { problem: `${media.name}'s captions are locked: unlock them to remake them.` };
    const old = existing.item.words ?? [];
    const same = old.length === words.length && old.every((w, i) => w.text === words[i]!.text);
    const set: Record<string, unknown> = { words, start: 0, duration, coversMain: true };
    if (req.mode) set.mode = req.mode;
    if (req.look && req.look !== existing.item.style?.preset) {
      const fields = lookItem(TEXT_STYLES[look]!, project, duration);
      set.style = fields.style;
      set.transform = fields.transform;
    }
    if (lines) set.lines = { ...(existing.item.lines ?? {}), ...lines };
    if (req.hideFillers !== undefined) set.hideFillers = req.hideFillers || null;
    const fixesDropped = same ? 0 : (existing.item.edits?.length ?? 0) + (existing.item.breaks?.length ?? 0);
    if (!same) {
      if (existing.item.edits) set.edits = null;
      if (existing.item.breaks) set.breaks = null;
    }
    const summary = fixesDropped ? `Remake captions (${fixesDropped} fix${fixesDropped === 1 ? "" : "es"} dropped)` : "Remake captions";
    return { ops: [{ op: "update_item", item: existing.item.id, set: set as FieldSet }], itemId: existing.item.id, summary, remade: true, words: words.length, fixesDropped };
  }
  const taken = new Set<string>();
  if (req.id !== undefined) {
    if (project.media.some((m) => m.id === req.id) || project.tracks.some((tr) => tr.id === req.id || tr.items.some((i) => i.id === req.id))) return { problem: `The id "${req.id}" is already used in this project.` };
    taken.add(req.id);
  }
  const trackId = freeId(project, "captions-track", taken);
  taken.add(trackId);
  const itemId = req.id ?? freeId(project, "captions", taken);
  const fields = lookItem(TEXT_STYLES[look]!, project, duration);
  const item: Item = {
    id: itemId,
    type: "captions",
    source: media.id,
    start: 0,
    duration,
    coversMain: true,
    mode: req.mode ?? CAPTION_DEFAULTS.mode,
    transform: fields.transform,
    style: fields.style as Item["style"],
    ...(lines && Object.keys(lines).length ? { lines } : {}),
    ...(req.hideFillers ? { hideFillers: true } : {}),
    words,
  };
  // An empty, unlocked captions track (its captions were deleted) is used again.
  const empty = project.tracks.find((tr) => tr.kind === "text" && /^Captions/.test(tr.name) && !tr.items.length && !tr.locked && !tr.hidden);
  const textTracks = project.tracks.filter((tr) => tr.kind === "text" && /^Captions/.test(tr.name)).length;
  const ops: Array<Op> = empty
    ? [{ op: "insert_item", track: empty.id, item }]
    : [
        { op: "add_track", index: 0, track: { id: trackId, kind: "text", name: textTracks ? `Captions ${textTracks + 1}` : "Captions" } } as Op,
        { op: "insert_item", track: trackId, item },
      ];
  return { ops, itemId, summary: "Make captions", remade: false, words: words.length, fixesDropped: 0 };
}

export interface CaptionEdit {
  /** Word corrections by index into the snapshot: text ("" hides the word), or null to go back to the transcript's. */
  readonly words?: ReadonlyArray<{ readonly index: number; readonly text: string | null }>;
  /** Start a new card at these words (true) or stop forcing one there (false). */
  readonly breaks?: ReadonlyArray<{ readonly index: number; readonly on: boolean }>;
  readonly mode?: CaptionMode;
  /** Grouping settings over the item's (null: back to the defaults). */
  readonly lines?: { readonly [K in keyof CaptionLines]?: CaptionLines[K] | null };
  readonly hideFillers?: boolean;
  /** Fit the window to the whole main track again. */
  readonly cover?: boolean;
}

const quote = (s: string) => `"${s.length > 30 ? `${s.slice(0, 29)}…` : s}"`;

/**
 * One captions edit as update_item (edits and breaks sorted, a correction equal to the
 * transcript's text dropped, empty lists removed), with the summary the History shows.
 */
export function planCaptionEdit(project: Pick<Project, "tracks">, itemId: string, edit: CaptionEdit): { readonly ops: Array<Op>; readonly summary: string } | { readonly problem: string } {
  const item = project.tracks.flatMap((t) => t.items).find((i) => i.id === itemId);
  if (!item || item.type !== "captions") return { problem: `"${itemId}" isn't a captions item.` };
  const words = item.words ?? [];
  const set: Record<string, unknown> = {};
  const labels: Array<string> = [];
  if (edit.words?.length) {
    const edits = new Map((item.edits ?? []).map((e) => [e.word, e.text]));
    for (const w of edit.words) {
      if (!Number.isInteger(w.index) || w.index < 0 || w.index >= words.length) return { problem: `There's no word ${w.index} in these captions (they have ${words.length}: w0 to w${Math.max(0, words.length - 1)}).` };
      const text = w.text === null ? null : w.text.replace(/\s+/g, " ").trim();
      if (text === null || text === words[w.index]!.text.trim()) edits.delete(w.index);
      else edits.set(w.index, text);
    }
    const list = [...edits].sort((a, b) => a[0] - b[0]).map(([word, text]) => ({ word, text }));
    const before = JSON.stringify(item.edits ?? []);
    if (JSON.stringify(list) !== before) {
      set.edits = list.length ? list : null;
      const one = edit.words.length === 1 ? edit.words[0]! : undefined;
      const restores = (w: { index: number; text: string | null }) => w.text === null || w.text.replace(/\s+/g, " ").trim() === words[w.index]!.text.trim();
      labels.push(
        one
          ? one.text === "" || one.text?.trim() === ""
            ? `Hide caption word ${quote(words[one.index]!.text.trim())}`
            : restores(one)
              ? `Restore caption word ${quote(words[one.index]!.text.trim())}`
              : `Fix caption word ${quote(one.text!.trim())}`
          : edit.words.every(restores)
            ? `Restore ${edit.words.length} caption words`
            : `Fix ${edit.words.length} caption words`,
      );
    }
  }
  if (edit.breaks?.length) {
    const breaks = new Set(item.breaks ?? []);
    for (const b of edit.breaks) {
      if (!Number.isInteger(b.index) || b.index < 0 || b.index >= words.length) return { problem: `There's no word ${b.index} in these captions.` };
      if (b.on) breaks.add(b.index);
      else breaks.delete(b.index);
    }
    const list = [...breaks].sort((a, b) => a - b);
    if (JSON.stringify(list) !== JSON.stringify(item.breaks ?? [])) {
      set.breaks = list.length ? list : null;
      labels.push(edit.breaks.length === 1 ? (edit.breaks[0]!.on ? "Start a caption card" : "Join caption cards") : "Change caption cards");
    }
  }
  if (edit.mode !== undefined) {
    if (!CAPTION_MODES.includes(edit.mode)) return { problem: `mode must be one of ${CAPTION_MODES.join(", ")}.` };
    if (edit.mode !== captionMode(item)) {
      set.mode = edit.mode;
      labels.push(`Captions ${CAPTION_MODE_NAMES[edit.mode].toLowerCase()}`);
    }
  }
  if (edit.lines) {
    const checked = checkCaptionLines(edit.lines, true);
    if ("problem" in checked) return checked;
    const next: Record<string, unknown> = { ...(item.lines ?? {}) };
    for (const [k, v] of Object.entries(checked.lines)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    if (JSON.stringify(next) !== JSON.stringify(item.lines ?? {})) {
      set.lines = Object.keys(next).length ? next : null;
      labels.push("Change caption lines");
    }
  }
  if (edit.hideFillers !== undefined && edit.hideFillers !== (item.hideFillers === true)) {
    set.hideFillers = edit.hideFillers || null;
    labels.push(edit.hideFillers ? "Hide fillers in captions" : "Show fillers in captions");
  }
  if (edit.cover && !item.coversMain) {
    set.start = 0;
    set.duration = Math.max(1, mainLength(project));
    set.coversMain = true;
    labels.push("Fit captions to the edit");
  }
  if (!labels.length) return { ops: [], summary: "" };
  return { ops: [{ op: "update_item", item: itemId, set: set as FieldSet }], summary: labels.length === 1 ? labels[0]! : "Edit captions" };
}

/** Whether a captions item's window covers the whole main track (else the Inspector offers to fit it). */
export const captionsCoverMain = (project: Pick<Project, "tracks">, item: Pick<Item, "start" | "duration" | "coversMain">) => item.coversMain === true || ((item.start ?? 0) <= 0 && (item.start ?? 0) + item.duration >= mainLength(project));

/** For the agent and the Inspector: the cards as text with their word ids and timeline frames. */
export function captionCardList(project: Pick<Project, "tracks" | "canvas">, item: Item): Array<{ readonly from: number; readonly to: number; readonly words: string; readonly text: string }> {
  return captionCards(project, item).map((c) => {
    let i = 0;
    const lines = c.lines.map((n) => {
      const line = c.words.slice(i, i + n).map((w) => w.text).join(" ");
      i += n;
      return line;
    });
    const a = c.words[0]!.index;
    const b = c.words.at(-1)!.index;
    return { from: c.from, to: c.to, words: a === b ? `w${a}` : `w${a}–w${b}`, text: lines.join(" / ") };
  });
}

