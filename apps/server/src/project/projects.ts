// The server owns the open project: it validates, applies edits through @uncut/core, keeps
// the undo/redo stacks and saves project.json. One open project per server for now.
//
// D71: every change is also a revision in <project>/history.db (history.ts): the undo/redo cursor,
// the edit log Undo turn replays and the History tab survive closing the project and restarting
// the app. project.json stays the source of truth: when it differs from the history's newest state
// (changed outside Uncut while closed, or reloaded after a hand edit) that is an "external"
// revision, and ⌘Z stops there (History can still go back past it, as a new revision).
import { isAbsolute, join } from "node:path";

import { DEFAULT_AGENT_ID, type HistoryState, type ProjectSnapshot } from "@uncut/contracts";
import { EditConflict, EditError, TurnDependency, redoTurn, undoTurn, type LogEntry, type Project, type Session } from "@uncut/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { writeFileAtomic } from "./atomicWrite.ts";
import { ServerConfig } from "../app/config.ts";
import { ProjectFormat } from "./format.ts";
import { HistoryDb, type NewRow, type Row } from "./history.ts";
import { sameJson } from "./jsonPatch.ts";
import { Recents } from "./recents.ts";
import { Projects, type MediaRecord, type OpenProject, type UnloggedChange, emptyProject, MATCH_FIRST_CLIP } from "./projects/service.ts";
import { makeEditUnlocked } from "./projects/edit.ts";
import {
  EXTERNAL_STOP,
  COMPACTED_STOP,
  HISTORY_LISTED,
  projectError,
  serialize,
  ioError,
  externalLines,
  EXTERNAL_LABEL,
  refused,
  validName,
  GITIGNORE,
} from "./projects/helpers.ts";
export { MATCH_FIRST_CLIP, Projects, DEFAULT_CANVAS, emptyProject } from "./projects/service.ts";
export type { MediaRecord, UnloggedChange, ProjectView, AgentEditInput, Canvas, ProjectsShape } from "./projects/service.ts";
export { HISTORY_LISTED, externalLines, MAX_NAME_LENGTH, GITIGNORE } from "./projects/helpers.ts";

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
    // #65 (D263): every media entry this opening of the project has listed. Undo takes media out
    // of the project but never deletes its file (redo brings it back), and the preview may still
    // be fetching it in that moment: the media routes keep serving such a file instead of a 404.
    let seenMedia: { openId: number; byId: Map<string, MediaRecord> } = { openId: -1, byId: new Map() };
    const noteMedia = () => {
      if (!current) return;
      if (seenMedia.openId !== current.openId) seenMedia = { openId: current.openId, byId: new Map() };
      for (const m of (current.session.project as unknown as { media?: ReadonlyArray<MediaRecord> }).media ?? [])
        if (typeof m?.id === "string" && typeof m.path === "string") seenMedia.byId.set(m.id, m);
    };
    const publish = Effect.suspend(() => {
      noteMedia();
      return Effect.andThen(
        SubscriptionRef.set(updates, current ? snapshot(current) : null),
        SubscriptionRef.set(historyUpdates, current ? historyOf(current) : null),
      );
    });

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
    const requireOpen = Effect.suspend(() => (current ? Effect.succeed(current) : Effect.fail(projectError("no-project", "No project is open"))));
    const readProjectFile = (dir: string) =>
      fs
        .readFileString(join(dir, "project.json"))
        .pipe(
          Effect.mapError((error: PlatformError) =>
            error.reason._tag === "NotFound" ? projectError("missing", `No project.json in ${dir}`, dir) : projectError("io", error.message, dir),
          ),
        );
    /** Parse and validate project.json text; the problems become a typed "invalid" error. */
    const parseProject = (dir: string, text: string) =>
      Effect.gen(function* () {
        const project = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (error) =>
            projectError("invalid", "project.json is not valid JSON", dir, [{ code: "json", path: "/", message: String((error as Error).message) }]),
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
            unlogged = { revision: head, what: "The project was closed and opened again (nothing changed in between)", unchanged: true };
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
          undone: new Map(),
        };
        yield* recents.touch(dir, project.name);
        yield* publish;
        return snapshot(current);
      });

    /** An absolute path, resolved through symlinks; missing → typed "missing". */
    const realDir = (raw: string, label: string) =>
      Effect.gen(function* () {
        if (!isAbsolute(raw)) return yield* projectError("invalid-path", `${label} must be an absolute path, got "${raw}"`);
        return yield* fs
          .realPath(raw)
          .pipe(
            Effect.mapError((error) =>
              error.reason._tag === "NotFound" ? projectError("missing", `${raw} does not exist`, raw) : projectError("io", error.message, raw),
            ),
          );
      });

    // ⌘Z and ⇧⌘Z show in the agent's net note (D6); one that takes back or brings back the agent's own edits is said too.
    const stepNote = (undo: boolean, revision: number, longer: ReadonlyArray<LogEntry>, shorter: ReadonlyArray<LogEntry>): UnloggedChange => {
      const kept = new Set(shorter.map((e) => e.revision));
      const agents = longer.filter((e) => e.actor === "agent" && !kept.has(e.revision));
      const what = undo ? "Used undo (⌘Z)" : "Used redo (⇧⌘Z)";
      if (!agents.length) return { revision, what, quiet: true };
      const labels = agents.map((e) => ({ agentId: e.agentId ?? DEFAULT_AGENT_ID, label: e.summary ? `"${e.summary}"` : `revision ${e.revision}` }));
      const verb = undo ? "took back" : "brought back";
      return {
        revision,
        what: `${what}, which ${verb} your edit${agents.length === 1 ? "" : "s"} ${labels.map((l) => l.label).join(", ")}`,
        step: { did: what, verb, edits: labels },
      };
    };

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
              p.unlogged.push(stepNote(undo, revision, undo ? previous.log : restored.log, undo ? restored.log : previous.log));
            },
            { kind: undo ? "undo" : "redo", author: "user", revision, label: undo ? "Undo" : "Redo", target },
          );
        }),
      );

    const editUnlocked = makeEditUnlocked({ format, commit });

    const stateOf = (p: OpenProject) => (revision: number) => {
      try {
        return p.history.stateAt(revision);
      } catch {
        return undefined;
      }
    };

    const openingIs = (openId: number) =>
      Effect.suspend(() =>
        current && current.openId === openId
          ? Effect.succeed(current)
          : Effect.fail(projectError("no-project", "The project was closed before this finished.")),
      );

    return Projects.of({
      create: ({ parentDir, name, canvas, matchFirstClip }) =>
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
                yield* fs
                  .makeDirectory(dir)
                  .pipe(
                    Effect.mapError((error) =>
                      error.reason._tag === "AlreadyExists" ? projectError("exists", `${dir} already exists`, dir) : ioError(dir)(error),
                    ),
                  );
                // From here on the folder is ours, so a failure removes it again.
                yield* Effect.gen(function* () {
                  if (config.testFault === "create-after-mkdir") yield* Effect.fail(new Error("injected fault"));
                  for (const sub of ["graphics", "media", ".cache"]) yield* fs.makeDirectory(join(dir, sub));
                  if (matchFirstClip) yield* fs.writeFileString(join(dir, ".cache", MATCH_FIRST_CLIP), "");
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
      mediaEntry: (id: string) =>
        Effect.sync(() => {
          if (!current) return undefined;
          const now = ((current.session.project as unknown as { media?: ReadonlyArray<MediaRecord> }).media ?? []).find((m) => m.id === id);
          const entry = now ?? (seenMedia.openId === current.openId ? seenMedia.byId.get(id) : undefined);
          return entry && typeof entry.path === "string" ? { dir: current.dir, entry, removed: !now } : undefined;
        }),

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
          ? {
              dir: current.dir,
              openId: current.openId,
              openRevision: current.openRevision,
              session: current.session,
              initial: current.initial,
              unlogged: [...current.unlogged],
              stateAt: stateOf(current),
              undone: new Map(current.undone),
            }
          : undefined,
      ),

      agentEdit: (openId, { turnId, ops, baseRevision, summary, dryRun }) =>
        lock.withPermits(1)(Effect.flatMap(openingIs(openId), (p) => editUnlocked(p, { ops, baseRevision, summary }, { turnId, dryRun }))),

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
                p.undone.set(turnId, { entries: previous.log.filter((e) => e.turnId === turnId), revision: next.revision });
              },
              { kind: "undo-turn", author: "user", revision: next.revision, label, undoTurn: turnId, project: written },
            );
          }),
        ),

      redoTurn: (openId, turnId, label) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const p = yield* openingIs(openId);
            const undone = p.undone.get(turnId);
            if (!undone)
              return yield* refused("The turn can't be redone: it wasn't undone since the project was opened", [
                { code: "edit", path: "/", message: "nothing to redo" },
              ]);
            const next = yield* Effect.try({
              try: () => redoTurn(p.session, undone.entries, undone.revision, format.validate),
              catch: (error) =>
                error instanceof EditError
                  ? refused(
                      error instanceof EditConflict
                        ? `A later edit changed what the turn changed (${error.details.join(", ")}): undo that first`
                        : error.message,
                      [{ code: error instanceof EditConflict ? "conflict" : "edit", path: "/", message: error.message }],
                    )
                  : refused("The turn can't be redone", [{ code: "malformed-op", path: "/", message: String((error as Error)?.message ?? error) }]),
            });
            const written = JSON.parse(serialize(next.project)) as Session["project"];
            const problems = format.validate(written);
            if (problems.length) return yield* refused("Redoing the turn would make the project invalid", problems);
            const entry = next.log.at(-1)!;
            return yield* commit(
              p,
              { ...next, project: written },
              (previous) => {
                p.past.push(previous.revision);
                p.future = [];
                p.pushedForTurn = undefined;
                p.unlogged.push({ revision: next.revision, what: label });
                p.undone.delete(turnId);
              },
              {
                kind: "edit",
                author: "user",
                revision: next.revision,
                at: entry.at,
                label,
                lines: [label],
                summary: entry.summary,
                ops: entry.ops,
                turnId,
                project: written,
              },
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
              {
                kind: "jump",
                author: "user",
                revision: next,
                label,
                lines: [`Restored the project as it was at revision ${revision} (${when.toISOString()})`],
                target,
                project: written,
              },
            );
          }),
        ),
    });
  }),
);
