// D261 (issue #93): how full the agent's context window is, next to the composer's send button.
// A small ring and "42k / 200k" from the usage claude reported after its last answer, "+~N" for the
// draft while typing (its words at ~4 characters a token plus the context Uncut adds, estimated
// like the last message's). The tooltip breaks the total down: system + tools, conversation, this
// message's context (estimates). Amber from 80 %, red from 95 %. Hidden until claude reported usage.
import { useApp } from "../state/store.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import "./token-meter.css";

/** 950 → "950", 1234 → "1.2k", 42_300 → "42k", 1_000_000 → "1M". */
export function tokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 10_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const R = 5.5;
const RING = 2 * Math.PI * R;

export function TokenMeter() {
  const { agent, agentDraft } = useApp();
  const c = agent?.context;
  if (!c || !(c.window > 0)) return null;
  const share = Math.min(1, c.used / c.window);
  const level = share >= 0.95 ? "full" : share >= 0.8 ? "high" : "ok";
  const draft = agentDraft.trim() ? Math.round(agentDraft.trim().length / 4) + c.message : 0;
  const lines = [
    `Context: ${c.used.toLocaleString("en-US")} of ${c.window.toLocaleString("en-US")} tokens (${Math.round(share * 100)}%), after the agent's last answer`,
    `System prompt + tools: ~${tokens(c.systemTools)} (estimate)`,
    `Conversation: ~${tokens(c.conversation)}`,
    `This message's context: ~${tokens(c.message)} (estimate)`,
    ...(draft ? [`Your draft adds ~${tokens(draft)} (estimate)`] : []),
    ...(level === "full"
      ? ["Almost full: when the window runs out, Claude Code may summarise older messages, and details from earlier turns can be lost. Keep messages short."]
      : level === "high"
        ? ["Getting full: past 80% of the window."]
        : []),
  ];
  return (
    <Tooltip label={lines.join("\n")}>
      <span className={`token-meter ${level}`} data-testid="agent-token-meter" data-level={level} tabIndex={0}>
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <circle className="track" cx="7" cy="7" r={R} />
          <circle className="fill" cx="7" cy="7" r={R} strokeDasharray={`${share * RING} ${RING}`} />
        </svg>
        <span className="token-meter-text" data-testid="agent-token-used">
          {tokens(c.used)} / {tokens(c.window)}
        </span>
        {draft > 0 && (
          <span className="token-meter-draft" data-testid="agent-token-draft">
            +~{tokens(draft)}
          </span>
        )}
      </span>
    </Tooltip>
  );
}
