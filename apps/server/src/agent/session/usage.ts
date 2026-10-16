// D261 (issue #93): how full the agent's context window is, from the usage claude reports in its
// stream-json, plus a rough breakdown for the composer's meter. Pure: no I/O, no state.
import type { AgentContext } from "@uncut/contracts";

/** Claude Code's own system prompt and built-in tools, which Uncut can't see: about this many tokens. */
export const CLAUDE_CODE_BASE_TOKENS = 20_000;

/** A rough token count: prose about 4 characters a token, JSON schemas about 2.4. */
export const estimateTokens = (chars: number, kind: "prose" | "json" = "prose") => Math.round(Math.max(0, chars) / (kind === "json" ? 2.4 : 4));

/** The window a model id implies when claude didn't say: "[1m]" in the id is the 1M window, else 200k. */
export const windowFor = (model: string | undefined) => (model && /\[1m\]/i.test(model) ? 1_000_000 : 200_000);

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
export const systemToolsEstimate = (systemChars: number, toolsJsonChars: number) => CLAUDE_CODE_BASE_TOKENS + estimateTokens(systemChars) + estimateTokens(toolsJsonChars, "json");

/** The meter's numbers: what claude reported, split into estimated parts (the conversation is the rest, never below 0). */
export function contextOf(o: { readonly used: number; readonly window: number; readonly systemTools: number; readonly message: number; readonly model?: string | undefined }): AgentContext {
  const systemTools = Math.min(o.systemTools, o.used);
  const message = Math.min(o.message, Math.max(0, o.used - systemTools));
  return { used: o.used, window: o.window, systemTools, conversation: Math.max(0, o.used - systemTools - message), message, ...(o.model ? { model: o.model } : {}) };
}

/** This message's context: what Uncut added to the user's words (the <context>, <editor-context> and other blocks), estimated. */
export const messageContextEstimate = (message: string, prompt: string) => estimateTokens(Math.max(0, message.length - prompt.length));
