import type { AgentApproval, AgentTurn } from "@uncut/contracts";
import { TerminalSquare } from "lucide-react";
import { useState, useEffect } from "react";
import { actions } from "../../state/store.ts";
import { useRecorder, refreshAccess, loadSources, getRecorder, startTake, COUNTDOWN } from "../../capture/recorder.ts";

/** D198: the agent wants to change a kit's colours or fonts: each field before and after; Apply or Keep the kit (no answer in 2 minutes keeps it). */
export function BrandDiffCard({ approval, brand, online }: { approval: AgentApproval; brand: NonNullable<AgentApproval["brand"]>; online: boolean }) {
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
export function BootCard({ approval, boot, online }: { approval: AgentApproval; boot: NonNullable<AgentApproval["boot"]>; online: boolean }) {
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
export function CleanupLine({ turnId, cleanup, online }: { turnId: string; cleanup: NonNullable<AgentTurn["cleanup"]>; online: boolean }) {
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
export function ApprovalCard({ approval, online }: { approval: AgentApproval; online: boolean }) {
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
export function PermissionCard({ approval, permission, online }: { approval: AgentApproval; permission: NonNullable<AgentApproval["permission"]>; online: boolean }) {
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
export function ScreenApprovalCard({ approval, screen, online }: { approval: AgentApproval; screen: NonNullable<AgentApproval["screen"]>; online: boolean }) {
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
    void startTake({ mode: "screen", source, withMic, seconds: screen.seconds, countdown: COUNTDOWN, agent: { id: approval.id } });
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
