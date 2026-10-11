// Types for the parts of @uncut/core the renderer uses. Only these two subpaths: the package root
// also re-exports the validator, which needs node:fs and can't be bundled for the browser.
declare module "@uncut/core/timeline" {
  import type { Item, ProjectModel, Track } from "./project.ts";
  export function layout(project: ProjectModel): { starts: Map<string, number>; duration: number };
  export function visualsAt(
    project: ProjectModel,
    starts: Map<string, number>,
    frame: number,
  ): Array<{ item: Item; track: Track; opacity: number; source: number }>;
}

declare module "@uncut/core/render" {
  import type { Item } from "./project.ts";
  export function esc(s: unknown): string;
  export function textHtml(item: Item, canvas: { width: number; height: number }, options?: { opacity?: number; selected?: boolean }): string;
}
