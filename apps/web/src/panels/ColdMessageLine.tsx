import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { actions } from "../state/store.ts";
import { useSelectedAgent } from "../state/agents.ts";
import { coldMessage, type ColdMessage } from "../state/coldMessage.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import { tokens } from "./TokenMeter.tsx";
import "./cold-message.css";

const CLOCK_MS = 30_000;
const dismissed = new Set<string>();

/** The current time, ticking so a line can appear with the composer open. */
function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const coldWords = (cold: ColdMessage) => {
  const cost = cold.dollars === undefined ? "" : ` (about $${cold.dollars.toFixed(2)})`;
  return cold.reason === "idle"
    ? `Idle over an hour: next message rewrites ${tokens(cold.tokens)} tokens${cost}`
    : `New session: next message may rewrite ${tokens(cold.tokens)} tokens${cost}`;
};

export function ColdMessageLine({ online, agentId }: { online: boolean; agentId: string }) {
  const agent = useSelectedAgent();
  const now = useClock();
  const [, setDismissals] = useState(0);
  const context = agent?.context;
  const cold = coldMessage(context, now);
  const key = `${agent?.dir}:${agentId}:${context?.answeredAt}`;
  if (!cold || !online || agent?.running !== null || dismissed.has(key)) return null;
  const dismiss = () => {
    dismissed.add(key);
    setDismissals((n) => n + 1);
  };
  return (
    <div className="cold-message" data-testid="agent-cold-message" role="status">
      <span className="cold-message-text">{coldWords(cold)}</span>
      <Tooltip label="Dismiss">
        <button className="icon-btn cold-message-dismiss" data-testid="agent-cold-dismiss" aria-label="Dismiss" onClick={dismiss}>
          <X />
        </button>
      </Tooltip>
      <div className="cold-message-actions">
        <Tooltip label="Compact reads the whole context once to summarise it, then every later message is smaller">
          <button className="cold-message-action" data-testid="agent-cold-compact" onClick={() => void actions.agentCompact()}>
            Compact
          </button>
        </Tooltip>
        <Tooltip label="A new chat skips the rewrite: the agent starts fresh, without this conversation">
          <button className="cold-message-action" data-testid="agent-cold-new-chat" onClick={() => void actions.agentNewThread()}>
            New chat
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
