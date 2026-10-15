// timeline_edit made friendlier for the agent (issue #38, D206). Browser-safe, pure.
//
// - place_item: insert a new item (or move one) on a free track and say how an overlap is
//   resolved: "after" (the first free frame at or after the start), "free-track" (the same start
//   on another track of that kind that is free there, else a new track next to it) or "ripple"
//   (the items on that track from the start on move later by what is needed).
// - set_transition with allowTrim: an overlapping transition that lacks spare media at the cut
//   trims exactly the missing frames first; without allowTrim it is refused with the numbers.
// - refusalFixes: every problem of a refused edit gets a concrete fix ("start 312 on text", "track
//   text-2", "id title-3").
import { applyEdit, createSession } from "./apply-ops.ts";
import { busySpans, isFree, takenIds } from "./arrange.ts";
import { fitsTrackKind, resolveStarts } from "./rules.ts";
import { overlaps } from "../visual/transitions.ts";
import type { Item, Op, Problem, Project, Track } from "./types.ts";

export const PLACE_MODES = ["after", "free-track", "ripple"] as const;
export type PlaceMode = (typeof PLACE_MODES)[number];

/** What a place_item or an allowTrim did, in one line for the agent. */
export interface PlacementNote {
  readonly item: string;
  readonly track: string;
  readonly start?: number;
  readonly how: string;
}

/** The project after `ops` with no validation (structural errors keep the project as it was). */
export function projectAfter(project: Project, ops: ReadonlyArray<unknown>): Project {
  if (!ops.length) return project;
  try {
    return applyEdit(createSession(project), { actor: "agent", ops: ops as ReadonlyArray<Op> }).project;
  } catch {
    return project;
  }
}

/** The first frame at or after `start` where `duration` frames are free on a free track (ignoring `exclude`). */
export function freeFrom(track: Track, start: number, duration: number, exclude?: string): { start: number; after?: string } {
  let at = Math.max(0, start);
  let after: string | undefined;
  const spans = track.items.filter((i) => i.id !== exclude).map((i) => ({ id: i.id, start: i.start ?? 0, end: (i.start ?? 0) + i.duration })).sort((a, b) => a.start - b.start);
  for (const b of spans) {
    if (at + duration <= b.start) break;
    if (at < b.end) {
      at = b.end;
      after = b.id;
    }
  }
  return { start: at, ...(after ? { after } : {}) };
}

/** Another unlocked free track of the same kind as `track` that is free over [start, start + duration), in track order. */
export function freeTrackLike(project: Pick<Project, "tracks">, track: Track, start: number, duration: number, exclude?: string): Track | undefined {
  return project.tracks.find((t) => t.id !== track.id && t.kind === track.kind && t.role !== "main" && !t.locked && isFree(t, start, duration, exclude));
}

/** A new id like `base` that isn't taken: title-2 → title-3, text → text-2. */
export function freshId(base: string, taken: ReadonlySet<string>): string {
  const m = /^(.*?)-(\d+)$/.exec(base);
  const stem = m ? m[1]! : base;
  for (let n = m ? Number(m[2]) + 1 : 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

const locate = (project: Pick<Project, "tracks">, id: string) => {
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === id);
    if (index !== -1) return { track, index, item: track.items[index]! };
  }
  return undefined;
};

/** The spare media an overlapping transition into `item` needs and what is missing (D206; mirrors rules.ts). */
export function transitionHandles(project: Pick<Project, "tracks" | "media">, itemId: string, transition: { module: string; duration: number }) {
  const at = locate(project, itemId);
  if (!at || at.track.role !== "main" || at.index === 0) return undefined;
  const item = at.item;
  const prev = at.track.items[at.index - 1]!;
  const half = overlaps(transition.module) ? Math.ceil(transition.duration / 2) : 0;
  const mediaOf = (i: Item) => (i.media ? project.media.find((m) => m.id === i.media) : undefined);
  const cur = mediaOf(item);
  const before = mediaOf(prev);
  const hasBefore = half > 0 && cur?.kind === "video" ? (item.in ?? 0) : Infinity;
  const hasAfter = half > 0 && before?.kind === "video" && before.probe?.frames ? before.probe.frames - ((prev.in ?? 0) + prev.duration) : Infinity;
  return {
    item,
    prev,
    half,
    hasBefore,
    hasAfter,
    missingIn: Number.isFinite(hasBefore) ? Math.max(0, half - hasBefore) : 0,
    missingOut: Number.isFinite(hasAfter) ? Math.max(0, half - hasAfter) : 0,
    // The longest transition that fits as the clips are (both items at least twice as long, D79).
    fits: Math.max(0, Math.min(Math.floor(Math.min(prev.duration, item.duration) / 2), 2 * Math.min(hasBefore, hasAfter, Number.MAX_SAFE_INTEGER))),
  };
}

const PLACE_KEYS = new Set(["op", "track", "item", "start", "index", "place"]);
const TRIM_KEYS = new Set(["op", "item", "transition", "allowTrim"]);

/**
 * timeline_edit's place_item ops and set_transition's allowTrim (D206) as plain edit ops, each
 * planned against the project as the ops before it leave it. Other ops pass through; a set_transition
 * that lacks spare media and has no allowTrim is refused with the exact numbers and the fix.
 */
export function expandPlacement(project: Project, ops: ReadonlyArray<unknown>): { ops: Array<unknown>; notes: Array<PlacementNote> } | { problem: string } {
  const out: Array<unknown> = [];
  const notes: Array<PlacementNote> = [];
  for (const [i, raw] of ops.entries()) {
    const op = raw as Record<string, unknown>;
    if (op?.op === "set_transition") {
      const extra = Object.keys(op).filter((k) => !TRIM_KEYS.has(k));
      const tr = op.transition as { module?: unknown; duration?: unknown } | null | undefined;
      if (extra.length || !tr || typeof tr !== "object" || typeof tr.module !== "string" || typeof tr.duration !== "number" || typeof op.item !== "string") {
        const { allowTrim: _a, ...rest } = op;
        out.push(rest);
        continue;
      }
      if (op.allowTrim !== undefined && typeof op.allowTrim !== "boolean") return { problem: `ops[${i}] (set_transition): allowTrim must be true or false.` };
      const now = projectAfter(project, out);
      const h = transitionHandles(now, op.item, { module: tr.module, duration: tr.duration });
      const { allowTrim, ...plain } = op;
      if (!h || (!h.missingIn && !h.missingOut)) {
        out.push(plain);
        continue;
      }
      const where = `ops[${i}] (set_transition ${tr.module} on "${op.item}")`;
      const what = [
        h.missingIn ? `"${h.item.id}" has ${h.hasBefore} frame${h.hasBefore === 1 ? "" : "s"} of media before its in-point (${h.missingIn} missing)` : "",
        h.missingOut ? `"${h.prev.id}" has ${h.hasAfter} after its out-point (${h.missingOut} missing)` : "",
      ].filter(Boolean);
      const speed = h.item.speed ?? 1;
      const trimIn = h.missingIn ? Math.ceil(h.missingIn / speed) : 0;
      const trimOut = h.missingOut;
      const trims = [trimIn ? `${trimIn} frame${trimIn === 1 ? "" : "s"} off the start of "${h.item.id}"` : "", trimOut ? `${trimOut} off the end of "${h.prev.id}"` : ""].filter(Boolean).join(" and ");
      if (allowTrim !== true)
        return {
          problem: `${where}: a ${tr.duration}-frame overlapping transition needs ${h.half} frames of spare media on each side of the cut; ${what.join(" and ")}. Fix: pass allowTrim: true on this set_transition to trim ${trims}${h.fits > 0 ? `, or use duration ${h.fits} or less` : ""}, or use transition.dip-to-black (it needs no spare media).`,
        };
      if (h.item.duration - trimIn < 2 * tr.duration || h.prev.duration - trimOut < 2 * tr.duration)
        return { problem: `${where}: trimming ${trims} would leave a clip shorter than twice the transition (${2 * tr.duration} frames). Use a shorter transition or transition.dip-to-black.` };
      if (trimOut) out.push({ op: "trim_item", item: h.prev.id, edge: "end", frames: trimOut });
      if (trimIn) out.push({ op: "trim_item", item: h.item.id, edge: "start", frames: trimIn });
      out.push(plain);
      notes.push({ item: h.item.id, track: locate(now, h.item.id)!.track.id, how: `trimmed ${trims} for the ${tr.module}'s spare media` });
      continue;
    }
    if (op?.op !== "place_item") {
      out.push(raw);
      continue;
    }
    const where = `ops[${i}] (place_item)`;
    const extra = Object.keys(op).filter((k) => !PLACE_KEYS.has(k));
    if (extra.length) return { problem: `${where}: unknown field ${extra.join(", ")}.` };
    if (!(PLACE_MODES as ReadonlyArray<unknown>).includes(op.place)) return { problem: `${where}: place must be "after", "free-track" or "ripple".` };
    const place = op.place as PlaceMode;
    const now = projectAfter(project, out);
    const taken = takenIds(now);
    // The item: a new one (an object) or one already on the timeline (its id) to move.
    const moving = typeof op.item === "string" ? locate(now, op.item) : undefined;
    if (typeof op.item === "string" && !moving) return { problem: `${where}: there's no item "${op.item}". Pass the item's id to move it, or a new item object to add one.` };
    const body = (moving ? moving.item : op.item) as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) return { problem: `${where}: item must be a new item ({id, type, duration, …}) or the id of one to move.` };
    if (typeof body.id !== "string" || !body.id) return { problem: `${where}: the new item needs an id.` };
    if (!moving && taken.has(body.id)) return { problem: `${where}: the id "${body.id}" is taken. Fix: use "${freshId(body.id, taken)}".` };
    if (!(Number.isInteger(body.duration) && (body.duration as number) > 0)) return { problem: `${where}: the item needs a duration in frames (a whole number above 0).` };
    const duration = body.duration as number;
    const trackId = typeof op.track === "string" ? op.track : moving?.track.id;
    if (!trackId) return { problem: `${where}: track is the id of the track to put it on.` };
    const track = now.tracks.find((t) => t.id === trackId);
    if (!track) return { problem: `${where}: there's no track "${trackId}". Tracks: ${now.tracks.map((t) => `${t.id} (${t.kind}${t.role === "main" ? ", main" : ""})`).join(", ")}.` };
    if (track.locked) return { problem: `${where}: the track "${track.id}" is locked.` };
    const id = body.id;
    if (track.role === "main") {
      // The main track is magnetic: items play back to back, so an insert always ripples.
      const starts = resolveStarts(now);
      const others = track.items.filter((x) => x.id !== id);
      let index = Number.isInteger(op.index) ? Math.min(op.index as number, others.length) : others.length;
      if (!Number.isInteger(op.index) && typeof op.start === "number") {
        index = others.findIndex((x) => (starts.get(x.id) ?? 0) >= (op.start as number));
        if (index === -1) index = others.length;
      }
      const { start: _s, ...plain } = body;
      if (moving) out.push({ op: "move_item", item: id, track: track.id, index });
      else out.push({ op: "insert_item", track: track.id, index, item: plain });
      notes.push({ item: id, track: track.id, how: `on the main track at index ${index} (items after it move later)` });
      continue;
    }
    const wanted = typeof op.start === "number" ? Math.max(0, Math.round(op.start)) : typeof body.start === "number" ? (body.start as number) : undefined;
    if (wanted === undefined) return { problem: `${where}: start (a frame) is needed on the free track "${track.id}".` };
    const exclude = moving ? id : undefined;
    const put = (t: Track, start: number, how: string) => {
      if (moving) out.push({ op: "move_item", item: id, track: t.id, start });
      else out.push({ op: "insert_item", track: t.id, item: { ...body, start } });
      notes.push({ item: id, track: t.id, start, how });
    };
    if (isFree(track, wanted, duration, exclude)) {
      put(track, wanted, "where asked (it was free)");
      continue;
    }
    if (place === "after") {
      const spot = freeFrom(track, wanted, duration, exclude);
      put(track, spot.start, `moved to frame ${spot.start}${spot.after ? `, right after "${spot.after}"` : ""}`);
      continue;
    }
    if (place === "free-track") {
      const other = freeTrackLike(now, track, wanted, duration, exclude);
      if (other) {
        put(other, wanted, `on track "${other.id}", free there`);
        continue;
      }
      const newId = freshId(track.id, taken);
      const names = new Set(now.tracks.map((t) => t.name));
      const base = track.name ?? track.kind[0]!.toUpperCase() + track.kind.slice(1);
      let name = `${base} 2`;
      for (let n = 2; names.has(name); n++) name = `${base} ${n + 1}`;
      // A picture or text track goes just above (it draws over); sound just below.
      const index = now.tracks.findIndex((t) => t.id === track.id) + (track.kind === "audio" ? 1 : 0);
      out.push({ op: "add_track", track: { id: newId, kind: track.kind, name }, index });
      put({ ...track, id: newId, items: [] }, wanted, `on a new track "${newId}" (nothing was free there)`);
      continue;
    }
    // ripple: everything on this track from the start on moves later by the overlap.
    const busy = track.items.filter((x) => x.id !== exclude);
    const straddle = busy.find((x) => (x.start ?? 0) < wanted && (x.start ?? 0) + x.duration > wanted);
    if (straddle) {
      const end = (straddle.start ?? 0) + straddle.duration;
      return { problem: `${where}: "${straddle.id}" runs across frame ${wanted} (${straddle.start ?? 0}–${end}), so ripple can't push it. Fix: start at ${end}, or place "free-track".` };
    }
    const later = busy.filter((x) => (x.start ?? 0) >= wanted).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    const shift = Math.max(0, wanted + duration - (later[0]?.start ?? Infinity));
    const locked = later.find((x) => x.locked);
    if (shift && locked) return { problem: `${where}: ripple would move "${locked.id}", which is locked. Fix: place "after" or "free-track".` };
    // The last first, so nothing passes through another on the way.
    if (shift) for (const x of [...later].reverse()) out.push({ op: "move_item", item: x.id, start: (x.start ?? 0) + shift });
    put(track, wanted, shift ? `at frame ${wanted}; ${later.length} item${later.length === 1 ? "" : "s"} after it on "${track.id}" moved ${shift} frames later` : `at frame ${wanted}`);
  }
  return { ops: out, notes };
}

/** A refusal's problem with a concrete fix (D206). */
export type FixedProblem = Problem & { readonly fix?: string };

const lastId = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";

/**
 * Each problem of a refused edit with a fix the agent can use as it is: a start frame and track
 * for an overlap, a free id, the frames a transition lacks, the tracks an item fits on.
 * `project` is the project before the edit; the ops are applied (unchecked) to see the result.
 */
export function refusalFixes(project: Project, ops: ReadonlyArray<unknown>, problems: ReadonlyArray<Problem>): Array<FixedProblem> {
  const after = projectAfter(project, ops);
  const taken = takenIds(after);
  const starts = resolveStarts(after);
  const beforeStarts = resolveStarts(project);
  // Whether the edit put or moved this item (a new one, another track, start or length).
  const touched = (id: string) => {
    const was = locate(project, id);
    const is = locate(after, id);
    return !was || !is || was.track.id !== is.track.id || beforeStarts.get(id) !== starts.get(id) || was.item.duration !== is.item.duration;
  };
  return problems.map((p): FixedProblem => {
    // An overlap is reported on the later item: the fix is for the one this edit placed.
    if (p.code === "overlap") {
      const other = /overlaps "([^"]+)"/.exec(p.message)?.[1];
      const id = lastId(p.path);
      if (other && !touched(id) && touched(other)) p = { ...p, path: p.path.replace(/[^/]+$/, other) };
    }
    const fix = fixFor(after, taken, starts, p);
    return fix ? { ...p, fix } : p;
  });
}

function fixFor(after: Project, taken: ReadonlySet<string>, starts: Map<string, number>, p: Problem): string | undefined {
  const id = lastId(p.path);
  const at = locate(after, id);
  switch (p.code) {
    case "overlap": {
      if (!at) return undefined;
      const start = starts.get(id) ?? 0;
      const spot = freeFrom(at.track, start, at.item.duration, id);
      const other = freeTrackLike(after, at.track, start, at.item.duration, id);
      return `Use start ${spot.start} on "${at.track.id}"${spot.after ? ` (right after "${spot.after}")` : ""}${other ? `, or track "${other.id}" (free at ${start}–${start + at.item.duration})` : ", or a new track"}. place_item with place "after", "free-track" or "ripple" does it in one op.`;
    }
    case "duplicate-id": {
      const m = /id "([^"]+)"/.exec(p.message);
      const dup = m?.[1] ?? id;
      return `Use the id "${freshId(dup, taken)}".`;
    }
    case "transition-handles": {
      if (!at?.item.transitionIn) return undefined;
      const h = transitionHandles(after, id, at.item.transitionIn);
      if (!h) return undefined;
      const parts = [h.missingIn ? `${h.missingIn} frames before "${h.item.id}"'s in-point` : "", h.missingOut ? `${h.missingOut} after "${h.prev.id}"'s out-point` : ""].filter(Boolean).join(" and ");
      return `It lacks ${parts}. Pass allowTrim: true on the set_transition to trim them${h.fits > 0 ? `, use duration ${h.fits} or less` : ""}, or use transition.dip-to-black (no spare media needed).`;
    }
    case "transition-too-long": {
      if (!at || at.index === 0) return undefined;
      const prev = at.track.items[at.index - 1]!;
      return `At most ${Math.floor(Math.min(prev.duration, at.item.duration) / 2)} frames fits between "${prev.id}" (${prev.duration}) and "${id}" (${at.item.duration}).`;
    }
    case "transition-first":
      return `Put the transition on the second or a later item of the main track (it goes into that item from the one before).`;
    case "transition-track":
      return `Only main-track items take transitions; animate an overlay in and out with its animation instead.`;
    case "item-track-kind": {
      if (!at) return undefined;
      const want = at.item.type === "text" || at.item.type === "captions" ? "text" : at.item.type === "audio" ? "audio" : "video";
      // D215: the main track takes any picture (text too).
      const fits = after.tracks.filter((t) => !t.locked && (t.role === "main" ? fitsTrackKind(at.item.type, t) : t.kind === want)).map((t) => t.id);
      return fits.length ? `A ${at.item.type} item goes on ${want === "video" || at.item.type === "text" ? "the main track or " : ""}a ${want} track: ${fits.slice(0, 6).join(", ")}.` : `Add a ${want} track first (add_track) and put it there.`;
    }
    case "missing-start": {
      if (!at) return undefined;
      const end = Math.max(0, ...busySpans(at.track, id).map((b) => b.end));
      return `Give it a start frame; ${end} is free after the last item on "${at.track.id}".`;
    }
    case "main-item-start":
      return `Drop start: main-track items play back to back; pass index on insert_item or move_item instead.`;
    case "unknown-media":
      return after.media.length ? `Media ids in the project: ${after.media.slice(0, 10).map((m) => m.id).join(", ")}${after.media.length > 10 ? ` and ${after.media.length - 10} more` : ""}.` : `The project has no media yet: media_import or media_search first.`;
    case "media-range": {
      if (!at) return undefined;
      const m = /has (\d+)/.exec(p.message);
      const frames = m ? Number(m[1]) : undefined;
      const room = frames !== undefined ? Math.max(1, Math.floor((frames - (at.item.in ?? 0)) / (at.item.speed ?? 1))) : undefined;
      return room !== undefined ? `Make it at most ${room} frames long from in ${at.item.in ?? 0}, or set hold: true (freeze the last frame) or loop: true.` : undefined;
    }
    case "fade-too-long":
      return at ? `fadeIn plus fadeOut must be at most ${at.item.duration} frames.` : undefined;
    case "animation-too-long":
      return at ? `Make the animation at most ${at.item.duration} frames.` : undefined;
    default:
      return undefined;
  }
}

/** A dry run's planned change (D206): items added, removed, moved (track or start) or otherwise changed, tracks and media added or removed. */
export function projectDiff(before: Project, after: Project) {
  const where = (p: Project) => {
    const starts = resolveStarts(p);
    return new Map(p.tracks.flatMap((t) => t.items.map((i) => [i.id, { track: t.id, start: starts.get(i.id) ?? 0, item: i }] as const)));
  };
  const a = where(before);
  const b = where(after);
  const span = (x: { track: string; start: number; item: Item }) => ({ id: x.item.id, type: x.item.type, track: x.track, start: x.start, end: x.start + x.item.duration });
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const added = [...b.values()].filter((x) => !a.has(x.item.id)).map(span);
  const removed = [...a.values()].filter((x) => !b.has(x.item.id)).map(span);
  const moved = [...b.values()].filter((x) => a.has(x.item.id) && (a.get(x.item.id)!.track !== x.track || a.get(x.item.id)!.start !== x.start)).map((x) => ({ ...span(x), from: { track: a.get(x.item.id)!.track, start: a.get(x.item.id)!.start } }));
  const movedIds = new Set(moved.map((m) => m.id));
  const changed = [...b.values()].filter((x) => a.has(x.item.id) && !movedIds.has(x.item.id) && !same(a.get(x.item.id)!.item, x.item)).map((x) => x.item.id);
  const tracksAdded = after.tracks.filter((t) => !before.tracks.some((u) => u.id === t.id)).map((t) => t.id);
  const tracksRemoved = before.tracks.filter((t) => !after.tracks.some((u) => u.id === t.id)).map((t) => t.id);
  const mediaAdded = after.media.filter((m) => !before.media.some((x) => x.id === m.id)).map((m) => m.id);
  const mediaRemoved = before.media.filter((m) => !after.media.some((x) => x.id === m.id)).map((m) => m.id);
  return {
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(moved.length ? { moved } : {}),
    ...(changed.length ? { changed } : {}),
    ...(tracksAdded.length ? { tracksAdded } : {}),
    ...(tracksRemoved.length ? { tracksRemoved } : {}),
    ...(mediaAdded.length ? { mediaAdded } : {}),
    ...(mediaRemoved.length ? { mediaRemoved } : {}),
  };
}
