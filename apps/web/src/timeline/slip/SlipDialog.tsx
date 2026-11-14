// The slip view (slipView.ts): the item's whole media as a strip (a video's frames, a sound's
// waveform), the part it plays as a yellow window that slides along it, and the window's first
// frame above. The strip opens at 20× the window's length, centred on it; a pinch or ⌘ + wheel
// zooms around the pointer, − / + around the window, Fit shows the whole media, and a sideways
// swipe scrolls it. The window keeps itself in view as it moves.
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";

import { frameTimecode } from "../../state/format.ts";
import type { ProjectModel } from "../../state/project.ts";
import { actions, getState, mediaUrl, projectOf, proxyOf, proxyUrl, subscribeApp, thumbUrl } from "../../state/store.ts";
import { useProxiesOn } from "../../settings/proxies.ts";
import { Tooltip } from "../../ui/Tooltip.tsx";
import { planSlipBy } from "../edit/slipRoll.ts";
import { ClipFilmstrip } from "../Filmstrip.tsx";
import { ItemWaveform } from "../Waveform.tsx";
import { wheelZoom } from "../wheel.ts";
import {
  centredScroll,
  clampVisible,
  getSlip,
  keepInView,
  nudged,
  offsetFor,
  openVisible,
  pressOn,
  scrollFor,
  slip,
  slipSubject,
  useSlip,
  windowStart,
  type SlipSubject,
} from "./slipView.ts";
import "./slip.css";

const useOnline = () => useSyncExternalStore(subscribeApp, () => getState().connection === "connected");

export function SlipDialog({ project }: { project: ProjectModel }) {
  const itemId = useSlip((s) => s.itemId);
  const online = useOnline();
  const subject = itemId === undefined ? undefined : slipSubject(project, itemId, online);
  // The item went (undone, deleted by the agent): nothing left to slip.
  useEffect(() => {
    if (itemId !== undefined && !subject) slip.close();
  }, [itemId, subject]);
  useEffect(() => () => slip.close(), []);
  if (!subject) return null;
  return <SlipModal key={subject.item.id} subject={subject} fps={project.canvas.fps} />;
}

const signed = (frames: number) => `${frames > 0 ? "+" : ""}${frames} ${Math.abs(frames) === 1 ? "frame" : "frames"}`;

async function apply(subject: SlipSubject) {
  const { offset, baseRevision, dir } = getSlip();
  const snapshot = getState().snapshot;
  if (subject.readOnly || offset === 0 || !snapshot) return slip.close();
  const sent = await actions.timelineEdit(planSlipBy(projectOf(snapshot), subject.item.id, offset), { baseRevision, dir });
  // Refused (the notice says why): the window stays where it was put, to try again or cancel.
  if (sent) slip.close();
}

function SlipModal({ subject, fps }: { subject: SlipSubject; fps: number }) {
  const offset = useSlip((s) => s.offset);
  const moved = useSlip((s) => s.past.length > 0 || s.offset !== 0);
  const start = windowStart(subject, offset);
  const { readOnly } = subject;
  const name = subject.item.name ?? subject.media.name;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") slip.close();
      else if (e.key === "Enter") void apply(subject);
      else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !readOnly) {
        // Held, the repeats are one step of ⌘Z.
        if (!e.repeat) slip.begin();
        slip.move(nudged(subject, getSlip().offset, e.key === "ArrowLeft" ? -1 : 1));
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onUp = (e: KeyboardEvent) => (e.key === "ArrowLeft" || e.key === "ArrowRight") && slip.end();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [subject, readOnly]);

  return (
    <div className="modal-layer" data-testid="slip-modal" onMouseDown={(e) => e.target === e.currentTarget && slip.close()}>
      <div className="modal slip-modal" role="dialog" aria-label={`Slip ${name}`}>
        <header className="slip-head">
          <span className="slip-title">
            Slip <b title={subject.media.path}>{name}</b>
          </span>
          <span className="slip-times" data-testid="slip-times">
            {frameTimecode(start, fps)} → {frameTimecode(start + subject.span, fps)}
            <span className="slip-delta" data-testid="slip-delta" data-offset={offset}>
              {offset === 0 ? "as on the timeline" : signed(offset)}
            </span>
          </span>
        </header>
        <SlipPicture subject={subject} start={start} fps={fps} />
        <SlipStrip subject={subject} offset={offset} start={start} fps={fps} />
        <footer className="slip-foot">
          {readOnly ? (
            <span className="slip-note" data-testid="slip-read-only">
              {readOnly}
            </span>
          ) : (
            <span className="slip-note">Drag the window, or click the strip to move it there. ← → move it a frame.</span>
          )}
          <button className="btn ghost" data-testid="slip-cancel" onClick={slip.close}>
            Cancel
          </button>
          <button className="btn primary" data-testid="slip-done" disabled={!!readOnly || (!moved && offset === 0)} onClick={() => void apply(subject)}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The window's first frame (a video's), or the sound's name and where it starts. */
function SlipPicture({ subject, start, fps }: { subject: SlipSubject; start: number; fps: number }) {
  const { media } = subject;
  const proxy = useSyncExternalStore(subscribeApp, () => proxyOf(getState(), media.id));
  const proxiesOn = useProxiesOn();
  const ref = useRef<HTMLVideoElement>(null);
  const want = useRef(0);
  want.current = (start + 0.5) / fps;
  const src = proxiesOn && proxy?.phase === "done" && proxy.key ? proxyUrl(media.id, proxy.key) : mediaUrl(media.id, media.path);
  // One seek at a time while it's dragged: the last asked-for frame wins.
  useEffect(() => {
    const el = ref.current;
    if (!el || media.kind !== "video") return;
    const seek = () => {
      if (el.readyState >= 1 && !el.seeking && Math.abs(el.currentTime - want.current) > 0.004) el.currentTime = want.current;
    };
    seek();
    el.addEventListener("loadedmetadata", seek);
    el.addEventListener("seeked", seek);
    return () => {
      el.removeEventListener("loadedmetadata", seek);
      el.removeEventListener("seeked", seek);
    };
  }, [media.kind, start, src]);
  if (media.kind !== "video") return null;
  return (
    <div className="slip-picture" data-testid="slip-picture">
      <video key={src} ref={ref} src={src} muted preload="auto" playsInline data-testid="slip-video" data-frame={start} />
    </div>
  );
}

function SlipStrip({ subject, offset, start, fps }: { subject: SlipSubject; offset: number; start: number; fps: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState<number | undefined>(undefined);
  const [scroll, setScroll] = useState(0);
  // A scroll to set once the strip is drawn at its new zoom.
  const pending = useRef<number | undefined>(undefined);
  const drag = useRef<{ grab: number } | undefined>(undefined);
  const { total, span, media, readOnly } = subject;
  const thumbs = useSyncExternalStore(subscribeApp, () => getState().thumbIds);
  const poster = thumbs.has(media.id) ? thumbUrl(media.id, media.path) : undefined;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Opens at 20× the window, centred on it.
  useLayoutEffect(() => {
    if (!width || visible !== undefined) return;
    const v = openVisible(subject, width);
    pending.current = centredScroll(subject, windowStart(subject, getSlip().offset), v, width);
    setVisible(v);
  }, [width, visible, subject]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || pending.current === undefined) return;
    el.scrollLeft = pending.current;
    pending.current = undefined;
    setScroll(el.scrollLeft);
  });

  const ppx = visible && width ? width / visible : 0;
  // The window keeps itself in view as it moves.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ppx) return;
    const next = keepInView(el.scrollLeft, start * ppx, (start + span) * ppx, width);
    if (Math.abs(next - el.scrollLeft) > 0.5) el.scrollLeft = next;
  }, [start, span, ppx, width]);

  const zoomTo = (next: number, frame: number, x: number) => {
    if (!width) return;
    const v = clampVisible(subject, next, width);
    pending.current = scrollFor(subject, frame, x, v, width);
    setVisible(v);
  };
  const zoomAroundWindow = (factor: number) => {
    if (!visible) return;
    const el = ref.current;
    const mid = start + span / 2;
    zoomTo(visible * factor, mid, el ? mid * ppx - el.scrollLeft : width / 2);
  };
  const fit = () => zoomTo(total, 0, 0);

  // A pinch (ctrl + wheel) or ⌘ + wheel zooms around the pointer; the page never zooms.
  const zoomRef = useRef({ visible, ppx });
  zoomRef.current = { visible, ppx };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { visible: v, ppx: p } = zoomRef.current;
      if (!v || !p) return;
      const x = e.clientX - el.getBoundingClientRect().left;
      const frame = (el.scrollLeft + x) / p;
      const factor = wheelZoom(1, e.deltaY, e.deltaMode);
      zoomTo(v / factor, frame, x);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const frameAt = (clientX: number) => {
    const el = ref.current;
    if (!el || !ppx) return 0;
    return (clientX - el.getBoundingClientRect().left + el.scrollLeft) / ppx;
  };
  const onPointerDown = (e: PointerEvent) => {
    if (readOnly || e.button !== 0 || !ppx) return;
    e.preventDefault();
    const p = pressOn(subject, getSlip().offset, frameAt(e.clientX));
    slip.begin();
    slip.move(p.offset);
    drag.current = { grab: p.grab };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag.current) return;
    slip.move(offsetFor(subject, frameAt(e.clientX) - drag.current.grab));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = undefined;
    slip.end();
  };

  const content = total * ppx;
  const sliceFrom = ppx ? scroll / ppx : 0;
  const sliceFrames = ppx ? Math.min(total - sliceFrom, width / ppx) : 0;
  const sound = media.kind === "audio" || media.probe?.hasAudio === true;
  return (
    <div className="slip-strip-wrap">
      <div
        ref={ref}
        className={`slip-strip ${media.kind === "audio" ? "audio" : ""} ${readOnly ? "read-only" : ""}`}
        data-testid="slip-strip"
        data-visible={visible}
        onScroll={(e) => setScroll(e.currentTarget.scrollLeft)}
      >
        {ppx > 0 && (
          <div
            className="slip-content"
            style={{ width: content }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {media.kind === "video" && (
              <div className="slip-film">
                <ClipFilmstrip
                  item={{ id: `slip-${media.id}`, type: "clip", media: media.id, in: 0, duration: total }}
                  media={media}
                  fps={fps}
                  duration={total}
                  ppf={ppx}
                  poster={poster}
                />
              </div>
            )}
            {sound && sliceFrames > 0 && (
              <div className={`slip-wave ${media.kind === "video" ? "under" : ""}`} style={{ left: scroll, width: sliceFrames * ppx }}>
                <ItemWaveform
                  item={{ id: `slip-${media.id}`, type: "audio", media: media.id, in: sliceFrom, duration: sliceFrames }}
                  media={media}
                  fps={fps}
                  width={Math.round(sliceFrames * ppx)}
                  compact={media.kind === "video"}
                />
              </div>
            )}
            {offset !== 0 && <div className="slip-was" style={{ left: subject.from * ppx, width: span * ppx }} title="Where it was" />}
            <div
              className="slip-window"
              data-testid="slip-window"
              data-start={start}
              data-offset={offset}
              style={{ left: start * ppx, width: Math.max(4, span * ppx) }}
            />
          </div>
        )}
      </div>
      <div className="slip-zoom">
        <Tooltip label="Zoom out">
          <button
            className="btn ghost"
            data-testid="slip-zoom-out"
            aria-label="Zoom out"
            onClick={() => zoomAroundWindow(1.6)}
            disabled={!visible || visible >= total}
          >
            <ZoomOut />
          </button>
        </Tooltip>
        <Tooltip label="Zoom in">
          <button className="btn ghost" data-testid="slip-zoom-in" aria-label="Zoom in" onClick={() => zoomAroundWindow(1 / 1.6)}>
            <ZoomIn />
          </button>
        </Tooltip>
        <Tooltip label="Show all of it">
          <button className="btn ghost" data-testid="slip-fit" onClick={fit} disabled={!visible || visible >= total}>
            <Maximize2 />
            Fit
          </button>
        </Tooltip>
        <span className="slip-length">{frameTimecode(total, fps)} in all</span>
      </div>
    </div>
  );
}
