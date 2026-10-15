// The agent service's mutable state (agent.ts's layer), one object its factories share.
import type { AgentApproval } from "@uncut/contracts";
import type { CardAnswer } from "../agent.ts";
import type { ClaudeSession, Loaded, Running } from "./types.ts";

export interface AgentVars {
  loaded: Loaded | undefined;
  running: Running | undefined;
  // D194: shown in the Agent tab while the last claude didn't answer initialize (approvals fail closed).
  initWarning: string | undefined;
  // D218: shown in the Agent tab while the running turn is paused on a Claude usage limit.
  limitWarning: string | undefined;
  session: ClaudeSession | undefined;
  // The running turn's one open approval card (D99) and how to answer it.
  approval: { readonly card: AgentApproval; readonly answer: (a: "allow" | "deny" | "timeout" | "stopped", source?: string, extra?: CardAnswer) => void } | undefined;
}
