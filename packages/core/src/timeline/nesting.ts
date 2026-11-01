// Nested sequences: a "sequence" item on Main plays frames of another timeline of the project.
// Nothing that draws or mixes knows about them: flattenSequences turns a project into one without
// them (same frames, same picture, same sound), and the preview, the export and render_frames work
// on that. A project without sequences comes back as the very same object. Browser-safe.
import { gapOf, resolveStarts, projectDuration } from "./rules.ts";
import { sliceProject } from "./slice.ts";
import type { Id, Item, Problem, Project, Sequence, Track } from "./types.ts";

/** What a sequence item may carry: anything else would need the nested picture as one layer. */
const SEQUENCE_FIELDS = new Set(["id", "type", "name", "sequence", "in", "duration", "gap", "locked", "group"]);

const SEPARATOR = "--";
const inner = (owner: Id, id: Id) => `${owner}${SEPARATOR}${id}`;

/** The project as a sequence's own timeline: the same media and canvas, its tracks. */
function asTimeline({ scenes: _s, markers: _m, sections: _l, ...project }: Project, sequence: Pick<Sequence, "tracks">): Project {
  return { ...project, tracks: sequence.tracks };
}

/** How long a sequence plays. */
export const sequenceLength = (project: Project, sequence: Sequence) => projectDuration(asTimeline(project, sequence));

/** The items of `project` and all its sequences that are a sequence item, with where they are. */
const sequenceItems = (tracks: ReadonlyArray<Track>) => tracks.flatMap((t) => t.items.filter((i) => i.type === "sequence").map((item) => ({ item, track: t })));

function withInnerIds(item: Item, owner: Id, start?: number): Item {
  return {
    ...item,
    id: inner(owner, item.id),
    ...(item.linkedTo ? { linkedTo: inner(owner, item.linkedTo) } : {}),
    ...(item.group ? { group: inner(owner, item.group) } : {}),
    ...(start !== undefined ? { start } : {}),
  };
}

/** The frames a sequence item plays, as a flat project starting at 0; undefined when there's nothing to play. */
function instance(project: Project, item: Item, through: ReadonlySet<Id>): Project | undefined {
  const sequence = project.sequences?.find((s) => s.id === item.sequence);
  if (!sequence || through.has(sequence.id)) return undefined;
  const from = item.in ?? 0;
  const flat = flattenSequences(asTimeline(project, sequence), new Set([...through, sequence.id]));
  const sliced = sliceProject(flat, { from, to: from + item.duration });
  return "problem" in sliced ? undefined : sliced;
}

/** What a sequence item plays through every level, with each clip's file, in a form two versions can be compared in. */
export function sequenceContent(project: Project, item: Item): string {
  const played = instance(project, item, new Set());
  const fileOf = (id: Id | undefined) => project.media.find((m) => m.id === id)?.path;
  return JSON.stringify(played?.tracks.map((t) => ({ ...t, items: t.items.map((i) => ({ ...i, file: fileOf(i.media) })) })));
}

/** The project with every sequence item played out on the timeline: its main items in Main's place, its other tracks next to Main. */
export function flattenSequences(project: Project, through: ReadonlySet<Id> = new Set()): Project {
  if (project.sequences === undefined) return project;
  const { sequences: _gone, ...rest } = project;
  const main = project.tracks.find((t) => t.role === "main");
  if (!main?.items.some((i) => i.type === "sequence")) return rest;
  const starts = resolveStarts(project);
  const items: Array<Item> = [];
  const above: Array<Track> = [];
  const below: Array<Track> = [];
  let owed = 0;
  for (const item of main.items) {
    if (item.type !== "sequence") {
      items.push({ ...item, ...(gapOf(item) + owed ? { gap: gapOf(item) + owed } : {}) });
      owed = 0;
      continue;
    }
    owed += gapOf(item);
    const played = instance(project, item, through);
    const nested = played?.tracks.find((t) => t.role === "main");
    let end = 0;
    const nestedStarts = played ? resolveStarts(played) : new Map<Id, number>();
    for (const child of nested?.items ?? []) {
      const start = nestedStarts.get(child.id)!;
      const gap = start - end + owed;
      const { gap: _gap, ...flat } = withInnerIds(child, item.id);
      items.push({ ...flat, ...(gap ? { gap } : {}) });
      end = start + child.duration;
      owed = 0;
    }
    owed += item.duration - end;
    const at = starts.get(item.id)!;
    const index = played?.tracks.findIndex((t) => t.role === "main") ?? 0;
    played?.tracks.forEach((track, i) => {
      if (track.role === "main") return;
      const flat = { ...track, id: inner(item.id, track.id), items: track.items.map((c) => withInnerIds(c, item.id, (c.start ?? 0) + at)) };
      (i < index ? above : below).push(flat);
    });
  }
  const tracks = project.tracks.flatMap((t) => (t.role === "main" ? [...above, { ...t, items }, ...below] : [t]));
  return { ...rest, tracks };
}

function reachesItself(project: Project, id: Id, seen: ReadonlySet<Id> = new Set()): boolean {
  if (seen.has(id)) return true;
  const sequence = project.sequences?.find((s) => s.id === id);
  if (!sequence) return false;
  return sequenceItems(sequence.tracks).some(({ item }) => reachesItself(project, item.sequence!, new Set([...seen, id])));
}

function itemProblems(project: Project, track: Track, item: Item, path: string): Array<Problem> {
  const sequence = project.sequences?.find((s) => s.id === item.sequence);
  const out: Array<Problem> = [];
  if (track.role !== "main") return out;
  const extra = Object.keys(item).filter((k) => !SEQUENCE_FIELDS.has(k));
  if (extra.length)
    out.push({ code: "sequence-field", path, message: `a sequence item can't have ${extra.join(", ")}: put it on the items in the sequence (edit_sequence)` });
  if (!sequence) return [...out, { code: "unknown-sequence", path, message: `sequence "${item.sequence}" does not exist` }];
  const length = sequenceLength(project, sequence);
  const used = (item.in ?? 0) + item.duration;
  if (used > length)
    out.push({ code: "sequence-range", path, message: `uses frames up to ${used} but "${sequence.id}" is ${length} long: trim "${item.id}" in the same edit` });
  const index = track.items.indexOf(item);
  if (item.transitionIn || track.items[index + 1]?.transitionIn)
    out.push({
      code: "sequence-transition",
      path,
      message: `a transition can't touch the sequence item "${item.id}": clear it, or put it inside the sequence`,
    });
  return out;
}

const refer = (problem: Problem, sequence: Id): Problem => ({ ...problem, path: `/sequences/${sequence}${problem.path}` });

/** What the timeline rules can't say about sequences. `check` validates a sequence's own timeline as a project. */
export function sequenceProblems(project: Project, check: (timeline: Project) => ReadonlyArray<Problem>): Array<Problem> {
  const out: Array<Problem> = [];
  const taken = new Set(project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]));
  for (const { item, track } of sequenceItems(project.tracks)) out.push(...itemProblems(project, track, item, `/tracks/${track.id}/items/${item.id}`));
  for (const sequence of project.sequences ?? []) {
    const path = `/sequences/${sequence.id}`;
    if (reachesItself(project, sequence.id)) {
      out.push({ code: "sequence-cycle", path, message: `"${sequence.id}" plays itself through a sequence item` });
      continue;
    }
    for (const id of sequence.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)])) {
      if (taken.has(id)) out.push({ code: "duplicate-id", path, message: `id "${id}" is used more than once` });
      taken.add(id);
    }
    out.push(...check(asTimeline(project, sequence)).map((p) => refer(p, sequence.id)));
    for (const { item, track } of sequenceItems(sequence.tracks))
      out.push(...itemProblems(project, track, item, `${path}/tracks/${track.id}/items/${item.id}`));
  }
  return out;
}

/** Whether nothing but its main items would be lost by putting a sequence back on Main: its whole length, one use. */
export function canUnnest(project: Project, item: Item): boolean {
  const sequence = project.sequences?.find((s) => s.id === item.sequence);
  if (!sequence) return false;
  const uses = [...project.tracks, ...(project.sequences ?? []).flatMap((s) => s.tracks)].flatMap((t) => t.items).filter((i) => i.sequence === sequence.id);
  return uses.length === 1 && (item.in ?? 0) === 0 && item.duration === sequenceLength(project, sequence) && sequence.tracks.length === 1;
}

/** Plain text for the agent: each sequence, how long it is, what it holds. */
export function sequencesNote(project: Project): string {
  return (project.sequences ?? [])
    .map(
      (s) =>
        `${s.id} "${s.name}": ${sequenceLength(project, s)} frames, ${s.tracks.length} tracks, items ${s.tracks.flatMap((t) => t.items.map((i) => i.id)).join(", ")}`,
    )
    .join("\n");
}
