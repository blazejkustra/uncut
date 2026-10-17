// `graphic` items (D78): the escape hatch for anything the components don't cover. The agent (with
// graphic_write) or the user writes an HTML file in the project's graphics/ folder that defines
// `render(t, info)`; Uncut calls it for each frame (t = seconds from the item's start). The preview
// shows it in a sandboxed iframe (served by the local server with its own CSP), the export draws it
// frame by frame in an offscreen Chromium window; both load the same document (graphicDocument) and
// call render the same way, so preview == export.
//
// Limits: full canvas (no box; opacity, fades and transitions apply); no network, no Node, no
// other files (CSP: inline scripts and styles, data: images and fonts only); fonts: the bundled DM
// Sans and DM Mono, the brand kit's font files (both declared inside the document when it names
// them, D198, fonts.ts resolveGraphicFonts) and the fonts installed on this Mac; every face is
// loaded before the first render(t), so canvas text isn't drawn in a fallback; render(t) must draw synchronously or return a promise
// that settles within GRAPHIC_FRAME_MS; the export draws every frame (D291: streamed raw to ffmpeg,
// with motion blur's sub-frames when it's on; the preview draws no blur); the file is read
// when the export starts or the preview loads it (write a new file to change a graphic: graphic_write
// never overwrites, so earlier revisions keep their look).
//
// Bundled libraries (D193): a graphic loads one with a marker, <script src="uncut:lib/three.js">
// </script> (also confetti.js, globe.js, spring.js, random.js, motion.js, ui.js). resolveGraphicLibs replaces each
// marker with the library's source as an inline script (so the CSP stays as it is and nothing loads
// from anywhere), right after the graphic file is read (the server's readGraphics, which the preview
// route, the export and render_frames all go through), so preview == export by construction. Core
// can't read files: the server passes the sources (assets/graphic-libs, ServerConfig
// graphicLibsDir). MAX_GRAPHIC_BYTES caps the author's file, not the libraries; with every library
// in, a document stays under MAX_GRAPHIC_DOC_BYTES (the export loads it as a data: URL, which
// Chromium caps at 2 MB of URL, base64).
import type { Canvas, Item } from "../timeline/types.ts";
import { GRAPHIC_MEDIA_BOOT, GRAPHIC_MEDIA_SCHEME } from "./graphicMedia.ts";

/** Where graphic files live in a project, and what their names look like (project.schema.json `src`). */
export const GRAPHIC_SRC = /^graphics\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.html$/;
/** The most a graphic file may hold (bytes). */
export const MAX_GRAPHIC_BYTES = 256 * 1024;
/** How long one render(t) may take before the frame fails (ms). */
export const GRAPHIC_FRAME_MS = 5000;
/** The CSP of a graphic's document: its own inline script and styles, data: images and fonts, nothing else; D290: the project's media through the rasteriser's own scheme (blob: images of them). */
export const GRAPHIC_CSP = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src ${GRAPHIC_MEDIA_SCHEME}:`;

/** What render(t, info) gets besides t. */
export interface GraphicInfo {
  readonly frame: number;
  readonly fps: number;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly props: { readonly [key: string]: unknown };
}

/**
 * The graphic's own frame shown `local` frames into its item: from the item's `in` (frames of the
 * graphic before what the item shows: a cut-off start, a split's second half, a range export's
 * slice), held at the item's first and last frame before and after it.
 */
export const graphicLocal = (item: Pick<Item, "duration" | "in">, local: number): number => (item.in ?? 0) + Math.max(0, Math.min(item.duration - 1, local));

/** What render(t, info) gets at the graphic's own frame `local` (graphicLocal); its duration counts from the graphic's start, `in` included. */
export const graphicInfo = (item: Pick<Item, "duration" | "props" | "in">, canvas: Pick<Canvas, "width" | "height"> & { readonly fps: number }, local: number): GraphicInfo => ({
  frame: local,
  fps: canvas.fps,
  duration: (item.in ?? 0) + item.duration,
  width: canvas.width,
  height: canvas.height,
  props: item.props ?? {},
});

/**
 * A graphic file's HTML as the document both the preview and the export load: canvas-sized,
 * transparent, the strict CSP, and a bootstrap after the author's markup. window.__uncutRender(t,
 * info) calls their render and resolves two animation frames later (so what's captured is drawn);
 * the preview's iframe gets the same call by postMessage ({ uncut: "render", seq, t, info }) and
 * answers { uncut: "rendered", seq }.
 */
/** The libraries a graphic may load with <script src="uncut:lib/<name>"></script> (D193). */
export const GRAPHIC_LIBS = ["three.js", "confetti.js", "globe.js", "spring.js", "random.js", "motion.js", "ui.js"] as const;
export type GraphicLib = (typeof GRAPHIC_LIBS)[number];

/** The most a graphic's whole document may hold, libraries in (bytes): base64 of it must stay under Chromium's 2 MB URL limit. */
export const MAX_GRAPHIC_DOC_BYTES = 1_400_000;

// A marker: a script element whose only attribute is src="uncut:lib/<name>", empty.
const LIB_MARKER = /<script\s+src\s*=\s*(["'])uncut:lib\/([^"'<>\s]*)\1\s*>\s*<\/script\s*>/gi;

/** Which libraries a graphic's HTML asks for, known and unknown (each once, in order); for graphic_write's note. */
export function graphicLibsUsed(html: string): { readonly known: Array<string>; readonly unknown: Array<string> } {
  const known: Array<string> = [];
  const unknown: Array<string> = [];
  for (const m of html.matchAll(LIB_MARKER)) {
    const name = m[2]!;
    const list = (GRAPHIC_LIBS as ReadonlyArray<string>).includes(name) ? known : unknown;
    if (!list.includes(name)) list.push(name);
  }
  return { known, unknown };
}

/**
 * The graphic's HTML with each library marker replaced by the library's source (`libs`: name →
 * source) as an inline classic script, once per library (a repeated marker becomes a comment); a
 * marker for a library that isn't there becomes a comment saying so (the graphic then fails where
 * it uses it, visibly). Nothing else in the HTML changes.
 */
export function resolveGraphicLibs(html: string, libs: Readonly<Record<string, string>>): string {
  // Each library once: a second marker for it is a comment (so a document never holds two copies,
  // which could take it past the export's data: URL limit while the preview still loaded it).
  const seen = new Set<string>();
  return html.replace(LIB_MARKER, (_marker, _q, name: string) => {
    const source = (GRAPHIC_LIBS as ReadonlyArray<string>).includes(name) && Object.hasOwn(libs, name) ? libs[name] : undefined;
    const safe = name.replace(/--/g, "- -");
    if (source === undefined) return `<!-- uncut:lib/${safe} is not a bundled library (bundled: ${GRAPHIC_LIBS.join(", ")}) -->`;
    if (seen.has(name)) return `<!-- uncut:lib/${safe} is already loaded above -->`;
    seen.add(name);
    // An inline script ends at the first </script: keep any inside the source from closing it.
    return `<script>/* uncut:lib/${safe} */\n${source.replace(/<\/(script)/gi, "<\\/$1")}\n</script>`;
  });
}

// D198: uncut:brand/logo-light (also logo-dark, logo-mark), in an attribute or a CSS url().
const BRAND_MARKER = /uncut:brand\/logo-(light|dark|mark)\b/g;
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Which kit logos a graphic asks for (uncut:brand/logo-…), each once. */
export function graphicLogosUsed(html: string): Array<"light" | "dark" | "mark"> {
  return [...new Set([...html.matchAll(BRAND_MARKER)].map((m) => m[1] as "light" | "dark" | "mark"))];
}

/** The graphic's HTML with each uncut:brand/logo-… marker replaced by the kit's logo as a data: URL (a missing one: a blank pixel). */
export function resolveGraphicBrand(html: string, logos: Readonly<Partial<Record<"light" | "dark" | "mark", string>>>): string {
  return html.replace(BRAND_MARKER, (_m, slot: "light" | "dark" | "mark") => logos[slot] ?? BLANK);
}

/** For the agent's system prompt (D193): the render(t) contract and the bundled libraries. */
export const GRAPHIC_LIBS_DOC = [
  "Graphics (graphic_write) draw everything from t alone: render(t, info) is called for each frame in any order, in the preview and again in the export, so no timers, no requestAnimationFrame loops, no Date.now or performance.now, no Math.random (use uncutRandom(seed)), no state carried from one frame to the next; nothing loads from the network.",
  'Bundled libraries load with a marker in the HTML, inlined by Uncut (the same in the preview and the export): <script src="uncut:lib/three.js"></script>, and likewise uncut:lib/confetti.js, uncut:lib/globe.js, uncut:lib/spring.js, uncut:lib/random.js, uncut:lib/motion.js, uncut:lib/ui.js; any other name is not loaded.',
  "three.js (0.169, window.THREE): create the renderer once at load, new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true }) with a canvas of info.width by info.height (renderer.setSize(info.width, info.height, false), pixel ratio 1), then inside render(t) set the camera and every object from t and call renderer.render(scene, camera).",
  "uncutConfetti.draw(ctx, t, { seed, count, at, origin: { x, y } as canvas fractions, angle, spread, velocity, gravity, drag, size, life, colors, shapes }) draws a confetti burst on a 2D context as a pure function of t (clear the canvas first).",
  "uncutGlobe.draw(ctx, t, { x, y, radius, dots, rotation, speed in degrees per second, tilt, dotSize, ocean, markers: [{ lat, lon, color, size }], colors: { dot, marker, sphere, rim } }) draws a dotted spinning globe; uncutGlobe.project(ctx, t, lat, lon, options) gives { x, y, visible }.",
  'uncutSpring(t, "spring.land" or { stiffness, damping, mass, velocity }) is the spring Uncut uses for eases (0 at t = 0 seconds, settling at 1; presets spring.snap, spring.settle, spring.land, spring.bounce), with uncutSpring.ease(preset)(p) fitted to p from 0 to 1.',
  'uncutMotion (motion.js) is for one-take motion films, all pure functions of t: springs(t, [{ at, to }], "spring.snap") sums one spring per target change (a value retargeted many times stays continuous); edges(t, [{ at, left, right }], { lead, trail }) gives a liquid tab indicator\'s two edges, the leading one on the faster spring; rise(t, { at, out, height }) gives the y of text rising out of a mask line (in an overflow: hidden box); flood(t, { at, x, y, r, width, height, dur: 0.3, until, to: { x, y, r } }) grows a circle past the frame\'s corners and contracts it into the next shape; iris(open, { x, y, r, blades: 6 }) gives blade polygons; squeeze(xs, widths, anchor, f) pulls a wordmark\'s letters into its period; cursor(t, [{ at, x, y }]) gives a drawn cursor\'s path; click(t, { from: [x, y], x, y, fire }) one believable click (a list chains them): it glides in, rests 0.1 s, presses (scale the cursor by .scale, the button by .button) and releases, and the change it causes is keyed at its fire, 0.03 s into the press, never on the cursor\'s arrival; camera(t, [{ at, x, y, zoom }]) a screen-studio camera ((x, y) the world point at the centre, zoom eased in log space), frameRect(left, top, w, h, { width, height, fit, pad, align }) the camera key that makes a UI rect fill the frame (fit: true shows all of it), apply(ctx, cam, width, height) its transform and toScreen(cam, x, y, width, height) a world point on screen; shape(t, [{ at, x, y, w, h, r } or { at, bleed: true }]) one rounded rect morphing key to key, morph(t, from, to, { at, dur: 0.3 }) rect to rect in dur s (to "bleed" fills past every edge), coverage(s, width, height) the share of the frame inside it, swap(t, at) the old content\'s exit then the new one\'s entry inside a morphing shape (alpha, a short blur, dy), shapePath(ctx, s) its path, footageRect(srcW, srcH, width, height, s) where a clip covers it (the whole frame\'s crop: a shot already on screen at another rect, a preview fitted to a card, never jumps to it on one frame, it eases there or uses it from the start); riseText(ctx, text, x, baseline, t, { at, out, size }) a line rising out of its mask; beat(n, { bpm, offset }), loop(t, duration), ease.inOut/out/in, mix, mixColor.',
  "uncutUI (ui.js) is Uncut's own editor UI as live DOM parts generated from the app's real components and CSS: editor (the whole window), topbar, agent, message, turn, review, timeline, preview, composer, storyboard, export, exportProgress. uncutUI.mount(host, name, props) on every frame puts one in a div you position, scale and clip with uncutMotion's CSS helpers; props set what changes (the composer's typed text and caret, timeline clips and playhead, the export's progress, the review's bars, your own canvas in the preview's frame, press and highlight on any slot); uncutUI.cursor(host, { x, y, scale }) draws the pointer. For a film about Uncut itself, build from these parts instead of redrawing its panels. By default a part states no run facts (the review says \"Reviewing\" with empty bars, no round, model, time or time left): pass a result, score, round or timing only from this run's real results.",
  "uncutRandom(seed) returns a seeded generator (rnd() in [0, 1), rnd.range(a, b), rnd.int(a, b), rnd.pick(list), rnd.normal()); uncutRandom.noise(seed, x) is smooth noise.",
  'Fonts: name a family in CSS font-family or in ctx.font (for example ctx.font = "600 64px \'DM Sans\', sans-serif") and Uncut declares it inside the graphic when it is DM Sans, DM Mono, a font file of the brand kit or one in the project\'s fonts folder (media_download a WOFF2/TTF/OTF of an OFL font such as Geist or Archivo puts it there), loaded before the first frame; fonts installed on this Mac work by name, and so does a family the graphic declares itself (@font-face with a data: URL). Any other family is a project_check error (it would fall back to another font), so never ask for one that isn\'t there.',
  'Brand logos: src="uncut:brand/logo-light" (also logo-dark, logo-mark) in an <img> or a CSS url() is the kit\'s logo file as it is (an SVG stays vector), inlined by Uncut.',
  'Project media (ids from project_read): const f = await uncut.frame(mediaId, seconds, { width, height }) is that video\'s frame at that moment of it (a still: any seconds) as an ImageBitmap for ctx.drawImage or a three.js texture, exact in the preview and the export; for footage that plays inside the graphic, await uncut.frame(id, start + t) inside an async render (return its promise). In markup, src="uncut:media/<id>" (a still or a video\'s first frame) or "uncut:media/<id>#t=2.5" in an <img> or a CSS url(). Pictures come at most 1920 px on their long edge (smaller when you ask for a smaller width or height), never inlined, so the 256 KB limit is about your code only.',
].join(" ");

export function graphicDocument(html: string, canvas: Pick<Canvas, "width" | "height">): string {
  const size = `width:${canvas.width}px;height:${canvas.height}px`;
  // The bootstrap goes in <head>, before the author's markup: an unclosed <script>, <!--, <textarea>
  // or <title> in their HTML can't swallow it. It only looks up window.render when called.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${GRAPHIC_CSP}">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;${size}}</style>
<script>${GRAPHIC_MEDIA_BOOT}</script>
<script>(() => {
  const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  // D198: every declared face loaded once before the first frame (canvas text doesn't wait for a font).
  let fonts;
  const fontsReady = () => (fonts ??= Promise.all([...document.fonts].map((f) => f.load().catch(() => {}))).then(() => document.fonts.ready));
  // dry (a rehearsal, nothing captured): no frames waited for after render(t).
  window.__uncutRender = async (t, info, dry) => {
    await fontsReady();
    await window.__uncutMedia.ready();
    // Whatever render throws comes back as an Error with its name and message: a DOMException
    // (drawImage of a closed bitmap, a failed decode) or a thrown string would reach the export as
    // a value without a message.
    if (typeof window.render === "function") {
      try {
        await window.render(t, info);
      } catch (e) {
        const text = e && typeof e.message === "string" ? (e.name && e.name !== "Error" ? e.name + ": " : "") + e.message : String(e);
        throw new Error(text || "render(t) failed");
      }
    }
    if (!dry) await frames();
    window.__uncutMedia.sweep();
    return true;
  };
  addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.uncut !== "render") return;
    window.__uncutRender(d.t, d.info).then(() => parent.postMessage({ uncut: "rendered", seq: d.seq }, "*"), (error) => parent.postMessage({ uncut: "rendered", seq: d.seq, error: String(error) }, "*"));
  });
})();</script></head><body>
${html}
</body></html>`;
}
