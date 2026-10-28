// C12: a project's agents. The server's AgentState carries every agent's turns and, per agent, its
// running turn, approval card, warning, context and thread start. The Agent tab shows one agent at a
// time (the selected one); "is anything running" questions ask about all of them.
import { DEFAULT_AGENT_ID, type AgentFocus, type AgentInfo, type AgentState, type AgentTurn } from "@uncut/contracts";
import { state, set, useApp } from "./store/core.ts";
import type { AppStateShape } from "./store/types.ts";

export const FOCUS_PRESETS: ReadonlyArray<{ readonly focus: AgentFocus; readonly label: string; readonly detail: string }> = [
  { focus: "general", label: "General", detail: "Anything in the edit" },
  { focus: "cuts", label: "Cuts", detail: "Timeline, cuts and pacing" },
  { focus: "graphics", label: "Graphics", detail: "Titles, text and graphics" },
  { focus: "look", label: "Look", detail: "Effects, colour and transforms" },
  { focus: "sound", label: "Sound", detail: "Music, mixer, volume and fades" },
  { focus: "captions", label: "Captions", detail: "Captions and subtitles" },
];

export const focusLabel = (focus: AgentFocus) => FOCUS_PRESETS.find((p) => p.focus === focus)?.label ?? focus;

export const turnAgent = (t: AgentTurn) => t.agentId ?? DEFAULT_AGENT_ID;

const singleMemo = new WeakMap<AgentState, ReadonlyArray<AgentInfo>>();
function singleAgent(agent: AgentState): ReadonlyArray<AgentInfo> {
  let list = singleMemo.get(agent);
  if (!list) {
    const status = agent.approval ? "waiting" : agent.running !== null ? "working" : "idle";
    list = [
      {
        id: DEFAULT_AGENT_ID,
        name: "Agent",
        focus: "general",
        colour: "#6d8cff",
        status,
        running: agent.running,
        approval: agent.approval,
        screenTake: agent.screenTake,
        warning: agent.warning,
        context: agent.context,
        threadStart: agent.threadStart,
      },
    ];
    singleMemo.set(agent, list);
  }
  return list;
}

/** The project's agents, oldest first (a server without several agents: one built from the top-level fields). */
export function agentsOf(agent: AgentState | null | undefined): ReadonlyArray<AgentInfo> {
  if (!agent) return [];
  return agent.agents?.length ? agent.agents : singleAgent(agent);
}

export const anyAgentRunning = (agent: AgentState | null | undefined) => agentsOf(agent).some((a) => a.running !== null);

/** The screen takes the agents wait for (D144), by approval id. */
export const agentScreenTakes = (agent: AgentState | null | undefined) => agentsOf(agent).flatMap((a) => (a.screenTake ? [a.screenTake] : []));

/** The turns every agent is running now. */
export const runningTurns = (agent: AgentState | null | undefined) =>
  agent ? agentsOf(agent).flatMap((a) => agent.turns.filter((t) => t.id === a.running)) : [];

export function selectedAgentId(s: AppStateShape = state): string {
  const agents = agentsOf(s.agent);
  const picked = s.agent ? s.agentSelected[s.agent.dir] : undefined;
  return agents.find((a) => a.id === picked)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
}

const viewMemo = new WeakMap<AgentState, Map<string, AgentState>>();
/** One agent's side of the state: its running turn, approval, warning, context and thread start, and only its turns. */
export function agentView(agent: AgentState, id: string): AgentState {
  if (!agent.agents?.length) return agent;
  let byId = viewMemo.get(agent);
  if (!byId) viewMemo.set(agent, (byId = new Map()));
  let view = byId.get(id);
  if (!view) {
    const info = agent.agents.find((a) => a.id === id);
    view = {
      ...agent,
      running: info?.running ?? null,
      approval: info?.approval,
      screenTake: info?.screenTake,
      warning: info?.warning,
      context: info?.context,
      threadStart: info?.threadStart,
      turns: agent.turns.filter((t) => turnAgent(t) === id),
    };
    byId.set(id, view);
  }
  return view;
}

export const selectedAgent = (s: AppStateShape = state) => (s.agent ? agentView(s.agent, selectedAgentId(s)) : null);

/** The selected agent's view, for the Agent tab. */
export function useSelectedAgent() {
  return selectedAgent(useApp());
}

const seenKey = (dir: string, id: string) => `${dir}\n${id}`;
function seenMark(agent: AgentState, id: string) {
  const last = agent.turns.findLast((t) => turnAgent(t) === id);
  return last ? `${last.id}:${last.status}` : "";
}

/** The selected agent's latest turn is seen, and so is every agent this window sees for the first time. */
export function noteAgentsSeen() {
  const agent = state.agent;
  if (!agent) return;
  const selected = selectedAgentId();
  let next: Record<string, string> | undefined;
  for (const a of agentsOf(agent)) {
    const key = seenKey(agent.dir, a.id);
    const was = state.agentSeen[key];
    if (was !== undefined && a.id !== selected) continue;
    const mark = seenMark(agent, a.id);
    if (was !== mark) (next ??= { ...state.agentSeen })[key] = mark;
  }
  if (next) set({ agentSeen: next });
}

/** A turn of another agent ended or started since the user last looked at it. */
export function agentUnread(s: AppStateShape, id: string): boolean {
  if (!s.agent || id === selectedAgentId(s)) return false;
  const was = s.agentSeen[seenKey(s.agent.dir, id)];
  return was !== undefined && was !== seenMark(s.agent, id);
}
