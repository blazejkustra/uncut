// The Agent tab (D28, D48, D139-D142): turn cards with the agent's thinking, steps (a work log),
// reply and edit list, "Undo turn", the note about edits made by hand, and the composer. Live: text
// and thinking stream in, a line says what it's doing now. Names, never ids (AG5). Everything shown
// comes from the server's agent.subscribe stream; this component only sends, stops and undoes.
import type { AgentApproval, AgentItem, AgentTurn, SetupCheck } from "@uncut/contracts";
import { friendlyText } from "@uncut/core/mentions";
import { Brain, Check, ChevronDown, ChevronRight, Copy, LoaderCircle, Pencil, RefreshCw, Sparkles, Square, TriangleAlert, Undo2, X } from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { Composer, withChips } from "./Composer.tsx";
import { actions, getState, useApp, type Project } from "../state/store.ts";

/** The project, for names instead of ids in what the cards show (AG5). */
const ProjectContext = createContext<Project | undefined>(undefined);
const useFriendly = () => {
  const project = useContext(ProjectContext);
  return (text: string) => friendlyText(project as never, text);
};

// Prompts that work on an empty project: text needs no media (D48).
const EXAMPLES = [
  "Make a 5 s title card that says “Kraków from above”",
  "Add a lower third at 2 s that says “Shot from a drone”",
  "Start with a 3 s title “Weekend in the mountains” and end with “Thanks for watching”",
];

export function AgentPanel({ project, online }: { project: Project; online: boolean }) {
  const { agent, setupChecks, setupChecking, agentError } = useApp();
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

  // Follow the newest turn as it streams in (the empty state stays scrolled to its top).
  useEffect(() => {
    const el = thread.current;
    if (el && turns.length) el.scrollTop = el.scrollHeight;
  }, [agent, turns.length]);

  // An example goes into the prompt box, ready to send or change. Focus moves there now, so the
  // next Enter sends it rather than pressing the example again.
  const pick = (example: string) => {
    actions.setAgentDraft(example, []);
    document.getElementById("agent-input")?.focus();
  };

  return (
    <ProjectContext.Provider value={project}>
    <div className="agent" data-testid="agent-panel">
      <div className="agent-thread" ref={thread} data-testid="agent-thread">
        {claude && claude.status !== "ready" && <ClaudeStatus check={claude} checking={setupChecking} />}
        {turns.length === 0 ? (
          <AgentEmpty onPick={pick} disabled={blocked || !online} />
        ) : (
          turns.map((t) => <TurnCard key={t.id} turn={t} busy={running !== null} online={online} approval={agent?.approval?.turnId === t.id ? agent.approval : undefined} />)
        )}
        {sessionSpend > 0 && (
          <div className="agent-spend small muted" data-testid="agent-session-spend">
            About ${sessionSpend.toFixed(2)} billed to your API keys in this project so far (estimates).
          </div>
        )}
      </div>
      {agentError && (
        <div className="agent-error inline-error small" data-testid="agent-error">
          <span>{agentError}</span>
          <button className="icon-btn" title="Dismiss" onClick={actions.dismissAgentError}>
            <X />
          </button>
        </div>
      )}
      <Composer project={project} online={online} blocked={blocked} turns={turns} running={running} provider={agent?.provider ?? "Claude Code"} />
    </div>
    </ProjectContext.Provider>
  );
}

function AgentEmpty({ onPick, disabled }: { onPick: (prompt: string) => void; disabled: boolean }) {
  return (
    <div className="agent-empty" data-testid="agent-empty">
      <div className="empty-icon">
        <Sparkles />
      </div>
      <div className="empty-title">Ask for an edit</div>
      <div className="agent-empty-sub">
        The agent sees the timeline and edits it live with your Claude Code login. No media needed to start: it can make titles and text right away. Every turn can be undone.
      </div>
      <div className="agent-examples">
        {EXAMPLES.map((example) => (
          <button key={example} className="agent-example" data-testid="agent-example" disabled={disabled} onClick={() => onPick(example)}>
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Claude Code missing, signed out or billed elsewhere: what's wrong and the fix, as in onboarding. */
function ClaudeStatus({ check, checking }: { check: SetupCheck; checking: boolean }) {
  const blocking = check.status === "missing" || check.status === "needs-login";
  return (
    <div className={`agent-setup ${blocking ? "blocking" : ""}`} data-testid="agent-setup" data-status={check.status}>
      <div className="agent-setup-head">
        <TriangleAlert />
        <span className="grow">
          <b>{check.status === "missing" ? "Claude Code isn't installed" : check.status === "needs-login" ? "Claude Code isn't signed in" : "Claude Code"}</b>
          <span className="agent-setup-detail">{check.detail}</span>
        </span>
      </div>
      {check.fix && (
        <div className="agent-setup-fix">
          <span>{check.fix.text}</span>
          {check.fix.command && (
            <div className="wiz-cmd">
              <code data-testid="agent-setup-command">{check.fix.command}</code>
              <button className="link-btn" onClick={() => void actions.copy(check.fix!.command!)} title="Copy the command">
                <Copy />
                Copy
              </button>
            </div>
          )}
        </div>
      )}
      {blocking && (
        <button className="btn agent-setup-again" data-testid="agent-check-again" disabled={checking} onClick={() => void actions.checkSetup()}>
          <RefreshCw className={checking ? "spin" : ""} />
          Check again
        </button>
      )}
    </div>
  );
}

function TurnCard({ turn: t, busy, online, approval }: { turn: AgentTurn; busy: boolean; online: boolean; approval?: AgentApproval | undefined }) {
  const friendly = useFriendly();
  const undone = t.undo.state === "undone";
  const status =
    // While it runs, the now line in the card says what it's doing (D139).
    t.status === "running" ? null : undone ? (
      "Undone"
    ) : t.status === "cancelled" ? (
      "Stopped"
    ) : t.status === "error" ? (
      "Didn't finish"
    ) : (
      `Claude Code${t.seconds !== undefined ? `, ${Math.max(1, Math.round(t.seconds))} s` : ""}`
    );
  // D9 / D99: what generators billed to the user's keys cost in this turn (an estimate).
  const spend = t.spend ? (
    <span className="turn-spend" data-testid="agent-turn-spend" title="Estimated cost of generators billed to your API keys in this turn">
      About ${t.spend.toFixed(2)} on your keys
    </span>
  ) : null;
  const canShowUndo = t.undo.state === "available" || t.undo.state === "blocked" || t.undo.state === "unavailable";
  return (
    <div className="turn-wrap" data-testid="agent-turn" data-turn={t.id} data-status={t.status} data-undo={t.undo.state}>
      <div className="msg-user" data-testid="agent-prompt">
        {withChips(t.prompt, (t.mentions ?? []).map((m) => m.label))}
      </div>
      {t.note && <ManualNote note={t.note} />}
      <div className={`turn ${t.status} ${undone ? "undone" : ""}`}>
        <div className="turn-body">
          {groupItems(t.items).map((g) =>
            g.kind === "steps" ? (
              <WorkLog key={g.at} steps={g.items} />
            ) : g.item.kind === "thinking" ? (
              <Thinking key={g.at} item={g.item} />
            ) : (
              <Reply key={g.at} text={friendly(g.item.text)} live={!!g.item.live} />
            ),
          )}
          {t.status === "running" && <NowLine turn={t} waiting={!!approval} />}
          {t.edits.length > 0 && (
            <div className="turn-edits" data-testid="agent-edits">
              <div className="turn-edits-label">
                {t.edits.length === 1 ? "1 edit" : `${t.edits.length} edits`}
                {undone ? ", undone" : ""}
              </div>
              {t.edits.map((e) => (
                <div key={e.revision} className="turn-edit" data-testid="agent-edit">
                  <div className="turn-edit-summary">{friendly(e.summary)}</div>
                  {e.lines.map((line, i) => (
                    <div key={i} className="turn-edit-line">
                      {friendly(line)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {approval && <ApprovalCard approval={approval} online={online} />}
          {t.error && (
            <p className="err" data-testid="agent-turn-error">
              {t.error}
            </p>
          )}
        </div>
        <div className="turn-foot">
          <span className="turn-status">{status}</span>
          {spend}
          <span className="spacer" />
          {t.status === "running" && (
            <button className="link-btn" data-testid="agent-cancel" disabled={!online} onClick={() => void actions.agentCancel()}>
              <Square />
              Stop
            </button>
          )}
          {canShowUndo && (
            <button
              className="link-btn"
              data-testid="agent-undo-turn"
              data-turn={t.id}
              disabled={!online || busy || t.undo.state !== "available"}
              title={t.undo.state === "available" ? "Take back this turn's edits; later edits stay" : (t.undo.reason ?? "Can't undo this turn")}
              onClick={() => void actions.agentUndoTurn(t.id)}
            >
              <Undo2 />
              Undo turn
            </button>
          )}
        </div>
        {(t.undo.state === "blocked" || t.undo.state === "unavailable") && t.undo.reason && (
          <div className="turn-undo-reason" data-testid="agent-undo-reason">
            {t.undo.reason}
          </div>
        )}
      </div>
    </div>
  );
}

/** D99: the agent wants to spend over $1 of the user's key; it waits for Allow or Don't (no answer in 2 minutes is no). */
function ApprovalCard({ approval, online }: { approval: AgentApproval; online: boolean }) {
  const [sent, setSent] = useState(false);
  const answer = (allow: boolean) => {
    setSent(true);
    void actions.agentApprove(approval.id, allow);
  };
  return (
    <div className="approval" data-testid="agent-approval" data-id={approval.id}>
      <div className="approval-text">{approval.text}?</div>
      <div className="approval-sub">The agent waits for your answer. Billed to your own key; no answer in 2 minutes means no.</div>
      <div className="approval-btns">
        <button className="btn ghost" data-testid="agent-decline" disabled={!online || sent} onClick={() => answer(false)}>
          Don't
        </button>
        <button className="btn primary" data-testid="agent-allow" disabled={!online || sent} onClick={() => answer(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}

/** D6: the edits by hand the agent was told about with this prompt. */
function ManualNote({ note }: { note: string }) {
  const friendly = useFriendly();
  const lines = note.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  return (
    <div className="manual-note" data-testid="agent-note">
      <div className="manual-note-head">
        <Pencil />
        {lines.length === 1 ? "Told the agent about 1 change you made by hand" : `Told the agent about ${lines.length} changes you made by hand`}
      </div>
      {lines.map((line, i) => (
        <div key={i} className="manual-note-line">
          {friendly(line)}
        </div>
      ))}
    </div>
  );
}

/** The little markdown agents write: paragraphs, "- " bullets, **bold** and `code`. */
function Reply({ text, live = false }: { text: string; live?: boolean }) {
  const inline = (s: string): ReactNode =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <b key={i}>{part.slice(2, -2)}</b>
      ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
  return (
    <div className={`reply ${live ? "live" : ""}`} data-testid="agent-reply" data-live={live ? "true" : undefined}>
      {text.split(/\n{2,}/).map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*] /.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*] /, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

type Group = { kind: "steps"; at: number; items: Array<AgentItem> } | { kind: "one"; at: number; item: AgentItem };

/** Consecutive steps make one work log; text and thinking stand alone. */
function groupItems(items: ReadonlyArray<AgentItem>): Array<Group> {
  const out: Array<Group> = [];
  items.forEach((item, at) => {
    const last = out.at(-1);
    if (item.kind === "step" && last?.kind === "steps") last.items.push(item);
    else if (item.kind === "step") out.push({ kind: "steps", at, items: [item] });
    else out.push({ kind: "one", at, item });
  });
  return out;
}

const StepIcon = ({ status }: { status?: string | undefined }) => (status === "error" ? <X className="bad" /> : status === "running" ? <LoaderCircle className="spin" /> : <Check />);

/** Tool calls in a row (D139): one line ("Added title, and 3 more"), opened for every step. */
function WorkLog({ steps }: { steps: ReadonlyArray<AgentItem> }) {
  const friendly = useFriendly();
  const [open, setOpen] = useState(false);
  const one = (s: AgentItem, i: number) => (
    <div key={i} className="step" data-testid="agent-step" data-status={s.status}>
      <StepIcon status={s.status} />
      <span>{friendly(s.text)}</span>
    </div>
  );
  if (steps.length === 1) return <div className="worklog">{one(steps[0]!, 0)}</div>;
  const failed = steps.filter((s) => s.status === "error").length;
  const runningNow = steps.some((s) => s.status === "running");
  const lead = steps.at(-1)!;
  return (
    <div className={`worklog ${open ? "open" : ""}`} data-testid="agent-worklog" data-count={steps.length}>
      <button className="worklog-head" data-testid="agent-worklog-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown /> : <ChevronRight />}
        <StepIcon status={runningNow ? "running" : failed === steps.length ? "error" : "done"} />
        <span className="ellipsis grow">
          {friendly(lead.text)}, and {steps.length - 1} more
          {failed ? <span className="worklog-failed">, {failed} didn't work</span> : null}
        </span>
      </button>
      {open && <div className="worklog-steps">{steps.map(one)}</div>}
      {/* Kept for tests and screen readers: every step, even folded. */}
      {!open && <div className="sr-only">{steps.map(one)}</div>}
    </div>
  );
}

/** A thinking summary (D139): folded to one line, opened for all of it; the latest line while it streams. */
function Thinking({ item }: { item: AgentItem }) {
  const [open, setOpen] = useState(false);
  const lines = item.text.trim().split("\n").filter(Boolean);
  return (
    <div className={`thinking ${open ? "open" : ""}`} data-testid="agent-thinking" data-live={item.live ? "true" : undefined}>
      <button className="thinking-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Brain />
        <span className="ellipsis grow">{item.live ? (lines.at(-1) ?? "Thinking") : open ? "Thinking" : (lines[0] ?? "Thinking")}</span>
        {open ? <ChevronDown /> : <ChevronRight />}
      </button>
      {open && <div className="thinking-body">{item.text}</div>}
    </div>
  );
}

/** What the agent is doing now (D139): the running step, writing, thinking, or starting. */
function NowLine({ turn, waiting }: { turn: AgentTurn; waiting: boolean }) {
  const friendly = useFriendly();
  const last = turn.items.at(-1);
  const step = [...turn.items].reverse().find((i) => i.kind === "step" && i.status === "running");
  const what = waiting
    ? "Waiting for your answer"
    : step
      ? friendly(step.text)
      : last?.kind === "thinking" && last.live
        ? "Thinking"
        : last?.kind === "text" && last.live
          ? "Writing"
          : turn.items.length === 0
            ? "Starting Claude Code"
            : "Working";
  return (
    <div className="now-line" data-testid="agent-now">
      <LoaderCircle className="spin" />
      <span className="ellipsis">{what}…</span>
    </div>
  );
}
