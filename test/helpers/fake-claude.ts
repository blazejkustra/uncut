#!/usr/bin/env node
// Stands in for `claude` in tests, so they never use a real subscription.
//   claude --version / claude auth status --json: answers like a signed-in Claude Code.
//   claude -p --output-format stream-json ...: reads the prompt from stdin, connects to the real
//   MCP server from --mcp-config (exactly as claude would start it) and plays the steps listed
//   in $FAKE_PLAN for this turn, printing stream-json like claude does.
// $FAKE_PLAN is a JSON file: an array of turns, each an array of steps:
//   { tool, args }  call an MCP tool ("$rev" in args becomes the revision from the last project_read)
//   { text, split? } say something (split: cut the line inside a multi-byte character)
//   { sleep: ms }   wait (so a test can cancel mid-turn)
//   { fail: msg }   end the turn with an error result
//   { await: path } wait (up to 5 min) for the JSON file at path, an array of steps, and play them
//                   next: the test decides them from the results so far, like claude would
// Every run appends { prompt, resume, env (variable names only), pid, mcpPid, mcpToken, ... } to $FAKE_PROMPT_LOG,
// and, with $FAKE_RESULT_LOG, every tool result ({ tool, result }) to that file.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("2.1.0 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
  process.exit(0);
}

type Step = { tool: string; args?: unknown } | { text: string; split?: boolean } | { sleep: number } | { fail: string } | { await: string };
interface RpcReply {
  id: number;
  result?: any;
  error?: { message: string };
}

const prompt = await new Promise<string>((resolve) => {
  let text = "";
  process.stdin.on("data", (d) => (text += d));
  process.stdin.on("end", () => resolve(text));
});
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const cfg = JSON.parse(readFileSync(flag("--mcp-config")!, "utf8")).mcpServers.uncut as { command: string; args: Array<string>; env: Record<string, string> };

const counter = `${process.env.FAKE_PLAN}.turn`;
const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(n + 1));
const plan: Array<Step> = (JSON.parse(readFileSync(process.env.FAKE_PLAN!, "utf8")) as Array<Array<Step>>)[n] ?? [];

const out = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const server = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "inherit"] });
appendFileSync(
  process.env.FAKE_PROMPT_LOG!,
  `${JSON.stringify({ prompt, resume: flag("--resume") ?? null, env: Object.keys(process.env), pid: process.pid, mcpPid: server.pid, mcpToken: cfg.env.UNCUT_AGENT_TOKEN, system: flag("--append-system-prompt"), tools: flag("--tools"), allowed: flag("--allowedTools") })}\n`,
);
const waiting = new Map<number, (m: RpcReply) => void>();
let id = 0;
createInterface({ input: server.stdout! }).on("line", (l) => {
  const m = JSON.parse(l) as RpcReply;
  waiting.get(m.id)?.(m);
});
const rpc = (method: string, params?: unknown) =>
  new Promise<RpcReply>((resolve) => {
    const k = ++id;
    waiting.set(k, resolve);
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: k, method, params })}\n`);
  });

await rpc("initialize", { protocolVersion: "2025-06-18" });
const listed = await rpc("tools/list");
const tools = (listed.result?.tools ?? []) as Array<{ name: string }>;
out({
  type: "system",
  subtype: "init",
  session_id: "fake-session",
  model: "fake",
  tools: tools.map((t) => `mcp__uncut__${t.name}`),
  mcp_servers: [{ name: "uncut", status: listed.result ? "connected" : "failed" }],
});
let rev = 0;
let steps = 0;
for (let k = 0; k < plan.length; k++) {
  const step = plan[k]!;
  if ("await" in step) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!existsSync(step.await) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    let more: unknown;
    try {
      more = existsSync(step.await) ? JSON.parse(readFileSync(step.await, "utf8")) : undefined;
    } catch {}
    plan.splice(k + 1, 0, ...(Array.isArray(more) ? (more as Array<Step>) : [{ fail: existsSync(step.await) ? `${step.await} isn't a list of steps` : `no steps at ${step.await} within 5 minutes` }]));
    continue;
  }
  if ("sleep" in step) {
    await new Promise((r) => setTimeout(r, step.sleep));
    continue;
  }
  if ("text" in step) {
    const line = Buffer.from(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: step.text }] } })}\n`);
    // split: write the line in two pieces cut inside its first multi-byte character, as a pipe can.
    const at = step.split ? line.findIndex((b) => b >= 0x80) + 1 : 0;
    if (at > 0) {
      process.stdout.write(line.subarray(0, at));
      await new Promise((r) => setTimeout(r, 150));
      process.stdout.write(line.subarray(at));
    } else process.stdout.write(line);
    continue;
  }
  if ("fail" in step) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: step.fail, duration_ms: 10, num_turns: steps, session_id: "fake-session" });
    server.kill();
    process.exit(1);
  }
  steps++;
  const args = JSON.parse(JSON.stringify(step.args ?? {}).replaceAll('"$rev"', String(rev)));
  const useId = `toolu_${steps}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: useId, name: `mcp__uncut__${step.tool}`, input: args }] } });
  const r = (await rpc("tools/call", { name: step.tool, arguments: args })).result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  if (process.env.FAKE_RESULT_LOG) appendFileSync(process.env.FAKE_RESULT_LOG, `${JSON.stringify({ tool: step.tool, result: r })}\n`);
  if (step.tool === "project_read" && !r.isError) rev = JSON.parse(r.content[0]!.text).revision;
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: useId, is_error: !!r.isError, content: r.content }] } });
}
const said = `Done: ${steps} step${steps === 1 ? "" : "s"}.`;
out({ type: "assistant", message: { content: [{ type: "text", text: said }] } });
out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: 10, num_turns: steps, session_id: "fake-session" });
server.kill();
