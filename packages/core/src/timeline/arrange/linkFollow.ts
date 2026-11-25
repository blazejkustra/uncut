// Links by delta (D347): what an edit does to one linked item, its mates get too. Nothing is
// re-derived from the other item, so a J or L cut (an edge trimmed alone) stays as it is.
import { applyEdit, createSession } from "../apply-ops.ts";
import { itemLabel, secs } from "../edit-log.ts";
import { layout } from "../timeline.ts";
import type { Id, Item, Op, Project } from "../types.ts";
import { gapOpsFor, shiftMainItems } from "./gaps.ts";
import { linkIdsIn, linkIndex, newLinkId, type Placed } from "./links.ts";
import { takenIds, tryOps, uniqueIn } from "./place.ts";
import { retimeSet } from "./retime.ts";

/** One edit's state: the project before and after the ops so far. */
interface Round {
  readonly before: Project;
  readonly after: Project;
  readonly beforeStarts: ReadonlyMap<Id, number>;
  readonly afterStarts: ReadonlyMap<Id, number>;
  /** The items in `after` that each item before was split into (itself included), in time order. */
  readonly pieces: ReadonlyMap<Id, ReadonlyArray<Placed>>;
  readonly ids: Set<string>;
  readonly links: Set<string>;
}

/** A driver piece's stretch in the timeline as it was before the edit, and how far it moved. */
interface Span {
  readonly from: number;
  readonly to: number;
  readonly shift: number;
  readonly piece: Item;
  /** Another media or way of playing now (a replaced fragment): the mate plays on there unlinked. */
  readonly foreign: boolean;
  /** The link the piece and the mates' parts over it get (undefined: the one they have). */
  readonly link: string | null | undefined;
}

interface Segment {
  readonly a: number;
  b: number;
  /** undefined: cut out with the driver's middle. */
  readonly span: Span | undefined;
}

const SOLO_OPS = new Set<Op["op"]>(["move_item", "trim_item", "split_item", "slip_item", "update_item"]);

/** Items this edit sets apart: ⌥ (solo) ops, and items whose link it changes. */
function soloIds(ops: ReadonlyArray<Op>): Set<Id> {
  const ids = new Set<Id>();
  for (const op of ops) {
    if (SOLO_OPS.has(op.op) && "solo" in op && op.solo) ids.add(op.item);
    if (op.op === "update_item" && ("link" in op.set || "linkedTo" in op.set)) ids.add(op.item);
  }
  return ids;
}

const applied = (project: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(project), { actor: "user", ops }).project;

function roundOf(before: Project, ops: ReadonlyArray<Op>, ids: Set<string>, links: Set<string>): Round {
  const after = applied(before, ops);
  const parent = new Map(ops.flatMap((op) => (op.op === "split_item" ? [[op.newId, op.item] as const] : [])));
  const originOf = (id: Id): Id => (parent.has(id) ? originOf(parent.get(id)!) : id);
  const afterStarts = layout(after).starts;
  const pieces = new Map<Id, Array<Placed>>();
  for (const track of after.tracks)
    for (const item of track.items) {
      const origin = originOf(item.id);
      pieces.set(origin, [...(pieces.get(origin) ?? []), { item, track }]);
    }
  for (const list of pieces.values()) list.sort((x, y) => afterStarts.get(x.item.id)! - afterStarts.get(y.item.id)!);
  for (const id of takenIds(after)) ids.add(id);
  return { before, after, beforeStarts: layout(before).starts, afterStarts, pieces, ids, links };
}

const ramp = (item: Item) => JSON.stringify(item.speedKeys ?? null);

const sameTiming = (a: Item, b: Item) =>
  (a.in ?? 0) === (b.in ?? 0) &&
  a.duration === b.duration &&
  (a.speed ?? 1) === (b.speed ?? 1) &&
  a.media === b.media &&
  !!a.reverse === !!b.reverse &&
  !!a.loop === !!b.loop &&
  ramp(a) === ramp(b);

function unchanged(round: Round, { item }: Placed): boolean {
  const now = round.pieces.get(item.id) ?? [];
  return (
    now.length === 1 && now[0]!.item.id === item.id && round.afterStarts.get(item.id) === round.beforeStarts.get(item.id) && sameTiming(item, now[0]!.item)
  );
}

const locked = ({ item, track }: Placed) => !!item.locked || !!track.locked;

/** Plays its media at a constant speed forwards, so its in point says which moment it shows. */
const timed = (project: Project, item: Item) =>
  !item.reverse && !item.speedKeys?.length && project.media.find((m) => m.id === item.media)?.kind !== "image" && item.media !== undefined;

function spansOf(round: Round, driver: Item, pieces: ReadonlyArray<Placed>): Array<Span> {
  const bs = round.beforeStarts.get(driver.id)!;
  const v = driver.speed ?? 1;
  const byIn = timed(round.before, driver);
  const raw = pieces.map(({ item: p }) => {
    const start = round.afterStarts.get(p.id)!;
    const foreign = p.media !== driver.media || (p.speed ?? 1) !== v || !!p.reverse !== !!driver.reverse || ramp(p) !== ramp(driver);
    // Without a media time to go by, a lone piece of the same length moved; any other stayed put.
    const from = foreign
      ? start
      : byIn
        ? bs + Math.round(((p.in ?? 0) - (driver.in ?? 0)) / v)
        : pieces.length === 1 && p.duration === driver.duration
          ? bs
          : start;
    return { from, to: from + p.duration, shift: start - from, piece: p, foreign };
  });
  const keep = raw.find((s) => s.piece.id === driver.id && !s.foreign) ?? raw.find((s) => !s.foreign);
  return raw.map((s) => ({ ...s, link: s.foreign ? null : s === keep ? undefined : newLinkId(round.links) })).sort((x, y) => x.from - y.from);
}

function spanFor(spans: ReadonlyArray<Span>, a: number, b: number): Span | undefined {
  const inside = spans.find((s) => s.from <= a && b <= s.to);
  if (inside) return inside;
  if (b <= spans[0]!.from) return spans[0];
  if (a >= spans.at(-1)!.to) return spans.at(-1);
  return undefined;
}

/** The mate's stretch [y0, y1) cut where the driver's pieces begin and end, runs over one piece merged. */
function segmentsOf(spans: ReadonlyArray<Span>, y0: number, y1: number): Array<Segment> {
  const cuts = [...new Set(spans.flatMap((s) => [s.from, s.to]))].filter((x) => x > y0 && x < y1).sort((p, q) => p - q);
  const edges = [y0, ...cuts, y1];
  const out: Array<Segment> = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const span = spanFor(spans, edges[k]!, edges[k + 1]!);
    const last = out.at(-1);
    if (last && last.span === span) last.b = edges[k + 1]!;
    else out.push({ a: edges[k]!, b: edges[k + 1]!, span });
  }
  return out;
}

/** How far the mate's edges may grow: back to its media's first frame, on to its last (loops and stills: no limit). */
function room(project: Project, item: Item) {
  const media = project.media.find((m) => m.id === item.media);
  if (!media || media.kind === "image" || item.reverse || item.speedKeys?.length) return { before: Infinity, after: Infinity };
  const speed = item.speed ?? 1;
  const frames = media.probe?.frames;
  const before = Math.floor((item.in ?? 0) / speed);
  const after = frames && !item.loop && !item.hold ? Math.floor((frames - (item.in ?? 0)) / speed) - item.duration : Infinity;
  return { before, after: Math.max(0, after) };
}

const linkSet = (item: Item, link: string | null): Record<string, unknown> => ({ link, ...(item.linkedTo ? { linkedTo: null } : {}) });

/** The ops that give `mate` what the edit did to `driver` (its pieces now), by delta. */
function followOps(round: Round, driver: Item, pieces: ReadonlyArray<Placed>, spans: ReadonlyArray<Span>, mate: Placed): Array<Op> {
  const { item: y, track } = mate;
  if (!pieces.length) return deleted(round, mate);
  const bs = round.beforeStarts.get(driver.id)!;
  const be = bs + driver.duration;
  const ys = round.beforeStarts.get(y.id)!;
  const ye = ys + y.duration;
  const lone = pieces.length === 1 ? pieces[0]!.item : undefined;
  if (lone && speedChanged(driver, lone)) return speedOps(round, driver, lone, mate);
  if (lone && spans[0]!.foreign) return [];
  const grow = room(round.before, y);
  const y0 = Math.max(ys === bs ? spans[0]!.from : ys, ys - grow.before);
  const y1 = Math.min(ye === be ? spans.at(-1)!.to : ye, ye + grow.after);
  if (y1 - y0 < 1) return deleted(round, mate);
  const ops: Array<Op> = [];
  if (y0 !== ys) ops.push({ op: "trim_item", item: y.id, edge: "start", frames: y0 - ys });
  if (y1 !== ye) ops.push({ op: "trim_item", item: y.id, edge: "end", frames: ye - y1 });
  const segments = segmentsOf(spans, y0, y1);
  const base = y.id.replace(/-\d+$/, "") || "item";
  const ids = segments.map((_, k) => (k === 0 ? y.id : uniqueIn(base, round.ids)));
  segments.slice(1).forEach((s, k) => ops.push({ op: "split_item", item: ids[k]!, at: s.a - segments[k]!.a, newId: ids[k + 1]! }));
  const wanted = new Map<Id, number>();
  segments.forEach((s, k) => {
    const id = ids[k]!;
    if (!s.span) return ops.push({ op: "delete_item", item: id });
    wanted.set(id, s.a + s.span.shift);
    if (track.role !== "main" && s.span.shift !== 0) ops.push({ op: "move_item", item: id, start: s.a + s.span.shift });
    const link = s.span.link;
    if (link !== undefined && (link !== (y.link ?? null) || y.linkedTo)) ops.push({ op: "update_item", item: id, set: linkSet(y, link) });
  });
  if (track.role !== "main") return ops;
  const moveOnly = ops.length === 0 && segments.length === 1 && segments[0]!.span;
  if (moveOnly) return mainShift(round, y.id, segments[0]!.span!.shift);
  return [...ops, ...mainPlaced(round, ops, wanted)];
}

const deleted = (round: Round, { item, track }: Placed): Array<Op> => {
  const ops: Array<Op> = [{ op: "delete_item", item: item.id }];
  return track.role === "main" ? [...ops, ...mainPlaced(round, ops, new Map())] : ops;
};

const speedChanged = (driver: Item, now: Item) =>
  now.id === driver.id &&
  now.media === driver.media &&
  !!now.reverse === !!driver.reverse &&
  ramp(now) === ramp(driver) &&
  (now.speed ?? 1) !== (driver.speed ?? 1);

/** The driver's speed changed: the mate's speed by the same factor, its timeline stretch scaled about the driver's start. */
function speedOps(round: Round, driver: Item, now: Item, mate: Placed): Array<Op> {
  const { item: y, track } = mate;
  const ratio = (driver.speed ?? 1) / (now.speed ?? 1);
  const speed = Math.round((((y.speed ?? 1) * (now.speed ?? 1)) / (driver.speed ?? 1)) * 1000) / 1000;
  const bs = round.beforeStarts.get(driver.id)!;
  const ys = round.beforeStarts.get(y.id)!;
  const start = round.afterStarts.get(now.id)! + Math.round((ys - bs) * ratio);
  const duration = Math.max(1, Math.round(y.duration * ratio));
  const fields: Record<string, unknown> = { speed: speed === 1 ? null : speed, keepPitch: now.keepPitch === false ? false : null };
  if (track.role !== "main") fields.start = start;
  const ops: Array<Op> = [{ op: "update_item", item: y.id, set: retimeSet(y, duration, fields, ratio) }];
  return track.role === "main" ? [...ops, ...mainPlaced(round, ops, new Map([[y.id, start]]))] : ops;
}

const mainOf = (project: Project) => project.tracks.find((t) => t.role === "main");

function mainShift(round: Round, id: Id, shift: number): Array<Op> {
  const main = mainOf(round.after);
  return shift && main ? shiftMainItems(main, new Set([id]), shift).ops : [];
}

/**
 * The gaps that put a main mate's parts where `wanted` says after `ops`, and every other main item
 * where the edit put it; a transition across a new gap or at a changed cut goes.
 */
function mainPlaced(round: Round, ops: ReadonlyArray<Op>, wanted: ReadonlyMap<Id, number>): Array<Op> {
  const mid = applied(round.after, ops);
  const main = mainOf(mid);
  if (!main) return [];
  const now = layout(mid).starts;
  const order = main.items;
  const gaps = gapOpsFor(order, (item) => wanted.get(item.id) ?? round.afterStarts.get(item.id) ?? now.get(item.id)!);
  const drops: Array<Op> = [];
  let end = 0;
  order.forEach((item, k) => {
    const start = gaps.starts.get(item.id)!;
    const touched = wanted.has(item.id) || wanted.has(order[k - 1]?.id ?? "");
    if (item.transitionIn && (start > end || touched)) drops.push({ op: "set_transition", item: item.id, transition: null });
    end = start + item.duration;
  });
  return [...drops, ...gaps.ops];
}

/** The link the driver's pieces get (a piece split off gets a link of its own with the mates' parts over it). */
const pieceLinkOps = (spans: ReadonlyArray<Span>): Array<Op> =>
  spans.flatMap((s) =>
    s.link === undefined || (s.link === (s.piece.link ?? null) && !s.piece.linkedTo)
      ? []
      : [{ op: "update_item" as const, item: s.piece.id, set: linkSet(s.piece, s.link) }],
  );

/** The member whose change the others follow: one the ops name, else a clip, else the first. */
function driverOf(drivers: ReadonlyArray<Placed>, ops: ReadonlyArray<Op>): Placed {
  const named = new Set(ops.flatMap((op) => ("item" in op && typeof op.item === "string" ? [op.item] : [])));
  return drivers.find((d) => named.has(d.item.id)) ?? drivers.find((d) => d.item.type === "clip") ?? drivers[0]!;
}

/** The follow ops for one link, when it has a changed member and unchanged ones to follow it. */
function followLink(round: Round, members: ReadonlyArray<Placed>, ops: ReadonlyArray<Op>, solo: ReadonlySet<Id>) {
  const free = members.filter((m) => !solo.has(m.item.id));
  const drivers = free.filter((m) => !unchanged(round, m));
  const mates = free.filter((m) => unchanged(round, m) && !locked(m));
  if (!drivers.length || !mates.length) return undefined;
  const driver = driverOf(drivers, ops).item;
  const pieces = round.pieces.get(driver.id) ?? [];
  const retimed = pieces.length === 1 && speedChanged(driver, pieces[0]!.item);
  const spans = pieces.length && !retimed ? spansOf(round, driver, pieces) : [];
  return {
    ops: [...mates.flatMap((mate) => followOps(round, driver, pieces, spans, mate)), ...pieceLinkOps(spans)],
    onMain: mates.some((m) => m.track.role === "main"),
  };
}

/** Passes over the links: a main mate that moves can ripple other linked clips, whose mates follow next. */
const ROUNDS = 4;

/**
 * Links by delta (D347): `ops` plus what keeps every linked item with its mates: the same move
 * (a ripple on Main included), the same trim of an edge that lined up with the trimmed one (an edge
 * that didn't, a J or L cut, stays), a split at the same timeline frame where it falls inside (each
 * piece linked with the mate's part over it), the same middle cut out (a transcript cut), the same
 * speed change, deleted together. ⌥ ops (`solo`) and link changes don't spread; locked mates stay.
 * A replaced fragment (another media) leaves its mates playing on there, unlinked. Refused, with
 * why, when a mate can't follow (something else is in its way). Pure; run where edits are applied
 * (the server) and drafted (the renderer).
 */
export function withLinks(project: Project, ops: ReadonlyArray<Op>): { readonly ops: ReadonlyArray<Op> } | { readonly problem: string } {
  const links = linkIndex(project.tracks).members;
  if (!ops.length || !links.size) return { ops };
  const solo = soloIds(ops);
  const done = new Set<string>();
  const ids = takenIds(project);
  const linkIds = linkIdsIn(project);
  let all = [...ops];
  try {
    for (let k = 0; k < ROUNDS; k++) {
      let round = roundOf(project, all, ids, linkIds);
      const before = all.length;
      for (const [key, members] of links) {
        if (done.has(key)) continue;
        const follow = followLink(round, members, ops, solo);
        if (!follow) continue;
        done.add(key);
        all = [...all, ...follow.ops];
        // A main mate moved or cut ripples the main track: the next links see where things are now.
        if (follow.onMain) round = roundOf(project, all, ids, linkIds);
      }
      if (all.length === before) break;
    }
  } catch (error) {
    return all.length === ops.length ? { ops } : { problem: followProblem((error as Error).message) };
  }
  if (all.length === ops.length) return { ops };
  const check = tryOps(project, all);
  if (!("problem" in check)) return { ops: all };
  return "problem" in tryOps(project, ops) ? { ops } : { problem: followProblem(check.problem.replace(/^Can't do that: /, "")) };
}

const followProblem = (why: string) =>
  `A linked item can't go along with that (${why.replace(/\.$/, "")}). Edit one side alone (hold ⌥ on the timeline) or unlink them first.`;

function followLine(project: Project, op: Op): string | undefined {
  const fps = project.canvas.fps;
  const label = (id: Id) => itemLabel(project, id);
  switch (op.op) {
    case "delete_item":
      return `Deleted ${label(op.item)} with the item it's linked to`;
    case "split_item":
      return `Split ${label(op.item)} with the item it's linked to (new piece ${op.newId})`;
    case "trim_item":
      return `Trimmed ${label(op.item)} with the item it's linked to: ${op.edge} edge by ${secs(op.frames, fps)}`;
    case "move_item":
      return op.start === undefined ? undefined : `Moved ${label(op.item)} with the item it's linked to, to ${secs(op.start, fps)}`;
    case "update_item":
      if ("speed" in op.set) return `Changed ${label(op.item)}'s speed with the item it's linked to`;
      return undefined;
    default:
      return undefined;
  }
}

/** The lines for what withLinks added to an edit (`synced` past `ops`), worded from the project before it. */
export function linkLines(project: Project, ops: ReadonlyArray<Op>, synced: ReadonlyArray<Op>): Array<string> {
  return synced
    .slice(ops.length)
    .map((op) => followLine(project, op))
    .filter((line): line is string => !!line);
}
