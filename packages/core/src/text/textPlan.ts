// Inserting text in a look (D80), shared by the Text tab's grid (renderer) and the agent's
// insert_text op (server): the item gets the look's size, weight, position and moves (the rest of
// the look stays a fallback, so "reset to preset" and later look changes apply), plus the looks in
// its `with` (a kicker above a title) on their own free text tracks. One edit, so one undo.
// Browser-safe.
import { TEXT_STYLES, type TextLook } from "./looks.ts";
import { safeMargin } from "../visual/render.ts";
import type { FieldSet, Item, Op, Project, TextStyle, TimedModule, Track } from "../timeline/types.ts";

export interface InsertTextRequest {
  /** A text-style module id (a look), e.g. text.big-title. */
  readonly look: string;
  readonly text?: string;
  readonly start: number;
  readonly duration: number;
  /** The new item's id (default: idBase numbered, e.g. big-title-1). Refused when the project already uses it. */
  readonly id?: string;
  /** The base of a numbered id (default: the look's name without "text.": big-title → big-title-1). */
  readonly idBase?: string;
  /** Style fields over the look's (canvas px; false removes a stroke/shadow/box the look has). */
  readonly style?: Partial<TextStyle>;
  /** Position / box over the look's (canvas px). */
  readonly transform?: { readonly x?: number; readonly y?: number; readonly w?: number };
  /** In / out moves instead of the look's (null: none). */
  readonly animation?: { readonly in?: TimedModule; readonly out?: TimedModule } | null;
  /** Leave out the looks in `with` (only this one). */
  readonly alone?: boolean;
}

export type InsertTextPlan = { readonly ops: Array<Op>; readonly itemId: string; readonly itemIds: ReadonlyArray<string> } | { readonly problem: string };

/** An id nothing in the project (or `taken`) uses: base-1, base-2, … */
function freeId(project: Pick<Project, "media" | "tracks" | "scenes">, base: string, taken: Set<string>) {
  const ids = new Set([...taken, ...project.media.map((m) => m.id), ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]), ...(project.scenes ?? []).map((s) => s.id)]);
  for (let n = 1; ; n++) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A look's item fields on this canvas: transform, the style the item stores and its moves (frames). */
export function lookItem(look: TextLook, project: Pick<Project, "canvas" | "theme">, duration: number) {
  const { width, height, fps } = project.canvas;
  const margin = safeMargin(project);
  const transform = look.span
    ? { x: margin, y: Math.round(height * look.y), w: width - 2 * margin }
    : { x: Math.round(width * look.x), y: Math.round(height * look.y), ...(look.w !== undefined ? { w: Math.round(width * look.w) } : {}) };
  const style = { preset: look.id, size: Math.round(height * look.size), weight: look.weight };
  const move = (m: { module: string; seconds: number; params?: { readonly [key: string]: unknown } } | undefined): TimedModule | undefined =>
    m ? { module: m.module, duration: Math.max(1, Math.min(duration, Math.round(m.seconds * fps))), ...(m.params ? { params: m.params } : {}) } : undefined;
  const inMove = move(look.animation?.in);
  const outMove = move(look.animation?.out);
  const animation = inMove || outMove ? { ...(inMove ? { in: inMove } : {}), ...(outMove ? { out: outMove } : {}) } : undefined;
  return { transform, style, animation };
}

/**
 * Text in a look at [start, start + duration): on the top-most unlocked text track free for that
 * stretch (tracks top to bottom as the timeline shows them), else a new text track on top. The
 * looks in its `with` follow, each on the next free (or a new) text track.
 */
export function planInsertText(project: Pick<Project, "canvas" | "theme" | "tracks" | "media" | "scenes">, req: InsertTextRequest): InsertTextPlan {
  const look = TEXT_STYLES[req.look];
  if (!look) return { problem: `There's no text look called ${req.look}. modules_list with kind "text-style" lists them.` };
  if (!Number.isInteger(req.start) || req.start < 0 || !Number.isInteger(req.duration) || req.duration < 1) return { problem: "start must be a frame (0 or more) and duration at least 1 frame." };
  const { start, duration } = req;
  const ops: Array<Op> = [];
  const taken = new Set<string>();
  // A requested id is reserved first, so a new track can't take it.
  if (req.id !== undefined) {
    const used = [...project.media.map((m) => m.id), ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]), ...(project.scenes ?? []).map((s) => s.id)];
    if (used.includes(req.id)) return { problem: `The id "${req.id}" is already used in this project: pick another, or leave id out.` };
    taken.add(req.id);
  }
  // Tracks as the timeline shows them, with what this plan puts on them. Hidden ones are skipped
  // (text added there wouldn't show).
  const tracks: Array<{ id: string; locked?: boolean; spans: Array<[number, number]> }> = project.tracks
    .filter((t: Track) => t.kind === "text" && !t.hidden)
    .map((t) => ({ id: t.id, ...(t.locked ? { locked: true } : {}), spans: t.items.map((i): [number, number] => [i.start ?? 0, (i.start ?? 0) + i.duration]) }));
  let textTracks = project.tracks.filter((t) => t.kind === "text").length;
  const place = (): string => {
    const free = tracks.find((t) => !t.locked && t.spans.every(([a, b]) => b <= start || start + duration <= a));
    if (free) {
      free.spans.push([start, start + duration]);
      return free.id;
    }
    const id = freeId(project, "text", taken);
    taken.add(id);
    textTracks += 1;
    ops.push({ op: "add_track", index: 0, track: { id, kind: "text", name: `Text ${textTracks}` } } as Op);
    tracks.unshift({ id, spans: [[start, start + duration]] });
    return id;
  };
  const base = lookItem(look, project, duration);
  const transform = { ...base.transform, ...(req.transform ?? {}) };
  const style = { ...base.style, ...(req.style ?? {}) };
  const animation = req.animation === null ? undefined : req.animation ?? base.animation;
  const trackId = place();
  const itemId = req.id ?? freeId(project, req.idBase ?? req.look.replace(/^text\./, ""), taken);
  taken.add(itemId);
  const item: Item = { id: itemId, type: "text", start, duration, text: req.text ?? look.text, transform, style: style as Item["style"], ...(animation ? { animation } : {}) };
  ops.push({ op: "insert_item", track: trackId, item } as Op);
  const itemIds = [itemId];
  if (!req.alone) {
    for (const extra of look.with ?? []) {
      const other = TEXT_STYLES[extra.look];
      if (!other) continue;
      const fields = lookItem(other, project, duration);
      const id = freeId(project, extra.look.replace(/^text\./, ""), taken);
      taken.add(id);
      const y = Math.round(transform.y + (extra.dy ?? 0) * project.canvas.height);
      const t = other.span ? { ...fields.transform, y } : { ...fields.transform, x: transform.x, y };
      const companion: Item = { id, type: "text", start, duration, text: extra.text, transform: t, style: fields.style, ...(animation ? { animation } : req.animation !== null && fields.animation ? { animation: fields.animation } : {}) };
      ops.push({ op: "insert_item", track: place(), item: companion } as Op);
      itemIds.push(id);
    }
  }
  return { ops, itemId, itemIds };
}

/** The style an item gets back from "reset to preset": the look's size and weight, every other field the look's again. */
export function resetLookFields(look: TextLook, project: Pick<Project, "canvas" | "theme">, duration: number): FieldSet {
  const { transform, style } = lookItem(look, project, duration);
  return { style, transform } as FieldSet;
}
