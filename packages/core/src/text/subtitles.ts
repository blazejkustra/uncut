// Subtitle files (D105), browser-safe. Writing: the cues are the cards the captions draw (core
// captionCards: the same grouping, hold, bridge and window; hidden words and fillers left out,
// corrections applied; word and single modes export their cards as line cards) plus the text items
// of "Subtitles" tracks (an imported .srt / .vtt), in timeline (post-cut) time at the project's fps,
// merged by time into one list (one file, one soft track). Reading: a .srt or .vtt becomes plain
// text items on a new "Subtitles" text track at the cues' timeline frames (planImportSubtitles), so
// D82's captions model (a media's transcript mapped through the main track) is left as it is.
import { TEXT_STYLES } from "./looks.ts";
import { lookItem } from "./textPlan.ts";
import { captionBox, captionCards, CAPTION_DEFAULTS } from "./captions.ts";
import { layout } from "../timeline/timeline.ts";
import { mainEnd } from "../timeline/rules.ts";
import type { Item, Op, Project, Track } from "../timeline/types.ts";

export type SubtitleFormat = "srt" | "vtt";
export const SUBTITLE_FORMATS: ReadonlyArray<SubtitleFormat> = ["srt", "vtt"];

/** A cue: timeline frames [from, to) and its text (lines separated by \n, no markup). */
export interface SubtitleCue {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** A cue read from a file: seconds and text. */
export interface ParsedCue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A text track that holds subtitles (made by an import): its plain text items are cues. */
export const isSubtitleTrack = (track: Pick<Track, "kind" | "name">) => track.kind === "text" && /^Subtitles\b/.test(track.name ?? "");

/** A subtitles-track text item the export may draw as part of one layer: no motion, keys or opacity of its own. */
export const isPlainCue = (item: Item) =>
  item.type === "text" &&
  typeof item.text === "string" &&
  !item.animation &&
  !item.keys?.length &&
  !item.effects?.length &&
  (item.transform?.opacity === undefined || item.transform.opacity === 1);

/** Text markup (**bold**, [[accent]], `mono`) as plain text. */
const unmarkup = (text: string) =>
  text
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/\[\[(.+?)\]\]/gs, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/​/g, "");

/**
 * Every cue the project's subtitles hold, in timeline order: the cards of each captions item and
 * the text items of each Subtitles track, on tracks that aren't hidden, clipped to the edit's length.
 */
export function subtitleCues(project: Project): Array<SubtitleCue> {
  const { starts, duration } = layout(project);
  const out: Array<SubtitleCue> = [];
  const push = (from: number, to: number, text: string) => {
    const a = Math.max(0, from);
    const b = Math.min(duration, to);
    const t = text
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    if (b > a && t) out.push({ from: a, to: b, text: t });
  };
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const item of track.items) {
      if (item.type === "captions") {
        for (const card of captionCards(project, item)) {
          let i = 0;
          const lines = card.lines.map((n) => {
            const line = card.words
              .slice(i, i + n)
              .map((w) => w.text)
              .join(" ");
            i += n;
            return line;
          });
          push(card.from, card.to, lines.join("\n"));
        }
      } else if (isSubtitleTrack(track) && item.type === "text" && typeof item.text === "string") {
        const start = starts.get(item.id) ?? item.start ?? 0;
        push(start, start + item.duration, unmarkup(item.text));
      }
    }
  }
  // Stable: cues starting together keep their track order.
  return out
    .map((c, k) => ({ c, k }))
    .sort((a, b) => a.c.from - b.c.from || a.k - b.k)
    .map((x) => x.c);
}

/**
 * Cues that never overlap: wherever cues overlap, one cue with their texts stacked (in the list's
 * order), split at every start and end, touching pieces with the same text joined. An mp4's soft
 * subtitle track (mov_text) shows one sample at a time, so overlapping cues would cut each other off.
 */
export function flattenCues(cues: ReadonlyArray<SubtitleCue>): Array<SubtitleCue> {
  const edges = [...new Set(cues.flatMap((c) => [c.from, c.to]))].sort((a, b) => a - b);
  const out: Array<SubtitleCue> = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    const text = cues
      .filter((c) => c.from <= from && c.to >= to)
      .map((c) => c.text)
      .join("\n");
    if (!text) continue;
    const last = out.at(-1);
    if (last && last.to === from && last.text === text) out[out.length - 1] = { ...last, to };
    else out.push({ from, to, text });
  }
  return out;
}

/** Frames as a file's clock: HH:MM:SS,mmm (SRT) or HH:MM:SS.mmm (VTT), to the nearest millisecond. */
export function subtitleTime(frames: number, fps: number, format: SubtitleFormat): string {
  const ms = Math.max(0, Math.round((frames * 1000) / fps));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${format === "srt" ? "," : "."}${pad(ms % 1000, 3)}`;
}

/** A cue's text made safe for the format: no blank lines (they end a cue), no "-->", and in VTT & < > as entities. */
function cueText(text: string, format: SubtitleFormat): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim().replace(/-->/g, "->"))
    .filter(Boolean);
  const body = lines.join("\n");
  return format === "vtt" ? body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : body;
}

/** The cues as a subtitle file (SRT numbered from 1; VTT with its WEBVTT header). Ends with a newline. */
export function writeSubtitles(cues: ReadonlyArray<SubtitleCue>, fps: number, format: SubtitleFormat): string {
  const blocks = cues.map((c, i) => {
    const time = `${subtitleTime(c.from, fps, format)} --> ${subtitleTime(c.to, fps, format)}`;
    return format === "srt" ? `${i + 1}\n${time}\n${cueText(c.text, "srt")}` : `${time}\n${cueText(c.text, "vtt")}`;
  });
  return format === "srt" ? (blocks.length ? `${blocks.join("\n\n")}\n` : "") : `WEBVTT\n\n${blocks.map((b) => `${b}\n\n`).join("")}`;
}
export const writeSrt = (cues: ReadonlyArray<SubtitleCue>, fps: number) => writeSubtitles(cues, fps, "srt");
export const writeVtt = (cues: ReadonlyArray<SubtitleCue>, fps: number) => writeSubtitles(cues, fps, "vtt");

/** The format of a file name by its extension (undefined: neither). */
export const subtitleFormatOf = (name: string): SubtitleFormat | undefined => {
  const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext === "srt" || ext === "vtt" ? ext : undefined;
};

// ---- languages (the soft track's tag) ----

/** Languages the export dialog offers for a soft subtitle track: ISO 639-1 code, the mp4's ISO 639-2 tag, the name. */
export const SUBTITLE_LANGUAGES: ReadonlyArray<{ readonly code: string; readonly tag: string; readonly name: string }> = [
  { code: "en", tag: "eng", name: "English" },
  { code: "pl", tag: "pol", name: "Polish" },
  { code: "de", tag: "ger", name: "German" },
  { code: "fr", tag: "fre", name: "French" },
  { code: "es", tag: "spa", name: "Spanish" },
  { code: "it", tag: "ita", name: "Italian" },
  { code: "pt", tag: "por", name: "Portuguese" },
  { code: "nl", tag: "dut", name: "Dutch" },
  { code: "sv", tag: "swe", name: "Swedish" },
  { code: "no", tag: "nor", name: "Norwegian" },
  { code: "da", tag: "dan", name: "Danish" },
  { code: "fi", tag: "fin", name: "Finnish" },
  { code: "cs", tag: "cze", name: "Czech" },
  { code: "uk", tag: "ukr", name: "Ukrainian" },
  { code: "ru", tag: "rus", name: "Russian" },
  { code: "tr", tag: "tur", name: "Turkish" },
  { code: "ja", tag: "jpn", name: "Japanese" },
  { code: "ko", tag: "kor", name: "Korean" },
  { code: "zh", tag: "chi", name: "Chinese" },
  { code: "hi", tag: "hin", name: "Hindi" },
  { code: "ar", tag: "ara", name: "Arabic" },
];

/** A language code (en, eng, en-US) as the mp4's three-letter tag; "und" when it isn't known. */
export function subtitleLanguageTag(code: string | undefined): string {
  const c = (code ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  const hit = SUBTITLE_LANGUAGES.find((l) => l.code === c || l.tag === c);
  if (hit) return hit.tag;
  return /^[a-z]{3}$/.test(c) ? c : "und";
}

// ---- reading .srt / .vtt ----

/** At most this many cues in a file. */
export const MAX_SUBTITLE_CUES = 20000;

/** A subtitle file's bytes as text: UTF-8 (with or without a BOM), UTF-16 with a BOM, else Windows-1252 (older .srt files). */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/;
const seconds = (t: string): number | undefined => {
  const m = TIME.exec(t.trim());
  if (!m) return undefined;
  const [, h, mm, ss, frac] = m;
  if (Number(mm) > 59 && h !== undefined) return undefined;
  if (Number(ss) > 59) return undefined;
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + (frac ? Number(frac.padEnd(3, "0")) / 1000 : 0);
};
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", nbsp: " ", quot: '"', apos: "'", lrm: "", rlm: "" };
/** A cue's text as plain lines: tags (<i>, <c.x>, <v Name>, <00:01.000>) and {\an8}-style overrides dropped, entities decoded. */
const plainCue = (lines: ReadonlyArray<string>) =>
  lines
    .map((l) =>
      l
        .replace(/<[^>]*>/g, "")
        .replace(/\{\\[^}]*\}/g, "")
        .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
          if (e[0] === "#") {
            const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
          }
          return ENTITIES[e.toLowerCase()] ?? all;
        })
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");

/**
 * The cues of a .srt or .vtt file's text, in time order, or why it can't be read (a sentence).
 * `name` (the file name) picks the format by its extension; text starting with WEBVTT is read as
 * VTT whatever the name. Blocks without a timing line (VTT's NOTE, STYLE, REGION, a stray number)
 * are skipped; a timing line Uncut can't read refuses the file with its line number; cues with no
 * text or that end before they start are left out.
 */
export function parseSubtitles(
  text: string,
  name = "subtitles.srt",
): { readonly cues: Array<ParsedCue>; readonly format: SubtitleFormat; readonly skipped: number } | { readonly problem: string } {
  const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const ext = subtitleFormatOf(name);
  const vtt = /^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(body);
  if (ext === "vtt" && !vtt) return { problem: `${name} isn't a WebVTT file: it has to start with "WEBVTT".` };
  if (!body.trim()) return { problem: `${name} is empty.` };
  const format: SubtitleFormat = vtt ? "vtt" : "srt";
  const lines = body.split("\n");
  const cues: Array<ParsedCue> = [];
  let skipped = 0;
  let i = vtt ? 1 : 0;
  // VTT: the header block (WEBVTT and any lines after it up to a blank line) isn't a cue.
  if (vtt) while (i < lines.length && lines[i]!.trim() !== "") i++;
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === "") i++;
    const block: Array<{ line: string; n: number }> = [];
    while (i < lines.length && lines[i]!.trim() !== "") block.push({ line: lines[i]!, n: ++i });
    if (!block.length) break;
    const timing = block.findIndex((b) => b.line.includes("-->"));
    if (timing < 0 || timing > 1) {
      if (timing > 1) return { problem: `${name} has a cue Uncut can't read at line ${block[timing]!.n}: the time should come right after the cue's number.` };
      continue;
    }
    const t = block[timing]!;
    const [left, rightAll] = t.line.split("-->");
    const right = (rightAll ?? "").trim().split(/\s+/)[0] ?? "";
    const start = seconds(left ?? "");
    const end = seconds(right);
    if (start === undefined || end === undefined) return { problem: `${name} has a time Uncut can't read at line ${t.n}: "${t.line.trim().slice(0, 60)}".` };
    const cueTextLines = block.slice(timing + 1).map((b) => b.line);
    const content = plainCue(cueTextLines);
    if (!content || end <= start) {
      skipped++;
      continue;
    }
    cues.push({ start, end, text: content });
    if (cues.length > MAX_SUBTITLE_CUES) return { problem: `${name} has more than ${MAX_SUBTITLE_CUES} cues: Uncut reads at most that many.` };
  }
  if (!cues.length)
    return {
      problem: skipped
        ? `${name} has no cues with text and a time that ends after it starts.`
        : `${name} has no subtitle cues: it isn't a .srt or .vtt file Uncut can read.`,
    };
  cues.sort((a, b) => a.start - b.start);
  return { cues, format, skipped };
}

// ---- importing ----

export type ImportSubtitlesPlan =
  | { readonly ops: Array<Op>; readonly trackId: string; readonly cues: number; readonly clipped: number; readonly joined: number; readonly summary: string }
  | { readonly problem: string };

/** Text made safe for textHtml's markup (as captions do), keeping line breaks. */
const markupSafe = (text: string) => text.replace(/`/g, "'").replace(/\*\*+/g, "*").replace(/\[\[+/g, "[").replace(/\]\]+/g, "]");

/**
 * Subtitles read from a file as plain text items on a new "Subtitles" text track on top (one item
 * per cue, at its timeline frames: cue time is the edit's time). Cues past the end of the main
 * track are left out and one running past it is shortened (when the main track has clips; text
 * items would otherwise make the video longer). Overlapping cues can't share a track: an earlier
 * cue ends where the next starts, and cues starting on the same frame are joined into one. Each
 * sits with its last line where a caption's last line sits (the text.caption look). One edit.
 */
export function planImportSubtitles(
  project: Pick<Project, "canvas" | "theme" | "tracks" | "media">,
  cues: ReadonlyArray<ParsedCue>,
  name: string,
  taken: Set<string> = new Set(),
): ImportSubtitlesPlan {
  const fps = project.canvas.fps;
  const mainLength = mainEnd(project);
  const limit = mainLength > 0 ? mainLength : Infinity;
  let clipped = 0;
  let joined = 0;
  const frames: Array<{ from: number; to: number; text: string }> = [];
  for (const c of [...cues].sort((a, b) => a.start - b.start)) {
    const from = Math.round(c.start * fps);
    let to = Math.max(from + 1, Math.round(c.end * fps));
    if (from >= limit) {
      clipped++;
      continue;
    }
    if (to > limit) to = limit;
    const text = markupSafe(c.text);
    const last = frames.at(-1);
    if (last && from === last.from) {
      last.text = `${last.text}\n${text}`;
      last.to = Math.max(last.to, to);
      joined++;
      continue;
    }
    if (last && from < last.to) last.to = from;
    frames.push({ from, to, text });
  }
  if (!frames.length) return { problem: `Every cue in ${name} starts after the end of the edit (${(mainLength / fps).toFixed(1)} s).` };
  const ids = new Set([...taken, ...project.media.map((m) => m.id), ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)])]);
  const fresh = (base: string) => {
    for (let n = 1; ; n++) {
      const id = `${base}-${n}`;
      if (!ids.has(id)) {
        ids.add(id);
        taken.add(id);
        return id;
      }
    }
  };
  const trackId = fresh("subtitles-track");
  const existing = project.tracks.filter((t) => isSubtitleTrack(t)).length;
  const look = lookItem(TEXT_STYLES[CAPTION_DEFAULTS.look]!, project, 1);
  // Where a caption card's bottom sits, and one line's height: a cue of n lines ends on that bottom.
  const two = captionBox(project, { style: look.style as Item["style"], transform: look.transform });
  const one = captionBox(project, { style: look.style as Item["style"], transform: look.transform, lines: { maxLines: 1 } });
  const perLine = two.height - one.height;
  const pad = one.height - perLine;
  const ops: Array<Op> = [
    { op: "add_track", index: 0, track: { id: trackId, kind: "text", name: existing ? `Subtitles ${existing + 1}` : "Subtitles" } } as Op,
  ];
  for (const f of frames) {
    const n = f.text.split("\n").length;
    const y = Math.round(two.bottom - n * perLine - pad);
    const item: Item = {
      id: fresh("sub"),
      type: "text",
      start: f.from,
      duration: f.to - f.from,
      text: f.text,
      style: look.style as Item["style"],
      transform: { ...look.transform, y },
    };
    ops.push({ op: "insert_item", track: trackId, item });
  }
  return { ops, trackId, cues: frames.length, clipped, joined, summary: `Import subtitles ${name}` };
}
