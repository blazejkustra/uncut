// fake-claude's long-lived session (D139): `claude -p --input-format stream-json
// --output-format stream-json ...` as Uncut keeps it open per project chat. One process, one MCP
// server (from --mcp-config), system/init once; every stream-json user line on stdin is a message
// that plays the next turn of $FAKE_PLAN (the `<plan>.turn` counter file counts messages, so a
// respawn with --resume carries on), ending with one `result`. Stdin closing ends the process.
//   control_request interrupt: the turn stops where it is, a control_response, then an error
//     result ("Interrupted by the user"); the process keeps running ($FAKE_IGNORE_INTERRUPT: no
//     answer at all, so Uncut has to kill it).
//   --include-partial-messages: text and thinking also stream as stream_event deltas first.
// Steps (on top of fake-claude.ts's { tool, args } / { text, split } / { sleep } / { fail } / { await }):
//   { think: "..." }   a thinking block (streamed with partial messages, then in the full message)
//   { text, slow: ms } stream the text in pieces, ms apart (a test can look mid-stream)
//   { crash: true }    exit at once, mid-turn, with no result (and a line on stderr)
//   { exit: true }     finish the turn, then exit (as an idle claude that went away)
//   { missing: name, args } claude's own failure for a tool it doesn't have (bare name): the call
//     shows, then an is_error tool_result "No such tool available" (the MCP server isn't asked)
//   { tool, args, slowInput: ms } the call's input streams in pieces, ms apart (input_json_delta)
// $FAKE_LINGER: stdin closing doesn't end it.
// $FAKE_NO_THINKING_DISPLAY: started with --thinking-display, it says commander's unknown-option
//   error on stderr and exits 1 before init (as a claude that doesn't know the flag).
// $FAKE_RESUME_GONE=<id>: started with --resume <id>, it says "No conversation found" and exits.
// Every message appends { prompt, resume, message, env, pid, mcpPid, mcpToken, system, tools,
// allowed, partial } to $FAKE_PROMPT_LOG (resume: the session it continued, null for the very
// first message), and $FAKE_TOOLS_LOG gets the tools/list names once per process.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Step =
  | { tool: string; args?: unknown; slowInput?: number }
  | { missing: string; args?: unknown }
  | { text: string; split?: boolean; slow?: number }
  | { think: string }
  | { sleep: number }
  | { fail: string }
  | { await: string }
  | { crash: true }
  | { exit: true };
interface RpcReply {
  id: number;
  result?: any;
  error?: { message: string };
}

const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const partial = argv.includes("--include-partial-messages");
const resume = flag("--resume") ?? null;
const out = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

if (process.env.FAKE_NO_THINKING_DISPLAY && argv.includes("--thinking-display")) {
  if (process.env.FAKE_PROMPT_LOG) appendFileSync(process.env.FAKE_PROMPT_LOG, `${JSON.stringify({ refused: "--thinking-display", argv })}\n`);
  process.stderr.write("error: unknown option '--thinking-display'\n", () => process.exit(1));
  await new Promise(() => {});
}
if (resume && process.env.FAKE_RESUME_GONE === resume) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`, () => process.exit(1));
  await new Promise(() => {});
}

const sessionId = resume ?? "fake-session";
const cfg = JSON.parse(readFileSync(flag("--mcp-config")!, "utf8")).mcpServers.uncut as { command: string; args: Array<string>; env: Record<string, string>; alwaysLoad?: boolean };
const server = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map<number, (m: RpcReply) => void>();
let rpcId = 0;
createInterface({ input: server.stdout! }).on("line", (l) => {
  const m = JSON.parse(l) as RpcReply;
  waiting.get(m.id)?.(m);
});
const rpc = (method: string, params?: unknown) =>
  new Promise<RpcReply>((resolve) => {
    const k = ++rpcId;
    waiting.set(k, resolve);
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: k, method, params })}\n`);
  });
const quit = (code: number) => {
  server.kill();
  process.exit(code);
};

await rpc("initialize", { protocolVersion: "2025-06-18" });
const listed = await rpc("tools/list");
const tools = (listed.result?.tools ?? []) as Array<{ name: string }>;
if (process.env.FAKE_TOOLS_LOG) appendFileSync(process.env.FAKE_TOOLS_LOG, `${JSON.stringify(tools.map((t) => t.name))}\n`);
out({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: "fake",
  tools: tools.map((t) => `mcp__uncut__${t.name}`),
  mcp_servers: [{ name: "uncut", status: listed.result ? "connected" : "failed" }],
});

/** Raised inside a turn when an interrupt arrives. */
class Interrupted extends Error {}
let abort: AbortController | undefined;
const pause = (ms: number) =>
  new Promise<void>((resolve, reject) => {
    const signal = abort?.signal;
    if (signal?.aborted) return reject(new Interrupted());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Interrupted())), { once: true });
  });
/** A promise that rejects as soon as the turn is interrupted. */
const orStop = <T>(p: Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    const signal = abort?.signal;
    if (signal?.aborted) return reject(new Interrupted());
    signal?.addEventListener("abort", () => reject(new Interrupted()), { once: true });
    p.then(resolve, reject);
  });

let messages = 0;
let continued: string | null = resume;
let msgCount = 0;
/** One assistant message: streamed first with partial messages, then whole. */
async function assistant(block: { type: "text"; text: string } | { type: "thinking"; thinking: string }, slow = 0) {
  const id = `msg_${process.pid}_${++msgCount}`;
  if (partial) {
    out({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant", content: [] } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: block.type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" } }, parent_tool_use_id: null, session_id: sessionId });
    const words = block.type === "text" ? block.text : block.thinking;
    const pieces = Math.min(4, Math.max(1, Math.ceil(words.length / 12)));
    const size = Math.ceil(words.length / pieces);
    for (let k = 0; k < words.length; k += size) {
      const piece = words.slice(k, k + size);
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: block.type === "text" ? { type: "text_delta", text: piece } : { type: "thinking_delta", thinking: piece } }, parent_tool_use_id: null, session_id: sessionId });
      if (slow) await pause(slow);
    }
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null, session_id: sessionId });
  }
  return id;
}

async function playTurn(prompt: string, images: Array<{ media_type: string; bytes: number }>) {
  const counter = `${process.env.FAKE_PLAN}.turn`;
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  const plan: Array<Step> = (JSON.parse(readFileSync(process.env.FAKE_PLAN!, "utf8")) as Array<Array<Step>>)[n] ?? [];
  messages++;
  if (process.env.FAKE_PROMPT_LOG) {
    appendFileSync(
      process.env.FAKE_PROMPT_LOG,
      `${JSON.stringify({
        prompt,
        resume: continued,
        message: messages,
        env: Object.keys(process.env),
        // D181: the values that matter for isolation and tool loading.
        envValues: Object.fromEntries(["ENABLE_TOOL_SEARCH", "CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"].map((k) => [k, process.env[k] ?? null])),
        argv,
        alwaysLoad: cfg.alwaysLoad ?? null,
        images,
        pid: process.pid,
        mcpPid: server.pid,
        mcpToken: cfg.env.UNCUT_AGENT_TOKEN,
        system: flag("--append-system-prompt"),
        tools: flag("--tools"),
        allowed: flag("--allowedTools"),
        partial,
      })}\n`,
    );
  }
  continued = sessionId;
  let rev = 0;
  let steps = 0;
  let exitAfter = false;
  const started = Date.now();
  for (let k = 0; k < plan.length; k++) {
    const step = plan[k]!;
    if ("await" in step) {
      const deadline = Date.now() + 5 * 60 * 1000;
      while (!existsSync(step.await) && Date.now() < deadline) await pause(100);
      let more: unknown;
      try {
        more = existsSync(step.await) ? JSON.parse(readFileSync(step.await, "utf8")) : undefined;
      } catch {}
      plan.splice(k + 1, 0, ...(Array.isArray(more) ? (more as Array<Step>) : [{ fail: existsSync(step.await) ? `${step.await} isn't a list of steps` : `no steps at ${step.await} within 5 minutes` }]));
      continue;
    }
    if ("sleep" in step) {
      await pause(step.sleep);
      continue;
    }
    if ("crash" in step) {
      process.stderr.write("fake-claude: crashed on purpose\n", () => quit(3));
      return await new Promise<never>(() => {});
    }
    if ("exit" in step) {
      exitAfter = true;
      continue;
    }
    if ("think" in step) {
      const id = await assistant({ type: "thinking", thinking: step.think });
      out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "thinking", thinking: step.think, signature: "fake" }] }, parent_tool_use_id: null, session_id: sessionId });
      continue;
    }
    if ("text" in step) {
      const id = await assistant({ type: "text", text: step.text }, step.slow ?? 0);
      const line = Buffer.from(`${JSON.stringify({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text: step.text }] }, parent_tool_use_id: null, session_id: sessionId })}\n`);
      // split: write the line in two pieces cut inside its first multi-byte character, as a pipe can.
      const at = step.split ? line.findIndex((b) => b >= 0x80) + 1 : 0;
      if (at > 0) {
        process.stdout.write(line.subarray(0, at));
        await pause(150);
        process.stdout.write(line.subarray(at));
      } else process.stdout.write(line);
      continue;
    }
    if ("fail" in step) {
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: step.fail, duration_ms: Date.now() - started, num_turns: steps, session_id: sessionId });
      return;
    }
    if ("missing" in step) {
      steps++;
      const useId = `toolu_${process.pid}_${messages}_${steps}`;
      const id = `msg_${process.pid}_${++msgCount}`;
      out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "tool_use", id: useId, name: step.missing, input: step.args ?? {} }] }, parent_tool_use_id: null, session_id: sessionId });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, is_error: true, content: `<tool_use_error>Error: No such tool available: ${step.missing}</tool_use_error>` }] }, parent_tool_use_id: null, session_id: sessionId });
      continue;
    }
    steps++;
    const args = JSON.parse(JSON.stringify(step.args ?? {}).replaceAll('"$rev"', String(rev)));
    const useId = `toolu_${process.pid}_${messages}_${steps}`;
    const id = `msg_${process.pid}_${++msgCount}`;
    if (partial) {
      out({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant", content: [] } }, parent_tool_use_id: null, session_id: sessionId });
      out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: useId, name: `mcp__uncut__${step.tool}`, input: {} } }, parent_tool_use_id: null, session_id: sessionId });
      const json = JSON.stringify(args);
      if ("slowInput" in step && step.slowInput) {
        // In 4 pieces, ms apart: a test can look at the now line while the input streams.
        const size = Math.ceil(json.length / 4);
        for (let k = 0; k < json.length; k += size) {
          out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(k, k + size) } }, parent_tool_use_id: null, session_id: sessionId });
          await pause(step.slowInput);
        }
      } else out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json } }, parent_tool_use_id: null, session_id: sessionId });
      out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null, session_id: sessionId });
    }
    out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "tool_use", id: useId, name: `mcp__uncut__${step.tool}`, input: args }] }, parent_tool_use_id: null, session_id: sessionId });
    const r = (await orStop(rpc("tools/call", { name: step.tool, arguments: args }))).result as { isError?: boolean; content: Array<{ type: string; text: string }> };
    if (process.env.FAKE_RESULT_LOG) appendFileSync(process.env.FAKE_RESULT_LOG, `${JSON.stringify({ tool: step.tool, result: r })}\n`);
    if (step.tool === "project_read" && !r.isError) rev = JSON.parse(r.content[0]!.text).revision;
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, is_error: !!r.isError, content: r.content }] }, parent_tool_use_id: null, session_id: sessionId });
  }
  const said = `Done: ${steps} step${steps === 1 ? "" : "s"}.`;
  const id = await assistant({ type: "text", text: said });
  out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text: said }] }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: Date.now() - started, num_turns: steps, session_id: sessionId });
  if (exitAfter) await new Promise<void>((r) => process.stdout.write("", () => r())).then(() => quit(0));
}

// Messages are played one at a time, in order; control requests are answered at once.
const queue: Array<{ prompt: string; images: Array<{ media_type: string; bytes: number }> }> = [];
let busy = false;
const pump = async () => {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const next = queue.shift()!;
    abort = new AbortController();
    try {
      await playTurn(next.prompt, next.images);
    } catch (error) {
      if (!(error instanceof Interrupted)) throw error;
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Interrupted by the user", duration_ms: 1, num_turns: 0, session_id: sessionId });
    }
    abort = undefined;
  }
  busy = false;
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "control_request") {
    if (msg.request?.subtype === "interrupt") {
      if (process.env.FAKE_IGNORE_INTERRUPT) return;
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
      abort?.abort();
      return;
    }
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type === "user") {
    const content = msg.message?.content;
    const prompt = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "";
    const images = Array.isArray(content) ? content.filter((c: any) => c.type === "image").map((c: any) => ({ media_type: c.source?.media_type, bytes: Buffer.from(String(c.source?.data ?? ""), "base64").length })) : [];
    queue.push({ prompt, images });
    void pump();
  }
});
// Uncut closed our input (idle, or the project closed): finish the turn in hand, then go.
process.stdin.on("end", async () => {
  // $FAKE_LINGER: a claude that doesn't exit when its input closes (Uncut has to kill it).
  if (process.env.FAKE_LINGER) return;
  while (busy) await new Promise((r) => setTimeout(r, 50));
  process.stdout.write("", () => quit(0));
});
