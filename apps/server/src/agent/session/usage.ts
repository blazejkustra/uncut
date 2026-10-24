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

/**
 * The context an assistant message shows: what the API call read (input, cache read, cache
 * creation) plus what it wrote (which joins the conversation). Undefined for a subagent's message
 * (parent_tool_use_id: its own context) or one without usage.
 */
export function assistantUsage(msg: Record<string, any>): { used: number; model: string | undefined } | undefined {
  if (msg?.type !== "assistant" || msg.parent_tool_use_id) return undefined;
  const usage = msg.message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const used = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.output_tokens);
  if (!used) return undefined;
  return { used, model: typeof msg.message?.model === "string" ? msg.message.model : undefined };
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
  readonly systemTools: number;
  readonly message: number;
  readonly model?: string | undefined;
}): AgentContext {
  const systemTools = Math.min(o.systemTools, o.used);
  const message = Math.min(o.message, Math.max(0, o.used - systemTools));
  return {
    used: o.used,
    ...(o.window ? { window: o.window } : {}),
    systemTools,
    conversation: Math.max(0, o.used - systemTools - message),
    message,
    ...(o.model ? { model: o.model } : {}),
  };
}

/** This message's context: what Uncut added to the user's words (the <context>, <editor-context> and other blocks), estimated. */
export const messageContextEstimate = (message: string, prompt: string) => estimateTokens(Math.max(0, message.length - prompt.length));
