// A user or agent edit to the open project: checked (schema, D6, names), then committed (the projects layer).
import type { ProjectSnapshot } from "@uncut/contracts";
import { applyEdit, describeOp, EditConflict, EditError, type Op, type Project, type Session } from "@uncut/core";
import { withLinkedAudio } from "@uncut/core/arrange";
import * as Effect from "effect/Effect";

import type { ProjectFormatShape } from "../format.ts";
import type { NewRow } from "../history.ts";
import { authorWords, storedAgents } from "../history/agents.ts";
import { MAX_NAME_LENGTH, refused, serialize, toProblems } from "./helpers.ts";
import type { OpenProject } from "./service.ts";

export interface EditCtx<E> {
  readonly format: ProjectFormatShape;
  readonly commit: (p: OpenProject, next: Session, moveStacks: (previous: Session) => void, row: NewRow) => Effect.Effect<ProjectSnapshot, E>;
}

/** C12: an agent's edit refused because someone else changed what it touches after its base: who changed what. */
function conflictRefusal(p: OpenProject, error: EditConflict) {
  const agents = storedAgents(p.history.agentList());
  const byAuthor = new Map<string, Array<string>>();
  for (const [id, author] of error.by) byAuthor.set(author, [...(byAuthor.get(author) ?? []), id]);
  const said = [...byAuthor].map(([author, ids]) => `${ids.join(", ")} (changed by ${authorWords(author, agents)})`);
  const details = [...error.by].map(([id, author]) => ({
    code: "conflict",
    path: id,
    message: `"${id}" was changed by ${authorWords(author, agents)} after your baseRevision`,
  }));
  return refused(`Conflicts with newer edits to: ${said.join("; ")}. Read the project again and keep their changes.`, details);
}

export const makeEditUnlocked = <E>(ctx: EditCtx<E>) => {
  const { format, commit } = ctx;
  const editUnlocked = (
    p: OpenProject,
    { ops, baseRevision, summary }: { ops: ReadonlyArray<unknown>; baseRevision?: number | undefined; summary?: string | undefined },
    agent?: { readonly turnId: string; readonly dryRun?: boolean | undefined },
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
      const agentId = agent ? p.history.turnAgent(agent.turnId) : undefined;
      const applied = yield* Effect.try({
        // validateOps above checked every op against the edit-ops schema.
        try: () =>
          applyEdit(
            p.session,
            // D123: detached sounds still linked to their clip follow what the edit does to it.
            {
              actor: agent ? "agent" : "user",
              ops: withLinkedAudio(p.session.project as Project, ops as ReadonlyArray<Op>),
              baseRevision,
              summary,
              ...(agent ? { turnId: agent.turnId, agentId } : {}),
            },
            format.validate,
          ),
        catch: (error) =>
          error instanceof EditConflict && agent
            ? conflictRefusal(p, error)
            : error instanceof EditError
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
      // D206: a dry run stops here, with everything checked and nothing saved (the revision stays).
      if (agent?.dryRun)
        return {
          dir: p.dir,
          project: written,
          revision: p.session.revision,
          canUndo: p.past.length > 0,
          canRedo: p.future.length > 0,
        } satisfies ProjectSnapshot;
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
  return editUnlocked;
};
