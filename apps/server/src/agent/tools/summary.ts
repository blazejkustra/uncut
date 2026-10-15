// project_read's project summary, and edit_captions' expansion.
import { type Project, subtitleCues, layout, mixNote, type Item, captionCardList, applyEdit, createSession, type Op, planCaptionEdit } from "@uncut/core";
import { creditsText, creditsOf } from "@uncut/core/library";

/** D105: project_read's line about subtitles (cues from captions and Subtitles tracks), or undefined. */
function subtitleNote(project: Project): string | undefined {
  const n = subtitleCues(project).length;
  return n ? `${n} subtitle cue${n === 1 ? "" : "s"} (captions cards and Subtitles tracks): subtitles_export writes them as .srt or .vtt.` : undefined;
}

/**
 * project_read's summary: tracks with every item (main-track items get their resolved start),
 * the media with its probe, the length, and the revision to pass back as baseRevision.
 */
export function projectSummary(project: Project, revision: number, range?: { start: number; end: number }) {
  const { starts, duration } = layout(project);
  const end = project.tracks.some((t) => t.items.length) ? duration : 0;
  const fps = project.canvas.fps;
  const inRange = (id: string, length: number) => {
    const start = starts.get(id) ?? 0;
    return !range || (start < range.end && start + length > range.start);
  };
  return {
    revision,
    name: project.name,
    canvas: project.canvas,
    duration: end,
    seconds: Number((end / fps).toFixed(2)),
    media: project.media.map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      ...(m.probe ? { probe: m.probe } : {}),
      ...(m.probe?.frames ? { seconds: Number((m.probe.frames / fps).toFixed(2)) } : {}),
    })),
    tracks: project.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      ...(t.role ? { role: t.role } : {}),
      ...(t.name ? { name: t.name } : {}),
      ...(t.hidden ? { hidden: true } : {}),
      // The mix (D83): volume, pan, mute, solo.
      ...(t.mixer ? { mixer: t.mixer } : {}),
      items: t.items.filter((it) => inRange(it.id, it.duration)).map((it) => (it.type === "captions" ? captionsSummary(project, it, starts.get(it.id) ?? 0, range) : { ...it, start: starts.get(it.id), ...mediaNameOf(project, it) })),
    })),
    ...(project.master ? { master: project.master } : {}),
    // What solo, mutes and the master leave audible, when it needs saying (D83).
    ...(mixNote(project) ? { mixNote: mixNote(project) } : {}),
    // D105: what a subtitles file would hold, when there's anything.
    ...(subtitleNote(project) ? { subtitles: subtitleNote(project) } : {}),
    // D135: the library sounds' credits (CC BY ones need them in the video's description).
    ...(creditsText(project) ? { credits: creditsSummary(project) } : {}),
  };
}

/** project_read's credits (D135): who to credit (CC BY) and the CC0 sounds, plus the text to paste. */
function creditsSummary(project: Project) {
  const c = creditsOf(project);
  const line = (x: (typeof c.attribution)[number]) => ({ title: x.title, creator: x.creator, license: x.license === "by" ? `CC BY ${x.licenseVersion}` : "CC0", url: x.landingUrl });
  return { needAttribution: c.attribution.map(line), publicDomain: c.publicDomain.map(line), text: creditsText(project) };
}

/** G4: the display name of an item's media (renamed in the Media panel), next to its id. */
const mediaNameOf = (project: Project, item: Item) => {
  const name = item.media ? project.media.find((m) => m.id === item.media)?.name : undefined;
  return name ? { mediaName: name } : {};
};

/** At most this many caption cards in project_read and captions_make's answer (a range narrows them). */
export const MAX_CAPTION_CARDS = 40;

/**
 * A captions item (D82) as project_read shows it: the word snapshot as a count (it can be thousands
 * of words; transcript_read has them), and its cards in frames of the edit with their word ids.
 */
export function captionsSummary(project: Project, item: Item, start: number, range?: { start: number; end: number }) {
  const { words, ...rest } = item;
  const all = captionCardList(project, item).filter((c) => !range || (c.from < range.end && c.to > range.start));
  return {
    ...rest,
    start,
    words: words?.length ?? 0,
    cards: all.slice(0, MAX_CAPTION_CARDS),
    ...(all.length > MAX_CAPTION_CARDS ? { moreCards: `${all.length - MAX_CAPTION_CARDS} more cards: pass range to see them.` } : {}),
  };
}

const EDIT_CAPTIONS_KEYS = new Set(["op", "item", "words", "breaks", "mode", "lines", "hideFillers", "cover"]);

/**
 * timeline_edit's ops with each edit_captions (D82) turned into the update_item core
 * planCaptionEdit makes (corrections and card starts merged into the item's), planned against the
 * project as the ops before it leave it. Other ops pass through.
 */
export function expandCaptionEdits(project: Project, ops: ReadonlyArray<unknown>): { ops: Array<unknown> } | { problem: string } {
  if (!ops.some((op) => (op as { op?: unknown })?.op === "edit_captions")) return { ops: [...ops] };
  const out: Array<unknown> = [];
  const word = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : typeof value === "string" && /^w?\d+$/.test(value) ? Number(value.replace(/^w/, "")) : undefined);
  for (const [i, raw] of ops.entries()) {
    const op = raw as Record<string, unknown>;
    if (op?.op !== "edit_captions") {
      out.push(raw);
      continue;
    }
    const where = `ops[${i}] (edit_captions)`;
    const extra = Object.keys(op).filter((k) => !EDIT_CAPTIONS_KEYS.has(k));
    if (extra.length) return { problem: `${where}: unknown field ${extra.join(", ")}.` };
    if (typeof op.item !== "string") return { problem: `${where}: item must be the captions item's id.` };
    const words: Array<{ index: number; text: string | null }> = [];
    if (op.words !== undefined) {
      if (!Array.isArray(op.words) || !op.words.length) return { problem: `${where}: words must be a list like [{"word":"w12","text":"Argent"}].` };
      for (const w of op.words as ReadonlyArray<{ word?: unknown; text?: unknown }>) {
        const index = word(w?.word);
        if (index === undefined || !(typeof w.text === "string" || w.text === null)) return { problem: `${where}: each words entry needs word ("w12") and text (a string, "" to hide it, null for the transcript's); got ${JSON.stringify(w)}.` };
        words.push({ index, text: w.text as string | null });
      }
    }
    const breaks: Array<{ index: number; on: boolean }> = [];
    if (op.breaks !== undefined) {
      if (!Array.isArray(op.breaks) || !op.breaks.length) return { problem: `${where}: breaks must be a list like [{"word":"w20"}].` };
      for (const b of op.breaks as ReadonlyArray<{ word?: unknown; on?: unknown }>) {
        const index = word(b?.word);
        if (index === undefined || (b.on !== undefined && typeof b.on !== "boolean")) return { problem: `${where}: each breaks entry needs word ("w20") and optionally on (true or false); got ${JSON.stringify(b)}.` };
        breaks.push({ index, on: b.on !== false });
      }
    }
    if (op.lines !== undefined && (typeof op.lines !== "object" || op.lines === null || Array.isArray(op.lines))) return { problem: `${where}: lines must be an object (maxChars, maxLines, maxSeconds, maxWords, pause).` };
    if (op.hideFillers !== undefined && typeof op.hideFillers !== "boolean") return { problem: `${where}: hideFillers must be true or false.` };
    let now: Project = project;
    try {
      if (out.length) now = applyEdit(createSession(project), { actor: "agent", ops: out as ReadonlyArray<Op> }).project;
    } catch {}
    const plan = planCaptionEdit(now, op.item, {
      ...(words.length ? { words } : {}),
      ...(breaks.length ? { breaks } : {}),
      ...(op.mode !== undefined ? { mode: op.mode as "line" } : {}),
      ...(op.lines !== undefined ? { lines: op.lines as Record<string, number> } : {}),
      ...(op.hideFillers !== undefined ? { hideFillers: op.hideFillers as boolean } : {}),
      ...(op.cover === true ? { cover: true } : {}),
    });
    if ("problem" in plan) return { problem: `${where}: ${plan.problem}` };
    out.push(...plan.ops);
  }
  return { ops: out };
}
