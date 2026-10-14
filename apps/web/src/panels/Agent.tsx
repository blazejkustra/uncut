// The Agent tab (D28, D48, D139-D142): turn cards with the agent's thinking, steps (a work log),
// reply and edit list, "Undo turn", the note about edits made by hand, and the composer. Live: text
// and thinking stream in, a line says what it's doing now. Names, never ids (AG5). Everything shown
// comes from the server's agent.subscribe stream; this component only sends, stops and undoes.
import { AGENT_MODELS, type AgentApproval, type AgentEdit, type AgentItem, type AgentTurn, type SetupCheck } from "@uncut/contracts";
import { friendlyText } from "@uncut/core/mentions";
import { Brain, Check, ChevronDown, ChevronRight, Copy, FileImage, Film, FolderOpen, Images, LoaderCircle, Music, Pencil, PencilLine, RefreshCw, Sparkles, Square, TerminalSquare, TriangleAlert, Undo2, X } from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Composer, withChips } from "./Composer.tsx";
import { CardItem, PlanChip, QuestionCard, StoryboardApproval, type CardLive } from "./AgentCards.tsx";
import { actions, agentImageUrl, getState, mediaUrl, thumbUrl, useApp, type Project } from "../state/store.ts";
import { cancelTake, clock, getRecorder, loadSources, refreshAccess, startTake, stopTake, useRecorder } from "../capture/recorder.ts";
import { usePlayback } from "../preview/playback.ts";
import { followShown } from "../state/agentFollow.ts";

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

  // An example goes into the prompt box, ready to send or change. Focus moves there now, so the
  // next Enter sends it rather than pressing the example again.
  const pick = (example: string) => {
    actions.setAgentDraft(example, []);
    document.getElementById("agent-input")?.focus();
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
      <div className="plan-strip agent-strip">
        <FollowToggle />
        <span className="spacer" />
        {agent?.plan && <PlanChip plan={agent.plan} />}
      </div>
      <div className="agent-thread" ref={thread} data-testid="agent-thread" onScroll={onScroll}>
        {claude && claude.status !== "ready" && <ClaudeStatus check={claude} checking={setupChecking} />}
        {turns.length === 0 ? (
          <AgentEmpty onPick={pick} disabled={blocked || !online} />
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

/** D202: whether the agent's ui_show moves the playhead (only ever when you aren't watching); remembered. */
function FollowToggle() {
  const { agentFollow } = useApp();
  const playing = usePlayback((s) => s.playing);
  const on = followShown(agentFollow, playing);
  return (
    <button className={`follow-toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} data-testid="agent-follow" data-on={on ? "true" : "false"} title={on ? "The playhead goes to the agent's changes while you aren't watching" : "The agent's changes show as a pill over the preview"} onClick={() => actions.setAgentFollow(!on)}>
      <span className="follow-dot" />
      Follow agent
    </button>
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

function TurnCard({ turn: t, busy, online, approval, latest, live }: { turn: AgentTurn; busy: boolean; online: boolean; approval?: AgentApproval | undefined; latest: ReadonlySet<string>; live: CardLive | undefined }) {
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
      `${AGENT_MODELS.find((m) => m.id === t.model)?.name ?? "Claude Code"}${t.seconds !== undefined ? `, ${Math.max(1, Math.round(t.seconds))} s` : ""}`
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
      {t.images && t.images.length > 0 && (
        <div className="msg-images" data-testid="agent-turn-images">
          {t.images.map((name) => {
            const src = agentImageUrl(name);
            return src ? <img key={name} src={src} alt="Attached image" data-testid="agent-turn-image" /> : null;
          })}
        </div>
      )}
      <div className="msg-user" data-testid="agent-prompt">
        {withChips(t.prompt, (t.mentions ?? []).map((m) => m.label))}
      </div>
      {t.folders && t.folders.length > 0 && (
        <div className="msg-folders small" data-testid="agent-turn-folders">
          {t.folders.map((f) => (
            <div key={f.path} className="msg-folder" data-testid="agent-turn-folder" data-problem={f.problem ? "1" : undefined} title={f.path}>
              <FolderOpen />
              <span className="msg-folder-text">{f.problem ? `Didn't list ${f.path}: ${f.problem}` : `Found ${f.files === 1 ? "1 file" : `${f.files} files`}${f.folders ? ` and ${f.folders === 1 ? "1 folder" : `${f.folders} folders`}` : ""} in ${f.path}`}</span>
            </div>
          ))}
        </div>
      )}
      {t.note && <ManualNote note={t.note} />}
      {/* D203: the turn as a stream of messages in order: replies, thinking, folded tool calls, edits
          where they happened, imports as one row, cards; then a compact footer. */}
      <div className={`turn ${t.status} ${undone ? "undone" : ""}`} data-testid="agent-stream">
        {groupItems(t.items, t.edits).map((g) =>
          g.kind === "steps" ? (
            <WorkLog key={g.at} steps={g.items} />
          ) : g.kind === "edit" ? (
            <EditRow key={g.at} step={g.item} edits={g.edits} />
          ) : g.kind === "media" ? (
            <MediaRow key={g.at} step={g.item} edits={g.edits} />
          ) : g.item.kind === "thinking" ? (
            <Thinking key={g.at} item={g.item} />
          ) : g.item.kind === "card" && g.item.card ? (
            <CardItem key={g.at} card={g.item.card} live={latest.has(`${t.id}:${g.at}`) ? live : undefined} />
          ) : (
            <Reply key={g.at} text={friendly(g.item.text)} live={!!g.item.live} />
          ),
        )}
        {approval &&
          (approval.screen ? (
            <ScreenApprovalCard approval={approval} screen={approval.screen} online={online} />
          ) : approval.boot ? (
            <BootCard key={approval.id} approval={approval} boot={approval.boot} online={online} />
          ) : approval.question ? (
            <QuestionCard key={approval.id} approval={approval} question={approval.question} online={online} />
          ) : approval.storyboard ? (
            <StoryboardApproval key={approval.id} approval={approval} storyboard={approval.storyboard} online={online} />
          ) : approval.permission ? (
            <PermissionCard key={approval.id} approval={approval} permission={approval.permission} online={online} />
          ) : approval.brand ? (
            <BrandDiffCard key={approval.id} approval={approval} brand={approval.brand} online={online} />
          ) : (
            <ApprovalCard approval={approval} online={online} />
          ))}
        {t.cleanup && <CleanupLine turnId={t.id} cleanup={t.cleanup} online={online} />}
        {t.status === "running" && <NowLine turn={t} waiting={!!approval} />}
        {t.error && (
          <p className="err" data-testid="agent-turn-error">
            {t.error}
          </p>
        )}
      </div>
      <div className={`turn-foot ${undone ? "undone" : ""}`}>
        {t.edits.length > 0 && <EditsFooter edits={t.edits} undone={undone} />}
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
  );
}

/** D203: the turn's edits in the footer: "3 edits", opened for every edit and its lines. */
function EditsFooter({ edits, undone }: { edits: ReadonlyArray<AgentEdit>; undone: boolean }) {
  const friendly = useFriendly();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);
  const list = (
    <div className="turn-edits-list">
      {edits.map((e) => (
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
  );
  return (
    <div className={`turn-edits ${open ? "open" : ""}`} data-testid="agent-edits" ref={box}>
      <button className="turn-edits-label" data-testid="agent-edits-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Hide the edits" : "Show every edit"}>
        <PencilLine />
        {edits.length === 1 ? "1 edit" : `${edits.length} edits`}
        {undone ? ", undone" : ""}
      </button>
      {open ? <div className="turn-edits-pop">{list}</div> : <div className="sr-only">{list}</div>}
    </div>
  );
}

/** D198: the agent wants to change a kit's colours or fonts: each field before and after; Apply or Keep the kit (no answer in 2 minutes keeps it). */
function BrandDiffCard({ approval, brand, online }: { approval: AgentApproval; brand: NonNullable<AgentApproval["brand"]>; online: boolean }) {
  const [sent, setSent] = useState(false);
  const answer = (allow: boolean) => {
    setSent(true);
    void actions.agentApprove(approval.id, allow);
  };
  const hex = (line: string) => /^#[0-9a-f]{6}\b/i.exec(line)?.[0];
  const row = (line: string, kind: "gone" | "new" | "same", i: number) => (
    <div key={i} className={`approval-diff-row ${kind}`} data-testid={`agent-brand-diff-${kind}`}>
      {hex(line) && <span className="approval-diff-swatch" style={{ background: hex(line) }} />}
      <span className="ellipsis">{line}</span>
    </div>
  );
  return (
    <div className="approval" data-testid="agent-approval" data-kind="brand" data-id={approval.id}>
      <div className="approval-text">{approval.text}?</div>
      <div className="approval-diff" data-testid="agent-brand-diff">
        {brand.changes.map((c) => {
          const after = new Set(c.after.map((x) => x.toLowerCase()));
          const before = new Set(c.before.map((x) => x.toLowerCase()));
          return (
            <div key={c.field}>
              <div className="approval-diff-field">{c.field}</div>
              <div className="approval-diff-cols">
                <div>
                  <span className="approval-diff-label">Now</span>
                  {c.before.map((l, i) => row(l, after.has(l.toLowerCase()) ? "same" : "gone", i))}
                </div>
                <div>
                  <span className="approval-diff-label">After</span>
                  {c.after.map((l, i) => row(l, before.has(l.toLowerCase()) ? "same" : "new", i))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="approval-sub">The kit "{brand.kit}" keeps its colours and fonts unless you apply this. No answer in 2 minutes keeps them.</div>
      <div className="approval-btns">
        <button className="btn ghost" data-testid="agent-decline" disabled={!online || sent} onClick={() => answer(false)}>
          Keep the kit
        </button>
        <button className="btn primary" data-testid="agent-allow" disabled={!online || sent} onClick={() => answer(true)}>
          Apply
        </button>
      </div>
    </div>
  );
}

/** D204: the agent asks to boot a simulator or emulator (argent_boot); nothing boots without Boot. */
function BootCard({ approval, boot, online }: { approval: AgentApproval; boot: NonNullable<AgentApproval["boot"]>; online: boolean }) {
  const [sent, setSent] = useState(false);
  const answer = (allow: boolean) => {
    setSent(true);
    void actions.agentApprove(approval.id, allow);
  };
  return (
    <div className="approval" data-testid="agent-approval" data-kind="boot" data-id={approval.id}>
      <div className="approval-text">Boot {boot.name}?</div>
      <div className="approval-lines" data-testid="agent-boot-lines">
        <div>{boot.kind}</div>
        <div>{`Argent starts it on this Mac, which can take a minute. Then the agent ${boot.bundleId ? `opens ${boot.bundleId} and ` : ""}records it into Media.`}</div>
      </div>
      <div className="approval-sub">Nothing boots without your answer. No answer in 2 minutes means no.</div>
      <div className="approval-btns">
        <button className="btn ghost" data-testid="agent-decline" disabled={!online || sent} onClick={() => answer(false)}>
          Don't
        </button>
        <button className="btn primary" data-testid="agent-allow" disabled={!online || sent} onClick={() => answer(true)}>
          Boot
        </button>
      </div>
    </div>
  );
}

/** D206: what the turn-end clean-up did (unused graphics to the trash, empty tracks removed), with Restore. */
function CleanupLine({ turnId, cleanup, online }: { turnId: string; cleanup: NonNullable<AgentTurn["cleanup"]>; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const g = cleanup.graphics.length;
  const n = cleanup.tracks.length;
  const parts = [g ? `Moved ${g === 1 ? "1 unused graphic" : `${g} unused graphics`} to the trash` : "", n ? `${g ? "removed" : "Removed"} ${n === 1 ? "an empty track" : `${n} empty tracks`}` : ""].filter(Boolean);
  return (
    <div className="turn-cleanup" data-testid="agent-cleanup">
      <span>{parts.join(", ")}</span>
      {g > 0 &&
        (cleanup.restored ? (
          <span className="turn-cleanup-done">Restored</span>
        ) : (
          <button
            className="link-btn"
            data-testid="agent-cleanup-restore"
            disabled={!online || busy}
            onClick={() => {
              setBusy(true);
              void actions.agentRestoreCleanup(turnId).finally(() => setBusy(false));
            }}
          >
            Restore
          </button>
        ))}
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
    <div className="approval" data-testid="agent-approval" data-kind={approval.edit ? "edit" : "spend"} data-id={approval.id}>
      <div className="approval-text">{approval.text}?</div>
      {approval.edit && approval.edit.lines.length > 0 && (
        <div className="approval-lines" data-testid="agent-approval-lines">
          {approval.edit.lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      <div className="approval-sub">{approval.edit ? "This chat asks before big changes. No answer in 2 minutes means no." : "The agent waits for your answer. Billed to your own key; no answer in 2 minutes means no."}</div>
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

/** Claude Code's tools in people's words, for the permission card (D194). */
const TOOL_NAMES: Record<string, string> = { Bash: "Terminal", Write: "Write file", Edit: "Edit file", MultiEdit: "Edit file", NotebookEdit: "Edit notebook", Read: "Read file", WebFetch: "Web page", WebSearch: "Web search" };

/**
 * D194: a Claude Code tool (a command, a file write outside the project, ...) waits for the user:
 * what it would run or touch, why it asks, and Deny, Always for this session (when it can be
 * remembered; a destructive command never can) or Allow once. No answer in 2 minutes is no.
 */
function PermissionCard({ approval, permission, online }: { approval: AgentApproval; permission: NonNullable<AgentApproval["permission"]>; online: boolean }) {
  const [sent, setSent] = useState(false);
  const answer = (allow: boolean, always = false) => {
    setSent(true);
    void actions.agentApprove(approval.id, allow, undefined, always ? { always: true } : {});
  };
  return (
    <div className="approval permission-card" data-testid="agent-approval" data-kind="permission" data-tool={permission.tool} data-id={approval.id}>
      <div className="approval-text">
        <TerminalSquare />
        {approval.text}?
      </div>
      <div className="permission-tool">{TOOL_NAMES[permission.tool] ?? permission.tool}</div>
      <pre className="permission-target" data-testid="agent-permission-target">
        {permission.target}
      </pre>
      {permission.why && (
        <div className="permission-why" data-testid="agent-permission-why">
          {permission.why}
        </div>
      )}
      <div className="approval-sub">No answer in 2 minutes means no.</div>
      <div className="approval-btns">
        <button className="btn ghost" data-testid="agent-decline" disabled={!online || sent} onClick={() => answer(false)}>
          Deny
        </button>
        {permission.always && (
          <button className="btn ghost" data-testid="agent-allow-always" disabled={!online || sent} onClick={() => answer(true, true)}>
            Always for this session
          </button>
        )}
        <button className="btn primary" data-testid="agent-allow" disabled={!online || sent} onClick={() => answer(true)}>
          Allow once
        </button>
      </div>
    </div>
  );
}

/**
 * D144: the agent asks to record the screen (screen_record). The user picks the screen or window
 * (the agent's suggestion preselected by name) and presses Record, or Don't; nothing is recorded
 * otherwise. The take runs in this window's recorder and goes back to the agent's turn.
 */
function ScreenApprovalCard({ approval, screen, online }: { approval: AgentApproval; screen: NonNullable<AgentApproval["screen"]>; online: boolean }) {
  const [sent, setSent] = useState(false);
  const sources = useRecorder((s) => s.sources);
  const loading = useRecorder((s) => s.loadingSources);
  const sourcesError = useRecorder((s) => s.sourcesError);
  const micAccess = useRecorder((s) => s.access?.microphone);
  const phase = useRecorder((s) => s.phase);
  const [picked, setPicked] = useState("");
  useEffect(() => {
    void refreshAccess();
    void loadSources();
  }, [approval.id]);
  // The agent's suggestion by name, else the first screen.
  useEffect(() => {
    if (picked || !sources?.length) return;
    const want = screen.source?.toLowerCase();
    const match = (want && (sources.find((s) => s.name.toLowerCase() === want) ?? sources.find((s) => s.name.toLowerCase().includes(want)))) || sources.find((s) => s.kind === "screen") || sources[0];
    if (match) setPicked(match.id);
  }, [sources, screen.source, picked]);
  const source = sources?.find((s) => s.id === picked);
  const withMic = screen.withMic && (micAccess === "granted" || micAccess === "unknown");
  const record = async () => {
    if (!source) return;
    setSent(true);
    // Only a card the server still has open starts a take (not one that timed out, was replaced or whose turn stopped).
    const accepted = await actions.agentApprove(approval.id, true, source.name);
    if (!accepted) return;
    if (getRecorder().phase !== "idle") return void actions.agentScreenTake(approval.id, { problem: "Another recording is running in Uncut." });
    void startTake({ mode: "screen", source, withMic, seconds: screen.seconds, agent: { id: approval.id } });
  };
  const decline = () => {
    setSent(true);
    void actions.agentApprove(approval.id, false);
  };
  return (
    <div className="approval" data-testid="agent-approval" data-kind="screen" data-id={approval.id}>
      <div className="approval-text">{approval.text}?</div>
      <select className="field input" data-testid="agent-screen-source" value={picked} disabled={sent || loading} onChange={(e) => setPicked(e.target.value)} title="Screen or window">
        {!sources?.length && <option value="">{loading ? "Looking for screens and windows…" : "No screens or windows"}</option>}
        {(["screen", "window"] as const).map((kind) => {
          const group = (sources ?? []).filter((s) => s.kind === kind);
          return group.length ? (
            <optgroup key={kind} label={kind === "screen" ? "Screens" : "Windows"}>
              {group.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
      {sourcesError && <div className="inline-error small">{sourcesError}</div>}
      <div className="approval-sub">{`${screen.seconds} s after a 3-2-1${withMic ? ", with the microphone" : screen.withMic ? ", without the microphone (Uncut isn't allowed to use it)" : ""}. No answer in 2 minutes means no.`}</div>
      <div className="approval-btns">
        <button className="btn ghost" data-testid="agent-decline" disabled={!online || sent} onClick={decline}>
          Don't
        </button>
        <button className="btn primary" data-testid="agent-allow" disabled={!online || sent || !source || phase !== "idle"} onClick={() => void record()}>
          Record
        </button>
      </div>
    </div>
  );
}

/** D144: the screen recording the user allowed, while it counts down, records and is sent. */
function AgentTakeLine() {
  const agentId = useRecorder((s) => s.agentId);
  const phase = useRecorder((s) => s.phase);
  const count = useRecorder((s) => s.count);
  const startedAt = useRecorder((s) => s.startedAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [phase]);
  if (!agentId || phase === "idle") return null;
  return (
    <div className="agent-take small" data-testid="agent-screen-take" data-phase={phase}>
      <span className="capture-timer">{phase === "countdown" ? `Recording in ${count ?? ""}` : phase === "recording" ? `Recording ${clock((now - (startedAt ?? now)) / 1000)}` : "Sending the recording…"}</span>
      {phase === "recording" && (
        <button className="link-btn" data-testid="agent-screen-stop" onClick={() => void stopTake()}>
          Stop now
        </button>
      )}
      {phase !== "saving" && (
        <button className="link-btn" data-testid="agent-screen-cancel" onClick={() => cancelTake()}>
          Cancel
        </button>
      )}
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

type Group =
  | { kind: "steps"; at: number; items: Array<AgentItem> }
  | { kind: "edit" | "media"; at: number; item: AgentItem; edits: Array<AgentEdit> }
  | { kind: "one"; at: number; item: AgentItem };

/**
 * Consecutive tool calls make one work log; text, thinking and cards stand alone. D203: a call that
 * edited the project is its own row, where it happened (its edit's `at`); one that added media
 * (an import) is one row with the files as thumbnails.
 */
function groupItems(items: ReadonlyArray<AgentItem>, edits: ReadonlyArray<AgentEdit> = []): Array<Group> {
  const byStep = new Map<number, Array<AgentEdit>>();
  for (const e of edits) if (e.at !== undefined) byStep.set(e.at, [...(byStep.get(e.at) ?? []), e]);
  const out: Array<Group> = [];
  items.forEach((item, at) => {
    // Thinking with no words (yet) isn't a row (D182).
    if (item.kind === "thinking" && !item.text.trim()) return;
    const made = item.kind === "step" ? byStep.get(at) : undefined;
    if (made) return void out.push({ kind: made.some((e) => e.media?.length) ? "media" : "edit", at, item, edits: made });
    const last = out.at(-1);
    if (item.kind === "step" && last?.kind === "steps") last.items.push(item);
    else if (item.kind === "step") out.push({ kind: "steps", at, items: [item] });
    else out.push({ kind: "one", at, item });
  });
  return out;
}

/** D203: a call that edited the project: its summary, opened for what it changed. */
function EditRow({ step, edits }: { step: AgentItem; edits: ReadonlyArray<AgentEdit> }) {
  const friendly = useFriendly();
  const [open, setOpen] = useState(false);
  const lines = edits.flatMap((e) => e.lines);
  return (
    <div className={`edit-row ${open ? "open" : ""}`} data-testid="agent-edit-row">
      <div className="step edit-step" data-testid="agent-step" data-status={step.status} data-tool={step.tool} aria-expanded={open} title={open ? "Hide the changes" : "Show the changes"} onClick={() => setOpen(!open)}>
        {step.status === "running" ? <LoaderCircle className="spin" /> : step.status === "error" ? <X className="bad" /> : <PencilLine />}
        <span className="grow">{friendly(step.status === "running" ? (step.doing ?? step.text) : step.text)}</span>
        {lines.length > 0 && (open ? <ChevronDown className="step-chev" /> : <ChevronRight className="step-chev" />)}
      </div>
      {open && (
        <div className="edit-lines" data-testid="agent-edit-lines">
          {lines.map((line, i) => (
            <div key={i}>{friendly(line)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** D203: an import (or a generated or recorded file) as one row ("Imported 40 files"), opened to its files as thumbnails. */
function MediaRow({ step, edits }: { step: AgentItem; edits: ReadonlyArray<AgentEdit> }) {
  const project = useContext(ProjectContext);
  const { thumbIds } = useApp();
  const [open, setOpen] = useState(false);
  const ids = edits.flatMap((e) => e.media ?? []);
  const summary = edits.length === 1 ? edits[0]!.summary : `Added ${ids.length} files`;
  return (
    <div className={`media-row ${open ? "open" : ""}`} data-testid="agent-import" data-count={ids.length}>
      <div className="step media-step" data-testid="agent-step" data-status={step.status} data-tool={step.tool} aria-expanded={open} title={open ? "Hide the files" : "Show the files"} onClick={() => setOpen(!open)}>
        {step.status === "running" ? <LoaderCircle className="spin" /> : <Images />}
        <span className="grow">{summary}</span>
        {open ? <ChevronDown className="step-chev" /> : <ChevronRight className="step-chev" />}
      </div>
      {open && (
        <div className="media-grid" data-testid="agent-import-grid">
          {ids.map((id) => {
            const m = project?.media.find((x) => x.id === id);
            const src = !m ? undefined : thumbIds.has(id) ? thumbUrl(id, m.path) : m.kind === "image" ? mediaUrl(id, m.path) : undefined;
            const Icon = m?.kind === "audio" ? Music : m?.kind === "image" ? FileImage : Film;
            return (
              <div key={id} className="media-tile" data-testid="agent-import-thumb" title={m ? m.name : "No longer in the project"}>
                {src ? <img src={src} alt={m?.name ?? ""} loading="lazy" /> : <Icon />}
                <span className="media-tile-name ellipsis">{m?.name ?? "Removed"}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const StepIcon = ({ status }: { status?: string | undefined }) => (status === "error" ? <X className="bad" /> : status === "running" ? <LoaderCircle className="spin" /> : <Check />);

/** Tool calls in a row (D139): one line ("Added title, and 3 more"), opened for every step. */
function WorkLog({ steps }: { steps: ReadonlyArray<AgentItem> }) {
  const friendly = useFriendly();
  const [open, setOpen] = useState(false);
  const one = (s: AgentItem, i: number) => <Step key={i} step={s} />;
  // A failed step opens the log, so its ✕ and why are in view (D182).
  const failedNow = steps.some((s) => s.status === "error");
  useEffect(() => {
    if (failedNow) setOpen(true);
  }, [failedNow]);
  if (steps.length === 1) return <div className="worklog">{one(steps[0]!, 0)}</div>;
  const failed = steps.filter((s) => s.status === "error").length;
  const runningNow = steps.some((s) => s.status === "running");
  const lead = steps.at(-1)!;
  return (
    <div className={`worklog ${open ? "open" : ""}`} data-testid="agent-worklog" data-count={steps.length}>
      <button className="worklog-head" data-testid="agent-worklog-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown /> : <ChevronRight />}
        <StepIcon status={runningNow ? "running" : failed === steps.length || lead.status === "error" ? "error" : "done"} />
        <span className="ellipsis grow">
          {friendly(lead.status === "running" ? (lead.doing ?? lead.text) : lead.text)}, and {steps.length - 1} more
          {failed ? <span className="worklog-failed">, {failed} didn't work</span> : null}
        </span>
      </button>
      {open && <div className="worklog-steps">{steps.map(one)}</div>}
      {/* Kept for tests and screen readers: every step, even folded. */}
      {!open && <div className="sr-only">{steps.map(one)}</div>}
    </div>
  );
}

/** One step of the work log; a failed one shows ✕, and a click shows what the tool answered (D182). */
function Step({ step: s }: { step: AgentItem }) {
  const friendly = useFriendly();
  const [why, setWhy] = useState(true);
  // D194: a built-in tool's answer (search results, a page, a command's output) opens from its row.
  const [shown, setShown] = useState(false);
  const failed = s.status === "error" && !!s.error;
  const result = !failed && s.status !== "running" && !!s.result;
  const toggle = failed ? () => setWhy(!why) : result ? () => setShown(!shown) : undefined;
  return (
    <>
      <div
        className={`step ${failed ? "failed" : ""} ${result ? "has-result" : ""}`}
        data-testid="agent-step"
        data-status={s.status}
        data-tool={s.tool}
        title={failed ? (why ? "Hide why" : "Show why") : result ? (shown ? "Hide the result" : "Show the result") : undefined}
        onClick={toggle}
        aria-expanded={result ? shown : undefined}
      >
        <StepIcon status={s.status} />
        <span className="grow">{friendly(s.status === "running" ? (s.doing ?? s.text) : s.text)}</span>
        {result && (shown ? <ChevronDown className="step-chev" /> : <ChevronRight className="step-chev" />)}
      </div>
      {failed && why && (
        <div className="step-error" data-testid="agent-step-error">
          {s.error}
        </div>
      )}
      {result && shown && (
        <pre className="step-result" data-testid="agent-step-result">
          {s.result}
        </pre>
      )}
    </>
  );
}

/** A thinking summary (D139): folded to one line, opened for all of it; the latest line while it streams. Empty thinking is never a row (D182): the now line says Thinking. */
function Thinking({ item }: { item: AgentItem }) {
  const [open, setOpen] = useState(false);
  const lines = item.text.trim().split("\n").filter(Boolean);
  if (!lines.length) return null;
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
      ? friendly(step.doing ?? step.text)
      : last?.kind === "thinking" && (last.live || !last.text.trim())
        ? "Thinking"
        : last?.kind === "text" && last.live
          ? "Writing reply"
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
