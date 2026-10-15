// The MediaLibrary service: its shape and the import, replace and drop inputs it takes.
import { ProjectError, type ImportJob, type ProjectSnapshot } from "@uncut/contracts";
import type { Overrun } from "@uncut/core";
import type { TakePlacement, MultiKind, MultiLayoutName, PlacedMulti } from "@uncut/core/place";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface MediaLibraryShape {
  /** Queue an import into the open project; returns the job id at once. */
  /** `drop` (T9, D128): also put the files on the timeline at that frame / track, in the same edit (core planPlaceMedia). */
  readonly startImport: (paths: ReadonlyArray<string>, drop?: MediaDrop) => Effect.Effect<{ jobId: string }, ProjectError>;
  readonly jobs: Stream.Stream<ReadonlyArray<ImportJob>>;
  /** Media ids of the open project whose current poster exists. */
  readonly thumbnails: Effect.Effect<ReadonlyArray<string>>;
  /** The poster file for a media id of the open project, if it exists. */
  readonly posterFor: (id: string) => Effect.Effect<string | undefined>;
  /**
   * The agent's media_import (D65): an import job like the Library's, but its edit is the agent's
   * (tagged with the turn, so Undo turn removes it and the manual-edit note doesn't list it).
   * Resolves once the media is in the project; posters carry on in the background.
   */
  readonly importForAgent: (input: AgentImportInput) => Effect.Effect<AgentImport, ProjectError>;
  /**
   * A recording a capture plugin made (D98): imported like media_import, with its `source`, stored
   * relative to the project when it's inside it (media/captures/...). The agent's (turnId) or,
   * without one, the user's edit (the Capture tab: one ⌘Z removes it).
   */
  readonly importCapture: (input: CaptureImportInput) => Effect.Effect<AgentImport, ProjectError>;
  /** D211: a multi-source take's files as one edit, placed start-aligned and grouped when `frame` is given. */
  readonly importMulti: (input: MultiImportInput) => Effect.Effect<AgentImport, ProjectError>;
  /**
   * A re-shot recording swapped in for media `mediaId` (D98): probed, then one edit that changes
   * the media's file and trims or holds clips past the new end (core planReshoot); a new poster.
   */
  readonly replaceMedia: (input: ReplaceMediaInput) => Effect.Effect<ReplacedMedia, ProjectError>;
}

/** Files dropped on the timeline (T9, D128): where they go. */
export interface MediaDrop {
  readonly frame: number;
  readonly track?: string | undefined;
}

export interface CaptureImportInput {
  readonly openId: number;
  readonly dir: string;
  readonly path: string;
  readonly name?: string | undefined;
  readonly source: { readonly module: string; readonly [key: string]: unknown };
  readonly turnId?: string | undefined;
  /** D114: also put it on the timeline at this frame, in the same edit (core planPlaceTake). */
  readonly place?: { readonly frame: number; readonly placement: TakePlacement } | undefined;
}

/** D211: a multi-source take's files, imported (and with `frame`, placed) as one edit. */
export interface MultiImportInput {
  readonly openId: number;
  readonly dir: string;
  readonly parts: ReadonlyArray<{ readonly path: string; readonly name: string; readonly kind: MultiKind; readonly offsetMs: number; readonly source: { readonly module: string; readonly [key: string]: unknown } }>;
  readonly frame?: number | undefined;
  readonly layout?: MultiLayoutName | undefined;
  readonly summary: string;
}

export interface ReplaceMediaInput {
  readonly openId: number;
  readonly dir: string;
  readonly mediaId: string;
  readonly path: string;
  readonly source?: { readonly module: string; readonly [key: string]: unknown } | undefined;
  readonly overrun?: Overrun | undefined;
  readonly turnId?: string | undefined;
}

export interface ReplacedMedia {
  readonly snapshot: ProjectSnapshot | undefined;
  readonly entry: MediaEntry;
  /** The file it had before. */
  readonly previousPath: string;
  readonly warnings: ReadonlyArray<string>;
  /** The edit's ops (update_media, then the trims and holds). */
  readonly ops: ReadonlyArray<unknown>;
}

export interface AgentImportInput {
  readonly openId: number;
  readonly dir: string;
  readonly turnId: string;
  readonly paths: ReadonlyArray<string>;
  /** Display names to use instead of the file name, by path. */
  readonly names?: ReadonlyMap<string, string> | undefined;
  /** D205: store files inside the project relative to it (a copy from another project in media/imports). */
  readonly relativePaths?: boolean | undefined;
}

export interface AgentImport {
  /** The project after the import, or undefined when nothing was added. */
  readonly snapshot: ProjectSnapshot | undefined;
  readonly entries: ReadonlyArray<MediaEntry>;
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly failed: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  /** D105: .srt / .vtt files read into a Subtitles text track. */
  readonly subtitles?: ReadonlyArray<ImportedSubtitles>;
  /** D114: the timeline item a placed take got. */
  readonly placed?: { readonly itemId: string; readonly trackId: string; readonly start: number };
  /** D211: a multi-source take's items and group. */
  readonly multi?: PlacedMulti;
}

export interface ImportedSubtitles {
  readonly path: string;
  readonly track: string;
  readonly cues: number;
}

export class MediaLibrary extends Context.Service<MediaLibrary, MediaLibraryShape>()("uncut/MediaLibrary") {}

export interface MediaEntry {
  readonly id: string;
  readonly kind: "video" | "audio" | "image";
  readonly name: string;
  readonly path: string;
  readonly probe: { frames?: number; fps?: number; width?: number; height?: number; hasAudio: boolean };
  readonly source?: { readonly module: string; readonly [key: string]: unknown };
}
