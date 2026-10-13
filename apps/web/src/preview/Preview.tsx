// The preview and the transport under it. The preview draws the project at the playhead at the
// canvas's aspect ratio: media through <video> (D37; <img> for stills), seeked to the source time
// of the frame (D38), each in its box (D75: a wrapper at core's box that clips, rounds and fades
// it, the picture inside at core's content rect), backgrounds (component.solid) between them in
// track order, text from @uncut/core's textHtml on top (D39), the canvas colour where nothing is.
// Components are core's componentHtml at the frame (D76: the same HTML the export rasterises);
// graphic items are their documents in sandboxed iframes, render(t) called by postMessage (D78).
// The text can be selected, dragged and edited in place (D53); a selected clip or component can be
// dragged and resized by its corners (D75); a component dropped from Elements lands where it's dropped.
import { heldPast } from "@uncut/core/audio";
import type { ClipBox } from "@uncut/core/box";
import { visualsAt, type Visual } from "@uncut/core/timeline";
import { componentHtml, isDrawnComponent } from "@uncut/core/components";
import { graphicInfo } from "@uncut/core/graphics";
import { irisRadius, overlaps } from "@uncut/core/transitions";
import { canvasBackground, RENDER_CSS, SOLID, solidBackground, textHtml } from "@uncut/core/render";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Mix, PREROLL_S, setCurrentMix } from "../audio/audio.ts";
import { draftOf, findItem, lockOf } from "../timeline/edit.ts";
import { getPlayback, playback, usePlayback, type PreviewDraft } from "./playback.ts";
import { layoutOf, type Item, type ProjectModel } from "../state/project.ts";
import { actions, getState, graphicUrl, mediaUrl, textPresets } from "../state/store.ts";
import { COMPONENT_DRAG_TYPE, draggedComponent, TEXT_DRAG_TYPE } from "./components.ts";
import { planText, planTransform, snapBox, textBox, type Guide } from "./text.ts";
import { clipState, planClipBox, resizeBox, type Corner } from "../timeline/clip.ts";
import { Transport } from "./Transport.tsx";
import { useViewport } from "./viewport.ts";

/** Fits a w×h box inside its container, like object-fit: contain. */
function useFit(width: number, height: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const style = getComputedStyle(el);
      const aw = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const ah = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const scale = Math.max(0, Math.min(aw / width, ah / height));
      setSize({ w: Math.floor(width * scale), h: Math.floor(height * scale) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);
  return { ref, size };
}

type MediaEl = HTMLVideoElement | HTMLImageElement;
// Where a video was last asked to be; while a seek runs only the newest target is kept.
const wanted = new WeakMap<HTMLVideoElement, number>();

/**
 * A time the video can actually reach. A clip whose range runs past the file's end (a probe that
 * overestimated, a relinked shorter file) would otherwise make the browser clamp every seek and
 * the "seeked" handler chase the unreachable target forever.
 */
const reachable = (el: HTMLVideoElement, t: number) => (Number.isFinite(el.duration) && el.duration > 0 ? Math.min(Math.max(0, t), Math.max(0, el.duration - 0.001)) : Math.max(0, t));

/** Seek without piling up seeks (from the spike): the "seeked" handler chases the latest target. */
function seek(el: HTMLVideoElement, t: number) {
  const target = reachable(el, t);
  wanted.set(el, target);
  if (!el.seeking && Math.abs(el.currentTime - target) > 0.004) el.currentTime = target;
}

/**
 * Keep a <video> at `source` seconds: playing at the clip's speed (pitch kept), seeked only when
 * it drifts; paused, seeked to the frame.
 */
function drive(el: HTMLVideoElement, source: number, playing: boolean, speed: number) {
  if (el.playbackRate !== speed) {
    el.playbackRate = speed;
    el.preservesPitch = true;
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

const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;
type Canvas = { readonly width: number; readonly height: number };

/** An iris transition (D79): the circle core's `iris` shows, centred on the canvas, in an element's own px (its top-left at `left`, `top` on the canvas). */
const irisClip = (iris: number, canvas: Canvas, left = 0, top = 0) => `circle(${px(irisRadius(iris, canvas))} at ${px(canvas.width / 2 - left)} ${px(canvas.height / 2 - top)})`;

/**
 * A full-canvas element (a background, a graphic) through a transition: a wipe shows the left share
 * of it (core's `wipe`), an iris the circle at the centre (D79), and a push or zoom moves it as the
 * canvas (D79: shift right, zoom about the canvas's centre, its own transform-origin).
 */
function transitionCanvas(el: HTMLElement, v: Pick<Visual, "wipe" | "iris" | "shift" | "zoom">, canvas: Canvas) {
  const clip = v.wipe !== undefined ? `inset(0 ${((1 - v.wipe) * 100).toFixed(4)}% 0 0)` : v.iris !== undefined ? irisClip(v.iris, canvas) : "";
  if (el.style.clipPath !== clip) el.style.clipPath = clip;
  const translate = v.shift ? `${px(v.shift)} 0px` : "";
  const scale = v.zoom !== undefined ? String(v.zoom) : "";
  if (el.style.translate !== translate) el.style.translate = translate;
  if (el.style.scale !== scale) el.style.scale = scale;
}
const setStyle = (el: HTMLElement, key: "left" | "top" | "width" | "height" | "borderRadius" | "objectFit", value: string) => {
  if (el.style[key] !== value) el.style[key] = value;
};

/**
 * A clip's box (D75): the wrapper at core's box in canvas pixels (it clips the picture and rounds
 * its corners), the picture inside at core's content rect (fit and zoom; a push or zoom transition
 * is already in the box, D79), and a wipe revealing the canvas from the left (the share of the
 * canvas width shown, in the wrapper's own pixels) or an iris the circle at the canvas's centre.
 */
function placeBox(wrap: HTMLElement, el: HTMLElement, box: ClipBox, canvas: Canvas, shown: number | undefined, iris: number | undefined) {
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
  const clip = hidden > 0 ? `inset(0 ${px(hidden)} 0 0)` : iris !== undefined ? irisClip(iris, canvas, box.x, box.y) : "";
  if (wrap.style.clipPath !== clip) wrap.style.clipPath = clip;
}

/**
 * Draws the project into the preview frame, imperatively: it runs on every playhead change
 * (60 times a second while playing) without going through React.
 */
class Compositor {
  private project: ProjectModel | undefined;
  private readonly els = new Map<string, MediaEl>();
  // Each media element sits in a box wrapper (D75), keyed like `els`.
  private readonly boxes = new Map<string, HTMLDivElement>();
  private readonly solids = new Map<string, HTMLDivElement>();
  // Components (D76): each one's element and the HTML (plus wipe) it was made from.
  private readonly comps = new Map<string, { el: HTMLElement; key: string }>();
  // Graphics (D78): a wrapper and its sandboxed iframe per item; `sent` is the last render asked for.
  private readonly graphics = new Map<string, { wrap: HTMLDivElement; frame: HTMLIFrameElement; src: string; loaded: boolean; sent: string }>();
  // Whether the server has each graphic's document: "ok", being asked, or when to ask again (D78).
  private readonly graphicCheck = new Map<string, "ok" | "pending" | number>();
  private graphicSeq = 0;
  private textKey = "";
  // The text being edited in place: hidden while the editor sits over it.
  private editing: string | undefined;
  private readonly unsubscribe: () => void;
  private readonly frameEl: HTMLDivElement;
  private readonly mediaLayer: HTMLDivElement;
  private readonly textLayer: HTMLDivElement;
  // The project folder this preview draws. Another folder open means this preview is on its way
  // out: it draws nothing more (its media ids could name the new project's files).
  private readonly dir: string;
  // The playback mix (D54): clips' sound comes from the <video> elements made here.
  private readonly mix = new Mix();

  constructor(dir: string, frameEl: HTMLDivElement, mediaLayer: HTMLDivElement, textLayer: HTMLDivElement) {
    this.dir = dir;
    this.frameEl = frameEl;
    this.mediaLayer = mediaLayer;
    this.textLayer = textLayer;
    this.unsubscribe = playback.subscribe(() => this.render());
    playback.setFollower((f) => this.follow(f));
    setCurrentMix(this.mix);
  }

  destroy() {
    this.unsubscribe();
    playback.setFollower(undefined);
    for (const id of [...this.els.keys()]) this.drop(id);
    for (const el of this.solids.values()) el.remove();
    this.solids.clear();
    this.clearOverlays();
    this.mix.destroy();
    setCurrentMix(undefined);
  }

  /** Components and graphics off the canvas. */
  private clearOverlays() {
    for (const c of this.comps.values()) c.el.remove();
    this.comps.clear();
    for (const g of this.graphics.values()) g.wrap.remove();
    this.graphics.clear();
  }

  setEditing(id: string | undefined) {
    this.editing = id;
    this.render();
  }

  /** The project on screen: the open one, or a local draft of an edit in progress on top of it. */
  shown(): ProjectModel | undefined {
    const draft = getPlayback().draft;
    return draft && draft.base === this.project ? draft.project : this.project;
  }

  setProject(project: ProjectModel) {
    this.project = project;
    this.render();
  }

  private drop(id: string) {
    const el = this.els.get(id);
    if (!el) return;
    if (el instanceof HTMLVideoElement) {
      this.mix.detach(id, el);
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    el.remove();
    this.boxes.get(id)?.remove();
    this.boxes.delete(id);
    this.els.delete(id);
  }

  /** The wrapper of a clip's media element (its box). */
  boxOf(id: string) {
    return this.boxes.get(id);
  }

  /** The element for a clip, made on first use; replaced if the clip now shows other media. */
  private elementFor(item: Item, kind: "video" | "image"): MediaEl | undefined {
    const media = item.media ? this.project?.media.find((m) => m.id === item.media) : undefined;
    // The URL carries a tag of the file's path, so a relinked file gets a new element, never a
    // <video> that has buffered the old file.
    const src = media ? mediaUrl(media.id, media.path) : undefined;
    if (!src || !media) return undefined;
    let el = this.els.get(item.id);
    if (el && el.dataset.src === src) return el;
    if (el) this.drop(item.id);
    if (kind === "image") {
      el = document.createElement("img");
      el.alt = "";
    } else {
      const video = document.createElement("video");
      // Muted until the mix routes its sound (a clip with sound); CORS mode so Web Audio may hear it.
      video.muted = true;
      video.crossOrigin = "anonymous";
      video.playsInline = true;
      video.preload = "auto";
      video.addEventListener("seeked", () => {
        // The target was set before the length was known: clamp it now, then chase it once more.
        const want = wanted.has(video) ? reachable(video, wanted.get(video)!) : undefined;
        if (want !== undefined && Math.abs(video.currentTime - want) > 0.004) {
          wanted.set(video, want);
          video.currentTime = want;
        } else wanted.delete(video);
      });
      el = video;
    }
    el.dataset.item = item.id;
    el.dataset.src = src;
    // Something Chromium can't decode (HEIC stills, odd codecs) or a file that went missing: say
    // so on the canvas instead of showing black.
    const shown = el;
    const wrap = document.createElement("div");
    wrap.className = "pv-box";
    wrap.dataset.item = item.id;
    shown.addEventListener("error", () => {
      if (this.els.get(item.id) !== shown || wrap.querySelector("[data-missing]")) return;
      shown.style.visibility = "hidden";
      const note = document.createElement("div");
      note.className = "pv-missing";
      note.dataset.missing = item.id;
      note.textContent = `Can't show ${media.name}`;
      wrap.append(note);
    });
    el.src = src;
    if (el instanceof HTMLVideoElement && media.probe?.hasAudio) this.mix.attach(item.id, el);
    this.els.set(item.id, el);
    this.boxes.set(item.id, wrap);
    wrap.append(el);
    this.mediaLayer.append(wrap);
    return el;
  }

  render() {
    const project = this.shown();
    if (!project) return;
    if (getState().snapshot?.dir !== this.dir) {
      for (const id of [...this.els.keys()]) this.drop(id);
      this.clearOverlays();
      this.mix.stop();
      return;
    }
    const background = canvasBackground(project);
    if (this.frameEl.style.background !== background) this.frameEl.style.background = background;
    const { frame, playing: running, rate, selected } = getPlayback();
    // Shuttling (J/L at another speed, G3): the videos are seeked per frame, like scrubbing, and silent.
    const playing = running && rate === 1;
    const fps = project.canvas.fps;
    const { starts } = layoutOf(project);
    const visible = visualsAt(project, starts, frame);
    const mediaKind = (item: Item) => project.media.find((m) => m.id === item.media);
    const clips = visible.filter((v) => v.item.type === "clip" && mediaKind(v.item) && mediaKind(v.item)!.kind !== "audio");
    // Warm up the next main clip two seconds ahead so the cut doesn't wait for a decoder.
    const main = project.tracks.find((t) => t.role === "main");
    // How early a main clip starts: half an overlapping transition into it (a dip doesn't overlap).
    const preroll = (it: Item) => (it.transitionIn && overlaps(it.transitionIn.module) ? it.transitionIn.duration / 2 : 0);
    const ahead = main?.items.find((it) => {
      const start = starts.get(it.id)! - preroll(it);
      return start > frame && start - frame < 2 * fps && mediaKind(it)?.kind === "video";
    });
    const keep = new Set([...clips.map((c) => c.item.id), ...(ahead ? [ahead.id] : [])]);
    for (const [id, el] of [...this.els]) {
      if (keep.has(id)) continue;
      // No longer shown (it ended, its track was hidden): the mix may hold the <video> a moment,
      // out of sight, while its sound ramps down or hands over to an <audio>, so nothing clicks.
      if (el instanceof HTMLVideoElement) {
        this.mix.unshow(id, el);
        if (this.mix.holds(el)) {
          el.style.opacity = "0";
          continue;
        }
      }
      this.drop(id);
    }

    // Everything is stacked in track order (visualsAt's, the order export composites in, D39):
    // media and backgrounds in the media layer, text in the text layer, interleaved by z-index
    // (the layers don't form stacking contexts of their own), so a background on a track above a
    // text track covers it here exactly as it will in the export.
    const drawn = visible.filter(
      (v) =>
        (v.item.type === "clip" && mediaKind(v.item) && mediaKind(v.item)!.kind !== "audio") ||
        (v.item.type === "component" && v.item.component === SOLID) ||
        isDrawnComponent(v.item) ||
        (v.item.type === "graphic" && typeof v.item.src === "string") ||
        (v.item.type === "text" && typeof v.item.text === "string"),
    );
    const z = new Map(drawn.map((v, i) => [v.item.id, i + 1]));
    const layered = drawn.filter((v) => v.item.type !== "text");
    const solids = layered.filter((v) => v.item.type === "component" && v.item.component === SOLID);
    for (const [id, el] of [...this.solids]) {
      if (solids.some((v) => v.item.id === id)) continue;
      el.remove();
      this.solids.delete(id);
    }
    for (const v of solids) {
      let el = this.solids.get(v.item.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "pv-solid";
        // A dip to black's black layer isn't an item: clicking it selects nothing.
        if (v.item.id.startsWith("dip:")) el.dataset.dip = v.item.id;
        else el.dataset.item = v.item.id;
        this.solids.set(v.item.id, el);
        this.mediaLayer.append(el);
      }
      const bg = solidBackground(v.item, project);
      if (el.dataset.bg !== bg) {
        el.dataset.bg = bg;
        el.style.background = bg;
      }
      el.style.opacity = String(v.opacity);
      el.style.zIndex = String(z.get(v.item.id));
      transitionCanvas(el, v, project.canvas);
    }

    // Components (D76): core's HTML at this frame, remade only when it changes (a terminal typing,
    // a fade); media references go through the server's /media/file route.
    const target = {
      ...project,
      mediaUrl: (id: string) => {
        const m = project.media.find((x) => x.id === id);
        return m && m.kind === "image" ? mediaUrl(m.id, m.path) : undefined;
      },
    };
    const comps = drawn.filter((v) => isDrawnComponent(v.item));
    for (const [id, c] of [...this.comps]) {
      if (comps.some((v) => v.item.id === id)) continue;
      c.el.remove();
      this.comps.delete(id);
    }
    const whole = Math.floor(frame);
    for (const v of comps) {
      // A push or zoom transition is in its box (D79), drawn into the HTML.
      // Only a moved one gets visualsAt's box (taken at the fractional playhead): otherwise its own at the
      // whole frame, so a keyed component isn't rebuilt on every animation frame while playing.
      const html = componentHtml(v.item, target, whole - starts.get(v.item.id)!, { opacity: v.opacity, motion: v.motion, fps, ...(v.box && (v.shift !== undefined || v.zoom !== undefined) ? { box: v.box } : {}) });
      const key = `${html}|${v.wipe ?? ""}|${v.iris ?? ""}`;
      let c = this.comps.get(v.item.id);
      if (!c || c.key !== key) {
        const holder = document.createElement("div");
        holder.innerHTML = html;
        const el = holder.firstElementChild as HTMLElement | null;
        if (!el) continue;
        // A wipe reveals the canvas from the left (as the export crops it): its edge in the element's
        // own pixels, through the scale about the box's centre and the move's offset; combined with
        // the element's own reveal (an in/out wipe) as the larger of the two.
        if (v.wipe !== undefined && v.box) {
          const b = v.box;
          const centre = b.x + b.w / 2 + (v.motion.dx ?? 0);
          const edge = b.w / 2 + (project.canvas.width * v.wipe - centre) / b.scale;
          const reveal = v.motion.reveal;
          const right = Math.min(b.w, Math.max(0, b.w - edge, reveal !== undefined && reveal < 1 ? (1 - reveal) * b.w : 0));
          el.style.clipPath = reveal !== undefined && reveal < 1 ? `inset(${px(-0.2 * b.h)} ${px(right)} ${px(-0.2 * b.h)} ${px(-0.05 * b.w)})` : `inset(0 ${px(right)} 0 0)`;
        } else if (v.iris !== undefined && v.box) {
          // An iris (D79): the canvas's circle in the element's own pixels, through its scale about the box's centre and the move's offset.
          const b = v.box;
          const ox = b.x + b.w / 2 + (v.motion.dx ?? 0);
          const oy = b.y + b.h / 2 + (v.motion.dy ?? 0);
          const r = irisRadius(v.iris, project.canvas) / b.scale;
          el.style.clipPath = `circle(${px(r)} at ${px(b.w / 2 + (project.canvas.width / 2 - ox) / b.scale)} ${px(b.h / 2 + (project.canvas.height / 2 - oy) / b.scale)})`;
        }
        if (c) c.el.replaceWith(el);
        else this.mediaLayer.append(el);
        c = { el, key };
        this.comps.set(v.item.id, c);
      }
      const zi = String(z.get(v.item.id));
      if (c.el.style.zIndex !== zi) c.el.style.zIndex = zi;
      c.el.classList.toggle("sel-clip", v.item.id === selected);
    }
    // Graphics (D78): the server's document in a sandboxed iframe; render(t) by postMessage. One
    // starting within two seconds is loaded ahead, out of sight at its first frame, so it doesn't
    // start blank (like the next clip's warm-up).
    type Shown = { item: Item; opacity: number; wipe?: number; iris?: number; shift?: number; zoom?: number; visible: boolean };
    const graphics: Array<Shown> = drawn
      .filter((v) => v.item.type === "graphic" && typeof v.item.src === "string")
      .map((v) => ({ item: v.item, opacity: v.opacity, ...(v.wipe !== undefined ? { wipe: v.wipe } : {}), ...(v.iris !== undefined ? { iris: v.iris } : {}), ...(v.shift !== undefined ? { shift: v.shift } : {}), ...(v.zoom !== undefined ? { zoom: v.zoom } : {}), visible: true }));
    for (const track of project.tracks) {
      if (track.hidden || track.kind !== "video") continue;
      for (const it of track.items) {
        const s = starts.get(it.id)!;
        if (it.type === "graphic" && typeof it.src === "string" && s > frame && s - frame <= 2 * fps && !graphics.some((g) => g.item.id === it.id)) graphics.push({ item: it, opacity: 0, visible: false });
      }
    }
    for (const [id, g] of [...this.graphics]) {
      if (graphics.some((v) => v.item.id === id && graphicUrl(v.item.src!) === g.src)) continue;
      g.wrap.remove();
      this.graphics.delete(id);
    }
    for (const v of graphics) {
      const src = graphicUrl(v.item.src!);
      if (!src) continue;
      let g = this.graphics.get(v.item.id);
      if (!g) {
        // Asked first: a 404 page in the iframe would draw "Not found" over the canvas, where the
        // export draws nothing. A missing file is asked for again 3 s later.
        const check = this.graphicCheck.get(src);
        if (check !== "ok") {
          if (check === "pending" || (typeof check === "number" && Date.now() < check)) continue;
          this.graphicCheck.set(src, "pending");
          void fetch(src)
            .then((r) => r.ok, () => false)
            .then((ok) => {
              this.graphicCheck.set(src, ok ? "ok" : Date.now() + 3000);
              if (!ok) setTimeout(() => this.render(), 3100);
              this.render();
            });
          continue;
        }
        const wrap = document.createElement("div");
        wrap.className = "pv-graphic";
        wrap.dataset.item = v.item.id;
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.setAttribute("tabindex", "-1");
        iframe.title = v.item.name ?? v.item.id;
        iframe.style.width = `${project.canvas.width}px`;
        iframe.style.height = `${project.canvas.height}px`;
        const entry = { wrap, frame: iframe, src, loaded: false, sent: "" };
        iframe.addEventListener("load", () => {
          entry.loaded = true;
          entry.sent = "";
          this.render();
        });
        iframe.src = src;
        wrap.append(iframe);
        this.mediaLayer.append(wrap);
        g = entry;
        this.graphics.set(v.item.id, g);
      }
      g.wrap.style.opacity = String(v.opacity);
      g.wrap.style.zIndex = v.visible ? String(z.get(v.item.id)) : "0";
      g.wrap.style.visibility = v.visible ? "" : "hidden";
      transitionCanvas(g.wrap, v, project.canvas);
      if (g.loaded) {
        const local = Math.max(0, Math.min(v.item.duration - 1, whole - starts.get(v.item.id)!));
        const info = graphicInfo(v.item, project.canvas, local);
        // Anything render(t, info) is given: a new length or canvas draws again too.
        const sent = JSON.stringify([local, info]);
        if (g.sent !== sent) {
          g.sent = sent;
          g.frame.contentWindow?.postMessage({ uncut: "render", seq: ++this.graphicSeq, t: local / fps, info }, "*");
        }
      }
    }

    clips.forEach((c) => {
      const media = mediaKind(c.item)!;
      const el = this.elementFor(c.item, media.kind === "image" ? "image" : "video");
      if (!el) return;
      const wrap = this.boxes.get(c.item.id)!;
      wrap.classList.toggle("sel-clip", c.item.id === selected);
      // The opacity stays on the media element (the wrapper only places, clips and rounds it).
      el.style.opacity = String(c.opacity);
      wrap.style.zIndex = String(z.get(c.item.id));
      if (c.box) placeBox(wrap, el, c.box, project.canvas, c.wipe, c.iris);
      if (!(el instanceof HTMLVideoElement)) return;
      // A looped clip's media starts over by itself; drive() reseeks only if it drifts (D75).
      el.loop = c.item.loop === true;
      if (media.probe?.hasAudio) this.mix.attach(c.item.id, el);
      // A held clip (D94) past its media's end sits paused on the last frame.
      drive(el, c.source, playing && !heldPast(project, c.item, frame - starts.get(c.item.id)!), c.item.speed ?? 1);
    });
    if (ahead && !clips.some((c) => c.item.id === ahead.id)) {
      const el = this.elementFor(ahead, "video");
      if (el instanceof HTMLVideoElement) {
        const wrap = this.boxes.get(ahead.id)!;
        el.style.opacity = "0";
        wrap.style.zIndex = "0";
        if (mediaKind(ahead)?.probe?.hasAudio) this.mix.attach(ahead.id, el);
        const from = starts.get(ahead.id)! - preroll(ahead);
        const speed = ahead.speed ?? 1;
        // Just before it starts (while playing) it already runs, out of sight and silent, so the
        // cut doesn't wait for the decoder to start (picture and sound).
        const early = (ahead.in ?? 0) + (frame - starts.get(ahead.id)!) * speed;
        if (playing && from - frame <= PREROLL_S * fps && early >= 0) drive(el, early / fps, true, speed);
        else {
          if (!el.paused) el.pause();
          seek(el, ((ahead.in ?? 0) - preroll(ahead) * speed) / fps + 0.0001);
        }
      }
    }

    // Text: rebuilt only when what it shows changes, not on every frame.
    const html = visible
      .filter((v) => v.item.type === "text" && typeof v.item.text === "string")
      .map(({ item, opacity, motion }) => textHtml(item, project, { opacity, motion, selected: item.id === selected }))
      .join("");
    const key = `${this.editing ?? ""}|${html}`;
    if (key !== this.textKey) {
      this.textKey = key;
      this.textLayer.innerHTML = html;
      if (this.editing) this.textLayer.querySelector<HTMLElement>(`[data-item="${CSS.escape(this.editing)}"]`)?.style.setProperty("visibility", "hidden");
    }
    const texts = new Map(visible.filter((v) => v.item.type === "text").map((v) => [v.item.id, v]));
    for (const child of this.textLayer.children) {
      const el = child as HTMLElement;
      const zi = String(z.get(el.dataset.item ?? "") ?? 0);
      if (el.style.zIndex !== zi) el.style.zIndex = zi;
      // A text on the main track through an iris, push or zoom (D79): as the canvas, like the
      // export's raster. Its own transform-origin is its centre, so a zoom about the canvas's
      // centre is that scale plus a shift; the iris's circle is in its own pixels.
      const v = texts.get(el.dataset.item ?? "");
      const zoom = v?.zoom ?? 1;
      const moved = !!v && (!!v.shift || zoom !== 1);
      // Layout is read only while one is moved (not on every frame of every text).
      const ox = moved ? el.offsetLeft + el.offsetWidth / 2 : 0;
      const oy = moved ? el.offsetTop + el.offsetHeight / 2 : 0;
      const translate = moved ? `${px((v!.shift ?? 0) + (1 - zoom) * (project.canvas.width / 2 - ox))} ${px((1 - zoom) * (project.canvas.height / 2 - oy))}` : "";
      if (el.style.translate !== translate) el.style.translate = translate;
      const scale = zoom !== 1 ? String(zoom) : "";
      if (el.style.scale !== scale) el.style.scale = scale;
      // The text's own clip-path (an in/out wipe move) is kept aside while an iris replaces it.
      if (v?.iris !== undefined) {
        if (el.dataset.clip === undefined) el.dataset.clip = el.style.clipPath;
        // Its own pixels: the layout box moved by the in/out move's translate (motion), as for components.
        el.style.clipPath = irisClip(v.iris, project.canvas, el.offsetLeft + (v.motion.dx ?? 0), el.offsetTop + (v.motion.dy ?? 0));
      } else if (el.dataset.clip !== undefined) {
        el.style.clipPath = el.dataset.clip;
        delete el.dataset.clip;
      }
    }
    // Sound after picture: the mix uses the <video> elements made above.
    this.mix.render(project, frame, playing);
    this.frameEl.dataset.frame = String(Math.floor(frame));
    this.frameEl.dataset.playing = playing ? "true" : "false";
  }

  /** Where the top fully visible video really is, so the clock can follow a late decoder. */
  private follow(f: number) {
    const project = this.shown();
    if (!project) return undefined;
    const { starts } = layoutOf(project);
    const top = visualsAt(project, starts, f)
      .filter((v) => v.item.type === "clip" && v.opacity === 1)
      .at(-1);
    if (!top) return undefined;
    const el = this.els.get(top.item.id);
    if (!(el instanceof HTMLVideoElement) || el.paused || el.seeking || el.readyState < 3) return undefined;
    return starts.get(top.item.id)! + (el.currentTime * project.canvas.fps - (top.item.in ?? 0)) / (top.item.speed ?? 1);
  }
}

interface CanvasDrag {
  readonly id: string;
  /** A text move (D53), a clip move or a clip's corner (D75). */
  readonly kind: "text" | "clip" | Corner;
  readonly pointer: number;
  readonly px: number;
  readonly py: number;
  readonly x: number;
  readonly y: number;
  /** The box in canvas pixels, for snapping. */
  readonly w: number;
  readonly h: number;
  /** How far the drawn box's top is below y (captions are drawn from their bottom edge, D82): snapping uses the drawn box. */
  readonly oy?: number;
  /** The playhead when it began: a keyed clip changes its keys there. */
  readonly frame: number;
  readonly revision: number;
  moved: boolean;
  to?: { x: number; y: number; w?: number; h?: number };
  draft?: PreviewDraft;
}

interface InlineEdit {
  readonly id: string;
  /** The text element's inline style, so the editor sits exactly over it with the same type. */
  readonly css: string;
  readonly text: string;
  readonly revision: number;
}

/** Stop showing a draft, unless a newer gesture has put up its own since. */
const dropDraft = (draft: PreviewDraft | undefined) => {
  if (draft && getPlayback().draft === draft) playback.setDraft(undefined);
};

/** Pointer travel (screen px) before a press on a text becomes a drag, and the snap distance. */
const DRAG_PX = 3;
const SNAP_SCREEN_PX = 8;

/**
 * Keyed on the project folder by its parent: another project gets a fresh preview. On the canvas
 * (D53): a click on a text selects it, dragging moves it (snapping to the centre lines and safe
 * margins, ⌘ to move freely; one edit on release), a double click edits it in place (Enter
 * saves, ⇧Enter is a new line, Esc cancels, clicking away saves).
 */
export function Stage({ project, dir }: { project: ProjectModel; dir: string }) {
  const { width, height } = project.canvas;
  const { ref, size: fitted } = useFit(width, height);
  // Zoom and pan (G6): Fit is the fitted size; a zoom is canvas px per screen px.
  const view = useViewport(ref, fitted.w / width);
  const size = view.zoom === "fit" ? fitted : { w: Math.round(width * view.scale), h: Math.round(height * view.scale) };
  // The full-window preview (G7b): Esc or the button again leaves it.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement | null)?.closest?.(".pv-inline")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setFull(false);
    };
    // Real full screen too, except in a background test run (it would show the hidden window).
    const native = !window.uncut?.silentAudio && document.fullscreenEnabled;
    if (native) void document.documentElement.requestFullscreen().catch(() => {});
    const onChange = () => !document.fullscreenElement && setFull(false);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [full]);
  const frameRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const compositor = useRef<Compositor | undefined>(undefined);
  const drag = useRef<CanvasDrag | undefined>(undefined);
  const [guides, setGuides] = useState<ReadonlyArray<Guide>>([]);
  const [editing, setEditing] = useState<InlineEdit | undefined>();
  useEffect(() => {
    const c = new Compositor(dir, frameRef.current!, mediaRef.current!, textRef.current!);
    compositor.current = c;
    return () => {
      c.destroy();
      compositor.current = undefined;
    };
  }, [dir]);
  useEffect(() => compositor.current?.setProject(project), [project]);
  useEffect(() => compositor.current?.setEditing(editing?.id), [editing?.id]);
  // Canvas pixels per screen pixel, and its inverse: how the canvas-size layer is scaled.
  const scale = width / Math.max(1, size.w);
  const fit = size.w / width;

  /** The text item under an event, if it can be moved or edited by hand. */
  const editableText = (target: EventTarget, at?: { clientX: number; clientY: number }) => {
    const el =
      (target as HTMLElement).closest<HTMLElement>(".pv-text[data-item]") ??
      (at ? document.elementsFromPoint(at.clientX, at.clientY).find((n): n is HTMLElement => n instanceof HTMLElement && n.matches(".pv-text[data-item]")) : undefined);
    const placed = findItem(project, el?.dataset.item);
    // Captions (D82) draw as text: they move like it, but their words are edited in the Inspector.
    if (!el || !placed || (placed.item.type !== "text" && placed.item.type !== "captions") || lockOf(placed)) return undefined;
    return { el, item: placed.item };
  };

  /** A clip or component that can be moved or resized by hand (D75, D76): selected, unlocked, drawn at the playhead. */
  const editableClip = (id: string | undefined) => {
    const placed = findItem(project, id);
    if (!placed || (placed.item.type !== "clip" && !isDrawnComponent(placed.item)) || lockOf(placed)) return undefined;
    const state = clipState(project, placed.item.id, getPlayback().frame);
    return state?.inside ? state : undefined;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Presses in the in-place editor are its own (caret, selection).
    if (e.button !== 0 || (e.target as HTMLElement).closest(".pv-inline")) return;
    const target = e.target as HTMLElement;
    const before = getPlayback().selected;
    const corner = target.closest<HTMLElement>("[data-handle]")?.dataset.handle as Corner | undefined;
    if (!corner) playback.select(target.closest<HTMLElement>("[data-item]")?.dataset.item);
    const snapshot = getState().snapshot;
    if (editing || !snapshot || snapshot.dir !== dir) return;
    const start = { pointer: e.pointerId, px: e.clientX, py: e.clientY, frame: Math.round(getPlayback().frame), revision: snapshot.revision, moved: false };
    // A clip's corner handle, or a press on the clip that was already selected: move or resize it.
    const clipId = corner ? before : target.closest<HTMLElement>(".pv-box[data-item], .pv-comp[data-item]")?.dataset.item;
    const clip = clipId !== undefined && clipId === before ? editableClip(clipId) : undefined;
    if (clip) {
      e.stopPropagation();
      drag.current = { ...start, id: clip.item.id, kind: corner ?? "clip", x: clip.box.x, y: clip.box.y, w: clip.box.w, h: clip.box.h };
      return;
    }
    const hit = editableText(e.target);
    if (!hit) return;
    const box = textBox(hit.item, project);
    drag.current = {
      ...start,
      id: hit.item.id,
      kind: "text",
      x: box.x,
      y: box.y,
      // Laid out at canvas size, so its offset size is already in canvas pixels.
      w: hit.el.offsetWidth,
      h: hit.el.offsetHeight,
      // A captions card is drawn from its bottom edge: its drawn top isn't the item's y.
      oy: hit.item.type === "captions" ? hit.el.offsetTop - box.y : 0,
    };
  };

  /** The edit a drag makes, planned on `p`. */
  const dragPlan = (p: ProjectModel, d: CanvasDrag, to: NonNullable<CanvasDrag["to"]>) =>
    d.kind === "text" ? planTransform(p, d.id, { x: to.x, y: to.y }) : d.kind === "clip" ? planClipBox(p, d.id, { x: to.x, y: to.y }, d.frame) : planClipBox(p, d.id, to, d.frame);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    // Released outside the frame before it became a drag: forget it.
    if (e.buttons === 0) {
      drag.current = undefined;
      return dropDraft(d.draft);
    }
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!d.moved) {
      playback.pause();
      // Captured only once it's a drag: capturing on press would retarget the clicks (and the
      // double click that edits in place) to the layer.
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    d.moved = true;
    let shown: ReadonlyArray<Guide> = [];
    if (d.kind === "text" || d.kind === "clip") {
      let x = Math.round(d.x + dx * scale);
      let y = Math.round(d.y + dy * scale);
      if (!e.metaKey && getPlayback().snapping) {
        const oy = d.oy ?? 0;
        const snapped = snapBox({ x, y: y + oy, w: d.w, h: d.h }, project, SNAP_SCREEN_PX * scale);
        x = snapped.x;
        y = snapped.y - oy;
        shown = snapped.guides;
      }
      d.to = { x, y };
    } else {
      // A corner (D75): the opposite corner stays, the box keeps its shape unless ⇧ is held.
      const r = resizeBox({ x: d.x, y: d.y, w: d.w, h: d.h }, d.kind, dx * scale, dy * scale, e.shiftKey);
      d.to = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
    }
    // Planned on the project as it is now: a snapshot that arrived mid-drag (an agent edit, a
    // save) becomes the base, so the preview keeps following the pointer.
    const plan = dragPlan(project, d, d.to);
    const draft = "ops" in plan ? draftOf(project, plan.ops) : undefined;
    if (draft && "project" in draft) {
      dropDraft(d.draft);
      d.draft = { base: project, project: draft.project };
      playback.setDraft(d.draft);
    }
    setGuides(shown);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = undefined;
    setGuides([]);
    if (!commit || !d.moved || !d.to) return dropDraft(d.draft);
    const to = d.to;
    void actions.itemEdit((p) => dragPlan(p, d, to), { baseRevision: d.revision, dir }).finally(() => dropDraft(d.draft));
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const hit = editableText(e.target, e);
    const snapshot = getState().snapshot;
    if (!hit || hit.item.type !== "text" || !snapshot || snapshot.dir !== dir) return;
    playback.pause();
    setEditing({ id: hit.item.id, css: hit.el.getAttribute("style") ?? "", text: hit.item.text ?? "", revision: snapshot.revision });
  };

  /** A component dragged from Elements (D76): dropped on the canvas, it's added at the playhead, centred where it lands. */
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const types = [...e.dataTransfer.types];
    if ((!types.includes(COMPONENT_DRAG_TYPE) && !types.includes(TEXT_DRAG_TYPE)) || getState().connection !== "connected") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = frameRef.current!.getBoundingClientRect();
    const at = { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
    // A Text tab preset (D80): added at the playhead, where it's dropped.
    const preset = textPresets().find((p) => p.id === e.dataTransfer.getData(TEXT_DRAG_TYPE));
    if (preset) {
      e.preventDefault();
      void actions.addText(preset, { at });
      return;
    }
    const id = e.dataTransfer.getData(COMPONENT_DRAG_TYPE) || draggedComponent();
    if (!id) return;
    e.preventDefault();
    void actions.addComponent(id, { at });
  };

  const finishEdit = (text: string | undefined) => {
    const edit = editing;
    setEditing(undefined);
    if (!edit || text === undefined) return;
    void actions.itemEdit((p) => planText(p, edit.id, text), { baseRevision: edit.revision, dir });
  };

  return (
    <main className={`stage ${full ? "fullscreen" : ""}`} data-testid="stage" data-full={full ? "true" : undefined}>
      <style>{RENDER_CSS}</style>
      <div className={`stage-canvas ${view.hand ? "hand" : ""}`} ref={ref} data-testid="stage-canvas" data-zoom={view.zoom === "fit" ? "fit" : view.scale.toFixed(3)} onPointerDownCapture={(e) => view.handDown(e)}>
        <div
          className="frame"
          ref={frameRef}
          data-testid="preview-frame"
          data-frame="0"
          style={{ width: size.w, height: size.h, transform: view.pan.x || view.pan.y ? `translate(${view.pan.x}px, ${view.pan.y}px)` : undefined }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, true)}
          onPointerCancel={(e) => endDrag(e, false)}
          onDoubleClick={onDoubleClick}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {/* Everything is laid out at canvas size and scaled down as one (D56): the text's
              cqh sizes, shadows and line breaks resolve exactly as in the export's canvas-size
              page, whatever the preview's size (the system font's tracking depends on size). */}
          <div className="pv-canvas" style={{ width, height, transform: `scale(${fit})`, ["--pv-scale" as string]: fit || 1 }}>
            <div className="pv-layer" ref={mediaRef} data-testid="preview-media" />
            <div className="pv-layer pv-texts" ref={textRef} data-testid="preview-text" />
            <div className="pv-layer pv-overlay">
            {guides.map((g) => (
              <div
                key={`${g.axis}-${g.at}`}
                className={`pv-guide ${g.axis} ${g.kind}`}
                data-testid="canvas-guide"
                data-axis={g.axis}
                data-kind={g.kind}
                style={g.axis === "x" ? { left: `${(g.at / width) * 100}%` } : { top: `${(g.at / height) * 100}%` }}
              />
            ))}
            {editing && <InlineEditor key={editing.id} edit={editing} onDone={finishEdit} />}
            <ClipSelection project={project} />
            </div>
          </div>
        </div>
      </div>
      <Transport project={project} view={view} full={full} onFull={() => setFull(!full)} />
    </main>
  );
}

/**
 * The selected clip's box on the canvas (D75): an outline and four corner handles (drag one to
 * resize; the clip itself drags to move). Follows the playhead (keyed x / y) and drafts.
 */
function ClipSelection({ project }: { project: ProjectModel }) {
  const selected = usePlayback((s) => s.selected);
  const frame = usePlayback((s) => Math.round(s.frame));
  const draft = usePlayback((s) => s.draft);
  const shown = draft && draft.base === project ? draft.project : project;
  const placed = findItem(shown, selected);
  if (!placed || (placed.item.type !== "clip" && !isDrawnComponent(placed.item)) || lockOf(placed)) return null;
  const state = clipState(shown, placed.item.id, frame);
  if (!state?.inside) return null;
  const { x, y, w, h } = state.box;
  const corners: ReadonlyArray<readonly [Corner, number, number]> = [
    ["nw", x, y],
    ["ne", x + w, y],
    ["sw", x, y + h],
    ["se", x + w, y + h],
  ];
  return (
    <>
      <div className="pv-clip-sel" data-testid="clip-selection" data-item={placed.item.id} style={{ left: x, top: y, width: w, height: h }} />
      {corners.map(([c, cx, cy]) => (
        <div key={c} className="pv-handle" data-testid="clip-handle" data-handle={c} style={{ left: cx, top: cy }} />
      ))}
    </>
  );
}

/**
 * Text editing in place: a textarea over the hidden text with the same inline style (position,
 * font, size, colour, alignment), growing with its content. Enter saves, ⇧Enter adds a line,
 * Esc cancels, blur saves. Editor shortcuts don't fire while it has focus (Editor.tsx skips
 * editable targets).
 */
function InlineEditor({ edit, onDone }: { edit: InlineEdit; onDone: (text: string | undefined) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(edit.text);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    // Same box and type as the text; a fit-to-content box grows with what's typed instead.
    el.style.cssText = `${edit.css.replace(/width:max-content;?/, "")};opacity:1;visibility:visible;transform:none;clip-path:none`;
    el.focus();
    el.select();
  }, [edit.css]);
  const finish = (text: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  return (
    <textarea
      ref={ref}
      className="pv-inline"
      data-testid="inline-editor"
      data-item={edit.id}
      value={value}
      spellCheck={false}
      rows={1}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Mid-composition (IME) Esc and Enter belong to the input method.
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(undefined);
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(value);
        }
      }}
    />
  );
}
