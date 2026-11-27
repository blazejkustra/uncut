import { LocateFixed } from "lucide-react";

import { Tooltip } from "../../ui/Tooltip.tsx";
import { followAgent, useFollowAgent } from "./follow.ts";

/** D348: the timeline toolbar's Follow agent toggle. */
export function FollowAgentButton() {
  const on = useFollowAgent();
  return (
    <Tooltip label={on ? "Following the agent: the timeline scrolls to its cursor" : "Follow agent: scroll the timeline to its cursor"}>
      <button className={`icon-btn ${on ? "on" : ""}`} data-testid="follow-agent" aria-pressed={on} onClick={followAgent.toggle}>
        <LocateFixed />
      </button>
    </Tooltip>
  );
}
