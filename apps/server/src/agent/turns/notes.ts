import type { AgentTurn } from "@uncut/contracts";
import {
  byUser,
  EditConflict,
  type LogEntry,
  manualEditsNote,
  netZeroNote,
  othersEditsNote,
  type Project,
  redoTurn,
  speechItem,
  transcriptScope,
  type Session,
  undoTurn,
  TurnDependency,
  describeOp,
} from "@uncut/core";
import type { ProjectView } from "../../project/projects.ts";
import { unloggedWords } from "../../project/projects/service.ts";
import type { StoredTurn } from "../session/types.ts";

// ---- notes and undo states ----

/** C12: the agent a note is for (its own edits aren't news) and the other agents' names. */
export interface Reader {
  readonly agentId: string;
  readonly nameOf: (agentId: string) => string;
}

/**
 * D6: what the user changed since the agent last looked, as the net result: the project the agent
 * saw at `since` (plus its own edits after it) against the project now (core netEditsNote). Undo
 * turn, a History jump and a reload get a line of their own too; ⌘Z and ⇧⌘Z only when they took
 * back or brought back the agent's edits. Without the state at `since` in the history, the log's
 * entries are listed as they are (manualEditsNote).
 */
export function noteFor(view: ProjectView, since: number, reader?: Reader): string {
  // The log goes back to earlier openings (history.db); what happened then reached the note that
  // was carried over (pendingNote), so only this opening's edits count here.
  const from = Math.max(since, view.openRevision);
  const before = view.stateAt(from);
  const reported = reader ? (e: LogEntry) => e.actor === "user" || (e.agentId !== undefined && e.agentId !== reader.agentId) : byUser;
  const agentName = (e: LogEntry) =>
    reader && e.actor === "agent" && e.agentId !== undefined && e.agentId !== reader.agentId ? reader.nameOf(e.agentId) : undefined;
  const base = before ? othersEditsNote(before, view.session, from, reported, agentName) : manualEditsNote(view.session, from, reported, agentName);
  const happened = view.unlogged.filter((u) => u.revision > since);
  const extra = happened.filter((u) => !u.quiet).map((u) => `- ${unloggedWords(u, reader)}`);
  const zero = netZeroNote(view.session.revision);
  if (!extra.length) return base || (happened.length ? zero : "");
  if (!base || base === zero) {
    return [
      `Since your last turn the user changed the project (now at revision ${view.session.revision}). Read it again before editing; keep what they did.`,
      ...extra,
    ].join("\n");
  }
  return [base, ...extra].join("\n");
}

/**
 * D6: whether noteFor(view, since) shows everything that changed: the net edits by item from the
 * state at `since`, with no change it can only name (an undo or redo of the agent's edits, Undo
 * turn, a History jump, a reload, an outside edit) and no fallback list of log entries. Only then
 * may the agent edit from the revision the note names without reading the project again.
 */
export const noteShowsAll = (view: ProjectView, since: number) =>
  view.stateAt(Math.max(since, view.openRevision)) !== undefined && !view.unlogged.some((u) => u.revision > since && !u.quiet && !u.unchanged);

/** A note carried over from an earlier opening, then the current one (left out when the carried note already ends with it: a second reopen with nothing done in between). */
export const joinNotes = (carried: string | undefined, current: string) =>
  [carried ? `Earlier, before the project was closed and reopened:\n${carried}` : "", carried && current && carried.endsWith(current) ? "" : current]
    .filter(Boolean)
    .join("\n\n");

type UndoState = AgentTurn["undo"];
// Sessions are immutable, so a dry run per (session, turn) is computed once.
/** D215: the media with speech heard through the main track (a main clip's own sound, or its linked microphone), in edit order. */
export function mediaHeardOnMain(project: Project): Array<string> {
  const out: Array<string> = [];
  for (const t of project.tracks) {
    if (t.role !== "main") continue;
    for (const i of t.items) {
      if (i.type !== "clip") continue;
      const speech = speechItem(project, i);
      const id = speech?.media ?? (project.media.find((m) => m.id === i.media && m.kind !== "image" && m.probe?.hasAudio !== false) ? i.media : undefined);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * D215: an `item` argument of transcript_read / transcript_edit / captions_make: the media its
 * speech is (its own sound, or its take's microphone) and how transcript_edit cuts it: that main
 * clip (on Main, or the main clip a sound is linked to), else its transcript scope's items.
 */
export function speechOfItem(
  project: Project,
  itemId: unknown,
):
  | { readonly media: string; readonly itemId: string; readonly request: { readonly items?: ReadonlyArray<string>; readonly clips?: ReadonlyArray<string> } }
  | { readonly problem: string } {
  if (typeof itemId !== "string") return { problem: "item must be an item id from project_read." };
  const at = project.tracks.flatMap((t) => t.items.map((i) => ({ item: i, track: t }))).find((x) => x.item.id === itemId);
  if (!at) return { problem: `There's no item "${itemId}". project_read lists the items on each track.` };
  const speech = speechItem(project, at.item);
  if (!speech?.media) return { problem: `${itemId} has no sound (and no linked or grouped sound), so there's no speech to read.` };
  const onMain = (id: string | undefined) => !!id && project.tracks.some((t) => t.role === "main" && t.items.some((i) => i.id === id));
  if (at.track.role === "main") return { media: speech.media, itemId, request: { clips: [itemId] } };
  if (onMain(at.item.linkedTo)) return { media: speech.media, itemId, request: { clips: [at.item.linkedTo!] } };
  if (onMain(speech.linkedTo)) return { media: speech.media, itemId, request: { clips: [speech.linkedTo!] } };
  const scope = transcriptScope(project, itemId);
  return { media: scope?.media ?? speech.media, itemId, request: { items: scope?.items ?? [speech.id] } };
}

const dryRuns = new WeakMap<Session, Map<string, UndoState>>();

export function undoState(
  turn: StoredTurn,
  view: ProjectView | undefined,
  openId: number,
  validate: (project: Project) => ReadonlyArray<{ readonly message: string }>,
): UndoState {
  if (turn.status === "running" || turn.edits.length === 0) return { state: "none" };
  const logged = new Set(view && view.openId === openId ? view.session.log.filter((e) => e.turnId === turn.id).map((e) => e.revision) : []);
  if (!view || !logged.size) {
    if (turn.undoneAt) return { state: "undone", ...(view && view.openId === openId ? redoState(turn.id, view, validate) : {}) };
    return {
      state: "unavailable",
      reason:
        "Its edits aren't in the project's history any more: project.json was changed outside Uncut after it, an earlier version was restored from History, or they were undone with ⌘Z.",
    };
  }
  // history.db keeps the last revisions only: a turn whose first edits are gone can't be taken back whole.
  if (!turn.edits.every((e) => logged.has(e.revision))) {
    return { state: "unavailable", reason: "Part of it is older than the history keeps, so it can't be undone as a whole any more." };
  }
  let cache = dryRuns.get(view.session);
  if (!cache) dryRuns.set(view.session, (cache = new Map()));
  const known = cache.get(turn.id);
  if (known) return known;
  let state: UndoState;
  try {
    // With validation, as the real undo does, so "available" means it will work.
    undoTurn(view.initial, view.session, turn.id, validate as Parameters<typeof undoTurn>[3]);
    state = { state: "available" };
  } catch (error) {
    const entry = error instanceof TurnDependency ? error.entry : undefined;
    const what = entry ? (entry.summary ?? (entry.ops[0] ? describeOp(entry.ops[0], view.session.project) : "a later edit")) : undefined;
    state = { state: "blocked", reason: what ? `A later edit builds on it: ${what}. Undo that first.` : String((error as Error).message) };
  }
  cache.set(turn.id, state);
  return state;
}

/** Whether an undone turn can be redone now (a dry run, as the real redo, cached per session); nothing when it wasn't undone in this opening. */
function redoState(
  turnId: string,
  view: ProjectView,
  validate: (project: Project) => ReadonlyArray<{ readonly message: string }>,
): Pick<UndoState, "redo" | "redoReason"> {
  const undone = view.undone.get(turnId);
  if (!undone) return {};
  let cache = redoRuns.get(view.session);
  if (!cache) redoRuns.set(view.session, (cache = new Map()));
  const known = cache.get(turnId);
  if (known) return known;
  let state: Pick<UndoState, "redo" | "redoReason">;
  try {
    redoTurn(view.session, undone.entries, undone.revision, validate as Parameters<typeof redoTurn>[3]);
    state = { redo: "available" };
  } catch (error) {
    const reason =
      error instanceof EditConflict ? `A later edit changed what it changed (${error.details.join(", ")}). Undo that first.` : String((error as Error).message);
    state = { redo: "blocked", redoReason: reason };
  }
  cache.set(turnId, state);
  return state;
}
const redoRuns = new WeakMap<Session, Map<string, Pick<UndoState, "redo" | "redoReason">>>();

/** D260 (issue #81): at most this many listed edits in a message's note. */
export const NOTE_LINES = 30;

/** A note with at most NOTE_LINES "- " lines; the rest counted, project_read has the result. */
export function capNote(note: string, max = NOTE_LINES): string {
  const lines = note.split("\n");
  let listed = 0;
  let dropped = 0;
  // An added item's "  - " field lines go with their item.
  let keeping = true;
  const out = lines.filter((l) => {
    if (l.startsWith("  - ")) return keeping;
    if (!l.startsWith("- ")) return true;
    keeping = listed < max;
    if (keeping) return ++listed > 0;
    dropped++;
    return false;
  });
  if (dropped) out.push(`- and ${dropped} more edit${dropped === 1 ? "" : "s"} (project_read shows the project as it is now)`);
  return out.join("\n");
}
