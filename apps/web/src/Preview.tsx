// The preview and the transport under it. The preview draws the project at the playhead at the
// canvas's aspect ratio: media through <video> (D37; <img> for stills), seeked to the source time
// of the frame (D38), backgrounds (component.solid) between them in track order, text from
// @uncut/core's textHtml on top (D39), the canvas colour where nothing is. The text can be
// selected, dragged and edited in place (D53).
import { visualsAt } from "@uncut/core/timeline";
import { overlaps } from "@uncut/core/transitions";
import { canvasBackground, RENDER_CSS, SOLID, solidBackground, textHtml } from "@uncut/core/render";
import { Maximize2, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Mix, PREROLL_S, setCurrentMix } from "./audio.ts";
import { draftOf, findItem, lockOf } from "./edit.ts";
import { canvasLabel, frameTimecode } from "./format.ts";
import { getPlayback, playback, usePlayback, type PreviewDraft } from "./playback.ts";
import { layoutOf, type Item, type ProjectModel } from "./project.ts";
import { actions, getState, mediaUrl } from "./store.ts";
import { planText, planTransform, snapBox, textBox, type Guide } from "./text.ts";

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

/** A wipe transition: show the left share of the element (core's `wipe`), or all of it. */
function wipe(el: HTMLElement, shown: number | undefined) {
  const clip = shown === undefined ? "" : `inset(0 ${((1 - shown) * 100).toFixed(4)}% 0 0)`;
  if (el.style.clipPath !== clip) el.style.clipPath = clip;
}

/**
 * Draws the project into the preview frame, imperatively: it runs on every playhead change
 * (60 times a second while playing) without going through React.
 */
class Compositor {
  private project: ProjectModel | undefined;
  private readonly els = new Map<string, MediaEl>();
  private readonly solids = new Map<string, HTMLDivElement>();
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
    this.mix.destroy();
    setCurrentMix(undefined);
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
    if (el instanceof HTMLVideoElement && media.probe?.hasAudio) this.mix.attach(item.id, el);
    this.els.set(item.id, el);
    this.mediaLayer.append(el);
    return el;
  }

  render() {
    const project = this.shown();
    if (!project) return;
    if (getState().snapshot?.dir !== this.dir) {
      for (const id of [...this.els.keys()]) this.drop(id);
      this.mix.stop();
      return;
    }
    const background = canvasBackground(project);
    if (this.frameEl.style.background !== background) this.frameEl.style.background = background;
    const { frame, playing, selected } = getPlayback();
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
      (v) => (v.item.type === "clip" && mediaKind(v.item) && mediaKind(v.item)!.kind !== "audio") || (v.item.type === "component" && v.item.component === SOLID) || (v.item.type === "text" && typeof v.item.text === "string"),
    );
    const z = new Map(drawn.map((v, i) => [v.item.id, i + 1]));
    const layered = drawn.filter((v) => v.item.type !== "text");
    const solids = layered.filter((v) => v.item.type === "component");
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
      wipe(el, v.wipe);
    }

    clips.forEach((c) => {
      const media = mediaKind(c.item)!;
      const el = this.elementFor(c.item, media.kind === "image" ? "image" : "video");
      if (!el) return;
      el.style.opacity = String(c.opacity);
      el.style.zIndex = String(z.get(c.item.id));
      wipe(el, c.wipe);
      if (!(el instanceof HTMLVideoElement)) return;
      if (media.probe?.hasAudio) this.mix.attach(c.item.id, el);
      drive(el, c.source, playing, c.item.speed ?? 1);
    });
    if (ahead && !clips.some((c) => c.item.id === ahead.id)) {
      const el = this.elementFor(ahead, "video");
      if (el instanceof HTMLVideoElement) {
        el.style.opacity = "0";
        el.style.zIndex = "0";
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
    for (const el of this.textLayer.children) {
      const zi = String(z.get((el as HTMLElement).dataset.item ?? "") ?? 0);
      if ((el as HTMLElement).style.zIndex !== zi) (el as HTMLElement).style.zIndex = zi;
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
  readonly pointer: number;
  readonly px: number;
  readonly py: number;
  readonly x: number;
  readonly y: number;
  /** The box in canvas pixels, for snapping. */
  readonly w: number;
  readonly h: number;
  readonly revision: number;
  moved: boolean;
  to?: { x: number; y: number };
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
  const { ref, size } = useFit(width, height);
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
    if (!el || !placed || placed.item.type !== "text" || lockOf(placed)) return undefined;
    return { el, item: placed.item };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Presses in the in-place editor are its own (caret, selection).
    if (e.button !== 0 || (e.target as HTMLElement).closest(".pv-inline")) return;
    playback.select((e.target as HTMLElement).closest<HTMLElement>("[data-item]")?.dataset.item);
    const hit = editableText(e.target);
    const snapshot = getState().snapshot;
    if (!hit || editing || !snapshot || snapshot.dir !== dir) return;
    const box = textBox(hit.item, project.canvas);
    drag.current = {
      id: hit.item.id,
      pointer: e.pointerId,
      px: e.clientX,
      py: e.clientY,
      x: box.x,
      y: box.y,
      // Laid out at canvas size, so its offset size is already in canvas pixels.
      w: hit.el.offsetWidth,
      h: hit.el.offsetHeight,
      revision: snapshot.revision,
      moved: false,
    };
  };

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
    let x = Math.round(d.x + dx * scale);
    let y = Math.round(d.y + dy * scale);
    let shown: ReadonlyArray<Guide> = [];
    if (!e.metaKey && getPlayback().snapping) {
      const snapped = snapBox({ x, y, w: d.w, h: d.h }, project, SNAP_SCREEN_PX * scale);
      ({ x, y } = snapped);
      shown = snapped.guides;
    }
    d.to = { x, y };
    // Planned on the project as it is now: a snapshot that arrived mid-drag (an agent edit, a
    // save) becomes the base, so the preview keeps following the pointer.
    const plan = planTransform(project, d.id, { x, y });
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
    void actions.itemEdit((p) => planTransform(p, d.id, to), { baseRevision: d.revision, dir }).finally(() => dropDraft(d.draft));
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const hit = editableText(e.target, e);
    const snapshot = getState().snapshot;
    if (!hit || !snapshot || snapshot.dir !== dir) return;
    playback.pause();
    setEditing({ id: hit.item.id, css: hit.el.getAttribute("style") ?? "", text: hit.item.text ?? "", revision: snapshot.revision });
  };

  const finishEdit = (text: string | undefined) => {
    const edit = editing;
    setEditing(undefined);
    if (!edit || text === undefined) return;
    void actions.itemEdit((p) => planText(p, edit.id, text), { baseRevision: edit.revision, dir });
  };

  return (
    <main className="stage">
      <style>{RENDER_CSS}</style>
      <div className="stage-canvas" ref={ref}>
        <div
          className="frame"
          ref={frameRef}
          data-testid="preview-frame"
          data-frame="0"
          style={{ width: size.w, height: size.h }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, true)}
          onPointerCancel={(e) => endDrag(e, false)}
          onDoubleClick={onDoubleClick}
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
            </div>
          </div>
        </div>
      </div>
      <Transport project={project} />
    </main>
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
        <button className="icon-btn" data-testid="step-forward" title="Forward one frame (→)" disabled={frame >= Math.max(frames - 1, end)} onClick={() => playback.step(1)}>
          <StepForward />
        </button>
        <button className="icon-btn" data-testid="to-end" title="Go to end (End)" disabled={frame >= end} onClick={playback.toEnd}>
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
