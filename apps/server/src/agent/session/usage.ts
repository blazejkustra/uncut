// D261 (issue #93): how full the agent's context window is, from the usage claude reports in its
// stream-json, plus a rough breakdown for the composer's meter. Pure: no I/O, no state.
import type { AgentContext } from "@uncut/contracts";

/** Claude Code's own system prompt and built-in tools, which Uncut can't see: about this many tokens. */
export const CLAUDE_CODE_BASE_TOKENS = 20_000;

/** A rough token count: prose about 4 characters a token, JSON schemas about 2.4. */
export const estimateTokens = (chars: number, kind: "prose" | "json" = "prose") => Math.round(Math.max(0, chars) / (kind === "json" ? 2.4 : 4));

/**
 * D269 (issue #101): the window a model id says outright: "[1m]" (the 1M-context variant, as the
 * user picks it or claude's init reports it) is 1M. Anything else is unknown: some models have 1M
 * natively, so 200k would be a guess. The API's message.model never carries "[1m]".
 */
export const windowFor = (model: string | undefined) => (model && /\[1m\]/i.test(model) ? 1_000_000 : undefined);

/**
 * D269: the model a session runs as claude knows it (init's model, else the user's choice, else the
 * message's), without a date suffix: the key a result's window is remembered under. "[1m]" stays,
 * so the 1M and 200k variants of one model don't share a window.
 */
export const windowKey = (o: { readonly model?: string | undefined; readonly initModel?: string | undefined; readonly chosen?: string | undefined }) => {
  const id = o.initModel || o.chosen || o.model;
  return id ? id.replace(/-\d{8}(?=\[1m\]$|$)/i, "") : undefined;
};

/**
 * D269: the window to show with an assistant message's usage, as soon as it's known: "[1m]" on the
 * model the user chose or claude's init named is 1M; else the window a result already reported for
 * this model (earlier in this app run); else undefined (the meter shows only the used count until
 * the turn's result reports modelUsage's contextWindow). Never a guessed 200k.
 */
export function knownWindow(o: {
  readonly model?: string | undefined;
  readonly initModel?: string | undefined;
  readonly chosen?: string | undefined;
  readonly learned?: ReadonlyMap<string, number>;
}): number | undefined {
  const marked = windowFor(o.chosen) ?? windowFor(o.initModel);
  if (marked) return marked;
  const key = windowKey(o);
  return key ? o.learned?.get(key) : undefined;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** What one API call read and wrote, as its usage says: fresh input, cache reads, cache writes and output. */
export interface CallTokens {
  readonly fresh: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

const lastMessageIteration = (usage: Record<string, any>): Record<string, any> | undefined =>
  Array.isArray(usage.iterations) ? usage.iterations.findLast((it) => it?.type === "message") : undefined;

/**
 * The context an assistant message shows, counted as Claude Code's own context indicator counts it:
 * what the API call read (fresh input + cache read + cache creation). Its output joins the context
 * only as the next call's input. Cached tokens take the same room in the window as fresh ones (they
 * cost about a tenth to read), so `parts` keeps the split for the meter's tooltip. Undefined for a
 * subagent's message (parent_tool_use_id: its own context) or one without usage. With the advisor,
 * the top-level usage sums every iteration of the call; the last "message" one is the context.
 */
export function assistantUsage(msg: Record<string, any>): { used: number; parts: CallTokens; model: string | undefined } | undefined {
  if (msg?.type !== "assistant" || msg.parent_tool_use_id) return undefined;
  const reported = msg.message?.usage;
  if (!reported || typeof reported !== "object") return undefined;
  const usage = lastMessageIteration(reported) ?? reported;
  const parts = {
    fresh: count(usage.input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens),
  };
  const used = parts.fresh + parts.cacheRead + parts.cacheWrite;
  if (!used) return undefined;
  return { used, parts, model: typeof msg.message?.model === "string" ? msg.message.model : undefined };
}

/**
 * Claude Code's answer to a get_context_usage control request: the model's window (rawMaxTokens),
 * where it compacts the conversation on its own (autoCompactThreshold, when auto-compact is on) and
 * its own count of the context now (totalTokens: the last call's usage plus estimates).
 */
export function contextUsageReply(reply: unknown): { readonly window?: number; readonly compactAt?: number; readonly total?: number } | undefined {
  if (!reply || typeof reply !== "object") return undefined;
  const r = reply as Record<string, unknown>;
  const window = count(r.rawMaxTokens) || count(r.maxTokens);
  const compactAt = r.isAutoCompactEnabled === true ? count(r.autoCompactThreshold) : 0;
  const total = count(r.totalTokens);
  if (!window && !total) return undefined;
  return { ...(window ? { window } : {}), ...(compactAt ? { compactAt } : {}), ...(total ? { total } : {}) };
}

/**
 * The context window a result reports (modelUsage[model].contextWindow): the entry for `model`
 * (exactly, or one whose key starts with it), else the only entry, else the largest window.
 * The result's own usage is summed over the turn's calls, so it isn't the context size.
 */
export function resultWindow(msg: Record<string, any>, model: string | undefined): number | undefined {
  if (msg?.type !== "result") return undefined;
  const all = msg.modelUsage;
  if (!all || typeof all !== "object") return undefined;
  const entries = Object.entries(all as Record<string, any>).filter(([, v]) => count(v?.contextWindow) > 0);
  if (!entries.length) return undefined;
  const bare = model?.replace(/\[1m\]$/i, "");
  const match = (bare && entries.find(([k]) => k === model || k === bare)) || (bare && entries.find(([k]) => k.startsWith(bare) || bare.startsWith(k)));
  if (match) return count(match[1].contextWindow);
  if (entries.length === 1) return count(entries[0]![1].contextWindow);
  return Math.max(...entries.map(([, v]) => count(v.contextWindow)));
}

/** System prompt + tools, estimated from Uncut's own strings plus Claude Code's (about CLAUDE_CODE_BASE_TOKENS). */
export const systemToolsEstimate = (systemChars: number, toolsJsonChars: number) =>
  CLAUDE_CODE_BASE_TOKENS + estimateTokens(systemChars) + estimateTokens(toolsJsonChars, "json");

/** The meter's numbers: what claude reported, split into estimated parts (the conversation is the rest, never below 0). */
export function contextOf(o: {
  readonly used: number;
  readonly window?: number | undefined;
  readonly compactAt?: number | undefined;
  readonly parts?: CallTokens | undefined;
  readonly systemTools: number;
  readonly message: number;
  readonly model?: string | undefined;
  readonly answeredAt?: string | undefined;
  readonly billedToKey?: boolean | undefined;
}): AgentContext {
  const systemTools = Math.min(o.systemTools, o.used);
  const message = Math.min(o.message, Math.max(0, o.used - systemTools));
  return {
    used: o.used,
    ...(o.window ? { window: o.window } : {}),
    ...(o.compactAt ? { compactAt: o.compactAt } : {}),
    systemTools,
    conversation: Math.max(0, o.used - systemTools - message),
    message,
    ...(o.parts ? { fresh: o.parts.fresh, cacheRead: o.parts.cacheRead, cacheWrite: o.parts.cacheWrite, output: o.parts.output } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.answeredAt ? { answeredAt: o.answeredAt } : {}),
    ...(o.billedToKey ? { billedToKey: true } : {}),
  };
}

/** This message's context: what Uncut added to the user's words (the <context>, <editor-context> and other blocks), estimated. */
export const messageContextEstimate = (message: string, prompt: string) => estimateTokens(Math.max(0, message.length - prompt.length));
