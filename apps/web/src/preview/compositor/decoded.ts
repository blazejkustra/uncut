// D311: the compositor's side of the playback engine (play/engine.ts): which clips it draws, the
// lanes each render asks for, and each clip's play canvas (canvas[data-play] over its hidden
// <video>), which holds the decoded frame the playback clock asks for.
import type { Visual } from "@uncut/core/timeline";
import { overlaps } from "@uncut/core/transitions";
import type { Item, ProjectModel } from "../../state/project.ts";
import { playEngineOn } from "../../settings/playEngine.ts";
import { LOOKAHEAD_S, PlayEngine } from "../play/engine.ts";
import { SCRUB_MAX_SIDE } from "../scrub/frames.ts";
import { previewSrc, reachable } from "./media.ts";

type Media = ProjectModel["media"][number];

/** Paused, how long the playhead rests before its frames are decoded for playback (scrubbing has the scrub cache's decoders first). */
const PRIME_REST_MS = 1000;

interface PlayView {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** The lane and frame it holds (lane 0: none yet). */
  lane: number;
  ts: number;
  frames: number;
}

/** Counters the preview tests read (`__uncutPlay.stats()`): frames drawn, held (none on time) and fallen back to the <video>. */
export const playStats = { drawn: 0, held: 0, fallback: 0 };

/** Whether a <video> already shows the frame at t (paused there). */
export const videoAt = (el: HTMLVideoElement, t: number) => !el.seeking && el.readyState >= 2 && Math.abs(el.currentTime - reachable(el, t)) < 0.002;

const speedOf = (item: Item) => item.speed ?? 1;

export class DecodedPictures {
  readonly engine: PlayEngine;
  private readonly views = new Map<string, PlayView>();
  private readonly shown = new Set<string>();
  // The clips the last plan gave a lane: on screen, their picture comes from it while playing.
  private laned = new Set<string>();
  private lastFrame = Number.NaN;
  private movedAt = 0;
  private primeTimer = 0;
  private readonly render: () => void;

  constructor(render: () => void) {
    this.render = render;
    this.engine = new PlayEngine(render);
    (globalThis as { __uncutPlay?: unknown }).__uncutPlay = { stats: () => ({ ...playStats, ...this.engine.stats() }) };
  }

  /** The file the engine draws a clip from, when it does: a video it decodes, played forward at up to 4×, not looped. */
  urlFor(item: Item, media: Media | undefined): string | undefined {
    if (!playEngineOn() || !media || media.kind !== "video" || item.loop) return undefined;
    if (!(speedOf(item) > 0 && speedOf(item) <= 4)) return undefined;
    const url = previewSrc(media, "video");
    return url && this.engine.source(url).state === "ready" ? url : undefined;
  }

  /** Opens the sources of the project's videos ahead of their first use (and closes the rest). */
  prepare(project: ProjectModel) {
    if (!playEngineOn()) return this.engine.keepSources(new Set());
    const urls = new Set<string>();
    for (const m of project.media) {
      const url = m.kind === "video" ? previewSrc(m, "video") : undefined;
      if (url) urls.add(url);
    }
    this.engine.keepSources(urls);
    for (const url of urls) this.engine.source(url);
  }

  /**
   * This render's lanes: the clips on screen from their frame, then the clips starting within
   * LOOKAHEAD_S. Paused, only once the playhead has rested PRIME_REST_MS; shuttling, none.
   */
  plan(
    project: ProjectModel,
    starts: ReadonlyMap<string, number>,
    frame: number,
    clips: ReadonlyArray<Visual>,
    { running, playing, scale }: { running: boolean; playing: boolean; scale: number },
  ) {
    const now = performance.now();
    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      this.movedAt = now;
    }
    if (!playing && !running && now - this.movedAt < PRIME_REST_MS) return this.primeLater();
    this.engine.begin();
    this.laned = new Set();
    if (running && !playing) return this.engine.end();
    for (const c of clips) {
      const url = this.urlFor(c.item, mediaOf(project, c.item));
      const content = c.box?.content ?? { w: project.canvas.width, h: project.canvas.height };
      const side = sideOnScreen(Math.max(content.w, content.h), scale);
      if (url && this.engine.want({ key: c.item.id, url, from: Math.max(0, c.source), until: clipEnd(c.item, project), side, shown: true }))
        this.laned.add(c.item.id);
    }
    const side = sideOnScreen(Math.max(project.canvas.width, project.canvas.height), scale);
    for (const { item, url } of this.upcoming(project, starts, frame, clips)) {
      if (this.engine.want({ key: item.id, url, from: firstFrame(item, project), until: clipEnd(item, project), side, shown: false })) this.laned.add(item.id);
    }
    this.engine.end();
  }

  /** Whether the engine draws this clip now (it has a lane): its <video> stays paused while playing. */
  decodes(id: string) {
    return this.laned.has(id);
  }

  /**
   * Whether a clip's sound comes from the mix's own <audio> instead of its <video>: any clip the
   * engine can draw, lane or not, so the sound never hands over between elements at a play or a cut.
   */
  soundApart(item: Item, project: ProjectModel | undefined) {
    return item.type === "clip" && !!this.urlFor(item, mediaOf(project, item));
  }

  /** While playing: the clip's frame at t in its play canvas; on a miss its last frame, if it has one. */
  playing(id: string, el: HTMLVideoElement, t: number): HTMLCanvasElement | undefined {
    const view = this.view(id, el);
    const hit = this.engine.frame(id, t);
    if (hit && (hit.lane !== view.lane || hit.ts !== view.ts)) {
      const c = view.canvas;
      if (c.width !== hit.bitmap.width) c.width = hit.bitmap.width;
      if (c.height !== hit.bitmap.height) c.height = hit.bitmap.height;
      view.ctx.drawImage(hit.bitmap, 0, 0);
      view.lane = hit.lane;
      view.ts = hit.ts;
      view.frames++;
      c.dataset.time = String(hit.ts);
      c.dataset.frames = String(view.frames);
      playStats.drawn++;
    } else if (!hit) {
      if (!view.lane) {
        playStats.fallback++;
        return undefined;
      }
      playStats.held++;
    }
    return this.show(id, view);
  }

  /** Paused or shuttling: the clip's last decoded frame until its <video> (or the scrub canvas, `other`) shows the frame at t. */
  resting(id: string, el: HTMLVideoElement, t: number, other: HTMLElement): HTMLCanvasElement | undefined {
    const view = this.views.get(id);
    if (!view?.lane || other !== el || videoAt(el, t)) return undefined;
    return this.show(id, view);
  }

  /** After a render: play canvases it didn't show are hidden. */
  finish() {
    for (const [id, view] of this.views) {
      if (this.shown.has(id) || view.canvas.dataset.shown !== "true") continue;
      view.canvas.dataset.shown = "false";
      view.canvas.style.visibility = "hidden";
    }
    this.shown.clear();
  }

  drop(id: string) {
    this.views.get(id)?.canvas.remove();
    this.views.delete(id);
  }

  dispose() {
    clearTimeout(this.primeTimer);
    for (const id of [...this.views.keys()]) this.drop(id);
    this.engine.dispose();
  }

  private show(id: string, view: PlayView) {
    this.shown.add(id);
    if (view.canvas.dataset.shown !== "true") view.canvas.dataset.shown = "true";
    if (view.canvas.style.visibility) view.canvas.style.visibility = "";
    return view.canvas;
  }

  private view(id: string, el: HTMLVideoElement): PlayView {
    let view = this.views.get(id);
    if (view && view.canvas.parentElement === el.parentElement) return view;
    view?.canvas.remove();
    const canvas = document.createElement("canvas");
    canvas.className = "pv-play";
    canvas.dataset.play = id;
    canvas.dataset.shown = "false";
    canvas.style.visibility = "hidden";
    el.after(canvas);
    view = { canvas, ctx: canvas.getContext("2d")!, lane: 0, ts: 0, frames: 0 };
    this.views.set(id, view);
    return view;
  }

  private primeLater() {
    clearTimeout(this.primeTimer);
    this.primeTimer = window.setTimeout(() => this.render(), PRIME_REST_MS + 10);
  }

  /** The clips starting within LOOKAHEAD_S on the visible video tracks that the engine draws, the nearest first. */
  private upcoming(project: ProjectModel, starts: ReadonlyMap<string, number>, frame: number, clips: ReadonlyArray<Visual>) {
    const until = frame + LOOKAHEAD_S * project.canvas.fps;
    const onScreen = new Set(clips.map((c) => c.item.id));
    const out: Array<{ item: Item; url: string; start: number }> = [];
    for (const track of project.tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      for (const item of track.items) {
        if (item.type !== "clip" || onScreen.has(item.id)) continue;
        const start = starts.get(item.id)! - (track.role === "main" ? preroll(item) : 0);
        if (start <= frame || start > until) continue;
        const url = this.urlFor(item, mediaOf(project, item));
        if (url) out.push({ item, url, start });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }
}

const mediaOf = (project: ProjectModel | undefined, item: Item) => project?.media.find((m) => m.id === item.media);

/** Device px of a length in canvas px on screen, within the scrub cache's frame size. */
const sideOnScreen = (canvasPx: number, scale: number) => Math.max(64, Math.min(SCRUB_MAX_SIDE, Math.ceil(canvasPx * scale)));

/** How early a main clip shows: half an overlapping transition into it. */
const preroll = (item: Item) => (item.transitionIn && overlaps(item.transitionIn.module) ? item.transitionIn.duration / 2 : 0);

/** Seconds into its file of a clip's first frame on screen, and of its last. */
const firstFrame = (item: Item, project: ProjectModel) => Math.max(0, ((item.in ?? 0) - preroll(item) * speedOf(item)) / project.canvas.fps);
const clipEnd = (item: Item, project: ProjectModel) => ((item.in ?? 0) + item.duration * speedOf(item)) / project.canvas.fps;
