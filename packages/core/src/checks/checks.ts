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
import { textLook } from "../text/looks.ts";
import { DIP_TO_BLACK } from "../visual/transitions.ts";
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
      return !!m && (MUSIC_NAME.test(m.name) || !!libraryTrackOf(m));
    }));
/** soundMedia (audio.ts) through the context's media map. */
function soundOf(ctx: CheckContext, item: Item) {
  if (item.type !== "clip" && item.type !== "audio") return undefined;
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
              .filter((i) => i.transitionIn && i.transitionIn.module !== DIP_TO_BLACK && i.transitionIn.duration > ctx.fps)
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
      return [{ key: "silent", message: "Nothing makes a sound, so the export carries a silent track.", hint: "Add a cozy track from the Audio tab's library, with fades." }];
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
  const ctx: CheckContext = { project, fps: project.canvas.fps, starts, end, texts, scale: Math.min(project.canvas.width, project.canvas.height) / 1080, media: new Map(project.media.map((m) => [m.id, m])), speech, audible: new Map() };
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
