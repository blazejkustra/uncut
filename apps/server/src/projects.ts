// The server owns the open project: it validates, applies edits through @uncut/core, keeps
// the undo/redo stacks and saves project.json. One open project per server for now.
//
// D12 also puts history.db (SQLite: the edit log and agent-turn snapshots) in the project
// folder. Not yet: the log and the undo stacks live in memory and start fresh on open.
// When it lands, open/edit/undo below are where it is read and appended.
import { isAbsolute, join } from "node:path";

import { EditRefused, ProjectError, type Problem, type ProjectSnapshot } from "@uncut/contracts";
import { applyEdit, EditConflict, EditError } from "@uncut/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { writeFileAtomic } from "./atomicWrite.ts";
import { ServerConfig } from "./config.ts";
import { ProjectFormat } from "./format.ts";
import { Recents } from "./recents.ts";

interface Session {
  readonly project: Record<string, unknown> & { readonly name: string };
  readonly revision: number;
  readonly log: ReadonlyArray<unknown>;
}

interface OpenProject {
  readonly dir: string;
  session: Session;
  past: Array<Session>;
  future: Array<Session>;
  // project.json exactly as we last read or wrote it, to notice hand edits before saving.
  diskText: string;
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
  /** The current snapshot (null: nothing open), then every change. */
  readonly changes: Stream.Stream<ProjectSnapshot | null>;
  readonly edit: (input: {
    ops: ReadonlyArray<unknown>;
    baseRevision?: number | undefined;
    summary?: string | undefined;
  }) => Effect.Effect<ProjectSnapshot, ProjectError | EditRefused>;
  readonly undo: Effect.Effect<ProjectSnapshot, ProjectError>;
  readonly redo: Effect.Effect<ProjectSnapshot, ProjectError>;
}

export class Projects extends Context.Service<Projects, ProjectsShape>()("uncut/Projects") {}

export const DEFAULT_CANVAS: Canvas = { width: 1920, height: 1080, fps: 30 };

/** A valid project with nothing in it: a text track on top, the main video track, an audio track. */
export const emptyProject = (name: string, canvas: Canvas = DEFAULT_CANVAS) => ({
  format: "uncut/0",
  name,
  canvas: { width: canvas.width, height: canvas.height, fps: canvas.fps },
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
    const updates = yield* SubscriptionRef.make<ProjectSnapshot | null>(null);
    // Tell subscribers what is open now. Called after every change, inside the same lock.
    const publish = Effect.suspend(() => SubscriptionRef.set(updates, current ? snapshot(current) : null));
    // The last revision this server handed out, so revisions keep going up across close/open.
    let lastRevision = -1;

    const snapshot = (p: OpenProject): ProjectSnapshot => {
      lastRevision = Math.max(lastRevision, p.session.revision);
      return snapshotOf(p);
    };
    const snapshotOf = (p: OpenProject): ProjectSnapshot => ({
      dir: p.dir,
      project: p.session.project,
      revision: p.session.revision,
      canUndo: p.past.length > 0,
      canRedo: p.future.length > 0,
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
    const commit = (p: OpenProject, next: Session, moveStacks: (previous: Session) => void) =>
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
          // Recents show the name the project has now, not the one it was opened with.
          if (next.project.name !== previous.project.name) yield* recents.touch(p.dir, next.project.name);
          yield* publish;
          return snapshot(p);
        }),
      );

    const setOpen = (dir: string, project: Session["project"], diskText: string) =>
      Effect.gen(function* () {
        // Revisions never go back, not even across opens within one server.
        const revision = lastRevision + 1;
        current = { dir, session: { project, revision, log: [] }, past: [], future: [], diskText };
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
          const source = p[from];
          const target = p[from === "past" ? "future" : "past"];
          const restored = source.at(-1);
          if (!restored) return snapshot(p);
          // The earlier project comes back, under a new revision.
          return yield* commit(p, { ...restored, revision: p.session.revision + 1 }, (previous) => {
            source.pop();
            target.push(previous);
          });
        }),
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
                  yield* fs.writeFileString(join(dir, ".gitignore"), ".cache/\n");
                  yield* writeFileAtomic(join(dir, "project.json"), text);
                }).pipe(
                  Effect.mapError(ioError(dir)),
                  Effect.tapError(() => fs.remove(dir, { recursive: true }).pipe(Effect.ignore)),
                );
              }),
            );
            return yield* setOpen(dir, project, text);
          }),
        ),

      open: (rawDir) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const dir = yield* realDir(rawDir, "The project folder");
            const text = yield* readProjectFile(dir);
            const project = yield* parseProject(dir, text);
            return yield* setOpen(dir, project, text);
          }),
        ),

      // Under the lock, so a read made after an edit was sent sees that edit.
      get: lock.withPermits(1)(Effect.map(requireOpen, snapshot)),

      close: lock.withPermits(1)(
        Effect.suspend(() => {
          if (current) lastRevision = Math.max(lastRevision, current.session.revision);
          current = undefined;
          return publish;
        }),
      ),

      changes: SubscriptionRef.changes(updates),

      reload: lock.withPermits(1)(
        Effect.gen(function* () {
          const p = yield* requireOpen;
          const text = yield* readProjectFile(p.dir);
          // An invalid file fails here and the current session stays as it was.
          const project = yield* parseProject(p.dir, text);
          // The undo stacks describe the file before the hand edit, so they go.
          const renamed = project.name !== p.session.project.name;
          p.session = { project, revision: p.session.revision + 1, log: [] };
          p.past = [];
          p.future = [];
          p.diskText = text;
          if (renamed) yield* recents.touch(p.dir, project.name);
          yield* publish;
          return snapshot(p);
        }),
      ),

      edit: ({ ops, baseRevision, summary }) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const p = yield* requireOpen;
            const opProblems = format.validateOps(ops);
            if (opProblems.length) return yield* refused("The edit is malformed", opProblems);
            if (baseRevision !== undefined && baseRevision > p.session.revision) {
              return yield* refused(`baseRevision ${baseRevision} is newer than the project (revision ${p.session.revision})`, [
                { code: "base-revision", path: "/baseRevision", message: "a revision from the future" },
              ]);
            }
            const applied = yield* Effect.try({
              try: () => applyEdit(p.session, { actor: "user", ops, baseRevision, summary }, format.validate) as Session,
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
            return yield* commit(p, { ...applied, project: written }, (previous) => {
              p.past.push(previous);
              p.future = [];
            });
          }),
        ),

      undo: step("past"),
      redo: step("future"),
    });
  }),
);
