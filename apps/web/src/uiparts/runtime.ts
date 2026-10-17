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
  composer: { box: ".composer-box", input: ".composer-box > textarea", text: ".composer-hl", context: ".composer-ctx", send: ".send", attach: ".composer-at", model: ".choice.model" },
  message: { text: ".msg-user" },
  turn: { reply: ".reply", steps: ".worklog", step: ".worklog .step", edit: ".edit-row", review: ".card-item" },
  storyboard: { summary: ".approval-text", beats: ".beats", beat: ".beat", approve: ".btn.primary", edit: ".approval-btns .btn.ghost" },
  review: { head: ".card-head", status: ".card-outcome", scores: ".scores", score: ".score", bar: ".score-bar > span" },
  timeline: { toolbar: ".bottom-toolbar", ruler: ".tl-ruler", lanes: ".tl-lanes", heads: ".tl-heads", playhead: ".playhead", clip: ".clip", lane: ".tl-lane", main: ".tl-lane.main" },
  preview: { frame: ".frame", transport: ".transport", timecode: ".timecode", play: ".icon-btn.play" },
  inspector: { title: ".insp-title", filter: '[data-testid="insp-filter"]', amount: '[data-testid="insp-filter-intensity"]', effects: '[data-testid="insp-effects"]', effect: '[data-testid="insp-effect"]', transform: '[data-testid="insp-sec-transform"]' },
  effects: { search: ".tr-search", target: '[data-testid="effects-target"]', filters: '[data-testid="filters-grid"]', tile: '[data-testid="filter-tile"]', none: '[data-look="none"]', natural: '[data-look="natural"]', warm: '[data-look="warm"]', cool: '[data-look="cool"]', vintage: '[data-look="vintage"]', film: '[data-look="film"]', bw: '[data-look="bw"]', vivid: '[data-look="vivid"]' },
  export: { close: ".export-head .icon-btn", draft: '[data-testid="quality-draft"]', standard: '[data-testid="quality-standard"]', high: '[data-testid="quality-high"]', file: '[data-testid="export-name"]', motionBlur: 'input[type="checkbox"]', cancel: ".wiz-foot .btn.ghost", export: ".wiz-foot .btn.primary" },
  exportProgress: { job: '[data-testid="export-job"]', progress: ".export-status", bar: ".export-bar", fill: ".export-bar > div", cancel: '[data-testid="export-cancel"]' },
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
  // scale, blur and dim are applied on every call, outside the key: a camera that scales a part doesn't
  // rebuild it. The editor's panels are live (see liveEditor): their props stay out of its key too.
  const stable: Record<string, unknown> = { ...o, scale: undefined, blur: undefined, dim: undefined };
  if (name === "editor") for (const k of EDITOR_LIVE_PROPS) stable[k] = undefined;
  const key = `${name}\n${keyOf(stable)}`;
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
    tpl.innerHTML = expand(p.html);
    const root = tpl.content.firstElementChild as HTMLElement;
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    root.style.margin = "0";
    root.style.position = root.style.position || "relative";
    at.appendChild(root);
    const back = typeof o.background === "string" ? o.background : p.backdrop;
    wrap.style.cssText = `position:relative;width:${width}px;height:${height}px;transform-origin:0 0${back ? `;background:${back};border-radius:${p.radius || "0"}` : ""}`;
    neutral(root);
    applyProps(name, root, name === "editor" ? { media: o.media } : o);
    host.replaceChildren(wrap);
    // Panels scrolled in the app (the agent's thread at its newest turn) scroll back there.
    for (const el of wrap.querySelectorAll("[data-ui-scroll]")) el.scrollTop = Number(el.getAttribute("data-ui-scroll"));
  }
  const scale = num(o.scale, 1);
  wrap.style.transform = `scale(${scale})`;
  // blur: screen px (the part's own px times its scale); dim 0..1 darkens it: the program behind a hero.
  const blur = Math.max(0, num(o.blur, 0));
  const dim = Math.max(0, Math.min(1, num(o.dim, 0)));
  wrap.style.filter = `${blur > 0.05 ? `blur(${(blur / Math.max(scale, 0.01)).toFixed(2)}px) ` : ""}${dim > 0.001 ? `brightness(${(1 - dim).toFixed(3)})` : ""}`.trim() || "none";
  const root = rootOf(wrap);
  if (name === "editor") liveEditor(root, o);
  placeElements(name, root, o);
  return root;
}

/** The editor's props that update its panels in place on every call (each panel rebuilt only when its own props change). */
const EDITOR_LIVE_PROPS = ["side", "library", "composer", "turn", "message", "review", "inspector", "effects", "timeline", "preview", "topbar", "export", "exportProgress", "text", "press", "highlight", "hide", "remove"];

type LiveRoot = HTMLElement & { __pristine?: Map<string, HTMLElement>; __liveKeys?: Map<string, string> };

/**
 * The editor as a live stage: each panel (the side panel, the library, the timeline, the preview,
 * the top bar, a dialog over it) is rebuilt from its pristine markup only when its props change,
 * so a film can move clips, grow the agent's steps, run the playhead or an export frame by frame
 * without rebuilding the window. side: "inspector" shows the Inspector tab in the side panel (its
 * props: inspector), library: "effects" the Effects panel (effects); export or exportProgress opens
 * that dialog over the window. text, press, highlight, hide and remove reach into every panel.
 */
function liveEditor(root: LiveRoot, o: Props) {
  const doc = root.ownerDocument;
  if (!root.__pristine) {
    root.__pristine = new Map();
    root.__liveKeys = new Map();
    for (const sel of [".side", ".library", ".bottom", ".stage", ".topbar"]) {
      const el = root.querySelector(sel) as HTMLElement | null;
      if (el) root.__pristine.set(sel, el.cloneNode(true) as HTMLElement);
    }
  }
  const sub = (k: string) => (o[k] && typeof o[k] === "object" ? (o[k] as Props) : undefined);
  const fresh = (name: string): HTMLElement => {
    const tpl = doc.createElement("template");
    tpl.innerHTML = expand(part(name).html);
    const el = tpl.content.firstElementChild as HTMLElement;
    neutral(el);
    return el;
  };
  const clips = (sub("timeline")?.clips as ReadonlyArray<Clip> | undefined) ?? [];
  const length = clips.reduce((m, c) => Math.max(m, num(c.start, 0) + num(c.duration, 0)), 0);
  const common = keyOf({ text: o.text, press: o.press, highlight: o.highlight, hide: o.hide, remove: o.remove });
  // Each panel: its base (pristine, or another part's markup), put in place, then its props (list
  // templates are found through the part the element sits in, so props go on once it is attached).
  const pristine = (sel: string) => root.__pristine!.get(sel)!.cloneNode(true) as HTMLElement;
  const units: ReadonlyArray<{ sel: string; spec: unknown; base: () => HTMLElement; apply: (el: HTMLElement) => void }> = [
    {
      sel: ".side",
      spec: [o.side, o.composer, o.turn, o.message, o.review, o.inspector],
      base: () => (o.side === "inspector" ? fresh("inspector") : pristine(".side")),
      apply: (el) => (o.side === "inspector" ? applyProps("inspector", el, sub("inspector") || {}) : nested(el, o, ["composer", "turn", "message", "review"])),
    },
    {
      sel: ".library",
      spec: [o.library, o.effects],
      base: () => (o.library === "effects" ? fresh("effects") : pristine(".library")),
      apply: (el) => {
        if (o.library === "effects") applyProps("effects", el, sub("effects") || {});
        for (const b of root.querySelectorAll(".rail [data-rail]")) b.classList.toggle("active", b.getAttribute("data-rail") === (o.library === "effects" ? "effects" : "media"));
      },
    },
    { sel: ".bottom", spec: [o.timeline], base: () => pristine(".bottom"), apply: (el) => applyProps("timeline", el, sub("timeline") || {}) },
    { sel: ".stage", spec: [o.preview, length], base: () => pristine(".stage"), apply: (el) => applyProps("preview", el, { duration: length, ...(sub("preview") || {}) }) },
    { sel: ".topbar", spec: [o.topbar], base: () => pristine(".topbar"), apply: (el) => applyProps("topbar", el, sub("topbar") || {}) },
  ];
  let changed = false;
  for (const u of units) {
    if (!root.__pristine.has(u.sel)) continue;
    const key = `${keyOf({ s: u.spec } as Props)}\n${common}`;
    if (root.__liveKeys!.get(u.sel) === key) continue;
    const next = u.base();
    const cur = root.querySelector(u.sel);
    if (cur) {
      cur.replaceWith(next);
      u.apply(next);
    }
    root.__liveKeys!.set(u.sel, key);
    changed = true;
  }
  // A dialog over the window: the export settings, or the export running.
  const dialog = sub("exportProgress") ? "exportProgress" : sub("export") ? "export" : "";
  const dkey = `${dialog}\n${keyOf({ d: dialog ? o[dialog] : null } as Props)}\n${common}`;
  if (root.__liveKeys!.get("modal") !== dkey) {
    root.querySelector(":scope > .modal-layer")?.remove();
    if (dialog) {
      const layer = doc.createElement("div");
      const anc = part(dialog).ancestors.at(-1);
      layer.className = anc?.cls || "modal-layer";
      if (anc?.vars) layer.setAttribute("style", anc.vars);
      const el = fresh(dialog);
      layer.appendChild(el);
      root.appendChild(layer);
      applyProps(dialog, el, { duration: length, ...(sub(dialog) || {}) });
    }
    root.__liveKeys!.set("modal", dkey);
    changed = true;
  }
  if (changed) applyProps("", root, { text: o.text, press: o.press, highlight: o.highlight, hide: o.hide, remove: o.remove });
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

/** A review card as the review part starts: "Reviewing", no result, round or scores (the fixture's are a run's facts). */
function blankReview(card: Element) {
  card.removeAttribute("data-passed");
  setText(card.querySelector(".card-head .grow"), "Review");
  const out = card.querySelector(".card-outcome");
  if (out) {
    out.className = "card-outcome";
    out.textContent = "Reviewing";
  }
  for (const row of card.querySelectorAll(".score")) {
    row.removeAttribute("data-value");
    row.classList.remove("low", "ok");
    const bar = row.querySelector(".score-bar > span") as HTMLElement | null;
    if (bar) bar.style.width = "0%";
    setText(row.querySelector(".score-value"), "");
  }
}

/**
 * Honesty first: the parts were captured on fixture data, so every fact about a run in them (the
 * review's result, round and scores, the plan's state, the turn's model and time, the export's time
 * left) starts blank or neutral ("Reviewing", empty bars). Only props the graphic passes (the real
 * results) put one on screen.
 */
function neutral(root: HTMLElement) {
  for (const card of findAll(root, '.card-item[data-type="review"]')) blankReview(card);
  for (const el of findAll(root, ".plan-state")) el.remove();
  for (const el of findAll(root, ".turn-status")) {
    el.textContent = "";
    el.removeAttribute("title");
  }
  for (const el of findAll(root, ".export-status .muted")) el.textContent = "";
  // The export's progress (the fixture's 42 %): none until progress is passed.
  for (const el of findAll(root, ".export-status")) setLead(el, "Rendering…");
  for (const el of root.querySelectorAll<HTMLElement>(".export-bar > div")) el.style.width = "0%";
  // The export's file, folder and settings line is the fixture's.
  for (const el of findAll(root, '[data-testid="export-job-where"]')) el.remove();
  // The fixture's prose and counts: the turn's steps, reply, edit count, the critic's card inside a
  // turn (props bring them back), the media library's sample files (editor: media).
  for (const el of root.querySelectorAll('.turn .worklog .step, .turn .reply, .turn-edits, .turn .card-item, .turn .edit-row, [data-testid="media-tile"], .tl-lane .clip')) el.remove();
  // The user's words (a message's text, the composer's typed text): the graphic's, else none.
  for (const el of findAll(root, ".msg-user")) el.textContent = "";
  for (const el of findAll(root, ".composer-hl")) el.textContent = "\u200b";
  for (const el of findAll(root, ".composer-box > textarea")) el.textContent = "";
  for (const el of findAll(root, ".composer .send")) el.setAttribute("disabled", "");
  // Sample labels: the fixture project's title, length and canvas, the clip named in the Inspector and
  // Effects. Blank until the graphic passes its own (topbar title, preview duration and canvas,
  // inspector title, effects target); an editor's length is its clips' end.
  for (const el of findAll(root, ".project-title")) el.textContent = "";
  for (const el of root.querySelectorAll(".timecode .tc-end")) el.textContent = ` / ${timecode(0)}`;
  for (const el of findAll(root, '[data-testid="canvas-info"]')) el.textContent = "";
  for (const el of root.querySelectorAll('.insp-title .grow, [data-testid="insp-media"], [data-testid="insp-duration"]')) el.textContent = "";
  for (const el of root.querySelectorAll('[data-testid="insp-name"], [data-testid="insp-media-name"]')) {
    el.removeAttribute("placeholder");
    el.setAttribute("value", "");
  }
  for (const el of findAll(root, '[data-testid="effects-target"]')) el.textContent = "";
  for (const el of findAll(root, '[data-testid="export-range-text"]')) el.textContent = "";
  // The storyboard's plan: the graphic's (summary, beats), else none.
  for (const el of findAll(root, ".approval-text")) setLead(el, "");
  for (const el of root.querySelectorAll(".beats .beat-time, .beats .beat-head b, .beats .beat-line")) el.textContent = "";
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
  for (const k of list(o.remove)) for (const el of findAll(root, k, name)) if (el !== root) el.remove();
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
    if (typeof o.reply === "string") addCaptured(root, "turn", ".reply", (el) => setText(el.querySelector("p"), o.reply));
    if (typeof o.edit === "string") addCaptured(root, "turn", ".edit-row", (el) => setText(el.querySelector(".grow"), o.edit), ".worklog");
    // The card as captured is the fixture's review (Passed, round 2, its scores): blank, then the graphic's props.
    if (o.review)
      addCaptured(root, "turn", ".card-item", (el) => {
        blankReview(el);
        if (typeof o.review === "object") applyProps("review", el, o.review as Props);
      }, ".edit-row, .worklog");
    if (Array.isArray(o.steps)) fillList(root.querySelector(".worklog"), ".step", o.steps.map(String), (el, s) => setText(el.querySelector(".grow"), s));
    // A running step shows the app's spinner (lucide LoaderCircle) where a done one has its tick.
    if (typeof o.done === "number")
      [...root.querySelectorAll(".worklog .step")].forEach((el, i) => {
        const running = i >= (o.done as number);
        el.setAttribute("data-status", running ? "running" : "done");
        const icon = el.querySelector("svg");
        if (running && icon) icon.outerHTML = SPINNER_SVG;
      });
    if (typeof o.status === "string") setText(root.querySelector(".turn-status"), o.status);
  },
  inspector(root, o) {
    if (typeof o.title === "string") {
      setText(find(root, "title", "inspector")?.querySelector(".grow") ?? null, o.title);
      setText(root.querySelector('[data-testid="insp-media"]'), o.title);
    }
    if (typeof o.filter === "string") setText(find(root, "amount", "inspector")?.querySelector(".prop-k") ?? null, o.filter);
    if (typeof o.amount === "number") for (const el of find(root, "amount", "inspector")?.querySelectorAll("input") ?? []) el.setAttribute("value", String(Math.round(o.amount)));
    if (o.filter === false) find(root, "filter", "inspector")?.remove();
    if (o.effects === false) find(root, "effects", "inspector")?.remove();
  },
  effects(root, o) {
    if (o.active !== undefined) for (const tile of findAll(root, '[data-testid="filter-tile"]')) {
      const on = tile.getAttribute("data-look") === o.active;
      tile.classList.toggle("active", on);
      on ? tile.setAttribute("data-active", "true") : tile.removeAttribute("data-active");
    }
    if (typeof o.target === "string") setText(find(root, "target", "effects"), o.target);
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
    // Only scores the graphic passes (a real review's) are drawn; progress fills their bars.
    const scores = o.scores as Readonly<Record<string, number>> | undefined;
    const fill = Math.max(0, Math.min(1, num(o.progress, 1)));
    if (scores && typeof scores === "object")
      for (const row of findAll(root, "score", "review")) {
        const value = scores[row.getAttribute("data-score") || ""];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const v = Math.max(0, Math.min(10, value));
        const bar = row.querySelector(".score-bar > span") as HTMLElement | null;
        if (bar) bar.style.width = `${fill * v * 10}%`;
        setText(row.querySelector(".score-value"), String(Math.round(v * fill)));
      }
  },
  timeline(root, o) {
    timelineProps(root, o, part("timeline").pxPerSecond || 60);
  },
  preview(root, o) {
    if (typeof o.time === "number") setLead(find(root, "timecode", "preview"), timecode(o.time));
    if (typeof o.duration === "number") setText(root.querySelector(".timecode .tc-end"), ` / ${timecode(o.duration)}`);
    if (typeof o.canvas === "string") setText(root.querySelector('[data-testid="canvas-info"]'), o.canvas);
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
    if (typeof o.duration === "number") setText(root.querySelector('[data-testid="export-range-text"]'), `${timecode(0)} to ${timecode(o.duration)}, ${o.duration.toFixed(1)} s`);
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
    if (typeof o.title === "string") setText(find(root, "title", "topbar"), o.title);
  },
  agent(root, o) {
    nested(root, o, ["composer", "turn", "message", "review"]);
  },
  editor(root, o) {
    if (Array.isArray(o.media)) {
      const grid = root.querySelector('[data-testid="media-grid"]');
      const tpl = DATA.parts.editor ? mediaTile(root.ownerDocument) : null;
      if (grid && tpl)
        for (const m of o.media as ReadonlyArray<{ name?: string; meta?: string; image?: string; duration?: number }>) {
          const el = tpl.cloneNode(true) as HTMLElement;
          setText(el.querySelector(".tile-name"), m.name ?? "");
          setText(el.querySelector(".tile-sub"), m.meta ?? "");
          // The tile's length badge (mm:ss) is the file's: shown only when passed.
          const badge = el.querySelector(".dur");
          if (typeof m.duration === "number") setText(badge, `${String(Math.floor(m.duration / 60)).padStart(2, "0")}:${String(Math.floor(m.duration % 60)).padStart(2, "0")}`);
          else badge?.remove();
          const thumb = el.querySelector(".thumb") as HTMLElement | null;
          if (thumb && m.image) thumb.style.cssText += `;background:url("${picture(m.image)}") center/cover`;
          grid.appendChild(el);
        }
    }
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

/** A picture URL a part can show: data: or blob: (uncut:media markers resolve only in the graphic's own HTML). */
function picture(src: string): string {
  if (/^uncut:media\//.test(src)) throw new Error(`uncutUI: "${src}" can't load from a prop; pass await uncut.url(id, seconds) (a blob: URL, asked once before the first frame) instead`);
  return src;
}

/** The library's media tile as captured (the runtime removes the sample files; editor: media puts tiles back from it). */
function mediaTile(doc: Document): Element | null {
  const tpl = doc.createElement("template");
  tpl.innerHTML = expand(part("editor").html);
  const tile = tpl.content.querySelector('[data-testid="media-tile"]');
  tile?.querySelector(".tile-used")?.remove();
  return tile;
}

/** Puts back an element neutral() removed from a part (its captured markup), after the first match of `after` (else last), and fills it. */
function addCaptured(root: HTMLElement, name: string, sel: string, fill: (el: HTMLElement) => void, after?: string) {
  let el = root.querySelector(sel) as HTMLElement | null;
  if (!el) {
    const tpl = root.ownerDocument.createElement("template");
    tpl.innerHTML = expand(part(name).html);
    const src = tpl.content.querySelector(sel) as HTMLElement | null;
    if (!src) return;
    el = src.cloneNode(true) as HTMLElement;
    const parent = (src.parentElement && root.querySelector(`.${[...src.parentElement.classList].join(".")}`)) || root;
    const anchor = after ? (parent.querySelector(after) as HTMLElement | null) : null;
    anchor && anchor.parentElement === parent ? anchor.after(el) : parent.appendChild(el);
  }
  fill(el);
}

function expand(html: string): string {
  return html.replace(/\u0001(\d+)\u0002/g, (_m, i: string) => DATA.pool[Number(i)] ?? "");
}

/** Make container hold one copy of its first `selector` child per entry (cloned), each filled by fill. */
function fillList<T>(container: Element | null, selector: string, entries: ReadonlyArray<T>, fill: (el: Element, entry: T, i: number) => void) {
  if (!container) return;
  const existing = [...container.querySelectorAll(selector)];
  // None left (the runtime blanked them): the first as captured, from the part it belongs to.
  let tpl: Element | undefined = existing[0];
  let parent: Element | null = tpl?.parentElement ?? null;
  if (!tpl) {
    const owner = partName(container);
    const t = container.ownerDocument.createElement("template");
    t.innerHTML = owner ? expand(part(owner).html) : "";
    tpl = t.content.querySelector(`${[...container.classList].map((c) => `.${c}`).join("")} ${selector}`) ?? undefined;
    parent = container;
  }
  if (!tpl || !parent) return;
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
    // Templates: each lane's first clip as captured (its kind's look); the part starts with none.
    const templates = new Map<HTMLElement, Element>();
    const any = new Map<string, Element>();
    const tpl0 = root.ownerDocument.createElement("template");
    tpl0.innerHTML = expand(part("timeline").html);
    const captured = [...tpl0.content.querySelectorAll(".tl-lane")];
    lanes.forEach((lane, i) => {
      const c = captured[i]?.querySelector(".clip");
      if (c) templates.set(lane, c);
      for (const k of ["video", "audio", "text"]) if (c?.classList.contains(k) && !any.has(k)) any.set(k, c);
    });
    // The clips passed are the whole timeline.
    for (const lane of lanes) for (const c of lane.querySelectorAll(".clip")) c.remove();
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
        strip.style.backgroundImage = `url("${picture(c.image)}")`;
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

// ---- pieces: one element of a part on its own, set large; and one shell morphing piece to piece ----

/** A piece as built: its content (natural size, padding included), the look its shell carries. */
interface Built {
  readonly node: HTMLElement;
  readonly el: HTMLElement;
  readonly w: number;
  readonly h: number;
  readonly bg: string;
  readonly radius: number;
  /** The slot's font size in the app (px) and its part's name. */
  readonly font: number;
  readonly name: string;
}
type Holder = HTMLElement & { __pieceKey?: string; __built?: Built };

/** One key of a sequence (and what piece takes): the piece, its part's props, where it sits. */
interface PieceKey {
  readonly at?: number;
  readonly piece: string;
  readonly props?: Props;
  readonly index?: number;
  /** Centre in host px (default: the host's centre). */
  readonly x?: number;
  readonly y?: number;
  /** Width in host px (default: 86 % of the host's, unless scale or size is given); height: a taller or wider shell, the content fitted inside. */
  readonly width?: number;
  readonly height?: number;
  readonly scale?: number;
  /** The piece's own layout size in app px (default: as the app lays it out): a narrower composer wraps its text, so it sets larger. */
  readonly size?: { readonly width?: number; readonly height?: number };
  readonly pad?: number;
  /** The shell's soft shadow on the canvas (default on; false: none). */
  readonly shadow?: boolean;
  readonly radius?: number;
  readonly background?: string;
  /** The shell's press (uncutMotion.click's .button, 0.95 pressed). */
  readonly press?: number;
  /** This key's transition into it (s, default the sequence's dur, 0.5). */
  readonly dur?: number;
  /** In a morph, the content fitted whole in the shell ("contain", the default) or covering it ("cover", the default for a picture: preview.frame). */
  readonly fit?: "contain" | "cover";
  /** The piece's text height on the canvas, host px (default 4.8 % of the host's height; 0: as the app sets it): it picks size.width, so the words wrap and set large. */
  readonly type?: number;
  /** "light": the piece in light colours (white surfaces, dark words), else the app's dark. */
  readonly theme?: "light" | "dark";
  /** The piece's text colour (a restyle: a dim label made to read). */
  readonly color?: string;
  /** Where the outgoing piece leaves to and this one comes from, as it pushes the last out of the shell: "up" (default), "down", "left", "right", or "none" (in place). */
  readonly from?: "up" | "down" | "left" | "right" | "none";
  /** Elements that carry over from the key before instead of swapping: a selector in both, or [before's, this one's]; each travels and scales from where it was to where it lands (the prompt into its message, the Send arrow). */
  readonly carry?: ReadonlyArray<string | readonly [string, string]>;
}


const PIECE_SHELL = "display:contents;";

/** A colour as [r, g, b, a] (rgb() / rgba() / #rrggbb), or undefined. */
function rgba(c: string): [number, number, number, number] | undefined {
  const hex = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = c.match(/[\d.]+/g);
  if (!m || m.length < 3 || !/^rgb/.test(c.trim())) return undefined;
  return [Number(m[0]), Number(m[1]), Number(m[2]), m.length >= 4 ? Number(m[3]) : 1];
}

function mixRgba(a: string, b: string, p: number): string {
  const x = rgba(a) || [0, 0, 0, 0];
  const y = rgba(b) || [0, 0, 0, 0];
  const v = x.map((n, i) => n + (y[i]! - n) * p);
  return `rgba(${Math.round(v[0]!)}, ${Math.round(v[1]!)}, ${Math.round(v[2]!)}, ${Math.round(v[3]! * 1000) / 1000})`;
}

/** The morph's ease: a critically damped spring from rest, normalised to land exactly at 1 (no overshoot, no lurch). */
function settle(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const k = 7.4;
  const f = (x: number) => 1 - (1 + x) * Math.exp(-x);
  return f(k * p) / f(k);
}

const smooth = (p: number) => {
  const q = Math.max(0, Math.min(1, p));
  return q * q * (3 - 2 * q);
};

/** A key with its host's defaults: centred, 86 % of the host's width, its words 4.8 % of the host's height. */
function resolveKey(k: PieceKey, host: HTMLElement): PieceKey {
  // A host not laid out yet (zero size): the graphic's own canvas, the document's size.
  const view = host.ownerDocument.defaultView;
  const W = host.offsetWidth || host.ownerDocument.documentElement.clientWidth || view?.innerWidth || 1080;
  const H = host.offsetHeight || host.ownerDocument.documentElement.clientHeight || view?.innerHeight || 1350;
  const own = typeof k.size?.width === "number";
  const width = typeof k.width === "number" ? k.width : typeof k.scale === "number" || own ? undefined : W * 0.86;
  const type = own || covers(k) || width === undefined ? 0 : num(k.type, H * 0.048);
  return { ...k, x: num(k.x, W / 2), y: num(k.y, H / 2), width, type };
}

/**
 * Builds piece `id` ("part.slot", or "part" for the whole part) in holder, cached by its props: the
 * part is built whole (its props applied, so a typed composer or a step's label is right), the
 * slot measured as the app lays it out, then everything around it unboxed (display: contents keeps
 * the selectors and the inherited type) and the slot pinned to its size: the app's, size, or the
 * width at which its text sets at type px once the piece is width px wide.
 */
function buildPiece(holder: Holder, k: PieceKey): Built {
  const [name, slot] = [k.piece.split(".")[0]!, k.piece.split(".").slice(1).join(".")];
  const props = k.props || {};
  const typed = num(k.type, 0) > 0 && typeof k.width === "number";
  const key = `${k.piece}\n${k.index ?? 0}\n${k.pad ?? ""}\n${k.radius ?? ""}\n${k.background ?? ""}\n${k.theme ?? ""}\n${k.color ?? ""}\n${typed ? `${k.width}/${k.type}` : ""}\n${keyOf(k.size ?? {})}\n${keyOf(props)}`;
  if (holder.__pieceKey === key && holder.__built) return holder.__built;
  const scratch = holder.ownerDocument.createElement("div");
  scratch.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;pointer-events:none";
  holder.replaceChildren(scratch);
  const root = mount(scratch, name, { ...props, background: "none", scale: 1 });
  const wrap = scratch.firstElementChild as HTMLElement;
  const theme = k.theme === "light";
  wrap.classList.toggle("uncut-ui-light", theme);
  const el = slot ? findAll(root, slot, name)[k.index ?? 0] : root;
  if (!el) throw new Error(`uncutUI: no piece "${k.piece}"${k.index ? ` #${k.index}` : ""} (slots of ${name}: ${slots(name).join(", ")})`);
  const view = holder.ownerDocument.defaultView!;
  const cs = view.getComputedStyle(el);
  // Read now: the style is live, and the slot is restyled below.
  const ownBg = cs.backgroundColor;
  const ownRadius = parseFloat(cs.borderTopLeftRadius) || 0;
  // The words' size: the first element holding text of its own (a step's label, not the list's).
  let lead: Element = el;
  for (let n: Element | null = el; n; n = nextEl(n, el))
    if ([...n.childNodes].some((c) => c.nodeType === 3 && /\S/.test(c.textContent || ""))) {
      lead = n;
      break;
    }
  const font = parseFloat(view.getComputedStyle(lead).fontSize) || 13;
  const own = rgba(ownBg);
  // An opaque slot with square corners (a timeline lane, a panel section) sits in a padded, rounded shell of its colour.
  const opaque = !!own && own[3] >= 0.99 && ownRadius > 0;
  let behind = own && own[3] >= 0.99 ? ownBg : theme ? "rgb(255, 255, 255)" : part(name).backdrop || "rgb(10, 10, 10)";
  if (!(own && own[3] >= 0.99))
    for (let p = el.parentElement; p && p !== scratch; p = p.parentElement) {
      const c = rgba(view.getComputedStyle(p).backgroundColor);
      if (c && c[3] >= 0.99) {
        behind = view.getComputedStyle(p).backgroundColor;
        break;
      }
    }
  const radius = num(k.radius, opaque ? ownRadius : Math.min(18, Math.max(10, el.offsetHeight * 0.2)));
  const pad = num(k.pad, opaque ? 0 : Math.round(Math.min(18, Math.max(10, el.offsetHeight * 0.25))));
  // type: the layout width at which font px reads as type px in a width px shell.
  const w = typed ? Math.max(48, Math.round((k.width! * font) / k.type! - pad * 2)) : num(k.size?.width, el.offsetWidth);
  let h = num(k.size?.height, el.offsetHeight);
  // Unbox the path from the part's wrapper to the slot; drop everything beside it.
  for (let at: HTMLElement = el; at !== wrap; ) {
    const parent = at.parentElement as HTMLElement;
    for (const sib of [...parent.children]) if (sib !== at) sib.remove();
    if (parent.getAttribute("style")?.startsWith(SHELL)) parent.setAttribute("style", PIECE_SHELL + (parent.getAttribute("style") || "").slice(SHELL.length));
    else parent.style.display = "contents";
    at = parent;
  }
  wrap.style.cssText = "display:contents";
  const st = el.style;
  st.boxSizing = "border-box";
  st.width = `${w}px`;
  st.height = (typed || typeof k.size?.width === "number") && typeof k.size?.height !== "number" ? "auto" : `${h}px`;
  st.margin = "0";
  st.position = "relative";
  st.left = st.top = st.right = st.bottom = "auto";
  st.flex = "none";
  st.maxWidth = st.maxHeight = "none";
  if (opaque) st.boxShadow = "none";
  if (k.color) st.color = k.color;
  if (st.height === "auto") {
    // A new width: its height as it lays out at that width, pinned.
    // (Children all positioned, a lane: it keeps the app's height.)
    h = el.offsetHeight > 2 ? el.offsetHeight : h;
    st.height = `${h}px`;
  }
  const node = holder.ownerDocument.createElement("div");
  node.className = "uncut-ui-piece";
  node.style.cssText = `position:absolute;left:0;top:0;width:${w + pad * 2}px;height:${h + pad * 2}px;padding:${pad}px;box-sizing:border-box;transform-origin:0 0`;
  node.appendChild(wrap);
  holder.replaceChildren(node);
  const built: Built = { node, el, w: w + pad * 2, h: h + pad * 2, bg: k.background ?? (opaque ? ownBg : behind), radius, font, name };
  holder.__pieceKey = key;
  holder.__built = built;
  return built;
}

/** The element after n in document order inside root, or null. */
function nextEl(n: Element, root: Element): Element | null {
  if (n.firstElementChild) return n.firstElementChild;
  for (let at: Element | null = n; at && at !== root; at = at.parentElement) if (at.nextElementSibling) return at.nextElementSibling;
  return null;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** A key's box in host px: its centre, size and corner radius (the piece's own radius scaled with it). */
function keyBox(k: PieceKey, b: Built): Box {
  const s = typeof k.width === "number" ? k.width / b.w : num(k.scale, 1);
  const w = typeof k.width === "number" ? k.width : b.w * s;
  const h = typeof k.height === "number" ? k.height : b.h * s;
  return { x: typeof k.x === "number" ? k.x : w / 2, y: typeof k.y === "number" ? k.y : h / 2, w, h, r: b.radius * s };
}

/** A built piece's content scale fitted in a w x h shell (one uniform scale, never stretched). */
const fitScale = (b: Built, w: number, h: number, cover?: boolean) => (cover ? Math.max(w / b.w, h / b.h) : Math.min(w / b.w, h / b.h));

/** Place a built piece's content fitted and centred in a w x h shell, moved by (dx, dy) and scaled by z about its centre. */
function fitInto(b: Built, w: number, h: number, alpha: number, blur: number, dx: number, dy: number, cover?: boolean, z?: number) {
  const s = fitScale(b, w, h, cover) * num(z, 1);
  const st = b.node.style;
  st.transform = `translate(${(w - b.w * s) / 2 + dx}px, ${(h - b.h * s) / 2 + dy}px) scale(${s})`;
  st.opacity = String(Math.round(alpha * 1000) / 1000);
  st.filter = blur > 0.05 ? `blur(${(blur / Math.max(s, 0.01)).toFixed(2)}px)` : "none";
  st.visibility = alpha > 0.001 ? "visible" : "hidden";
}

const covers = (k: PieceKey) => (k.fit ? k.fit === "cover" : /\.frame$/.test(k.piece));

const DIRS: Readonly<Record<string, readonly [number, number]>> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], none: [0, 0] };

/** An element's rect in its piece's content px (the piece unscaled). */
function localRect(el: Element, node: HTMLElement): Box {
  const a = el.getBoundingClientRect();
  const b = node.getBoundingClientRect();
  const s = node.offsetWidth ? b.width / node.offsetWidth : 1;
  return { x: (a.left - b.left) / s, y: (a.top - b.top) / s, w: a.width / s, h: a.height / s, r: 0 };
}

/** Where a piece's content sits at rest in box: its scale and top-left, host px. */
function restAt(b: Built, box: Box, cover: boolean) {
  const s = fitScale(b, box.w, box.h, cover);
  return { s, x: box.x - box.w / 2 + (box.w - b.w * s) / 2, y: box.y - box.h / 2 + (box.h - b.h * s) / 2 };
}

type Carrier = HTMLElement & { __from?: Built; __to?: Built; __spec?: string };

/**
 * The carried elements of a morph: each pair drawn once, outside both pieces (a copy of each piece
 * with only that element visible), travelling from where it sat in the last piece to where it lands
 * in this one, its scale following the box; the two copies hand over midway (same words, same wrap:
 * no double image). The originals are hidden meanwhile.
 */
function carry(host: HTMLElement, kf: PieceKey, kj: PieceKey, bf: Built, bj: Built, boxF: Box, boxJ: Box, p: number, raw: number, hidden: Array<HTMLElement>) {
  const doc = host.ownerDocument;
  let layer = host.querySelector(":scope > .uncut-ui-carry") as Carrier | null;
  if (!layer) {
    layer = doc.createElement("div") as Carrier;
    layer.className = "uncut-ui-carry";
    host.appendChild(layer);
  }
  const pairs = (kj.carry || []).map((c) => (typeof c === "string" ? [c, c] : c) as readonly [string, string]);
  const found = pairs.map(([a, b]) => [find(bf.el, a, bf.name), find(bj.el, b, bj.name)] as const).filter((x): x is readonly [HTMLElement, HTMLElement] => !!x[0] && !!x[1]);
  if (!found.length || raw >= 1) {
    layer.style.display = "none";
    return;
  }
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2";
  const spec = JSON.stringify(pairs);
  if (layer.__from !== bf || layer.__to !== bj || layer.__spec !== spec) {
    layer.replaceChildren();
    found.forEach(([fe, te], i) => {
      for (const [b, e] of [[bf, fe], [bj, te]] as const) {
        e.setAttribute("data-uncut-carry", String(i));
        const c = b.node.cloneNode(true) as HTMLElement;
        e.removeAttribute("data-uncut-carry");
        c.querySelector(`[data-uncut-carry="${i}"]`)?.setAttribute("style", `${c.querySelector(`[data-uncut-carry="${i}"]`)?.getAttribute("style") || ""};visibility:visible`);
        layer!.appendChild(c);
      }
    });
    layer.__from = bf;
    layer.__to = bj;
    layer.__spec = spec;
  }
  const rf = restAt(bf, boxF, covers(kf));
  const rj = restAt(bj, boxJ, covers(kj));
  const hand = smooth((raw - 0.4) / 0.12);
  found.forEach(([fe, te], i) => {
    const lf = localRect(fe, bf.node);
    const lj = localRect(te, bj.node);
    const A = { x: rf.x + lf.x * rf.s, y: rf.y + lf.y * rf.s, w: lf.w * rf.s };
    const B = { x: rj.x + lj.x * rj.s, y: rj.y + lj.y * rj.s, w: lj.w * rj.s };
    const cur = { x: A.x + (B.x - A.x) * p, y: A.y + (B.y - A.y) * p, w: A.w + (B.w - A.w) * p };
    const sides: ReadonlyArray<readonly [Box, number, number]> = [[lf, (rf.s * cur.w) / Math.max(A.w, 0.01), 1 - hand], [lj, (rj.s * cur.w) / Math.max(B.w, 0.01), hand]];
    sides.forEach(([l, s, alpha], side) => {
      const c = layer!.children[i * 2 + side] as HTMLElement;
      c.style.transform = `translate(${cur.x - l.x * s}px, ${cur.y - l.y * s}px) scale(${s})`;
      c.style.opacity = String(Math.round(alpha * 1000) / 1000);
      c.style.filter = "none";
      c.style.visibility = "hidden";
    });
    for (const e of [fe, te]) {
      e.style.visibility = "hidden";
      hidden.push(e);
    }
  });
  layer.style.display = "block";
}

type Hiding = HTMLElement & { __hidden?: Array<HTMLElement> };

/**
 * One shell carried through the keys: each key a piece where it sits (by default centred in the
 * host, 86 % of its width, its words 4.8 % of its height); from each key's at it morphs from the key
 * before (dur s, a critically damped ease): the shell's centre, size, corner radius and colour
 * travel as one object while the new content pushes the old out of it (from: the side it enters
 * from, the old leaving by the other, both fitted at one uniform scale, text never stretched), and
 * carry elements travel to their place in the new piece. The same piece twice (another width, more
 * steps) resizes without a swap. Pure in t. Returns the shell's box { x, y, w, h, r }, p (0..1 in a
 * morph, 1 at rest), the key index shown, its element and the text's height on the canvas (type).
 */
function sequence(host: HTMLElement, t: number, keyList: ReadonlyArray<PieceKey>, o?: { readonly dur?: number }): { x: number; y: number; w: number; h: number; r: number; p: number; key: number; el: HTMLElement; type: number } {
  if (!keyList.length) throw new Error("uncutUI.sequence: no keys");
  const doc = host.ownerDocument;
  ensureCss(doc);
  const keys = keyList.map((k) => resolveKey(k, host));
  let shell = host.querySelector(":scope > .uncut-ui-shell") as Hiding | null;
  if (!shell) {
    shell = doc.createElement("div") as Hiding;
    shell.className = "uncut-ui-shell";
    host.insertBefore(shell, host.querySelector(":scope > .uncut-ui-carry"));
  }
  for (const e of shell.__hidden || []) e.style.visibility = "";
  const hidden: Array<HTMLElement> = (shell.__hidden = []);
  const holders: Array<Holder> = [];
  for (let i = 0; i < keys.length; i++) {
    let hd = shell.children[i] as Holder | undefined;
    if (!hd) {
      hd = doc.createElement("div") as Holder;
      hd.style.cssText = "position:absolute;left:0;top:0";
      shell.appendChild(hd);
    }
    holders.push(hd);
  }
  while (shell.children.length > keys.length) shell.lastElementChild!.remove();
  let j = 0;
  for (let i = 0; i < keys.length; i++) if (num(keys[i]!.at, 0) <= t) j = i;
  const dur = (k: PieceKey) => Math.max(0.05, num(k.dur, num(o?.dur, 0.5)));
  const from = j > 0 && t < num(keys[j]!.at, 0) + dur(keys[j]!) ? j - 1 : -1;
  const raw = from >= 0 ? (t - num(keys[j]!.at, 0)) / dur(keys[j]!) : 1;
  const p = settle(raw);
  // Shown before building: a piece is measured as laid out.
  holders.forEach((hd, i) => (hd.style.display = i === j || i === from ? "block" : "none"));
  const bj = buildPiece(holders[j]!, keys[j]!);
  const boxJ = keyBox(keys[j]!, bj);
  let box: Box = boxJ;
  let bg = bj.bg;
  let press = num(keys[j]!.press, 1);
  let carried = false;
  if (from >= 0) {
    const kf = keys[from]!;
    const kj = keys[j]!;
    const bf = buildPiece(holders[from]!, kf);
    const boxF = keyBox(kf, bf);
    box = { x: boxF.x + (boxJ.x - boxF.x) * p, y: boxF.y + (boxJ.y - boxF.y) * p, w: boxF.w + (boxJ.w - boxF.w) * p, h: boxF.h + (boxJ.h - boxF.h) * p, r: boxF.r + (boxJ.r - boxF.r) * p };
    bg = mixRgba(bf.bg, bj.bg, p);
    press = num(kf.press, 1) + (press - num(kf.press, 1)) * p;
    const same = kf.piece === kj.piece && (kf.index ?? 0) === (kj.index ?? 0) && kf.theme === kj.theme;
    holders[from]!.style.display = same ? "none" : "block";
    if (!same) {
      // A push inside the travelling shell, as the reference films swap a control: the old content
      // drifts toward the far side, blurring hard and fading by a third of the morph; the new comes
      // in from its side (from) out of the same blur. Between, the shell holds only soft shapes of
      // its colour: never two legible pictures on each other. A picture that leaves (a preview frame)
      // stays put on the canvas, cropped by the shrinking shell, and gives way once the shell is nearly there.
      const [dx, dy] = DIRS[kj.from || "down"] || DIRS.down!;
      const out = smooth((raw - 0.04) / 0.3);
      const go = out * out;
      const blurOut = 14 * smooth(raw / 0.3);
      if (covers(kf)) {
        const rf = restAt(bf, boxF, true);
        const st = bf.node.style;
        const fade = smooth((raw - 0.3) / 0.35);
        st.transform = `translate(${rf.x - (box.x - box.w / 2)}px, ${rf.y - (box.y - box.h / 2)}px) scale(${rf.s})`;
        st.opacity = String(Math.round((1 - fade) * 1000) / 1000);
        st.filter = "none";
        st.visibility = fade < 0.999 ? "visible" : "hidden";
      } else fitInto(bf, box.w, box.h, 1 - out, blurOut, -dx * 0.35 * box.w * go, -dy * 0.35 * box.h * go, false, 1 - 0.06 * out);
      const pic = covers(kj);
      const inn = pic ? smooth((raw - 0.08) / 0.27) : smooth((raw - 0.18) / 0.3);
      const arrive = 1 - settle(Math.max(0, (raw - 0.08) / 0.92));
      fitInto(bj, box.w, box.h, inn, (pic ? 8 : 14) * (1 - smooth((raw - (pic ? 0.1 : 0.16)) / 0.45)), dx * 0.35 * box.w * arrive, dy * 0.35 * box.h * arrive, covers(kj), 1 + 0.05 * arrive);
      if (kj.carry?.length) {
        carry(host, kf, kj, bf, bj, boxF, boxJ, p, raw, hidden);
        carried = true;
      }
    } else {
      // The same piece grown or shrunk (a row added): the content at its new scale, anchored at the
      // shell's top, which reveals it as it grows.
      const s = boxJ.w / bj.w;
      const st = bj.node.style;
      st.transform = `translate(${(box.w - bj.w * s) / 2}px, 0px) scale(${s})`;
      st.opacity = "1";
      st.filter = "none";
      st.visibility = "visible";
    }
  } else fitInto(bj, box.w, box.h, 1, 0, 0, 0, covers(keys[j]!));
  if (!carried) {
    const layer = host.querySelector(":scope > .uncut-ui-carry") as HTMLElement | null;
    if (layer) layer.style.display = "none";
  }
  shell.style.cssText = `position:absolute;left:${box.x - box.w / 2}px;top:${box.y - box.h / 2}px;width:${box.w}px;height:${box.h}px;border-radius:${Math.min(box.r, box.w / 2, box.h / 2)}px;background:${bg};overflow:hidden;transform:scale(${press});transform-origin:50% 50%${keys[j]!.shadow === false || (from >= 0 && keys[from]!.shadow === false && raw < 0.6) ? "" : ";box-shadow:0 1px 2px rgb(0 0 0 / 8%), 0 14px 40px rgb(0 0 0 / 14%)"}`;
  return { x: box.x, y: box.y, w: box.w, h: box.h, r: box.r, p: from >= 0 ? p : 1, key: j, el: bj.el, type: (bj.font * boxJ.w) / bj.w };
}

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
type FlyLayer = HTMLElement & { __snaps?: Map<string, { key: string; node: HTMLElement; w: number; h: number; bg: string; r: number }> };

interface Flight {
  readonly at: number;
  /** The flight's length (s, default 0.7). */
  readonly dur?: number;
  /** Where it starts: an element on screen (a media tile, a piece's text), a rect in host px, or a piece key (a big free piece, shown at rest before at). */
  readonly from: Element | Rect | PieceKey;
  /** Where it lands: an element (the editor's composer, a timeline clip, the preview's frame) or a rect in host px. */
  readonly to: Element | Rect;
  /** Host px the path bows by at its middle (negative: up, a lift off the page). */
  readonly arc?: number;
  /** true: the from element is gone once the flight starts (the prompt leaving the composer); default it stays (a tile copied to the timeline). */
  readonly leave?: boolean;
  /** The layer's name, one per flight in flight at once (default "0"). */
  readonly id?: string;
  /** How an element's copy sits in the moving rect: "cover" (default: a tile cropped into a clip's strip) or "contain" (text into a bubble, whole). */
  readonly fit?: "cover" | "contain";
}

/** An element as a free-standing copy: its computed styles written inline (it keeps its look outside the part's CSS). */
function snapshot(el: HTMLElement): HTMLElement {
  const view = el.ownerDocument.defaultView!;
  const copy = el.cloneNode(true) as HTMLElement;
  const src = [el, ...el.querySelectorAll("*")];
  const dst = [copy, ...copy.querySelectorAll("*")];
  src.forEach((s, i) => {
    const cs = view.getComputedStyle(s);
    let css = "";
    for (let j = 0; j < cs.length; j++) {
      const k = cs[j]!;
      if (k === "visibility" || k.startsWith("transition") || k.startsWith("animation")) continue;
      css += `${k}:${cs.getPropertyValue(k)};`;
    }
    dst[i]!.setAttribute("style", css);
  });
  copy.style.position = "absolute";
  copy.style.left = copy.style.top = "0px";
  copy.style.margin = "0";
  copy.style.transform = "none";
  copy.style.transformOrigin = "0 0";
  copy.style.opacity = "1";
  copy.style.boxShadow = "none";
  copy.style.width = `${el.offsetWidth}px`;
  copy.style.height = `${el.offsetHeight}px`;
  // Its box as laid out: percentages of a parent it no longer has don't apply.
  copy.style.maxWidth = copy.style.maxHeight = "none";
  copy.style.minWidth = copy.style.minHeight = "0";
  copy.style.boxSizing = "border-box";
  copy.style.visibility = "visible";
  return copy;
}

const isPieceKey = (v: unknown): v is PieceKey => !!v && typeof v === "object" && typeof (v as PieceKey).piece === "string";
const isElement = (v: unknown): v is HTMLElement => !!v && typeof v === "object" && "nodeType" in (v as object);

/**
 * One element travelling into its place in the program, as one object (call it every frame): from
 * a free rect or element (a big floating piece, a media tile, the typed prompt) to an element in the
 * stage (the composer's slot in the agent panel, the clip on the timeline, the preview's frame). Its
 * rect, corner radius and colour travel along an optional arc (critically damped), the start's look
 * handing over to the landing element's own look on the way; the landing element is hidden until
 * it lands, then the copy is gone and the real one shows. A piece key as from shows that piece at
 * rest before at (its typed text, the Send press), so the same call is the hero and its dock. Pure
 * in t. Returns { x, y, w, h, p, el } (el: the free piece's element when from is a piece key).
 */
function fly(host: HTMLElement, t: number, f: Flight): { x: number; y: number; w: number; h: number; p: number; el: HTMLElement | null } {
  const doc = host.ownerDocument;
  ensureCss(doc);
  const id = f.id ?? "0";
  let layer = [...host.children].find((c) => c.classList.contains("uncut-ui-fly") && c.getAttribute("data-fly") === id) as FlyLayer | undefined;
  if (!layer) {
    layer = doc.createElement("div") as FlyLayer;
    layer.className = "uncut-ui-fly";
    layer.setAttribute("data-fly", id);
    layer.innerHTML = '<div class="uncut-ui-fly-box"><div class="uncut-ui-fly-a"></div><div class="uncut-ui-fly-b"></div></div>';
    host.appendChild(layer);
  }
  layer.__snaps ??= new Map();
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:50";
  const box = layer.firstElementChild as HTMLElement;
  const slotA = box.children[0] as Holder;
  const slotB = box.children[1] as HTMLElement;
  const dur = Math.max(0.05, num(f.dur, 0.7));
  const raw = (t - f.at) / dur;
  const to = isElement(f.to) ? f.to : null;
  const from = isElement(f.from) ? f.from : null;
  // The landing element is hidden while the copy flies; the from element leaves once the flight starts (leave).
  if (to) to.style.visibility = raw >= 0 && raw < 1 ? "hidden" : "";
  if (from && f.leave) from.style.visibility = raw >= 0 ? "hidden" : "";

  // Landed, not started from an element yet, or an end gone with a later state: nothing shows.
  if (raw >= 1 || !f.to || !f.from || (raw < 0 && !isPieceKey(f.from))) {
    layer.style.display = "none";
    return { x: 0, y: 0, w: 0, h: 0, p: raw >= 1 ? 1 : 0, el: null };
  }
  // The start: a piece key's box (built here), an element's rect, or a rect.
  let A: Rect;
  let built: Built | null = null;
  let press = 1;
  if (isPieceKey(f.from)) {
    const k = resolveKey(f.from, host);
    built = buildPiece(slotA, k);
    const b = keyBox(k, built);
    A = { x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h };
    press = num(k.press, 1);
  } else if (from) A = rectIn(from, host);
  else A = f.from as Rect;
  const B: Rect = to ? rectIn(to, host) : (f.to as Rect);

  if (raw < 0 && !built) {
    layer.style.display = "none";
    return { x: A.x + A.w / 2, y: A.y + A.h / 2, w: A.w, h: A.h, p: 0, el: null };
  }
  layer.style.display = "block";
  const q = Math.max(0, raw);
  const p = settle(q);
  const arc = num(f.arc, 0) * 4 * p * (1 - p);
  const cur = { x: A.x + (B.x - A.x) * p, y: A.y + (B.y - A.y) * p + arc, w: A.w + (B.w - A.w) * p, h: A.h + (B.h - A.h) * p };
  // The copies: the start's (an element's look, inline) and the landing element's, cached by their markup.
  const snap = (slot: string, el: HTMLElement) => {
    const key = `${el.outerHTML.length}:${el.offsetWidth}x${el.offsetHeight}:${el.outerHTML.slice(0, 400)}:${el.textContent}`;
    let s = layer!.__snaps!.get(slot);
    if (!s || s.key !== key) {
      const view = doc.defaultView!;
      const cs = view.getComputedStyle(el);
      const node = snapshot(el);
      node.style.backgroundColor = "transparent";
      node.style.borderRadius = "0";
      node.style.border = "0";
      s = { key, node, w: el.offsetWidth || 1, h: el.offsetHeight || 1, bg: cs.backgroundColor, r: parseFloat(cs.borderTopLeftRadius) || 0 };
      layer!.__snaps!.set(slot, s);
    }
    return s;
  };
  const sb = to ? snap("b", to) : null;
  if (sb && slotB.firstElementChild !== sb.node) slotB.replaceChildren(sb.node);
  if (!sb) slotB.replaceChildren();
  let rA = 0;
  let bgA = "rgba(0, 0, 0, 0)";
  if (built) {
    rA = (built.radius * A.w) / built.w;
    bgA = built.bg;
  } else if (from) {
    const sa = snap("a", from);
    if (slotA.firstElementChild !== sa.node) slotA.replaceChildren(sa.node);
    rA = (sa.r * A.w) / sa.w;
    bgA = sa.bg;
  } else slotA.replaceChildren();
  const rB = sb ? (sb.r * B.w) / sb.w : rA;
  const bgB = sb ? sb.bg : bgA;
  // The hand-over: the landing look comes in over the start's, which goes once it is mostly in.
  const inB = smooth((q - 0.2) / 0.25);
  const outA = smooth((q - 0.32) / 0.18);
  const place = (node: HTMLElement, w: number, h: number, alpha: number, cover: boolean) => {
    const s = cover ? Math.max(cur.w / w, cur.h / h) : Math.min(cur.w / w, cur.h / h);
    node.style.transformOrigin = "0 0";
    node.style.transform = `translate(${(cur.w - w * s) / 2}px, ${(cur.h - h * s) / 2}px) scale(${s})`;
    node.style.opacity = String(Math.round(alpha * 1000) / 1000);
    node.style.visibility = alpha > 0.001 ? "visible" : "hidden";
  };
  slotA.style.cssText = slotB.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible";
  if (built) {
    built.node.style.position = "absolute";
    place(built.node, built.w, built.h, raw < 0 ? 1 : 1 - outA, false);
  } else if (slotA.firstElementChild) {
    const sa = layer.__snaps.get("a")!;
    place(sa.node, sa.w, sa.h, 1 - outA, f.fit !== "contain");
  }
  if (sb) place(sb.node, sb.w, sb.h, raw < 0 ? 0 : inB, f.fit !== "contain");
  const bg = mixRgba(bgA, bgB, raw < 0 ? 0 : inB);
  const r = rA + (rB - rA) * p;
  const lift = raw < 0 ? (built && f.from && (f.from as PieceKey).shadow !== false ? 1 : 0) : Math.sin(Math.PI * Math.min(1, q * 1.4)) * (1 - p) + (built ? 1 - p : 0);
  const shadow = lift > 0.01 ? `;box-shadow:0 ${(2 + 22 * lift).toFixed(1)}px ${(6 + 50 * lift).toFixed(1)}px rgb(0 0 0 / ${(0.1 + 0.22 * Math.min(1, lift)).toFixed(3)})` : "";
  const pz = raw < 0 ? press : 1;
  box.style.cssText = `position:absolute;left:${cur.x}px;top:${cur.y}px;width:${cur.w}px;height:${cur.h}px;border-radius:${Math.min(r, cur.w / 2, cur.h / 2)}px;background:${bg};overflow:hidden;transform:scale(${pz});transform-origin:50% 50%${shadow}`;
  return { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2, w: cur.w, h: cur.h, p: raw < 0 ? 0 : p, el: built?.el ?? null };
}

/** One piece on its own: sequence with one key (the same pixels as that key at rest). Returns the slot's element. */
function piece(host: HTMLElement, id: string, props?: Omit<PieceKey, "piece" | "at">): HTMLElement {
  return sequence(host, 0, [{ ...(props || {}), piece: id, at: 0 }]).el;
}

/** An element's rect in host px { x, y, w, h } (its top-left; a cursor's target, a headline pinned to a piece). */
function rectIn(el: Element, host: HTMLElement): { x: number; y: number; w: number; h: number } {
  const a = el.getBoundingClientRect();
  const b = host.getBoundingClientRect();
  const s = host.offsetWidth ? b.width / host.offsetWidth : 1;
  return { x: (a.left - b.left) / s, y: (a.top - b.top) / s, w: a.width / s, h: a.height / s };
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

const SPINNER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';
const CURSOR_SVG = '<svg viewBox="0 0 20 30" width="100%" height="100%" style="display:block;overflow:visible;filter:drop-shadow(0 1px 1.5px rgb(0 0 0 / 35%))"><path d="M3.6 3 L3.6 24.2 L8.6 19.4 L11.9 27 L15.1 25.6 L11.9 18.2 L18.6 18.2 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

export {};
