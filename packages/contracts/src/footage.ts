import * as Schema from "effect/Schema";

export const FOOTAGE_THUMB_PATH = "/media/footage-thumb"; // GET /media/footage-thumb/<fingerprint>/<second>?token=…

/** A moment of a clip that matches a search: spoken words, or a stored description of what's on screen. */
export const FootageHit = Schema.Struct({
  id: Schema.String,
  fingerprint: Schema.String,
  source: Schema.Literals(["speech", "visual"]),
  path: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["video", "image", "audio"]),
  project: Schema.Struct({ dir: Schema.String, name: Schema.String }),
  // The clip's media id when it's in the open project; without it the hit has to be imported first.
  media: Schema.optional(Schema.String),
  // Its media index entry, for media.recentImport.
  recent: Schema.String,
  // Seconds of the file.
  start: Schema.Number,
  end: Schema.Number,
  before: Schema.String,
  match: Schema.String,
  after: Schema.String,
});
export type FootageHit = typeof FootageHit.Type;

/** The footage index for the open project, and what it's doing. */
export const FootageStatus = Schema.Struct({
  phase: Schema.Literals(["idle", "running"]),
  clips: Schema.Number,
  indexed: Schema.Number,
  failed: Schema.Number,
  // Clips indexed in every project on this Mac.
  everywhere: Schema.Number,
  progress: Schema.Number,
  current: Schema.optional(Schema.String),
  waiting: Schema.optional(Schema.Literals(["export", "model"])),
  error: Schema.optional(Schema.String),
  // Bumped whenever what a search finds may have changed.
  revision: Schema.Number,
});
export type FootageStatus = typeof FootageStatus.Type;
