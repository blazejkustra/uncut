// Issues #81 and #84 without a claude.
// - #81 (D236): each MCP tool carries only the $defs it reaches through its $refs (the whole shared
//   block in every tool was ~250k tokens per call); every Uncut tool the prompt or the per-message
//   tools line names is served (media_download was missing); the example end card names no real brand.
// - #84 (D237): the storyboard gate holds timeline_edit only in a turn that wrote the brief or
//   proposed the storyboard; a later small edit goes ahead while it waits or was sent back, and the
//   <plan> block says so. The prompt's new-video trigger no longer fires on "an empty timeline".
import { test } from "node:test";
import assert from "node:assert/strict";

import { ALL_DOCS, defsFor, mcpTools, SYSTEM_PROMPT, TOOL_NAMES } from "../../apps/server/src/agent/agentTools.ts";
import { gateOf, gateRefusal, planContext, userMessageText } from "../../apps/server/src/agent/agentPlan.ts";
import toolsSpec from "../../spec/agent/tools.json" with { type: "json" };

/** Every `#/$defs/x` a value refers to, outside nested $defs. */
function refs(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) refs(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref" && typeof v === "string") out.add(v);
      else if (k !== "$defs") refs(v, out);
    }
  return out;
}

test("#81: each tool carries only the defs it reaches, and the whole list stays small", () => {
  const tools = mcpTools();
  for (const t of tools) {
    const defs = (t.inputSchema.$defs ?? {}) as Record<string, unknown>;
    // Every ref resolves inside the tool's own schema (no cross-file refs left for the client).
    const all = new Set([...refs(t.inputSchema), ...Object.values(defs).flatMap((d) => [...refs(d)])]);
    for (const r of all) {
      assert.ok(r.startsWith("#/$defs/"), `${t.name}: ${r} isn't a local ref`);
      assert.ok(r.slice(8) in defs, `${t.name}: ${r} has no def`);
    }
    // And nothing it doesn't reach.
    // (timeline_edit also carries its convenience-op branch, D285, which isn't a shared def.)
    const own = t.name === "timeline_edit" ? ["convenienceOp"] : [];
    assert.deepEqual(Object.keys(defs).sort(), [...Object.keys(defsFor({ ...t.inputSchema, $defs: undefined })), ...own].sort(), t.name);
    const used = new Set([...all].map((r) => r.slice(8)));
    for (const k of Object.keys(defs)) assert.ok(used.has(k), `${t.name} carries ${k} it never refers to`);
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  assert.ok(Object.keys(byName.get("timeline_edit")!.inputSchema.$defs as object).includes("op"));
  assert.deepEqual(Object.keys(byName.get("project_read")!.inputSchema.$defs as object), ["range"]);
  assert.equal(byName.get("ui_show")!.inputSchema.$defs, undefined, "a tool with no refs gets no $defs");
  // The size bound: the list was 675k chars with the shared block copied into every tool.
  const size = JSON.stringify(tools).length;
  assert.ok(size < 90_000, `the tool list is ${size} chars`);
  for (const t of tools) if (t.name !== "timeline_edit") assert.ok(JSON.stringify(t.inputSchema.$defs ?? {}).length < 2_000, `${t.name}'s defs`);
});

test("#81: every Uncut tool the prompt or the docs name is served", () => {
  const served = new Set(mcpTools().map((t) => t.name));
  assert.ok(served.has("media_download"));
  assert.equal(served.size, TOOL_NAMES.length, "every listed name has its spec");
  const text = `${SYSTEM_PROMPT}\n${ALL_DOCS}`;
  // Full names (mcp__uncut__x).
  for (const [, name] of text.matchAll(/mcp__uncut__([a-z_]+)/g)) assert.ok(served.has(name!), `mcp__uncut__${name} isn't served`);
  // Short names: every tool the spec defines that the prompt mentions.
  for (const t of toolsSpec.tools) if (new RegExp(`\\b${t.name}\\b`).test(text)) assert.ok(served.has(t.name), `the prompt names ${t.name}, which isn't served`);
});

test("#81: the prompt's example end card names no real product", () => {
  assert.ok(!/"title":"Argent"|npx @swmansion\/argent/.test(`${SYSTEM_PROMPT}\n${ALL_DOCS}`));
  assert.match(ALL_DOCS, /component\.end-card[^\n]*"title":"<product name>"/);
});

test("#84: the gate holds only the turn that is planning; later small edits go ahead", () => {
  const brief = { film: "x", audience: "", duration: "", formats: [], assets: [], visual: "", hardLines: [], deliverables: [] };
  const sb = (status: "proposed" | "approved" | "declined") => ({ summary: "s", beats: [], status, ...(status === "declined" ? { note: "more logo" } : {}) });
  // This turn wrote the brief (or proposed the storyboard): refused until approved.
  assert.match(gateRefusal({ brief, reviews: [] }, gateOf({ brief, reviews: [] }, false, true))!, /no storyboard yet/);
  assert.match(gateRefusal({ brief, storyboard: sb("declined"), reviews: [] }, gateOf({ brief, storyboard: sb("declined"), reviews: [] }, false, true))!, /more logo/);
  assert.match(gateRefusal({ brief, storyboard: sb("proposed"), reviews: [] }, gateOf({ brief, storyboard: sb("proposed"), reviews: [] }, false, true))!, /waiting for the user's approval/);
  // A later turn (a small edit): never refused, pending or declined.
  for (const status of ["proposed", "declined"] as const) {
    const plan = { brief, storyboard: sb(status), reviews: [] };
    const gate = gateOf(plan, false, false);
    assert.equal(gateRefusal(plan, gate), undefined, status);
    assert.equal(gate.waiting, true);
  }
  assert.equal(gateRefusal({ brief, reviews: [] }, gateOf({ brief, reviews: [] }, false)), undefined, "no planning in this turn: not held");
  // D237 (review finding 3): a later turn's edit that adds more than SMALL_EDIT_INSERTS items is building scenes: refused.
  const scene = [1, 2, 3].map((n) => ({ op: "insert_item", track: "text", item: { id: `t${n}` } }));
  for (const status of ["proposed", "declined"] as const) {
    const plan = { brief, storyboard: sb(status), reviews: [] };
    assert.match(gateRefusal(plan, gateOf(plan, false, false), scene)!, /adds 3 items[\s\S]*ask_user[\s\S]*storyboard_propose/, status);
    assert.equal(gateRefusal(plan, gateOf(plan, false, false), [{ op: "update_item", item: "t1", set: { style: { size: 140 } } }]), undefined);
    assert.equal(gateRefusal(plan, gateOf(plan, false, false), scene.slice(0, 2)), undefined, "a title and its background");
  }
  assert.match(gateRefusal({ brief, reviews: [] }, gateOf({ brief, reviews: [] }, false), [...scene, { op: "insert_text", text: "x" }])!, /no storyboard yet[\s\S]*adds 4 items/);
  const ok = { brief, storyboard: sb("approved"), reviews: [] };
  assert.equal(gateRefusal(ok, gateOf(ok, false, false), scene), undefined, "approved: build away");
  assert.equal(gateRefusal({ reviews: [] }, gateOf({ reviews: [] }, false), scene), undefined, "no brief: no gate");
  // Approved, the skip setting or no brief: nothing waits.
  assert.equal(gateOf({ brief, storyboard: sb("approved"), reviews: [] }, false, true).closed, false);
  assert.equal(gateOf({ brief, reviews: [] }, true, true).closed, false);
  assert.equal(gateOf({ reviews: [] }, false, true).closed, false);
  // The message's <plan> tells the agent small edits go ahead.
  const ctx = planContext({ files: {}, skills: [], others: [] }, { brief, storyboard: sb("declined"), reviews: [] }, gateOf({ brief, storyboard: sb("declined"), reviews: [] }, false));
  assert.match(ctx, /The storyboard isn't approved: a small edit the user asks for goes ahead \(at most 2 new items per timeline_edit\); building the planned video waits/);
  assert.ok(!/The build waits for/.test(ctx));
});

test("#84: the prompt starts the production process on intent, not on an empty timeline", () => {
  assert.ok(!/an empty or nearly empty timeline/.test(SYSTEM_PROMPT));
  assert.match(SYSTEM_PROMPT, /A small, specific request \([^)]*\) is just done, even on an empty or new project: no brief, storyboard or critic loop/);
  assert.match(SYSTEM_PROMPT, /In a turn that writes the brief or proposes the storyboard, timeline_edit is refused until the storyboard is approved/);
});

test("#60 M2 (D232, D236): no user message reaches claude starting with /, skill or not", () => {
  for (const raw of ["/init", "/clear now", "/compact", "  /launch-promo-typo please", "\u200b/init", "/revoked-skill go"]) {
    const out = userMessageText(raw, []);
    assert.ok(!/^[\s\u200b-\u200d\u2060\ufeff]*\//.test(out), `${JSON.stringify(raw)} became ${JSON.stringify(out)}`);
    assert.ok(out.includes(raw.trimStart().replace(/^\u200b/, "")) || out.includes(raw.trimStart()), "the words stay");
  }
  assert.equal(userMessageText("/init", []), "The user wrote: /init");
  // A called skill becomes words, as before; a path later in the text stays as it is.
  assert.equal(userMessageText("/explainer for /tmp/x", ["explainer"]), "(skill explainer) for /tmp/x");
  assert.equal(userMessageText("cut /tmp/a.mp4", []), "cut /tmp/a.mp4");
});
