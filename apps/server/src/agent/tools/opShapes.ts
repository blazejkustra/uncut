// D285 (issue #81): timeline_edit's tool definition stays small. The edit ops keep a strict schema
// without their long descriptions; the convenience ops the server expands (insert_text,
// place_item, ...) go in as one loose branch plus one line each, and every op's fields and rules
// are docs_read edits (EDITS_DOC), generated from the same schemas so they can't drift. The server
// still checks each op strictly (core validateOps, the expanders' own checks) and a refusal names
// the op's shape (shapeHint).
import editOpsSchema from "../../../../../spec/schema/edit-ops.schema.json" with { type: "json" };
import toolsSpec from "../../../../../spec/agent/tools.json" with { type: "json" };
import { withoutDecisionIds } from "./decisionIds.ts";

type Schema = { [k: string]: unknown; properties?: Record<string, Schema>; required?: ReadonlyArray<string>; description?: string };

/** The edit ops core applies, in the schema's order. */
const CORE: ReadonlyArray<Schema> = editOpsSchema.$defs.op.oneOf as unknown as ReadonlyArray<Schema>;
export const CORE_OPS: ReadonlyArray<string> = CORE.map((b) => (b.properties!.op as { const: string }).const);

/** The convenience ops: name, the spec $def with their full shape, and a line for the tool description. */
const CONVENIENCE: ReadonlyArray<{ readonly op: string; readonly def: string; readonly line: string }> = [
  { op: "insert_text", def: "insertText", line: "text in a look (a text-style module) on the top-most free text track, with the looks it comes with" },
  { op: "insert_device_frame", def: "insertDeviceFrame", line: "a phone or browser frame with footage on its screen (the clip on a video track, the frame above it)" },
  { op: "place_item", def: "placeItem", line: "puts a new item (or moves one by id) where asked when free, else after what's in the way, on a free track of that kind, or rippling; the result's placed says where" },
  { op: "put_on_main", def: "putOnMain", line: "moves a picture off Main onto it at the nearest cut; a take's microphone and other parts get linked under it" },
  { op: "detach_audio", def: "detachAudio", line: "moves a clip's sound to its own audio item and mutes the clip" },
  { op: "set_speed", def: "setSpeed", line: "changes a clip's or audio item's speed (0.1 to 10) and its length with it" },
  { op: "replace_range", def: "replaceRange", line: "swaps timeline frames [from, to) of a clip or sound for another media from its frame in; nothing moves (stays in sync)" },
  { op: "edit_captions", def: "editCaptions", line: "fixes caption words (by transcript word id), forces card starts, changes mode, grouping or fillers" },
];
export const CONVENIENCE_OPS: ReadonlyArray<string> = CONVENIENCE.map((c) => c.op);
const DEFS = toolsSpec.$defs as unknown as Record<string, Schema>;

/** A value's shape in a few characters: enums spelled out, objects with their fields, the rest by name only. */
function shapeOf(s: Schema | undefined): string {
  if (!s || typeof s !== "object") return "";
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join("|");
  const union = (s.oneOf ?? s.anyOf) as ReadonlyArray<Schema> | undefined;
  if (union) return union.map((u) => shapeOf(u) || String(u.type ?? "")).filter(Boolean).join("|");
  if (s.type === "null") return "null";
  if (s.properties) return objectShape(s);
  if (s.type === "object") return "{…}";
  if (s.type === "array") return `[${shapeOf(s.items as Schema) || "…"}]`;
  return "";
}

function objectShape(s: Schema): string {
  const required = new Set(s.required ?? []);
  const fields = Object.entries(s.properties ?? {}).map(([k, v]) => {
    if (v.const !== undefined) return `"${k}":${JSON.stringify(v.const)}`;
    const t = shapeOf(v);
    return `${k}${required.has(k) ? "" : "?"}${t ? `: ${t}` : ""}`;
  });
  return `{${fields.join(", ")}}`;
}


/** Each op's shape, e.g. {"op":"trim_item", item, edge: "start"|"end", frames}. */
export const OP_SHAPES: Readonly<Record<string, string>> = Object.fromEntries([
  ...CORE.map((b) => [(b.properties!.op as { const: string }).const, (b.properties!.op as { const: string }).const === "set_transition" ? objectShape(b).replace(/\}$/, ", allowTrim?: true}") : objectShape(b)]),
  ...CONVENIENCE.map((c) => [c.op, objectShape(DEFS[c.def]!)]),
]);

/** Every description inside a schema's fields, as "field: text" (nested ones as a.b). */
function fieldNotes(s: Schema, prefix = ""): Array<string> {
  const out: Array<string> = [];
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    const name = `${prefix}${k}`;
    if (typeof v.description === "string" && name !== "transition.module") out.push(`${name}: ${v.description}`);
    for (const u of ((v.oneOf ?? v.anyOf) as ReadonlyArray<Schema> | undefined) ?? []) if (u.properties) out.push(...fieldNotes(u, `${name}.`));
    if (v.properties) out.push(...fieldNotes(v, `${name}.`));
    const items = v.items as Schema | undefined;
    if (items?.properties) out.push(...fieldNotes(items, `${name}[].`));
  }
  return out;
}

const entry = (shape: string, description: string | undefined, notes: ReadonlyArray<string>) =>
  `- ${shape}${description ? `\n  ${withoutDecisionIds(description)}` : ""}${notes.length ? `\n  ${notes.map(withoutDecisionIds).join(" ")}` : ""}`;

/** docs_read edits: every op's shape and rules. */
export const EDITS_DOC = [
  "Every timeline_edit op as its fields (? = optional). Positions and lengths are frames; ids are lowercase letters, digits and dashes.",
  "Edit ops:",
  ...CORE.map((b) => {
    const op = (b.properties!.op as { const: string }).const;
    return entry(OP_SHAPES[op]!, b.description, fieldNotes(b));
  }),
  "set_transition with allowTrim true: " + withoutDecisionIds(DEFS.setTransitionTrim!.description ?? ""),
  "Convenience ops (Uncut turns each into edit ops before the edit runs):",
  ...CONVENIENCE.map((c) => entry(OP_SHAPES[c.op]!, DEFS[c.def]!.description, fieldNotes(DEFS[c.def]!))),
].join("\n");

/** The convenience ops for timeline_edit's description, one line each. */
export const CONVENIENCE_LINES = CONVENIENCE.map((c) => `- ${OP_SHAPES[c.op]}: ${c.line}.`).join("\n");

/**
 * A refusal's hint: the shape of each op it names, so the model can fix the call without reading
 * the docs first. Finds op names in "ops[2] (insert_text): ..." and "trim_item: must be ..." alike.
 */
export function shapeHint(...texts: ReadonlyArray<string>): string {
  const named = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)) if (m[1]! in OP_SHAPES) named.add(m[1]!);
  if (!named.size) return "";
  return `${[...named].map((op) => `${op} takes ${OP_SHAPES[op]}`).join("; ")}. docs_read edits has every field.`;
}

/** An op whose name is neither an edit op nor a convenience op, as a refusal; undefined when all are known. */
export function unknownOp(ops: ReadonlyArray<unknown>): string | undefined {
  for (const [i, op] of ops.entries()) {
    const name = (op as { op?: unknown } | null)?.op;
    if (!op || typeof op !== "object" || Array.isArray(op)) return `ops[${i}] must be an object like {"op":"trim_item", ...}.`;
    if (typeof name !== "string" || !(name in OP_SHAPES)) return `ops[${i}]: unknown op ${JSON.stringify(name)}. The ops: ${Object.keys(OP_SHAPES).join(", ")}. docs_read edits gives each one's fields.`;
  }
  return undefined;
}

/**
 * timeline_edit's ops schema for the MCP tool list: the edit ops strict (fields, types, enums) but
 * without their descriptions, and the convenience ops as one branch the server checks.
 */
export function opsSchema(): { ops: Record<string, unknown>; defs: Record<string, unknown> } {
  const strip = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "description").map(([k, x]) => [k, strip(x)])) : v;
  const core = strip(editOpsSchema.$defs.op) as { oneOf: Array<Schema> };
  // set_transition also takes allowTrim (the server trims the spare media an overlap lacks).
  const st = core.oneOf.find((b) => (b.properties!.op as { const: string }).const === "set_transition")!;
  st.properties = { ...st.properties, allowTrim: { type: "boolean" } };
  return {
    ops: { type: "array", minItems: 1, items: { anyOf: [{ $ref: "#/$defs/op" }, { $ref: "#/$defs/convenienceOp" }] } },
    defs: {
      op: core,
      convenienceOp: { type: "object", required: ["op"], properties: { op: { enum: [...CONVENIENCE_OPS] } }, description: "Fields as listed in this tool's description." },
    },
  };
}
