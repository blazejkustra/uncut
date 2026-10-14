// The main track's cuts (D73, split out of Timeline.tsx): a cut point between two clips (click to
// select it) or the transition on it, a marker straddling the cut whose edges change its length.
// While a transition tile is dragged, each cut shows whether it fits and the nearest is the target.
import { transitionName, type Cut } from "@uncut/core/transitions";
import React from "react";

import { playback } from "../preview/playback.ts";
import { itemLabel, type ProjectModel } from "../state/project.ts";
import { planSetTransition, secondsLabel } from "./edit.ts";
import { transitionSeconds } from "./transitionLength.ts";

export function CutMarkers({
  view,
  cuts,
  ppf,
  fps,
  selectedCut,
  transitionDragged,
  dropCut,
  resizing,
  editable,
  onTransitionDown,
}: {
  view: ProjectModel;
  cuts: ReadonlyArray<Cut>;
  ppf: number;
  fps: number;
  selectedCut: string | undefined;
  transitionDragged: string | undefined;
  dropCut: string | undefined;
  /** The transition being resized (its clip's id) and whether it's refused. */
  resizing: { readonly id: string; readonly refused: boolean } | undefined;
  editable: boolean;
  onTransitionDown: (e: React.PointerEvent, itemId: string, cutFrame: number) => void;
}) {
  return (
    <>
      {cuts.map((cut) => {
        const tr = cut.item.transitionIn;
        const isSel = selectedCut === cut.item.id;
        // What a drop here would do: the planner's checks (locks on either clip, the cut's limits).
        const seconds = transitionSeconds();
        const fit = transitionDragged ? planSetTransition(view, cut.item.id, { module: transitionDragged, ...(seconds ? { duration: Math.round(seconds * fps) } : {}) }) : undefined;
        const dropState = fit ? ("problem" in fit ? "invalid" : "valid") : undefined;
        const target = transitionDragged && dropCut === cut.item.id;
        // F16 (D154): the transition as it would land, straddling the cut, at the length it would get.
        const landing = target && fit && !("problem" in fit) ? (fit.ops[0] as { transition?: { duration: number } } | undefined)?.transition?.duration ?? cut.item.transitionIn?.duration : undefined;
        const ghost =
          landing !== undefined ? (
            <div key={`ghost-${cut.item.id}`} className="tr-ghost" data-testid="transition-drop-ghost" data-item={cut.item.id} data-duration={landing} style={{ left: cut.frame * ppf - Math.max(landing * ppf, 14) / 2, width: Math.max(landing * ppf, 14) }} />
          ) : null;
        if (!tr) {
          return [
            ghost,
            <div
              key={`cut-${cut.item.id}`}
              className={`cut-point ${isSel ? "selected" : ""} ${dropState ?? ""} ${target ? "target" : ""}`}
              data-testid="cut-point"
              data-item={cut.item.id}
              data-frame={cut.frame}
              data-drop={dropState}
              title={fit && "problem" in fit ? fit.problem : `Cut between ${itemLabel(view, cut.prev)} and ${itemLabel(view, cut.item)}`}
              style={{ left: cut.frame * ppf }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                playback.selectCut(cut.item.id);
              }}
            />,
          ];
        }
        const w = tr.duration * ppf;
        const state = resizing?.id === cut.item.id ? (resizing.refused ? "refused" : "resizing") : "";
        return [
          ghost,
          <div
            key={`tr-${cut.item.id}`}
            className={`tr-marker ${isSel ? "selected" : ""} ${dropState ?? ""} ${target ? "target" : ""} ${state}`}
            data-testid="transition-marker"
            data-item={cut.item.id}
            data-module={tr.module}
            data-duration={tr.duration}
            data-frame={cut.frame}
            title={`${transitionName(tr.module)}, ${secondsLabel(tr.duration, fps)} (${tr.duration} frames)`}
            style={{ left: cut.frame * ppf - Math.max(w, 14) / 2, width: Math.max(w, 14) }}
            onPointerDown={(e) => onTransitionDown(e, cut.item.id, cut.frame)}
          >
            <span className="tr-x" />
            {editable && (
              <>
                <div className="tr-edge start" data-tr-edge="start" data-testid="transition-edge-start" />
                <div className="tr-edge end" data-tr-edge="end" data-testid="transition-edge-end" />
              </>
            )}
          </div>,
        ];
      })}
    </>
  );
}
