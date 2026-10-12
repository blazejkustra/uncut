// Text and background editing (phase 4 chunk 4, D53): pure planners for the text Inspector, the
// on-canvas drag and inline edit, and the Elements tab's backgrounds. Like the timeline's (D52),
// every gesture becomes one project.edit, so it is validated, undoes in one step and is listed in
// the agent's next note. update_item replaces nested objects whole, so every plan here sends the
// complete style / transform / animation / props, built from the item as it is now.
import { SOLID, safeMargin, textLook, TEXT_STYLES, themeColors, type RenderTarget } from "@uncut/core/render";
import type { FieldSet, Item, TimedModule } from "@uncut/core/types";

import { findItem, lockOf, type Plan } from "./edit.ts";
import { displayTracks, uniqueId, type ProjectModel, type Track } from "./project.ts";

type Problem = { readonly problem: string };
type Style = NonNullable<Item["style"]>;
type Transform = NonNullable<Item["transform"]>;

/** A text item's position, size and box, with the preset's fallbacks filled in. */
export function textBox(item: Item, canvas: { readonly width: number; readonly height: number }) {
  const look = textLook(item.style?.preset);
  return {
    x: Math.round(item.transform?.x ?? canvas.width * look.x),
    y: Math.round(item.transform?.y ?? canvas.height * look.y),
    w: item.transform?.w,
    size: Math.round(item.style?.size ?? canvas.height * look.size),
    weight: item.style?.weight ?? look.weight,
    color: item.style?.color ?? look.color,
    align: item.style?.align ?? look.align ?? "left",
  };
}

/** One update_item on an editable item, or why it can't be edited. */
export function planUpdate(project: ProjectModel, itemId: string, set: FieldSet, summary: string): Plan | Problem {
  const placed = findItem(project, itemId);
  if (!placed) return { problem: "That item isn't in the project any more." };
  const locked = lockOf(placed);
  if (locked) return { problem: locked };
  if (!Object.keys(set).length) return { ops: [], summary };
  return { ops: [{ op: "update_item", item: itemId, set }], summary };
}

/** The item with `id` now, for planners that build a whole nested object from it. */
const itemOf = (project: ProjectModel, id: string) => findItem(project, id)?.item;

/** New text (markup as typed). Unchanged text plans nothing. */
export function planText(project: ProjectModel, itemId: string, text: string): Plan | Problem {
  const item = itemOf(project, itemId);
  if (item && item.text === text) return { ops: [], summary: "" };
  return planUpdate(project, itemId, { text }, "Edit text");
}

const clampWeight = (w: number) => Math.min(900, Math.max(100, Math.round(w / 100) * 100));

/**
 * Style fields merged into the item's style. A null removes the field (so the preset's look
 * applies again). Size is clamped to at least 1 canvas pixel, weight to 100–900 in hundreds,
 * the schema's limits, so a slider can't make an edit the server refuses.
 */
export function planStyle(project: ProjectModel, itemId: string, patch: { readonly [K in keyof Style]?: Style[K] | null }, summary = "Restyle text"): Plan | Problem {
  const item = itemOf(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  const style: Record<string, unknown> = { ...(item.style ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete style[k];
    else if (k === "size") style[k] = Math.max(1, Math.round(v as number));
    else if (k === "weight") style[k] = clampWeight(v as number);
    else style[k] = v;
  }
  if (JSON.stringify(style) === JSON.stringify(item.style ?? {})) return { ops: [], summary };
  return planUpdate(project, itemId, { style: Object.keys(style).length ? style : null }, summary);
}

/**
 * A built-in text style: the preset and its size and weight (scaled to the canvas); fields that
 * only the preset defines (font, tracking, line height) are dropped so its look shows. Colour,
 * alignment and position stay: they're the user's.
 */
export function planPreset(project: ProjectModel, itemId: string, preset: string): Plan | Problem {
  const look = TEXT_STYLES[preset];
  if (!look) return { problem: `There's no text style called ${preset}.` };
  return planStyle(project, itemId, { preset, size: project.canvas.height * look.size, weight: look.weight, font: null, tracking: null, lineHeight: null }, `Style text as ${look.name}`);
}

/** Position and box width merged into the transform (a null w makes the box fit its text). */
export function planTransform(project: ProjectModel, itemId: string, patch: { readonly x?: number; readonly y?: number; readonly w?: number | null }, summary = "Move text"): Plan | Problem {
  const item = itemOf(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  const box = textBox(item, project.canvas);
  const transform: Record<string, unknown> = { ...(item.transform ?? {}), x: box.x, y: box.y };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || (k === "w" && (v as number) <= 0)) delete transform[k];
    else transform[k] = Math.round(v as number);
  }
  if (JSON.stringify(transform) === JSON.stringify(item.transform ?? {})) return { ops: [], summary };
  return planUpdate(project, itemId, { transform: transform as Transform }, summary);
}

/**
 * "Centre on the canvas": the box spans the canvas between the safe margins and the lines are
 * centred, so the text stays centred whatever it says (no measuring involved).
 */
export function planCentre(project: ProjectModel, itemId: string): Plan | Problem {
  const margin = safeMargin(project);
  const item = itemOf(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  const transform = { ...(item.transform ?? {}), x: margin, y: textBox(item, project.canvas).y, w: project.canvas.width - 2 * margin };
  const style = { ...(item.style ?? {}), align: "center" as const };
  return planUpdate(project, itemId, { transform, style }, "Centre text");
}

export type AnimationSlot = "in" | "out";
/** The moves the Inspector offers: the built-in move modules the preview draws (core DRAWN_MOVES). */
export const MOVES = [
  { id: "", label: "None" },
  { id: "move.fade", label: "Fade" },
  { id: "move.rise", label: "Rise" },
  { id: "move.slide-left", label: "Slide left" },
  { id: "move.wipe", label: "Wipe" },
] as const;

/**
 * Set or clear the in or out animation. The duration is clamped to 1 frame…the item's length
 * (the rule the validator checks); clearing the last one removes `animation` altogether.
 */
export function planAnimation(project: ProjectModel, itemId: string, slot: AnimationSlot, move: TimedModule | null): Plan | Problem {
  const item = itemOf(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  const animation: Record<string, TimedModule> = { ...((item.animation ?? {}) as Record<string, TimedModule>) };
  if (move?.module) animation[slot] = { ...move, duration: Math.max(1, Math.min(item.duration, Math.round(move.duration))) };
  else delete animation[slot];
  if (JSON.stringify(animation) === JSON.stringify(item.animation ?? {})) return { ops: [], summary: "" };
  const words = move?.module ? `${MOVES.find((m) => m.id === move.module)?.label ?? move.module} ${slot}` : `no ${slot} animation`;
  return planUpdate(project, itemId, { animation: Object.keys(animation).length ? animation : null }, `Animate text: ${words.toLowerCase()}`);
}

/** Wrap the selection in [[accent]] markup, or unwrap it if it already is. Returns the new text and selection. */
export function toggleAccent(text: string, from: number, to: number): { text: string; from: number; to: number } {
  const before = text.slice(0, from);
  const inner = text.slice(from, to);
  const after = text.slice(to);
  if (before.endsWith("[[") && after.startsWith("]]")) return { text: before.slice(0, -2) + inner + after.slice(2), from: from - 2, to: to - 2 };
  if (inner.startsWith("[[") && inner.endsWith("]]") && inner.length >= 4) return { text: before + inner.slice(2, -2) + after, from, to: to - 4 };
  if (from === to) {
    // Nothing selected: accent the word under the caret, if any.
    const start = before.search(/\S+$/);
    const end = after.search(/\s|$/);
    if (start === -1 && end <= 0) return { text, from, to };
    const s = start === -1 ? from : start;
    const e = to + Math.max(0, end);
    return toggleAccent(text, s, e);
  }
  return { text: `${before}[[${inner}]]${after}`, from: from + 2, to: to + 2 };
}

/** Colours offered in the Inspector and the Elements tab: the theme's tokens, then a few plain ones. */
export function swatches(project: RenderTarget): Array<{ readonly value: string; readonly css: string; readonly label: string }> {
  const theme = themeColors(project);
  const tokens = Object.entries(theme).map(([token, css]) => ({ value: token, css, label: `Theme ${token}` }));
  const plain = [
    { value: "#FFFFFF", css: "#FFFFFF", label: "White" },
    { value: "#000000", css: "#000000", label: "Black" },
    { value: "#0B1D3A", css: "#0B1D3A", label: "Dark blue" },
    { value: "#F5C26B", css: "#F5C26B", label: "Amber" },
  ].filter((p) => !tokens.some((t) => t.css.toLowerCase() === p.css.toLowerCase()));
  return [...tokens, ...plain];
}

/** The Elements tab's backgrounds: a colour or a gradient (component.solid props). */
export const BACKGROUNDS = [
  { id: "theme", label: "Theme", props: { color: "bg" } },
  { id: "black", label: "Black", props: { color: "#000000" } },
  { id: "white", label: "White", props: { color: "#FFFFFF" } },
  { id: "dark-blue", label: "Dark blue", props: { color: "#0B1D3A" } },
  { id: "dusk", label: "Dusk", props: { color: "#0B1D3A", to: "#3B1E54", angle: 160 } },
  { id: "ember", label: "Ember", props: { color: "#1A0F0A", to: "#5A2A12", angle: 180 } },
] as const;
export type BackgroundProps = { readonly color: string; readonly to?: string; readonly angle?: number };

const BACKGROUND_SECONDS = 3;

export type PlannedAdd = (Plan & { readonly itemId: string; readonly start: number }) | Problem;

/**
 * A background (component.solid) under the text, D53. Its time: the selected text item's (so
 * "select the title, add a background" makes a title card), else 3 s at the playhead. Where:
 * at the end of the main track when that's where the time starts (an empty project, or the
 * playhead at main's end): a card in the sequence. Otherwise on a free video track above main
 * and below every text track (the nearest one free for that stretch), so it covers the footage
 * under it and stays below the text; if none is free, a new "Background" track goes directly
 * above main.
 */
export function planAddBackground(project: ProjectModel, props: BackgroundProps, frame: number, selected: string | undefined): PlannedAdd {
  const fps = project.canvas.fps;
  const sel = findItem(project, selected);
  const start = sel && sel.item.type === "text" ? sel.start : Math.max(0, Math.floor(frame));
  const duration = sel && sel.item.type === "text" ? sel.item.duration : BACKGROUND_SECONDS * fps;
  const mainIndex = project.tracks.findIndex((t) => t.role === "main");
  const main = project.tracks[mainIndex];
  if (!main) return { problem: "This project has no main track." };
  const mainEnd = main.items.reduce((n, i) => n + i.duration, 0);
  const taken = new Set<string>();
  const itemId = uniqueId(project, "background", taken);
  taken.add(itemId);
  const item: Item = { id: itemId, type: "component", component: SOLID, duration, props: { ...props } };
  if (start === mainEnd && !main.locked) {
    return { ops: [{ op: "insert_item", track: main.id, item }], summary: "Add a background", itemId, start };
  }
  const free = (t: Track) => t.items.every((i) => (i.start ?? 0) + i.duration <= start || start + duration <= (i.start ?? 0));
  // Video tracks between the lowest text track above main and main, nearest first (the project
  // lists tracks top to bottom, and the preview and export stack them in that order): a
  // background on a track above a text track would cover that text.
  const lastText = project.tracks.slice(0, mainIndex).reduce((n, t, i) => (t.kind === "text" ? i : n), -1);
  const above = project.tracks.slice(lastText + 1, mainIndex).filter((t) => t.kind === "video" && !t.locked).reverse();
  const track = above.find(free);
  const ops: Array<Plan["ops"][number]> = [];
  let trackId = track?.id;
  if (!trackId) {
    trackId = uniqueId(project, "background-track", taken);
    const n = displayTracks(project).filter((t) => t.kind === "video" && t.role !== "main").length;
    ops.push({ op: "add_track", index: mainIndex, track: { id: trackId, kind: "video", name: n ? `Background ${n + 1}` : "Background" } });
  }
  ops.push({ op: "insert_item", track: trackId, item: { ...item, start } });
  return { ops, summary: "Add a background", itemId, start };
}

/** A background's colours (props merged; a null `to` makes it a plain colour again). */
export function planBackground(project: ProjectModel, itemId: string, patch: { readonly color?: string; readonly to?: string | null; readonly angle?: number | null }): Plan | Problem {
  const item = itemOf(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  const props: Record<string, unknown> = { ...(item.props ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete props[k];
    else props[k] = k === "angle" ? Math.round(v as number) : v;
  }
  if (props.to === undefined) delete props.angle;
  if (JSON.stringify(props) === JSON.stringify(item.props ?? {})) return { ops: [], summary: "" };
  return planUpdate(project, itemId, { props }, "Change the background");
}

export interface Guide {
  readonly axis: "x" | "y";
  /** Canvas pixels. */
  readonly at: number;
  readonly kind: "centre" | "margin";
}

/**
 * Snap a dragged box (canvas pixels) to the canvas's centre lines and safe margins: its centre to
 * the centre, its edges to the margins, whichever is nearest within `threshold`. Returns the
 * snapped corner and the guides to draw.
 */
export function snapBox(box: { x: number; y: number; w: number; h: number }, target: RenderTarget, threshold: number): { x: number; y: number; guides: Array<Guide> } {
  const { width, height } = target.canvas;
  const margin = safeMargin(target);
  const guides: Array<Guide> = [];
  const axis = (pos: number, size: number, full: number, name: "x" | "y") => {
    const candidates: Array<[number, number, Guide["kind"]]> = [
      [full / 2 - size / 2, full / 2, "centre"],
      [margin, margin, "margin"],
      [full - margin - size, full - margin, "margin"],
    ];
    let best: [number, number, Guide["kind"]] | undefined;
    for (const c of candidates) if (Math.abs(c[0] - pos) <= threshold && (!best || Math.abs(c[0] - pos) < Math.abs(best[0] - pos))) best = c;
    if (!best) return pos;
    guides.push({ axis: name, at: best[1], kind: best[2] });
    return best[0];
  };
  return { x: Math.round(axis(box.x, box.w, width, "x")), y: Math.round(axis(box.y, box.h, height, "y")), guides };
}
