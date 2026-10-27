// The composer's choices per project (U4, D184): provider (issue #106), model, effort and access, remembered on this Mac
// by project folder (localStorage uncut.agent.prefs, the newest 50), and the favourite models
// (uncut.agent.favourites). Changing one fires "uncut:agent-prefs" so every composer follows.
import { AGENT_ACCESS, AGENT_EFFORTS, AGENT_MODELS, AGENT_PROVIDERS, type AgentAccess, type AgentEffort, type AgentProvider } from "@uncut/contracts";
import { useEffect, useState } from "react";

export interface AgentPrefs {
  // Issue #106: the agent CLI the turns run in.
  readonly provider: AgentProvider;
  // A model id from AGENT_MODELS of that provider; undefined = the CLI's default.
  readonly model?: string | undefined;
  // undefined = Claude Code's default effort.
  readonly effort?: AgentEffort | undefined;
  readonly access: AgentAccess;
}

// D214: Auto (Claude Code's own auto mode) for every project never set.
export const DEFAULT_AGENT_PREFS: AgentPrefs = { provider: "claude", access: "auto" };
const PREFS_KEY = "uncut.agent.prefs";
const FAVOURITES_KEY = "uncut.agent.favourites";
const EVENT = "uncut:agent-prefs";

const readJson = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};

const clean = (raw: unknown): AgentPrefs => {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const provider: AgentProvider =
    typeof p.provider === "string" && (AGENT_PROVIDERS as ReadonlyArray<string>).includes(p.provider) ? (p.provider as AgentProvider) : "claude";
  return {
    provider,
    // A model of another provider (the provider was switched) is that CLI's default.
    ...(typeof p.model === "string" && AGENT_MODELS.some((m) => m.id === p.model && m.provider === provider) ? { model: p.model } : {}),
    ...(typeof p.effort === "string" && (AGENT_EFFORTS as ReadonlyArray<string>).includes(p.effort) ? { effort: p.effort as AgentEffort } : {}),
    // D214: "edit" (Edit freely, before Auto) and anything unknown become Auto.
    access: typeof p.access === "string" && (AGENT_ACCESS as ReadonlyArray<string>).includes(p.access) ? (p.access as AgentAccess) : "auto",
  };
};

/** The project's choices (the defaults for a project never set). */
export function agentPrefs(dir: string): AgentPrefs {
  const all = readJson(PREFS_KEY);
  const list = Array.isArray(all) ? (all as Array<[string, unknown]>) : [];
  const hit = list.find((e) => Array.isArray(e) && e[0] === dir);
  return hit ? clean(hit[1]) : DEFAULT_AGENT_PREFS;
}

export function setAgentPrefs(dir: string, patch: Partial<AgentPrefs>) {
  const next = clean({ ...agentPrefs(dir), ...patch });
  const all = readJson(PREFS_KEY);
  const list = (Array.isArray(all) ? (all as Array<[string, unknown]>) : []).filter((e) => Array.isArray(e) && e[0] !== dir);
  list.unshift([dir, next]);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(list.slice(0, 50)));
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}

export function favouriteModels(): ReadonlyArray<string> {
  const raw = readJson(FAVOURITES_KEY);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

export function toggleFavourite(id: string) {
  const now = favouriteModels();
  try {
    localStorage.setItem(FAVOURITES_KEY, JSON.stringify(now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}

/** The project's choices and the favourites, kept current. */
export function useAgentPrefs(dir: string): { prefs: AgentPrefs; favourites: ReadonlyArray<string> } {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return { prefs: agentPrefs(dir), favourites: favouriteModels() };
}
