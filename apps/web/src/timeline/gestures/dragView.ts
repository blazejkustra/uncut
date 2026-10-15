import type { NewTrackSide } from "../edit.ts";
import { getPlayback } from "../../preview/playback.ts";
import type { ProjectModel } from "../../state/project.ts";

export const HEAD_WIDTH = 184;

/** What the lanes draw while an item is dragged: the planned result, before it is sent. */
export interface DragView {
  readonly itemId: string;
  readonly mode: "move" | "start" | "end" | "fade" | "transition" | "group";
  /** The project with the planned ops applied (or as it is, when they would be refused). */
  readonly view: ProjectModel;
  /** Drawn at this start and length instead of where the view puts it (a main clip's left trim). */
  readonly ghost?: { readonly start: number; readonly duration: number };
  /** A move: the item under the pointer, on this track. Its planned spot shows as the landing. */
  readonly float?: { readonly track: string; readonly start: number };
  /** A move past the top or bottom lane, or onto a lane that can't take it (F6): a new track appears there (y: the line, px in the lanes). */
  readonly newTrack?: { readonly side: NewTrackSide | "between"; readonly y: number };
  /** A group move: the items moving. */
  readonly group?: ReadonlyArray<string>;
  readonly snapAt?: number;
  /** The frame the tip points at, and what it says (the length while trimming, the start or slot while moving). */
  readonly tipAt: number;
  readonly tip: string;
  /** Why it can't be dropped here (the server would refuse it); releasing sends nothing. */
  readonly refused?: string;
}

/** A marquee in lane coordinates (px from the lanes' top-left). */
export interface Marquee {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export const selectionIds = () => {
  const { selected, also } = getPlayback();
  return selected === undefined ? [] : [selected, ...also];
};
