// The pure half of the UI parts generator (scripts/ui-parts.ts): what the harness captured, turned
// into assets/graphic-libs/ui.js (the scoped CSS, the parts' markup, the runtime), and the hash of
// the inputs the parts are made from (test/core/ui-parts.test.ts compares it with ui.js's).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripTypeScriptTypes } from "node:module";

/** One scene's capture (apps/web/src/uiparts/extract.ts). */
export interface SceneCapture {
  readonly parts: Readonly<Record<string, { readonly html: string; readonly width: number; readonly height: number; readonly ancestors: ReadonlyArray<unknown>; readonly [key: string]: unknown }>>;
  readonly rules: ReadonlyArray<{ readonly key: string; readonly selectors: ReadonlyArray<string>; readonly body: string; readonly rootish: boolean }>;
  readonly keyframes: Readonly<Record<string, string>>;
}
export type Capture = Readonly<Record<string, SceneCapture>>;

/**
 * What the parts are made from: every stylesheet of the editor, the components whose markup the
 * parts are, the fixture and harness, and the generator itself. A change to any of them can change
 * a part, so ui.js must be regenerated (node scripts/ui-parts.ts).
 */
export function uiPartsInputs(root: string): Array<string> {
  const web = join(root, "apps/web/src");
  const out: Array<string> = [];
  const walk = (dir: string, keep: (f: string) => boolean) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, keep);
      else if (keep(p)) out.push(p);
    }
  };
  walk(web, (f) => f.endsWith(".css"));
  for (const dir of ["editor", "timeline", "preview", "panels/agent", "panels/composer", "panels/exportDialog", "uiparts"]) walk(join(web, dir), (f) => /\.tsx?$/.test(f));
  for (const f of ["panels/Agent.tsx", "panels/AgentCards.tsx", "panels/Composer.tsx", "panels/ExportDialog.tsx", "panels/TokenMeter.tsx", "panels/Library.tsx", "panels/library/MediaLibrary.tsx", "panels/library/MediaTile.tsx", "onboarding/Onboarding.tsx"]) out.push(join(web, f));
  for (const f of ["scripts/ui-parts.ts", "scripts/ui-parts-lib.ts", "apps/web/src/uiparts/extract.ts", "apps/web/uiparts.html"]) out.push(join(root, f));
  return [...new Set(out)].map((f) => relative(root, f)).sort();
}

/** sha256 of the inputs (path and content, line endings normalised), hex. */
export function uiPartsInputHash(root: string): string {
  const h = createHash("sha256");
  for (const f of uiPartsInputs(root)) {
    h.update(`${f}\n`);
    h.update(readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n"));
    h.update("\n\0");
  }
  return h.digest("hex");
}

/** The hash a ui.js was generated from (its second comment). */
export const libInputHash = (lib: string): string | undefined => /\/\* uncut-ui-inputs: ([0-9a-f]{64}) \*\//.exec(lib)?.[1];

const ROOT_PREFIX = /^(?:(?::root|html|body|#root)(?:\[[^\]]*\])*\s*(?:>\s*)?)+/;

/** One selector scoped under .uncut-ui (the page's own root and body selectors become the scope). */
export function scopeSelector(selector: string): string {
  const s = selector.trim();
  if (s === "*") return ".uncut-ui, .uncut-ui *";
  const rest = s.replace(ROOT_PREFIX, "");
  return rest ? `.uncut-ui ${rest}` : ".uncut-ui";
}

/** The declarations of the page's root rules a part may take: variables, colour and font (never the page's background, size or overflow). */
function rootBody(selectors: ReadonlyArray<string>, body: string): string {
  if (selectors.includes(":root")) return body;
  return body
    .split(/;(?![^(]*\))/)
    .map((d) => d.trim())
    .filter((d) => /^(--[\w-]+|color|font(-[a-z-]+)?|line-height|letter-spacing|-webkit-font-smoothing)\s*:/.test(d))
    .join("; ");
}

/** Uncut's own additions to the parts' CSS: the composer's caret. */
const EXTRA_CSS = ".uncut-ui{text-align:left;-webkit-font-smoothing:antialiased}.uncut-ui .uncut-ui-caret{display:inline-block;width:1.5px;height:1.2em;margin:0 -1.5px 0 0;vertical-align:-0.25em;background:var(--fg)}";

/** A rule body without transitions or animations: they run on the wall clock, and a graphic's frame is a function of t alone. */
function timeless(body: string): string {
  return body
    .split(/;(?![^(]*\))/)
    .map((d) => d.trim())
    .filter((d) => d && !/^(transition|animation)(-[a-z-]+)?\s*:/.test(d))
    .join("; ");
}

/** The scoped CSS of every scene's kept rules, in stylesheet order, without transitions or animations. */
export function partsCss(capture: Capture): string {
  const byKey = new Map<string, { selectors: Set<string>; body: string; rootish: boolean }>();
  for (const scene of Object.values(capture)) {
    for (const r of scene.rules) {
      const hit = byKey.get(r.key);
      if (hit) for (const s of r.selectors) hit.selectors.add(s);
      else byKey.set(r.key, { selectors: new Set(r.selectors), body: r.body, rootish: r.rootish });
    }
  }
  const out: Array<string> = [];
  for (const key of [...byKey.keys()].sort()) {
    const r = byKey.get(key)!;
    const body = timeless(r.rootish ? rootBody([...r.selectors], r.body) : r.body);
    if (!body.trim()) continue;
    const selectors = [...new Set([...r.selectors].map(scopeSelector))];
    out.push(`${selectors.join(",")}{${body}}`);
  }
  return [...out, EXTRA_CSS].join("\n");
}

/** Every scene's parts in one map (each part comes from one scene). */
export function partsOf(capture: Capture): Record<string, SceneCapture["parts"][string]> {
  const out: Record<string, SceneCapture["parts"][string]> = {};
  for (const scene of Object.values(capture)) Object.assign(out, scene.parts);
  return out;
}

/** The runtime's source as plain JS (types stripped, the module marker removed). */
export function runtimeJs(source: string): string {
  return stripTypeScriptTypes(source)
    .replace(/^export \{\};\s*$/m, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The library's header: its API for the agent (docs_read graphics carries it word for word). */
export const UI_HEADER = `/* uncutUI (Uncut, MIT): Uncut's own editor UI as parts a graphic animates, for a film about Uncut
   itself: build it from these instead of redrawing panels. Load it with the marker uncut:lib/ui.js
   (a script tag with that src). Each part is the real app's markup and CSS, generated from its
   React components (scripts/ui-parts.ts), as live DOM: scale it, move it with uncutMotion.cameraCSS,
   clip it with uncutMotion.shapeCSS or growCSS, put footage in its preview frame. Dark, as the app.
     uncutUI.parts()                                  // the names: editor, topbar, agent, message, turn, review,
                                                      // timeline, preview, composer, storyboard, export, exportProgress
     uncutUI.size(name)                               // { width, height }: its box in the app, CSS px at scale 1
     uncutUI.mount(host, name, props)                 // puts the part in host (a div you position) and returns its root;
                                                      // call it every frame: the same props give the same picture
       props for every part: scale (1); width, height (its box, px before scale); text { slot: "..." };
       press { slot: scale } (uncutMotion.click's .button); highlight: slot or [slots] (a selection ring);
       hide: slot or [slots]; background ("none" or a colour: behind a part that isn't opaque, by
       default the panel it sat on in the app)
       composer: text (typed so far; empty disables Send), caret (true: a text caret after it), placeholder,
         context ("Playhead 00:00:12:00"); slots input, send, attach, model, context
       message: text (the user's prompt bubble)
       turn: reply, steps: ["Read the brand kit", ...]; slots reply, steps, review
       storyboard: summary, beats: [{ start, end, title, lines: ["...", ...] }], count (show the first n);
         slots summary, beat, approve, edit
       review: progress 0..1 (the score bars fill), scores { hook, readability, motion, variety, sound, brand }
         (0 to 10), status ("Passed", "Reviewing"), title; slots status, score, bar
       timeline: clips: [{ track: "Main" | "Text" | "Audio" | "Sound effects" | index, start, duration (s),
         name, image (a data: URL or uncut:media/<id>: the clip's filmstrip), selected, color }] (replaces
         those tracks' clips), playhead (s), selected: [clip indexes]; slots playhead, clip, ruler, lanes
       preview: frame (an element of yours, a canvas or an img with uncut.frame's picture: it fills the
         preview's frame), time (s: the timecode); slots frame, transport, play
       export: quality ("draft" | "standard" | "high"), file ("Launch film.mp4"), motionBlur (true or false);
         slots draft, standard, high, file, motionBlur, export, cancel
       exportProgress: progress 0..1 (the bar and "Rendering... 42%"), eta (s left); slots fill, cancel
       topbar: exportLabel ("Exporting 42%"); slots export, saved, title
       agent (the whole side panel), editor (the whole window, 1920 x 900): the props of the parts inside
         them by name, editor: { composer: { text }, timeline: { playhead: 4 }, preview: { frame: canvas } }
     uncutUI.slots(name)                              // its slot names (the elements a film reaches for)
     uncutUI.find(root, slot)                         // the slot's element (or any CSS selector's) in a mounted part
     uncutUI.findAll(root, slot)                      // every match
     uncutUI.cursor(host, { x, y, scale, size: 28 })  // the macOS pointer, its tip at (x, y) in host px
     uncutUI.timecode(seconds, fps)                   // "00:00:12:30", the editor's timecode
     uncutUI.css()                                    // the parts' CSS (scoped under .uncut-ui), added once by mount
   Text inside parts is real text: keep a part's UI line 3.5 % of the frame's height or more (scale, camera).
   The fonts are the Mac's system UI fonts, as in the app; nothing loads from the network. */`;

/**
 * The parts with their repeated pieces (icons, waveform images) moved into a pool, each once: a
 * part's markup refers to pool entry i as \u0001i\u0002 (the runtime puts them back).
 */
export function pooled(parts: Record<string, SceneCapture["parts"][string]>): { parts: Record<string, SceneCapture["parts"][string]>; pool: Array<string> } {
  const pool: Array<string> = [];
  const index = new Map<string, number>();
  const ref = (piece: string) => {
    let i = index.get(piece);
    if (i === undefined) {
      i = pool.push(piece) - 1;
      index.set(piece, i);
    }
    return `\u0001${i}\u0002`;
  };
  const out: Record<string, SceneCapture["parts"][string]> = {};
  for (const [name, p] of Object.entries(parts)) out[name] = { ...p, html: p.html.replace(/<svg[\s\S]*?<\/svg>|data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, ref) };
  return { parts: out, pool };
}

/** ui.js: the header, the inputs' hash, then the data and the runtime in one IIFE that sets window.uncutUI. */
export function buildUiLib(capture: Capture, hash: string, runtimeSource: string): string {
  const data = { css: partsCss(capture), ...pooled(partsOf(capture)) };
  // No "<" in the data at all: nothing in it can close the inline script it is inlined into.
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
  return `${UI_HEADER}
/* uncut-ui-inputs: ${hash} */
(function () {
var DATA = ${json};

${runtimeJs(runtimeSource)}

window.uncutUI = {
  parts: parts,
  size: size,
  slots: slots,
  mount: mount,
  find: find,
  findAll: findAll,
  cursor: cursor,
  timecode: timecode,
  css: css,
};
})();
`;
}
