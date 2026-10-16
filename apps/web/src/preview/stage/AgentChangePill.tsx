import { Sparkles, X } from "lucide-react";
import { useApp, actions } from "../../state/store.ts";
import { changeLabel } from "../../state/agentChange.ts";
import { Tooltip } from "../../ui/Tooltip.tsx";

/** D202, D235: where the agent changed things; a click jumps there. */
export function AgentChangePill({ fps }: { fps: number }) {
  const { agentChange } = useApp();
  if (!agentChange) return null;
  return (
    <div className="agent-change" data-testid="agent-change" data-from={agentChange.from} data-to={agentChange.to}>
      <button className="agent-change-jump" data-testid="agent-change-jump" title="Jump there" onClick={actions.agentJump}>
        <Sparkles />
        {changeLabel(agentChange, fps)}
      </button>
      <Tooltip label="Dismiss">
        <button className="icon-btn" data-testid="agent-change-dismiss" onClick={actions.dismissAgentChange}>
          <X />
        </button>
      </Tooltip>
    </div>
  );
}
