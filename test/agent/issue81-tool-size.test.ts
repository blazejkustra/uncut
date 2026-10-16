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
  assert.match(SYSTEM_PROMPT, /edits \(every timeline_edit op's fields/);
  assert.match(edit.description, /docs_read edits/);
  // A shape spells out required and optional fields and enums.
  assert.equal(OP_SHAPES.trim_item, '{"op":"trim_item", item, edge: "start"|"end", frames}');
  assert.equal(OP_SHAPES.set_speed, '{"op":"set_speed", item, speed, keepPitch?}');
});

test("D285: long tool explanations live in their docs_read topic; the tool keeps a pointer", () => {
  const tools = mcpTools();
  const desc = (name: string) => tools.find((t) => t.name === name)!.description;
  const moved: Array<[string, keyof typeof DOCS, Array<string>]> = [
    ["library_search", "sound", ["vine boom, fahh, bruh", "answers with free sound-alikes and says so", "Openverse allows 20 searches a minute and 200 a day"]],
    ["graphic_write", "graphics", ["await uncut.frame(mediaId, seconds) gives a video's exact frame", "the graphic's own @font-face with a data: URL", "pass from (the graphic's file) and edits [{old, new}] instead of html: only the changed lines travel"]],
    ["media_download", "graphics", ["an OFL font such as Geist, Archivo or Inter", "name it after the family (\"Geist\", or \"Geist-Bold\" for one weight)"]],
    ["storyboard_propose", "production", ["({graphic, t}: drawn alone, nothing placed", "Up to 4 beats get one (the open, the drop, the busiest state, the last frame)"]],
    ["review_submit", "production", ["(hook, phone readability, motion, variety, sound, brand; a tutorial has no hook score", "style rules are findings unless the brief asks for them"]],
    ["project_check", "production", ["text read time (words ÷ 3 s, 2 s minimum", "music not ducked under speech, a canvas other than 4:5 (info)"]],
    ["shader_write", "picture", ["at most 64 steps, 4 loops, two deep", "nothing named uncut*; 16 KB"]],
    ["transcript_edit", "footage", ["its group's other parts (a take's camera, screen) get the same cuts", "A media that no main clip plays is cut where it plays."]],
    ["captions_make", "footage", ["each item at its own start, item picks it from any clip or sound"]],
  ];
  for (const [tool, topic, texts] of moved) {
    assert.match(desc(tool), new RegExp(`docs_read ${topic}`), tool);
    for (const text of texts) {
      assert.ok(DOCS[topic].body.includes(text), `${topic}: ${text}`);
      assert.ok(!desc(tool).includes(text), `${tool} still has: ${text}`);
    }
  }
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
          edit([{ op: "insert_item", track: "text", item: { id: "t1", type: "text", text: "Shake", start: 60, duration: 240 } }]),
          // A keyframed shake: the dry run used to echo every op back (20k chars in a real session).
          { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Shake", dryRun: true, ops: [{ op: "update_item", item: "t1", set: { keys: Array.from({ length: 60 }, (_, i) => ({ frame: i * 4, x: (i % 7) - 3, y: (i % 5) - 2, scale: 1.04, ease: "linear" })) } }] } },
          { tool: "modules_list", args: {} },
          { tool: "modules_list", args: { ids: ["effect.color", "nope.module"] } },
          { tool: "library_search", args: { kind: "sfx", source: "included" } },
          { tool: "render_frames", args: { frames: [0] } },
          { tool: "render_frames", args: { frames: Array.from({ length: 13 }, (_, i) => i) } },
        ],
      ]),
    );
    const { turnId } = await client.ok("agent.send", { prompt: "add a title" });
    await agent.until(() => agent.values.at(-1)?.turns.find((t: { id: string }) => t.id === turnId)?.status !== "running", 20000);
    const all = readFileSync(results, "utf8").trim().split("\n").map((l) => JSON.parse(l)) as Array<{ tool: string; result: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> } }>;
    const out = all.filter((x) => x.tool === "timeline_edit").map((x) => ({ isError: !!x.result.isError, size: x.result.content[0]!.text!.length, body: JSON.parse(x.result.content[0]!.text!) }));
    assert.equal(out.length, 6);
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
    // The dry run: lines and the diff, not the ops back.
    assert.equal(out[5]!.body.dryRun, true, JSON.stringify(out[5]!.body));
    assert.equal(out[5]!.body.ops, undefined);
    assert.equal(out[5]!.body.lines.length, 1);
    assert.ok(out[5]!.size < 1_000, `the dry run answered ${out[5]!.size} chars: ${JSON.stringify(out[5]!.body)}`);
    // modules_list: an index without arguments, whole modules by id.
    const [index, byId] = all.filter((x) => x.tool === "modules_list").map((x) => x.result.content[0]!.text!);
    assert.ok(index!.length < 10_000, `the modules index is ${index!.length} chars: ${index}`);
    const parsed = JSON.parse(index!);
    assert.match(parsed.modules.effect["effect.color"], /Exposure/);
    assert.doesNotMatch(index!, /\bD\d{2,3}\b/, "no decision ids in module purposes");
    const whole = JSON.parse(byId!);
    assert.equal(whole.modules[0].id, "effect.color");
    assert.ok(whole.modules[0].params.properties.exposure);
    assert.deepEqual(whole.unknown, ["nope.module"]);
    // library_search's bundled sounds: at most 16, the rest a "more" line.
    const sounds = JSON.parse(all.find((x) => x.tool === "library_search")!.result.content[0]!.text!);
    assert.equal(sounds.sounds.length, 16);
    assert.match(sounds.more, /more of \d+: narrow it with query or category/);
    assert.ok(JSON.stringify(sounds).length < 4_000, `library_search answered ${JSON.stringify(sounds).length} chars`);
    // render_frames: 768 px on the longest side by default, 12 frames a call at most.
    const [one, many] = all.filter((x) => x.tool === "render_frames");
    assert.match(one!.result.content[0]!.text!, /at 768×432/);
    assert.equal(one!.result.content.filter((c) => c.type === "image").length, 1);
    assert.equal(many!.result.isError, true);
    assert.match(many!.result.content[0]!.text!, /frames must be 1 to 12/);
  } finally {
    client.close();
    await server.stop();
  }
});
