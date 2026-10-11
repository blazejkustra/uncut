// The project format, from @uncut/core: installed modules and the validator.
import type { Problem } from "@uncut/contracts";
import { loadModules, validateOps, validateProject } from "@uncut/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config.ts";

export interface ProjectFormatShape {
  /** Every problem with the project; empty when it is valid. */
  readonly validate: (project: unknown) => ReadonlyArray<Problem>;
  /** Problems with a list of edit ops (edit-ops schema, no prototype keys, no renames). */
  readonly validateOps: (ops: unknown) => ReadonlyArray<Problem>;
}

export class ProjectFormat extends Context.Service<ProjectFormat, ProjectFormatShape>()("uncut/ProjectFormat") {}

export const layer = Layer.effect(
  ProjectFormat,
  Effect.gen(function* () {
    const { modulesDir } = yield* ServerConfig;
    // Without modules nothing validates, so a missing folder stops the server at startup.
    const modules = yield* Effect.tryPromise({
      try: () => loadModules(modulesDir),
      catch: (cause) => new Error(`can't load modules from ${modulesDir}: ${String(cause)}`),
    }).pipe(Effect.orDie);
    return ProjectFormat.of({ validate: (project) => validateProject(project, modules), validateOps });
  }),
);
