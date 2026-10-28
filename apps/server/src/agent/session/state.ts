// The agent service's mutable state (agent.ts's layer), one object its factories share.
import type { AgentApproval } from "@uncut/contracts";
import type { CardAnswer } from "../agent.ts";
import type { Loaded } from "./types.ts";

export interface AgentVars {
  // C12: the open project's agents (oldest first, archived ones left out), each with its own
  // conversation, claude session, running turn and approval card.
  agents: Array<Loaded>;
  // The agents of a project that closed while one of them still ran (its turn is stopping): the
  // same folder opened again takes them back.
  closing: Array<Loaded>;
  // Agents whose message send is still preparing (the shell, skills, the plan): they count as working.
  readonly starting: Set<Loaded>;
}

/** An agent's open approval card (D99) and how to answer it. */
export interface Approval {
  readonly card: AgentApproval;
  readonly answer: (a: "allow" | "deny" | "timeout" | "stopped", source?: string, extra?: CardAnswer) => void;
}
