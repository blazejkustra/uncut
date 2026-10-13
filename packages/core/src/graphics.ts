// `graphic` items (D78): the escape hatch for anything the components don't cover. The agent (with
// graphic_write) or the user writes an HTML file in the project's graphics/ folder that defines
// `render(t, info)`; Uncut calls it for each frame (t = seconds from the item's start). The preview
// shows it in a sandboxed iframe (served by the local server with its own CSP), the export draws it
// frame by frame in an offscreen Chromium window; both load the same document (graphicDocument) and
// call render the same way, so preview == export.
//
// Limits: full canvas (no box; opacity, fades and transitions apply); no network, no Node, no
// other files (CSP: inline scripts and styles, data: images and fonts only); system fonts (the
// bundled DM fonts aren't loaded inside it); render(t) must draw synchronously or return a promise
// that settles within GRAPHIC_FRAME_MS; the export draws at most MAX_RASTER_STATES frames of one
// item (past that it holds frames: every k-th frame is drawn and shown k frames); the file is read
// when the export starts or the preview loads it (write a new file to change a graphic: graphic_write
// never overwrites, so earlier revisions keep their look).
import type { Canvas, Item } from "./types.ts";

/** Where graphic files live in a project, and what their names look like (project.schema.json `src`). */
export const GRAPHIC_SRC = /^graphics\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.html$/;
/** The most a graphic file may hold (bytes). */
export const MAX_GRAPHIC_BYTES = 256 * 1024;
/** How long one render(t) may take before the frame fails (ms). */
export const GRAPHIC_FRAME_MS = 5000;
/** The most distinct pictures the export draws for one animated layer (a component or a graphic) before it holds frames. */
export const MAX_RASTER_STATES = 360;

/** The CSP of a graphic's document: its own inline script and styles, data: images and fonts, nothing else. */
export const GRAPHIC_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** What render(t, info) gets besides t. */
export interface GraphicInfo {
  readonly frame: number;
  readonly fps: number;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly props: { readonly [key: string]: unknown };
}

export const graphicInfo = (item: Pick<Item, "duration" | "props">, canvas: Pick<Canvas, "width" | "height"> & { readonly fps: number }, local: number): GraphicInfo => ({
  frame: local,
  fps: canvas.fps,
  duration: item.duration,
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
export function graphicDocument(html: string, canvas: Pick<Canvas, "width" | "height">): string {
  const size = `width:${canvas.width}px;height:${canvas.height}px`;
  // The bootstrap goes in <head>, before the author's markup: an unclosed <script>, <!--, <textarea>
  // or <title> in their HTML can't swallow it. It only looks up window.render when called.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${GRAPHIC_CSP}">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;${size}}</style>
<script>(() => {
  const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  window.__uncutRender = async (t, info) => {
    if (typeof window.render === "function") await window.render(t, info);
    await frames();
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
