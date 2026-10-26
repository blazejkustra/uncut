// Graphics (D78) in the preview: the server's document in a sandboxed iframe, render(t) asked by
// postMessage. render(t) draws from t alone (no state carried between frames), so an iframe that
// has loaded a graphic file can draw any item of that file: iframes are pooled per file. One
// whose item ended stays loaded out of sight (at most IDLE_FRAMES of them, the least recently used
// go first) and is given the next item of its file, so a back-to-back watermark, a label used again
// or a jump back to a graphic seen before doesn't load the document, its libraries and its fonts
// again. A graphic starting within LOAD_AHEAD_S is loaded ahead, out of sight at its first frame.
import type { Visual } from "@uncut/core/timeline";
import { graphicInfo, graphicLocal } from "@uncut/core/graphics";
import type { Item, ProjectModel } from "../../state/project.ts";
import { graphicUrl } from "../../state/store.ts";
import { transitionCanvas } from "./media.ts";

/** Loaded iframes kept out of sight for their file's next item (each holds its document, and a WebGL context when it makes one). */
const IDLE_FRAMES = 6;
/** How early an upcoming graphic gets its iframe (s). */
const LOAD_AHEAD_S = 2;

export type ShownGraphic = Pick<Visual, "wipe" | "iris" | "mask" | "shift" | "shiftY" | "zoom" | "blur"> & { item: Item; opacity: number; z: number };

interface GraphicFrame {
  readonly wrap: HTMLDivElement;
  readonly frame: HTMLIFrameElement;
  readonly src: string;
  loaded: boolean;
  /** The item it draws now (undefined: idle). */
  item: string | undefined;
  /** The last render(t) asked for, and the asks not answered yet (seq to seconds of the graphic). */
  sent: string;
  readonly asked: Map<number, number>;
  renders: number;
  idleSince: number;
}

export class GraphicLayers {
  private readonly frames: Array<GraphicFrame> = [];
  // Whether the server has each graphic's document: "ok", being asked, or when to ask again.
  private readonly check = new Map<string, "ok" | "pending" | number>();
  private seq = 0;
  private readonly layer: HTMLElement;
  private readonly render: () => void;

  constructor(layer: HTMLElement, render: () => void) {
    this.layer = layer;
    this.render = render;
    addEventListener("message", this.onRendered);
  }

  dispose() {
    removeEventListener("message", this.onRendered);
    this.clear();
  }

  clear() {
    for (const g of this.frames.splice(0)) g.wrap.remove();
  }

  /** The graphics shown at `frame` (in stacking order, with their z-index) and the ones starting within LOAD_AHEAD_S on visible video tracks. */
  sync(project: ProjectModel, starts: ReadonlyMap<string, number>, frame: number, shown: ReadonlyArray<ShownGraphic>, running: boolean) {
    const fps = project.canvas.fps;
    const upcoming = this.upcoming(project, starts, frame, shown);
    const wanted = new Set([...shown.map((v) => v.item.id), ...upcoming.map((it) => it.id)]);
    for (const g of this.frames) if (g.item !== undefined && (!wanted.has(g.item) || !this.sameSrc(g, shown, upcoming))) this.release(g);
    this.trimIdle();
    const whole = Math.floor(frame);
    const place = (item: Item, shownAs: ShownGraphic | undefined) => {
      const g = this.frameFor(item, project);
      if (!g) return;
      g.wrap.style.opacity = shownAs ? String(shownAs.opacity) : "0";
      g.wrap.style.zIndex = shownAs ? String(shownAs.z) : "0";
      g.wrap.style.visibility = shownAs ? "" : "hidden";
      if (shownAs) transitionCanvas(g.wrap, shownAs, project.canvas);
      if (!g.loaded) return;
      const local = graphicLocal(item, whole - starts.get(item.id)!);
      const info = graphicInfo(item, project.canvas, local);
      // Anything render(t, info) is given: a new length or canvas draws again too. And whether it
      // plays: a graphic's footage (uncut.frame) is its nearest decoded frame while playing, the
      // exact one when stopped, so the frame playback stops on is drawn again exactly.
      const sent = JSON.stringify([local, info, running]);
      if (g.sent === sent) return;
      g.sent = sent;
      const seq = ++this.seq;
      g.asked.set(seq, local / fps);
      g.frame.contentWindow?.postMessage({ uncut: "render", seq, t: local / fps, info, playing: running }, "*");
    };
    for (const v of shown) place(v.item, v);
    for (const it of upcoming) place(it, undefined);
  }

  private upcoming(project: ProjectModel, starts: ReadonlyMap<string, number>, frame: number, shown: ReadonlyArray<ShownGraphic>) {
    const out: Array<Item> = [];
    const ahead = LOAD_AHEAD_S * project.canvas.fps;
    for (const track of project.tracks) {
      if (track.hidden || track.kind !== "video") continue;
      for (const it of track.items) {
        const s = starts.get(it.id)!;
        if (it.type === "graphic" && typeof it.src === "string" && s > frame && s - frame <= ahead && !shown.some((g) => g.item.id === it.id)) out.push(it);
      }
    }
    return out;
  }

  private sameSrc(g: GraphicFrame, shown: ReadonlyArray<ShownGraphic>, upcoming: ReadonlyArray<Item>) {
    const item = shown.find((v) => v.item.id === g.item)?.item ?? upcoming.find((it) => it.id === g.item);
    return !!item?.src && graphicUrl(item.src) === g.src;
  }

  /** The item's iframe: the one it has, else an idle one of its file (the most recently used), else a new one once the server has the document. */
  private frameFor(item: Item, project: ProjectModel): GraphicFrame | undefined {
    const own = this.frames.find((g) => g.item === item.id);
    if (own) return own;
    const src = graphicUrl(item.src!);
    if (!src) return undefined;
    const idle = this.frames.filter((g) => g.item === undefined && g.src === src).sort((a, b) => b.idleSince - a.idleSince)[0];
    if (idle) {
      this.assign(idle, item);
      return idle;
    }
    if (!this.available(src)) return undefined;
    const g = this.make(src, project);
    this.assign(g, item);
    return g;
  }

  /**
   * Asked first: a 404 page in the iframe would draw "Not found" over the canvas, where the export
   * draws nothing. A missing file is asked for again 3 s later.
   */
  private available(src: string) {
    const known = this.check.get(src);
    if (known === "ok") return true;
    if (known === "pending" || (typeof known === "number" && Date.now() < known)) return false;
    this.check.set(src, "pending");
    void fetch(src)
      .then(
        (r) => r.ok,
        () => false,
      )
      .then((ok) => {
        this.check.set(src, ok ? "ok" : Date.now() + 3000);
        if (!ok) setTimeout(() => this.render(), 3100);
        this.render();
      });
    return false;
  }

  private make(src: string, project: ProjectModel): GraphicFrame {
    const wrap = document.createElement("div");
    wrap.className = "pv-graphic";
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("tabindex", "-1");
    frame.style.width = `${project.canvas.width}px`;
    frame.style.height = `${project.canvas.height}px`;
    const g: GraphicFrame = { wrap, frame, src, loaded: false, item: undefined, sent: "", asked: new Map(), renders: 0, idleSince: 0 };
    frame.addEventListener("load", () => {
      g.loaded = true;
      g.sent = "";
      this.render();
    });
    frame.src = src;
    wrap.append(frame);
    this.layer.append(wrap);
    this.frames.push(g);
    return g;
  }

  private assign(g: GraphicFrame, item: Item) {
    g.item = item.id;
    g.sent = "";
    g.asked.clear();
    g.wrap.dataset.item = item.id;
    g.frame.title = item.name ?? item.id;
    delete g.wrap.dataset.time;
    delete g.wrap.dataset.frames;
  }

  private release(g: GraphicFrame) {
    g.item = undefined;
    g.idleSince = performance.now();
    g.asked.clear();
    g.wrap.style.visibility = "hidden";
    g.wrap.style.zIndex = "0";
    delete g.wrap.dataset.item;
    delete g.wrap.dataset.time;
    delete g.wrap.dataset.frames;
  }

  private trimIdle() {
    const idle = this.frames.filter((g) => g.item === undefined).sort((a, b) => b.idleSince - a.idleSince);
    for (const g of idle.slice(IDLE_FRAMES)) {
      g.wrap.remove();
      this.frames.splice(this.frames.indexOf(g), 1);
    }
  }

  /** A graphic's iframe drew a render(t) asked of it: its wrapper says which time (s) it shows, for the preview tests. */
  private readonly onRendered = (e: MessageEvent) => {
    const d = e.data as { uncut?: unknown; seq?: unknown; skipped?: unknown; error?: unknown } | null;
    if (!d || d.uncut !== "rendered" || typeof d.seq !== "number") return;
    const g = this.frames.find((f) => f.frame.contentWindow === e.source);
    const t = g?.asked.get(d.seq);
    if (!g || t === undefined) return;
    g.asked.delete(d.seq);
    if (d.skipped || d.error) return;
    g.renders++;
    g.wrap.dataset.time = String(t);
    g.wrap.dataset.frames = String(g.renders);
  };
}
