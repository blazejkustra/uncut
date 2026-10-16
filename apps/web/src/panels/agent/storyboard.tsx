import type { StoryboardBeat, AgentApproval, Storyboard } from "@uncut/contracts";
import { Clapperboard, Pencil } from "lucide-react";
import { useState, useEffect } from "react";
import { actions, agentImageUrl } from "../../state/store.ts";

export const seconds = (s: number) => `${Math.round(s * 10) / 10} s`;

/** One beat as a row, or its fields while editing. */
export function BeatRow({ beat, i, edit, onChange }: { beat: StoryboardBeat; i: number; edit: boolean; onChange?: (b: StoryboardBeat) => void }) {
  if (!edit || !onChange) {
    return (
      <div className={`beat ${beat.still ? "with-still" : ""}`} data-testid="agent-storyboard-beat">
        {beat.still && <img className="beat-still" data-testid="agent-storyboard-still" src={agentImageUrl(beat.still)} alt={`Beat ${i + 1} still`} title={`Beat ${i + 1}`} />}
        <div className="beat-head">
          <span className="beat-time">
            {i + 1}. {seconds(beat.start)} to {seconds(beat.end)}
          </span>
          <b>{beat.title || `Beat ${i + 1}`}</b>
        </div>
        <div className="beat-line">
          {beat.entry} <span className="muted">→</span> {beat.exit}
        </div>
        <div className="beat-line muted">{beat.purpose}</div>
        {(beat.assets.length > 0 || beat.sound) && (
          <div className="beat-line small muted">
            {beat.assets.join(", ")}
            {beat.assets.length > 0 && beat.sound ? ", " : ""}
            {beat.sound ? `on ${beat.sound}` : ""}
          </div>
        )}
      </div>
    );
  }
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : fallback);
  return (
    <div className="beat editing" data-testid="agent-storyboard-beat">
      <div className="beat-fields">
        <input className="field input beat-num" type="number" step="0.1" value={beat.start} title="Start, seconds" onChange={(e) => onChange({ ...beat, start: num(e.target.value, beat.start) })} />
        <input className="field input beat-num" type="number" step="0.1" value={beat.end} title="End, seconds" onChange={(e) => onChange({ ...beat, end: num(e.target.value, beat.end) })} />
        <input className="field input grow" data-testid="agent-storyboard-beat-title" value={beat.title} placeholder="Title" onChange={(e) => onChange({ ...beat, title: e.target.value })} />
      </div>
      <input className="field input" value={beat.entry} placeholder="Starts on" onChange={(e) => onChange({ ...beat, entry: e.target.value })} />
      <input className="field input" value={beat.exit} placeholder="Ends on" onChange={(e) => onChange({ ...beat, exit: e.target.value })} />
      <input className="field input" value={beat.purpose} placeholder="Purpose" onChange={(e) => onChange({ ...beat, purpose: e.target.value })} />
      <input className="field input" value={beat.assets.join(", ")} placeholder="Assets" onChange={(e) => onChange({ ...beat, assets: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
    </div>
  );
}

/** D188: the storyboard to approve before the build: Approve (with edits) or Ask for changes. */
export function StoryboardApproval({ approval, storyboard, online }: { approval: AgentApproval; storyboard: Storyboard; online: boolean }) {
  const [beats, setBeats] = useState<ReadonlyArray<StoryboardBeat>>(storyboard.beats);
  const [edit, setEdit] = useState(false);
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  useEffect(() => setBeats(storyboard.beats), [approval.id]);
  const edited = JSON.stringify(beats) !== JSON.stringify(storyboard.beats);
  const approve = () => {
    setSent(true);
    void actions.agentApprove(approval.id, true, undefined, edited ? { beats } : {});
  };
  const change = () => {
    setSent(true);
    void actions.agentApprove(approval.id, false, undefined, note.trim() ? { note: note.trim() } : {});
  };
  return (
    <div className="approval storyboard-card" data-testid="agent-storyboard" data-id={approval.id}>
      <div className="approval-text">
        <Clapperboard />
        {storyboard.summary || "Storyboard"}
      </div>
      <div className="beats">
        {beats.map((b, i) => (
          <BeatRow key={i} beat={b} i={i} edit={edit} onChange={(next) => setBeats(beats.map((x, j) => (j === i ? next : x)))} />
        ))}
      </div>
      {changing && <textarea className="field input" data-testid="agent-storyboard-note" rows={2} placeholder="What to change" value={note} autoFocus onChange={(e) => setNote(e.target.value)} />}
      <div className="approval-sub">The build waits for your approval.</div>
      <div className="approval-btns">
        {!changing && (
          <button className="btn ghost" data-testid="agent-storyboard-edit" disabled={!online || sent} onClick={() => setEdit(!edit)}>
            <Pencil />
            {edit ? "Done editing" : "Edit"}
          </button>
        )}
        {changing ? (
          <button className="btn" data-testid="agent-storyboard-send-change" disabled={!online || sent || !note.trim()} onClick={change}>
            Send changes
          </button>
        ) : (
          <button className="btn ghost" data-testid="agent-storyboard-change" disabled={!online || sent} onClick={() => setChanging(true)}>
            Ask for changes
          </button>
        )}
        <button className="btn primary" data-testid="agent-storyboard-approve" disabled={!online || sent} onClick={approve}>
          {edited ? "Approve with edits" : "Approve"}
        </button>
      </div>
    </div>
  );
}
