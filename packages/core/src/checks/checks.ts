// Taste checks (D90): what a project does against the best practices for short product videos
// (devrel VIDEO-BEST-PRACTICES), as far as the model alone can tell. Each rule is objective (read
// time, punctuation, sizes, speeds, sound) and says one plain sentence per finding; some carry a
// fix (edit ops planned against the project, applied as one undoable edit). Checks never block an
// export: the editor lists them, the export dialog mentions them, the agent's project_check returns
// them.
//
// Browser-safe and pure, O(items) (O(items log items) for the overlaps), so the editor runs it on
// every snapshot. Rules are a registry (CHECK_RULES): a module can pass more rules later (Phase 8).
// A project turns rules off with checks.disabled (rule ids).
import { trackAudible } from "../audio/audio.ts";
import { DUCK } from "../audio/effects.ts";
import { duckEntry } from "../audio/ducking.ts";
import { libraryTrackOf } from "../audio/music.ts";
import { bundledSfxOf } from "../audio/library.ts";
import { textLook } from "../text/looks.ts";
import { overlaps } from "../visual/transitions.ts";
import { safeMargin, textPlacement, wordCount } from "../visual/render.ts";
import { layout, visualsAt } from "../timeline/timeline.ts";
import type { Id, Item, Media, Op, Project, Track } from "../timeline/types.ts";

export type CheckSeverity = "warn" | "info";

/** A suggested fix: ops for one project.edit / timeline_edit, and its History label. */
export interface CheckFix {
  readonly summary: string;
  readonly ops: ReadonlyArray<Op>;
}

/** One finding. */
export interface Check {
  /** The rule's stable id (what checks.disabled lists). */
  readonly id: string;
  /** Unique among the findings: the rule id plus what it's about. */
  readonly key: string;
  readonly severity: CheckSeverity;
  /** One plain sentence. */
  readonly message: string;
  readonly itemIds?: ReadonlyArray<Id>;
  /** Where to look (the playhead goes there). */
  readonly frame?: number;
  /** The stretch it's about, [start, end) in frames. */
  readonly range?: { readonly start: number; readonly end: number };
  readonly fix?: CheckFix;
  /** What to do when there's no fix (or as well as it). */
  readonly hint?: string;
}

/** What a rule gets: the project and things every rule would otherwise recompute. */
export interface CheckContext {
  readonly project: Project;
  readonly fps: number;
  readonly starts: ReadonlyMap<Id, number>;
  /** The video's length in frames (0 when nothing is on the timeline). */
  readonly end: number;
  /** Text items on shown text tracks, with their track and start, in start order. */
  readonly texts: ReadonlyArray<Placed>;
  /** Canvas px are judged at a 1080 px shorter side: this is the canvas's shorter side / 1080. */
  readonly scale: number;
  readonly media: ReadonlyMap<Id, Media>;
  /** Media known to carry speech (options.speechMedia, plus captions' sources). */
  readonly speech: ReadonlySet<Id>;
  /** trackAudible by track id, filled as rules ask. */
  readonly audible: Map<Id, boolean>;
}

export interface Placed {
  readonly item: Item;
  readonly track: Track;
  readonly start: number;
}

export interface CheckRule {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: CheckSeverity;
  readonly check: (ctx: CheckContext) => ReadonlyArray<Omit<Check, "id" | "severity"> & { readonly severity?: CheckSeverity }>;
}

// ---- helpers ----

const secs = (frames: number, fps: number) => `${(Math.round((frames / fps) * 10) / 10).toFixed(1)} s`;
/** A text's words for messages: markup stripped, one line, at most 32 characters. */
export const textLabel = (text: string | undefined) => {
  const plain = (text ?? "").replace(/\[\[(.*?)\]\]/gs, "$1").replace(/\*\*(.+?)\*\*/gs, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
  return plain.length > 32 ? `${plain.slice(0, 31).trimEnd()}…` : plain;
};
const locked = (p: Placed) => p.track.locked === true || p.item.locked === true;
/** Frames a text is fully on screen: its length less its in and out moves. */
const holdOf = (item: Item) => Math.max(0, item.duration - (item.animation?.in?.duration ?? 0) - (item.animation?.out?.duration ?? 0));
/** Frames a text needs to be read twice: words ÷ 3 s, at least 2 s. */
export const readFrames = (text: string | undefined, fps: number) => Math.ceil(Math.max(2, wordCount(text ?? "") / 3) * fps);
const startOf = (ctx: CheckContext, item: Item) => ctx.starts.get(item.id) ?? 0;
/** Room after a free-track item before the next item on its track (Infinity when none). */
function roomAfter(ctx: CheckContext, p: Placed) {
  const end = p.start + p.item.duration;
  let next = Infinity;
  for (const other of p.track.items) {
    const s = startOf(ctx, other);
    if (other.id !== p.item.id && s >= end) next = Math.min(next, s);
  }
  return next - end;
}
/** A fix that makes a text `extra` frames longer, if its track has room and it doesn't make the video longer. */
function lengthen(ctx: CheckContext, p: Placed, extra: number): CheckFix | undefined {
  if (locked(p) || p.track.role === "main" || extra <= 0) return undefined;
  if (roomAfter(ctx, p) < extra || p.start + p.item.duration + extra > ctx.end) return undefined;
  const set: Record<string, unknown> = { duration: p.item.duration + extra };
  return { summary: `Hold "${textLabel(p.item.text)}" for ${secs(holdOf(p.item) + extra, ctx.fps)}`, ops: [{ op: "update_item", item: p.item.id, set }] };
}

// Phrases that could sit under any product (VIDEO-BEST-PRACTICES 2b), matched as whole words, any case.
export const FILLER_PHRASES = [
  "seamlessly",
  "seamless",
  "effortlessly",
  "effortless",
  "unlock",
  "unlocks",
  "unleash",
  "the future of",
  "game-changer",
  "game changer",
  "revolutionize",
  "revolutionary",
  "supercharge",
  "next-level",
  "next level",
  "cutting-edge",
  "like never before",
  "elevate your",
  "empower",
  "whatever the",
  "in today's world",
] as const;
const FILLER_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${FILLER_PHRASES.map((p) => p.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`, "giu");

// Dots between words: "Swift · Kotlin", "fast • simple", "one * two" (never **bold**). A dot at
// the start of a line is a bullet: the list keeps its lines and loses the bullets. A lone * is left
// alone in code (inside backticks, on a mono text, after import / export / select, or between
// numbers: "2 * 3").
const DOT = "[·•∙⋅]";
const BULLET_RE = new RegExp(`^([ \\t]*)${DOT}[ \\t]*`, "gm");
const DOT_RE = new RegExp(`(\\S)[ \\t]*${DOT}[ \\t]*(?=\\S)`, "g");
const STAR_RE = /(\S+)[ \t]+\*[ \t]+(?=(\S))/g;
const CODE_WORD = /^(import|export|select|from|count|return|where|and|or)$/i;

/** The text with its dots between words turned into commas and its bullets dropped, or undefined when it has none. */
export function fixDots(text: string, mono = false): string | undefined {
  // Code spans (`…`) are kept as they are.
  const parts = text.split(/(`[^`\n]*`)/);
  let lineStart = true;
  const out = parts.map((part, i) => {
    if (i % 2 === 1) {
      lineStart = false;
      return part;
    }
    let s = part;
    // Bullets only where a line really starts (not right after a code span).
    s = s.replace(BULLET_RE, (m, indent: string, offset: number) => (offset === 0 && !lineStart ? m : indent));
    s = s.replace(DOT_RE, "$1, ");
    if (!mono)
      s = s.replace(STAR_RE, (m, before: string, after: string) => {
        const word = before.replace(/^.*?([\p{L}\p{N}_]+)[^\p{L}\p{N}_]*$/u, "$1");
        if (/\d$/.test(before) && /^\d/.test(after)) return m;
        if (CODE_WORD.test(word) || /^[A-Z]{2,}$/.test(word)) return m;
        return `${before}, `;
      });
    if (part.length) lineStart = part.endsWith("\n");
    return s;
  });
  const fixed = out.join("");
  return fixed === text ? undefined : fixed;
}

/** Each line's trailing period (not an ellipsis), after markup that closes the line. */
const PERIOD_RE = /(?<!\.)\.((?:\]\]|\*\*|`)*)[ \t]*$/gm;
/** Abbreviations whose period stays ("Expo, RN, etc."). */
const ABBREVIATION = /(?:^|[^\p{L}])(etc|e\.g|i\.e|vs|inc|ltd|co|jr|sr|approx|corp)$/iu;
/** The text without its lines' trailing periods, or undefined when none has one. */
export function fixPeriods(text: string): string | undefined {
  const fixed = text.replace(PERIOD_RE, (m, close: string, offset: number) => (ABBREVIATION.test(text.slice(0, offset).split("\n").at(-1)!) ? m : close));
  return fixed === text ? undefined : fixed;
}

const MUSIC_NAME = /\b(music|song|bed|lo-?fi|cozy|beat|soundtrack)\b/i;
const SPEECH_NAME = /\b(voice|vo|voiceover|voice-over|narration|narrator|speech|talk|talking|interview|dialog(ue)?|podcast)\b/i;
const mediaOf = (ctx: CheckContext, item: Item) => (item.media ? ctx.media.get(item.media) : undefined);
const isMusicTrack = (ctx: CheckContext, track: Track) =>
  track.kind === "audio" &&
  (!!duckEntry(track) ||
    MUSIC_NAME.test(track.name) ||
    track.items.some((i) => {
      const m = mediaOf(ctx, i);
      // The file's name, not the display name (G4: renaming a media item doesn't change what it is).
      return !!m && (MUSIC_NAME.test(m.path.replace(/\\/g, "/").split("/").pop() ?? "") || !!libraryTrackOf(m));
    }));
/** soundMedia (audio.ts) through the context's media map. */
function soundOf(ctx: CheckContext, item: Item) {
  if ((item.type !== "clip" && item.type !== "audio") || item.mute) return undefined;
  const m = mediaOf(ctx, item);
  return m && m.kind !== "image" && (m.kind === "audio" || m.probe?.hasAudio) ? m : undefined;
}
const sounds = (ctx: CheckContext, track: Track) => track.items.some((i) => soundOf(ctx, i) !== undefined);
/** trackAudible (mute, solo), once per track. */
function audible(ctx: CheckContext, track: Track) {
  let a = ctx.audible.get(track.id);
  if (a === undefined) {
    a = trackAudible(ctx.project, track);
    ctx.audible.set(track.id, a);
  }
  return a;
}
/**
 * A track that carries speech, for ducking: named like a voice (or holding media named like one),
 * or the main track when its sound is known to be speech (in `speechMedia`, else captions made from it).
 */
function isSpeechTrack(ctx: CheckContext, track: Track) {
  if (isMusicTrack(ctx, track)) return false;
  if (SPEECH_NAME.test(track.name) || track.items.some((i) => SPEECH_NAME.test(mediaOf(ctx, i)?.name ?? ""))) return true;
  if (track.role === "main") return track.items.some((i) => !!i.media && ctx.speech.has(i.media));
  return false;
}
/** A fade made with volume keys (D83): the envelope starts (or ends) about silent. */
const keyFade = (item: Item, side: "in" | "out") => {
  const keys = [...(item.gainKeys ?? [])].sort((a, b) => a.frame - b.frame);
  const k = side === "in" ? keys[0] : keys.at(-1);
  return !!k && k.db <= -40;
};

/**
 * The family a text draws with. The built-in looks use both the system sans ("sans") and the
 * bundled DM Sans (D77): with no theme font they count as one family, the app's own pair (D90).
 */
function familyOf(project: Project, item: Item) {
  const token = item.style?.font ?? textLook(item.style?.preset).font;
  const themed = project.theme?.fonts?.[token];
  const name = themed || token;
  const mono = token === "mono" || /mono|code|courier|menlo|consol/i.test(name);
  const house = !themed && (token === "sans" || token === "DM Sans");
  return { key: house ? "sans" : name, name: house ? "DM Sans" : name, token, mono };
}

/** The look whose texts don't count as crowding (D96). */
export const FOOTNOTE_LOOK = "text.footnote";
/** A footnote for the crowding rule (D96): in the Footnote look and no bigger than the look's own size. */
const isFootnote = (ctx: CheckContext, item: Item) => item.style?.preset === FOOTNOTE_LOOK && textPlacement(item, ctx.project).size <= textLook(FOOTNOTE_LOOK).size * ctx.project.canvas.height + 0.5;

// ---- sound design (D207, issue #31) ----
//
// What the evidence showed (argent-cloud-2: 16 sound effects in 21.5 s from 7 files, a UI click 7
// times, also as "typing" and on every text line, two booms, a slow lo-fi loop under a punchy cut)
// as objective rules over the timeline alone: how many effects play in any 10 s, the same file over
// and over, big hits, effects at the music's level or above, effects that land on nothing that
// changes on screen, clicks on text, meme sounds, and a slow track under fast cuts. The sound sheet
// is the same analysis as lines, for the critic, which can't hear (it reads the sheet blindfold).

/** At most this many sound effects start in any 10 s (fewer in a shorter video, pro rata, at least 2). */
export const SFX_PER_10S = 4;
/** The same effect file this many times or more reads as a loop. */
export const SFX_REPEAT_MAX = 3;
/** Big hits (impacts, booms): at most one in any 15 s. */
export const SFX_HITS_PER_15S = 1;
/** An effect sits at least this many dB under the music it plays over (−6 to −12 dB). */
export const SFX_UNDER_MUSIC_DB = 6;
/** Where an effect's fix puts it: this many dB under the music. */
export const SFX_FIX_UNDER_DB = 9;
/** A visual event this close (s) before an effect's start, or this close after, counts as its hit. */
export const SFX_SYNC_BEFORE_S = 0.1;
export const SFX_SYNC_AFTER_S = 0.2;
/** Under this tempo a track is slow (bpm), and cuts closer than this (s) on average are fast. */
export const SLOW_BPM = 95;
export const FAST_CUT_S = 2;

const SFX_NAME = /\b(sfx|fx|whoosh|swoosh|swish|whip|click|tap|pop|boom|hit|impact|riser|rise|ding|chime|glitch|notification|swipe|thud|stinger|sting|blip|beep|typing|keyboard)\b/i;
const SFX_TRACK = /\b(sfx|fx|effects?|sound effects?)\b/i;
const MEME_NAME = /\b(bruh|airhorn|air horn|scratch|trombone|crickets|laugh|laughter|applause|vine|fahh?|oof|meme)\b/i;
const HIT_NAME = /\b(boom|impact|hit|thud|slam|bass drop)\b/i;
const fileName = (m: Media) => m.path.replace(/\\/g, "/").split("/").pop() ?? "";

export type SfxKind = "whoosh" | "riser" | "ui" | "hit" | "meme" | "other";

/** One sound effect on the timeline. */
export interface PlacedSfx {
  readonly item: Item;
  readonly track: Track;
  readonly start: number;
  readonly media: Media;
  /** The sound's name in messages: the bundled effect's id, else the media's name. */
  readonly label: string;
  /** What gives the sound its identity (the same file in numbered copies is one). */
  readonly sound: string;
  readonly kind: SfxKind;
  /** item gain + track gain, dB. */
  readonly gain: number;
  /** From Uncut's pack (levelled to −20 LUFS, peaks under −1 dBFS, D208), so its level against the music is known. */
  readonly bundled: boolean;
}

/** A sound effect's kind, from the bundled pack's category or the file's name. */
function sfxKind(m: Media): SfxKind {
  const b = bundledSfxOf(m);
  const c = b?.category;
  const name = `${fileName(m)} ${m.name}`;
  if (c === "meme" || c === "crowd" || MEME_NAME.test(name)) return c === "meme" && b?.id === "bass-boom" ? "hit" : "meme";
  if (c === "whoosh" || c === "transition" || c === "swipe" || c === "glitch" || /whoosh|swoosh|swish|whip|swipe|transition|glitch/i.test(name)) return "whoosh";
  if (c === "riser" || /riser|rise|build/i.test(name)) return "riser";
  if (c === "impact" || HIT_NAME.test(name)) return "hit";
  if (c === "ui" || c === "notification" || c === "pop" || c === "success" || c === "typing" || /click|tap|pop|ding|chime|blip|beep|notification|typing|keyboard/i.test(name)) return "ui";
  return "other";
}

const trackGain = (t: Track) => t.mixer?.gainDb ?? 0;

/** Music items (bundled tracks, files named like music, long sounds on a music track), with their gain. */
function musicItems(ctx: CheckContext) {
  const out: Array<{ item: Item; track: Track; start: number; media: Media; gain: number; bpm: number | null | undefined }> = [];
  for (const track of ctx.project.tracks) {
    if (track.kind !== "audio" || !audible(ctx, track) || isSpeechTrack(ctx, track)) continue;
    const musicTrack = isMusicTrack(ctx, track);
    for (const item of track.items) {
      const m = soundOf(ctx, item);
      if (!m || item.type !== "audio" || bundledSfxOf(m)) continue;
      const lib = libraryTrackOf(m);
      if (lib || MUSIC_NAME.test(fileName(m)) || (musicTrack && item.duration > 6 * ctx.fps)) out.push({ item, track, start: startOf(ctx, item), media: m, gain: (item.gainDb ?? 0) + trackGain(track), bpm: lib?.bpm });
    }
  }
  return out;
}

/** The sound effects: bundled ones, files or tracks named like effects, short sounds off the music and voice. */
export function sfxItems(ctx: CheckContext): Array<PlacedSfx> {
  const music = new Set(musicItems(ctx).map((m) => m.item.id));
  const out: Array<PlacedSfx> = [];
  for (const track of ctx.project.tracks) {
    if (track.kind !== "audio" || !audible(ctx, track) || isSpeechTrack(ctx, track)) continue;
    for (const item of track.items) {
      const m = soundOf(ctx, item);
      if (!m || item.type !== "audio" || music.has(item.id) || libraryTrackOf(m)) continue;
      const bundled = bundledSfxOf(m);
      const named = SFX_NAME.test(fileName(m)) || SFX_NAME.test(m.name) || MEME_NAME.test(fileName(m)) || SFX_TRACK.test(track.name);
      if (!bundled && !named && item.duration > 3 * ctx.fps) continue;
      out.push({ item, track, start: startOf(ctx, item), media: m, label: bundled?.id ?? m.name, sound: bundled?.id ?? m.path, kind: sfxKind(m), gain: (item.gainDb ?? 0) + trackGain(track), bundled: !!bundled });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Something that changes on screen: a cut, a text or graphic arriving or leaving, a keyframe. */
export interface VisualEvent {
  readonly frame: number;
  readonly what: string;
  /** A text arriving (a click on it isn't a click the viewer sees). */
  readonly text: boolean;
  /**
   * A component or graphic animates inside itself (a tap indicator, a cursor in a render(t)
   * graphic): Uncut can't see when, so the event spans until here (a component's first second, a
   * graphic's whole length) and an effect anywhere in it counts as landing.
   */
  readonly until?: number;
}

export function visualEvents(ctx: CheckContext): Array<VisualEvent> {
  const out: Array<VisualEvent> = [];
  for (const track of ctx.project.tracks) {
    if (track.hidden || track.kind === "audio") continue;
    for (const item of track.items) {
      if (item.type === "captions") continue;
      const s = startOf(ctx, item);
      const name = item.type === "text" ? `"${textLabel(item.text)}"` : (item.name ?? item.id);
      const text = item.type === "text";
      if (s > 0) out.push({ frame: s, what: track.role === "main" ? `the cut to ${name}` : `${name} appearing`, text });
      if (item.type === "component" || item.type === "graphic") out.push({ frame: s, until: item.type === "graphic" ? s + item.duration : s + Math.min(item.duration, ctx.fps), what: `${name}'s own animation`, text: false });
      if (item.animation?.in?.duration) out.push({ frame: s + item.animation.in.duration, what: `${name} landing`, text });
      for (const k of item.keys ?? []) if (k.frame > 0) out.push({ frame: s + k.frame, what: `${name}'s move at its key`, text: false });
      const end = s + item.duration;
      if (end < ctx.end && track.role !== "main") out.push({ frame: end, what: `${name} leaving`, text });
    }
  }
  return out.sort((a, b) => a.frame - b.frame);
}

/** The visual events an effect lands on: whooshes over their first second, risers at their end, the rest at their start. */
function hitsOf(ctx: CheckContext, s: PlacedSfx, events: ReadonlyArray<VisualEvent>) {
  const before = Math.round(SFX_SYNC_BEFORE_S * ctx.fps);
  const after = Math.max(2, Math.round(SFX_SYNC_AFTER_S * ctx.fps));
  const end = s.start + s.item.duration;
  const [a, b] = s.kind === "whoosh" ? [s.start - before, s.start + Math.min(s.item.duration, ctx.fps)] : s.kind === "riser" ? [end - Math.round(0.4 * ctx.fps), end + after] : [s.start - before, s.start + after];
  return events.filter((e) => (e.until !== undefined ? e.frame <= b && e.until >= a : e.frame >= a && e.frame <= b));
}

/** The most effects that start in any `window` frames, and where that window begins. */
function busiest(starts: ReadonlyArray<number>, window: number) {
  let best = { count: 0, from: 0, to: 0 };
  for (let i = 0, j = 0; i < starts.length; i++) {
    while (starts[i]! - starts[j]! >= window) j++;
    if (i - j + 1 > best.count) best = { count: i - j + 1, from: starts[j]!, to: starts[i]! };
  }
  return best;
}

/** The music playing at a frame (the loudest, if several). */
const musicAt = (music: ReturnType<typeof musicItems>, frame: number) => music.filter((m) => frame >= m.start && frame < m.start + m.item.duration).sort((a, b) => b.gain - a.gain)[0];

const dbText = (db: number) => `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(Math.round(db * 10) / 10)} dB`;

/**
 * The sound as lines (D207): music, voices and every effect with its time, kind, level, what it
 * lands on, then the counts. The critic reads it (it can't hear), and so can the agent.
 */
export function soundSheet(project: Project, options: { readonly speechMedia?: Iterable<Id> } = {}): Array<string> {
  const ctx = checkContext(project, options);
  const fps = ctx.fps;
  const lines: Array<string> = [];
  const music = musicItems(ctx);
  for (const m of music) lines.push(`music ${secs(m.start, fps)} to ${secs(m.start + m.item.duration, fps)}: ${m.media.name}${m.bpm ? `, ${m.bpm} BPM` : m.bpm === null ? ", no steady beat" : ""}, at ${dbText(m.gain)}${m.item.fadeIn ? ", fades in" : ""}${m.item.fadeOut ? ", fades out" : ""}${duckEntry(m.track) ? ", ducked under the voice" : ""}`);
  for (const track of ctx.project.tracks) {
    if (!isSpeechTrack(ctx, track) || !audible(ctx, track)) continue;
    const spoken = track.items.filter((i) => soundOf(ctx, i));
    if (spoken.length) lines.push(`voice on ${track.name}: ${spoken.map((i) => `${secs(startOf(ctx, i), fps)} to ${secs(startOf(ctx, i) + i.duration, fps)}`).join(", ")}`);
  }
  const sfx = sfxItems(ctx);
  const events = visualEvents(ctx);
  for (const s of sfx) {
    const hits = hitsOf(ctx, s, events);
    const under = musicAt(music, s.start);
    lines.push(`sound effect ${secs(s.start, fps)} (f ${s.start}): ${s.label} (${s.kind}), ${secs(s.item.duration, fps)}, at ${dbText(s.gain)}${under ? ` (${dbText(s.gain - under.gain)} against the music)` : ""}; ${hits.length ? `lands on ${hits.slice(0, 2).map((e) => `${e.what} (f ${e.frame})`).join(" and ")}` : "lands on nothing that changes on screen"}`);
  }
  const length = Math.max(1, ctx.end);
  if (!music.length && !sfx.length) lines.push("No music and no sound effects.");
  else lines.push(`${sfx.length} sound effect${sfx.length === 1 ? "" : "s"} in ${secs(length, fps)} (${(Math.round((sfx.length / (length / fps)) * 100) / 10).toFixed(1)} per 10 s; the bar is at most ${SFX_PER_10S}), ${new Set(sfx.map((s) => s.sound)).size} different`);
  return lines;
}

/** The sound rule's findings that fail a critic round (density and level), by key. */
export const SOUND_HARD = /^sound:(density|loud):/;

// ---- the rules ----

export const CHECK_RULES: ReadonlyArray<CheckRule> = [
  {
    id: "text-read-time",
    title: "Time to read",
    description: "Every text stays fully on screen for at least words ÷ 3 seconds (2 s minimum), counted after its in move.",
    severity: "warn",
    check: (ctx) =>
      ctx.texts.flatMap((p) => {
        const need = readFrames(p.item.text, ctx.fps);
        const hold = holdOf(p.item);
        if (!textLabel(p.item.text) || hold >= need) return [];
        const words = wordCount(p.item.text ?? "");
        const fix = lengthen(ctx, p, need - hold);
        return [
          {
            key: `text-read-time:${p.item.id}`,
            message: `"${textLabel(p.item.text)}" is fully on screen for ${secs(hold, ctx.fps)}, and ${words} word${words === 1 ? "" : "s"} need about ${secs(need, ctx.fps)} to read twice.`,
            itemIds: [p.item.id],
            frame: p.start,
            range: { start: p.start, end: p.start + p.item.duration },
            ...(fix ? { fix } : { hint: "Make it longer (or shorten its moves), or cut words." }),
          },
        ];
      }),
  },
  {
    id: "last-text-hold",
    title: "Last text holds",
    description: "The last text of the video stays fully on screen for at least 3 seconds.",
    severity: "warn",
    check: (ctx) => {
      const last = ctx.texts.filter((p) => textLabel(p.item.text)).sort((a, b) => a.start + a.item.duration - (b.start + b.item.duration)).at(-1);
      if (!last) return [];
      const need = 3 * ctx.fps;
      const hold = holdOf(last.item);
      // The read-time rule already asks for more when it needs more.
      if (hold >= need || readFrames(last.item.text, ctx.fps) > need) return [];
      const fix = lengthen(ctx, last, need - hold);
      return [
        {
          key: `last-text-hold:${last.item.id}`,
          message: `The last text, "${textLabel(last.item.text)}", holds for ${secs(hold, ctx.fps)}; give the closing line at least 3 s.`,
          itemIds: [last.item.id],
          frame: last.start,
          range: { start: last.start, end: last.start + last.item.duration },
          ...(fix ? { fix } : { hint: "Start it earlier or make the video end later." }),
        },
      ];
    },
  },
  {
    id: "late-text",
    title: "No new text at the very end",
    description: "No text starts in the last 2 seconds of the video.",
    severity: "warn",
    check: (ctx) =>
      ctx.end <= 2 * ctx.fps
        ? []
        : ctx.texts
            .filter((p) => textLabel(p.item.text) && p.start > ctx.end - 2 * ctx.fps)
            .map((p) => ({
              key: `late-text:${p.item.id}`,
              message: `"${textLabel(p.item.text)}" starts ${secs(ctx.end - p.start, ctx.fps)} before the end, too late to be read.`,
              itemIds: [p.item.id],
              frame: p.start,
              hint: "Bring it in earlier, or drop it.",
            })),
  },
  {
    id: "trailing-period",
    title: "No trailing period",
    description: "Titles, captions and labels don't end with a period; a line break separates two thoughts.",
    severity: "warn",
    check: (ctx) =>
      ctx.texts.flatMap((p) => {
        const text = p.item.text ?? "";
        const fixed = fixPeriods(text);
        if (fixed === undefined) return [];
        return [
          {
            key: `trailing-period:${p.item.id}`,
            message: `"${textLabel(text)}" ends with a period; on screen it reads better without.`,
            itemIds: [p.item.id],
            frame: p.start,
            ...(locked(p) ? { hint: "Unlock it to drop the period." } : { fix: { summary: `Remove the period from "${textLabel(fixed)}"`, ops: [{ op: "update_item" as const, item: p.item.id, set: { text: fixed } }] } }),
          },
        ];
      }),
  },
  {
    id: "dot-separators",
    title: "No dots between words",
    description: "No ·, • or * between words: list with commas or line breaks.",
    severity: "warn",
    check: (ctx) =>
      ctx.texts.flatMap((p) => {
        const text = p.item.text ?? "";
        const fixed = fixDots(text, familyOf(ctx.project, p.item).mono);
        if (fixed === undefined) return [];
        return [
          {
            key: `dot-separators:${p.item.id}`,
            message: `"${textLabel(text)}" separates words with dots, which reads as generated; use commas or line breaks.`,
            itemIds: [p.item.id],
            frame: p.start,
            ...(locked(p) ? { hint: "Unlock it to swap the dots for commas." } : { fix: { summary: `Use commas in "${textLabel(fixed)}"`, ops: [{ op: "update_item" as const, item: p.item.id, set: { text: fixed } }] } }),
          },
        ];
      }),
  },
  {
    id: "filler-phrases",
    title: "No filler phrases",
    description: `No lines that could sit under any product (${FILLER_PHRASES.slice(0, 5).join(", ")}…).`,
    severity: "warn",
    check: (ctx) =>
      ctx.texts.flatMap((p) => {
        const found = [...new Set([...(p.item.text ?? "").matchAll(FILLER_RE)].map((m) => m[1]!.toLowerCase().replace(/\s+/g, " ")))];
        if (!found.length) return [];
        return [
          {
            key: `filler-phrases:${p.item.id}`,
            message: `"${textLabel(p.item.text)}" uses ${found.map((f) => `"${f}"`).join(" and ")}, which could describe any product.`,
            itemIds: [p.item.id],
            frame: p.start,
            hint: "Say the specific thing it does, the way you'd tell another dev.",
          },
        ];
      }),
  },
  {
    id: "frame-one",
    title: "Hook on frame 1",
    description: "Frame 1 is the thumbnail and what autoplay shows muted: it should show the video, not black or a fade from black.",
    severity: "warn",
    check: (ctx) => {
      if (ctx.end <= 0) return [];
      const shown = visualsAt(ctx.project, ctx.starts, 0).filter((v) => !v.item.id.startsWith("dip:"));
      const best = Math.max(0, ...shown.map((v) => v.opacity));
      if (best >= 0.5) return [];
      // Items at frame 0 that fade in: dropping their in move starts on a full frame.
      const fading = ctx.project.tracks.flatMap((track) => (track.hidden || track.kind === "audio" ? [] : track.items.filter((i) => startOf(ctx, i) === 0 && i.animation?.in && !locked({ item: i, track, start: 0 })).map((i) => ({ i }))));
      const ops: Array<Op> = fading.map(({ i }) => {
        const { in: _, ...rest } = i.animation!;
        return { op: "update_item", item: i.id, set: { animation: Object.keys(rest).length ? rest : null } };
      });
      return [
        {
          key: "frame-one",
          message: shown.length ? "Frame 1 fades in from black, so the thumbnail and the muted autoplay start on an empty frame." : "Frame 1 is empty, so the thumbnail and the muted autoplay start on black.",
          itemIds: fading.map(({ i }) => i.id),
          frame: 0,
          ...(ops.length ? { fix: { summary: "Start on a full frame (no fade in)", ops } } : { hint: "Start on the claim: put footage or the first line on frame 1." }),
        },
      ];
    },
  },
  {
    id: "crowded-text",
    title: "Few texts at once",
    description: "At most two texts on screen at the same time (a footnote in the Footnote look at its size or smaller, the disclosure line, doesn't count).",
    severity: "warn",
    check: (ctx) => {
      // Sweep the text spans: the first stretch where three or more overlap, once. A footnote
      // (text.footnote) is the small print best practice asks for ("sped up 8×", how it was
      // measured), not a competing idea, so it doesn't count (D96).
      const events = ctx.texts.filter((p) => !isFootnote(ctx, p.item)).flatMap((p) => [
        { at: p.start, d: 1, p },
        { at: p.start + p.item.duration, d: -1, p },
      ]);
      events.sort((a, b) => a.at - b.at || a.d - b.d);
      const on = new Set<Placed>();
      for (const e of events) {
        if (e.d < 0) on.delete(e.p);
        else on.add(e.p);
        if (on.size > 2) {
          const list = [...on];
          const end = Math.min(...list.map((p) => p.start + p.item.duration));
          return [
            {
              key: "crowded-text",
              message: `${list.length} texts are on screen together at ${secs(e.at, ctx.fps)}; one idea per frame reads better.`,
              itemIds: list.map((p) => p.item.id),
              frame: e.at,
              range: { start: e.at, end },
              hint: "Keep a title and at most one supporting line; move the rest to another moment or into the post.",
            },
          ];
        }
      }
      return [];
    },
  },
  {
    id: "one-typeface",
    title: "One typeface",
    description: "Text uses one typeface family (a mono face for code or labels is fine).",
    severity: "warn",
    check: (ctx) => {
      const by = new Map<string, { name: string; placed: Array<Placed>; tokens: Map<string, number> }>();
      for (const p of ctx.texts) {
        const f = familyOf(ctx.project, p.item);
        if (f.mono) continue;
        const g = by.get(f.key) ?? { name: f.name, placed: [] as Array<Placed>, tokens: new Map<string, number>() };
        g.placed.push(p);
        g.tokens.set(f.token, (g.tokens.get(f.token) ?? 0) + 1);
        by.set(f.key, g);
      }
      if (by.size < 2) return [];
      const groups = [...by.entries()].sort((a, b) => b[1].placed.length - a[1].placed.length);
      const names = groups.map(([, g]) => g.name);
      // The fix: every other text in the family most texts use (the house pair as DM Sans).
      const [majorKey, major] = groups[0]!;
      const token = majorKey === "sans" ? "DM Sans" : [...major.tokens.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const others = groups.slice(1).flatMap(([, g]) => g.placed);
      const ops: Array<Op> = others.filter((p) => !locked(p)).map((p) => ({ op: "update_item", item: p.item.id, set: { style: { ...(p.item.style ?? {}), font: token } } }));
      return [
        {
          key: "one-typeface",
          message: `Text uses ${names.length} typefaces (${names.slice(0, -1).join(", ")} and ${names.at(-1)}); one family with a real size scale looks designed.`,
          itemIds: others.map((p) => p.item.id),
          frame: Math.min(...others.map((p) => p.start)),
          ...(ops.length ? { fix: { summary: `Set ${ops.length === 1 ? "1 text" : `${ops.length} texts`} in ${major.name}`, ops } } : { hint: "Pick one in the Style tab's font list and use it for every text." }),
        },
      ];
    },
  },
  {
    id: "small-text",
    title: "Readable on a phone",
    description: "Text is at least 28 px tall on a 1080 px canvas (scaled to the canvas), so it reads at phone size.",
    severity: "warn",
    check: (ctx) =>
      ctx.texts.flatMap((p) => {
        const min = Math.round(28 * ctx.scale);
        const { size } = textPlacement(p.item, ctx.project);
        if (!textLabel(p.item.text) || size >= min - 0.5) return [];
        return [
          {
            key: `small-text:${p.item.id}`,
            message: `"${textLabel(p.item.text)}" is ${Math.round(size)} px, below the ${min} px that still reads on a phone.`,
            itemIds: [p.item.id],
            frame: p.start,
            ...(locked(p) ? { hint: "Unlock it to make it bigger." } : { fix: { summary: `Make "${textLabel(p.item.text)}" ${min} px`, ops: [{ op: "update_item" as const, item: p.item.id, set: { style: { ...(p.item.style ?? {}), size: min } } }] } }),
          },
        ];
      }),
  },
  {
    id: "text-edge",
    title: "Inside the safe area",
    description: "Text keeps clear of the frame's edges (about half the safe margin at least).",
    severity: "warn",
    check: (ctx) =>
      ctx.texts.flatMap((p) => {
        if (!textLabel(p.item.text)) return [];
        const { width, height } = ctx.project.canvas;
        const m = safeMargin(ctx.project) / 2;
        const { x, y, w, size } = textPlacement(p.item, ctx.project);
        const look = textLook(p.item.style?.preset);
        const align = p.item.style?.align ?? look.align ?? "left";
        const lines = (p.item.text ?? "").split("\n").length;
        const bottom = y + lines * size * (p.item.style?.lineHeight ?? look.lineHeight);
        const sides = [x < m && (align === "left" || w === undefined) ? "left" : "", y < m ? "top" : "", w !== undefined && x + w > width - m && align === "right" ? "right" : "", bottom > height - m ? "bottom" : ""].filter(Boolean);
        if (!sides.length) return [];
        return [
          {
            key: `text-edge:${p.item.id}`,
            message: `"${textLabel(p.item.text)}" is about at the ${sides.join(" and ")} edge of the frame; feeds crop and overlay there.`,
            itemIds: [p.item.id],
            frame: p.start,
            hint: `Keep it at least ${Math.round(safeMargin(ctx.project))} px from the edges (the safe margin).`,
          },
        ];
      }),
  },
  {
    id: "one-speed",
    title: "One footage speed",
    description: "Footage plays at one constant speed; cutting idle time is fine, mixing speeds isn't.",
    severity: "warn",
    check: (ctx) => {
      const by = new Map<number, Array<Id>>();
      for (const track of ctx.project.tracks) {
        if (track.hidden || track.kind !== "video") continue;
        for (const item of track.items) {
          const m = item.type === "clip" ? mediaOf(ctx, item) : undefined;
          if (m?.kind === "video") by.set(item.speed ?? 1, [...(by.get(item.speed ?? 1) ?? []), item.id]);
        }
      }
      if (by.size < 2) return [];
      const speeds = [...by.keys()].sort((a, b) => a - b).map((s) => `${Math.round(s * 100) / 100}×`);
      // The odd ones out: every clip not at the most used speed (1× wins a tie).
      const base = [...by.entries()].sort((a, b) => b[1].length - a[1].length || Number(b[0] === 1) - Number(a[0] === 1))[0]![0];
      const odd = [...by.entries()].filter(([s]) => s !== base).flatMap(([, list]) => list);
      return [
        {
          key: "one-speed",
          message: `Clips play at ${speeds.slice(0, -1).join(", ")} and ${speeds.at(-1)}; mixed speeds in one demo read as dishonest.`,
          itemIds: odd,
          frame: Math.min(...odd.map((id) => ctx.starts.get(id) ?? 0)),
          hint: "Use one speed for all footage and say it once in the post (for example \"sped up 3×\").",
        },
      ];
    },
  },
  {
    id: "same-entrance",
    title: "Varied entrances",
    description: "Three or more texts that all enter with the same move read as a template.",
    severity: "info",
    check: (ctx) => {
      const texts = ctx.texts.filter((p) => textLabel(p.item.text));
      if (texts.length < 3) return [];
      const first = texts[0]!.item.animation?.in?.module;
      if (!first || !texts.every((p) => p.item.animation?.in?.module === first)) return [];
      return [
        {
          key: "same-entrance",
          message: `All ${texts.length} texts enter with the same ${first.replace(/^move\./, "").replace(/-/g, " ")} move, which looks templated.`,
          itemIds: texts.map((p) => p.item.id),
          frame: texts[0]!.start,
          hint: "Let most text simply cut in, and keep a move for the one line that needs it.",
        },
      ];
    },
  },
  {
    id: "long-transition",
    title: "Short transitions",
    description: "Cuts are hard or very short crossfades (1 s at most).",
    severity: "info",
    check: (ctx) =>
      ctx.project.tracks.flatMap((track) =>
        track.role !== "main"
          ? []
          : track.items
              .filter((i) => i.transitionIn && overlaps(i.transitionIn.module) && i.transitionIn.duration > ctx.fps)
              .map((i) => ({
                key: `long-transition:${i.id}`,
                message: `The ${secs(i.transitionIn!.duration, ctx.fps)} transition into ${i.name ?? i.id} is long; hard cuts or very short crossfades keep the pace.`,
                itemIds: [i.id],
                frame: startOf(ctx, i),
                ...(track.locked || i.locked ? {} : { fix: { summary: "Shorten the transition to 0.3 s", ops: [{ op: "set_transition" as const, item: i.id, transition: { ...i.transitionIn!, duration: Math.max(2, Math.round(0.3 * ctx.fps)) } }] } }),
              })),
      ),
  },
  {
    id: "blank-gap",
    title: "No blank stretches",
    description: "Nothing shows black in the middle of the video.",
    severity: "warn",
    check: (ctx) => {
      if (ctx.end <= 0) return [];
      const spans: Array<[number, number]> = [];
      for (const track of ctx.project.tracks) {
        if (track.hidden || track.kind === "audio") continue;
        for (const item of track.items) if (item.type !== "captions") spans.push([startOf(ctx, item), startOf(ctx, item) + item.duration]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      const out: Array<Omit<Check, "id" | "severity">> = [];
      let covered = 0;
      for (const [s, e] of spans) {
        // A gap from frame 0 is the frame-one rule's.
        if (s > covered && covered > 0 && s - covered >= Math.round(ctx.fps / 5)) out.push({ key: `blank-gap:${covered}`, message: `Nothing shows from ${secs(covered, ctx.fps)} to ${secs(s, ctx.fps)}, so the video goes black there.`, frame: covered, range: { start: covered, end: s }, hint: "Close the gap or fill it with footage." });
        covered = Math.max(covered, e);
      }
      return out;
    },
  },
  {
    id: "silent",
    title: "Has sound",
    description: "A video gets an audio track: music at about −16 LUFS or the footage's own sound.",
    severity: "info",
    check: (ctx) => {
      if (ctx.end <= 0 || ctx.project.tracks.some((t) => sounds(ctx, t) && audible(ctx, t))) return [];
      return [{ key: "silent", message: "Nothing makes a sound, so the export carries a silent track.", hint: "Add a track from the Audio tab's library whose tempo fits the cutting, with fades." }];
    },
  },
  {
    id: "music-fades",
    title: "Music fades in and out",
    description: "Music that starts with the video or plays to its end fades in or out instead of starting or stopping cold.",
    severity: "warn",
    check: (ctx) =>
      ctx.project.tracks.flatMap((track) => {
        if (!isMusicTrack(ctx, track)) return [];
        return track.items.flatMap((item) => {
          if (item.type !== "audio" || !soundOf(ctx, item)) return [];
          const start = startOf(ctx, item);
          // A fade made with volume keys counts (the fix doesn't stack a fade on it).
          const needIn = !item.fadeIn && !keyFade(item, "in") && start === 0;
          const needOut = !item.fadeOut && !keyFade(item, "out") && start + item.duration >= ctx.end;
          if (!needIn && !needOut) return [];
          const fadeIn = needIn ? Math.min(ctx.fps, Math.floor(item.duration / 4)) : item.fadeIn;
          const fadeOut = needOut ? Math.min(2 * ctx.fps, Math.floor(item.duration / 4)) : item.fadeOut;
          const name = mediaOf(ctx, item)?.name ?? item.id;
          const what = needIn && needOut ? "starts and stops cold" : needIn ? "starts cold" : "stops cold";
          const set: Record<string, unknown> = {};
          if (needIn && fadeIn) set.fadeIn = fadeIn;
          if (needOut && fadeOut) set.fadeOut = fadeOut;
          const ok = Object.keys(set).length > 0 && !track.locked && !item.locked;
          return [
            {
              key: `music-fades:${item.id}`,
              message: `${name} ${what}; a short fade sounds finished.`,
              itemIds: [item.id],
              frame: needIn ? start : start + item.duration - 1,
              ...(ok ? { fix: { summary: needIn && needOut ? `Fade ${name} in and out` : needIn ? `Fade ${name} in` : `Fade ${name} out`, ops: [{ op: "update_item" as const, item: item.id, set }] } } : { hint: "Add a fade in the Inspector's Fades row." }),
            },
          ];
        });
      }),
  },
  {
    id: "music-ducking",
    title: "Music ducks under speech",
    description: "A music bed playing under a voice is ducked (audio.duck) so the voice stays clear.",
    severity: "info",
    check: (ctx) =>
      ctx.project.tracks.flatMap((track) => {
        if (!isMusicTrack(ctx, track) || duckEntry(track) || !sounds(ctx, track) || !audible(ctx, track)) return [];
        // The tracks it plays under: heard speech tracks (voice, narration, or main when its sound
        // is known to be speech) overlapping it in time. Effects and ambient sound don't count.
        const spans = track.items.map((i) => [startOf(ctx, i), startOf(ctx, i) + i.duration] as const);
        const keys = ctx.project.tracks.filter(
          (t) => t.id !== track.id && isSpeechTrack(ctx, t) && audible(ctx, t) && t.items.some((i) => soundOf(ctx, i) && spans.some(([s, e]) => startOf(ctx, i) < e && startOf(ctx, i) + i.duration > s)),
        );
        if (!keys.length) return [];
        const mixer = { ...(track.mixer ?? {}), effects: [...(track.mixer?.effects ?? []), { module: DUCK, params: { under: keys.map((k) => k.id), amountDb: -12, attackMs: 250, releaseMs: 600 } }] };
        const names = keys.map((k) => k.name);
        return [
          {
            key: `music-ducking:${track.id}`,
            message: `${track.name} plays under ${names.join(" and ")} at full level; ducking keeps the voice clear.`,
            itemIds: track.items.map((i) => i.id),
            frame: Math.min(...spans.map(([s]) => s)),
            ...(track.locked ? { hint: "Unlock the track, then add Duck in the Mixer." } : { fix: { summary: `Duck ${track.name} under ${names.join(" and ")}`, ops: [{ op: "update_track" as const, track: track.id, set: { mixer } }] } }),
          },
        ];
      }),
  },
  {
    id: "sound",
    title: "Sound design",
    description: `Sound effects are few and earn their place: at most ${SFX_PER_10S} in any 10 s, each on something that changes on screen, the same file at most ${SFX_REPEAT_MAX - 1} times, one big hit per 15 s, ${SFX_UNDER_MUSIC_DB} to 12 dB under the music, no clicks on text, no meme sounds unless asked, and music whose tempo fits the cutting.`,
    severity: "warn",
    check: (ctx) => {
      const out: Array<Omit<Check, "id" | "severity"> & { severity?: CheckSeverity }> = [];
      const fps = ctx.fps;
      const sfx = sfxItems(ctx);
      const music = musicItems(ctx);
      const events = visualEvents(ctx);
      const length = Math.max(1, ctx.end);
      // Density: the busiest 10 s (a shorter video pro rata, at least 2).
      const window = Math.min(10 * fps, length);
      const limit = Math.max(2, Math.floor((SFX_PER_10S * window) / (10 * fps)));
      const dense = busiest(sfx.map((s) => s.start), 10 * fps);
      if (dense.count > limit) {
        const inWindow = sfx.filter((s) => s.start >= dense.from && s.start <= dense.to);
        out.push({
          key: `sound:density:${dense.from}`,
          message: `${dense.count} sound effects start between ${secs(dense.from, fps)} and ${secs(dense.to, fps)}; at most ${limit} in any ${secs(window, fps)}, so each one means something.`,
          itemIds: inWindow.map((s) => s.item.id),
          frame: dense.from,
          range: { start: dense.from, end: dense.to + 1 },
          hint: "Keep the effects on the moments that matter (the reveal, a real click, the end card) and delete the rest; a cut on the beat needs no whoosh.",
        });
      }
      // The same file over and over.
      const bySound = new Map<string, Array<PlacedSfx>>();
      for (const s of sfx) bySound.set(s.sound, [...(bySound.get(s.sound) ?? []), s]);
      for (const [sound, uses] of bySound) {
        if (uses.length < SFX_REPEAT_MAX) continue;
        out.push({
          key: `sound:repeat:${sound}`,
          message: `${uses[0]!.label} plays ${uses.length} times (${uses.map((s) => secs(s.start, fps)).join(", ")}); the same sound again and again reads as a template.`,
          itemIds: uses.map((s) => s.item.id),
          frame: uses[0]!.start,
          hint: `Keep it on at most ${SFX_REPEAT_MAX - 1} real events, or use different sounds for different kinds of event.`,
        });
      }
      // Big hits.
      const hits = sfx.filter((s) => s.kind === "hit");
      const heavy = busiest(hits.map((s) => s.start), 15 * fps);
      if (heavy.count > SFX_HITS_PER_15S) {
        const these = hits.filter((s) => s.start >= heavy.from && s.start <= heavy.to);
        out.push({
          key: `sound:hits:${heavy.from}`,
          message: `${these.length} big hits (${these.map((s) => `${s.label} at ${secs(s.start, fps)}`).join(", ")}) within 15 s; a boom lands once, on the moment that matters most.`,
          itemIds: these.map((s) => s.item.id),
          frame: heavy.from,
          hint: "Keep one hit for the reveal or the logo; the others go, or become something softer.",
        });
      }
      for (const s of sfx) {
        // Level against the music it plays over.
        const under = musicAt(music, s.start);
        if (under && s.gain - under.gain > -SFX_UNDER_MUSIC_DB) {
          const target = Math.round((under.gain - SFX_FIX_UNDER_DB - trackGain(s.track)) * 10) / 10;
          const ok = !s.track.locked && !s.item.locked && target >= -60;
          // Only the pack's level is known (peak-normalised): another file's may already be quiet,
          // so it's a soft "level" finding to listen to or measure, never a hard one.
          out.push({
            key: `sound:${s.bundled ? "loud" : "level"}:${s.item.id}`,
            ...(s.bundled ? {} : { severity: "info" as const }),
            message: s.bundled
              ? `${s.label} at ${secs(s.start, fps)} is at ${dbText(s.gain)} over music at ${dbText(under.gain)}; effects sit ${SFX_UNDER_MUSIC_DB} to 12 dB under the music (the pack's effects are peak-normalised, so at the same gain they jump out).`
              : `${s.label} at ${secs(s.start, fps)} is at ${dbText(s.gain)} over music at ${dbText(under.gain)}; its own loudness is unknown, so check it sits ${SFX_UNDER_MUSIC_DB} to 12 dB under the music (media_analyze loudness, or listen).`,
            itemIds: [s.item.id],
            frame: s.start,
            ...(ok ? { fix: { summary: `Put ${s.label} ${SFX_FIX_UNDER_DB} dB under the music`, ops: [{ op: "update_item" as const, item: s.item.id, set: { gainDb: target } }] } } : { hint: "Turn it down in the Inspector." }),
          });
        }
        // What it lands on.
        const on = hitsOf(ctx, s, events);
        if (!on.length) {
          const near = events.reduce<VisualEvent | undefined>((best, e) => (!best || Math.abs(e.frame - s.start) < Math.abs(best.frame - s.start) ? e : best), undefined);
          out.push({
            key: `sound:sync:${s.item.id}`,
            message: `${s.label} at ${secs(s.start, fps)} lands on nothing that changes on screen${near ? ` (the nearest is ${near.what} at ${secs(near.frame, fps)})` : ""}.`,
            itemIds: [s.item.id],
            frame: s.start,
            hint: s.kind === "whoosh" ? "Start a whoosh 1 to 2 frames before the cut or move it carries, or delete it." : s.kind === "riser" ? "End a riser on the reveal it builds to, or delete it." : "Move it onto the frame its event happens (1 to 2 frames early), or delete it.",
          });
        } else if (s.kind === "ui" && on.every((e) => e.text)) {
          out.push({
            key: `sound:click-text:${s.item.id}`,
            message: `${s.label} at ${secs(s.start, fps)} clicks on a text (${on[0]!.what}); a click belongs on a click the viewer sees, and a text arriving or typing isn't one.`,
            itemIds: [s.item.id],
            frame: s.start,
            hint: "Delete it, or put it where a cursor or a finger presses something.",
          });
        }
        if (s.kind === "meme") {
          out.push({ key: `sound:meme:${s.item.id}`, severity: "info", message: `${s.label} at ${secs(s.start, fps)} is a meme sound; use one only when the user asked for that joke.`, itemIds: [s.item.id], frame: s.start, hint: "Delete it unless the brief asks for meme humour." });
        }
      }
      // A slow track under fast cuts.
      const slow = music.find((m) => typeof m.bpm === "number" && m.bpm < SLOW_BPM && m.item.duration >= Math.min(length, 8 * fps));
      if (slow) {
        const cuts = events.filter((e) => e.frame >= slow.start && e.frame < slow.start + slow.item.duration && !e.what.endsWith("leaving") && !e.what.endsWith("landing") && e.until === undefined);
        const avg = slow.item.duration / fps / Math.max(1, cuts.length + 1);
        if (cuts.length >= 4 && avg < FAST_CUT_S) {
          out.push({
            key: `sound:pace:${slow.item.id}`,
            severity: "info",
            message: `${slow.media.name} is ${slow.bpm} BPM under something new every ${avg.toFixed(1)} s; a slow loop under fast cutting feels sluggish.`,
            itemIds: [slow.item.id],
            frame: slow.start,
            hint: "Pick music whose tempo fits the cutting (music_list tempo fast, 110 to 130 BPM for a punchy promo) and cut on its beats (beat_grid), or slow the cutting down.",
          });
        }
      }
      return out;
    },
  },
  {
    id: "canvas-format",
    title: "Canvas for the feed",
    description: "Phone feeds show 4:5 (1080×1350) biggest; 16:9 suits YouTube, decks and sites.",
    severity: "info",
    check: (ctx) => {
      const { width, height } = ctx.project.canvas;
      if (Math.abs(width / height - 4 / 5) < 0.01) return [];
      return [{ key: "canvas-format", message: `The canvas is ${width}×${height}; for X and other phone feeds, 4:5 (1080×1350) shows bigger, while 16:9 is right for YouTube and sites.`, hint: "Pick the format when you make the project; keep this one if it's for a landscape screen." }];
    },
  },
];

/** The rule ids, in the registry's order. */
export const CHECK_IDS = CHECK_RULES.map((r) => r.id);

/** The rule ids a project turned off (checks.disabled), ignoring anything that isn't a string. */
export const disabledChecks = (project: Pick<Project, "checks">): ReadonlyArray<string> => (Array.isArray(project.checks?.disabled) ? project.checks.disabled.filter((d): d is string => typeof d === "string") : []);

/**
 * The project's checks: every rule (CHECK_RULES, plus the `rules` a module adds; one with a built-in
 * id replaces it) that isn't in the project's checks.disabled or `disabled`, warnings first, then
 * by frame. `speechMedia`: media known to hold speech (a transcript), for the ducking rule; media
 * that captions were made from count too. Never throws: a rule that fails is skipped.
 */
export function projectChecks(project: Project, options: { readonly rules?: ReadonlyArray<CheckRule>; readonly disabled?: ReadonlyArray<string>; readonly speechMedia?: Iterable<Id> } = {}): Array<Check> {
  const off = new Set([...disabledChecks(project), ...(options.disabled ?? [])]);
  const ctx = checkContext(project, options);
  const out: Array<Check> = [];
  for (const rule of allRules(options.rules)) {
    if (off.has(rule.id)) continue;
    try {
      for (const found of rule.check(ctx)) out.push({ ...found, id: rule.id, severity: found.severity ?? rule.severity });
    } catch {
      // A broken rule mustn't take the others (or the editor) down.
    }
  }
  const rank = (c: Check) => (c.severity === "warn" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (a.frame ?? Infinity) - (b.frame ?? Infinity));
}

/** What every rule gets (projectChecks, soundSheet). */
function checkContext(project: Project, options: { readonly speechMedia?: Iterable<Id> } = {}): CheckContext {
  const { starts, duration } = layout(project);
  const end = project.tracks.some((t) => t.items.some((i) => i.type !== "captions")) ? duration : 0;
  const texts: Array<Placed> = [];
  const speech = new Set<Id>(options.speechMedia ?? []);
  for (const track of project.tracks) {
    for (const item of track.items) if (item.type === "captions" && item.source) speech.add(item.source);
    if (track.hidden || track.kind !== "text") continue;
    for (const item of track.items) if (item.type === "text") texts.push({ item, track, start: starts.get(item.id) ?? 0 });
  }
  texts.sort((a, b) => a.start - b.start);
  return { project, fps: project.canvas.fps, starts, end, texts, scale: Math.min(project.canvas.width, project.canvas.height) / 1080, media: new Map(project.media.map((m) => [m.id, m])), speech, audible: new Map() };
}

/** The built-in rules with a module's added (same id: the module's replaces the built-in one). */
function allRules(extra: ReadonlyArray<CheckRule> = []): ReadonlyArray<CheckRule> {
  if (!extra.length) return CHECK_RULES;
  const ids = new Set(extra.map((r) => r.id));
  return [...CHECK_RULES.filter((r) => !ids.has(r.id)), ...extra];
}

/** A rule by id (the built-in ones and `extra`), for titles in the UI. */
export const checkRule = (id: string, extra: ReadonlyArray<CheckRule> = []) => allRules(extra).find((r) => r.id === id);

/** The update_project that turns a rule off (or back on) for the project. */
export function planDisableCheck(project: Pick<Project, "checks">, id: string, off = true): CheckFix {
  const now = disabledChecks(project);
  const next = off ? [...new Set([...now, id])] : now.filter((d) => d !== id);
  const title = checkRule(id)?.title ?? id;
  const rest = { ...(project.checks ?? {}) } as Record<string, unknown>;
  delete rest.disabled;
  const checks = next.length ? { ...rest, disabled: next } : Object.keys(rest).length ? rest : null;
  return { summary: off ? `Turn off the check "${title}"` : `Turn on the check "${title}"`, ops: [{ op: "update_project", set: { checks } }] };
}

const hex6 = (c: unknown): string | undefined => {
  if (typeof c !== "string") return undefined;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return undefined;
  const h = m[1]!.toLowerCase();
  return `#${h.length === 3 ? [...h].map((x) => x + x).join("") : h}`;
};
const rgbOf = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const nearest = (h: string, palette: ReadonlyArray<string>) => palette.reduce((best, p) => {
  const [a, b] = [rgbOf(h), rgbOf(p)];
  const d = (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;
  return d < best.d ? { p, d } : best;
}, { p: palette[0]!, d: Infinity }).p;

/**
 * D186: the brand kit's colours rule (U7): text colours, outlines, text boxes and backgrounds
 * (component.solid) written as a hex colour that isn't one of the kit's. Theme tokens (fg, accent…)
 * are fine: the theme carries the kit. Added to project_check's rules while a kit is active; the
 * fix moves each colour to the kit's nearest.
 */
export function brandColourRule(kitName: string, colors: ReadonlyArray<string>): CheckRule {
  const palette = [...new Set(colors.map(hex6).filter((c): c is string => !!c))];
  return {
    id: "brand-colours",
    title: "Brand colours",
    description: `Colours come from the brand kit "${kitName}".`,
    severity: "warn",
    check: (ctx) => {
      if (!palette.length) return [];
      const off = (c: unknown) => {
        const h = hex6(c);
        return h && !palette.includes(h) ? h : undefined;
      };
      const out: Array<Omit<Check, "id" | "severity"> & { severity?: CheckSeverity }> = [];
      for (const track of ctx.project.tracks) {
        if (track.hidden) continue;
        for (const item of track.items) {
          const at = ctx.starts.get(item.id) ?? 0;
          const lock = track.locked === true || item.locked === true;
          if (item.type === "text" && item.style) {
            const st = item.style as Record<string, unknown>;
            const found = [off(st.color), off((st.stroke as { color?: unknown } | undefined)?.color), off((st.background as { color?: unknown } | undefined)?.color)].filter((x): x is string => !!x);
            if (!found.length) continue;
            const fixStyle: Record<string, unknown> = { ...st };
            if (off(st.color)) fixStyle.color = nearest(off(st.color)!, palette);
            if (st.stroke && typeof st.stroke === "object" && off((st.stroke as { color?: unknown }).color)) fixStyle.stroke = { ...(st.stroke as object), color: nearest(off((st.stroke as { color?: unknown }).color)!, palette) };
            if (st.background && typeof st.background === "object" && off((st.background as { color?: unknown }).color)) fixStyle.background = { ...(st.background as object), color: nearest(off((st.background as { color?: unknown }).color)!, palette) };
            out.push({ key: `brand-colours:${item.id}`, message: `"${textLabel(item.text)}" uses ${found.join(", ")}, not a colour of the kit "${kitName}".`, itemIds: [item.id], frame: at, ...(lock ? {} : { fix: { summary: `Use the kit's colours on "${textLabel(item.text)}"`, ops: [{ op: "update_item", item: item.id, set: { style: fixStyle } } as Op] } }) });
          } else if (item.type === "component" && item.component === "component.solid" && item.props) {
            const pr = item.props as Record<string, unknown>;
            const keys = ["color", "to", "via"].filter((k) => off(pr[k]));
            if (!keys.length) continue;
            const props = { ...pr, ...Object.fromEntries(keys.map((k) => [k, nearest(off(pr[k])!, palette)])) };
            out.push({ key: `brand-colours:${item.id}`, message: `A background uses ${keys.map((k) => off(pr[k])).join(", ")}, not a colour of the kit "${kitName}".`, itemIds: [item.id], frame: at, ...(lock ? {} : { fix: { summary: "Use the kit's colours on the background", ops: [{ op: "update_item", item: item.id, set: { props } } as Op] } }) });
          }
        }
      }
      return out;
    },
  };
}
