// Recording on this Mac (D114): the Capture tab's microphone, camera and screen. The page records
// with MediaRecorder (webm), sends the file to the active server (store saveTake: /api/upload,
// then capture.save converts and imports it in one edit) and says how it went. One take at a time.
//
// Permissions come from the desktop shell (macOS's answer; tests get theirs from the test). The
// level meter and the camera preview run only while their part of the tab is open. A take under a
// second is discarded. A voiceover can play the timeline from the playhead while it records (the
// preview muted, so the microphone doesn't pick it up) and lands on a Voiceover track there.
//
// D210: this Mac's sound (getDisplayMedia's loopback audio through the desktop shell; tests use a
// tone drawn here) alone, or with the microphone or the screen. D211: a take of more than one
// source (screen, camera, microphone, this Mac's sound) records each with its own MediaRecorder,
// all started in the same tick once their devices are open (D267, D273: no 3-2-1, on the Capture
// tab or for the agent's take); each recorder's start event is measured on the
// page's clock and the parts' offsets go to the server, which trims the earlier ones so every part
// starts together on the timeline. Each part is its own file (capture.saveMulti).
import type { MultiLayout } from "@uncut/contracts";

export { PEAK_HOLD_MS, levelDb, MIN_TAKE_MS, useRecorder, getRecorder } from "./recorder/state.ts";
export type { TakeMode, PartKind, Resolution, Input, RecorderState } from "./recorder/state.ts";
export {
  refreshAccess,
  askAccess,
  openPrivacySettings,
  refreshSystemAudio,
  loadInputs,
  openMonitor,
  closeMonitor,
  openPreview,
  closePreview,
  loadSources,
} from "./recorder/devices.ts";
export { NO_SYSTEM_SOUND } from "./recorder/streams.ts";
export { isMulti, startTake, stopTake, pauseTake, resumeTake, takeSeconds, cancelTake, clock, closeAll } from "./recorder/take.ts";
export type { TakeOptions } from "./recorder/take.ts";
export type { MultiLayout };
