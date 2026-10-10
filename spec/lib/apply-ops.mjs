// Reference engine for edit ops: applies them atomically, records who made
// them, and refuses an agent edit that would overwrite newer user edits (D6).

export class EditError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "EditError";
    this.details = details;
  }
}

export class EditConflict extends EditError {
  constructor(touched) {
    super(`Conflicts with newer edits to: ${touched.join(", ")}`, touched);
    this.name = "EditConflict";
  }
}

export function createSession(project) {
  return { project: structuredClone(project), revision: 0, log: [] };
}

/** What an op touches, for conflict checks. */
function touches(op) {
  if (op.op === "insert_item") return [op.item.id];
  if (op.item) return [op.item];
  if (op.op === "add_track") return [`track:${op.track.id}`];
  if (op.track) return [`track:${op.track}`];
  if (op.op === "add_media") return [`media:${op.media.id}`];
  return ["project"];
}

function locate(project, itemId) {
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === itemId);
    if (index !== -1) return { track, index, item: track.items[index] };
  }
  throw new EditError(`Item "${itemId}" does not exist`);
}

function findTrack(project, trackId) {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError(`Track "${trackId}" does not exist`);
  return track;
}

function merge(target, set) {
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete target[k];
    else target[k] = v;
  }
}

function applyOp(project, op) {
  switch (op.op) {
    case "insert_item": {
      const track = findTrack(project, op.track);
      const item = structuredClone(op.item);
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
        if (item.in < 0) throw new EditError(`"${item.id}" can't extend before the start of its media`);
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
      else item.transitionIn = structuredClone(op.transition);
      return;
    }
    case "add_track":
      project.tracks.splice(op.index ?? project.tracks.length, 0, { items: [], ...structuredClone(op.track) });
      return;
    case "update_track":
      merge(findTrack(project, op.track), op.set);
      return;
    case "delete_track":
      findTrack(project, op.track);
      project.tracks = project.tracks.filter((t) => t.id !== op.track);
      return;
    case "add_media":
      project.media.push(structuredClone(op.media));
      return;
    case "update_project":
      merge(project, structuredClone(op.set));
      return;
    default:
      throw new EditError(`Unknown op "${op.op}"`);
  }
}

/**
 * Apply one edit (a list of ops) atomically. Returns a new session; the old one is untouched.
 * baseRevision is the revision the actor last saw. If the agent's ops touch something the
 * user changed after that, the whole edit is refused with EditConflict.
 */
export function applyEdit(session, { actor, ops, baseRevision = session.revision, turnId, summary, at }, validate) {
  if (!["user", "agent"].includes(actor)) throw new EditError(`Unknown actor "${actor}"`);
  if (baseRevision < session.revision) {
    const mine = new Set(ops.flatMap(touches));
    const newer = session.log.filter((e) => e.revision > baseRevision && e.actor !== actor).flatMap((e) => e.ops.flatMap(touches));
    const clash = [...new Set(newer.filter((id) => mine.has(id)))];
    if (clash.length) throw new EditConflict(clash);
  }
  const project = structuredClone(session.project);
  for (const op of ops) applyOp(project, op);
  if (validate) {
    const errors = validate(project);
    if (errors.length) throw new EditError("The edit would make the project invalid", errors);
  }
  const revision = session.revision + 1;
  const entry = { revision, at: at ?? new Date().toISOString(), actor, ops: structuredClone(ops) };
  if (turnId) entry.turnId = turnId;
  if (summary) entry.summary = summary;
  return { project, revision, log: [...session.log, entry] };
}

/** Undo one agent turn (D7): rebuild from the start, skipping that turn's entries. */
export function undoTurn(initialProject, session, turnId) {
  let s = createSession(initialProject);
  for (const e of session.log) {
    if (e.turnId === turnId) continue;
    s = applyEdit(s, { ...e, baseRevision: s.revision });
  }
  return s;
}
