// Locked items and tracks, as the agent's edits see them. The op guards in apply-ops.ts stop an op
// aimed at a locked thing; agentLockProblem compares the project before and after a whole edit, so a
// ripple, a relink or a transition next door can't reach it either. Only the user unlocks, and only
// the agent is held to this. Browser-safe.
import { resolveStarts } from "./rules.ts";
import type { Item, Problem, Project, Track } from "./types.ts";

const ASK = "leave it as it is, or ask the user to unlock it";

const problem = (path: string, message: string): Problem => ({ code: "locked", path, message });

/** A refusal for an op aimed at a locked track or item. */
export const lockedTrackProblem = (track: Pick<Track, "id" | "name">): Problem =>
  problem(`/tracks/${track.id}`, `the track "${track.name ?? track.id}" is locked: ${ASK}`);
export const lockedItemProblem = (track: Pick<Track, "id">, item: Pick<Item, "id">): Problem =>
  problem(`/tracks/${track.id}/items/${item.id}`, `"${item.id}" is locked: ${ASK}`);

/** The locked items of a project (their own lock, or their track's), with their tracks. */
function lockedItems(project: Project) {
  return project.tracks.flatMap((track) => track.items.filter((item) => track.locked || item.locked).map((item) => ({ track, item })));
}

function find(project: Project, itemId: string) {
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === itemId);
    if (index !== -1) return { track, index, item: track.items[index]! };
  }
  return undefined;
}

/** An item as it plays: where it sits on the timeline is compared apart, in frames, so its `gap` may give way. */
const content = ({ gap: _gap, start: _start, locked: _locked, ...rest }: Item) => JSON.stringify(rest);

const trackFields = ({ items: _items, ...rest }: Track) => JSON.stringify(rest);

function trackProblem(before: Track, after: Project): Problem | undefined {
  const now = after.tracks.find((t) => t.id === before.id);
  if (!now) return lockedTrackProblem(before);
  if (!now.locked) return problem(`/tracks/${before.id}`, `only the user can unlock the track "${before.name}"; ask them to`);
  if (trackFields(before) !== trackFields(now)) return lockedTrackProblem(before);
  return undefined;
}

/** The transition into the item after a locked main clip plays over that clip's last frames. */
const nextTransition = (track: Track, index: number) => (track.role === "main" ? JSON.stringify(track.items[index + 1]?.transitionIn) : undefined);

function itemProblem(before: Project, after: Project, track: Track, item: Item, startsBefore: Map<string, number>, startsAfter: Map<string, number>) {
  const path = `/tracks/${track.id}/items/${item.id}`;
  const was = find(before, item.id)!;
  const now = find(after, item.id);
  if (!now || now.track.id !== track.id) return lockedItemProblem(track, item);
  if (item.locked && !now.item.locked) return problem(path, `only the user can unlock "${item.id}"; ask them to`);
  if (content(item) !== content(now.item)) return lockedItemProblem(track, item);
  const from = startsBefore.get(item.id);
  const to = startsAfter.get(item.id);
  if (from !== to)
    return problem(
      path,
      `"${item.id}" is locked, and this edit would move it from frame ${from} to ${to} (a ripple before it): keep it where it is by giving the item after the cut a gap, use replace_range, or ask the user to unlock it`,
    );
  const media = item.media ? before.media.find((m) => m.id === item.media) : undefined;
  if (media && media.path !== after.media.find((m) => m.id === media.id)?.path)
    return problem(`/media/${media.id}`, `"${item.id}" is locked and plays "${media.id}": relink it only if the user unlocks the clip`);
  if (nextTransition(was.track, was.index) !== nextTransition(now.track, now.index))
    return problem(path, `"${item.id}" is locked, and the transition after it plays over its end: ${ASK}`);
  return undefined;
}

/** The problem when the agent's edit changes, moves or unlocks something locked, else undefined. */
export function agentLockProblem(before: Project, after: Project): Problem | undefined {
  for (const track of before.tracks) {
    const found = track.locked ? trackProblem(track, after) : undefined;
    if (found) return found;
  }
  const locked = lockedItems(before);
  if (!locked.length) return undefined;
  const startsBefore = resolveStarts(before);
  const startsAfter = resolveStarts(after);
  for (const { track, item } of locked) {
    const found = itemProblem(before, after, track, item, startsBefore, startsAfter);
    if (found) return found;
  }
  return undefined;
}

/** What is locked, for the agent, one line (empty when nothing is). */
export function locksNote(project: Project): string {
  const tracks = project.tracks.filter((t) => t.locked).map((t) => `track ${t.id}`);
  const items = project.tracks.flatMap((t) => (t.locked ? [] : t.items.filter((i) => i.locked).map((i) => i.id)));
  return [...tracks, ...items].join(", ");
}
