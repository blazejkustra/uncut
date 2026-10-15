import { Sparkles, X } from "lucide-react";
import { useApp, actions } from "../../state/store.ts";
import { changeLabel } from "../../state/agentFollow.ts";

/** D202: where the agent changed things while the user was watching; a click jumps there. */
export function AgentChangePill({ fps }: { fps: number }) {
  const { agentChange } = useApp();
  if (!agentChange) return null;
  return (
    <div className="agent-change" data-testid="agent-change" data-from={agentChange.from} data-to={agentChange.to}>
      <button className="agent-change-jump" data-testid="agent-change-jump" title="Jump there" onClick={actions.agentJump}>
        <Sparkles />
        {changeLabel(agentChange, fps)}
      </button>
      <button className="icon-btn" data-testid="agent-change-dismiss" title="Dismiss" onClick={actions.dismissAgentChange}>
        <X />
      </button>
    </div>
  );
}
