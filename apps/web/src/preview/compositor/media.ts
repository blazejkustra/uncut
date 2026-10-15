import type { ClipBox } from "@uncut/core/box";
import type { Visual } from "@uncut/core/timeline";
import { irisRadius, maskClipPath } from "@uncut/core/transitions";
import { proxyOf, getState, proxyUrl, mediaUrl } from "../../state/store.ts";
import { proxiesOn } from "../../settings/proxies.ts";

/** Renderers kept for reuse when clips with effects leave the canvas (D136). */
export const FX_POOL = 4;
/** D221: how long the playhead rests before a <video> under a scrub canvas is seeked to it. */
export const SCRUB_SETTLE_MS = 200;

/** D221: how long the last renders took (ms), for the compositor's measurements in tests. */
export const renderTimes: Array<number> = [];
(globalThis as { __uncutPreview?: unknown }).__uncutPreview = { renderMs: () => renderTimes.splice(0) };

/** D221: a clip's scrub canvas (its cached frame over the hidden <video>). */
export interface ScrubView {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** The source and sample drawn ("" for none yet). */
  key: string;
  shown: boolean;
  lastT: number;
  movedAt: number;
}

export type MediaEl = HTMLVideoElement | HTMLImageElement;
/** What a clip's picture is drawn from: its media element, or (D221) its scrub canvas. */
export type PictureEl = MediaEl | HTMLCanvasElement;
/** Whether a picture has something to read. */
export const pictureReady = (el: PictureEl) => (el instanceof HTMLVideoElement ? el.readyState >= 2 : el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el.width > 0);
// Where a video was last asked to be; while a seek runs only the newest target is kept.
/**
 * D212: what a clip's element plays: the media item's proxy when the server has made one and
 * "Use proxies for preview" is on, else the original. The URL carries a tag of the file's path (or
 * the proxy's key), so a relinked file gets a new element, never a <video> that has buffered the old file.
 */
export function previewSrc(media: { readonly id: string; readonly path: string }, kind: "video" | "image") {
  const proxy = kind === "video" && proxiesOn() ? proxyOf(getState(), media.id) : undefined;
  return proxy?.phase === "done" && proxy.key ? proxyUrl(media.id, proxy.key) : mediaUrl(media.id, media.path);
}

export const wanted = new WeakMap<HTMLVideoElement, number>();

/**
 * A time the video can actually reach. A clip whose range runs past the file's end (a probe that
 * overestimated, a relinked shorter file) would otherwise make the browser clamp every seek and
 * the "seeked" handler chase the unreachable target forever.
 */
export const reachable = (el: HTMLVideoElement, t: number) => (Number.isFinite(el.duration) && el.duration > 0 ? Math.min(Math.max(0, t), Math.max(0, el.duration - 0.001)) : Math.max(0, t));

/** Seek without piling up seeks (from the spike): the "seeked" handler chases the latest target. */
export function seek(el: HTMLVideoElement, t: number) {
  const target = reachable(el, t);
  wanted.set(el, target);
  if (!el.seeking && Math.abs(el.currentTime - target) > 0.004) el.currentTime = target;
}

/**
 * Keep a <video> at `source` seconds: playing at the clip's speed (pitch kept), seeked only when
 * it drifts; paused, seeked to the frame.
 */
export function drive(el: HTMLVideoElement, source: number, playing: boolean, speed: number, keepPitch = true) {
  if (el.playbackRate !== speed || el.preservesPitch !== keepPitch) {
    el.playbackRate = speed;
    el.preservesPitch = keepPitch;
  }
  const target = source + 0.0001;
  if (playing) {
    if (el.paused) {
      seek(el, target);
      el.play().catch(() => {});
    } else if (Math.abs(el.currentTime - target) > 0.12 * Math.max(1, speed)) seek(el, target);
  } else {
    if (!el.paused) el.pause();
    seek(el, target);
  }
}

export const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;
type Canvas = { readonly width: number; readonly height: number };

/** An iris transition (D79): the circle core's `iris` shows, centred on the canvas, in an element's own px (its top-left at `left`, `top` on the canvas). */
export const irisClip = (iris: number, canvas: Canvas, left = 0, top = 0) => `circle(${px(irisRadius(iris, canvas))} at ${px(canvas.width / 2 - left)} ${px(canvas.height / 2 - top)})`;

/**
 * A full-canvas element (a background, a graphic) through a transition: a wipe shows the left share
 * of it (core's `wipe`), an iris the circle at the centre (D79), and a push or zoom moves it as the
 * canvas (D79: shift right, zoom about the canvas's centre, its own transform-origin).
 */
export function transitionCanvas(el: HTMLElement, v: Pick<Visual, "wipe" | "iris" | "mask" | "shift" | "shiftY" | "zoom" | "blur">, canvas: Canvas) {
  const clip = v.wipe !== undefined ? `inset(0 ${((1 - v.wipe) * 100).toFixed(4)}% 0 0)` : v.iris !== undefined ? irisClip(v.iris, canvas) : v.mask ? maskClipPath(v.mask.shape, v.mask.p, canvas) : "";
  if (el.style.clipPath !== clip) el.style.clipPath = clip;
  setBlur(el, v.blur);
  const translate = v.shift || v.shiftY ? `${px(v.shift ?? 0)} ${px(v.shiftY ?? 0)}` : "";
  const scale = v.zoom !== undefined ? String(v.zoom) : "";
  if (el.style.translate !== translate) el.style.translate = translate;
  if (el.style.scale !== scale) el.style.scale = scale;
}
/** A blur dissolve (D133): CSS blur at core's sigma (canvas px), as the export's gblur. */
export const setBlur = (el: HTMLElement, blur: number | undefined) => {
  const filter = blur ? `blur(${px(blur)})` : "";
  if (el.style.filter !== filter) el.style.filter = filter;
};
export const setStyle = (el: HTMLElement, key: "left" | "top" | "width" | "height" | "borderRadius" | "objectFit", value: string) => {
  if (el.style[key] !== value) el.style[key] = value;
};

/**
 * A clip's box (D75): the wrapper at core's box in canvas pixels (it clips the picture and rounds
 * its corners), the picture inside at core's content rect (fit and zoom; a push or zoom transition
 * is already in the box, D79), and a wipe revealing the canvas from the left (the share of the
 * canvas width shown, in the wrapper's own pixels) or an iris the circle at the canvas's centre.
 */
export function placeBox(wrap: HTMLElement, el: HTMLElement, box: ClipBox, canvas: Canvas, shown: number | undefined, iris: number | undefined, mask?: Visual["mask"], blur?: number) {
  setStyle(wrap, "left", px(box.x));
  setStyle(wrap, "top", px(box.y));
  setStyle(wrap, "width", px(box.w));
  setStyle(wrap, "height", px(box.h));
  setStyle(wrap, "borderRadius", box.radius > 0 ? px(box.radius) : "");
  setStyle(el, "left", px(box.content.x - box.x));
  setStyle(el, "top", px(box.content.y - box.y));
  setStyle(el, "width", px(box.content.w));
  setStyle(el, "height", px(box.content.h));
  setStyle(el, "objectFit", box.fit);
  const hidden = shown === undefined ? 0 : Math.min(box.w, Math.max(0, box.x + box.w - canvas.width * shown));
  const clip = hidden > 0 ? `inset(0 ${px(hidden)} 0 0)` : iris !== undefined ? irisClip(iris, canvas, box.x, box.y) : mask ? maskClipPath(mask.shape, mask.p, canvas, (x, y) => [x - box.x, y - box.y]) : "";
  if (wrap.style.clipPath !== clip) wrap.style.clipPath = clip;
  setBlur(wrap, blur);
}
