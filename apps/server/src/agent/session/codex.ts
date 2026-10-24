// Issue #106: a session's Codex: `codex app-server`, JSON-RPC 2.0 lines on stdio (the protocol
// `codex app-server generate-ts` describes). One app-server per project chat, like claude's
// session (D139): initialize, then a thread (Codex's conversation: started, or resumed from its id),
// then a turn/start per message; its item notifications become the turn's items, turn/completed
// ends it, turn/interrupt is Stop. Uncut's tools reach Codex through the same MCP server (mcp.ts),
// pre-approved (Uncut gates them itself, `allowed`); Codex's own approvals (a command, a file
// change) are decided like claude's can_use_tool (permit), so the access choice means the same.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { Access } from "../agentPermissions.ts";
import { CODEX_SYSTEM_PROMPT, skillsPrompt } from "../agentTools.ts";
import { codexLimitNotice, codexTurnError } from "../agentLimits.ts";
import { asksNoQuestions, reviewNudge } from "../agentPlan.ts";
import { codexEnv } from "../../app/shellEnv.ts";
import { which } from "../../app/setup.ts";
import { besideServer } from "../../paths.ts";
import { isString, RESULT_MAX } from "../turns/history.ts";
import { CODEX_PID, TURN_DIR_PREFIX } from "./stale.ts";
import { contextOf, messageContextEstimate, systemToolsEstimate } from "./usage.ts";
import type { ClaudeSession, CodexLink, Loaded, Running } from "./types.ts";
import { forgetSentBlocks } from "./send.ts";
import type { StreamCtx } from "./stream.ts";

/** owner.sessionId of a Codex conversation: its thread id with this prefix (a claude session id has none). */
export const CODEX_SESSION = "codex:";

/** The codex binary: UNCUT_CODEX (tests, or a custom install), else the first on PATH. */
export const findCodex = async (env: NodeJS.ProcessEnv = process.env) => env.UNCUT_CODEX || (await which("codex", env.PATH ?? ""));

/**
 * D184/D214 for Codex: Look only reads in a read-only sandbox and is never asked anything; Ask first
 * asks for every command Codex doesn't trust (untrusted); Auto lets Codex ask only when it needs
 * more than the project folder (on-request). Whatever Codex asks goes through permit.
 */
export const codexPolicy = (access: Access) =>
  access === "look" ? { sandbox: "read-only", approvalPolicy: "never" } : { sandbox: "workspace-write", approvalPolicy: access === "ask" ? "untrusted" : "on-request" };

/** A Codex command for the work log: without the login shell wrapper (`/bin/zsh -lc 'ls media'` → `ls media`). */
export const codexCommand = (command: unknown) => {
  const c = isString(command) ? command.trim() : "";
  const m = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(c);
  if (!m) return c;
  const body = m[1]!.trim();
  return /^'[\s\S]*'$/.test(body) || /^"[\s\S]*"$/.test(body) ? body.slice(1, -1) : body;
};

const write = (s: ClaudeSession, msg: Record<string, unknown>) => {
  if (s.closed && !("result" in msg || "error" in msg)) return false;
  try {
    s.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
    return true;
  } catch {
    return false;
  }
};

/** A JSON-RPC request to a session's Codex; its answer (an error when the session ends first). */
export const codexRequest = (s: ClaudeSession, method: string, params: unknown) =>
  new Promise<{ readonly result?: any; readonly error?: { readonly message?: string } }>((resolve) => {
    const link = s.codex;
    if (!link || !s.child?.stdin) return resolve({ error: { message: "Codex isn't running." } });
    const id = link.nextId++;
    link.calls.set(id, resolve);
    if (!write(s, { id, method, params })) {
      link.calls.delete(id);
      resolve({ error: { message: "Couldn't reach Codex." } });
    }
  });

/** Stop: Codex interrupts the turn (turn/completed "interrupted" follows); false when there's nothing to interrupt. */
export const codexInterrupt = (s: ClaudeSession): boolean => {
  const link = s.codex;
  if (!link?.threadId || !link.turnId || !s.child?.stdin?.writable) return false;
  void codexRequest(s, "turn/interrupt", { threadId: link.threadId, turnId: link.turnId });
  return true;
};

export const makeCodex = (ctx: StreamCtx) => {
  const { persist, closeSession, st, publishNow, publishSoon, label, doing, delivered, finish, turnCleanup, permit, config, bridgeUrl, sessions } = ctx;

  /** The turn's item for a Codex item id (text, thinking or a step). */
  const itemAt = (r: Running, id: string) => {
    const at = r.steps.get(`codex:${id}`);
    return at === undefined ? undefined : r.turn.items[at];
  };

  /** A Codex item as a step of the work log: Uncut's tools by name, Codex's own as claude's (Bash, Edit, WebSearch). */
  const stepOf = (item: Record<string, any>): { tool: string; input: Record<string, unknown> } | undefined => {
    switch (item.type) {
      case "mcpToolCall":
        return { tool: item.server === "uncut" ? String(item.tool) : `${item.server}:${item.tool}`, input: item.arguments && typeof item.arguments === "object" ? item.arguments : {} };
      case "commandExecution":
        return { tool: "Bash", input: { command: codexCommand(item.command) } };
      case "fileChange": {
        const paths = (Array.isArray(item.changes) ? item.changes : []).map((c: Record<string, unknown>) => c?.path).filter(isString);
        return { tool: "Edit", input: paths.length ? { file_path: paths[0] } : {} };
      }
      case "webSearch":
        return { tool: "WebSearch", input: { query: isString(item.query) ? item.query : "" } };
      default:
        return undefined;
    }
  };

  const onItemStarted = (r: Running, link: CodexLink, item: Record<string, any>) => {
    const id = String(item.id ?? "");
    if (!id) return;
    link.items.set(id, item);
    const items = r.turn.items;
    if (item.type === "agentMessage" || item.type === "reasoning") {
      r.steps.set(`codex:${id}`, items.length);
      items.push({ kind: item.type === "agentMessage" ? "text" : "thinking", text: isString(item.text) ? item.text : "", live: true });
      return publishSoon();
    }
    const step = stepOf(item);
    if (!step) return;
    if (item.type === "webSearch") r.owner.webUsed = true;
    r.toolNames.set(id, step.tool);
    r.steps.set(`codex:${id}`, items.length);
    items.push({ kind: "step", tool: step.tool, text: label(step.tool, step.input), status: "running", doing: doing(step.tool, step.input) });
    publishNow();
  };

  const onItemCompleted = (r: Running, link: CodexLink, item: Record<string, any>) => {
    const id = String(item.id ?? "");
    link.items.delete(id);
    if (item.type === "agentMessage" || item.type === "reasoning") {
      const text = item.type === "agentMessage" ? (isString(item.text) ? item.text : "") : [...(Array.isArray(item.summary) ? item.summary : []), ...(item.summary?.length ? [] : Array.isArray(item.content) ? item.content : [])].filter(isString).join("\n\n");
      const shown = itemAt(r, id);
      if (shown) {
        if (text.trim()) shown.text = text.trim();
        delete shown.live;
      } else if (text.trim()) r.turn.items.push({ kind: item.type === "agentMessage" ? "text" : "thinking", text: text.trim() });
      return publishNow();
    }
    const step = stepOf(item);
    if (!step) return;
    let shown = itemAt(r, id);
    if (!shown) {
      onItemStarted(r, link, item);
      shown = itemAt(r, id);
    }
    if (!shown) return;
    shown.text = label(step.tool, step.input);
    delete shown.doing;
    const failed = item.status === "failed" || item.status === "declined" || (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0);
    shown.status = failed ? "error" : "done";
    const said =
      item.type === "commandExecution" ? (isString(item.aggregatedOutput) ? item.aggregatedOutput : "") :
      item.type === "mcpToolCall" ? (item.error?.message ? String(item.error.message) : (Array.isArray(item.result?.content) ? item.result.content : []).flatMap((c: Record<string, unknown>) => (c?.type === "text" && isString(c.text) ? [c.text] : [])).join("\n")) :
      "";
    if (failed) shown.error = (said.length > 600 ? `${said.slice(0, 597)}...` : said).trim() || "The tool reported an error.";
    // D194: a built-in tool's answer (a command's output) opens from its row.
    else if (said.trim() && !/^[a-z]/.test(shown.tool ?? "")) shown.result = said.length > RESULT_MAX ? `${said.slice(0, RESULT_MAX - 3)}...` : said;
    publishNow();
  };

  /** D261: the context meter from Codex's token usage (its last request's input and output, and the model's window). */
  const onUsage = (s: ClaudeSession, r: Running, usage: Record<string, any>) => {
    const last = usage?.last;
    const used = typeof last?.totalTokens === "number" ? last.totalTokens : (last?.inputTokens ?? 0) + (last?.outputTokens ?? 0);
    if (!used) return;
    const window = typeof usage.modelContextWindow === "number" && usage.modelContextWindow > 0 ? usage.modelContextWindow : undefined;
    const model = s.initModel ?? s.model;
    r.owner.context = contextOf({ used, window, systemTools: systemToolsEstimate(s.systemChars, s.toolsChars ?? 0), message: messageContextEstimate(r.message, r.turn.prompt), ...(model ? { model } : {}) });
    publishSoon();
  };

  /** Codex finished the turn: done (after the review nudge and the clean-up), stopped, or failed in words. */
  const onTurnCompleted = (s: ClaudeSession, r: Running, turn: Record<string, any>, resetsAt: number | undefined) => {
    const link = s.codex!;
    link.turnId = undefined;
    const status = turn?.status;
    if (r.cancelled || status === "interrupted") return finish(r, { status: "cancelled", ...(r.stopReason ? { error: r.stopReason } : {}) });
    if (r.turn.error) return finish(r, { status: "error" });
    if (status === "failed") {
      const said = isString(turn.error?.message) ? turn.error.message.trim() : "";
      return finish(r, { status: "error", error: codexTurnError(turn.error, resetsAt, Date.now()) ?? `Codex stopped: ${said || "it reported an error"}` });
    }
    // Round 2's A2: a turn that built a video and never asked the critic is reminded once and goes on.
    const brief = r.owner.plan.brief;
    const nudge = reviewNudge({ access: r.access, unattended: asksNoQuestions(r.turn.prompt, brief?.film, brief?.visual, brief?.notes, ...(brief?.hardLines ?? [])), reviewRounds: r.reviewRounds, graphicWrites: r.graphicWrites, edits: r.turn.edits.length, planned: r.planned, proposing: r.proposing, nudged: r.nudged, cancelled: r.cancelled, storyboard: r.owner.plan.storyboard?.status });
    if (nudge && !s.closed && s.turn === r) {
      r.nudged = true;
      return void startTurn(s, r, [{ type: "text", text: nudge, text_elements: [] }]);
    }
    const seconds = typeof turn?.durationMs === "number" ? Math.round(turn.durationMs / 100) / 10 : undefined;
    const patch = { status: "done" as const, ...(seconds !== undefined && !r.nudged ? { seconds } : {}) };
    // D206: the clean-up first (unused graphics to the trash, empty tracks it made removed), then the turn ends.
    void Effect.runPromise(turnCleanup(r))
      .catch((error) => console.error(`[uncut] turn clean-up failed: ${(error as Error).message}`))
      .finally(() => finish(r, patch));
  };

  /** A request from Codex (an approval, a question): answered, never left waiting. */
  const onServerRequest = (s: ClaudeSession, msg: Record<string, any>) => {
    const id = msg.id;
    const params = (msg.params ?? {}) as Record<string, any>;
    const answer = (result: unknown) => write(s, { id, result });
    const key = `codex-${String(id)}`;
    switch (msg.method) {
      case "item/commandExecution/requestApproval": {
        const command = codexCommand(params.command);
        return permit(s, key, "Bash", { command, ...(isString(params.reason) ? { description: params.reason } : {}) }, (a) => answer({ decision: a.allow ? "accept" : "decline" }));
      }
      case "item/fileChange/requestApproval": {
        // Every file the change touches (from its item), one decision after another: all must be allowed.
        const item = s.codex?.items.get(String(params.itemId ?? ""));
        const paths = [...new Set<string>((Array.isArray(item?.changes) ? item.changes : []).map((c: Record<string, unknown>) => c?.path).filter(isString))];
        if (isString(params.grantRoot)) paths.push(params.grantRoot);
        if (!paths.length) return answer({ decision: "decline" });
        const next = (i: number) => {
          if (i >= paths.length) return answer({ decision: "accept" });
          permit(s, `${key}-${i}`, "Write", { file_path: paths[i] }, (a) => (a.allow ? next(i + 1) : answer({ decision: "decline" })));
        };
        return next(0);
      }
      case "mcpServer/elicitation/request":
        // Uncut's own tools are pre-approved and gated by Uncut; anything else isn't Uncut's to approve.
        return answer({ action: params.serverName === "uncut" && params._meta?.codex_approval_kind === "mcp_tool_call" ? "accept" : "decline", content: params.serverName === "uncut" ? {} : null, _meta: null });
      case "item/tool/requestUserInput":
        return answer({ answers: {} });
      default:
        return write(s, { id, error: { code: -32601, message: `Uncut doesn't handle ${String(msg.method)}` } });
    }
  };

  /** One JSON-RPC line from a session's Codex. */
  const onLine = (s: ClaudeSession, line: string, limits: { resetsAt?: number | undefined }) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const link = s.codex!;
    if (msg.id !== undefined && msg.method === undefined) {
      const done = link.calls.get(Number(msg.id));
      link.calls.delete(Number(msg.id));
      return void done?.(msg);
    }
    if (msg.id !== undefined) return onServerRequest(s, msg);
    const params = (msg.params ?? {}) as Record<string, any>;
    if (params.threadId && link.threadId && params.threadId !== link.threadId) return;
    if (msg.method === "mcpServer/startupStatus/updated" && params.name === "uncut" && params.status === "failed") {
      const r = s.turn;
      if (r && !r.cancelled) r.turn.error = "Uncut's tools didn't start for Codex, so it couldn't see or edit the project.";
      return closeSession(s, "kill");
    }
    if (msg.method === "thread/compacted") return void forgetSentBlocks(s);
    // Codex gave up on a request (an interrupt): no answer, and its card goes.
    if (msg.method === "serverRequest/resolved") {
      const key = `codex-${String(params.requestId)}`;
      for (const [k, close] of [...s.prompts]) if (k === key || k.startsWith(`${key}-`)) close();
      return;
    }
    const r = s.turn;
    if (!r || r.turn.status !== "running") return;
    switch (msg.method) {
      case "turn/started":
        if (isString(params.turn?.id)) link.turnId = params.turn.id;
        return delivered(r);
      case "item/started":
        return onItemStarted(r, link, (params.item ?? {}) as Record<string, any>);
      case "item/completed":
        return onItemCompleted(r, link, (params.item ?? {}) as Record<string, any>);
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const item = itemAt(r, String(params.itemId ?? ""));
        if (!item || !isString(params.delta)) return;
        // Summary parts are paragraphs.
        if (msg.method === "item/reasoning/summaryTextDelta" && typeof params.summaryIndex === "number" && params.summaryIndex > 0 && !item.text.endsWith("\n\n") && (item as { part?: number }).part !== params.summaryIndex) item.text += "\n\n";
        (item as { part?: number }).part = params.summaryIndex;
        item.text += params.delta;
        return publishSoon();
      }
      case "thread/tokenUsage/updated":
        return onUsage(s, r, (params.tokenUsage ?? {}) as Record<string, any>);
      case "account/rateLimits/updated": {
        const { notice, resetsAt } = codexLimitNotice(params.rateLimits, Date.now());
        if (resetsAt) limits.resetsAt = resetsAt;
        if ((notice ?? undefined) !== st.limitWarning) {
          st.limitWarning = notice;
          publishNow();
        }
        return;
      }
      case "error":
        // A retry Codex makes on its own is shown, not ended on: turn/completed ends the turn.
        if (params.willRetry) {
          st.limitWarning = `Codex is retrying: ${String(params.error?.message ?? "the request failed").slice(0, 200)}`;
          publishNow();
        }
        return;
      case "turn/completed":
        return onTurnCompleted(s, r, (params.turn ?? {}) as Record<string, any>, limits.resetsAt);
    }
  };

  /** turn/start with the message (or a reminder) in the session's thread. */
  const startTurn = async (s: ClaudeSession, r: Running, input: Array<Record<string, unknown>>) => {
    const link = s.codex!;
    const got = await codexRequest(s, "turn/start", { threadId: link.threadId, input, ...(s.model ? { model: s.model } : {}), // The composer's efforts are Codex's names too (it also has xhigh).
      ...(s.effort ? { effort: s.effort } : {}), summary: "auto" });
    if (got.error) {
      if (r.turn.status !== "running") return;
      closeSession(s, "kill");
      return finish(r, { status: "error", error: codexTurnError({ message: got.error.message }, undefined, Date.now()) ?? `Codex refused the message: ${got.error.message ?? "no reason"}` });
    }
    if (isString(got.result?.turn?.id)) link.turnId = got.result.turn.id;
  };

  /** Write a turn's message to its session's Codex (once its thread is ready). */
  const writeCodexTurn = (s: ClaudeSession, r: Running) => {
    if (s.turn && s.turn !== r && s.turn.turn.status === "running") {
      closeSession(s, "kill");
      return finish(r, { status: "error", error: "Codex was still on the last message." });
    }
    s.turn = r;
    r.session = s;
    clearTimeout(s.idleTimer);
    const deliver = () => {
      if (s.closed || r.turn.status !== "running" || s.turn !== r) return;
      // Attached images (D184) first, as data URLs, then the text.
      const images = r.images.map((img) => ({ type: "image", url: `data:${img.mimeType};base64,${img.data}` }));
      void startTurn(s, r, [...images, { type: "text", text: r.message, text_elements: [] }]);
    };
    if (s.initialized) deliver();
    else s.waiting = deliver;
  };

  /** initialize, then the thread: the stored one resumed (a fresh one when Codex lost it), or a new one. */
  const handshake = async (s: ClaudeSession, threadConfig: Record<string, unknown>, resume: string | undefined) => {
    const fail = (why: string) => {
      const r = s.turn;
      if (r && r.turn.status === "running") {
        closeSession(s, "kill");
        finish(r, { status: "error", error: why });
      }
    };
    const init = await codexRequest(s, "initialize", { clientInfo: { name: "uncut", title: "Uncut", version: typeof __UNCUT_SERVER_VERSION__ === "string" ? __UNCUT_SERVER_VERSION__ : "0.0.0-dev" } });
    if (init.error) return fail(`Codex didn't start: ${init.error.message ?? "initialize failed"}`);
    write(s, { method: "initialized" });
    let thread: Record<string, any> | undefined;
    if (resume) {
      const got = await codexRequest(s, "thread/resume", { threadId: resume, ...threadConfig });
      thread = got.result?.thread;
      if (!thread) {
        // A stored thread can be gone (another Mac, a cleaned ~/.codex): start a fresh one.
        s.owner.sessionId = undefined;
        s.owner.context = undefined;
        persist(s.owner);
      }
    }
    if (!thread) {
      const got = await codexRequest(s, "thread/start", threadConfig);
      thread = got.result?.thread;
      if (!thread) return fail(codexTurnError({ message: got.error?.message }, undefined, Date.now()) ?? `Codex couldn't start a conversation: ${got.error?.message ?? "no reason"}`);
    }
    s.codex!.threadId = String(thread.id);
    if (isString(thread.model)) s.initModel = thread.model;
    s.gotInit = true;
    const id = `${CODEX_SESSION}${thread.id}`;
    if (id !== s.owner.sessionId) {
      s.owner.sessionId = id;
      persist(s.owner);
    }
    s.initialized = true;
    const w = s.waiting;
    s.waiting = undefined;
    w?.();
  };

  /**
   * Start a session's Codex. Its MCP server (Uncut's, on this server's runtime as for claude) and
   * the token go in the thread's config over stdin, never on argv.
   */
  const spawnCodex = (owner: Loaded, bin: string, toolsKey: string, resume: boolean, choice: { readonly model: string | undefined; readonly effort: string | undefined; readonly access: Access }): ClaudeSession | string => {
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), `${TURN_DIR_PREFIX}${process.pid}-`));
    } catch (error) {
      return `Can't prepare the agent's tools: ${(error as Error).message}`;
    }
    const token = randomBytes(24).toString("base64url");
    const resumed = resume && owner.sessionId?.startsWith(CODEX_SESSION) ? owner.sessionId.slice(CODEX_SESSION.length) : undefined;
    const mcpEntry = process.env.UNCUT_MCP_ENTRY || besideServer("./mcp.mjs");
    const access = choice.access;
    const instructions = `${CODEX_SYSTEM_PROMPT}${skillsPrompt(ctx.plugins.skillsNow())}`;
    const threadConfig = {
      cwd: owner.dir,
      ...codexPolicy(access),
      ...(choice.model ? { model: choice.model } : {}),
      developerInstructions: instructions,
      config: {
        mcp_servers: {
          uncut: {
            command: process.execPath,
            args: [mcpEntry],
            env: { UNCUT_BRIDGE: bridgeUrl, UNCUT_AGENT_TOKEN: token, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
            // Uncut decides on its own tools (allowed); a call can wait for a card or a long render.
            default_tools_approval_mode: "approve",
            tool_timeout_sec: 3600,
          },
        },
      },
    };
    const s: ClaudeSession = {
      provider: "codex",
      codex: { nextId: 1, calls: new Map(), threadId: undefined, turnId: undefined, items: new Map() },
      owner, openId: owner.openId, dir, token, toolsKey, model: choice.model, effort: choice.effort, thinking: undefined, snapshotOff: false, resumed, dirsKey: [...owner.dirs].sort().join("\n"), prompts: new Map(), access,
      initId: "", initialized: false, initFailed: false, initTimer: undefined, waiting: undefined, child: undefined, turn: undefined, gotInit: false, closed: false, stderr: "", idleTimer: undefined, killTimer: undefined, gens: 0, initModel: undefined, systemChars: instructions.length, toolsChars: undefined,
    };
    try {
      // Its own process group, so closing it also stops the MCP server and commands Codex started.
      s.child = spawn(bin, ["app-server"], { cwd: owner.dir, env: codexEnv(process.env), stdio: ["pipe", "pipe", "pipe"], detached: true });
      // So cleanStaleTurns can find an app-server this server left behind.
      if (s.child.pid) writeFileSync(join(dir, CODEX_PID), String(s.child.pid), { mode: 0o600 });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      return `Couldn't start Codex: ${(error as Error).message}`;
    }
    const child = s.child;
    sessions.add(s);
    child.stdin!.on("error", () => {});
    const limits: { resetsAt?: number | undefined } = {};
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) onLine(s, line, limits);
      }
    });
    child.stderr!.on("data", (chunk: string) => (s.stderr = (s.stderr + chunk).slice(-4000)));
    let settled = false;
    const settle = (code: number | null, startError?: Error) => {
      if (settled) return;
      settled = true;
      if (buffer.trim()) onLine(s, buffer.trim(), limits);
      s.closed = true;
      s.waiting = undefined;
      for (const done of s.codex!.calls.values()) done({ error: { message: "Codex stopped." } });
      s.codex!.calls.clear();
      sessions.delete(s);
      clearTimeout(s.idleTimer);
      clearTimeout(s.killTimer);
      if (st.session === s) st.session = undefined;
      rmSync(s.dir, { recursive: true, force: true });
      const r = s.turn;
      s.turn = undefined;
      if (!r || r.turn.status !== "running") return;
      if (startError) return finish(r, { status: "error", error: `Couldn't start Codex (${bin}): ${startError.message}` });
      if (r.cancelled) return finish(r, { status: "cancelled", ...(r.stopReason ? { error: r.stopReason } : {}) });
      if (r.turn.error) return finish(r, { status: "error" });
      // It died mid-turn (a crash, a kill): the next message starts another that resumes the thread.
      const why = s.stderr.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-3).join(" ") || `exit code ${code}`;
      return finish(r, { status: "error", error: codexTurnError({ message: why }, limits.resetsAt, Date.now()) ?? `Codex stopped: ${why}` });
    };
    child.once("error", (error) => settle(null, error));
    child.once("close", (code) => settle(code));
    void handshake(s, threadConfig, resumed).catch((error) => console.error(`[uncut] Codex handshake failed: ${(error as Error).message}`));
    return s;
  };

  return { spawnCodex, writeCodexTurn };
};

declare const __UNCUT_SERVER_VERSION__: string | undefined;
