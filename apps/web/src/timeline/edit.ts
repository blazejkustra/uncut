// Manual timeline editing (phase 4 chunk 3, D52): pure planners that turn a gesture into edit ops.
// The timeline previews a drag by applying the planned ops locally with @uncut/core's engine (no
// server round trip per mouse move) and sends one project.edit when the mouse is released, so
// every action is validated by the server, undoes in one step and reaches the agent's note (D6).
import { nearestFreeSpot } from "@uncut/core/arrange";

export { SNAP_PX, findItem, homeKind, fitsTrack, lockOf, secondsLabel, draftOf, withGroups } from "./edit/base.ts";
export type { Placed, Plan } from "./edit/base.ts";
export { MIN_BEAT_PX, beatsInItem, visibleBeats, beatTargets, snapPlayhead, snapTargets, trimSnapTargets } from "./edit/snap.ts";
export type { BeatMap, BeatSnap, Snap } from "./edit/snap.ts";
export { planMove, planMoveToNewTrack, newTrackIndexOver, planGroupMove, planLayer } from "./edit/move.ts";
export type { MovePlan, NewTrackSide, GroupMovePlan } from "./edit/move.ts";
export { planRippleDelete, planTrim, planSplit, planDelete, planGroupTrim } from "./edit/trim.ts";
export type { TrimPlan, SplitPlan } from "./edit/trim.ts";
export { mainCuts, nearestCut, planSetTransition, trackFlag, planTrackFlag, cutFit } from "./edit/transitions.ts";
export type { TrackFlag, CutFit } from "./edit/transitions.ts";
export { withOverlayRipple, planGrouping } from "./edit/ripple.ts";

export { nearestFreeSpot };
