// The running turn's live output: publishing, the turn's end, claude's streamed and full messages.
import type { Project } from "@uncut/core";
import { friendlyText } from "@uncut/core/mentions";
import { doingLabel, partialFields, stepLabel, TOOL_NAMES } from "../agentTools.ts";
import type { Running, ClaudeSession, StoredTurn } from "./types.ts";
import { isString, resultText } from "../turns/history.ts";
import { STREAM_PUBLISH_MS, idleMs, canonical } from "./config.ts";
import type { RunCtx } from "../tools/run.ts";
import { track } from "../../telemetry/telemetry.ts";
import { agentFailCode } from "../../telemetry/events.ts";
import { assistantUsage, contextOf, contextUsageReply, knownWindow, messageContextEstimate, resultWindow, systemToolsEstimate, windowKey } from "./usage.ts";

export const makeStream = (ctx: RunCtx) => {
  const { publish, closeSession, view, persist, trackPending, plugins } = ctx;
  // D269: the context windows results reported this app run, by windowKey (init's model, "[1m]" kept).
  const learnedWindows = new Map<string, number>();

  // ---- running claude ----

  // Live deltas are published together, at most every STREAM_PUBLISH_MS; anything else at once.
  let publishTimer: NodeJS.Timeout | undefined;
  const publishNow = () => {
    clearTimeout(publishTimer);
    publishTimer = undefined;
    publish();
  };
  const publishSoon = () => {
    if (publishTimer) return;
    publishTimer = setTimeout(publishNow, STREAM_PUBLISH_MS);
  };

  const armIdle = (s: ClaudeSession) => {
    clearTimeout(s.idleTimer);
    if (s.closed) return;
    s.idleTimer = setTimeout(() => {
      if (!s.turn) closeSession(s, "graceful");
    }, idleMs());
    s.idleTimer.unref?.();
  };

  const finish = (r: Running, patch: Partial<StoredTurn>) => {
    if (r.turn.status !== "running") return;
    r.abort.abort();
    clearTimeout(r.interruptTimer);
    Object.assign(r.turn, patch, { finishedAt: new Date().toISOString() });
    if (r.turn.seconds === undefined) r.turn.seconds = Math.round((Date.now() - Date.parse(r.turn.startedAt)) / 100) / 10;
    const ok = patch.status === "done";
    for (const item of r.turn.items) {
      if (item.status === "running") item.status = ok ? "done" : "error";
      delete item.live;
      delete item.doing;
    }
    // A streamed block that never got any words (whitespace, an empty thinking) isn't shown.
    for (let i = r.turn.items.length - 1; i >= 0; i--) {
      const item = r.turn.items[i]!;
      if (item.kind !== "step" && !item.text.trim()) {
        r.turn.items.splice(i, 1);
        // D203: the edits' steps move up with it.
        r.turn.edits.forEach((e, k) => e.at !== undefined && e.at > i && (r.turn.edits[k] = { ...e, at: e.at - 1 }));
      } else if (item.kind !== "step") item.text = item.text.trim();
    }
    const now = view();
    if (now && now.openId === r.openId) r.owner.bounds.set(r.turn.id, { ...r.owner.bounds.get(r.turn.id), end: now.session.revision });
    if (r.session.turn === r) r.session.turn = undefined;
    // D218: a limit notice belongs to the turn it paused.
    r.owner.limitWarning = undefined;
    armIdle(r.session);
    if (r.owner.running === r) r.owner.running = undefined;
    persist(r.owner);
    publishNow();
    // Telemetry (D223): the turn's outcome and size; a failure as a fixed code, never its words.
    const outcome = patch.status === "done" || patch.status === "cancelled" ? patch.status : "error";
    track("agent:turn", {
      outcome,
      duration_ms: Date.now() - Date.parse(r.turn.startedAt),
      edits: r.turn.edits.length,
      steps: r.turn.items.filter((i) => i.kind === "step").length,
    });
    if (outcome === "error") track("agent:fail", { code: agentFailCode(r.turn.error) });
  };

  /** The turn's note reached claude (it answered this message): the next turn needn't repeat it. */
  const delivered = (r: Running) => {
    if (r.delivered) return;
    r.delivered = true;
    if (r.turn.kind === "compact") return;
    r.owner.agentSeen = Math.max(r.owner.agentSeen, r.noteRevision);
    r.owner.carried = undefined;
    r.owner.pending = "";
    trackPending();
    persist(r.owner);
  };

  const label = (tool: string, input: unknown) =>
    friendlyText(view()?.session.project as Project | undefined, stepLabel(tool, input, plugins.owner(tool)?.name, view()?.dir));
  const doing = (tool: string, input: unknown) =>
    friendlyText(view()?.session.project as Project | undefined, doingLabel(tool, input, plugins.owner(tool)?.name, view()?.dir));

  /** Live output (D139): a stream_event of the message claude is writing. */
  const onStream = (r: Running, event: Record<string, any>) => {
    const items = r.turn.items;
    if (event.type === "message_start") {
      r.messageId = isString(event.message?.id) ? event.message.id : `msg-${items.length}`;
      r.blocks = new Map();
      r.inputs.clear();
      return;
    }
    const index = Number(event.index);
    if (event.type === "content_block_start") {
      const block = (event.content_block ?? {}) as Record<string, any>;
      if (block.type === "text" || block.type === "thinking") {
        const kind = block.type as "text" | "thinking";
        r.blocks.set(index, items.length);
        const list = r.streamed.get(r.messageId) ?? [];
        list.push({ kind, at: items.length, used: false });
        r.streamed.set(r.messageId, list);
        items.push({ kind, text: isString(block.text) ? block.text : isString(block.thinking) ? block.thinking : "", live: true });
        publishSoon();
      } else if (block.type === "tool_use" && isString(block.name) && isString(block.id)) {
        // The step shows as soon as claude starts writing the call; its words follow the input.
        const tool = block.name.replace(/^mcp__uncut__/, "");
        r.steps.set(block.id, items.length);
        r.inputs.set(index, { at: items.length, tool, json: "", shown: "" });
        items.push({ kind: "step", tool, text: label(tool, {}), status: "running", doing: doing(tool, {}) });
        publishSoon();
      }
      return;
    }
    // D182: a call's input streams in (a graphic's HTML takes a while): its name or summary,
    // once it's there, goes on the now line.
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      const input = r.inputs.get(index);
      if (!input || !isString(event.delta.partial_json) || input.json.length > 400_000) return;
      input.json += event.delta.partial_json;
      const item = items[input.at];
      if (!item || item.status !== "running") return;
      const now = doing(input.tool, partialFields(input.json));
      if (now !== input.shown) {
        input.shown = now;
        item.doing = now;
        publishSoon();
      }
      return;
    }
    if (event.type === "content_block_delta") {
      const at = r.blocks.get(index);
      const item = at === undefined ? undefined : items[at];
      if (!item) return;
      const delta = (event.delta ?? {}) as Record<string, any>;
      if (delta.type === "text_delta" && isString(delta.text)) item.text += delta.text;
      else if (delta.type === "thinking_delta" && isString(delta.thinking)) item.text += delta.thinking;
      else return;
      publishSoon();
      return;
    }
    if (event.type === "content_block_stop") {
      const at = r.blocks.get(index);
      const item = at === undefined ? undefined : items[at];
      if (item?.live) {
        delete item.live;
        publishSoon();
      }
    }
  };

  /**
   * D261: the context window's use, from a top-level assistant message's usage (its last API
   * call's context) or the window a result reports (modelUsage). Published with the message.
   */
  const noteContext = (r: Running, msg: Record<string, any>) => {
    const owner = r.owner;
    const s = r.session;
    const last = owner.context;
    const usage = assistantUsage(msg);
    // D269 (#101): the window as soon as it's known (the chosen or init model's "[1m]", or what a
    // result reported for this model before), never a guessed 200k; the result fills it in.
    const ids = { model: usage?.model ?? last?.model, initModel: s.initModel, chosen: s.model };
    if (usage) {
      const model = usage.model ?? s.initModel ?? s.model;
      const window = s.window ?? knownWindow({ ...ids, learned: learnedWindows }) ?? (last && last.model === model ? last.window : undefined);
      const compactAt = s.compactAt ?? (last && last.model === model ? last.compactAt : undefined);
      owner.context = contextOf({
        used: usage.used,
        window,
        compactAt,
        parts: usage.parts,
        systemTools: systemToolsEstimate(s.systemChars, s.toolsChars ?? 0),
        message: messageContextEstimate(r.message, r.turn.prompt),
        model,
      });
      return;
    }
    const window = last ? resultWindow(msg, last.model ?? s.initModel ?? s.model) : undefined;
    if (!last || !window) return;
    owner.context = { ...last, window };
    const key = windowKey(ids);
    if (key) learnedWindows.set(key, window);
  };

  /**
   * Claude Code's answer to get_context_usage (asked when a session starts and after a compaction):
   * the window and where it compacts on its own, as its own /context shows them. After a compaction
   * its count is the context now (the last call's usage is from before it).
   */
  const onContextUsage = (s: ClaudeSession, reply: unknown, compacted: boolean) => {
    const got = contextUsageReply(reply);
    if (!got) return;
    s.window = got.window ?? s.window;
    s.compactAt = got.compactAt ?? s.compactAt;
    const key = windowKey({ initModel: s.initModel, chosen: s.model });
    if (key && got.window) learnedWindows.set(key, got.window);
    const owner = s.owner;
    const last = owner.context;
    if (compacted && got.total)
      owner.context = contextOf({
        used: got.total,
        window: s.window,
        compactAt: s.compactAt,
        systemTools: systemToolsEstimate(s.systemChars, s.toolsChars ?? 0),
        message: 0,
        ...(last?.model ? { model: last.model } : {}),
      });
    else if (last) owner.context = { ...last, ...(s.window ? { window: s.window } : {}), ...(s.compactAt ? { compactAt: s.compactAt } : {}) };
    else return;
    publishNow();
  };

  /** A full assistant message: replaces what was streamed of it, adds what wasn't (a block this turn already shows word for word isn't added twice). */
  const onAssistant = (r: Running, msg: Record<string, any>) => {
    noteContext(r, msg);
    const items = r.turn.items;
    const id = isString(msg.message?.id) ? msg.message.id : undefined;
    const slots = id ? r.streamed.get(id) : undefined;
    const take = (kind: "text" | "thinking") => {
      const slot = slots?.find((x) => x.kind === kind && !x.used);
      if (slot) slot.used = true;
      return slot ? items[slot.at] : undefined;
    };
    for (const c of (msg.message?.content ?? []) as Array<Record<string, any>>) {
      if (c.type === "text" && isString(c.text)) {
        const item = take("text");
        if (item) {
          item.text = c.text.trim();
          delete item.live;
        } else if (c.text.trim() && !items.some((i) => i.kind === "text" && !i.live && i.text.trim() === c.text.trim()))
          items.push({ kind: "text", text: c.text.trim() });
      } else if (c.type === "thinking" && isString(c.thinking)) {
        const item = take("thinking");
        if (item) {
          if (c.thinking.trim()) item.text = c.thinking.trim();
          delete item.live;
        } else if (c.thinking.trim() && !items.some((i) => i.kind === "thinking" && i.text.trim() === c.thinking.trim()))
          items.push({ kind: "thinking", text: c.thinking.trim() });
      } else if (c.type === "tool_use" && isString(c.name)) {
        const tool = c.name.replace(/^mcp__uncut__/, "");
        r.announced.push({ name: tool, args: canonical(c.input ?? {}), used: false });
        const at = r.steps.get(String(c.id));
        const step = at === undefined ? undefined : items[at];
        if (step) {
          step.text = label(tool, c.input);
          if (step.status === "running") step.doing = doing(tool, c.input);
        } else {
          r.steps.set(String(c.id), items.length);
          items.push({ kind: "step", tool, text: label(tool, c.input), status: "running", doing: doing(tool, c.input) });
        }
      }
    }
    publishNow();
  };

  /**
   * D194: a turn's web use and the data it read. A WebSearch or WebFetch call marks the turn (then
   * anything outside the project asks); secret-looking strings (20+ letters and digits) in other
   * tools' results are kept, so a WebFetch address carrying one asks.
   */
  const watchData = (r: Running, msg: Record<string, any>) => {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const c of content as Array<Record<string, any>>) {
      if (c?.type === "tool_use" && isString(c.name)) {
        r.toolNames.set(String(c.id), c.name);
        if ((TOOL_NAMES as ReadonlyArray<string>).includes(c.name)) (r.bareCalls ??= []).push(c.name);
        if (c.name === "WebSearch" || c.name === "WebFetch") r.owner.webUsed = true;
      } else if (msg.type === "user" && c?.type === "tool_result") {
        const name = r.toolNames.get(String(c.tool_use_id)) ?? "";
        if (name === "WebSearch" || name === "WebFetch" || r.owner.tainted.size > 20_000) continue;
        for (const m of resultText(c.content).matchAll(/[A-Za-z0-9_+/=-]{20,}/g)) if (/\d/.test(m[0]) && /[A-Za-z]/.test(m[0])) r.owner.tainted.add(m[0]);
      }
    }
  };

  return { publishNow, publishSoon, label, doing, watchData, delivered, onStream, onAssistant, finish, noteContext, onContextUsage };
};

export type StreamCtx = RunCtx & ReturnType<typeof makeStream>;
