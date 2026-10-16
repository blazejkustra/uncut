// Issue #81 (D285): the tool definitions sent on every request stay small, and timeline_edit's
// smaller schema loses nothing: every op's shape and rules are in docs_read edits, the server
// checks each op strictly, and a wrong shape is refused with the shape it should have had.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DOCS, mcpTools, SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";
import { CONVENIENCE_OPS, CORE_OPS, EDITS_DOC, OP_SHAPES, shapeHint, unknownOp } from "../../apps/server/src/agent/tools/opShapes.ts";
import editOps from "../../spec/schema/edit-ops.schema.json" with { type: "json" };
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const size = (x: unknown) => JSON.stringify(x).length;

test("D285: timeline_edit's definition is under 9k chars and every tool together under 50k", () => {
  const tools = mcpTools();
  const edit = tools.find((t) => t.name === "timeline_edit")!;
  assert.ok(size(edit) < 9_000, `timeline_edit is ${size(edit)} chars`);
  assert.ok(size(tools) < 50_000, `the tool list is ${size(tools)} chars`);
});

test("D285: the edit ops stay strict in the schema; every op's shape is in the description or docs_read edits", () => {
  const edit = mcpTools().find((t) => t.name === "timeline_edit")!;
  const defs = edit.inputSchema.$defs as any;
  // Core ops keep their fields and types (no descriptions), set_transition also takes allowTrim.
  assert.deepEqual(defs.op.oneOf.map((b: any) => b.properties.op.const), editOps.$defs.op.oneOf.map((b) => b.properties.op.const));
  const trim = defs.op.oneOf.find((b: any) => b.properties.op.const === "trim_item");
  assert.deepEqual(trim.properties.edge, { enum: ["start", "end"] });
  assert.equal(trim.additionalProperties, false);
  assert.ok(defs.op.oneOf.find((b: any) => b.properties.op.const === "set_transition").properties.allowTrim);
  assert.doesNotMatch(JSON.stringify(defs.op), /"description"/);
  // The convenience ops: one branch, each listed with its fields in the description.
  assert.deepEqual(defs.convenienceOp.properties.op.enum, [...CONVENIENCE_OPS]);
  for (const op of CONVENIENCE_OPS) assert.ok(edit.description.includes(OP_SHAPES[op]!), op);
  // docs_read edits has every op with its shape, and the prompt names the topic.
  assert.equal(DOCS.edits.body, EDITS_DOC);
  for (const op of [...CORE_OPS, ...CONVENIENCE_OPS]) assert.ok(EDITS_DOC.includes(OP_SHAPES[op]!), op);
  assert.match(SYSTEM_PROMPT, /edits \(every timeline_edit op\)/);
  assert.match(edit.description, /docs_read edits/);
  // A shape spells out required and optional fields and enums.
  assert.equal(OP_SHAPES.trim_item, '{"op":"trim_item", item, edge: "start"|"end", frames}');
  assert.equal(OP_SHAPES.set_speed, '{"op":"set_speed", item, speed, keepPitch?}');
});

test("D285: an unknown op or a wrong shape names the expected shape", () => {
  assert.match(unknownOp([{ op: "add_text", text: "Hi" }])!, /unknown op "add_text"\. The ops: insert_item, .*insert_text.*docs_read edits/);
  assert.match(unknownOp(["trim_item"])!, /ops\[0\] must be an object/);
  assert.equal(unknownOp([{ op: "trim_item" }, { op: "insert_text" }]), undefined);
  assert.equal(shapeHint("ops[1] (insert_text): look must be a text-style module id"), `insert_text takes ${OP_SHAPES.insert_text}. docs_read edits has every field.`);
  assert.match(shapeHint("trim_item: must be equal to one of the allowed values"), /trim_item takes \{"op":"trim_item", item, edge: "start"\|"end", frames\}/);
  assert.equal(shapeHint("baseRevision 3 isn't a revision you read"), "");
});

// Through the real server, with the fake claude.
const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";
let root = "";
before(() => {
  if (!skip) root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-tool-size-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("D285: timeline_edit refuses a wrong shape with the shape it takes, and still applies a right one", { skip, timeout: 60000 }, async () => {
  mkdirSync(join(root, "projects"), { recursive: true });
  const plan = join(root, "plan.json");
  const results = join(root, "results.jsonl");
  writeFileSync(results, "");
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: results } });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const agent = client.subscribe("agent.subscribe");
    const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "P" });
    await agent.until((s) => s?.dir === snap.dir);
    const edit = (ops: Array<unknown>) => ({ tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Title", ops } });
    writeFileSync(
      plan,
      JSON.stringify([
        [
          { tool: "project_read" },
          edit([{ op: "add_text", text: "Hi" }]),
          edit([{ op: "insert_text", text: "Hi", start: 0, duration: 60 }]),
          edit([{ op: "trim_item", item: "x", edge: "middle", frames: 3 }]),
          edit([{ op: "insert_text", look: "text.big-title", text: "Hi", start: 0, duration: 60 }]),
        ],
      ]),
    );
    const { turnId } = await client.ok("agent.send", { prompt: "add a title" });
    await agent.until(() => agent.values.at(-1)?.turns.find((t: { id: string }) => t.id === turnId)?.status !== "running", 20000);
    const out = readFileSync(results, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.tool === "timeline_edit").map((x) => ({ isError: !!x.result.isError, body: JSON.parse(x.result.content[0].text) }));
    assert.equal(out.length, 4);
    assert.ok(out[0]!.isError);
    assert.match(out[0]!.body.refused, /unknown op "add_text".*insert_text/);
    assert.ok(out[1]!.isError);
    assert.match(out[1]!.body.refused, /insert_text\): look must be/);
    assert.equal(out[1]!.body.shapes, `insert_text takes ${OP_SHAPES.insert_text}. docs_read edits has every field.`);
    assert.ok(out[2]!.isError);
    assert.match(JSON.stringify(out[2]!.body.details), /trim_item: must be equal to one of the allowed values \(\\"start\\", \\"end\\"\)/);
    assert.match(out[2]!.body.shapes, /trim_item takes \{"op":"trim_item", item, edge: "start"\|"end", frames\}/);
    assert.equal(out[3]!.isError, false, JSON.stringify(out[3]!.body));
    assert.equal(out[3]!.body.ok, true);
  } finally {
    client.close();
    await server.stop();
  }
});
