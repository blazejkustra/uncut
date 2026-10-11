#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json` in tests. It connects to the real
// MCP server from --mcp-config and plays the tool calls listed in $FAKE_PLAN (a JSON file:
// an array of turns, each an array of { tool, args }). "$rev" in args becomes the revision
// from the last project_read. The prompt it got is appended to $FAKE_PROMPT_LOG.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.uncut;
const prompt = argv.at(-1);
appendFileSync(process.env.FAKE_PROMPT_LOG, JSON.stringify({ prompt, resume: argv.includes("--resume") }) + "\n");
const counter = `${process.env.FAKE_PLAN}.turn`;
const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(n + 1));
const plan = JSON.parse(readFileSync(process.env.FAKE_PLAN, "utf8"))[n] ?? [];

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const server = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env } });
const waiting = new Map();
let id = 0;
createInterface({ input: server.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
const rpc = (method, params) => new Promise((r) => { const k = ++id; waiting.set(k, r); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: k, method, params }) + "\n"); });

await rpc("initialize", { protocolVersion: "2025-06-18" });
const tools = (await rpc("tools/list")).result.tools;
out({ type: "system", subtype: "init", session_id: "fake-session", model: "fake", tools: tools.map((t) => `mcp__uncut__${t.name}`), mcp_servers: [{ name: "uncut", status: "connected" }] });
let rev = 0;
for (const step of plan) {
  const args = JSON.parse(JSON.stringify(step.args ?? {}).replaceAll('"$rev"', String(rev)));
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${id}`, name: `mcp__uncut__${step.tool}`, input: args }] } });
  const r = (await rpc("tools/call", { name: step.tool, arguments: args })).result;
  if (step.tool === "project_read") rev = JSON.parse(r.content[0].text).revision;
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${id}`, is_error: !!r.isError, content: r.content.filter((c) => c.type === "text") }] } });
}
out({ type: "assistant", message: { content: [{ type: "text", text: `Done: ${plan.length} steps.` }] } });
out({ type: "result", subtype: "success", is_error: false, result: `Done: ${plan.length} steps.`, duration_ms: 10, num_turns: plan.length, session_id: "fake-session" });
server.kill();
