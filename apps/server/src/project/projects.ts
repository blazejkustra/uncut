// The server owns the open project: it validates, applies edits through @uncut/core, keeps
// the undo/redo stacks and saves project.json. One open project per server for now.
//
// D71: every change is also a revision in <project>/history.db (history.ts): the undo/redo cursor,
// the edit log Undo turn replays and the History tab survive closing the project and restarting
// the app. project.json stays the source of truth: when it differs from the history's newest state
// (changed outside Uncut while closed, or reloaded after a hand edit) that is an "external"
// revision, and ⌘Z stops there (History can still go back past it, as a new revision).
import { isAbsolute, join } from "node:path";

import { EditRefused, ProjectError, type HistoryState, type Problem, type ProjectSnapshot } from "@uncut/contracts";
import { applyEdit, describeOp, EditConflict, EditError, TurnDependency, undoTurn, type Op, type Project, type Session } from "@uncut/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { writeFileAtomic } from "./atomicWrite.ts";
import { ServerConfig } from "../app/config.ts";
import { ProjectFormat } from "./format.ts";
import { HistoryDb, MAX_ROWS, type NewRow, type Row } from "./history.ts";
import { sameJson } from "./jsonPatch.ts";
import { Recents } from "./recents.ts";

interface OpenProject {
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
}

export interface Canvas {
  readonly width: number;
  readonly height: number;
  readonly fps: 24 | 25 | 30 | 50 | 60;
}

export interface ProjectsShape {
  readonly create: (input: { parentDir: string; name: string; canvas?: Canvas | undefined }) => Effect.Effect<ProjectSnapshot, ProjectError>;
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

/** How many revisions history.subscribe sends (newest first; undo/redo steps aren't listed). */
export const HISTORY_LISTED = 200;

/** A change made outside Uncut in a few lines: items and media added, removed or changed. */
export function externalLines(before: Project, after: Project): Array<string> {
  const items = (p: Project) => new Map(p.tracks.flatMap((t) => t.items.map((i) => [i.id, i] as const)));
  const a = items(before);
  const b = items(after);
  const list = (ids: Array<string>) => `${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ` and ${ids.length - 5} more` : ""}`;
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const changed = [...b.keys()].filter((id) => a.has(id) && !sameJson(a.get(id), b.get(id)));
  const mediaAdded = after.media.filter((m) => !before.media.some((x) => x.id === m.id)).map((m) => m.id);
  const mediaRemoved = before.media.filter((m) => !after.media.some((x) => x.id === m.id)).map((m) => m.id);
  const lines = [
    added.length ? `Added ${list(added)}` : "",
    removed.length ? `Removed ${list(removed)}` : "",
    changed.length ? `Changed ${list(changed)}` : "",
    mediaAdded.length ? `Added media ${list(mediaAdded)}` : "",
    mediaRemoved.length ? `Removed media ${list(mediaRemoved)}` : "",
    before.name !== after.name ? `Renamed the project to "${after.name}"` : "",
  ].filter(Boolean);
  return lines.length ? lines : ["Changed the project's settings or track order"];
}

const EXTERNAL_LABEL = "Changed outside Uncut";
const EXTERNAL_STOP = "Undo stops at the change made to project.json outside Uncut, so it isn't lost by accident. To go back further, pick an earlier version in History.";
const COMPACTED_STOP = `Older steps aren't kept: History keeps the last ${MAX_ROWS} changes.`;

export class Projects extends Context.Service<Projects, ProjectsShape>()("uncut/Projects") {}

export const DEFAULT_CANVAS: Canvas = { width: 1920, height: 1080, fps: 30 };

/** A valid project with nothing in it: a text track on top, the main video track, an audio track. */
export const emptyProject = (name: string, canvas: Canvas = DEFAULT_CANVAS): Project => ({
  format: "uncut/0",
  name,
  canvas: { width: canvas.width, height: canvas.height, fps: canvas.fps },
  // D80: made after text looks landed, so the older looks' soft shadow isn't a default here.
  textLooks: 1,
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    { id: "audio", kind: "audio", name: "Audio", items: [] },
  ],
});

const projectError = (reason: ProjectError["reason"], message: string, dir?: string, details: ReadonlyArray<Problem> = []) =>
  new ProjectError({ reason, message, dir, details: [...details] });

const ioError = (dir: string) => (error: { readonly message: string }) => projectError("io", error.message, dir);

// Folder names only: no separators or control characters, no hidden folders, nothing a
// filesystem would mangle (leading/trailing spaces, trailing dots).
const validName = (name: string) =>
  name.length > 0 &&
  name.length <= 100 &&
  name.trim() === name &&
  name.length <= MAX_NAME_LENGTH &&
  !name.startsWith(".") &&
  !name.endsWith(".") &&
  !/[\u0000-\u001f\u007f/\\:]/.test(name);

export const MAX_NAME_LENGTH = 100;

const refused = (message: string, details: ReadonlyArray<Problem> = []) => new EditRefused({ message, details: [...details] });

const toProblems = (error: EditError): Array<Problem> =>
  error instanceof EditConflict
    ? (error.details as Array<string>).map((id) => ({ code: "conflict", path: id, message: `"${id}" was changed by a newer edit` }))
    : (error.details as Array<Problem | string>).map((d) => (typeof d === "string" ? { code: "edit", path: "/", message: d } : d));

const serialize = (project: unknown) => `${JSON.stringify(project, null, 2)}\n`;

/** The .gitignore a new project gets: the cache and the per-Mac undo history (D71) stay local. */
export const GITIGNORE = ".cache/\nhistory.db\nhistory.db-wal\nhistory.db-shm\n";

export const layer = Layer.effect(
  Projects,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const format = yield* ProjectFormat;
    const recents = yield* Recents;
    const config = yield* ServerConfig;
    // Everything that changes the open project runs one at a time.
    const lock = yield* Semaphore.make(1);
    let current: OpenProject | undefined;
    let openCount = 0;
    // A stopping server closes the history, so its WAL is checkpointed into history.db.
    yield* Effect.addFinalizer(() => Effect.sync(() => current?.history.close()));
    const updates = yield* SubscriptionRef.make<ProjectSnapshot | null>(null);
    const historyUpdates = yield* SubscriptionRef.make<HistoryState | null>(null);
    // Tell subscribers what is open now. Called after every change, inside the same lock.
    const publish = Effect.suspend(() =>
      Effect.andThen(SubscriptionRef.set(updates, current ? snapshot(current) : null), SubscriptionRef.set(historyUpdates, current ? historyOf(current) : null)),
    );

    // Why ⌘Z can't go further, when the reason is worth saying (not just "nothing done yet").
    const undoStop = (p: OpenProject): string | undefined => {
      if (p.past.length) return undefined;
      try {
        const start = p.history.boundaryOf(p.session.revision);
        if (start.kind === "external") return EXTERNAL_STOP;
        if (start.kind !== "initial") return COMPACTED_STOP;
      } catch {}
      return undefined;
    };
    // The highest revision this server has shown per folder: a history that starts over (no
    // history.db, or one that fell back to memory) starts above it, so a folder's revisions never
    // go back while the app runs (a late call result can't pass for news).
    const shown = new Map<string, number>();
    const snapshot = (p: OpenProject): ProjectSnapshot => {
      shown.set(p.dir, Math.max(shown.get(p.dir) ?? -1, p.session.revision));
      const stop = undoStop(p);
      return {
        dir: p.dir,
        project: p.session.project,
        revision: p.session.revision,
        canUndo: p.past.length > 0,
        canRedo: p.future.length > 0,
        ...(stop ? { undoStop: stop } : {}),
        ...(p.history.problem ? { historyProblem: p.history.problem } : {}),
      };
    };
    const historyOf = (p: OpenProject): HistoryState => {
      const { rows, total } = p.history.listed(HISTORY_LISTED);
      let lineage: Set<number>;
      try {
        lineage = p.history.lineage(p.session.revision);
      } catch {
        lineage = new Set();
      }
      return {
        dir: p.dir,
        revision: p.session.revision,
        persistent: p.history.persistent,
        ...(p.history.problem ? { problem: p.history.problem } : {}),
        total,
        entries: rows.map((r) => ({
          revision: r.revision,
          at: r.at,
          kind: r.kind,
          author: r.author,
          ...(r.turnId ? { turnId: r.turnId } : {}),
          label: r.label,
          lines: [...r.lines],
          current: lineage.has(r.revision),
        })),
      };
    };
    /** Add a revision to the history and take the cursor it stored (compaction can trim it). */
    const record = (p: OpenProject, row: NewRow) => {
      try {
        const stored = p.history.record(row, { past: p.past, future: p.future });
        p.past = [...stored.past];
        p.future = [...stored.future];
      } catch (error) {
        // project.json is saved; the history just misses this step. Undo stops before it.
        console.error(`[uncut] history: couldn't record revision ${row.revision}: ${(error as Error).message}`);
        p.past = [];
        p.future = [];
      }
    };
    /** A revision's state, its log and the project the log starts from, read from the history. */
    const restoreFrom = (p: OpenProject, revision: number) =>
      Effect.try({
        try: () => {
          const project = p.history.stateAt(revision);
          const { log, initial } = p.history.logAt(revision);
          return { project, log, initial: p.history.stateAt(initial) };
        },
        catch: (error) => projectError("io", `The history can't bring back revision ${revision}: ${(error as Error).message}`, p.dir),
      });
    const requireOpen = Effect.suspend(() =>
      current ? Effect.succeed(current) : Effect.fail(projectError("no-project", "No project is open")),
    );
    const readProjectFile = (dir: string) =>
      fs.readFileString(join(dir, "project.json")).pipe(
        Effect.mapError((error: PlatformError) =>
          error.reason._tag === "NotFound" ? projectError("missing", `No project.json in ${dir}`, dir) : projectError("io", error.message, dir),
        ),
      );
    /** Parse and validate project.json text; the problems become a typed "invalid" error. */
    const parseProject = (dir: string, text: string) =>
      Effect.gen(function* () {
        const project = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (error) => projectError("invalid", "project.json is not valid JSON", dir, [{ code: "json", path: "/", message: String((error as Error).message) }]),
        });
        const problems = format.validate(project);
        if (problems.length) {
          return yield* projectError("invalid", `project.json has ${problems.length} problem${problems.length === 1 ? "" : "s"}`, dir, problems);
        }
        return project as Session["project"];
      });

    /**
     * Save `next` and make it current, as one step that can't be interrupted halfway (a
     * client hanging up mid-save must not leave disk and memory disagreeing). Refuses if
     * project.json was edited by hand since we last read or wrote it.
     */
    const commit = (p: OpenProject, next: Session, moveStacks: (previous: Session) => void, row: NewRow) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const onDisk = yield* readProjectFile(p.dir).pipe(Effect.catchTag("ProjectError", () => Effect.succeed(undefined)));
          if (onDisk !== p.diskText) {
            return yield* projectError("changed-on-disk", "project.json was changed outside Uncut; reload it before editing", p.dir);
          }
          const text = serialize(next.project);
          yield* writeFileAtomic(join(p.dir, "project.json"), text).pipe(Effect.mapError(ioError(p.dir)));
          const previous = p.session;
          p.session = next;
          p.diskText = text;
          moveStacks(previous);
          record(p, row);
          // Recents show the name the project has now, not the one it was opened with.
          if (next.project.name !== previous.project.name) yield* recents.touch(p.dir, next.project.name);
          yield* publish;
          return snapshot(p);
        }),
      );

    /**
     * Make `project` (just read or created) the open one, with its history. A history whose newest
     * state isn't what project.json says gets an "external" revision: the file was changed outside
     * Uncut while it was closed (git, another editor, a sync app), and ⌘Z stops there.
     */
    const setOpen = (dir: string, project: Session["project"], diskText: string, created: boolean) =>
      Effect.gen(function* () {
        if (current && current.dir !== dir) current.history.close();
        const history = HistoryDb.open(dir);
        let session: Session;
        let initial: Project = project;
        let cursor = { past: [] as ReadonlyArray<number>, future: [] as ReadonlyArray<number> };
        let unlogged: UnloggedChange;
        const start = (revision: number) => {
          const label = created ? "Created the project" : "Opened project.json: the history starts here";
          cursor = history.record({ kind: "initial", author: created ? "user" : "import", revision, label, project }, cursor);
          session = { project, revision, log: [] };
          unlogged = { revision, what: "The project was opened" };
        };
        try {
          const head = history.head;
          if (head === undefined || created) start(Math.max(head ?? -1, shown.get(dir) ?? -1) + 1);
          else if (sameJson(history.stateAt(head), project)) {
            const { log, initial: from } = history.logAt(head);
            session = { project, revision: head, log };
            initial = history.stateAt(from);
            cursor = history.cursor;
            // Nothing changed while it was closed; still, the agent re-reads before editing.
            unlogged = { revision: head, what: "The project was closed and opened again (nothing changed in between)" };
          } else {
            const revision = head + 1;
            const lines = externalLines(history.stateAt(head), project);
            cursor = history.record({ kind: "external", author: "external", revision, label: EXTERNAL_LABEL, lines, project }, { past: [], future: [] });
            session = { project, revision, log: [] };
            unlogged = { revision, what: `The project was closed and opened again, and project.json had been changed outside Uncut (${lines.join("; ")})` };
          }
        } catch (error) {
          // A history whose contents can't be used doesn't stop the project from opening.
          console.error(`[uncut] history of ${dir} can't be used: ${(error as Error).message}`);
          history.abandon(error);
          initial = project;
          cursor = { past: [], future: [] };
          start((shown.get(dir) ?? -1) + 1);
        }
        current = {
          dir,
          openId: ++openCount,
          openRevision: session!.revision,
          session: session!,
          past: [...cursor.past],
          future: [...cursor.future],
          history,
          diskText,
          initial,
          unlogged: [unlogged!],
          pushedForTurn: undefined,
        };
        yield* recents.touch(dir, project.name);
        yield* publish;
        return snapshot(current);
      });

    /** An absolute path, resolved through symlinks; missing → typed "missing". */
    const realDir = (raw: string, label: string) =>
      Effect.gen(function* () {
        if (!isAbsolute(raw)) return yield* projectError("invalid-path", `${label} must be an absolute path, got "${raw}"`);
        return yield* fs.realPath(raw).pipe(
          Effect.mapError((error) =>
            error.reason._tag === "NotFound" ? projectError("missing", `${raw} does not exist`, raw) : projectError("io", error.message, raw),
          ),
        );
      });

    const step = (from: "past" | "future") =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const p = yield* requireOpen;
          const target = p[from].at(-1);
          if (target === undefined) return snapshot(p);
          // The earlier project comes back, under a new revision.
          const restored = yield* restoreFrom(p, target);
          const revision = p.session.revision + 1;
          const undo = from === "past";
          return yield* commit(
            p,
            { project: restored.project, revision, log: restored.log },
            (previous) => {
              p[from].pop();
              p[undo ? "future" : "past"].push(previous.revision);
              p.initial = restored.initial;
              p.pushedForTurn = undefined;
              p.unlogged.push({ revision, what: undo ? "Used undo (⌘Z)" : "Used redo (⇧⌘Z)" });
            },
            { kind: undo ? "undo" : "redo", author: "user", revision, label: undo ? "Undo" : "Redo", target },
          );
        }),
      );

    const editUnlocked = (
      p: OpenProject,
      { ops, baseRevision, summary }: { ops: ReadonlyArray<unknown>; baseRevision?: number | undefined; summary?: string | undefined },
      agent?: { readonly turnId: string },
    ) =>
      Effect.gen(function* () {
        const opProblems = format.validateOps(ops);
        if (opProblems.length) return yield* refused("The edit is malformed", opProblems);
        if (baseRevision !== undefined && baseRevision > p.session.revision) {
          return yield* refused(`baseRevision ${baseRevision} is newer than the project (revision ${p.session.revision})`, [
            { code: "base-revision", path: "/baseRevision", message: "a revision from the future" },
          ]);
        }
        // D6: undo, redo and reload aren't log entries, so the engine can't tell what they
        // touched. Any agent edit planned before one of them is refused: read again first.
        const unseen = agent && baseRevision !== undefined ? p.unlogged.filter((u) => u.revision > baseRevision) : [];
        if (unseen.length) {
          const what = unseen.map((u) => u.what).join("; ");
          return yield* refused(`The project changed after revision ${baseRevision} (${what}). Read it again before editing.`, [
            { code: "conflict", path: "/", message: what },
          ]);
        }
        const applied = yield* Effect.try({
          // validateOps above checked every op against the edit-ops schema.
          try: () =>
            applyEdit(
              p.session,
              { actor: agent ? "agent" : "user", ops: ops as ReadonlyArray<Op>, baseRevision, summary, ...(agent ? { turnId: agent.turnId } : {}) },
              format.validate,
            ),
          catch: (error) =>
            error instanceof EditError
              ? refused(error.message, toProblems(error))
              : // Well-formed ops can still trip the engine (e.g. a field it doesn't expect).
                refused("The edit is malformed", [{ code: "malformed-op", path: "/", message: String((error as Error)?.message ?? error) }]),
        });
        // Validate exactly what will be written and read back, so nothing that wouldn't
        // reopen can be saved.
        const written = JSON.parse(serialize(applied.project)) as Session["project"];
        // Names double as folder and window names: keep them non-blank and short.
        if (typeof written.name === "string" && written.name.trim() === "") {
          return yield* refused("A project needs a name.", [{ code: "name", path: "/name", message: "A project needs a name." }]);
        }
        if (typeof written.name === "string" && written.name.length > MAX_NAME_LENGTH) {
          const message = `A project name can be at most ${MAX_NAME_LENGTH} characters.`;
          return yield* refused(message, [{ code: "name", path: "/name", message }]);
        }
        const problems = format.validate(written);
        if (problems.length) return yield* refused("The edit would make the project invalid", problems);
        const entry = applied.log.at(-1)!;
        const typed = ops as ReadonlyArray<Op>;
        const lines = typed.map((op) => describeOp(op, written, summary));
        const author = agent ? "agent" : typed.every((op) => op.op === "add_media") ? "import" : "user";
        return yield* commit(
          p,
          { ...applied, project: written },
          (previous) => {
            // D7: a turn's later edits join its first one on the undo stack, so ⌘Z after a turn
            // takes the whole turn back, as "Undo turn" does.
            if (!agent || p.pushedForTurn !== agent.turnId) p.past.push(previous.revision);
            p.pushedForTurn = agent?.turnId;
            p.future = [];
          },
          {
            kind: "edit",
            author,
            revision: applied.revision,
            at: entry.at,
            label: summary?.trim() || lines[0] || "Edit",
            lines,
            summary,
            ops: typed,
            turnId: agent?.turnId,
            project: written,
          },
        );
      });

    const openingIs = (openId: number) =>
      Effect.suspend(() =>
        current && current.openId === openId ? Effect.succeed(current) : Effect.fail(projectError("no-project", "The project was closed before this finished.")),
      );

    return Projects.of({
      create: ({ parentDir, name, canvas }) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (!validName(name)) return yield* projectError("invalid-name", `"${name}" can't be used as a folder name`);
            const parent = yield* realDir(parentDir, "The parent folder");
            const dir = join(parent, `${name}.uncut`);
            const project = emptyProject(name, canvas);
            const problems = format.validate(project);
            if (problems.length) return yield* projectError("invalid", "The new project would be invalid", dir, problems);
            const text = serialize(project);
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                // Not recursive: if the folder appeared in the meantime this fails instead of reusing it.
                yield* fs.makeDirectory(dir).pipe(
                  Effect.mapError((error) =>
                    error.reason._tag === "AlreadyExists" ? projectError("exists", `${dir} already exists`, dir) : ioError(dir)(error),
                  ),
                );
                // From here on the folder is ours, so a failure removes it again.
                yield* Effect.gen(function* () {
                  if (config.testFault === "create-after-mkdir") yield* Effect.fail(new Error("injected fault"));
                  for (const sub of ["graphics", "media", ".cache"]) yield* fs.makeDirectory(join(dir, sub));
                  // history.db (D71) is this Mac's undo history, not part of the shared project.
                  yield* fs.writeFileString(join(dir, ".gitignore"), GITIGNORE);
                  yield* writeFileAtomic(join(dir, "project.json"), text);
                }).pipe(
                  Effect.mapError(ioError(dir)),
                  Effect.tapError(() => fs.remove(dir, { recursive: true }).pipe(Effect.ignore)),
                );
              }),
            );
            return yield* setOpen(dir, project, text, true);
          }),
        ),

      open: (rawDir) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const dir = yield* realDir(rawDir, "The project folder");
            const text = yield* readProjectFile(dir);
            const project = yield* parseProject(dir, text);
            return yield* setOpen(dir, project, text, false);
          }),
        ),

      // Under the lock, so a read made after an edit was sent sees that edit.
      get: lock.withPermits(1)(Effect.map(requireOpen, snapshot)),

      close: lock.withPermits(1)(
        Effect.suspend(() => {
          current?.history.close();
          current = undefined;
          return publish;
        }),
      ),

      changes: SubscriptionRef.changes(updates),

      currentDir: Effect.sync(() => current?.dir),
      current: Effect.sync(() => (current ? { dir: current.dir, openId: current.openId, project: current.session.project } : undefined)),

      reload: lock.withPermits(1)(
        Effect.gen(function* () {
          const p = yield* requireOpen;
          const text = yield* readProjectFile(p.dir);
          // An invalid file fails here and the current session stays as it was.
          const project = yield* parseProject(p.dir, text);
          // Only the formatting changed: nothing to record, saving works again.
          if (sameJson(project, p.session.project)) {
            p.diskText = text;
            yield* publish;
            return snapshot(p);
          }
          // An external revision (D71): the undo stacks describe the file before the hand edit, so
          // ⌘Z stops here; History can still go back past it.
          const renamed = project.name !== p.session.project.name;
          const lines = externalLines(p.session.project, project);
          const revision = p.session.revision + 1;
          p.session = { project, revision, log: [] };
          p.past = [];
          p.future = [];
          p.diskText = text;
          p.initial = project;
          p.pushedForTurn = undefined;
          p.unlogged.push({ revision, what: `Reloaded project.json after it was changed outside Uncut (${lines.join("; ")})` });
          record(p, { kind: "external", author: "external", revision, label: EXTERNAL_LABEL, lines, project });
          if (renamed) yield* recents.touch(p.dir, project.name);
          yield* publish;
          return snapshot(p);
        }),
      ),

      edit: ({ ops, baseRevision, summary }) => lock.withPermits(1)(Effect.flatMap(requireOpen, (p) => editUnlocked(p, { ops, baseRevision, summary }))),

      editIn: (openId, plan, agent) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const p = current;
            if (!p || p.openId !== openId) {
              return yield* projectError("no-project", "The project was closed before this finished.");
            }
            const planned = yield* plan(p.session.project, p.dir);
            if (!planned || planned.ops.length === 0) return undefined;
            return yield* editUnlocked(p, planned, agent);
          }),
        ),

      undo: step("past"),
      redo: step("future"),

      view: Effect.sync(() =>
        current
          ? { dir: current.dir, openId: current.openId, openRevision: current.openRevision, session: current.session, initial: current.initial, unlogged: [...current.unlogged] }
          : undefined,
      ),

      agentEdit: (openId, { turnId, ops, baseRevision, summary }) =>
        lock.withPermits(1)(Effect.flatMap(openingIs(openId), (p) => editUnlocked(p, { ops, baseRevision, summary }, { turnId }))),

      undoTurn: (openId, turnId, label) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const p = yield* openingIs(openId);
            const next = yield* Effect.try({
              try: () => undoTurn(p.initial, p.session, turnId, format.validate),
              catch: (error) =>
                error instanceof EditError
                  ? refused(error.message, [{ code: error instanceof TurnDependency ? "depends" : "edit", path: "/", message: error.message }])
                  : refused("The turn can't be undone", [{ code: "malformed-op", path: "/", message: String((error as Error)?.message ?? error) }]),
            });
            const written = JSON.parse(serialize(next.project)) as Session["project"];
            const problems = format.validate(written);
            if (problems.length) return yield* refused("Undoing the turn would make the project invalid", problems);
            return yield* commit(
              p,
              { ...next, project: written },
              (previous) => {
                p.past.push(previous.revision);
                p.future = [];
                p.pushedForTurn = undefined;
                p.unlogged.push({ revision: next.revision, what: label });
              },
              { kind: "undo-turn", author: "user", revision: next.revision, label, undoTurn: turnId, project: written },
            );
          }),
        ),

      historyChanges: SubscriptionRef.changes(historyUpdates),

      historyPreview: (revision) =>
        Effect.gen(function* () {
          const p = yield* requireOpen;
          if (!p.history.has(revision)) return yield* projectError("missing", `Revision ${revision} isn't in this project's history`, p.dir);
          const restored = yield* restoreFrom(p, revision);
          return { revision, project: restored.project };
        }),

      historyJump: (revision) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const p = yield* requireOpen;
            if (!p.history.has(revision)) return yield* projectError("missing", `Revision ${revision} isn't in this project's history`, p.dir);
            const row: Row = p.history.row(revision);
            const target = p.history.resolve(revision);
            if (target === p.history.resolve(p.session.revision)) return snapshot(p);
            const restored = yield* restoreFrom(p, target);
            const written = JSON.parse(serialize(restored.project)) as Session["project"];
            const problems = format.validate(written);
            if (problems.length) return yield* refused("That version can't be restored: it isn't a valid project any more", problems);
            const next = p.session.revision + 1;
            const when = new Date(row.at);
            const label = `Went back to "${row.label}"`;
            return yield* commit(
              p,
              { project: written, revision: next, log: restored.log },
              (previous) => {
                p.past.push(previous.revision);
                p.future = [];
                p.initial = restored.initial;
                p.pushedForTurn = undefined;
                p.unlogged.push({ revision: next, what: `Went back to an earlier version from History (revision ${revision}: ${row.label})` });
              },
              { kind: "jump", author: "user", revision: next, label, lines: [`Restored the project as it was at revision ${revision} (${when.toISOString()})`], target, project: written },
            );
          }),
        ),
    });
  }),
);
