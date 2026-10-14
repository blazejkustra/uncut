// What the element Inspector reads from a component manifest's params schema (D76, D130): each
// param's type, its group (x-group, else one by its type) and unit (x-unit), its label, and the
// props with one param set (update_item replaces props whole, so every edit sends all of them).
import { findItem } from "../../timeline/edit.ts";
import type { ProjectModel } from "../../state/project.ts";

export type Schema = {
  readonly type?: string;
  readonly enum?: ReadonlyArray<unknown>;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: Schema;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly "x-control"?: string;
  readonly "x-group"?: string;
  readonly "x-unit"?: string;
};

const WORDS: Readonly<Record<string, string>> = { url: "URL", typeFrom: "Type from (frame)", speed: "Speed (characters/s)", max: "Full bar at", at: "At frame", code: "Code", kind: "Kind", strokeWidth: "Stroke width", borderWidth: "Border width", pressAt: "Press at" };
/** A param's label: "typeFrom" → "Type from (frame)", "title" → "Title". */
export const labelOf = (key: string) => WORDS[key] ?? `${key[0]!.toUpperCase()}${key.slice(1).replace(/([A-Z])/g, " $1").toLowerCase()}`;
/** A list's row in words: "bars" → "bar", "lines" → "line". */
export const rowWord = (key: string) => key.replace(/s$/, "");

/** The section order; params without an x-group get one from their type. */
export const GROUPS = ["Content", "Style", "Layout", "Motion"] as const;
export function groupOf(schema: Schema): string {
  const g = schema["x-group"];
  if (g) return g;
  if (schema["x-control"] === "color" || schema.type === "boolean" || schema.enum) return "Style";
  if (schema.type === "number" || schema.type === "integer") return "Layout";
  return "Content";
}

/** The props as they are in `p` (the newest project), with `key` set (undefined removes it). */
export const withProp = (p: ProjectModel, id: string, key: string, value: unknown) => {
  const props: Record<string, unknown> = { ...((findItem(p, id)?.item.props ?? {}) as Record<string, unknown>) };
  if (value === undefined) delete props[key];
  else props[key] = value;
  return props;
};
