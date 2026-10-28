// C12: a project's agents as history.db's meta "agents" keeps them (no schema change: older builds ignore the key).
import { AGENT_FOCUSES, type AgentFocus, DEFAULT_AGENT_ID } from "@uncut/contracts";

export interface StoredAgent {
  readonly id: string;
  readonly name: string;
  readonly focus: AgentFocus;
  readonly colour: string;
  readonly createdAt: string;
  readonly archivedAt?: string | undefined;
}

export const AGENT_COLOURS = ["#5b8def", "#3fb68b", "#d9a43b", "#b072d8", "#e0655b", "#4bb3c4"] as const;

export const defaultAgent = (): StoredAgent => ({
  id: DEFAULT_AGENT_ID,
  name: "Editor",
  focus: "general",
  colour: AGENT_COLOURS[0],
  createdAt: new Date(0).toISOString(),
});

const isString = (v: unknown): v is string => typeof v === "string";

function storedAgent(raw: unknown): StoredAgent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  if (!isString(a.id) || !isString(a.name)) return undefined;
  return {
    id: a.id,
    name: a.name.slice(0, 40),
    focus: AGENT_FOCUSES.find((f) => f === a.focus) ?? "general",
    colour: isString(a.colour) && /^#[0-9a-f]{6}$/i.test(a.colour) ? a.colour : AGENT_COLOURS[0],
    createdAt: isString(a.createdAt) ? a.createdAt : new Date(0).toISOString(),
    ...(isString(a.archivedAt) ? { archivedAt: a.archivedAt } : {}),
  };
}

/** The saved list, the default agent first (a project from before several agents has only it). */
export function storedAgents(json: string | undefined): Array<StoredAgent> {
  let parsed: unknown = [];
  try {
    parsed = json ? JSON.parse(json) : [];
  } catch {}
  const list = (Array.isArray(parsed) ? parsed : []).flatMap((x) => storedAgent(x) ?? []);
  const unique = list.filter((a, i) => list.findIndex((b) => b.id === a.id) === i);
  return unique.some((a) => a.id === DEFAULT_AGENT_ID) ? unique : [defaultAgent(), ...unique];
}

/** An author of the edit log in words: the user, or an agent of the project by its name. */
export function authorWords(author: string, agents: ReadonlyArray<StoredAgent>): string {
  if (author === "user") return "the user";
  if (author === "agent") return "the agent";
  return agents.find((a) => a.id === author)?.name ?? author;
}
