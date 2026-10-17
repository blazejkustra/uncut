// The runtime of uncut:lib/ui.js (uncutUI): puts a UI part (lifted from the real editor by
// scripts/ui-parts.ts) into a graphic as live DOM and applies props to it. scripts/ui-parts.ts strips
// the types and wraps this file with the captured DATA, so it must stay self-contained: no imports,
// nothing that runs at load but function declarations (graphic libraries are loaded into a VM by
// tests), no clocks or randomness (render(t) is a pure function of t). Every mount call puts the part
// in the same state for the same props, so frames can be drawn in any order.

/** One captured part: its markup, its size as drawn in the app, and the ancestors its CSS expects. */
interface UiPart {
  readonly html: string;
  readonly width: number;
  readonly height: number;
  readonly ancestors: ReadonlyArray<{ readonly tag: string; readonly cls: string; readonly attrs: Readonly<Record<string, string>>; readonly vars: string }>;
  readonly pxPerSecond?: number;
  /** The panel colour the part was drawn over, when its own background isn't opaque, and its corner radius. */
  readonly backdrop?: string;
  readonly radius?: string;
}
interface UiData {
  readonly css: string;
  readonly parts: Readonly<Record<string, UiPart>>;
  /** Pieces the parts share (icons, waveform images), referred to as \u0001i\u0002 in their markup. */
  readonly pool: ReadonlyArray<string>;
}
declare const DATA: UiData;

type Props = { readonly [key: string]: unknown };
type Root = HTMLElement & { __uiKey?: string; __uiName?: string };

/** Named slots per part: a name for the selectors a film reaches for most (find takes any selector too). */
const SLOTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  composer: { input: ".composer-box > textarea", text: ".composer-hl", context: ".composer-ctx", send: ".send", attach: ".composer-at", model: ".choice.model" },
  message: { text: ".msg-user" },
  turn: { reply: ".reply", steps: ".step", review: ".card-item" },
  storyboard: { summary: ".approval-text", beats: ".beats", beat: ".beat", approve: ".btn.primary", edit: ".approval-btns .btn.ghost" },
  review: { head: ".card-head", status: ".card-outcome", scores: ".scores", score: ".score", bar: ".score-bar > span" },
  timeline: { toolbar: ".bottom-toolbar", ruler: ".tl-ruler", lanes: ".tl-lanes", heads: ".tl-heads", playhead: ".playhead", clip: ".clip" },
  preview: { frame: ".frame", transport: ".transport", timecode: ".timecode", play: ".icon-btn.play" },
  export: { close: ".export-head .icon-btn", draft: '[data-testid="quality-draft"]', standard: '[data-testid="quality-standard"]', high: '[data-testid="quality-high"]', file: '[data-testid="export-name"]', motionBlur: 'input[type="checkbox"]', cancel: ".wiz-foot .btn.ghost", export: ".wiz-foot .btn.primary" },
  exportProgress: { bar: ".export-bar", fill: ".export-bar > div", cancel: '[data-testid="export-cancel"]' },
  topbar: { export: ".export-btn", saved: ".saved", title: ".project-title" },
  agent: { tabs: ".tabs", thread: ".agent-thread", composer: ".composer", send: ".send", plan: ".plan-chip-btn" },
  editor: { topbar: ".topbar", export: ".export-btn", rail: ".rail", library: ".library", preview: ".stage", frame: ".frame", side: ".side", composer: ".composer", send: ".send", thread: ".agent-thread", timeline: ".bottom", playhead: ".playhead" },
};

/** The part names there are. */
function parts(): Array<string> {
  return Object.keys(DATA.parts);
}

/** The slot names of part `name` (find takes them, and any CSS selector). */
function slots(name: string): Array<string> {
  part(name);
  return Object.keys(SLOTS[name] || {});
}

/** A part's size as drawn in the app, CSS px at scale 1: { width, height }. */
function size(name: string): { width: number; height: number } {
  const p = part(name);
  return { width: p.width, height: p.height };
}

function part(name: string): UiPart {
  const p = Object.hasOwn(DATA.parts, name) ? DATA.parts[name] : undefined;
  if (!p) throw new Error(`uncutUI: no part "${name}" (parts: ${parts().join(", ")})`);
  return p;
}

/** The parts' CSS (every rule scoped under .uncut-ui); mount adds it to the document once. */
function css(): string {
  return DATA.css;
}

function ensureCss(doc: Document) {
  if (doc.querySelector("style[data-uncut-ui]")) return;
  const style = doc.createElement("style");
  style.setAttribute("data-uncut-ui", "");
  style.textContent = DATA.css;
  (doc.head || doc.documentElement).appendChild(style);
}

const SHELL = "display:block;position:relative;width:100%;height:100%;margin:0;padding:0;border:0;background:none;box-shadow:none;outline:0;overflow:visible;transform:none;opacity:1;filter:none;backdrop-filter:none;inset:auto;min-width:0;min-height:0;max-width:none;max-height:none;";

/**
 * Puts part `name` into `host` (an element of the graphic) and applies `props`; returns the part's
 * root element. The first call builds it; a later call with other props rebuilds it from the
 * captured markup, so the same props always give the same picture. Common props: scale (1), width
 * and height (the part's box, CSS px before scale; default its size in the app), text { slot or
 * selector: string }, press { slot: scale } (uncutMotion.click's button scale), highlight (slot or
 * list: a selection ring), hide (slot or list), plus the part's own (see the header).
 */
function mount(host: HTMLElement, name: string, props?: Props): HTMLElement {
  const p = part(name);
  const o: Props = props || {};
  const doc = host.ownerDocument;
  ensureCss(doc);
  // scale is applied on every call, outside the key: a camera that scales a part doesn't rebuild it.
  const key = `${name}\n${keyOf({ ...o, scale: undefined })}`;
  let wrap = host.firstElementChild as Root | null;
  if (!wrap || wrap.__uiKey !== key) {
    const width = num(o.width, p.width);
    const height = num(o.height, p.height);
    wrap = doc.createElement("div") as Root;
    wrap.className = "uncut-ui";
    wrap.__uiKey = key;
    wrap.__uiName = name;
    wrap.setAttribute("data-part", name);
    let at: HTMLElement = wrap;
    for (const a of p.ancestors) {
      const shell = doc.createElement(a.tag);
      if (a.cls) shell.className = a.cls;
      for (const k of Object.keys(a.attrs)) shell.setAttribute(k, a.attrs[k]!);
      shell.setAttribute("style", SHELL + a.vars);
      at.appendChild(shell);
      at = shell;
    }
    const tpl = doc.createElement("template");
    tpl.innerHTML = p.html.replace(/\u0001(\d+)\u0002/g, (_m, i: string) => DATA.pool[Number(i)] ?? "");
    const root = tpl.content.firstElementChild as HTMLElement;
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    root.style.margin = "0";
    root.style.position = root.style.position || "relative";
    at.appendChild(root);
    const back = typeof o.background === "string" ? o.background : p.backdrop;
    wrap.style.cssText = `position:relative;width:${width}px;height:${height}px;transform-origin:0 0${back ? `;background:${back};border-radius:${p.radius || "0"}` : ""}`;
    applyProps(name, root, o);
    host.replaceChildren(wrap);
    // Panels scrolled in the app (the agent's thread at its newest turn) scroll back there.
    for (const el of wrap.querySelectorAll("[data-ui-scroll]")) el.scrollTop = Number(el.getAttribute("data-ui-scroll"));
  }
  wrap.style.transform = `scale(${num(o.scale, 1)})`;
  const root = rootOf(wrap);
  placeElements(name, root, o);
  return root;
}

function rootOf(wrap: HTMLElement): HTMLElement {
  let at: Element = wrap;
  while (at.firstElementChild) {
    const next: Element = at.firstElementChild;
    if (next.getAttribute("style")?.startsWith(SHELL)) at = next;
    else return next as HTMLElement;
  }
  return at as HTMLElement;
}

/** The props as a key (elements by identity are placed on every call, not keyed). */
function keyOf(o: Props): string {
  return JSON.stringify(o, (k, v) => (k && typeof v === "object" && v !== null && "nodeType" in v ? "[element]" : v));
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A slot of part `name` (or any CSS selector) inside root: the first match, or null. */
function find(root: Element, slot: string, name?: string): HTMLElement | null {
  const owner = name || partName(root);
  const sel = (owner && SLOTS[owner]?.[slot]) || slot;
  if (root.matches(sel)) return root as HTMLElement;
  return root.querySelector(sel) as HTMLElement | null;
}

/** Every match of a slot or selector inside root. */
function findAll(root: Element, slot: string, name?: string): Array<HTMLElement> {
  const owner = name || partName(root);
  const sel = (owner && SLOTS[owner]?.[slot]) || slot;
  return [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)] as Array<HTMLElement>;
}

function partName(el: Element): string | undefined {
  const wrap = el.closest(".uncut-ui") as Root | null;
  return wrap?.__uiName;
}

function list(v: unknown): Array<string> {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
}

function setText(el: Element | null, text: unknown) {
  if (el && text !== undefined && text !== null) el.textContent = String(text);
}

/** Set the first text node of el (a label with a child after it), adding one if there is none. */
function setLead(el: Element | null, text: string) {
  if (!el) return;
  const node = [...el.childNodes].find((n) => n.nodeType === 3);
  if (node) node.textContent = text;
  else el.insertBefore(el.ownerDocument.createTextNode(text), el.firstChild);
}

function applyProps(name: string, root: HTMLElement, o: Props) {
  const at = (slot: string) => find(root, slot, name);
  // The part's own props first, then the common ones (text, press, highlight, hide) over them.
  const own = PART_PROPS[name];
  if (own) own(root, o, name);
  const text = o.text as Readonly<Record<string, unknown>> | undefined;
  if (text && typeof text === "object") for (const k of Object.keys(text)) setText(at(k), text[k]);
  const press = o.press as Readonly<Record<string, unknown>> | undefined;
  if (press && typeof press === "object")
    for (const k of Object.keys(press)) {
      const el = at(k);
      if (el) {
        el.style.transform = `scale(${num(press[k], 1)})`;
        el.style.transformOrigin = "50% 50%";
      }
    }
  for (const k of list(o.highlight)) {
    const el = at(k);
    if (el) {
      el.style.boxShadow = "0 0 0 2px var(--select), 0 0 0 6px rgb(109 140 255 / 22%)";
      el.style.borderRadius = el.style.borderRadius || getRadius(el);
    }
  }
  for (const k of list(o.hide)) for (const el of findAll(root, k, name)) el.style.visibility = "hidden";
}

function getRadius(el: HTMLElement): string {
  const view = el.ownerDocument.defaultView;
  return (view && view.getComputedStyle(el).borderRadius) || "6px";
}

/** Props that place the author's own elements (the preview's picture), on every call. */
function placeElements(name: string, root: HTMLElement, o: Props) {
  const frame = name === "preview" || name === "editor" ? find(root, "frame", name) : null;
  const pic = name === "editor" ? (o.preview as Props | undefined)?.frame : o.frame;
  if (frame && pic && typeof pic === "object" && "nodeType" in pic && (pic as Node).parentNode !== frame) {
    const el = pic as HTMLElement;
    el.style.width = el.style.width || "100%";
    el.style.height = el.style.height || "100%";
    el.style.display = el.style.display || "block";
    frame.replaceChildren(el);
  }
}

/** Seconds as the editor's timecode, hh:mm:ss:ff at fps. */
function timecode(seconds: number, fps?: number): string {
  const f = fps || 60;
  const total = Math.max(0, Math.round(seconds * f));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / f / 3600))}:${pad(Math.floor(total / f / 60) % 60)}:${pad(Math.floor(total / f) % 60)}:${pad(total % f)}`;
}

const PART_PROPS: Readonly<Record<string, (root: HTMLElement, o: Props, name: string) => void>> = {
  composer(root, o) {
    if (o.text !== undefined && typeof o.text !== "object") {
      const value = String(o.text);
      const input = find(root, "input", "composer");
      const hl = find(root, "text", "composer");
      if (input) input.textContent = value;
      if (hl) hl.textContent = `${value}\u200b`;
      const send = find(root, "send", "composer");
      if (send) value.trim() ? send.removeAttribute("disabled") : send.setAttribute("disabled", "");
    }
    if (o.placeholder !== undefined) find(root, "input", "composer")?.setAttribute("placeholder", String(o.placeholder));
    if (o.caret) {
      const hl = find(root, "text", "composer");
      if (hl) {
        const caret = root.ownerDocument.createElement("span");
        caret.className = "uncut-ui-caret";
        const zw = hl.lastChild;
        if (zw && zw.nodeType === 3 && zw.textContent?.endsWith("\u200b")) zw.textContent = zw.textContent.slice(0, -1);
        hl.appendChild(caret);
        hl.appendChild(root.ownerDocument.createTextNode("\u200b"));
      }
    }
    if (o.context !== undefined) setText(find(root, "context", "composer")?.querySelector("span") ?? null, o.context);
  },
  message(root, o) {
    if (typeof o.text === "string") root.textContent = o.text;
  },
  turn(root, o) {
    if (typeof o.reply === "string") {
      const p = find(root, "reply", "turn")?.querySelector("p");
      setText(p ?? null, o.reply);
    }
    if (Array.isArray(o.steps)) fillList(root.querySelector(".worklog"), ".step", o.steps.map(String), (el, s) => setText(el.querySelector(".grow"), s));
  },
  storyboard(root, o) {
    if (typeof o.summary === "string") {
      const el = find(root, "summary", "storyboard");
      if (el) setLead(el, o.summary);
    }
    if (Array.isArray(o.beats)) {
      const beats = o.beats as ReadonlyArray<{ start?: number; end?: number; title?: string; lines?: ReadonlyArray<string> }>;
      fillList(find(root, "beats", "storyboard"), ".beat", beats, (el, b, i) => {
        setText(el.querySelector(".beat-time"), `${i + 1}. ${num(b.start, 0)} s to ${num(b.end, 0)} s`);
        setText(el.querySelector(".beat-head b"), b.title ?? "");
        const lines = [...el.querySelectorAll(".beat-line")];
        lines.forEach((line, j) => (b.lines && j < b.lines.length ? (line.textContent = b.lines[j]!) : b.lines && line.remove()));
      });
    }
    if (typeof o.count === "number") [...root.querySelectorAll(".beat")].forEach((el, i) => i >= (o.count as number) && el.remove());
  },
  review(root, o) {
    if (typeof o.status === "string") setText(find(root, "status", "review"), o.status);
    if (typeof o.title === "string") setText(find(root, "head", "review")?.querySelector(".grow") ?? null, o.title);
    const scores = o.scores as Readonly<Record<string, number>> | undefined;
    const fill = num(o.progress, 1);
    for (const row of findAll(root, "score", "review")) {
      const id = row.getAttribute("data-score") || "";
      const value = scores && typeof scores[id] === "number" ? scores[id]! : Number(row.getAttribute("data-value"));
      const bar = row.querySelector(".score-bar > span") as HTMLElement | null;
      if (bar) bar.style.width = `${Math.max(0, Math.min(1, fill)) * value * 10}%`;
      setText(row.querySelector(".score-value"), fill >= 1 || scores ? String(Math.round(value * Math.min(1, fill))) : row.querySelector(".score-value")?.textContent);
    }
  },
  timeline(root, o) {
    timelineProps(root, o, part("timeline").pxPerSecond || 60);
  },
  preview(root, o) {
    if (typeof o.time === "number") setLead(find(root, "timecode", "preview"), `${timecode(o.time)} / `);
  },
  export(root, o) {
    if (typeof o.quality === "string") {
      for (const q of ["draft", "standard", "high"]) {
        const card = find(root, q, "export");
        if (!card) continue;
        card.classList.toggle("active", q === o.quality);
        card.setAttribute("data-active", String(q === o.quality));
      }
    }
    if (typeof o.file === "string") find(root, "file", "export")?.setAttribute("value", o.file);
    if (typeof o.motionBlur === "boolean") {
      const box = find(root, "motionBlur", "export");
      if (box) o.motionBlur ? box.setAttribute("checked", "") : box.removeAttribute("checked");
    }
  },
  exportProgress(root, o) {
    if (typeof o.progress === "number") {
      const p = Math.max(0, Math.min(1, o.progress));
      const fill = find(root, "fill", "exportProgress");
      if (fill) fill.style.width = `${p * 100}%`;
      const label = find(root, "bar", "exportProgress")?.previousElementSibling ?? null;
      if (label) setLead(label, `${p >= 1 ? "Done" : "Rendering…"} ${Math.round(p * 100)}%`);
    }
    if (typeof o.eta === "number") {
      const label = find(root, "bar", "exportProgress")?.previousElementSibling?.querySelector(".muted") ?? null;
      setText(label, `About ${Math.max(1, Math.round(o.eta))} s left`);
    }
  },
  topbar(root, o) {
    if (typeof o.exportLabel === "string") setLead(find(root, "export", "topbar"), o.exportLabel);
  },
  agent(root, o) {
    nested(root, o, ["composer", "turn", "message", "review"]);
  },
  editor(root, o) {
    nested(root, o, ["composer", "turn", "message", "review", "timeline", "preview", "topbar"]);
  },
};

/** Sub-props of a part that contains others: { composer: {...}, timeline: {...} } applied inside it. */
function nested(root: HTMLElement, o: Props, names: ReadonlyArray<string>) {
  const sel: Readonly<Record<string, string>> = { composer: ".composer", turn: ".turn", message: ".msg-user", review: '.card-item[data-type="review"]', timeline: ".bottom", preview: ".stage", topbar: ".topbar" };
  for (const n of names) {
    const sub = o[n] as Props | undefined;
    const el = root.querySelector(sel[n]!) as HTMLElement | null;
    if (sub && typeof sub === "object" && el) applyProps(n, el, sub);
  }
}

/** Make container hold one copy of its first `selector` child per entry (cloned), each filled by fill. */
function fillList<T>(container: Element | null, selector: string, entries: ReadonlyArray<T>, fill: (el: Element, entry: T, i: number) => void) {
  if (!container) return;
  const existing = [...container.querySelectorAll(selector)];
  const tpl = existing[0];
  if (!tpl) return;
  const parent = tpl.parentElement!;
  existing.forEach((e) => e.remove());
  entries.forEach((entry, i) => {
    const el = tpl.cloneNode(true) as Element;
    fill(el, entry, i);
    parent.appendChild(el);
  });
}

interface Clip {
  readonly track?: string | number;
  readonly start?: number;
  readonly duration?: number;
  readonly name?: string;
  readonly image?: string;
  readonly selected?: boolean;
  readonly color?: string;
}

/** The timeline's props: clips (per track, seconds), playhead (seconds), selected (clip indexes). */
function timelineProps(root: HTMLElement, o: Props, pps: number) {
  const lanes = [...root.querySelectorAll(".tl-lane")] as Array<HTMLElement>;
  const heads = [...root.querySelectorAll(".tl-head")];
  const laneOf = (track: string | number | undefined): HTMLElement | undefined => {
    if (typeof track === "number") return lanes[track];
    if (typeof track === "string") {
      const i = heads.findIndex((h) => (h.querySelector(".name")?.textContent || "").trim().toLowerCase() === track.toLowerCase());
      return i >= 0 ? lanes[i] : lanes.find((l) => l.getAttribute("data-track") === track);
    }
    return lanes.find((l) => l.classList.contains("main"));
  };
  if (Array.isArray(o.clips)) {
    const clips = o.clips as ReadonlyArray<Clip>;
    // Templates: each lane's first clip (its kind's look), before the lanes are cleared.
    const templates = new Map<HTMLElement, Element>();
    const any = new Map<string, Element>();
    for (const lane of lanes) {
      const c = lane.querySelector(".clip");
      if (c) templates.set(lane, c);
      for (const k of ["video", "audio", "text"]) if (c?.classList.contains(k) && !any.has(k)) any.set(k, c);
    }
    const touched = new Set<HTMLElement>(clips.map((c) => laneOf(c.track)).filter((l): l is HTMLElement => !!l));
    for (const lane of touched) for (const c of lane.querySelectorAll(".clip")) c.remove();
    for (const c of clips) {
      const lane = laneOf(c.track);
      if (!lane) continue;
      const tpl = templates.get(lane) || any.get(lane.classList.contains("main") ? "video" : "audio") || any.values().next().value;
      if (!tpl) continue;
      const el = tpl.cloneNode(true) as HTMLElement;
      const start = num(c.start, 0);
      const dur = Math.max(0.05, num(c.duration, 1));
      el.style.left = `${start * pps}px`;
      el.style.width = `${Math.max(2, dur * pps - 2)}px`;
      el.classList.toggle("selected", !!c.selected);
      if (c.name !== undefined) setText(el.querySelector(".nm"), c.name);
      setText(el.querySelector(".meta"), `${dur.toFixed(1)}s`);
      for (const img of el.querySelectorAll("img")) (img as HTMLElement).style.width = "100%";
      const strip = el.querySelector(".strip") as HTMLElement | null;
      if (strip && c.image) {
        strip.style.backgroundImage = `url("${c.image}")`;
        strip.style.backgroundSize = "auto 100%";
        strip.style.backgroundRepeat = "repeat-x";
      }
      if (c.color) el.style.background = c.color;
      lane.appendChild(el);
    }
  }
  for (const i of list(o.selected)) root.querySelectorAll(".clip")[Number(i)]?.classList.add("selected");
  if (typeof o.playhead === "number") {
    const ph = root.querySelector(".playhead") as HTMLElement | null;
    if (ph) ph.style.left = `${o.playhead * pps}px`;
  }
}

/**
 * The pointer as macOS draws it (a black arrow with a white edge), its tip at (x, y) in host px:
 * { x, y, scale, down } (uncutMotion.click's cursor: scale 0.85 while pressed). Returns the element.
 */
function cursor(host: HTMLElement, o: { readonly x: number; readonly y: number; readonly scale?: number; readonly size?: number }): HTMLElement {
  const doc = host.ownerDocument;
  let el = host.querySelector(":scope > .uncut-ui-cursor") as HTMLElement | null;
  if (!el) {
    el = doc.createElement("div");
    el.className = "uncut-ui-cursor";
    el.innerHTML = CURSOR_SVG;
    host.appendChild(el);
  }
  const size = num(o.size, 28);
  el.style.cssText = `position:absolute;left:0;top:0;width:${size}px;height:${size * 1.5}px;pointer-events:none;z-index:1000;transform-origin:${size * 0.18}px ${size * 0.1}px;transform:translate(${o.x - size * 0.18}px,${o.y - size * 0.1}px) scale(${num(o.scale, 1)})`;
  return el;
}

const CURSOR_SVG = '<svg viewBox="0 0 20 30" width="100%" height="100%" style="display:block;overflow:visible;filter:drop-shadow(0 1px 1.5px rgb(0 0 0 / 35%))"><path d="M3.6 3 L3.6 24.2 L8.6 19.4 L11.9 27 L15.1 25.6 L11.9 18.2 L18.6 18.2 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

export {};
