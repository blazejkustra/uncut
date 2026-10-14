// The Transitions tab (D73, D133): every transition the preview and export draw (core TRANSITIONS),
// each a tile with an animated thumbnail drawn by the same core maths as the preview (incomingFx /
// outgoingFx, the iris radius, the mask outlines), a search, kind filters and the length new ones
// get. Drag a tile onto a cut between two main-track clips; or select a cut and click the tile; or
// + puts it on the cut nearest the playhead.
import { defaultFrames, incomingFx, irisRadius, maskClipPath, outgoingFx, TRANSITIONS, type TransitionFx, type TransitionInfo, type TransitionKind } from "@uncut/core/transitions";
import { Plus, X } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { actions, useApp, type Project } from "../state/store.ts";
import { setDraggedTransition, TRANSITION_DRAG_TYPE } from "../timeline/dnd.ts";
import { secondsLabel } from "../timeline/edit.ts";
import { setTransitionSeconds, TRANSITION_LENGTHS, useTransitionSeconds } from "../timeline/transitionLength.ts";

/** The thumbnail's own canvas (px): the shapes are drawn on it, then it's scaled into the tile. */
const THUMB = { width: 160, height: 90 } as const;
/** One loop: A held, the transition, B held (ms). */
const HOLD = 500;
const RUN = 1300;
const LOOP = 2 * HOLD + RUN;

const KINDS: ReadonlyArray<{ readonly id: TransitionKind | undefined; readonly name: string }> = [
  { id: undefined, name: "All" },
  { id: "fade", name: "Fades" },
  { id: "reveal", name: "Reveals" },
  { id: "move", name: "Moves" },
  { id: "dip", name: "Dips" },
];

// One clock for every tile, so 28 thumbnails share one animation frame.
const ticks = new Set<(now: number) => void>();
let raf = 0;
const loop = (now: number) => {
  for (const tick of ticks) tick(now);
  raf = ticks.size ? requestAnimationFrame(loop) : 0;
};
function onTick(tick: (now: number) => void) {
  ticks.add(tick);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => void ticks.delete(tick);
}

const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;
/** The style a clip gets from core's TransitionFx, as the preview applies it (transform about its centre, clip-path, blur). */
function styleOf(el: HTMLElement, fx: TransitionFx | undefined) {
  if (!fx) {
    el.style.visibility = "hidden";
    return;
  }
  el.style.visibility = "";
  el.style.opacity = String(fx.opacity);
  el.style.translate = fx.shift || fx.shiftY ? `${px(fx.shift ?? 0)} ${px(fx.shiftY ?? 0)}` : "";
  el.style.scale = fx.zoom !== undefined && fx.zoom !== 1 ? String(fx.zoom) : "";
  el.style.filter = fx.blur ? `blur(${px(fx.blur)})` : "";
  el.style.clipPath =
    fx.wipe !== undefined
      ? `inset(0 ${px((1 - fx.wipe) * THUMB.width)} 0 0)`
      : fx.iris !== undefined
        ? `circle(${px(irisRadius(fx.iris, THUMB))} at ${px(THUMB.width / 2)} ${px(THUMB.height / 2)})`
        : fx.mask
          ? maskClipPath(fx.mask.shape, fx.mask.p, THUMB)
          : "";
}

/**
 * Draws a transition at time `ms` of its loop on the thumbnail's two shots and colour layer: A, then
 * the transition at share p (linear, as core draws it), then B.
 */
function drawAt(t: TransitionInfo, ms: number, a: HTMLElement, b: HTMLElement, k: HTMLElement) {
  const at = ms % LOOP;
  const p = Math.min(1, Math.max(0, (at - HOLD) / RUN));
  const running = p > 0 && p < 1;
  if (!t.overlaps) {
    // A dip: A over the first half, B over the second, the colour layer up to the cut and back.
    styleOf(a, p < 0.5 ? { opacity: 1 } : undefined);
    styleOf(b, p >= 0.5 ? { opacity: 1 } : undefined);
  } else {
    styleOf(a, p < 1 ? (running ? outgoingFx(t.id, p, THUMB) : { opacity: 1 }) : undefined);
    styleOf(b, p > 0 ? (running ? incomingFx(t.id, p, THUMB) : { opacity: 1 }) : undefined);
  }
  k.style.background = t.color ?? "transparent";
  k.style.opacity = t.color && running ? String(1 - Math.abs(2 * p - 1)) : "0";
}

/** A tile's animated preview (D133): looping while the panel is open, a still mid-transition with reduced motion. */
function TransitionThumb({ t }: { t: TransitionInfo }) {
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const a = useRef<HTMLSpanElement>(null);
  const b = useRef<HTMLSpanElement>(null);
  const k = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      if (stage.current) stage.current.style.scale = String(el.clientWidth / THUMB.width || 1);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const draw = (ms: number) => a.current && b.current && k.current && drawAt(t, ms, a.current, b.current, k.current);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The still: the middle of the transition (a dip's colour at its fullest).
    draw(HOLD + RUN * (t.overlaps ? 0.5 : 0.45));
    if (still) return;
    const start = performance.now();
    return onTick((now) => draw(now - start));
  }, [t]);
  return (
    <div className="thumb tr-thumb" ref={box} data-testid="transition-thumb">
      <div className="tr-stage" ref={stage} style={{ width: THUMB.width, height: THUMB.height }}>
        {/* Two shots, A then B, and the colour of a dip or flash over them. */}
        <span className="tr-a" ref={a} aria-hidden="true">
          <i />
        </span>
        <span className="tr-b" ref={b} aria-hidden="true">
          <i />
        </span>
        <span className="tr-k" ref={k} aria-hidden="true" />
      </div>
    </div>
  );
}

/** The transitions matching a search (name or description words) and a kind. */
export function filterTransitions(query: string, kind: TransitionKind | undefined): Array<TransitionInfo> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return TRANSITIONS.filter((t) => (!kind || t.kind === kind) && words.every((w) => `${t.name} ${t.description}`.toLowerCase().includes(w)));
}

export function TransitionsLibrary({ project }: { project: Project }) {
  const { connection } = useApp();
  const online = connection === "connected";
  const fps = project.canvas.fps;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<TransitionKind | undefined>();
  const seconds = useTransitionSeconds();
  const shown = filterTransitions(query, kind);
  const apply = (t: TransitionInfo, e: React.MouseEvent, nearest: boolean) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).blur();
    if (online) void actions.applyTransition(t.id, { nearest });
  };
  /** The length a tile puts on a cut: the chosen one for all (within its limits), else its own default. */
  const lengthOf = (t: TransitionInfo) => (seconds ? Math.min(t.maxFrames, Math.max(t.minFrames, Math.round(seconds * fps))) : defaultFrames(t, fps));
  return (
    <aside className="library" data-testid="transitions-library">
      <div className="lib-head">Transitions</div>
      <div className="lib-section">
        <div className="music-filters">
          <div className="tr-search">
            <input className="field input" data-testid="transition-search" placeholder="Search transitions" value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
            {query && (
              <button className="icon-btn" data-testid="transition-search-clear" title="Clear" onClick={() => setQuery("")}>
                <X />
              </button>
            )}
          </div>
          <div className="music-chips" data-testid="transition-kinds">
            {KINDS.map((k) => (
              <button key={k.name} className={`music-chip${kind === k.id ? " active" : ""}`} data-testid="transition-kind" data-kind={k.id ?? "all"} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>
                {k.name}
              </button>
            ))}
          </div>
          <div className="tr-length" data-testid="transition-lengths">
            <span className="muted small">Length</span>
            {TRANSITION_LENGTHS.map((s) => (
              <button key={String(s)} className={`music-chip${seconds === s ? " active" : ""}`} data-testid="transition-length" data-seconds={s ?? "default"} aria-pressed={seconds === s} onClick={() => setTransitionSeconds(s)}>
                {s === undefined ? "Default" : `${s} s`}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 && (
          <div className="muted small" data-testid="transition-empty">
            No transition matches
          </div>
        )}
        <div className="grid2">
          {shown.map((t) => (
            <div
              key={t.id}
              className="tile tr-tile"
              data-testid="transition-tile"
              data-module={t.id}
              role="button"
              tabIndex={0}
              aria-disabled={!online}
              draggable={online}
              title={`${t.name}: ${t.description}`}
              onDragStart={(e) => {
                e.dataTransfer.setData(TRANSITION_DRAG_TYPE, t.id);
                e.dataTransfer.effectAllowed = "copy";
                setDraggedTransition(t.id);
              }}
              onDragEnd={() => setDraggedTransition(undefined)}
              onClick={(e) => apply(t, e, false)}
              onKeyDown={(e) => {
                // Keys on the + belong to it (its click), not to the tile as well.
                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                e.preventDefault();
                if (online) void actions.applyTransition(t.id);
              }}
            >
              <div className="tr-thumb-wrap">
                <TransitionThumb t={t} />
                <button className="tile-add" data-testid="transition-add" disabled={!online} title={`Put a ${t.name.toLowerCase()} on the cut nearest the playhead`} onClick={(e) => apply(t, e, true)}>
                  <Plus />
                </button>
              </div>
              <div className="tile-name">{t.name}</div>
              <div className="tile-sub" data-testid="transition-default">
                {secondsLabel(lengthOf(t), fps)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
