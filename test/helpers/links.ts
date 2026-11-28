// D347: an edit's ops with what its links add (core withLinks), as the server applies them.
import type { Op, Project } from "../../packages/core/src/index.ts";
import { withLinks } from "../../packages/core/src/timeline/arrange.ts";

export function linkedOps(project: Project, ops: ReadonlyArray<Op>): ReadonlyArray<Op> {
  const linked = withLinks(project, ops);
  if ("problem" in linked) throw new Error(linked.problem);
  return linked.ops;
}
