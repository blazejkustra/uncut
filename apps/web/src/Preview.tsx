// The preview and the transport under it. The preview draws the project at the playhead at the
// canvas's aspect ratio: media through <video> (D37; <img> for stills), seeked to the source time
// of the frame (D38), text from @uncut/core's textHtml on top (D39), black where nothing is.
import { visualsAt } from "@uncut/core/timeline";
import { textHtml } from "@uncut/core/render";
import { Maximize2, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { canvasLabel, frameTimecode } from "./format.ts";
import { getPlayback, playback, usePlayback } from "./playback.ts";
import { layoutOf, type Item, type ProjectModel } from "./project.ts";
import { getState, mediaUrl } from "./store.ts";

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
 * Draws the project into the preview frame, imperatively: it runs on every playhead change
 * (60 times a second while playing) without going through React.
 */
class Compositor {
  private project: ProjectModel | undefined;
  private readonly els = new Map<string, MediaEl>();
  private textKey = "";
  private readonly unsubscribe: () => void;
  private readonly frameEl: HTMLDivElement;
  private readonly mediaLayer: HTMLDivElement;
  private readonly textLayer: HTMLDivElement;
  // The project folder this preview draws. Another folder open means this preview is on its way
  // out: it draws nothing more (its media ids could name the new project's files).
  private readonly dir: string;

  constructor(dir: string, frameEl: HTMLDivElement, mediaLayer: HTMLDivElement, textLayer: HTMLDivElement) {
    this.dir = dir;
    this.frameEl = frameEl;
    this.mediaLayer = mediaLayer;
    this.textLayer = textLayer;
    this.unsubscribe = playback.subscribe(() => this.render());
    playback.setFollower((f) => this.follow(f));
  }

  destroy() {
    this.unsubscribe();
    playback.setFollower(undefined);
    for (const id of [...this.els.keys()]) this.drop(id);
  }

  setProject(project: ProjectModel) {
    this.project = project;
    this.render();
  }

  private drop(id: string) {
    const el = this.els.get(id);
    if (!el) return;
    if (el instanceof HTMLVideoElement) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    el.remove();
    this.mediaLayer.querySelector(`[data-missing="${CSS.escape(id)}"]`)?.remove();
    this.els.delete(id);
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
      video.muted = true;
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
    shown.addEventListener("error", () => {
      if (this.els.get(item.id) !== shown || this.mediaLayer.querySelector(`[data-missing="${CSS.escape(item.id)}"]`)) return;
      shown.style.visibility = "hidden";
      const note = document.createElement("div");
      note.className = "pv-missing";
      note.dataset.missing = item.id;
      note.textContent = `Can't show ${media.name}`;
      note.style.zIndex = shown.style.zIndex;
      this.mediaLayer.append(note);
    });
    el.src = src;
    this.els.set(item.id, el);
    this.mediaLayer.append(el);
    return el;
  }

  render() {
    const project = this.project;
    if (!project) return;
    if (getState().snapshot?.dir !== this.dir) {
      for (const id of [...this.els.keys()]) this.drop(id);
      return;
    }
    const { frame, playing, selected } = getPlayback();
    const fps = project.canvas.fps;
    const { starts } = layoutOf(project);
    const visible = visualsAt(project, starts, frame);
    const mediaKind = (item: Item) => project.media.find((m) => m.id === item.media);
    const clips = visible.filter((v) => v.item.type === "clip" && mediaKind(v.item) && mediaKind(v.item)!.kind !== "audio");
    // Warm up the next main clip two seconds ahead so the cut doesn't wait for a decoder.
    const main = project.tracks.find((t) => t.role === "main");
    const ahead = main?.items.find((it) => {
      const start = starts.get(it.id)! - (it.transitionIn?.duration ?? 0) / 2;
      return start > frame && start - frame < 2 * fps && mediaKind(it)?.kind === "video";
    });
    const keep = new Set([...clips.map((c) => c.item.id), ...(ahead ? [ahead.id] : [])]);
    for (const id of [...this.els.keys()]) if (!keep.has(id)) this.drop(id);

    clips.forEach((c, z) => {
      const media = mediaKind(c.item)!;
      const el = this.elementFor(c.item, media.kind === "image" ? "image" : "video");
      if (!el) return;
      el.style.opacity = String(c.opacity);
      el.style.zIndex = String(z + 1);
      if (!(el instanceof HTMLVideoElement)) return;
      el.muted = !playing || c.opacity < 1 || !media.probe?.hasAudio;
      const target = c.source + 0.0001;
      if (playing) {
        if (el.paused) {
          seek(el, target);
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - target) > 0.12) seek(el, target);
      } else {
        if (!el.paused) el.pause();
        seek(el, target);
      }
    });
    if (ahead && !clips.some((c) => c.item.id === ahead.id)) {
      const el = this.elementFor(ahead, "video");
      if (el instanceof HTMLVideoElement) {
        el.style.opacity = "0";
        el.style.zIndex = "0";
        if (!el.paused) el.pause();
        seek(el, ((ahead.in ?? 0) - (ahead.transitionIn?.duration ?? 0) / 2) / fps + 0.0001);
      }
    }

    // Text: rebuilt only when what it shows changes, not on every frame.
    const html = visible
      .filter((v) => v.item.type === "text" && typeof v.item.text === "string" && v.item.transform && v.item.style?.size)
      .map(({ item, opacity }) => textHtml(item, project.canvas, { opacity, selected: item.id === selected }))
      .join("");
    if (html !== this.textKey) {
      this.textKey = html;
      this.textLayer.innerHTML = html;
    }
    this.frameEl.dataset.frame = String(Math.floor(frame));
    this.frameEl.dataset.playing = playing ? "true" : "false";
  }

  /** Where the top fully visible video really is, so the clock can follow a late decoder. */
  private follow(f: number) {
    const project = this.project;
    if (!project) return undefined;
    const { starts } = layoutOf(project);
    const top = visualsAt(project, starts, f)
      .filter((v) => v.item.type === "clip" && v.opacity === 1)
      .at(-1);
    const el = top && this.els.get(top.item.id);
    if (!(el instanceof HTMLVideoElement) || el.paused || el.seeking || el.readyState < 3) return undefined;
    return starts.get(top.item.id)! + el.currentTime * project.canvas.fps - (top.item.in ?? 0);
  }
}

/** Keyed on the project folder by its parent: another project gets a fresh preview. */
export function Stage({ project, dir }: { project: ProjectModel; dir: string }) {
  const { width, height } = project.canvas;
  const { ref, size } = useFit(width, height);
  const frameRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const compositor = useRef<Compositor | undefined>(undefined);
  useEffect(() => {
    const c = new Compositor(dir, frameRef.current!, mediaRef.current!, textRef.current!);
    compositor.current = c;
    return () => {
      c.destroy();
      compositor.current = undefined;
    };
  }, [dir]);
  useEffect(() => compositor.current?.setProject(project), [project]);
  return (
    <main className="stage">
      <div className="stage-canvas" ref={ref}>
        <div className="frame" ref={frameRef} data-testid="preview-frame" data-frame="0" style={{ width: size.w, height: size.h }}>
          <div className="pv-layer" ref={mediaRef} data-testid="preview-media" />
          <div
            className="pv-layer pv-texts"
            ref={textRef}
            data-testid="preview-text"
            onPointerDown={(e) => playback.select((e.target as HTMLElement).closest<HTMLElement>("[data-item]")?.dataset.item)}
          />
        </div>
      </div>
      <Transport project={project} />
    </main>
  );
}

function Transport({ project }: { project: ProjectModel }) {
  const fps = project.canvas.fps;
  const frame = usePlayback((s) => Math.floor(s.frame));
  const playing = usePlayback((s) => s.playing);
  const { end, frames } = layoutOf(project);
  return (
    <div className="transport">
      <span className="timecode" data-testid="timecode">
        {frameTimecode(frame, fps)} / {frameTimecode(end, fps)}
      </span>
      <div className="transport-mid">
        <button className="icon-btn" data-testid="to-start" title="Go to start (Home)" disabled={frame === 0} onClick={playback.toStart}>
          <SkipBack />
        </button>
        <button className="icon-btn" data-testid="step-back" title="Back one frame (←)" disabled={frame === 0} onClick={() => playback.step(-1)}>
          <StepBack />
        </button>
        <button className="icon-btn play" data-testid="play" title={playing ? "Pause (Space)" : "Play (Space)"} disabled={frames <= 1} onClick={playback.toggle}>
          {playing ? <Pause /> : <Play />}
        </button>
        <button className="icon-btn" data-testid="step-forward" title="Forward one frame (→)" disabled={frame >= frames - 1} onClick={() => playback.step(1)}>
          <StepForward />
        </button>
        <button className="icon-btn" data-testid="to-end" title="Go to end (End)" disabled={frame >= frames - 1} onClick={playback.toEnd}>
          <SkipForward />
        </button>
      </div>
      <span className="muted small" data-testid="canvas-info">
        {canvasLabel(project.canvas)}
      </span>
      <button className="icon-btn" data-testid="zoom-fit-transport" title="Fit the timeline to the window (⌘0)" onClick={playback.zoomFit}>
        <Maximize2 />
      </button>
    </div>
  );
}
