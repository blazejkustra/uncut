// The Agent tab (D28, D48, D139-D142): turn cards with the agent's thinking, steps (a work log),
// reply and edit list, "Undo turn", the note about edits made by hand, and the composer. Live: text
// and thinking stream in, a line says what it's doing now. Names, never ids (AG5). Everything shown
// comes from the server's agent.subscribe stream; this component only sends, stops and undoes.
import { ChevronDown, Maximize2, TriangleAlert, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Composer } from "./Composer.tsx";
import { PlanChip, type CardLive } from "./AgentCards.tsx";
import { actions, getState, useApp, type Project } from "../state/store.ts";
import { ProjectContext } from "./agent/context.ts";
import { ClaudeStatus, AgentEmpty, AgentTakeLine } from "./agent/status.tsx";
import { TurnCard } from "./agent/TurnCard.tsx";
import { projectEmpty, stage, useStageDismissed } from "../editor/agentStage.ts";
import { panels } from "../editor/layout.ts";
import { Tooltip } from "../ui/Tooltip.tsx";

export function AgentPanel({ project, online }: { project: Project; online: boolean }) {
  const { agent, setupChecks, setupChecking, agentError, snapshot } = useApp();
  // #75 (D255): sent to the editor while still empty: the empty state can bring the stage back.
  const dir = snapshot?.dir;
  const canRestage = useStageDismissed().some((d) => d === dir) && projectEmpty(project);
  const thread = useRef<HTMLDivElement>(null);

  // Is Claude Code there and signed in? Onboarding may have checked already; otherwise check once.
  useEffect(() => {
    const s = getState();
    if (!s.setupChecks && !s.setupChecking) void actions.checkSetup();
  }, []);
  const claude = setupChecks?.find((c) => c.id === "claude");
  const blocked = claude?.status === "missing" || claude?.status === "needs-login";
  const turns = agent?.turns ?? [];
  const running = agent?.running ?? null;
  // D9: the session's estimated spend on the user's API keys (generators), when there is any.
  const sessionSpend = turns.reduce((n, t) => n + (t.spend ?? 0), 0);
  // D197: the latest brief and storyboard cards (edit, approve there), as "turn:item".
  const latest = new Set<string>();
  for (const type of ["brief", "storyboard"] as const) {
    let at: string | undefined;
    for (const t of turns) t.items.forEach((item, i) => item.kind === "card" && item.card?.type === type && (at = `${t.id}:${i}`));
    if (at) latest.add(at);
  }
  const live: CardLive | undefined = agent?.plan ? { plan: agent.plan, online, busy: running !== null, waiting: !!agent.approval?.storyboard } : undefined;

  // Follow the newest turn as it streams in, but only while the thread is scrolled to its end: someone
  // reading further up keeps their place (D203), and a "Latest" button takes them down. A new turn
  // (the user just sent) always goes to the end. The empty state stays scrolled to its top.
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const lastCount = useRef(turns.length);
  useLayoutEffect(() => {
    const el = thread.current;
    if (!el || !turns.length) return;
    if (turns.length !== lastCount.current) stuck.current = true;
    lastCount.current = turns.length;
    if (stuck.current) el.scrollTop = el.scrollHeight;
  }, [agent, turns.length]);
  const onScroll = () => {
    const el = thread.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (away === stuck.current) setAway(!stuck.current);
  };
  const toLatest = () => {
    const el = thread.current;
    if (!el) return;
    stuck.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <ProjectContext.Provider value={project}>
    <div className="agent" data-testid="agent-panel">
      {agent?.warning && (
        <p className="err agent-warning" data-testid="agent-warning">
          <TriangleAlert />
          {agent.warning}
        </p>
      )}
      {/* An empty plan has no chip: no strip either (it left a bare rule above the empty state). */}
      {agent?.plan && (agent.plan.brief || agent.plan.storyboard || agent.plan.reviews.length > 0) && (
        <div className="plan-strip agent-strip">
          <span className="spacer" />
          <PlanChip plan={agent.plan} />
        </div>
      )}
      <div className="agent-thread" ref={thread} data-testid="agent-thread" onScroll={onScroll}>
        {claude && claude.status !== "ready" && <ClaudeStatus check={claude} checking={setupChecking} />}
        {turns.length === 0 ? (
          <>
            <AgentEmpty name={project.name} />
            {canRestage && dir && (
              <button
                className="link-btn agent-stage-back"
                data-testid="agent-stage-reopen"
                title="Show the agent in the middle of the window"
                onClick={() => {
                  panels.focus(false);
                  stage.reopen(dir);
                }}
              >
                <Maximize2 />
                Open in the middle
              </button>
            )}
          </>
        ) : (
          turns.map((t) => <TurnCard key={t.id} turn={t} busy={running !== null} online={online} approval={agent?.approval?.turnId === t.id ? agent.approval : undefined} latest={latest} live={live} />)
        )}
        <AgentTakeLine />
        {sessionSpend > 0 && (
          <div className="agent-spend small muted" data-testid="agent-session-spend">
            About ${sessionSpend.toFixed(2)} billed to your API keys in this project so far (estimates).
          </div>
        )}
      </div>
      {away && turns.length > 0 && (
        <button className="agent-latest" data-testid="agent-latest" onClick={toLatest}>
          <ChevronDown />
          {agent?.approval ? "Waiting for your answer below" : "Latest"}
        </button>
      )}
      {agentError && (
        <div className="agent-error inline-error small" data-testid="agent-error">
          <span>{agentError}</span>
          <Tooltip label="Dismiss">
            <button className="icon-btn" onClick={actions.dismissAgentError}>
              <X />
            </button>
          </Tooltip>
        </div>
      )}
      <Composer project={project} online={online} blocked={blocked} turns={turns} running={running} provider={agent?.provider ?? "Claude Code"} />
    </div>
    </ProjectContext.Provider>
  );
}
