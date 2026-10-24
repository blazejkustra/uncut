import * as Schema from "effect/Schema";

// ---- capture (D98) ----

/** A device a capture source can see (Argent: simulators, emulators, Chromium apps). */
export const CaptureDevice = Schema.Struct({
  id: Schema.String,
  platform: Schema.String,
  name: Schema.String,
  state: Schema.String,
  recordable: Schema.Boolean,
  // Why it can't be recorded (yet), in a few words.
  reason: Schema.optional(Schema.String),
  // D143: off now, but Argent can boot it on the user's click (a shut-down simulator, an AVD).
  bootable: Schema.optional(Schema.Boolean),
});
export type CaptureDevice = typeof CaptureDevice.Type;

/**
 * The Capture tab's Argent section: whether Argent is there (else the command that installs it),
 * its devices, and the recordings running now (device id, ISO start).
 */
export const CaptureState = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.optional(Schema.String),
  install: Schema.String,
  problem: Schema.optional(Schema.String),
  devices: Schema.Array(CaptureDevice),
  recording: Schema.Array(Schema.Struct({ device: Schema.String, startedAt: Schema.String, flow: Schema.optional(Schema.String) })),
  // D143: the open project's saved flows (flows/<name>.yaml), by name.
  flows: Schema.optional(Schema.Array(Schema.String)),
});
export type CaptureState = typeof CaptureState.Type;

/** D114: what a take recorded on this Mac is (the microphone's voiceover, a camera, a screen or window; D210: this Mac's sound). */
export const TakeKind = Schema.Literals(["voiceover", "camera", "screen", "system"]);
export type TakeKind = typeof TakeKind.Type;

/**
 * D114: the name a take's recording is uploaded under (media/uploads/uncut-take-voiceover-1a2b3c4d5e6f.webm;
 * the server may add " 2"). capture.save only takes files named like this, so a file the user
 * uploaded (D108) is never converted or removed by it.
 */
export const takeUploadName = (kind: TakeKind, ext: "webm" | "mp4") =>
  `uncut-take-${kind}-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("")}.${ext}`;
export const TAKE_UPLOAD_NAME = /^uncut-take-(voiceover|camera|screen|system)-[0-9a-f]{12}(?: \d+)?\.(?:webm|mp4)$/;

/** D211: where a multi-source take's camera goes over its screen: a corner bubble or side by side. */
export const MultiLayout = Schema.Literals(["tl", "tr", "bl", "br", "side"]);
export type MultiLayout = typeof MultiLayout.Type;

/** D211: one source of a multi-source take: its upload, what it is, and when its recorder started after the first one's (ms). */
export const MultiPart = Schema.Struct({
  path: Schema.String,
  kind: TakeKind,
  device: Schema.optional(Schema.String),
  offsetMs: Schema.Number,
  recordedMs: Schema.optional(Schema.Number),
});
export type MultiPart = typeof MultiPart.Type;

/** D143: how the Capture tab records a device: what to do first, and Argent's own options. */
export const CaptureOrientation = Schema.Literals(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"]);
export type CaptureOrientation = typeof CaptureOrientation.Type;
export const CaptureOptions = Schema.Struct({
  showTouches: Schema.optional(Schema.Boolean),
  // Cut the parts where the screen doesn't change (Argent's trimStatic).
  trimStatic: Schema.optional(Schema.Boolean),
  // Argent stops the take by itself after this long (1 to 600 s).
  maxSeconds: Schema.optional(Schema.Number),
  orientation: Schema.optional(CaptureOrientation),
  // Opened on the device before the take.
  bundleId: Schema.optional(Schema.String),
});
export type CaptureOptions = typeof CaptureOptions.Type;

export class CaptureError extends Schema.TaggedError<CaptureError>()("CaptureError", {
  reason: Schema.Literals(["no-project", "unavailable", "failed"]),
  message: Schema.String,
}) {}
