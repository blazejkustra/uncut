import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

// ---- import from a link (D259, #94) ----
// Uncut never ships or downloads a downloader: it runs the user's own yt-dlp when there is one.

export const LINK_METHODS = {
  check: "link.check",
  start: "link.start",
  jobs: "link.jobs",
  cancel: "link.cancel",
} as const;

export const LinkKind = Schema.Literals(["video", "audio"]);
export type LinkKind = typeof LinkKind.Type;
/** The video's height cap ("best": none). Audio ignores it. */
export const LINK_QUALITIES = ["best", "2160", "1440", "1080", "720", "480"] as const;
export const LinkQuality = Schema.Literals(LINK_QUALITIES);
export type LinkQuality = typeof LinkQuality.Type;
export const DEFAULT_LINK_QUALITY: LinkQuality = "1080";

/** The server's yt-dlp: where it is and its version, or not found. */
export const LinkTool = Schema.Struct({
  found: Schema.Boolean,
  path: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
});
export type LinkTool = typeof LinkTool.Type;

export const LinkRequest = Schema.Struct({
  url: Schema.String,
  kind: LinkKind,
  quality: Schema.optional(LinkQuality),
  // Dropped on the timeline: it goes there too, in the import's own edit (like T9 file drops).
  drop: Schema.optional(Schema.Struct({ frame: Schema.Number, track: Schema.optional(Schema.String) })),
});
export type LinkRequest = typeof LinkRequest.Type;

export const LinkJob = Schema.Struct({
  id: Schema.String,
  projectDir: Schema.String,
  url: Schema.String,
  kind: LinkKind,
  quality: LinkQuality,
  phase: Schema.Literals(["running", "importing", "done", "failed", "cancelled"]),
  // 0–1 while downloading, when yt-dlp says.
  progress: Schema.optional(Schema.Number),
  // What it's doing, in words ("Downloading… 42%").
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  mediaId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  startedAt: Schema.String,
});
export type LinkJob = typeof LinkJob.Type;

export class LinkError extends Schema.TaggedError<LinkError>()("LinkError", {
  reason: Schema.Literals(["no-project", "no-tool", "bad-url", "failed"]),
  message: Schema.String,
}) {}

const Empty = Schema.Struct({});

// Looks for yt-dlp again (PATH, the login shell's PATH, the Homebrew folders).
export const LinkCheckRpc = Rpc.make(LINK_METHODS.check, { payload: Empty, success: LinkTool });
// Starts a download into the open project's media/links/ and returns its id; follow it on link.jobs.
export const LinkStartRpc = Rpc.make(LINK_METHODS.start, { payload: LinkRequest, success: Schema.Struct({ jobId: Schema.String }), error: LinkError });
export const LinkJobsRpc = Rpc.make(LINK_METHODS.jobs, { payload: Empty, success: Schema.Array(LinkJob), stream: true });
// Stops a download (yt-dlp and what it started); nothing is added and its partial files go.
export const LinkCancelRpc = Rpc.make(LINK_METHODS.cancel, { payload: Schema.Struct({ jobId: Schema.String }) });
