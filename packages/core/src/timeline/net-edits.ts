// The user's edits since the agent last looked, as their net result (D6): the project the agent
// last saw against the project now, per item, track and media entry, with final values. Anything
// that was done and then undone, deleted or reverted nets to nothing and isn't listed.
import { applyEdit, EditError } from "./apply-ops.ts";
import { describeOp, itemLabel } from "./edit-log.ts";
import type { Id, Item, LogEntry, Media, Project, Session, Track } from "./types.ts";

/** Which log entries a note reports; the rest are the reader's own (today: the agent's). */
export type EntryFilter = (entry: LogEntry) => boolean;
export const byUser: EntryFilter = (e) => e.actor === "user";

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

/** The fields of `before` and `after` that differ, as an op's `set`: final values, null for a removed field. */
function changedFields(before: object, after: object, skip: ReadonlySet<string>): Record<string, unknown> {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!skip.has(k) && !same(a[k], b[k])) set[k] = b[k] ?? null;
  }
  return set;
}

const seconds = (frames: number, fps: number) => `${(frames / fps).toFixed(1)}s`;

/** "4.0s → 3.5s"; when that rounds to the same text, the frames say how much: "4.0s → 4.0s (−2 frames)". */
function framesChange(from: number, to: number, fps: number) {
  const text = `${seconds(from, fps)} → ${seconds(to, fps)}`;
  if (seconds(from, fps) !== seconds(to, fps)) return text;
  const d = to - from;
  return `${text} (${d > 0 ? "+" : "−"}${Math.abs(d)} frame${Math.abs(d) === 1 ? "" : "s"})`;
}

interface Placed {
  readonly track: Track;
  readonly item: Item;
}

const placedItems = (p: Project) => new Map(p.tracks.flatMap((track) => track.items.map((item) => [item.id, { track, item }] as const)));

const TIMING = new Set(["id", "type", "start", "duration", "in"]);

/** The fields of an added item the add line says (where and what it plays), or that only say what it is. */
const ADDED_SKIP = new Set(["id", "type", "start", "duration", "in", "media", "src", "component", "source", "words", "linkedTo"]);

/** Under an added item, a field it was given: an indented "  - " line, so the item counts as one change. */
export const SUB_LINE = "\n  - ";

/**
 * An added item as the edit log says it ("Added audio audio-1 on track audio"), with its name and
 * where it plays, then a SUB_LINE per field it was given (its text, style, position, volume,
 * fades, …) as the edit log words a change of that field. One change, one entry.
 */
function addedItem(after: Project, { track, item }: Placed): string {
  const fps = after.canvas.fps;
  const at = track.role === "main" ? `at position ${track.items.indexOf(item) + 1}` : `at ${seconds(item.start ?? 0, fps)}`;
  const label = itemLabel(after, item.id);
  const named = item.type === "text" || !label.endsWith(` (${item.id})`) ? "" : label.slice(0, -(item.id.length + 3));
  const name = named.startsWith(`${item.type} `) ? named.slice(item.type.length + 1) : named;
  const added = describeOp({ op: "insert_item", track: track.id, item }, after);
  const solid = item.type === "component" && item.component === "component.solid";
  const own = Object.fromEntries(Object.entries(item).filter(([k]) => !ADDED_SKIP.has(k) && !(solid && k === "props")));
  const head = `${added}${name && !added.includes(name) ? ` (${name})` : ""} ${at}, ${seconds(item.duration, fps)} long`;
  return [head, ...fieldLines(after, item, own)].join(SUB_LINE);
}

const CAPTION_FIELDS = new Set(["edits", "breaks", "mode", "lines", "hideFillers", "words", "coversMain"]);

/** Fields of an item in words, one line each as the edit log says them (a captions item's own fields together). */
function fieldLines(after: Project, item: Item, set: Record<string, unknown>): Array<string> {
  const keys = Object.keys(set);
  const captions = item.type === "captions" ? keys.filter((k) => CAPTION_FIELDS.has(k)) : [];
  const groups = [...(captions.length ? [captions] : []), ...keys.filter((k) => !captions.includes(k)).map((k) => [k])];
  return groups.map((g) => describeOp({ op: "update_item", item: item.id, set: Object.fromEntries(g.map((k) => [k, set[k]])) }, after));
}

function changedItem(after: Project, was: Placed, now: Placed): Array<string> {
  const fps = after.canvas.fps;
  const timing: Array<string> = [];
  if (was.track.id !== now.track.id) timing.push(`moved to track ${now.track.id}`);
  if (now.track.role !== "main" && (was.item.start ?? 0) !== (now.item.start ?? 0))
    timing.push(`start ${framesChange(was.item.start ?? 0, now.item.start ?? 0, fps)}`);
  if (was.item.duration !== now.item.duration) timing.push(`length ${framesChange(was.item.duration, now.item.duration, fps)}`);
  if ((was.item.in ?? 0) !== (now.item.in ?? 0)) timing.push(`source in ${framesChange(was.item.in ?? 0, now.item.in ?? 0, fps)}`);
  const lines = timing.length ? [`Changed ${itemLabel(after, now.item.id)}: ${timing.join(", ")}`] : [];
  const set = changedFields(was.item, now.item, TIMING);
  return [...lines, ...fieldLines(after, now.item, set)];
}

/** A track whose surviving items play in another order (a main track's reorder, which shifts every later start). */
function reordered(before: Track, after: Track) {
  const kept = new Set(before.items.map((i) => i.id));
  const was = before.items.map((i) => i.id).filter((id) => after.items.some((i) => i.id === id));
  const now = after.items.map((i) => i.id).filter((id) => kept.has(id));
  return !same(was, now);
}

function itemLines(before: Project, after: Project): Array<string> {
  const a = placedItems(before);
  const b = placedItems(after);
  const lines: Array<string> = [];
  for (const [id, now] of b) {
    const was = a.get(id);
    if (!was) lines.push(addedItem(after, now));
    else if (!same(was.item, now.item) || was.track.id !== now.track.id) lines.push(...changedItem(after, was, now));
  }
  for (const [id, was] of a) if (!b.has(id)) lines.push(`Removed ${itemLabel(before, id)} from track ${was.track.id}`);
  for (const track of after.tracks) {
    const old = before.tracks.find((t) => t.id === track.id);
    if (old && track.role === "main" && reordered(old, track)) lines.push(`Reordered track ${track.id}: ${track.items.map((i) => i.id).join(", ")}`);
  }
  return lines;
}

const TRACK_SKIP = new Set(["id", "items"]);

function trackLines(before: Project, after: Project): Array<string> {
  const lines: Array<string> = [];
  for (const track of after.tracks) {
    const old = before.tracks.find((t) => t.id === track.id);
    if (!old) {
      const { items: _, ...fields } = track;
      lines.push(describeOp({ op: "add_track", track: fields }, after));
      continue;
    }
    const set = changedFields(old, track, TRACK_SKIP);
    // One line per field, so a mute and a volume each read as themselves.
    for (const [k, v] of Object.entries(set)) lines.push(describeOp({ op: "update_track", track: track.id, set: { [k]: v } }, after));
  }
  for (const old of before.tracks) if (!after.tracks.some((t) => t.id === old.id)) lines.push(`Deleted track ${old.id}`);
  const order = (p: Project, keep: (id: Id) => boolean) => p.tracks.map((t) => t.id).filter(keep);
  const inBoth = (id: Id) => before.tracks.some((t) => t.id === id) && after.tracks.some((t) => t.id === id);
  if (!same(order(before, inBoth), order(after, inBoth))) lines.push(`Reordered the tracks: ${after.tracks.map((t) => t.id).join(", ")}`);
  return lines;
}

function mediaLines(before: Project, after: Project): Array<string> {
  const lines: Array<string> = [];
  const byId = (list: ReadonlyArray<Media>, id: Id) => list.find((m) => m.id === id);
  for (const m of after.media) {
    const old = byId(before.media, m.id);
    if (!old) lines.push(describeOp({ op: "add_media", media: m }, after));
    else {
      const set = changedFields(old, m, new Set(["id"]));
      if (Object.keys(set).length) lines.push(describeOp({ op: "update_media", media: m.id, set }, after));
    }
  }
  for (const m of before.media) if (!byId(after.media, m.id)) lines.push(describeOp({ op: "delete_media", media: m.id }, before));
  return lines;
}

const PROJECT_SKIP = new Set(["tracks", "media"]);

function projectLines(before: Project, after: Project): Array<string> {
  const set = changedFields(before, after, PROJECT_SKIP);
  return Object.entries(set).map(([k, v]) => describeOp({ op: "update_project", set: { [k]: v } }, after));
}

/** Every difference from `before` to `after`, in words, one entry each (no "- "; an added item's fields as SUB_LINEs). */
export function projectChanges(before: Project, after: Project): Array<string> {
  return [...projectLines(before, after), ...trackLines(before, after), ...mediaLines(before, after), ...itemLines(before, after)];
}

/**
 * The project as the reader of a note knows it: what it saw at `since`, plus its own edits after
 * that (the log entries `reported` doesn't accept), replayed in order. An own edit that no longer
 * applies to it (it built on an edit being reported) is left out.
 */
export function knownProject(before: Project, session: Session, since: number, reported: EntryFilter = byUser): Project {
  let s: Session = { project: before, revision: since, log: [] };
  for (const e of session.log) {
    if (e.revision <= since || reported(e)) continue;
    try {
      s = applyEdit(s, { ...e, baseRevision: s.revision });
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
    }
  }
  return s.project;
}

/** The net changes made by the entries `reported` accepts since `since`, `before` being the project at `since`. */
export function netChanges(before: Project, session: Session, since: number, reported: EntryFilter = byUser): Array<string> {
  return projectChanges(knownProject(before, session, since, reported), session.project);
}

/** Said when the user did things since the agent's last look that cancel out. */
export const netZeroNote = (revision: number) =>
  `The project is at revision ${revision} now. The user's changes since your last turn cancel out (the project is as you left it), but read it again before editing.`;

/**
 * The note the agent receives (D6) about the user's edits since `since`: their net result, with
 * final values. Empty when nothing was done; netZeroNote when what was done cancels out.
 */
export function netEditsNote(before: Project, session: Session, since: number, reported: EntryFilter = byUser): string {
  const lines = netChanges(before, session, since, reported);
  if (!lines.length) return session.log.some((e) => e.revision > since && reported(e)) ? netZeroNote(session.revision) : "";
  return [
    `The user changed ${lines.length} thing${lines.length === 1 ? "" : "s"} by hand since your last turn (now at revision ${session.revision}). This is the net result: anything they did and then undid or reverted isn't listed.`,
    "They are intentional. Keep them, build on them, and don't undo or question them unless the user asks.",
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
}
