// A session's claude: its stream-json lines, a turn's message, the initialize handshake, starting it.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { Access } from "../agentPermissions.ts";
import { onRateLimit, resultError, resultFailed } from "../agentLimits.ts";
import { besideServer } from "../../paths.ts";
import type { Loaded, Running, ClaudeSession } from "./types.ts";
import { isString, resultText, RESULT_MAX } from "../turns/history.ts";
import { TURN_DIR_PREFIX } from "./stale.ts";
import { sessionEnv, initMs, sessionArgs } from "./config.ts";
import { forgetSentBlocks } from "./send.ts";
import type { StreamCtx } from "./stream.ts";

/**
 * D181: thinking summaries need `--thinking-display summarized` in print mode (claude 2.1.299 reads
 * the showThinkingSummaries setting only in interactive sessions; without the flag Opus sends empty
 * thinking blocks). A claude that refuses the flag at startup is started again without it, and this
 * server doesn't pass it again. UNCUT_AGENT_THINKING_DISPLAY overrides the value ("off": never).
 */
let thinkingDisplayRefused = false;
const thinkingDisplay = () => {
  const asked = process.env.UNCUT_AGENT_THINKING_DISPLAY;
  if (asked === "off" || thinkingDisplayRefused) return undefined;
  return asked || "summarized";
};
/**
 * D260 amended: `--system-prompt-snapshot off` (claude 2.1.257+) so a resumed conversation gets the
 * current system prompt, not the one recorded on its first request. A claude that refuses the flag is
 * started again without it, and this server doesn't pass it again (before 2.1.265 an append flag
 * turned recording off anyway).
 */
let promptSnapshotRefused = false;

export const makeSpawn = (ctx: StreamCtx) => {
  const { persist, closeSession, canUseTool, st, publishNow, watchData, delivered, onStream, onAssistant, finish, noteContext, turnCleanup, publish, config, bridgeUrl, sessions } = ctx;

  /** One stream-json line from a session's claude. */
  const onLine = (s: ClaudeSession, line: string) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "system" && msg.subtype === "init") {
      s.gotInit = true;
      if (isString(msg.model)) s.initModel = msg.model;
      if (isString(msg.session_id) && msg.session_id !== s.owner.sessionId) {
        s.owner.sessionId = msg.session_id;
        persist(s.owner);
      }
      const status = (msg.mcp_servers as Array<{ name?: string; status?: string }> | undefined)?.find((x) => x.name === "uncut")?.status;
      if (status === "failed") {
        const r = s.turn;
        if (r && !r.cancelled) r.turn.error = "Uncut's tools didn't start for Claude Code, so it couldn't see or edit the project.";
        closeSession(s, "kill");
      }
      return;
    }
    // D266: after a compaction the brand kit and plan go whole with the next message.
    if (msg.type === "system" && msg.subtype === "compact_boundary") return void forgetSentBlocks(s);
    // D194: claude asks whether a built-in tool may run (--permission-prompt-tool stdio).
    if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") return void canUseTool(s, msg);
    if (msg.type === "control_response" && String(msg.response?.request_id ?? "") === s.initId) {
      if (msg.response?.subtype !== "success") console.error(`[uncut] claude refused initialize: ${String(msg.response?.error ?? "no reason")}`);
      return initDone(s, true);
    }
    if (msg.type === "control_cancel_request") {
      s.prompts.get(String(msg.request_id))?.();
      return;
    }
    if (msg.type === "control_response" || msg.type === "control_request" || msg.type === "keep_alive") return;
    const r = s.turn;
    if (!r || r.turn.status !== "running") return;
    // D218: a rejected window pauses claude (it holds the turn until the window reopens): say so
    // in the Agent tab, once per window; Stop still works. Nothing is retried.
    if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info;
      if (!info || typeof info !== "object") return;
      const { notice, cleared } = onRateLimit(r.limits, info, Date.now());
      if (notice) st.limitWarning = notice;
      else if (cleared) st.limitWarning = undefined;
      if (notice || cleared) publishNow();
      return;
    }
    if (msg.type === "assistant" && !msg.parent_tool_use_id) {
      r.limits.rateLimited = msg.error === "rate_limit";
      if (msg.error === "authentication_failed") r.limits.authFailed = true;
    }
    // D194: what the turn did with the web and read from files, the subagents' work included.
    watchData(r, msg);
    // Work from a subagent (none today) isn't the turn's own.
    if (msg.parent_tool_use_id) return;
    if (msg.type === "stream_event" || msg.type === "assistant" || msg.type === "user" || msg.type === "result") delivered(r);
    if (msg.type === "stream_event") onStream(r, (msg.event ?? {}) as Record<string, any>);
    else if (msg.type === "assistant") onAssistant(r, msg);
    else if (msg.type === "user") {
      const content = msg.message?.content;
      for (const c of (Array.isArray(content) ? content : []) as Array<Record<string, any>>) {
        if (c.type !== "tool_result") continue;
        const at = r.steps.get(String(c.tool_use_id));
        const item = at === undefined ? undefined : r.turn.items[at];
        if (!item) continue;
        item.status = c.is_error ? "error" : "done";
        delete item.doing;
        // D194: a built-in tool's answer (a search's results, a page's summary, a command's output) opens from its row.
        if (!c.is_error && item.tool && !/^[a-z]/.test(item.tool)) {
          const said = resultText(c.content);
          if (said.trim()) item.result = said.length > RESULT_MAX ? `${said.slice(0, RESULT_MAX - 3)}...` : said;
        }
        // D182: a failed call shows why (the tool's answer, or claude's own "No such tool").
        if (c.is_error) {
          const said = resultText(c.content);
          const why = said.replace(/<\/?tool_use_error>/g, "").trim();
          item.error = (why.length > 600 ? `${why.slice(0, 597)}...` : why) || "The tool reported an error.";
        }
      }
      publishNow();
    } else if (msg.type === "result") {
      // D261: the window the result reports, before finish publishes the turn's end.
      noteContext(r, msg);
      // A Stop that crossed a successful result doesn't relabel the finished turn.
      if (r.cancelled && msg.is_error) return finish(r, { status: "cancelled", ...(r.stopReason ? { error: r.stopReason } : {}) });
      if (r.turn.error) return finish(r, { status: "error" });
      // D218: claude reports API failures (429, 529) and give-ups as a "success" result too.
      if (!msg.is_error && !resultFailed(msg)) {
        const patch = { status: "done" as const, ...(typeof msg.duration_ms === "number" ? { seconds: Math.round(msg.duration_ms / 100) / 10 } : {}) };
        // D206: the clean-up first (unused graphics to the trash, empty tracks it made removed), then the turn ends.
        return void Effect.runPromise(turnCleanup(r))
          .catch((error) => console.error(`[uncut] turn clean-up failed: ${(error as Error).message}`))
          .finally(() => finish(r, patch));
      }
      const why = (isString(msg.result) && msg.result.trim()) || (Array.isArray(msg.errors) && msg.errors.filter(isString).join(" ")) || msg.subtype || "it reported an error";
      // D218: a usage limit, rate limit, overload or sign-in problem in words (like t3code), else claude's own.
      return finish(r, { status: "error", error: resultError(msg, r.limits, Date.now(), process.env.CLAUDE_CONFIG_DIR) ?? `Claude Code stopped: ${why}` });
    }
  };

  /** Write a turn's message to its session's claude, as one stream-json user line. */
  const writeTurn = (s: ClaudeSession, r: Running) => {
    // One turn in flight: the next is written only once the last one's result was consumed.
    if (s.turn && s.turn !== r && s.turn.turn.status === "running") {
      closeSession(s, "kill");
      return finish(r, { status: "error", error: "Claude Code was still on the last message." });
    }
    s.turn = r;
    r.session = s;
    clearTimeout(s.idleTimer);
    const deliver = () => {
      if (s.closed || r.turn.status !== "running" || s.turn !== r) return;
      try {
        // Attached images (D184) go first, as image content blocks, then the text.
        const images = r.images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } }));
        s.child!.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [...images, { type: "text", text: r.message }] }, parent_tool_use_id: null })}\n`);
      } catch (error) {
        closeSession(s, "kill");
        finish(r, { status: "error", error: `Couldn't reach Claude Code: ${(error as Error).message}` });
      }
    };
    // D194: the message goes once claude answered initialize (or gave up waiting for it).
    if (s.initialized) deliver();
    else s.waiting = deliver;
  };

  /** D194: claude answered initialize, or didn't in time: the waiting message goes. */
  const initDone = (s: ClaudeSession, answered: boolean) => {
    if (s.initialized) return;
    s.initialized = true;
    clearTimeout(s.initTimer);
    if (!answered) {
      console.error(`[uncut] claude didn't answer initialize in ${initMs() / 1000} s; the message goes, and every call that needs an approval is refused`);
      s.initFailed = true;
      st.initWarning = "Claude Code didn't answer Uncut's setup, so approvals can't be asked: commands, file writes and anything else that needs your OK are refused in this session. Update Claude Code, or start a new message to try again.";
      publish();
    } else if (st.initWarning) {
      st.initWarning = undefined;
      publish();
    }
    const w = s.waiting;
    s.waiting = undefined;
    w?.();
  };

  /**
   * Start a session's claude. The MCP server runs on the same runtime as this server: Node in
   * development, the Electron binary in Node mode in the packaged app (bin.ts took
   * ELECTRON_RUN_AS_NODE out of our environment, so it is set again for this one child).
   */
  const spawnSession = (owner: Loaded, bin: string, toolsKey: string, resume: boolean, choice: { readonly model: string | undefined; readonly effort: string | undefined; readonly access: Access }): ClaudeSession | string => {
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), `${TURN_DIR_PREFIX}${process.pid}-`));
    } catch (error) {
      return `Can't prepare the agent's tools: ${(error as Error).message}`;
    }
    const cfg = join(dir, "mcp.json");
    const token = randomBytes(24).toString("base64url");
    const resumed = resume ? owner.sessionId : undefined;
    const mcpEntry = process.env.UNCUT_MCP_ENTRY || besideServer("./mcp.mjs");
    const thinking = thinkingDisplay();
    const addDirs = [...owner.dirs].sort();
    const access = choice.access;
    let projects = [owner.dir];
    try {
      projects = [owner.dir, realpathSync.native(owner.dir)];
    } catch {}
    // D232: every installed skill's name and description go in the system prompt (send's toolsKey has their names).
    const snapshotOff = !promptSnapshotRefused;
    const args = sessionArgs({ cfg, model: choice.model, effort: choice.effort, resume: resumed, thinking, promptSnapshot: snapshotOff ? "off" : undefined, addDirs, access, projects, dataDir: config.dataDir, skills: ctx.plugins.skillsNow() });
    const initId = `init-${randomBytes(4).toString("hex")}`;
    const s: ClaudeSession = { owner, openId: owner.openId, dir, token, toolsKey, model: choice.model, effort: choice.effort, thinking, snapshotOff, resumed, dirsKey: addDirs.join("\n"), prompts: new Map(), access, initId, initialized: false, initFailed: false, initTimer: undefined, waiting: undefined, child: undefined, turn: undefined, gotInit: false, closed: false, stderr: "", idleTimer: undefined, killTimer: undefined, gens: 0, initModel: undefined, systemChars: args.includes("--append-system-prompt") ? (args[args.indexOf("--append-system-prompt") + 1]?.length ?? 0) : 0, toolsChars: undefined };
    try {
      writeFileSync(
        cfg,
        JSON.stringify({
          mcpServers: {
            uncut: {
              command: process.execPath,
              args: [mcpEntry],
              // D181: every Uncut tool in the prompt from the start, never deferred behind tool search.
              alwaysLoad: true,
              env: { UNCUT_BRIDGE: bridgeUrl, UNCUT_AGENT_TOKEN: token, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
            },
          },
        }),
        { mode: 0o600 },
      );
      // Its own process group, so closing it also stops the MCP server claude started.
      s.child = spawn(bin, args, { cwd: owner.dir, env: sessionEnv(process.env), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      return `Couldn't start Claude Code: ${(error as Error).message}`;
    }
    const child = s.child;
    sessions.add(s);
    child.stdin!.on("error", () => {});
    // D194: as the Agent SDK does before anything else (no hooks, SDK MCP servers or other
    // options of its own, so the request carries only its subtype); the first message waits for
    // the answer, at most INIT_MS.
    try {
      child.stdin!.write(`${JSON.stringify({ type: "control_request", request_id: initId, request: { subtype: "initialize" } })}\n`);
    } catch {}
    s.initTimer = setTimeout(() => initDone(s, false), initMs());
    s.initTimer.unref?.();
    let buffer = "";
    // Decoded as a stream, so a character split across two chunks ("ó" in "Kraków") stays whole.
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) onLine(s, line);
      }
    });
    child.stderr!.on("data", (chunk: string) => (s.stderr = (s.stderr + chunk).slice(-4000)));
    let settled = false;
    const settle = (code: number | null, startError?: Error) => {
      if (settled) return;
      settled = true;
      if (buffer.trim()) onLine(s, buffer.trim());
      s.closed = true;
      clearTimeout(s.initTimer);
      s.waiting = undefined;
      sessions.delete(s);
      clearTimeout(s.idleTimer);
      clearTimeout(s.killTimer);
      if (st.session === s) st.session = undefined;
      rmSync(s.dir, { recursive: true, force: true });
      const r = s.turn;
      s.turn = undefined;
      if (!r || r.turn.status !== "running") return;
      if (startError) return finish(r, { status: "error", error: `Couldn't start Claude Code (${bin}): ${startError.message}` });
      if (r.cancelled) return finish(r, { status: "cancelled", ...(r.stopReason ? { error: r.stopReason } : {}) });
      if (r.turn.error) return finish(r, { status: "error" });
      // D181: a claude that doesn't take --thinking-display: again without it (and never again here).
      if (s.thinking && !s.gotInit && /--thinking/i.test(s.stderr)) {
        thinkingDisplayRefused = true;
        console.error(`[uncut] claude refused --thinking-display; the agent runs without thinking summaries: ${s.stderr.trim().split("\n")[0]}`);
        const again = spawnSession(s.owner, bin, s.toolsKey, !!s.resumed, { model: s.model, effort: s.effort, access: s.access });
        if (typeof again === "string") return finish(r, { status: "error", error: again });
        st.session = again;
        return writeTurn(again, r);
      }
      // D260 amended: a claude that doesn't take --system-prompt-snapshot: again without it (never again here).
      if (s.snapshotOff && !s.gotInit && /--system-prompt-snapshot/i.test(s.stderr)) {
        promptSnapshotRefused = true;
        console.error(`[uncut] claude refused --system-prompt-snapshot; a resumed conversation keeps the system prompt it started with: ${s.stderr.trim().split("\n")[0]}`);
        const again = spawnSession(s.owner, bin, s.toolsKey, !!s.resumed, { model: s.model, effort: s.effort, access: s.access });
        if (typeof again === "string") return finish(r, { status: "error", error: again });
        st.session = again;
        return writeTurn(again, r);
      }
      // A stored session can be gone (another Mac, a cleaned ~/.claude): start a fresh one, once.
      if (s.resumed && !s.gotInit && /no conversation found/i.test(s.stderr)) {
        s.owner.sessionId = undefined;
        // D261: a new conversation: the last one's context doesn't apply.
        s.owner.context = undefined;
        persist(s.owner);
        const fresh = spawnSession(s.owner, bin, s.toolsKey, false, { model: s.model, effort: s.effort, access: s.access });
        if (typeof fresh === "string") return finish(r, { status: "error", error: fresh });
        st.session = fresh;
        return writeTurn(fresh, r);
      }
      // It died mid-turn (a crash, a kill): the next message starts another with --resume.
      const why = s.stderr.trim().split("\n").slice(-3).join(" ") || `exit code ${code}`;
      return finish(r, { status: "error", error: resultError({ result: why }, r.limits, Date.now(), process.env.CLAUDE_CONFIG_DIR) ?? `Claude Code stopped: ${why}` });
    };
    child.once("error", (error) => settle(null, error));
    child.once("close", (code) => settle(code));
    return s;
  };

  return { spawnSession, writeTurn };
};

export type SpawnCtx = StreamCtx & ReturnType<typeof makeSpawn>;
