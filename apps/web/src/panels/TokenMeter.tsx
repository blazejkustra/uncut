// D261 (issue #93): how full the agent's context window is, next to the composer's send button.
// A small ring and "42k / 200k" from the usage claude reported after its last answer, "+~N" for the
// draft while typing (its words at ~4 characters a token plus the context Uncut adds, estimated
// like the last message's). The tooltip breaks the total down: system + tools, conversation, this
// message's context (estimates). Amber from 80 %, red from 95 %. Hidden until claude reported usage.
// D269 (#101): the window shows once it's known (Claude Code's get_context_usage, the model's "[1m]"
// or the result's modelUsage); until then only the used count ("72k"), the ring empty, never a
// guessed 200k. Handoff 8: counted as Claude Code's own indicator counts it (the last call's fresh
// input, cache read and cache write; cached tokens fill the window like fresh ones); amber and red
// are measured against where Claude Code compacts on its own when it says so.
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
  if (!c || !(c.used > 0)) return null;
  const window = c.window && c.window > 0 ? c.window : undefined;
  const share = window ? Math.min(1, c.used / window) : 0;
  const limit = c.compactAt && c.compactAt > 0 ? c.compactAt : window;
  const toLimit = limit ? c.used / limit : 0;
  const level = toLimit >= 0.95 ? "full" : toLimit >= 0.8 ? "high" : "ok";
  const cached = c.cacheRead !== undefined && c.cacheWrite !== undefined && c.fresh !== undefined;
  const draft = agentDraft.trim() ? Math.round(agentDraft.trim().length / 4) + c.message : 0;
  const lines = [
    window
      ? `Context: ${c.used.toLocaleString("en-US")} of ${window.toLocaleString("en-US")} tokens (${Math.round(share * 100)}%) after the agent's last answer, as Claude Code counts it`
      : `Context: ${c.used.toLocaleString("en-US")} tokens after the agent's last answer (the window shows once Claude Code reports it)`,
    ...(cached
      ? [
          `Cache read ${tokens(c.cacheRead!)}, cache write ${tokens(c.cacheWrite!)}, fresh ${tokens(c.fresh!)}: cached tokens fill the window like fresh ones but cost about a tenth to read`,
        ]
      : []),
    ...(c.compactAt && window
      ? [`Claude Code compacts the conversation on its own at ${tokens(c.compactAt)} (${Math.round((c.compactAt / window) * 100)}% of the window)`]
      : []),
    `System prompt + tools: ~${tokens(c.systemTools)} (estimate)`,
    `Conversation: ~${tokens(c.conversation)}`,
    `This message's context: ~${tokens(c.message)} (estimate)`,
    ...(draft ? [`Your draft adds ~${tokens(draft)} (estimate)`] : []),
    ...(level === "full"
      ? [
          "Almost full: Claude Code will summarise older messages soon, and details from earlier turns can be lost. Compact now (or type /compact) to choose when.",
        ]
      : level === "high"
        ? [
            `Getting full: past 80% of where ${c.compactAt ? "Claude Code compacts" : "the window ends"}. Compact (or /compact) summarises the conversation so far.`,
          ]
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
          {window ? `${tokens(c.used)} / ${tokens(window)}` : tokens(c.used)}
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
