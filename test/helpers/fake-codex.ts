#!/usr/bin/env node
// fake-codex (issue #106): `codex app-server` as Uncut drives it: JSON-RPC lines on stdio.
// initialize, then thread/start or thread/resume (whose config carries Uncut's MCP server: it is
// started here, tools/list once), then each turn/start plays the next turn of $FAKE_PLAN (the
// `<plan>.turn` counter file counts turns, so a respawn carries on) and ends with turn/completed.
// turn/interrupt ends the running turn as "interrupted". Stdin closing ends the process.
//   `codex --version`: prints a version. `codex app-server` + account/read: $FAKE_CODEX_ACCOUNT
//     ("chatgpt", "apiKey", "none": no sign-in needed, "signed-out"; default chatgpt).
// Steps:
//   { text, slow?: ms }  an agentMessage, streamed in pieces (item/agentMessage/delta), then whole
//   { think }            a reasoning item with a summary
//   { tool, args }       an mcpToolCall of Uncut's MCP server (really called through it; "$rev" in
//                        args becomes the revision from the last project_read)
//   { command, output?, approval? } a commandExecution; approval: an approval request goes to
//                        Uncut first and the command runs only if it's accepted
//   { usage: { input, output }, window? } a thread/tokenUsage/updated
//   { limit: {...} }     an account/rateLimits/updated with this snapshot
//   { sleep: ms }        wait (a Stop interrupts it)
//   { fail: { message, codexErrorInfo? } } end the turn as failed with this error
//   { crash: true }      exit at once, mid-turn (a line on stderr)
// $FAKE_RESUME_GONE=<thread id>: thread/resume of it fails (Codex lost it).
// Every turn appends { prompt, input, resume, threadId, turn, threadConfig (without the token),
// pid, mcpPid, mcpToken, approvals } to $FAKE_PROMPT_LOG; $FAKE_TOOLS_LOG gets the tools/list names.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

type Step =
  | { text: string; slow?: number }
  | { think: string }
  | { tool: string; args?: unknown }
  | { command: string; output?: string; approval?: boolean }
  | { usage: { input: number; output: number }; window?: number }
  | { limit: Record<string, unknown> }
  | { sleep: number }
  | { fail: { message: string; codexErrorInfo?: unknown } }
  | { crash: true };

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.164.0\n");
  process.exit(0);
}
const out = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const log = (file: string | undefined, value: unknown) => file && appendFileSync(file, `${JSON.stringify(value)}\n`);

let mcp: ChildProcess | undefined;
let mcpToken = "";
let mcpId = 0;
const mcpWaits = new Map<number, (reply: { result?: any; error?: { message: string } }) => void>();
const mcpCall = (method: string, params?: unknown) =>
  new Promise<{ result?: any; error?: { message: string } }>((resolve) => {
    const k = ++mcpId;
    mcpWaits.set(k, resolve);
    mcp!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: k, method, params })}\n`);
  });

const startMcp = async (cfg: { command: string; args: Array<string>; env: Record<string, string> }) => {
  mcpToken = cfg.env.UNCUT_AGENT_TOKEN ?? "";
  mcp = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: mcp.stdout! }).on("line", (line) => {
    const msg = JSON.parse(line);
    mcpWaits.get(msg.id)?.(msg);
    mcpWaits.delete(msg.id);
  });
  await mcpCall("initialize", { protocolVersion: "2025-06-18" });
  const listed = await mcpCall("tools/list");
  log(process.env.FAKE_TOOLS_LOG, ((listed.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name));
  return !!listed.result;
};

let threadId = "";
let resumed: string | null = null;
let threadConfig: Record<string, any> = {};
let running: { id: string; abort: AbortController } | undefined;
let requestId = 0;
const requestWaits = new Map<number, (result: any) => void>();
const ask = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = ++requestId;
    requestWaits.set(id, resolve);
    out({ id, method, params });
  });

class Interrupted extends Error {}
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Interrupted());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Interrupted())), { once: true });
  });

const note = (method: string, params: Record<string, unknown>) => out({ method, params: { threadId, ...params } });

async function playTurn(turnId: string, input: Array<Record<string, any>>, signal: AbortSignal) {
  const counter = `${process.env.FAKE_PLAN}.turn`;
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  const plan: Array<Step> = (JSON.parse(readFileSync(process.env.FAKE_PLAN!, "utf8")) as Array<Array<Step>>)[n] ?? [];
  const prompt = input.filter((i) => i.type === "text").map((i) => i.text).join("\n");
  const approvals: Array<unknown> = [];
  const { config: _config, ...shown } = threadConfig;
  const entry = { prompt, input: input.map((i) => (i.type === "image" ? { type: "image", url: String(i.url).slice(0, 30) } : i)), resume: resumed, threadId, turn: n, threadConfig: { ...shown, mcp: Object.keys(threadConfig.config?.mcp_servers ?? {}), mcpApproval: threadConfig.config?.mcp_servers?.uncut?.default_tools_approval_mode ?? null }, pid: process.pid, mcpPid: mcp?.pid, mcpToken, approvals };
  note("turn/started", { turn: { id: turnId, items: [], status: "inProgress", error: null } });
  let item = 0;
  const id = () => `item_${turnId}_${++item}`;
  let error: Record<string, unknown> | null = null;
  let rev = 0;
  try {
    for (const step of plan) {
      if ("text" in step) {
        const itemId = id();
        note("item/started", { turnId, item: { type: "agentMessage", id: itemId, text: "" } });
        const pieces = Math.max(1, Math.ceil(step.text.length / 12));
        const size = Math.ceil(step.text.length / pieces);
        for (let k = 0; k < step.text.length; k += size) {
          note("item/agentMessage/delta", { turnId, itemId, delta: step.text.slice(k, k + size) });
          if (step.slow) await pause(step.slow, signal);
        }
        note("item/completed", { turnId, item: { type: "agentMessage", id: itemId, text: step.text } });
      } else if ("think" in step) {
        const itemId = id();
        note("item/started", { turnId, item: { type: "reasoning", id: itemId, summary: [], content: [] } });
        note("item/reasoning/summaryTextDelta", { turnId, itemId, delta: step.think, summaryIndex: 0 });
        note("item/completed", { turnId, item: { type: "reasoning", id: itemId, summary: [step.think], content: [] } });
      } else if ("tool" in step) {
        const itemId = id();
        const args = JSON.parse(JSON.stringify(step.args ?? {}).replaceAll('"$rev"', String(rev)));
        const base = { type: "mcpToolCall", id: itemId, server: "uncut", tool: step.tool, arguments: args };
        note("item/started", { turnId, item: { ...base, status: "inProgress", result: null, error: null } });
        const got = await mcpCall("tools/call", { name: step.tool, arguments: args });
        const failed = !got.result || got.result.isError;
        if (step.tool === "project_read" && !failed) rev = JSON.parse(got.result.content[0].text).revision;
        note("item/completed", { turnId, item: { ...base, status: failed ? "failed" : "completed", result: got.result ? { content: got.result.content, structuredContent: null, _meta: null } : null, error: failed ? { message: got.error?.message ?? got.result?.content?.[0]?.text ?? "failed" } : null } });
      } else if ("command" in step) {
        const itemId = id();
        const base = { type: "commandExecution", id: itemId, command: `/bin/zsh -lc '${step.command}'`, cwd: threadConfig.cwd };
        note("item/started", { turnId, item: { ...base, status: "inProgress", aggregatedOutput: null, exitCode: null } });
        let decision = "accept";
        if (step.approval) {
          const answer = await ask("item/commandExecution/requestApproval", { threadId, turnId, itemId, command: base.command, cwd: base.cwd });
          decision = answer?.decision;
          approvals.push({ command: step.command, decision });
        }
        if (decision === "accept" || decision === "acceptForSession") note("item/completed", { turnId, item: { ...base, status: "completed", aggregatedOutput: step.output ?? "ok\n", exitCode: 0 } });
        else note("item/completed", { turnId, item: { ...base, status: "declined", aggregatedOutput: null, exitCode: null } });
      } else if ("usage" in step) {
        const last = { totalTokens: step.usage.input + step.usage.output, inputTokens: step.usage.input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: step.usage.output, reasoningOutputTokens: 0 };
        note("thread/tokenUsage/updated", { turnId, tokenUsage: { total: last, last, modelContextWindow: step.window ?? null } });
      } else if ("limit" in step) {
        out({ method: "account/rateLimits/updated", params: { rateLimits: step.limit } });
      } else if ("sleep" in step) {
        await pause(step.sleep, signal);
      } else if ("fail" in step) {
        error = { message: step.fail.message, codexErrorInfo: step.fail.codexErrorInfo ?? null, additionalDetails: null };
        break;
      } else if ("crash" in step) {
        log(process.env.FAKE_PROMPT_LOG, entry);
        process.stderr.write("fake-codex: crashed on purpose\n", () => process.exit(3));
        await new Promise(() => {});
      }
    }
    log(process.env.FAKE_PROMPT_LOG, entry);
    note("turn/completed", { turn: { id: turnId, items: [], status: error ? "failed" : "completed", error, durationMs: 1234 } });
  } catch (caught) {
    log(process.env.FAKE_PROMPT_LOG, entry);
    if (!(caught instanceof Interrupted)) throw caught;
    note("turn/completed", { turn: { id: turnId, items: [], status: "interrupted", error: null, durationMs: 10 } });
  }
}

const account = () => {
  const kind = process.env.FAKE_CODEX_ACCOUNT ?? "chatgpt";
  if (kind === "signed-out") return { account: null, requiresOpenaiAuth: true };
  if (kind === "none") return { account: null, requiresOpenaiAuth: false };
  return { account: kind === "apiKey" ? { type: "apiKey" } : { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true };
};

const openThread = async (params: Record<string, any>, id: number, resume: boolean) => {
  threadConfig = params;
  if (resume && process.env.FAKE_RESUME_GONE === params.threadId) return out({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
  const uncut = params.config?.mcp_servers?.uncut;
  if (uncut && !mcp) {
    const ok = await startMcp(uncut);
    note("mcpServer/startupStatus/updated", { name: "uncut", status: ok ? "ready" : "failed" });
  }
  threadId = resume ? params.threadId : randomUUID();
  resumed = resume ? params.threadId : null;
  out({ id, result: { thread: { id: threadId, model: params.model ?? "fake-codex-model", status: { type: "idle" } } } });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id !== undefined) {
    requestWaits.get(msg.id)?.(msg.result);
    requestWaits.delete(msg.id);
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") return out({ id, result: { userAgent: "fake-codex/0.164.0" } });
  if (method === "initialized") return;
  if (method === "account/read") return out({ id, result: account() });
  if (method === "thread/start") return void openThread(params, id, false);
  if (method === "thread/resume") return void openThread(params, id, true);
  if (method === "turn/start") {
    if (running) return out({ id, error: { code: -32600, message: "a turn is already running" } });
    const turnId = randomUUID();
    const abort = new AbortController();
    running = { id: turnId, abort };
    out({ id, result: { turn: { id: turnId, items: [], status: "inProgress", error: null } } });
    void playTurn(turnId, params.input ?? [], abort.signal).finally(() => {
      if (running?.id === turnId) running = undefined;
    });
    return;
  }
  if (method === "turn/interrupt") {
    if (running && running.id === params.turnId) running.abort.abort();
    return out({ id, result: {} });
  }
  if (id !== undefined) out({ id, error: { code: -32601, message: `fake-codex: no ${method}` } });
});
process.stdin.on("end", () => {
  mcp?.kill();
  process.exit(0);
});
