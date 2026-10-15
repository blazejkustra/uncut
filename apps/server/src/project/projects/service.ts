// The Projects service: its shape, the open project's state and an empty project.
import { type ProjectSnapshot, ProjectError, EditRefused, type HistoryState } from "@uncut/contracts";
import type { Session, Project, Canvas as CoreCanvas } from "@uncut/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { HistoryDb } from "../history.ts";

export interface OpenProject {
  readonly dir: string;
  // Which opening of the project this is: a close and reopen (or another project) is a new one.
  readonly openId: number;
  // The revision the project was opened at (revisions are the project's own, kept in history.db).
  readonly openRevision: number;
  session: Session;
  // The revisions ⌘Z and ⇧⌘Z go back to (one per undo step: a turn's edits are one, D7).
  past: Array<number>;
  future: Array<number>;
  readonly history: HistoryDb;
  // project.json exactly as we last read or wrote it, to notice hand edits before saving.
  diskText: string;
  // The project the session's log starts from (the history's boundary): undoing a turn replays from it.
  initial: Project;
  // Changes that aren't log entries (undo, redo, reload, undoing a turn), for the agent's note and
  // its conflict check: an agent edit based on a revision before one of these is refused.
  unlogged: Array<UnloggedChange>;
  // The agent turn whose first edit put the pre-turn project on the undo stack (D7: a turn is
  // one undo step). Cleared by anything else that touches the stack.
  pushedForTurn: string | undefined;
}

export interface UnloggedChange {
  readonly revision: number;
  readonly what: string;
}

/** The open project as the agent service needs it: the session with its log. Read-only. */
export interface ProjectView {
  readonly dir: string;
  readonly openId: number;
  // Log entries up to this revision are from earlier openings (the agent's carried note covers them).
  readonly openRevision: number;
  readonly session: Session;
  readonly initial: Project;
  readonly unlogged: ReadonlyArray<UnloggedChange>;
}

export interface AgentEditInput {
  readonly turnId: string;
  readonly ops: ReadonlyArray<unknown>;
  readonly baseRevision: number;
  readonly summary: string;
  /** D206: check the edit exactly as it would be made (schema, rules, D6) and return the result without saving it. */
  readonly dryRun?: boolean;
}

export interface Canvas {
  readonly width: number;
  readonly height: number;
  readonly fps: CoreCanvas["fps"];
  readonly background?: string | undefined;
}

/** D209: a project made with "Match first clip" takes its first video's size and frame rate; this marker in .cache says so until then. */
export const MATCH_FIRST_CLIP = "match-first-clip";

export interface ProjectsShape {
  readonly create: (input: { parentDir: string; name: string; canvas?: Canvas | undefined; matchFirstClip?: boolean | undefined }) => Effect.Effect<ProjectSnapshot, ProjectError>;
  readonly open: (dir: string) => Effect.Effect<ProjectSnapshot, ProjectError>;
  readonly get: Effect.Effect<ProjectSnapshot, ProjectError>;
  readonly reload: Effect.Effect<ProjectSnapshot, ProjectError>;
  readonly close: Effect.Effect<void>;
  /** The open project's folder, without waiting for the lock (for read-only uses like thumbnails). */
  readonly currentDir: Effect.Effect<string | undefined>;
  /** The open project right now (no lock): its folder, opening and content. */
  readonly current: Effect.Effect<{ readonly dir: string; readonly openId: number; readonly project: unknown } | undefined>;
  /**
   * An edit planned against the project as it is under the lock, refused unless the same
   * opening of the project is still open. `plan` returns the ops (or nothing to do). With
   * `agent`, the edit is the agent's (actor "agent", tagged with its turn), so Undo turn takes
   * it back and the manual-edit note doesn't list it (an agent media_import, D65).
   */
  readonly editIn: <E>(
    openId: number,
    plan: (project: unknown, dir: string) => Effect.Effect<{ ops: ReadonlyArray<unknown>; summary: string } | undefined, E>,
    agent?: { readonly turnId: string },
  ) => Effect.Effect<ProjectSnapshot | undefined, ProjectError | EditRefused | E>;
  /** The current snapshot (null: nothing open), then every change. */
  readonly changes: Stream.Stream<ProjectSnapshot | null>;
  readonly edit: (input: {
    ops: ReadonlyArray<unknown>;
    baseRevision?: number | undefined;
    summary?: string | undefined;
  }) => Effect.Effect<ProjectSnapshot, ProjectError | EditRefused>;
  readonly undo: Effect.Effect<ProjectSnapshot, ProjectError>;
  readonly redo: Effect.Effect<ProjectSnapshot, ProjectError>;
  /** The open project with its edit log (no lock), for the agent service. */
  readonly view: Effect.Effect<ProjectView | undefined>;
  /**
   * An agent edit (actor "agent", tagged with its turn) to the same opening of the project: the
   * same validation and saving as a user edit, plus D6's refusal when the user changed what it
   * touches (or used undo/redo/reload) after `baseRevision`. Not reachable over the RPC.
   */
  readonly agentEdit: (openId: number, input: AgentEditInput) => Effect.Effect<ProjectSnapshot, ProjectError | EditRefused>;
  /** Revert one turn's edits as one undoable step, keeping later edits (D7). */
  readonly undoTurn: (openId: number, turnId: string, label: string) => Effect.Effect<ProjectSnapshot, ProjectError | EditRefused>;
  /** The open project's history for the History tab (null: nothing open), then every change. */
  readonly historyChanges: Stream.Stream<HistoryState | null>;
  /** The project as it was at a revision, for the History tab's preview. Changes nothing. */
  readonly historyPreview: (revision: number) => Effect.Effect<{ revision: number; project: unknown }, ProjectError>;
  /** Go back (or forward) to a revision's state as a new, undoable revision (D71). */
  readonly historyJump: (revision: number) => Effect.Effect<ProjectSnapshot, ProjectError | EditRefused>;
}

export class Projects extends Context.Service<Projects, ProjectsShape>()("uncut/Projects") {}

export const DEFAULT_CANVAS: Canvas = { width: 1920, height: 1080, fps: 30 };

/** A valid project with nothing in it: a text track on top, the main video track, an audio track. */
export const emptyProject = (name: string, canvas: Canvas = DEFAULT_CANVAS): Project => ({
  format: "uncut/0",
  name,
  canvas: { width: canvas.width, height: canvas.height, fps: canvas.fps, ...(canvas.background ? { background: canvas.background } : {}) },
  // D80: made after text looks landed, so the older looks' soft shadow isn't a default here.
  textLooks: 1,
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    { id: "audio", kind: "audio", name: "Audio", items: [] },
  ],
});
