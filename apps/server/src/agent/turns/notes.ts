import type { AgentTurn } from "@uncut/contracts";
import { manualEditsNote, type Project, speechItem, transcriptScope, type Session, undoTurn, TurnDependency, describeOp } from "@uncut/core";
import type { ProjectView } from "../../project/projects.ts";
import type { StoredTurn } from "../session/types.ts";

// ---- notes and undo states ----

/**
 * D6: what the user changed since the agent last looked. Item edits come from the log (core
 * manualEditsNote); undo, redo, reload and undone turns aren't log entries, so they're listed too.
 */
export function noteFor(view: ProjectView, since: number): string {
  // The log goes back to earlier openings (history.db); what happened then reached the note that
  // was carried over (pendingNote), so only this opening's edits count here.
  const base = manualEditsNote(view.session, Math.max(since, view.openRevision));
  const extra = view.unlogged.filter((u) => u.revision > since).map((u) => `- ${u.what}`);
  if (!extra.length) return base;
  if (!base) {
    return [
      `Since your last turn the user changed the project (now at revision ${view.session.revision}). Read it again before editing; keep what they did.`,
      ...extra,
    ].join("\n");
  }
  return [base, ...extra].join("\n");
}

/** A note carried over from an earlier opening, then the current one. */
export const joinNotes = (carried: string | undefined, current: string) =>
  [carried ? `Earlier, before the project was closed and reopened:\n${carried}` : "", current].filter(Boolean).join("\n\n");

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
export function speechOfItem(project: Project, itemId: unknown): { readonly media: string; readonly itemId: string; readonly request: { readonly items?: ReadonlyArray<string>; readonly clips?: ReadonlyArray<string> } } | { readonly problem: string } {
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

export function undoState(turn: StoredTurn, view: ProjectView | undefined, openId: number, validate: (project: Project) => ReadonlyArray<{ readonly message: string }>): UndoState {
  if (turn.status === "running" || turn.edits.length === 0) return { state: "none" };
  const logged = new Set(view && view.openId === openId ? view.session.log.filter((e) => e.turnId === turn.id).map((e) => e.revision) : []);
  if (!view || !logged.size) {
    if (turn.undoneAt) return { state: "undone" };
    return {
      state: "unavailable",
      reason: "Its edits aren't in the project's history any more: project.json was changed outside Uncut after it, an earlier version was restored from History, or they were undone with ⌘Z.",
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

/** D260 (issue #81): at most this many listed edits in a message's note. */
export const NOTE_LINES = 30;

/** A note with at most NOTE_LINES "- " lines; the rest counted, project_read has the result. */
export function capNote(note: string, max = NOTE_LINES): string {
  const lines = note.split("\n");
  let listed = 0;
  let dropped = 0;
  const out = lines.filter((l) => {
    if (!l.startsWith("- ")) return true;
    if (listed < max) return ++listed > 0;
    dropped++;
    return false;
  });
  if (dropped) out.push(`- and ${dropped} more edit${dropped === 1 ? "" : "s"} (project_read shows the project as it is now)`);
  return out.join("\n");
}
