// The preview and the transport under it. The preview draws the project at the playhead at the
// canvas's aspect ratio: media through <video> (D37; <img> for stills), seeked to the source time
// of the frame (D38), each in its box (D75: a wrapper at core's box that clips, rounds and fades
// it, the picture inside at core's content rect), backgrounds (component.solid) between them in
// track order, text from @uncut/core's textHtml on top (D39), the canvas colour where nothing is.
// Components are core's componentHtml at the frame (D76: the same HTML the export rasterises);
// graphic items are their documents in sandboxed iframes, render(t) called by postMessage (D78).
// The text can be selected, dragged and edited in place (D53); a selected clip or component can be
// dragged and resized by its corners (D75); a component dropped from Elements lands where it's dropped.
import { isDrawnComponent } from "@uncut/core/components";
import { RENDER_CSS } from "@uncut/core/render";
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { draftOf, findItem, lockOf, planLayer } from "../timeline/edit.ts";
import { getPlayback, playback, type PreviewDraft } from "./playback.ts";
import { type ProjectModel } from "../state/project.ts";
import { actions, getState, subscribeApp, textPresets } from "../state/store.ts";
import { useProxiesOn } from "../settings/proxies.ts";
import { useScrubCacheOn } from "../settings/scrub.ts";
import { useGpuCompositorOn } from "../settings/gpu.ts";
import { usePlayEngineOn } from "../settings/playEngine.ts";
import { requestTextFocus } from "../inspector/focus.ts";
import { COMPONENT_DRAG_TYPE, draggedComponent, draggedText, setDraggedText, TEXT_DRAG_TYPE } from "./components.ts";
import { planText, planTextScale, planTransform, snapBox, textBox, type Guide } from "./text.ts";
import { clipState, planClipBox, planResetPosition, resizeBox, type Corner } from "../timeline/clip.ts";
import { Transport } from "./Transport.tsx";
import { useViewport } from "./viewport.ts";
import { EFFECT_DRAG_TYPE, setDraggedEffect } from "../timeline/dnd.ts";
import { openMenu } from "../timeline/ContextMenu.tsx";
import { copySelection, deleteSelection, duplicate } from "../editor/keys.ts";
import { useFit } from "./hooks/useFit.ts";
import { Compositor } from "./compositor/Compositor.ts";
import { type InlineEdit, InlineEditor } from "./stage/InlineEditor.tsx";
import { dropGhostHtml } from "./stage/dropGhost.ts";
import { ClipSelection, TextSelection } from "./stage/selection.tsx";
import { AgentChangePill } from "./stage/AgentChangePill.tsx";
import { MediaSkim } from "./stage/MediaSkim.tsx";
import { RegionPins, RegionSelect } from "./stage/Region.tsx";

interface CanvasDrag {
  readonly id: string;
  /** A text move (D53), a clip move or a clip's corner (D75). */
  readonly kind: "text" | "clip" | Corner;
  /** Issue #72 (D242): a text's corner (kind "text"): the drag resizes it, from its drawn box (x, y, w, h). */
  readonly textCorner?: Corner;
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
  to?: { x: number; y: number; w?: number; h?: number; k?: number };
  draft?: PreviewDraft;
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
  // A tile dragged over the canvas (X2, D132): the element as it would land there, drawn faint with an outline.
  const [dropGhost, setDropGhost] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<InlineEdit | undefined>();
  // Issue #118: the Area tool (a rectangle over the picture into the chat).
  const [region, setRegion] = useState(false);
  const endRegion = useCallback(() => setRegion(false), []);
  useEffect(() => {
    const c = new Compositor(dir, frameRef.current!, mediaRef.current!, textRef.current!);
    compositor.current = c;
    return () => {
      c.destroy();
      compositor.current = undefined;
    };
  }, [dir]);
  useEffect(() => compositor.current?.setProject(project), [project]);
  // D212: a proxy that's ready (or the setting turned) swaps the clip's element for the other file.
  const proxies = useSyncExternalStore(subscribeApp, () => getState().proxies);
  const useProxies = useProxiesOn();
  // D221: the scrub cache, the playback engine (D311) or the GPU compositor turned on or off draws again.
  const scrubCache = useScrubCacheOn();
  const playEngine = usePlayEngineOn();
  const gpu = useGpuCompositorOn();
  useEffect(() => compositor.current?.render(), [proxies, useProxies, scrubCache, playEngine, gpu]);
  useEffect(() => compositor.current?.setEditing(editing?.id), [editing?.id]);
  // Canvas pixels per screen pixel, and its inverse: how the canvas-size layer is scaled.
  const scale = width / Math.max(1, size.w);
  const fit = size.w / width;

  /** The text item under an event, if it can be moved or edited by hand. */
  const editableText = (target: EventTarget, at?: { clientX: number; clientY: number }) => {
    const inside = (n: HTMLElement) => {
      const r = n.getBoundingClientRect();
      return !!at && at.clientX >= r.left && at.clientX <= r.right && at.clientY >= r.top && at.clientY <= r.bottom;
    };
    const el =
      (target as HTMLElement).closest<HTMLElement>(".pv-text[data-item]") ??
      (at
        ? document.elementsFromPoint(at.clientX, at.clientY).find((n): n is HTMLElement => n instanceof HTMLElement && n.matches(".pv-text[data-item]"))
        : undefined) ??
      // F20 (D158): a text mid-way through a reveal (clipped) still takes a double click inside its box; the selected one first.
      (at
        ? ([...document.querySelectorAll<HTMLElement>(".pv-text.sel-box[data-item]"), ...document.querySelectorAll<HTMLElement>(".pv-text[data-item]")].find(
            inside,
          ) ?? undefined)
        : undefined);
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
    // Issue #72 (D242): the selected text's corner resizes it.
    const textCorner = target.closest<HTMLElement>("[data-text-handle]")?.dataset.textHandle as Corner | undefined;
    if (textCorner) {
      const placed = findItem(project, before);
      const el = before === undefined ? null : textRef.current?.querySelector<HTMLElement>(`.pv-text[data-item="${CSS.escape(before)}"]`);
      if (!placed || placed.item.type !== "text" || lockOf(placed) || !el || el.offsetWidth <= 0) return;
      e.stopPropagation();
      drag.current = { ...start, id: placed.item.id, kind: "text", textCorner, x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
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
    d.textCorner
      ? planTextScale(p, d.id, to.k ?? 1, d.textCorner, { x: d.x, y: d.y, w: d.w, h: d.h })
      : d.kind === "text"
        ? planTransform(p, d.id, { x: to.x, y: to.y })
        : d.kind === "clip"
          ? planClipBox(p, d.id, { x: to.x, y: to.y }, d.frame)
          : planClipBox(p, d.id, to, d.frame);

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
    if (d.textCorner) {
      // Issue #72 (D242): the box keeps its shape (a text has no height of its own); its width's factor is the font size's.
      const r = resizeBox({ x: d.x, y: d.y, w: d.w, h: d.h }, d.textCorner, dx * scale, dy * scale, false);
      d.to = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), k: r.w / d.w };
    } else if (d.kind === "text" || d.kind === "clip") {
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
    // F23 (D162): an element (lower third...) has no in-place editor: its main text field in the Inspector takes the focus.
    const comp = hit ? undefined : findItem(project, (e.target as HTMLElement).closest<HTMLElement>(".pv-comp[data-item]")?.dataset.item);
    if (comp && isDrawnComponent(comp.item)) {
      playback.pause();
      playback.select(comp.item.id);
      actions.openPanel("inspector");
      requestTextFocus(comp.item.id);
      return;
    }
    if (!hit || hit.item.type !== "text" || !snapshot || snapshot.dir !== dir) return;
    playback.pause();
    setEditing({ id: hit.item.id, css: hit.el.getAttribute("style") ?? "", text: hit.item.text ?? "", revision: snapshot.revision });
  };

  /** A component dragged from Elements (D76): dropped on the canvas, it's added at the playhead, centred where it lands. */
  /** The clip on the canvas under a pointer (an Effects tile dropped there goes on it, D136): the topmost box there. */
  const clipAt = (x: number, y: number) =>
    document.elementsFromPoint(x, y).find((el): el is HTMLElement => el instanceof HTMLElement && el.matches(".pv-box[data-item]"))?.dataset.item;
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const types = [...e.dataTransfer.types];
    if (types.includes(EFFECT_DRAG_TYPE)) {
      if (getState().connection !== "connected" || !clipAt(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    if ((!types.includes(COMPONENT_DRAG_TYPE) && !types.includes(TEXT_DRAG_TYPE)) || getState().connection !== "connected") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const rect = frameRef.current!.getBoundingClientRect();
    const at = { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
    const ghost = dropGhostHtml(project, types.includes(TEXT_DRAG_TYPE) ? { text: draggedText() } : { component: draggedComponent() }, at);
    if (ghost !== dropGhost) setDropGhost(ghost);
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropGhost(undefined);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    setDropGhost(undefined);
    const effect = e.dataTransfer.getData(EFFECT_DRAG_TYPE);
    if (effect) {
      e.preventDefault();
      setDraggedEffect(undefined);
      const id = clipAt(e.clientX, e.clientY);
      if (id) void actions.applyFx(effect, id);
      return;
    }
    setDraggedText(undefined);
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
      <div
        className={`stage-canvas ${view.hand ? "hand" : ""}`}
        ref={ref}
        data-testid="stage-canvas"
        data-zoom={view.zoom === "fit" ? "fit" : view.scale.toFixed(3)}
        onPointerDownCapture={(e) => view.handDown(e)}
        onMouseDownCapture={(e) => e.button === 1 && e.preventDefault()}
        onAuxClick={(e) => e.button === 1 && e.preventDefault()}
      >
        <div
          className="frame"
          ref={frameRef}
          data-testid="preview-frame"
          data-frame="0"
          style={{ width: size.w, height: size.h, transform: view.pan.x || view.pan.y ? `translate(${view.pan.x}px, ${view.pan.y}px)` : undefined }}
          onPointerDown={onPointerDown}
          onContextMenu={(e) => {
            // D141: right-click a picture or a text on the canvas: Add to chat (with the frame it
            // was picked at), and the usual Copy, Duplicate and Delete.
            const id = (e.target as HTMLElement).closest<HTMLElement>("[data-item]")?.dataset.item;
            if (!id || !findItem(project, id)) return;
            e.preventDefault();
            playback.select(id);
            const frame = Math.floor(getPlayback().frame);
            const off = getState().connection !== "connected";
            // F15 (D151): also Split at the playhead, Detach audio, the layer order and Reset position.
            const placed = findItem(project, id)!;
            const { item, track, start } = placed;
            const locked = !!(track.locked || item.locked) || off;
            const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
            const layered = track.role !== "main" && item.type !== "captions";
            const forward = layered ? planLayer(project, id, -1) : undefined;
            const backward = layered ? planLayer(project, id, 1) : undefined;
            const reset = planResetPosition(project, id);
            openMenu(
              e.clientX,
              e.clientY,
              [
                { id: "add-to-chat", label: "Add to chat", run: () => actions.addItemToChat(id, frame) },
                "-",
                {
                  id: "split",
                  label: "Split at playhead",
                  shortcut: "S",
                  disabled: locked || !(frame > start && frame < start + item.duration),
                  run: () => void actions.split(),
                },
                ...(item.type === "clip" && media?.kind === "video" && media.probe?.hasAudio
                  ? [
                      {
                        id: "detach-audio",
                        label: item.mute ? "Audio detached" : "Detach audio",
                        disabled: locked || !!item.mute,
                        run: () => void actions.detachAudio(id),
                      },
                    ]
                  : []),
                "-",
                { id: "bring-forward", label: "Bring forward", disabled: locked || !forward || "problem" in forward, run: () => void actions.layer(id, -1) },
                { id: "send-backward", label: "Send backward", disabled: locked || !backward || "problem" in backward, run: () => void actions.layer(id, 1) },
                { id: "reset-position", label: "Reset position", disabled: locked || "problem" in reset, run: () => void actions.resetPosition(id) },
                "-",
                { id: "copy", label: "Copy", shortcut: "⌘C", run: () => void copySelection() },
                { id: "duplicate", label: "Duplicate", shortcut: "⌘D", disabled: off, run: () => void duplicate() },
                { id: "delete", label: "Delete", shortcut: "⌫", danger: true, disabled: off, run: () => void deleteSelection() },
              ],
              "Canvas item",
            );
          }}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, true)}
          onPointerCancel={(e) => endDrag(e, false)}
          onDoubleClick={onDoubleClick}
          // Issue #61 (D233): nothing on the canvas starts a native drag (an <img>'s ghost copy
          // would cancel the pointer drag that moves the layer); the in-place editor's text may.
          onDragStart={(e) => !(e.target as HTMLElement).closest?.(".pv-inline") && e.preventDefault()}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
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
              {dropGhost && <div className="pv-drop-ghost" data-testid="drop-ghost" dangerouslySetInnerHTML={{ __html: dropGhost }} />}
              {editing && <InlineEditor key={editing.id} edit={editing} onDone={finishEdit} />}
              <ClipSelection project={project} />
              {!editing && <TextSelection layer={textRef} project={project} />}
            </div>
          </div>
          <MediaSkim />
          <RegionPins project={project} />
          {region && <RegionSelect project={project} onDone={endRegion} />}
        </div>
      </div>
      <AgentChangePill fps={project.canvas.fps} />
      <Transport project={project} view={view} full={full} onFull={() => setFull(!full)} region={region} onRegion={() => setRegion(!region)} />
    </main>
  );
}
