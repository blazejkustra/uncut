// The pure half of the UI parts generator (scripts/ui-parts.ts): what the harness captured, turned
// into assets/graphic-libs/ui.js (the scoped CSS, the parts' markup, the runtime), and the hash of
// the inputs the parts are made from (test/core/ui-parts.test.ts compares it with ui.js's).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";

/** One scene's capture (apps/web/src/uiparts/extract.ts). */
export interface SceneCapture {
  readonly parts: Readonly<Record<string, { readonly html: string; readonly width: number; readonly height: number; readonly ancestors: ReadonlyArray<unknown>; readonly [key: string]: unknown }>>;
  readonly rules: ReadonlyArray<{ readonly key: string; readonly selectors: ReadonlyArray<string>; readonly body: string; readonly rootish: boolean }>;
  readonly keyframes: Readonly<Record<string, string>>;
}
export type Capture = Readonly<Record<string, SceneCapture>>;

/**
 * What the parts are made from: every stylesheet of the editor, every module the harness reaches
 * through relative imports (the editor part is the whole window, so any component App draws, its
 * helpers and the store can change a part), the web app's package.json (its dependencies' versions),
 * and the generator itself. A change to any of them can change a part, so ui.js must be regenerated
 * (node scripts/ui-parts.ts). Not tracked: the lockfile and workspace packages (@uncut/contracts).
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
  out.push(...importClosure(join(web, "uiparts/harness.tsx")));
  for (const f of ["scripts/ui-parts.ts", "scripts/ui-parts-lib.ts", "apps/web/src/uiparts/extract.ts", "apps/web/src/uiparts/runtime.ts", "apps/web/uiparts.html", "apps/web/package.json"]) out.push(join(root, f));
  return [...new Set(out)].map((f) => relative(root, f)).sort();
}

/** Every .ts/.tsx module reachable from entry through relative imports (static, side-effect and dynamic), entry included. */
export function importClosure(entry: string): Array<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = resolve(dirname(f), m[1]!);
      const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((p) => /\.tsx?$/.test(p) && existsSync(p) && statSync(p).isFile());
      if (hit) queue.push(hit);
    }
  }
  return [...seen].sort();
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
export const UI_HEADER = `/* uncutUI (Uncut, MIT): Uncut's own editor UI for a film about Uncut itself: the real app's markup
   and CSS, generated from its React components (scripts/ui-parts.ts), as live DOM (crisp at any
   size). Load it with the marker uncut:lib/ui.js (a script tag with that src). Dark, as the app.
   Build the film from PIECES: one element of the UI on its own (the composer, a step row, a lane of
   clips, the filter slider, the preview, Export, Saved), set LARGE on a calm canvas (60 to 90 % of
   the width, its text 3.5 % of the frame's height or more), each one morphing into the next. A whole
   panel only briefly, and only when its words read on a phone; never a camera panning over a
   desktop-sized window: that reads as a screen recording.
     uncutUI.sequence(host, t, keys, { dur: 0.5 })    // ONE shell carried through keys (call it every frame):
       keys: [{ at, piece: "composer", props, size: { width: 300 }, width: 920, x: 540, y: 675 }, { at: 2, piece: "turn.steps", ... }]
       piece: "part.slot" (or "part"); props: the part's props below; index: the nth match; x, y: its centre
       in host px; width: its width in host px; size: its own layout size in app px (narrower wraps its text,
       so it sets larger: the composer at 300 shown 920 wide); height: a taller or wider shell; pad, radius,
       background (its shell's, default the piece's own look); press: the shell's scale (uncutMotion.click's
       .button); fit: "contain" | "cover" (default cover for preview.frame); shadow: false; dur: its morph.
       From each key's at the shell's centre, size, radius and colour travel to it in dur s (critically damped:
       no overshoot) while the old content leaves and the new one arrives inside it, both at one uniform
       scale (text never stretches): the send button's composer becomes the agent's steps, a step becomes the
       lane its clips land on. The same piece twice (one more step) grows without a crossfade. Pure in t.
       Returns { x, y, w, h, r, p, key, el } (el: the shown piece's element, for find and rectIn).
     uncutUI.piece(host, "export.high", { props, width, x, y, ... })  // one piece alone (sequence's key at rest)
     uncutUI.rectIn(el, host)                         // { x, y, w, h }: an element's rect in host px (aim a click at Send)
     uncutUI.mount(host, name, props)                 // a whole part (returns its root): rarely, briefly
     uncutUI.parts()                                  // editor, topbar, agent, message, turn, review, timeline, preview,
                                                      // composer, storyboard, export, exportProgress, inspector, effects
     uncutUI.slots(name), uncutUI.size(name)          // its slots (what a piece can be); its box in the app, CSS px
     uncutUI.find(root, slot), uncutUI.findAll(root, slot)  // a slot's element (or any CSS selector's) in a part or piece
   Pieces (part.slot): composer, composer.box, composer.send; message; turn.steps, turn.step, turn.edit,
     turn.review; storyboard.beat, storyboard.approve; review.score; timeline.main, timeline.lane, timeline.clip,
     timeline.playhead; preview.frame, preview.play; inspector.amount (a filter's slider), inspector.effect,
     inspector.filter; effects.warm (any look: natural, cool, vintage, film, bw, vivid), effects.tile, effects.filters;
     export.draft, export.standard, export.high, export.export; exportProgress.progress, exportProgress.bar;
     topbar.export, topbar.saved, topbar.title.
   Props (every part): text { slot: "..." }; press { slot: scale }; highlight, hide (keeps its room), remove (slot
   or [slots]); background (mount: "none" or a colour behind a part that isn't opaque). Each part's own:
       composer: text (typed so far; empty disables Send), caret, placeholder, context ("Playhead 00:00:12:00")
       message: text (the user's prompt bubble)
       turn: steps: ["Read the brand kit", ...], done (rows done, the rest running), edit (the edit row's label),
         reply (the agent's answer), review (true, or the review's props: its card in the turn), status
       storyboard: summary, beats: [{ start, end, title, lines: ["..."] }], count (the first n)
       review: scores { hook, readability, motion, variety, sound, brand } (0 to 10), progress 0..1, status, title
       timeline: clips: [{ track: "Main" | "Text" | "Graphics" | "Audio" | "Sound effects" | index, start, duration
         (s), name, image, selected, color }]: the whole timeline (it starts empty); playhead (s)
       preview: frame (your canvas or img: it fills the frame), time (s: the timecode)
       inspector: title (the clip's name), filter (the look's name on its slider), amount (0 to 100),
         filter: false, effects: false (those sections out)
       effects: active (the look picked: "warm"; none: ""), target ("On DJI 0063")
       export: quality ("draft" | "standard" | "high"), file ("Launch film.mp4"), motionBlur
       exportProgress: progress 0..1 ("Rendering... 42%"), eta (s left)
       topbar: exportLabel ("Exporting 42%")
       agent (the side panel), editor (the window, 1920 x 900): the parts inside by name ({ composer: { text } });
         editor: media: [{ name, meta, image }] (the library's tiles)
   An image is a data: or blob: URL: await uncut.url(id, seconds) once before the first frame (an uncut:media/
   marker only resolves in the graphic's own HTML). Nothing of the fixture shows unless you pass it: no prompt
   in a message, no clips, media tiles, reply, edit count or review card in a turn; the review says
   "Reviewing" with empty bars, no round, model, time or time left. Run facts are real or absent: pass a result,
   round, score or timing only from this run's real results (review_submit, beat_grid), never invented.
     uncutUI.cursor(host, { x, y, scale, size: 28 })  // the macOS pointer, its tip at (x, y) in host px
     uncutUI.timecode(seconds, fps), uncutUI.css()    // "00:00:12:30"; the parts' CSS (added once by mount)
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
  piece: piece,
  sequence: sequence,
  rectIn: rectIn,
  cursor: cursor,
  timecode: timecode,
  css: css,
};
})();
`;
}
