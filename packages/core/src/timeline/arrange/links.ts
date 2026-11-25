// Links (D347): clips and sounds with the same `link` are edited together by delta (linkFollow.ts).
// Old projects carry D123/D215's one-way `linkedTo` instead; it reads as a link with that clip here
// and is converted to `link` when the project opens (legacyLinkOps).
import { itemLabel } from "../edit-log.ts";
import { layout } from "../timeline.ts";
import type { Id, Item, Op, Project, Track } from "../types.ts";
import { tryOps, uniqueIn } from "./place.ts";

export interface Placed {
  readonly item: Item;
  readonly track: Track;
}

export interface LinkIndex {
  /** The link of every linked item (one with at least one mate). */
  readonly keyOf: ReadonlyMap<Id, string>;
  /** The items of each link, in track order. */
  readonly members: ReadonlyMap<string, ReadonlyArray<Placed>>;
}

/** A legacy link's key: the clip the `linkedTo` items followed. */
const LEGACY = "~";

const indexes = new WeakMap<ReadonlyArray<Track>, LinkIndex>();

export function linkIndex(tracks: ReadonlyArray<Track>): LinkIndex {
  const cached = indexes.get(tracks);
  if (cached) return cached;
  const placed = tracks.flatMap((track) => track.items.map((item) => ({ item, track })));
  const byId = new Map(placed.map((p) => [p.item.id, p.item]));
  const leaders = new Set(placed.flatMap(({ item }) => (!item.link && item.linkedTo ? [item.linkedTo] : [])));
  const keyFor = (item: Item): string | undefined => {
    if (item.link) return item.link;
    if (item.linkedTo) return byId.get(item.linkedTo)?.link ?? LEGACY + item.linkedTo;
    return leaders.has(item.id) ? LEGACY + item.id : undefined;
  };
  const all = new Map<string, Array<Placed>>();
  for (const p of placed) {
    const key = keyFor(p.item);
    if (key) all.set(key, [...(all.get(key) ?? []), p]);
  }
  const members = new Map([...all].filter(([, list]) => list.length > 1));
  const keyOf = new Map([...members].flatMap(([key, list]) => list.map((p) => [p.item.id, key] as const)));
  const index = { keyOf, members };
  indexes.set(tracks, index);
  return index;
}

/** The items linked to `id` (not itself). */
export function linkMates(project: Pick<Project, "tracks">, id: Id): ReadonlyArray<Placed> {
  const index = linkIndex(project.tracks);
  const key = index.keyOf.get(id);
  return key ? index.members.get(key)!.filter((p) => p.item.id !== id) : [];
}

export const isLinked = (project: Pick<Project, "tracks">, id: Id) => linkIndex(project.tracks).keyOf.has(id);

/** Every link id in use (legacy keys aside), for handing out new ones. */
export const linkIdsIn = (project: Pick<Project, "tracks">) => new Set(project.tracks.flatMap((t) => t.items.flatMap((i) => (i.link ? [i.link] : []))));

export const newLinkId = (taken: Set<string>) => uniqueIn("link", taken);

const lockedPlaced = ({ item, track }: Placed) => !!item.locked || !!track.locked;

/**
 * The ops that turn legacy `linkedTo` links (D123, D215) into `link`s, nothing else changing: what
 * plays and exports stays the same. A link with a locked member stays legacy (still read as a link).
 */
export function legacyLinkOps(project: Pick<Project, "tracks">): ReadonlyArray<Op> {
  const index = linkIndex(project.tracks);
  const taken = linkIdsIn(project);
  const ops: Array<Op> = [];
  for (const [key, members] of index.members) {
    if (!key.startsWith(LEGACY) || members.some(lockedPlaced)) continue;
    const link = newLinkId(taken);
    for (const { item } of members) ops.push({ op: "update_item", item: item.id, set: { link, ...(item.linkedTo ? { linkedTo: null } : {}) } });
  }
  return ops;
}

const LINKABLE = new Set<Item["type"]>(["clip", "audio"]);

/** Link (D347): the selected clips and sounds get one link of their own; a link they leave with one item left goes. */
export function planLink(
  project: Project,
  ids: ReadonlyArray<Id>,
): { readonly ops: ReadonlyArray<Op>; readonly summary: string } | { readonly problem: string } {
  const all = project.tracks.flatMap((track) => track.items.map((item) => ({ item, track })));
  const chosen = [...new Set(ids)].map((id) => all.find((p) => p.item.id === id)).filter((p): p is Placed => !!p);
  if (chosen.length < 2) return { problem: "Select two or more clips or sounds to link them." };
  if (chosen.some((p) => !LINKABLE.has(p.item.type))) return { problem: "Only clips and sounds can be linked." };
  if (chosen.some(lockedPlaced)) return { problem: "Unlock them first: a locked item can't be linked." };
  const index = linkIndex(project.tracks);
  const keys = new Set(chosen.map((p) => index.keyOf.get(p.item.id)));
  if (keys.size === 1 && !keys.has(undefined) && index.members.get([...keys][0]!)!.length === chosen.length) return { problem: "They're already linked." };
  const link = newLinkId(linkIdsIn(project));
  const ops: Array<Op> = chosen.map(({ item }) => ({ op: "update_item", item: item.id, set: { link, ...(item.linkedTo ? { linkedTo: null } : {}) } }));
  ops.push(...leftAlone(project, new Set(chosen.map((p) => p.item.id))));
  return { ops, summary: `Link ${chosen.length} items` };
}

/** Unlink (D347): the selected items leave their links (a link left with one item goes too). */
export function planUnlink(
  project: Project,
  ids: ReadonlyArray<Id>,
): { readonly ops: ReadonlyArray<Op>; readonly summary: string } | { readonly problem: string } {
  const index = linkIndex(project.tracks);
  const chosen = [...new Set(ids)].filter((id) => index.keyOf.has(id));
  if (!chosen.length) return { problem: "Nothing selected is linked." };
  const leaving = new Set(chosen);
  // A legacy leader holds no field: its followers let go of it.
  for (const id of chosen) for (const p of index.members.get(index.keyOf.get(id)!)!) if (p.item.linkedTo === id) leaving.add(p.item.id);
  const all = new Map(project.tracks.flatMap((track) => track.items.map((item) => [item.id, { item, track }] as const)));
  const locked = [...leaving].find((id) => lockedPlaced(all.get(id)!));
  if (locked) return { problem: `${itemLabel(project, locked)} is locked. Unlock it to unlink it.` };
  const ops: Array<Op> = [...leaving].flatMap((id) => unlinkOp(all.get(id)!.item));
  ops.push(...leftAlone(project, leaving));
  return { ops, summary: chosen.length === 1 ? `Unlink ${chosen[0]}` : `Unlink ${chosen.length} items` };
}

const unlinkOp = (item: Item): Array<Op> =>
  item.link || item.linkedTo
    ? [{ op: "update_item", item: item.id, set: { ...(item.link ? { link: null } : {}), ...(item.linkedTo ? { linkedTo: null } : {}) } }]
    : [];

/** The unlink ops for items left alone in their link once `leaving` go. */
function leftAlone(project: Pick<Project, "tracks">, leaving: ReadonlySet<Id>): Array<Op> {
  const index = linkIndex(project.tracks);
  const keys = new Set([...leaving].map((id) => index.keyOf.get(id)).filter((k): k is string => !!k));
  return [...keys].flatMap((key) => {
    const rest = index.members.get(key)!.filter((p) => !leaving.has(p.item.id));
    return rest.length === 1 && !lockedPlaced(rest[0]!) ? unlinkOp(rest[0]!.item) : [];
  });
}

const syncable = (item: Item) => (item.type === "clip" || item.type === "audio") && !!item.media && !item.reverse && !item.speedKeys?.length;

/**
 * How many frames `id` is out of sync with a linked item playing the same media at the same speed
 * (positive: it plays later than its mate); undefined when it has no such mate to compare with.
 */
export function linkDrift(project: Pick<Project, "tracks">, id: Id, starts?: ReadonlyMap<Id, number>): number | undefined {
  const index = linkIndex(project.tracks);
  const key = index.keyOf.get(id);
  const self = key ? index.members.get(key)!.find((p) => p.item.id === id)!.item : undefined;
  if (!self || !syncable(self)) return undefined;
  const speed = self.speed ?? 1;
  const mates = linkMates(project, id)
    .map((p) => p.item)
    .filter((m) => syncable(m) && m.media === self.media && (m.speed ?? 1) === speed)
    .sort((a, b) => Number(a.type === self.type) - Number(b.type === self.type));
  const mate = mates[0];
  if (!mate) return undefined;
  const at = starts ?? layout(project).starts;
  const offset = (i: Item) => (at.get(i.id) ?? 0) - (i.in ?? 0) / speed;
  return Math.round(offset(self) - offset(mate));
}

/** "+12f", "-3f": a drift for the timeline's badge. */
export const driftLabel = (frames: number) => `${frames > 0 ? "+" : "-"}${Math.abs(frames)}f`;

/**
 * Move into sync (D347): the linked item off the main track (`id`, or its mate when `id` is on it)
 * moves by its drift, on its own, so it plays the same moment as its mate again.
 */
export function planMoveIntoSync(project: Project, id: Id): { readonly ops: ReadonlyArray<Op>; readonly summary: string } | { readonly problem: string } {
  const drift = linkDrift(project, id);
  if (!drift) return { problem: "It's in sync with what it's linked to." };
  const all = project.tracks.flatMap((track) => track.items.map((item) => ({ item, track })));
  const self = all.find((p) => p.item.id === id)!;
  const mate = linkMates(project, id).find((p) => linkDrift(project, p.item.id) === -drift);
  const target = self.track.role === "main" ? mate : self;
  if (!target || target.track.role === "main") return { problem: "Both are on the main track: move one off it first." };
  if (lockedPlaced(target)) return { problem: `${itemLabel(project, target.item.id)} is locked. Unlock it to move it.` };
  const by = target === self ? -drift : drift;
  const start = (target.item.start ?? 0) + by;
  if (start < 0) return { problem: "It would have to start before the timeline does: trim its start first." };
  const ops: ReadonlyArray<Op> = [{ op: "move_item", item: target.item.id, start, solo: true }];
  const tried = tryOps(project, ops);
  if ("problem" in tried) return { problem: `There's no room on the ${target.track.name} track to move it into sync.` };
  return { ops, summary: `Move ${target.item.id} into sync` };
}
