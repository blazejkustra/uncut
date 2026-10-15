// Arranging media on the timeline (feedback round 1: D122 tracks, D123 detach audio, D124 audio
// tracks, D125 speed). Pure planners shared by the renderer (drops, "Add to timeline", the context
// menu), the server (a Finder drop imports and places in one edit) and the agent's convenience ops.
// Browser-safe.
//
// D122, what "main" means: the main track is the magnetic spine (back to back, ripple, transitions).
// Every other video track is an overlay with free starts, drawn over the tracks below it (track
// order is the stacking order); clips there never ripple and carry no transitions. D215: Main takes
// any picture (text too), a take goes on it with its parts linked (planPutOnMain), and transcripts
// and captions work on any item (transcript.ts, captions.ts).
export { IMAGE_SECONDS, takenIds, busySpans, isFree, nearestFreeSpot, mainSlot, itemTypeFor, placedLength, freeAudioTrack, planPlaceMedia, tryOps } from "./arrange/place.ts";
export type { PlaceMedia, PlacedItem, PlaceMediaPlan } from "./arrange/place.ts";
export { planDetachAudio, SPEED_PRESETS, SPEED_RANGE, speedLabel, planSetSpeed, withLinkedAudio } from "./arrange/retime.ts";
export type { DetachAudioPlan } from "./arrange/retime.ts";
export { planPutOnMain } from "./arrange/putOnMain.ts";
export type { PutOnMainPlan } from "./arrange/putOnMain.ts";
