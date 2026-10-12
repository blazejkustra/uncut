// The Agent tab (D28, D48): turn cards with the agent's steps, reply and edit list, "Undo turn",
// the note about edits made by hand, and a prompt box. Everything shown comes from the server's
// agent.subscribe stream; this component only sends prompts, cancels and undoes turns.
import type { AgentTurn, SetupCheck } from "@uncut/contracts";
import { ArrowUp, Check, Copy, LoaderCircle, MousePointer2, Pencil, RefreshCw, Sparkles, Square, TriangleAlert, Undo2, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { frameTimecode } from "./format.ts";
import { usePlayback } from "./playback.ts";
import { itemLabel } from "./project.ts";
import { actions, getState, useApp, type Project } from "./store.ts";

// Prompts that work on an empty project: text needs no media (D48).
const EXAMPLES = [
  "Make a 5 s title card that says “Kraków from above”",
  "Add a lower third at 2 s that says “Shot from a drone”",
  "Start with a 3 s title “Weekend in the mountains” and end with “Thanks for watching”",
];

export function AgentPanel({ project, online }: { project: Project; online: boolean }) {
  const { agent, setupChecks, setupChecking, agentError } = useApp();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
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

  // Follow the newest turn as it streams in (the empty state stays scrolled to its top).
  useEffect(() => {
    const el = thread.current;
    if (el && turns.length) el.scrollTop = el.scrollHeight;
  }, [agent, turns.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || running || !online || blocked) return;
    setDraft("");
    if (!(await actions.agentSend(text))) setDraft((now) => now || text);
  };
  // An example goes into the prompt box, ready to send or change. Focus moves there now, so the
  // next Enter sends it rather than pressing the example again.
  const pick = (example: string) => {
    setDraft(example);
    input.current?.focus();
  };

  return (
    <div className="agent" data-testid="agent-panel">
      <div className="agent-thread" ref={thread} data-testid="agent-thread">
        {claude && claude.status !== "ready" && <ClaudeStatus check={claude} checking={setupChecking} />}
        {turns.length === 0 ? (
          <AgentEmpty onPick={pick} disabled={blocked || !online} />
        ) : (
          turns.map((t) => <TurnCard key={t.id} turn={t} busy={running !== null} online={online} />)
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
      <div className="composer">
        <ContextLine project={project} />
        <textarea
          ref={input}
          id="agent-input"
          data-testid="agent-input"
          rows={3}
          value={draft}
          spellCheck={false}
          disabled={!online || blocked}
          placeholder={blocked ? "Set up Claude Code to use the agent" : "Ask for an edit in plain words"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, ⇧Enter is a new line. Not while an input method is composing.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-foot">
          <span className="composer-who">{agent?.provider ?? "Claude Code"}, your subscription</span>
          <button className="send" data-testid="agent-send" title="Send (Enter)" disabled={!draft.trim() || running !== null || !online || blocked} onClick={() => void send()}>
            <ArrowUp />
          </button>
        </div>
      </div>
    </div>
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

function TurnCard({ turn: t, busy, online }: { turn: AgentTurn; busy: boolean; online: boolean }) {
  const undone = t.undo.state === "undone";
  const status =
    t.status === "running" ? (
      <>
        <LoaderCircle className="spin" />
        Working
      </>
    ) : undone ? (
      "Undone"
    ) : t.status === "cancelled" ? (
      "Stopped"
    ) : t.status === "error" ? (
      "Didn't finish"
    ) : (
      `Claude Code${t.seconds !== undefined ? `, ${Math.max(1, Math.round(t.seconds))} s` : ""}`
    );
  const canShowUndo = t.undo.state === "available" || t.undo.state === "blocked" || t.undo.state === "unavailable";
  return (
    <div className="turn-wrap" data-testid="agent-turn" data-turn={t.id} data-status={t.status} data-undo={t.undo.state}>
      <div className="msg-user" data-testid="agent-prompt">
        {t.prompt}
      </div>
      {t.note && <ManualNote note={t.note} />}
      <div className={`turn ${t.status} ${undone ? "undone" : ""}`}>
        <div className="turn-body">
          {t.items.map((item, i) =>
            item.kind === "step" ? (
              <div key={i} className="step" data-testid="agent-step" data-status={item.status}>
                {item.status === "error" ? <X className="bad" /> : item.status === "running" ? <LoaderCircle className="spin" /> : <Check />}
                <span>{item.text}</span>
              </div>
            ) : (
              <Reply key={i} text={item.text} />
            ),
          )}
          {t.status === "running" && t.items.length === 0 && (
            <div className="step muted">
              <LoaderCircle className="spin" />
              <span>Starting Claude Code…</span>
            </div>
          )}
          {t.edits.length > 0 && (
            <div className="turn-edits" data-testid="agent-edits">
              <div className="turn-edits-label">
                {t.edits.length === 1 ? "1 edit" : `${t.edits.length} edits`}
                {undone ? ", undone" : ""}
              </div>
              {t.edits.map((e) => (
                <div key={e.revision} className="turn-edit" data-testid="agent-edit">
                  <div className="turn-edit-summary">{e.summary}</div>
                  {e.lines.map((line, i) => (
                    <div key={i} className="turn-edit-line">
                      {line}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {t.error && (
            <p className="err" data-testid="agent-turn-error">
              {t.error}
            </p>
          )}
        </div>
        <div className="turn-foot">
          <span className="turn-status">{status}</span>
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

/** D6: the edits by hand the agent was told about with this prompt. */
function ManualNote({ note }: { note: string }) {
  const lines = note.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  return (
    <div className="manual-note" data-testid="agent-note">
      <div className="manual-note-head">
        <Pencil />
        {lines.length === 1 ? "Told the agent about 1 change you made by hand" : `Told the agent about ${lines.length} changes you made by hand`}
      </div>
      {lines.map((line, i) => (
        <div key={i} className="manual-note-line">
          {line}
        </div>
      ))}
    </div>
  );
}

/** The little markdown agents write: paragraphs, "- " bullets, **bold** and `code`. */
function Reply({ text }: { text: string }) {
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
    <div className="reply" data-testid="agent-reply">
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

/** What the agent is told about where you are: the playhead and the selected item. */
function ContextLine({ project }: { project: Project }) {
  const frame = usePlayback((s) => Math.floor(s.frame));
  const selected = usePlayback((s) => s.selected);
  const item = selected ? project.tracks.flatMap((t) => t.items).find((i) => i.id === selected) : undefined;
  return (
    <div className="composer-ctx" data-testid="agent-context">
      <MousePointer2 />
      <span className="ellipsis">
        Playhead {frameTimecode(frame, project.canvas.fps)}
        {item ? `, selected ${itemLabel(project, item)}` : ""}
      </span>
    </div>
  );
}
