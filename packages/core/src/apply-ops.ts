// Reference engine for edit ops: applies them atomically, records who made
// them, and refuses an agent edit that would overwrite newer user edits (D6).
import type { Edit, FieldSet, Id, Item, LogEntry, Mutable, Op, Problem, Project, Session, Track } from "./types.ts";

type Draft = Mutable<Project>;
type DraftTrack = Mutable<Track>;
type DraftItem = Mutable<Item>;

export class EditError extends Error {
  details: ReadonlyArray<unknown>;
  constructor(message: string, details: ReadonlyArray<unknown> = []) {
    super(message);
    this.name = "EditError";
    this.details = details;
  }
}

export class EditConflict extends EditError {
  constructor(touched: ReadonlyArray<string>) {
    super(`Conflicts with newer edits to: ${touched.join(", ")}`, touched);
    this.name = "EditConflict";
  }
}

export function createSession(project: Project): Session {
  return { project: structuredClone(project), revision: 0, log: [] };
}

/** What an op touches, for conflict checks. */
function touches(op: Op): Array<string> {
  if (op.op === "insert_item") return [op.item.id];
  if ("item" in op && op.item) return [op.item];
  if (op.op === "add_track") return [`track:${op.track.id}`];
  if ("track" in op && op.track) return [`track:${op.track}`];
  if (op.op === "add_media") return [`media:${op.media.id}`];
  return ["project"];
}

function locate(project: Draft, itemId: Id): { track: DraftTrack; index: number; item: DraftItem } {
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === itemId);
    if (index !== -1) return { track, index, item: track.items[index]! };
  }
  throw new EditError(`Item "${itemId}" does not exist`);
}

function findTrack(project: Draft, trackId: Id): DraftTrack {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError(`Track "${trackId}" does not exist`);
  return track;
}

// Keys that would reach an object's prototype instead of setting a field. Ops come from
// clients and the agent, so they are refused rather than trusted.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function merge(target: object, set: FieldSet) {
  const fields = target as Record<string, unknown>;
  for (const k of Object.keys(set)) {
    if (UNSAFE_KEYS.has(k)) throw new EditError(`"${k}" can't be set`);
  }
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete fields[k];
    else fields[k] = v;
  }
}

function applyOp(project: Draft, op: Op) {
  switch (op.op) {
    case "insert_item": {
      const track = findTrack(project, op.track);
      const item = structuredClone(op.item) as DraftItem;
      if (track.role === "main") track.items.splice(op.index ?? track.items.length, 0, item);
      else track.items.push(item);
      return;
    }
    case "update_item":
      merge(locate(project, op.item).item, op.set);
      return;
    case "trim_item": {
      const { item } = locate(project, op.item);
      if (item.duration - op.frames < 1) throw new EditError(`Trimming ${op.frames} frames would leave "${item.id}" empty`);
      item.duration -= op.frames;
      if (op.edge === "start") {
        if ("in" in item || item.media) item.in = (item.in ?? 0) + op.frames;
        if (item.start !== undefined) item.start += op.frames;
        if (item.in! < 0) throw new EditError(`"${item.id}" can't extend before the start of its media`);
      }
      return;
    }
    case "split_item": {
      const { track, index, item } = locate(project, op.item);
      if (op.at >= item.duration) throw new EditError(`Split point ${op.at} is outside "${item.id}"`);
      const second = structuredClone(item);
      second.id = op.newId;
      second.duration = item.duration - op.at;
      if (item.media || "in" in item) second.in = (item.in ?? 0) + op.at;
      if (item.start !== undefined) second.start = item.start + op.at;
      delete second.transitionIn;
      item.duration = op.at;
      track.items.splice(index + 1, 0, second);
      return;
    }
    case "move_item": {
      const { track, index, item } = locate(project, op.item);
      const target = op.track ? findTrack(project, op.track) : track;
      track.items.splice(index, 1);
      if (target.role === "main") {
        delete item.start;
        target.items.splice(op.index ?? target.items.length, 0, item);
      } else {
        if (op.start !== undefined) item.start = op.start;
        if (item.start === undefined) throw new EditError(`Moving "${item.id}" to a free track needs a start`);
        delete item.transitionIn;
        target.items.push(item);
      }
      return;
    }
    case "delete_item": {
      const { track, index } = locate(project, op.item);
      track.items.splice(index, 1);
      return;
    }
    case "set_transition": {
      const { item } = locate(project, op.item);
      if (op.transition === null) delete item.transitionIn;
      else item.transitionIn = structuredClone(op.transition) as DraftItem["transitionIn"];
      return;
    }
    case "add_track":
      project.tracks.splice(op.index ?? project.tracks.length, 0, { items: [], ...(structuredClone(op.track) as Partial<DraftTrack>) } as DraftTrack);
      return;
    case "update_track":
      merge(findTrack(project, op.track), op.set);
      return;
    case "delete_track":
      findTrack(project, op.track);
      project.tracks = project.tracks.filter((t) => t.id !== op.track);
      return;
    case "add_media":
      project.media.push(structuredClone(op.media) as Draft["media"][number]);
      return;
    case "update_project":
      merge(project, structuredClone(op.set));
      return;
    default:
      throw new EditError(`Unknown op "${(op as { op: unknown }).op}"`);
  }
}

/**
 * Apply one edit (a list of ops) atomically. Returns a new session; the old one is untouched.
 * baseRevision is the revision the actor last saw. If the agent's ops touch something the
 * user changed after that, the whole edit is refused with EditConflict.
 */
export function applyEdit(session: Session, { actor, ops, baseRevision = session.revision, turnId, summary, at }: Edit, validate?: (project: Project) => ReadonlyArray<Problem>): Session {
  if (!["user", "agent"].includes(actor)) throw new EditError(`Unknown actor "${actor}"`);
  if (baseRevision < session.revision) {
    const mine = new Set(ops.flatMap(touches));
    const newer = session.log.filter((e) => e.revision > baseRevision && e.actor !== actor).flatMap((e) => e.ops.flatMap(touches));
    const clash = [...new Set(newer.filter((id) => mine.has(id)))];
    if (clash.length) throw new EditConflict(clash);
  }
  const project = structuredClone(session.project) as Draft;
  for (const op of ops) applyOp(project, op);
  if (validate) {
    const errors = validate(project);
    if (errors.length) throw new EditError("The edit would make the project invalid", errors);
  }
  const revision = session.revision + 1;
  const entry: Mutable<LogEntry> = { revision, at: at ?? new Date().toISOString(), actor, ops: structuredClone(ops) as Array<Mutable<Op>> };
  if (turnId) entry.turnId = turnId;
  if (summary) entry.summary = summary;
  return { project, revision, log: [...session.log, entry] };
}

/** A later edit can't be replayed without the turn being undone: it builds on that turn. */
export class TurnDependency extends EditError {
  readonly entry: LogEntry;
  constructor(entry: LogEntry, cause: EditError) {
    super(`A later edit builds on this turn${entry.summary ? ` ("${entry.summary}")` : ""}: ${cause.message}`, [entry.revision]);
    this.name = "TurnDependency";
    this.entry = entry;
  }
}

/**
 * Undo one agent turn (D7): rebuild from the project the log starts at, skipping that turn's
 * entries, so later edits by anyone survive. Revisions don't go back: the kept entries keep
 * theirs and the result is one revision past `session` (a revision the agent read before the
 * undo still means what it meant). Throws TurnDependency when a later edit needs the turn
 * (e.g. it trims an item the turn added), and EditError when the turn has nothing in the log.
 */
export function undoTurn(initialProject: Project, session: Session, turnId: string, validate?: (project: Project) => ReadonlyArray<Problem>): Session {
  if (!session.log.some((e) => e.turnId === turnId)) throw new EditError(`Turn "${turnId}" has no edits in this session`);
  let s = createSession(initialProject);
  const kept: Array<LogEntry> = [];
  for (const e of session.log) {
    if (e.turnId === turnId) continue;
    try {
      s = applyEdit(s, { ...e, baseRevision: s.revision }, validate);
    } catch (error) {
      if (error instanceof EditError) throw new TurnDependency(e, error);
      throw error;
    }
    kept.push(e);
  }
  return { project: s.project, revision: session.revision + 1, log: kept };
}
