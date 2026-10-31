// Past the prompt cache's hour the next message rewrites the whole context, so the composer says so
// first. Pure, so the audit's turns can be replayed through the same rule.
import type { AgentContext } from "@uncut/contracts";

export const CACHE_TTL_MS = 60 * 60_000;
export const COLD_MIN_TOKENS = 200_000;
/** Fitted to Claude Code's own cost on claude-opus-5-5; other models have no measured rate. */
const CACHE_WRITE_PER_MILLION = 8;
const PRICED_MODEL = /^claude-opus-5-5/;

export interface ColdMessage {
  readonly tokens: number;
  /** Only when an API key pays: a subscription's message costs no dollars. */
  readonly dollars?: number;
}

export function coldMessage(context: AgentContext | undefined, now: number): ColdMessage | undefined {
  if (!context?.answeredAt || context.used <= COLD_MIN_TOKENS) return undefined;
  if (now - Date.parse(context.answeredAt) <= CACHE_TTL_MS) return undefined;
  const priced = context.billedToKey && PRICED_MODEL.test(context.model ?? "");
  return { tokens: context.used, ...(priced ? { dollars: (context.used * CACHE_WRITE_PER_MILLION) / 1_000_000 } : {}) };
}
