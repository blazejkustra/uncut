// The production process in the Agent tab (U8, U9, U15, U16; D187–D189): the question card
// (ask_user), the storyboard to approve, the cards a turn keeps (question and answer, brief,
// storyboard, review, brand) and the Plan bar over the thread (the brief to read and edit, the
// storyboard to approve, the last review's scores).
import { REVIEW_SCORES, type AgentApproval, type AgentCard, type AgentPlan, type AgentQuestion, type Brief, type Review, type Storyboard, type StoryboardBeat } from "@uncut/contracts";
import { Check, ChevronDown, ChevronRight, ClipboardList, Clapperboard, Gauge, HelpCircle, Palette, Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import { actions } from "../state/store.ts";

const SCORE_NAMES: Readonly<Record<(typeof REVIEW_SCORES)[number], string>> = {
  hook: "Hook in 2 s",
  readability: "Phone readability",
  motion: "Motion",
  variety: "Variety",
  sound: "Sound sync",
  brand: "Brand",
};
const seconds = (s: number) => `${Math.round(s * 10) / 10} s`;

/** D187: the agent's question; pick, write, Send (or Skip). It waits up to 15 minutes. */
export function QuestionCard({ approval, question, online }: { approval: AgentApproval; question: AgentQuestion; online: boolean }) {
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const toggle = (label: string) => setPicked((now) => (question.multi ? (now.includes(label) ? now.filter((x) => x !== label) : [...now, label]) : now[0] === label ? [] : [label]));
  const ready = picked.length > 0 || text.trim() !== "";
  const send = (allow: boolean) => {
    setSent(true);
    void actions.agentApprove(approval.id, allow, undefined, allow ? { answer: { choices: [...picked], ...(text.trim() ? { text: text.trim() } : {}) } } : {});
  };
  return (
    <div className="approval question-card" data-testid="agent-question" data-id={approval.id}>
      <div className="approval-text">
        <HelpCircle />
        {question.question}
      </div>
      {question.options.length > 0 && (
        <div className="question-options" role={question.multi ? "group" : "radiogroup"}>
          {question.options.map((o) => (
            <button key={o.label} className={`question-option ${picked.includes(o.label) ? "on" : ""}`} data-testid="agent-question-option" aria-pressed={picked.includes(o.label)} disabled={sent} onClick={() => toggle(o.label)}>
              <span className="question-mark">{picked.includes(o.label) ? <Check /> : null}</span>
              <span className="question-label">
                {o.label}
                {o.detail && <span className="question-detail">{o.detail}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {question.freeText && (
        <textarea
          className="field input question-text"
          data-testid="agent-question-text"
          rows={2}
          placeholder={question.options.length ? "Or in your words" : "Your answer"}
          value={text}
          disabled={sent}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) send(true);
          }}
        />
      )}
      <div className="approval-btns">
        <button className="btn ghost" data-testid="agent-question-skip" disabled={!online || sent} onClick={() => send(false)}>
          Skip
        </button>
        <button className="btn primary" data-testid="agent-question-send" disabled={!online || sent || !ready} onClick={() => send(true)}>
          Send
        </button>
      </div>
    </div>
  );
}

/** One beat as a row, or its fields while editing. */
function BeatRow({ beat, i, edit, onChange }: { beat: StoryboardBeat; i: number; edit: boolean; onChange?: (b: StoryboardBeat) => void }) {
  if (!edit || !onChange) {
    return (
      <div className="beat" data-testid="agent-storyboard-beat">
        <div className="beat-head">
          <span className="beat-time">
            {seconds(beat.start)} to {seconds(beat.end)}
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

/** A review's scores as bars (8 and up passes). */
export function ScoreBars({ review }: { review: Review }) {
  return (
    <div className="scores" data-testid="agent-review-scores">
      {REVIEW_SCORES.map((k) => {
        const v = review.scores[k];
        return (
          <div key={k} className={`score ${v >= 8 ? "ok" : "low"}`} data-testid="agent-review-score" data-score={k} data-value={v}>
            <span className="score-name">{SCORE_NAMES[k]}</span>
            <span className="score-bar">
              <span style={{ width: `${v * 10}%` }} />
            </span>
            <span className="score-value">{v}</span>
          </div>
        );
      })}
    </div>
  );
}

function ReviewBody({ review }: { review: Review }) {
  return (
    <>
      <ScoreBars review={review} />
      {review.defects.length > 0 && (
        <div className="defects" data-testid="agent-review-defects">
          {review.defects.map((d, i) => (
            <div key={i} className="defect">
              <span className="defect-at">{seconds(d.at)}</span>
              <span>
                {d.what}
                {d.fix && <span className="muted">, fix: {d.fix}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {review.determinism && review.determinism.checked.length > 0 && (
        <div className="small muted" data-testid="agent-review-determinism">
          {review.determinism.differed.length ? `Drew differently twice: ${review.determinism.differed.join(", ")}` : `${review.determinism.checked.length === 1 ? "1 graphic" : `${review.determinism.checked.length} graphics`} drew the same twice`}
        </div>
      )}
    </>
  );
}

function BriefBody({ brief }: { brief: Brief }) {
  const rows: Array<[string, string]> = [
    ["Film", brief.film],
    ["Audience", brief.audience],
    ["Length", brief.duration],
    ["Formats", brief.formats.join(", ")],
    ["Assets", brief.assets.join(", ")],
    ["Look", brief.visual],
    ["Never", brief.hardLines.join("; ")],
    ["Deliver", brief.deliverables.join(", ")],
    ["Notes", brief.notes ?? ""],
  ];
  return (
    <div className="brief-rows" data-testid="agent-brief-rows">
      {rows
        .filter(([, v]) => v.trim())
        .map(([k, v]) => (
          <div key={k} className="brief-row">
            <span className="brief-key">{k}</span>
            <span>{v}</span>
          </div>
        ))}
    </div>
  );
}

const OUTCOME: Readonly<Record<string, string>> = { approved: "Approved", declined: "Changes asked", auto: "Approved by the setting", skipped: "No answer", answered: "Answered" };

/** A card a turn keeps (D186–D189). */
export function CardItem({ card }: { card: AgentCard }) {
  const [open, setOpen] = useState(card.type === "review" || card.type === "question");
  if (card.type === "question" && card.question) {
    const answer = card.answer ? [...card.answer.choices, ...(card.answer.text ? [card.answer.text] : [])].join(", ") : "";
    return (
      <div className="card-item" data-testid="agent-card" data-type="question" data-outcome={card.outcome}>
        <div className="card-head">
          <HelpCircle />
          <span className="grow">{card.question.question}</span>
        </div>
        <div className={`card-answer ${answer ? "" : "muted"}`} data-testid="agent-card-answer">
          {answer || "Skipped"}
        </div>
      </div>
    );
  }
  if (card.type === "brand") {
    return (
      <div className="card-item" data-testid="agent-card" data-type="brand">
        <div className="card-head">
          <Palette />
          <span className="grow">{card.text}</span>
        </div>
      </div>
    );
  }
  const head =
    card.type === "brief" ? (
      <>
        <ClipboardList />
        <span className="grow ellipsis">Brief: {card.brief?.film}</span>
      </>
    ) : card.type === "storyboard" ? (
      <>
        <Clapperboard />
        <span className="grow ellipsis">Storyboard, {card.storyboard?.beats.length ?? 0} beats</span>
        {card.outcome && <span className={`card-outcome ${card.outcome}`}>{OUTCOME[card.outcome] ?? card.outcome}</span>}
      </>
    ) : (
      <>
        <Gauge />
        <span className="grow">Review, round {card.review?.round}</span>
        {card.review && <span className={`card-outcome ${card.review.passed ? "approved" : "declined"}`}>{card.review.passed ? "Passed" : "Below 8"}</span>}
      </>
    );
  return (
    <div className={`card-item ${open ? "open" : ""}`} data-testid="agent-card" data-type={card.type} data-outcome={card.outcome}>
      <button className="card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {head}
        {open ? <ChevronDown /> : <ChevronRight />}
      </button>
      {open && card.brief && <BriefBody brief={card.brief} />}
      {open && card.storyboard && (
        <div className="beats">
          {card.storyboard.beats.map((b, i) => (
            <BeatRow key={i} beat={b} i={i} edit={false} />
          ))}
        </div>
      )}
      {open && card.review && <ReviewBody review={card.review} />}
    </div>
  );
}

const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);

/** The brief as a form (the user's edit, D188). */
function BriefForm({ brief, onDone }: { brief: Brief; onDone: () => void }) {
  const [b, setB] = useState(brief);
  const [saving, setSaving] = useState(false);
  const field = (key: "film" | "audience" | "duration" | "visual" | "notes", label: string, rows = 1) => (
    <label className="brief-field">
      <span className="brief-key">{label}</span>
      {rows > 1 ? <textarea className="field input" rows={rows} data-testid={`plan-brief-${key}`} value={b[key] ?? ""} onChange={(e) => setB({ ...b, [key]: e.target.value })} /> : <input className="field input" data-testid={`plan-brief-${key}`} value={b[key] ?? ""} onChange={(e) => setB({ ...b, [key]: e.target.value })} />}
    </label>
  );
  const list = (key: "formats" | "assets" | "hardLines" | "deliverables", label: string) => (
    <label className="brief-field">
      <span className="brief-key">{label}</span>
      <textarea className="field input" rows={2} data-testid={`plan-brief-${key}`} value={b[key].join("\n")} onChange={(e) => setB({ ...b, [key]: lines(e.target.value) })} />
    </label>
  );
  return (
    <div className="brief-form" data-testid="plan-brief-form">
      {field("film", "Film", 2)}
      {field("audience", "Audience")}
      {field("duration", "Length")}
      {list("formats", "Formats")}
      {list("assets", "Assets")}
      {field("visual", "Look", 2)}
      {list("hardLines", "Never")}
      {list("deliverables", "Deliver")}
      {field("notes", "Notes", 2)}
      <div className="approval-btns">
        <button className="btn ghost" data-testid="plan-brief-cancel" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn primary"
          data-testid="plan-brief-save"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            if (await actions.agentPlanSave({ brief: b })) onDone();
            setSaving(false);
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/** D188: the plan over the thread: the brief (read, edit), the storyboard (approve), the last review. */
export function PlanBar({ plan, waiting, online, busy }: { plan: AgentPlan; waiting: boolean; online: boolean; busy: boolean }) {
  const [open, setOpen] = useState<"brief" | "storyboard" | "review" | undefined>();
  const [editing, setEditing] = useState(false);
  const last = plan.reviews.at(-1);
  if (!plan.brief && !plan.storyboard && !last) return null;
  const sb = plan.storyboard;
  const tab = (key: "brief" | "storyboard" | "review", label: string, extra?: string) => (
    <button className={`plan-tab ${open === key ? "on" : ""}`} data-testid={`plan-${key}`} onClick={() => (setOpen(open === key ? undefined : key), setEditing(false))}>
      {label}
      {extra && <span className={`plan-chip ${extra}`}>{extra === "approved" ? "Approved" : extra === "declined" ? "Changes asked" : extra === "proposed" ? "Waiting" : extra === "passed" ? "Passed" : "Below 8"}</span>}
    </button>
  );
  return (
    <div className="plan-bar" data-testid="agent-plan">
      <div className="plan-tabs">
        {plan.brief && tab("brief", "Brief")}
        {sb && tab("storyboard", "Storyboard", sb.status)}
        {last && tab("review", `Review ${last.round}`, last.passed ? "passed" : "low")}
      </div>
      {open === "brief" && plan.brief && (
        <div className="plan-body">
          {editing ? (
            <BriefForm brief={plan.brief} onDone={() => setEditing(false)} />
          ) : (
            <>
              <BriefBody brief={plan.brief} />
              <div className="approval-btns">
                <button className="btn ghost" data-testid="plan-brief-edit" disabled={!online} onClick={() => setEditing(true)}>
                  <Pencil />
                  Edit
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {open === "storyboard" && sb && (
        <div className="plan-body">
          {sb.summary && <div className="small">{sb.summary}</div>}
          <div className="beats">
            {sb.beats.map((b, i) => (
              <BeatRow key={i} beat={b} i={i} edit={false} />
            ))}
          </div>
          {sb.note && <div className="small muted">You asked: {sb.note}</div>}
          {sb.status !== "approved" && !waiting && (
            <div className="approval-btns">
              <button className="btn primary" data-testid="plan-storyboard-approve" disabled={!online || busy} title={busy ? "The agent is working" : undefined} onClick={() => void actions.agentPlanSave({ storyboard: { ...sb, status: "approved" } })}>
                Approve
              </button>
            </div>
          )}
        </div>
      )}
      {open === "review" && last && (
        <div className="plan-body">
          <ReviewBody review={last} />
        </div>
      )}
    </div>
  );
}
