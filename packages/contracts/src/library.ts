import * as Schema from "effect/Schema";

// ---- sound library (D134) ----

export const LibraryHitSchema = Schema.Struct({
  source: Schema.Literals(["openverse", "freesound", "jamendo"]),
  id: Schema.String,
  title: Schema.String,
  creator: Schema.String,
  creatorUrl: Schema.optional(Schema.String),
  landingUrl: Schema.String,
  provider: Schema.optional(Schema.String),
  license: Schema.Literals(["cc0", "by"]),
  licenseVersion: Schema.String,
  licenseUrl: Schema.String,
  attribution: Schema.String,
  seconds: Schema.optional(Schema.Number),
  tags: Schema.Array(Schema.String),
  filetype: Schema.optional(Schema.String),
});

/** Why a search has no fresh results: the source's request limit (Openverse without an account: 20 a minute, 200 a day). */
export const LibraryLimit = Schema.Struct({
  scope: Schema.Literals(["minute", "day"]),
  // When searching works again (ISO 8601), as far as Uncut knows.
  until: Schema.String,
});
export type LibraryLimit = typeof LibraryLimit.Type;

export const LibrarySearchResult = Schema.Struct({
  hits: Schema.Array(LibraryHitSchema),
  total: Schema.Number,
  page: Schema.Number,
  pages: Schema.Number,
  source: Schema.Literals(["openverse", "freesound", "jamendo"]),
  // Answered from Uncut's cache of recent searches (no request went out).
  cached: Schema.Boolean,
  limit: Schema.optional(LibraryLimit),
  // Searches left before the source's limit, when it says (Openverse's headers).
  left: Schema.optional(Schema.Struct({ minute: Schema.optional(Schema.Number), day: Schema.optional(Schema.Number) })),
  // D208: what went online when it isn't the words typed (a meme name's search, or a variant tried
  // after nothing was found), and why (a clip nobody may give away: free sound-alikes).
  searched: Schema.optional(Schema.String),
  alias: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});
export type LibrarySearchResult = typeof LibrarySearchResult.Type;

export const LibraryState = Schema.Struct({
  // The sources that can search now: Openverse always, Freesound and Jamendo with the user's key or client ID.
  sources: Schema.Array(Schema.Literals(["openverse", "freesound", "jamendo"])),
  limit: Schema.optional(LibraryLimit),
});
export type LibraryState = typeof LibraryState.Type;

export class LibraryError extends Schema.TaggedError<LibraryError>()("LibraryError", {
  reason: Schema.Literals(["bad-request", "no-key", "network", "refused", "limit", "no-project", "io"]),
  message: Schema.String,
}) {}

// ---- the user's sound folders (D208) ----

export const FolderSoundSchema = Schema.Struct({ id: Schema.String, folder: Schema.String, name: Schema.String, rel: Schema.String, ext: Schema.String, bytes: Schema.Number });
export const SoundFolderSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  name: Schema.String,
  sounds: Schema.Array(FolderSoundSchema),
  missing: Schema.optional(Schema.Boolean),
  truncated: Schema.optional(Schema.Boolean),
  // D249: the Music app's library (DRM-free files only), listed like a folder.
  system: Schema.optional(Schema.Literals(["music"])),
  // Songs of that library left out: Apple Music (DRM or not downloaded) and other protected files.
  skipped: Schema.optional(Schema.Number),
});
export type SoundFolderInfo = typeof SoundFolderSchema.Type;
