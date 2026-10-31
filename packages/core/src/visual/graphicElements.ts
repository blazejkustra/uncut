// A graphic's elements (D316). A graphic stays one item and one document; its elements are what the
// page shows with an id, with the times a scan measured (graphicScan.ts) or the file declares
// (data-at, data-out). Edits live on the item (`elements`), never in the file: graphic_write keeps
// old revisions, and two items of one file can differ. Both drawers pass them to the document in
// render's info (graphicInfo), and the document's bootstrap (GRAPHIC_ELEMENTS_BOOT) applies them
// around the author's render(t), which knows nothing about them: a retimed element is the page drawn
// at its own time and swapped in for that frame, so timing buried in a script can still be changed.
import type { FieldSet, Frame, GraphicElementEdit, Id, Item, Op } from "../timeline/types.ts";
import type { ScannedElement } from "./graphicScan.ts";

/** One element on the graphic's own time (frames from the graphic's start). */
export interface GraphicElement {
  readonly key: string;
  readonly name: string;
  readonly kind: "text" | "image" | "drawing" | "box";
  readonly parent?: string;
  /** Where it is in the file: the graphic's own frames [from, to). */
  readonly from: readonly [Frame, Frame];
  readonly text?: string;
  /** Its text can be replaced: nothing but text and inline markup inside. */
  readonly plain?: boolean;
  readonly timing: "declared" | "measured";
}

export interface GraphicElements {
  readonly elements: ReadonlyArray<GraphicElement>;
  /** Why the graphic stays one block, in words for the UI; undefined when it has elements. */
  readonly reason?: string;
}

/** Scene-long wrappers cover at least this share of the graphic: they hold elements and aren't one. */
const WRAPPER_SHARE = 0.9;
/** A child this close to its parent's span (frames at each end, the scan's grid) moves with it and isn't listed. */
const SAME_SPAN_FRAMES = 3;

const kindOf = (tag: string, text: string): GraphicElement["kind"] => {
  if (tag === "img" || tag === "video") return "image";
  if (tag === "canvas" || tag === "svg" || tag === "path" || tag === "rect" || tag === "circle") return "drawing";
  return text ? "text" : "box";
};

const shortName = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
};

const spanOf = (e: ScannedElement, ts: ReadonlyArray<number>, fps: number, duration: Frame): readonly [Frame, Frame] | undefined => {
  if (e.at !== undefined) return [Math.round(e.at * fps), Math.round((e.out ?? duration / fps) * fps)];
  if (!e.runs.length) return undefined;
  const step = ts.length > 1 ? ts[1]! - ts[0]! : 0;
  const first = ts[e.runs[0]![0]]!;
  const last = ts[e.runs.at(-1)![1]]!;
  const from = first <= ts[0]! ? 0 : Math.max(0, Math.floor((first - step) * fps));
  const to = last >= ts.at(-1)! ? duration : Math.min(duration, Math.ceil((last + step) * fps) + 1);
  return [from, to];
};

/**
 * The elements a scan found, in order of appearance: wrappers that stay on screen while their
 * children come and go are left out (their children are the elements), so are children that come
 * and go with their parent, and a canvas with no time of its own. Declared elements (data-at) are
 * all there is when a file has any: its author said what its pieces are.
 */
export function graphicElementsFrom(scan: ReadonlyArray<ScannedElement>, ts: ReadonlyArray<number>, fps: number, duration: Frame): GraphicElements {
  const declared = scan.some((e) => e.at !== undefined);
  const spans = new Map(scan.flatMap((e) => (spanOf(e, ts, fps, duration) ? [[e.key, spanOf(e, ts, fps, duration)!] as const] : [])));
  const byKey = new Map(scan.map((e) => [e.key, e]));
  const hasChild = new Set(scan.flatMap((e) => (e.parent ? [e.parent] : [])));
  const whole = (e: ScannedElement) => {
    const s = spans.get(e.key);
    return s !== undefined && s[1] - s[0] >= duration * WRAPPER_SHARE;
  };
  const wrapper = (e: ScannedElement) => whole(e) && hasChild.has(e.key);
  const parentOf = (e: ScannedElement): ScannedElement | undefined => {
    let p = e.parent ? byKey.get(e.parent) : undefined;
    while (p && wrapper(p)) p = p.parent ? byKey.get(p.parent) : undefined;
    return p;
  };
  const sameAsParent = (e: ScannedElement) => {
    const p = parentOf(e);
    if (!p) return false;
    const a = spans.get(e.key);
    const b = spans.get(p.key);
    return !!a && !!b && Math.abs(a[0] - b[0]) <= SAME_SPAN_FRAMES && Math.abs(a[1] - b[1]) <= SAME_SPAN_FRAMES;
  };
  const listed = scan.filter((e) => {
    if (!spans.has(e.key)) return false;
    if (declared) return e.at !== undefined;
    if (wrapper(e) || sameAsParent(e)) return false;
    return !(e.tag === "canvas" && whole(e));
  });
  const keys = new Set(listed.map((e) => e.key));
  const nearestListed = (e: ScannedElement) => {
    for (let p = e.parent ? byKey.get(e.parent) : undefined; p; p = p.parent ? byKey.get(p.parent) : undefined) if (keys.has(p.key)) return p.key;
    return undefined;
  };
  const elements = listed
    .map((e): GraphicElement => {
      const parent = nearestListed(e);
      const text = e.text.replace(/\s+/g, " ").trim();
      const kind = kindOf(e.tag, text);
      return {
        key: e.key,
        name: e.name ?? (text ? shortName(e.text) : e.key),
        kind,
        ...(parent ? { parent } : {}),
        from: spans.get(e.key)!,
        ...(text ? { text } : {}),
        ...(e.plain ? { plain: true } : {}),
        timing: e.at !== undefined ? "declared" : "measured",
      };
    })
    .sort((a, b) => a.from[0] - b.from[0] || b.from[1] - a.from[1]);
  const timed = elements.filter((e) => e.from[1] - e.from[0] < duration * WRAPPER_SHARE);
  if (timed.length >= 2) return { elements };
  const canvas = scan.some((e) => e.tag === "canvas");
  return {
    elements: [],
    reason: canvas
      ? "This graphic draws everything on one canvas, so its pieces have no times of their own. It stays one block: edit it as a whole, or ask the agent to rebuild it with separate elements."
      : "This graphic has no elements with an id that come and go, so it stays one block. Edit it as a whole, or ask the agent to rebuild it with separate elements.",
  };
}

/** Where an element is now, on the graphic's own frames: its edit's in and out, or where the file has it. */
export const elementSpan = (element: Pick<GraphicElement, "from">, edit?: GraphicElementEdit): readonly [Frame, Frame] =>
  edit?.in !== undefined && edit.out !== undefined ? [edit.in, edit.out] : element.from;

/**
 * The item's frame where the graphic's own frame `own` is shown (the inverse of graphicTime): `in`
 * and `skips` taken off; inside a skip, the frame right after it. May lie outside the item.
 */
export function itemFrameOf(item: Pick<Item, "in" | "skips">, own: Frame): Frame {
  let local = own - (item.in ?? 0);
  for (const s of [...(item.skips ?? [])].sort((a, b) => a.at - b.at)) {
    if (local < s.at) break;
    local = Math.max(s.at, local - s.frames);
  }
  return local;
}

export interface ElementBlock {
  readonly element: GraphicElement;
  /** Frames from the item's start, clipped to it. */
  readonly from: number;
  readonly to: number;
  readonly row: number;
}

/** The item's elements as blocks, each on the first row free at its start. Deleted ones and ones outside the item aren't drawn. */
export function elementBlocks(item: Item, elements: ReadonlyArray<GraphicElement>): ReadonlyArray<ElementBlock> {
  const ends: Array<number> = [];
  const blocks: Array<ElementBlock> = [];
  const spans = elements.flatMap((element) => {
    const edit = item.elements?.[element.key];
    if (edit?.hidden) return [];
    const [a, b] = elementSpan(element, edit);
    const from = Math.max(0, itemFrameOf(item, a));
    const to = Math.min(item.duration, itemFrameOf(item, b));
    return to > from ? [{ element, from, to }] : [];
  });
  for (const span of [...spans].sort((x, y) => x.from - y.from || y.to - x.to)) {
    const free = ends.findIndex((end) => end <= span.from);
    const row = free < 0 ? ends.length : free;
    ends[row] = span.to;
    blocks.push({ ...span, row });
  }
  return blocks;
}

/** What a change to an element sets; null clears a field. `in` and `out`: the graphic's own frames. */
export type ElementChange = {
  readonly [K in "in" | "out" | "text" | "color" | "x" | "y" | "scale" | "opacity" | "hidden"]?: GraphicElementEdit[K] | null;
};

const SHORTEST: Frame = 1;
/** An element's first and last moments keep their pace when its length changes. */
const HANDLE_SECONDS = 0.6;

const inkLength = (text: string) => text.replace(/\s/g, "").length;

function editedElement(element: Pick<GraphicElement, "from" | "text">, had: GraphicElementEdit, change: ElementChange): GraphicElementEdit {
  const next: Record<string, unknown> = { ...had };
  for (const [k, v] of Object.entries(change)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  const [a, b] = elementSpan(element, had);
  const at = "in" in change ? (change.in ?? element.from[0]) : a;
  const to = "out" in change ? (change.out ?? element.from[1]) : b;
  delete next.from;
  delete next.in;
  delete next.out;
  if (at !== element.from[0] || to !== element.from[1]) Object.assign(next, { from: element.from, in: at, out: Math.max(at + SHORTEST, to) });
  if (next.text === element.text) delete next.text;
  if (next.text !== undefined && element.text) next.sourceLength = inkLength(element.text);
  else delete next.sourceLength;
  return next as GraphicElementEdit;
}

/** The update_item that changes one element (all the item's edits in one revision); a change that brings an element back to the file's state drops its edit. */
export function planElementEdit(item: Pick<Item, "id" | "elements">, element: Pick<GraphicElement, "key" | "from" | "text">, change: ElementChange): Op {
  return planElementEdits(item, [{ element, change }]);
}

/** One update_item for several elements (one undoable revision). */
export function planElementEdits(
  item: { readonly id: Id; readonly elements?: Item["elements"] },
  edits: ReadonlyArray<{ readonly element: Pick<GraphicElement, "key" | "from" | "text">; readonly change: ElementChange }>,
): Op {
  const all: Record<string, GraphicElementEdit> = { ...item.elements };
  for (const { element, change } of edits) {
    const next = editedElement(element, all[element.key] ?? {}, change);
    if (Object.keys(next).length) all[element.key] = next;
    else delete all[element.key];
  }
  const set = (Object.keys(all).length ? { elements: all } : { elements: null }) as unknown as FieldSet;
  return { op: "update_item", item: item.id, set };
}

type Span = readonly [Frame, Frame];

/** The frame of the file shown at `shown` when span `file` plays over span `now`: GRAPHIC_ELEMENTS_BOOT's sourceTime in frames. */
function fileFrame(file: Span, now: Span, shown: number, fps: number) {
  const [a, b] = file;
  const [A, B] = now;
  const handle = Math.min(HANDLE_SECONDS * fps, (b - a) / 3);
  const span = B - A;
  if (span < handle * 2) return a + ((shown - A) * (b - a)) / span;
  if (shown < A + handle) return a + (shown - A);
  if (shown >= B - handle) return b - (B - shown);
  return a + handle + ((shown - A - handle) * (b - a - handle * 2)) / (span - handle * 2);
}

/** The inverse of fileFrame: where frame `own` of the file is shown. */
function shownFrame(file: Span, now: Span, own: number, fps: number) {
  const [a, b] = file;
  const [A, B] = now;
  const handle = Math.min(HANDLE_SECONDS * fps, (b - a) / 3);
  const span = B - A;
  if (span < handle * 2) return A + ((own - a) * span) / (b - a);
  if (own < a + handle) return A + (own - a);
  if (own >= b - handle) return B - (b - own);
  return A + handle + ((own - a - handle) * (span - handle * 2)) / (b - a - handle * 2);
}

type Listed = Pick<GraphicElement, "key" | "from" | "text" | "parent">;
export interface ElementEdit {
  readonly element: Listed;
  readonly change: ElementChange;
}

/** The elements inside `element`, each retimed as its parent's new span plays them: they are drawn in its clone. */
function followersOf(item: { readonly elements?: Item["elements"] }, elements: ReadonlyArray<Listed>, { element, change }: ElementEdit, fps: number) {
  const had = item.elements?.[element.key];
  const before = elementSpan(element, had);
  const after = elementSpan(element, editedElement(element, had ?? {}, change));
  if (before[0] === after[0] && before[1] === after[1]) return [];
  const byKey = new Map(elements.map((e) => [e.key, e]));
  const inside = (e: Listed) => {
    for (let p = e.parent; p !== undefined; p = byKey.get(p)?.parent) if (p === element.key) return true;
    return false;
  };
  const carried = (frame: Frame) => Math.round(shownFrame(element.from, after, fileFrame(element.from, before, frame, fps), fps));
  return elements.filter(inside).map((e): ElementEdit => {
    const [a, b] = elementSpan(e, item.elements?.[e.key]);
    const from = Math.max(0, carried(a));
    return { element: e, change: { in: from, out: Math.max(from + SHORTEST, carried(b)) } };
  });
}

/** One edit of these changes; a retimed element takes the elements inside it along, unless a change names them too. */
export function planElementChanges(
  item: { readonly id: Id; readonly elements?: Item["elements"] },
  elements: ReadonlyArray<Listed>,
  edits: ReadonlyArray<ElementEdit>,
  fps: number,
): Op {
  const named = new Set(edits.map((e) => e.element.key));
  const followers = edits.flatMap((edit) => followersOf(item, elements, edit, fps)).filter((f) => !named.has(f.element.key));
  const once = new Map(followers.map((f) => [f.element.key, f]));
  return planElementEdits(item, [...edits, ...once.values()]);
}

/** How one translate px moves an element on the canvas: x's move [0], [1], y's move [2], [3]. Ancestors scale or turn it. */
export type ElementBasis = readonly [number, number, number, number];
export const NO_BASIS: ElementBasis = [1, 0, 0, 1];

const FLAT = 1e-6;
const flattens = ([a, b, c, d]: ElementBasis) => Math.abs(a * d - b * c) < FLAT;

/** A basis to convert with: an element scaled to nothing at this frame, or one translate can't move, tells nothing. */
export const validBasis = (value: unknown): value is ElementBasis =>
  Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && !flattens(value as unknown as ElementBasis);

const TRANSLATE_PLACES = 100;
const tidy = (n: number) => Math.round(n * TRANSLATE_PLACES) / TRANSLATE_PLACES;

/** A translate as canvas px. */
export const onCanvas = ([a, b, c, d]: ElementBasis, x: number, y: number): readonly [number, number] => [a * x + c * y, b * x + d * y];

/** The translate that moves an element by canvas px (x, y). */
export function fromCanvas(basis: ElementBasis, x: number, y: number): readonly [number, number] {
  const [a, b, c, d] = basis;
  if (flattens(basis)) return [tidy(x), tidy(y)];
  const det = a * d - b * c;
  return [tidy((d * x - c * y) / det), tidy((a * y - b * x) / det)];
}

export interface ElementBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The part of a document's answer that is on the canvas; undefined if none is, or the answer isn't numbers. */
export function boxOnCanvas(rect: ElementBox | undefined, canvas: { readonly width: number; readonly height: number }): ElementBox | undefined {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return undefined;
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const width = Math.min(canvas.width, rect.x + rect.width) - x;
  const height = Math.min(canvas.height, rect.y + rect.height) - y;
  return width > 0 && height >= 0 ? { x, y, width, height } : undefined;
}

/** The edits as render's info carries them, each with its key, in key order; undefined when there are none. */
export function elementsInfo(item: Pick<Item, "elements">): ReadonlyArray<GraphicElementEdit & { readonly key: string }> | undefined {
  const entries = Object.entries(item.elements ?? {});
  if (!entries.length) return undefined;
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, edit]) => ({ key, ...edit }));
}

/**
 * window.__uncutElements, in the document's head. restore() puts the page back as render(t) left it
 * (before anything draws); frame(t, info, draw) draws frame t with info.elements applied, `draw(at)`
 * being one render(t) with its settling. Applied after the page's own frame, so they stay on any
 * script: a style sheet of !important rules for looks and deletions (the script's inline styles
 * lose to them, and translate and scale add to its transform), a clone of the element drawn at its
 * own time swapped in for the frame (the live node detached, back before the next render, so the
 * script's own references hold), a data-uncut-off mark outside its new span.
 */
export const GRAPHIC_ELEMENTS_BOOT = `(() => {
  // The first and last moments of an element keep their pace (its entrance and exit): what a new length changes is the middle.
  const HANDLE = 0.6;
  const sourceTime = (e, t, fps) => {
    const a = e.from[0] / fps, b = e.from[1] / fps, A = e.in / fps, B = e.out / fps;
    if (t < A || t >= B) return undefined;
    const handle = Math.min(HANDLE, (b - a) / 3), span = B - A;
    if (span < handle * 2) return a + ((t - A) * (b - a)) / span;
    if (t < A + handle) return a + (t - A);
    if (t >= B - handle) return b - (B - t);
    return a + handle + ((t - A - handle) * (b - a - handle * 2)) / (span - handle * 2);
  };
  const rule = (e) => {
    const sel = "#" + CSS.escape(e.key);
    const look = [];
    if (e.x !== undefined || e.y !== undefined) look.push("translate:" + (e.x ?? 0) + "px " + (e.y ?? 0) + "px!important");
    if (e.scale !== undefined) look.push("scale:" + e.scale + "!important");
    if (e.opacity !== undefined) look.push("filter:opacity(" + e.opacity + ")!important");
    if (e.color !== undefined) look.push("color:" + e.color + "!important");
    const rules = look.length ? [sel + "{" + look.join(";") + "}"] : [];
    if (e.hidden) rules.push(sel + "," + sel + " *{visibility:hidden!important}");
    return rules.join("");
  };
  let sheet;
  let sheetText = "";
  const setSheet = (text) => {
    if (text === sheetText) return;
    sheetText = text;
    if (!sheet) { sheet = document.createElement("style"); document.head.appendChild(sheet); }
    sheet.textContent = text;
  };
  const OFF = "[data-uncut-off],[data-uncut-off] *{visibility:hidden!important}";
  const canvases = (el) => (el.matches("canvas") ? [el] : [...el.querySelectorAll("canvas")]);
  const cloneOf = (el) => {
    const copy = el.cloneNode(true);
    const from = canvases(el), to = canvases(copy);
    from.forEach((c, i) => { try { to[i].getContext("2d").drawImage(c, 0, 0); } catch {} });
    if (getComputedStyle(el).visibility === "visible") copy.style.visibility = "visible";
    return copy;
  };
  const typed = (e, shown) => {
    const ink = shown.replace(/\\s/g, "").length;
    if (!e.sourceLength || ink >= e.sourceLength) return e.text;
    return e.text.slice(0, Math.round((ink / e.sourceLength) * e.text.length));
  };
  let undo = [];
  const restore = () => { for (const f of undo.reverse()) f(); undo = []; };
  const depth = (el) => { let n = 0; for (let a = el; a; a = a.parentElement) n++; return n; };
  const frame = async (t, info, draw) => {
    const edits = info.elements;
    setSheet(edits.some((e) => e.in !== undefined) ? OFF + edits.map(rule).join("") : edits.map(rule).join(""));
    const groups = new Map();
    const off = [];
    const swapped = [];
    for (const e of edits) {
      if (e.hidden) continue;
      const retimed = e.in !== undefined && e.out !== undefined && e.from;
      const at = retimed ? sourceTime(e, t, info.fps) : t;
      if (at === undefined) { off.push(e); continue; }
      if (Math.abs(at - t) < 1e-6) { if (e.text !== undefined) swapped.push({ e, at: t }); continue; }
      const key = at.toFixed(6);
      if (!groups.has(key)) groups.set(key, { at, list: [] });
      groups.get(key).list.push(e);
    }
    const copies = new Map();
    const take = (e) => {
      const el = document.getElementById(e.key);
      if (el) copies.set(e.key, { e, el, copy: cloneOf(el) });
    };
    for (const g of groups.values()) {
      await draw(g.at);
      await window.__uncutMedia.held();
      g.list.forEach(take);
    }
    await draw(t);
    swapped.forEach((s) => take(s.e));
    const order = [...copies.values()].sort((a, b) => depth(a.el) - depth(b.el));
    for (const { e, copy } of order) {
      if (e.text !== undefined) copy.textContent = typed(e, (copy.textContent || "").trim());
      const live = document.getElementById(e.key);
      if (!live) continue;
      live.replaceWith(copy);
      undo.push(() => copy.replaceWith(live));
    }
    for (const e of off) {
      const live = document.getElementById(e.key);
      if (!live) continue;
      live.setAttribute("data-uncut-off", "");
      undo.push(() => live.removeAttribute("data-uncut-off"));
    }
  };
  const shown = (el) => {
    let o = 1;
    for (let a = el; a; a = a.parentElement) o *= Number(getComputedStyle(a).opacity);
    return o >= 0.02;
  };
  const thinAt = (x, y, keys, slop) => {
    let best, gap = Infinity;
    for (const key of keys) {
      const r = rectOf(key);
      if (!r || !r.width || !r.height || Math.min(r.width, r.height) >= slop * 2) continue;
      const d = Math.hypot(Math.max(r.x - x, 0, x - r.x - r.width), Math.max(r.y - y, 0, y - r.y - r.height));
      if (d <= slop && d < gap) { best = key; gap = d; }
    }
    return best;
  };
  const keyAt = (x, y, keys) => {
    const known = new Set(keys);
    for (const hit of document.elementsFromPoint(x, y)) {
      for (let a = hit; a; a = a.parentElement) if (a.id && known.has(a.id) && shown(a)) return a.id;
    }
    return undefined;
  };
  const rectOf = (key) => {
    const el = document.getElementById(key);
    if (!el || getComputedStyle(el).visibility !== "visible" || !shown(el)) return undefined;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const PROBE = 100;
  const basisOf = (el) => {
    const was = [el.style.getPropertyValue("translate"), el.style.getPropertyPriority("translate")];
    const [tx = 0, ty = 0] = getComputedStyle(el).translate.split(" ").map(parseFloat).map((n) => n || 0);
    const at = (x, y) => {
      el.style.setProperty("translate", x + "px " + y + "px", "important");
      return el.getBoundingClientRect();
    };
    const base = at(tx, ty), right = at(tx + PROBE, ty), down = at(tx, ty + PROBE);
    el.style.setProperty("translate", was[0], was[1]);
    return [(right.x - base.x) / PROBE, (right.y - base.y) / PROBE, (down.x - base.x) / PROBE, (down.y - base.y) / PROBE];
  };
  addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.uncut !== "element-ask") return;
    const key = d.point ? thinAt(d.point[0], d.point[1], d.keys ?? [], d.slop ?? 0) ?? keyAt(d.point[0], d.point[1], d.keys ?? []) : d.key;
    const rect = key === undefined ? undefined : rectOf(key);
    const basis = rect && !d.point ? basisOf(document.getElementById(key)) : undefined;
    parent.postMessage({ uncut: "element-answer", seq: d.seq, key, rect, basis }, "*");
  });
  window.__uncutElements = { restore, frame, clear: () => setSheet("") };
})();`;
