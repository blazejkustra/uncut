import * as Schema from "effect/Schema";

// ---- media ----

export const THUMB_PATH = "/media/thumb"; // GET /media/thumb/<media id>?token=…
/** D205: a poster from the user's media index (another project's take), by index entry id. */
export const RECENT_THUMB_PATH = "/media/recent-thumb"; // GET /media/recent-thumb/<entry id>?token=…

/**
 * D205: a capture, import or generation from any project on this Mac, from the user-level media
 * index (<data dir>/media-index.json): where it is, what it is, which project it came from.
 */
export const MediaRecentEntry = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["video", "image", "audio"]),
  origin: Schema.Literals(["capture", "import", "generated"]),
  seconds: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  project: Schema.Struct({ dir: Schema.String, name: Schema.String }),
  device: Schema.optional(Schema.String),
  app: Schema.optional(Schema.String),
  created: Schema.String,
  thumb: Schema.optional(Schema.Boolean),
  // Importing it copies the file into this project's media/ (it lives inside another project's folder), else references it (D12).
  copies: Schema.optional(Schema.Boolean),
});
export type MediaRecentEntry = typeof MediaRecentEntry.Type;
// GET /media/file/<media id>?token=…: the original file of a media item of the open project, with
// HTTP Range support (the preview's <video> seeks with it). Footage is streamed, never copied.
export const MEDIA_FILE_PATH = "/media/file";
// D212: GET /media/proxy/<media id>?token=…: the preview proxy of a media item of the open project
// (<project>/.cache/proxies/), with Range support like MEDIA_FILE_PATH; 404 until it is made.
export const PROXY_PATH = "/media/proxy";

/**
 * D212: a media item's preview proxy: queued (waiting for an export when `waiting`), running with
 * progress 0–1, done (served at PROXY_PATH; `key` tags the file it was made from) or failed.
 * Media that needs none has no state.
 */
export const ProxyState = Schema.Struct({
  mediaId: Schema.String,
  phase: Schema.Literals(["queued", "running", "done", "failed"]),
  key: Schema.optional(Schema.String),
  progress: Schema.optional(Schema.Number),
  waiting: Schema.optional(Schema.Literals(["export"])),
  error: Schema.optional(Schema.String),
});
export type ProxyState = typeof ProxyState.Type;
// GET /media/waveform/<media id>?token=…: the sound's peaks for the timeline, as JSON
// { version, rate, seconds, peaks } where peaks is base64 of one byte per 1/rate s (the loudest
// sample in it, 0–255 for 0–full scale). Made once per file and cached in the project's .cache/.
export const WAVEFORM_PATH = "/media/waveform";
// GET /media/filmstrip/<media id>?token=…: a video's filmstrip for the timeline (issue #53), one
// JPEG sprite of frames taken every `interval` s from 0, FILMSTRIP_TILE_H px high, laid out
// `cols` to a row; the layout is in the x-uncut-filmstrip-layout header (FilmstripLayout as JSON).
// Made once per file (from its proxy when there is one) and cached in the project's .cache/.
export const FILMSTRIP_PATH = "/media/filmstrip";
/** The height of a filmstrip tile (px): twice a timeline lane's picture, for Retina. */
export const FILMSTRIP_TILE_H = 64;
/** Where the tiles of a filmstrip sprite are: tile n (time n × interval) is at column n % cols, row ⌊n / cols⌋. */
export interface FilmstripLayout {
  readonly version: 1;
  /** Seconds between tiles. */
  readonly interval: number;
  /** Tiles that hold a frame (the rest of the last row is padding). */
  readonly count: number;
  readonly cols: number;
  readonly rows: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** The media's length (s) the strip was made for. */
  readonly seconds: number;
}
// GET /media/graphic/<file name>?token=…: a graphic item's document (D78) for the preview's
// sandboxed iframe: the open project's graphics/<file name>, only if one of its graphic items uses
// it, wrapped by core graphicDocument and served with its strict CSP (inline script, no network).
export const GRAPHIC_PATH = "/media/graphic";
// GET /media/graphic-media/<media id>?t=&w=&h=&token=… (D290): a picture of the open project's media
// for a graphic in the preview (its iframe asks the editor, which fetches it here): the frame on the
// media's own grid at t seconds, as the export's rasteriser gets it. The server token, as any route.
export const GRAPHIC_MEDIA_PATH = "/media/graphic-media";
// GET /media/agent-image/<file name>?token=…: an image the user attached to an agent message (U4,
// D184), kept in the open project's .cache/agent-images/ for the turn card's thumbnails.
export const AGENT_IMAGE_PATH = "/media/agent-image";
// GET /media/brand/<kit id>/<file name>?token=…: a file of a brand kit the open project sees
// (D198): logo thumbnails in the Brand tab and the kit's font files for the preview.
export const BRAND_FILE_PATH = "/media/brand";
/** An attached image's file name in .cache/agent-images/: <turn id>-<n>.<ext>. */
// D295: a storyboard still is <turn>-s<proposal>-<n>.jpg.
export const AGENT_IMAGE_NAME = /^turn-[a-z0-9]+-[a-f0-9]{6}-(\d|s\d{1,2}-\d)\.(png|jpg|gif|webp)$/;
// GET /media/sfx/<file>?token=…: a sound of the bundled sound-effects pack (D134), for the Sound
// effects tab's preview; only the files core SFX_SOUNDS lists.
export const SFX_FILE_PATH = "/media/sfx";
// GET /library/preview/<source>/<id>?token=…: an online library hit's preview (D134), streamed
// through the server from the URL its search gave (only hits of a recent search), never saved.
export const LIBRARY_PREVIEW_PATH = "/library/preview";
// GET /library/folder/<sound id>?token=…: a file of one of the user's sound folders (D208), for the
// Folders view's preview; only files the folder's index lists, inside the folder.
export const LIBRARY_FOLDER_PATH = "/library/folder";
export interface Waveform {
  readonly version: 1;
  /** Peaks per second. */
  readonly rate: number;
  readonly seconds: number;
  readonly peaks: string;
}

/** What an import did, file by file. The project change itself arrives as a snapshot. */
export const MediaImportResult = Schema.Struct({
  imported: Schema.Array(Schema.Struct({ path: Schema.String, id: Schema.String, name: Schema.String, via: Schema.String })),
  /** D105: .srt / .vtt files read into a Subtitles text track (no media is added for them). */
  subtitles: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String, track: Schema.String, cues: Schema.Number }))),
  skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  failed: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
});
export type MediaImportResult = typeof MediaImportResult.Type;

/**
 * An import runs as a job on the server: it isn't tied to the request that started it, so a
 * slow batch or a dropped connection can't cancel it halfway. Jobs run one at a time.
 */
export const ImportJob = Schema.Struct({
  id: Schema.String,
  projectDir: Schema.String,
  total: Schema.Number,
  phase: Schema.Literals(["queued", "probing", "adding", "posters", "done", "failed"]),
  probed: Schema.Number,
  postersDone: Schema.Number,
  postersTotal: Schema.Number,
  result: Schema.optional(MediaImportResult),
  error: Schema.optional(Schema.String),
  // Started by the agent's media_import (D65): the agent reports skips and failures itself.
  agent: Schema.optional(Schema.Boolean),
});
export type ImportJob = typeof ImportJob.Type;

// ---- setup (onboarding) ----

export const SetupStatus = Schema.Literals(["ready", "missing", "needs-login", "warning", "error"]);
export type SetupStatus = typeof SetupStatus.Type;

/** One thing Uncut looked for on this Mac. `fix` says what to do, with a command to copy when there is one. */
export const SetupCheck = Schema.Struct({
  id: Schema.String, // "claude" | "codex" | "argent" | "ffmpeg" | "whisper" | "api-key"
  name: Schema.String,
  status: SetupStatus,
  optional: Schema.Boolean,
  version: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  detail: Schema.String,
  fix: Schema.optional(Schema.Struct({ text: Schema.String, command: Schema.optional(Schema.String) })),
});
export type SetupCheck = typeof SetupCheck.Type;
