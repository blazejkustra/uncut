// The production process in the Agent tab (U8, U9, U15, U16; D187–D189, D197): the question card
// (ask_user), the storyboard to approve, the cards a turn keeps in the conversation where they
// happened (question and answer, brief, storyboard, review, brand; the latest brief is edited and
// the latest storyboard approved on its card) and the pinned Plan chip that jumps to the latest
// brief, storyboard and review cards.
import { REVIEW_SCORES, type AgentApproval, type AgentCard, type AgentPlan, type AgentQuestion, type Brief, type Review, type Storyboard, type StoryboardBeat } from "@uncut/contracts";
import { Check, ChevronDown, ChevronRight, ClipboardList, Clapperboard, Gauge, HelpCircle, Palette, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

/** A review's scores as bars (8 and up passes), with the critic's evidence under each. */
export function ScoreBars({ review }: { review: Review }) {
  return (
    <div className="scores" data-testid="agent-review-scores">
      {REVIEW_SCORES.map((k) => {
        const v = review.scores[k];
        const ev = review.evidence?.[k];
        return (
          <div key={k} className={`score ${v >= 8 ? "ok" : "low"}`} data-testid="agent-review-score" data-score={k} data-value={v}>
            <span className="score-name">{SCORE_NAMES[k]}</span>
            <span className="score-bar">
              <span style={{ width: `${v * 10}%` }} />
            </span>
            <span className="score-value">{v}</span>
            {ev && (
              <span className="score-evidence" title={ev}>
                {ev}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const BLOCKER_NAMES: Readonly<Record<string, string>> = {
  placeholder: "Empty screen",
  "missing-asset": "Missing asset",
  font: "Font",
  overflow: "Overflow",
  illegible: "Hard to read",
  "brand-colour": "Off-brand colour",
  invented: "Invented",
  blank: "Blank frame",
  "off-centre": "Off-centre",
  "unverified-fix": "Fix not seen",
  sound: "Sound",
  other: "Blocker",
};

function ReviewBody({ review }: { review: Review }) {
  const blockers = review.blockers ?? [];
  return (
    <>
      <div className="review-by small muted" data-testid="agent-review-by" data-by={review.by ?? "agent"} title={review.by === "critic" ? "A separate Claude that sees only the frames, the brief, the kit and the storyboard" : undefined}>
        {review.by === "critic" ? "Independent critic" : "Self-scored"}
      </div>
      {review.error && <div className="small err">{review.error}</div>}
      {blockers.length > 0 && (
        <div className="blockers" data-testid="agent-review-blockers">
          {blockers.map((b, i) => (
            <div key={i} className="blocker" data-testid="agent-review-blocker" data-kind={b.kind} data-source={b.source}>
              <span className="blocker-kind">{BLOCKER_NAMES[b.kind] ?? b.kind}</span>
              {b.at !== undefined && <span className="defect-at">{seconds(b.at)}</span>}
              <span className="grow">
                {b.what}
                {b.source === "check" && <span className="muted"> (Uncut's {b.kind === "sound" ? "sound" : "layout"} check)</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {review.fixes && review.fixes.length > 0 && (
        <div className="fixes" data-testid="agent-review-fixes">
          {review.fixes.map((f, i) => (
            <div key={i} className={`fix ${f.verified ? "ok" : "bad"}`} data-testid="agent-review-fix" data-verified={f.verified}>
              {f.verified ? <Check /> : <X />}
              <span className="grow">
                {f.what}
                {f.note && <span className="muted">, {f.note}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
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
      {review.notes && review.by === "critic" && <div className="small">{review.notes}</div>}
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

/** The review's chip: passed, its blockers, or under the bar. */
const reviewOutcome = (r: Review) => (r.passed ? "Passed" : r.blockers?.length ? (r.blockers.length === 1 ? "1 blocker" : `${r.blockers.length} blockers`) : "Below 8");

/** What the latest card of its type can do (D197): edit the brief, approve the storyboard. */
export interface CardLive {
  readonly plan: AgentPlan;
  readonly online: boolean;
  readonly busy: boolean;
  /** A storyboard approval card is open. */
  readonly waiting: boolean;
}

/** The Plan chip's jump: the event a card listens for to open itself. */
const OPEN_CARD = "uncut-open-card";

/** A card a turn keeps (D186–D189), in the conversation where it happened; `live` on the latest of its type. */
export function CardItem({ card, live }: { card: AgentCard; live?: CardLive | undefined }) {
  const [open, setOpen] = useState(card.type === "review" || card.type === "question");
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onOpen = () => setOpen(true);
    el.addEventListener(OPEN_CARD, onOpen);
    return () => el.removeEventListener(OPEN_CARD, onOpen);
  }, []);
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
  // The latest brief shows the brief as it is now (the user may have edited it since).
  const brief = live && card.type === "brief" ? (live.plan.brief ?? card.brief) : card.brief;
  const sb = live && card.type === "storyboard" ? live.plan.storyboard : undefined;
  const head =
    card.type === "brief" ? (
      <>
        <ClipboardList />
        <span className="grow ellipsis">Brief: {brief?.film}</span>
        {brief?.by === "user" && live && <span className="card-outcome approved">Edited by you</span>}
      </>
    ) : card.type === "storyboard" ? (
      <>
        <Clapperboard />
        <span className="grow ellipsis">Storyboard, {card.storyboard?.beats.length ?? 0} beats</span>
        {sb && sb.status === "approved" && card.outcome !== "approved" && card.outcome !== "auto" ? <span className="card-outcome approved">Approved</span> : card.outcome && <span className={`card-outcome ${card.outcome}`}>{OUTCOME[card.outcome] ?? card.outcome}</span>}
      </>
    ) : (
      <>
        <Gauge />
        <span className="grow">Review, round {card.review?.round}</span>
        {card.review && <span className={`card-outcome ${card.review.passed ? "approved" : "declined"}`}>{reviewOutcome(card.review)}</span>}
      </>
    );
  return (
    <div ref={ref} className={`card-item ${open ? "open" : ""}`} data-testid="agent-card" data-type={card.type} data-outcome={card.outcome} data-latest={live ? "true" : undefined} data-passed={card.review ? String(card.review.passed) : undefined}>
      <button className="card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {head}
        {open ? <ChevronDown /> : <ChevronRight />}
      </button>
      {open && brief && card.type === "brief" && (editing && live ? <BriefForm brief={brief} onDone={() => setEditing(false)} /> : <BriefBody brief={brief} />)}
      {open && brief && card.type === "brief" && live && !editing && (
        <div className="approval-btns card-btns">
          <button className="btn ghost" data-testid="plan-brief-edit" disabled={!live.online} onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </button>
        </div>
      )}
      {open && card.storyboard && (
        <div className="beats">
          {card.storyboard.beats.map((b, i) => (
            <BeatRow key={i} beat={b} i={i} edit={false} />
          ))}
        </div>
      )}
      {open && sb && sb.status !== "approved" && !live?.waiting && (
        <div className="approval-btns card-btns">
          {sb.note && <span className="small muted grow">You asked: {sb.note}</span>}
          <button className="btn primary" data-testid="plan-storyboard-approve" disabled={!live?.online || live.busy} title={live?.busy ? "The agent is working" : undefined} onClick={() => void actions.agentPlanSave({ storyboard: { ...sb, status: "approved" } })}>
            Approve
          </button>
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

/** Jumps to the latest card of a type in the thread: scrolled into view, opened, flashed. Whether there was one. */
export function jumpToCard(type: "brief" | "storyboard" | "review"): boolean {
  const all = document.querySelectorAll<HTMLElement>(`[data-testid="agent-card"][data-type="${type}"]`);
  const el = all[all.length - 1];
  if (!el) return false;
  el.dispatchEvent(new Event(OPEN_CARD));
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  // An attribute, not a class: React owns className and the card re-renders as it opens.
  el.removeAttribute("data-flash");
  setTimeout(() => el.setAttribute("data-flash", "on"), 30);
  setTimeout(() => el.removeAttribute("data-flash"), 1600);
  return true;
}

/**
 * D197: the pinned Plan chip over the thread. The brief, storyboard and reviews are cards in the
 * conversation; the chip lists the latest of each with its state and jumps to its card (or shows
 * it here when no card has it, e.g. a brief.json written by hand).
 */
export function PlanChip({ plan }: { plan: AgentPlan }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<"brief" | "storyboard" | "review" | undefined>();
  const last = plan.reviews.at(-1);
  const sb = plan.storyboard;
  if (!plan.brief && !sb && !last) return null;
  const go = (type: "brief" | "storyboard" | "review") => {
    if (jumpToCard(type)) {
      setOpen(false);
      setShown(undefined);
    } else setShown(shown === type ? undefined : type);
  };
  const state = (cls: string, text: string) => <span className={`plan-state ${cls}`}>{text}</span>;
  return (
    <div className="plan-chip-wrap" data-testid="agent-plan">
      <button className={`plan-chip-btn ${open ? "on" : ""}`} data-testid="plan-chip" aria-expanded={open} onClick={() => (setOpen(!open), setShown(undefined))}>
        <ClipboardList />
        Plan
        {last && state(last.passed ? "passed" : "low", reviewOutcome(last))}
        {!last && sb && state(sb.status, sb.status === "approved" ? "Approved" : sb.status === "declined" ? "Changes asked" : "Waiting")}
      </button>
      {open && (
        <div className="plan-menu" data-testid="plan-menu">
          {plan.brief && (
            <button className="plan-row" data-testid="plan-brief" onClick={() => go("brief")}>
              <ClipboardList />
              <span className="grow ellipsis">Brief: {plan.brief.film}</span>
            </button>
          )}
          {sb && (
            <button className="plan-row" data-testid="plan-storyboard" onClick={() => go("storyboard")}>
              <Clapperboard />
              <span className="grow">Storyboard, {sb.beats.length} beats</span>
              {state(sb.status, sb.status === "approved" ? "Approved" : sb.status === "declined" ? "Changes asked" : "Waiting")}
            </button>
          )}
          {last && (
            <button className="plan-row" data-testid="plan-review" onClick={() => go("review")}>
              <Gauge />
              <span className="grow">Review, round {last.round}</span>
              {state(last.passed ? "passed" : "low", reviewOutcome(last))}
            </button>
          )}
          {shown === "brief" && plan.brief && (
            <div className="plan-body">
              <BriefBody brief={plan.brief} />
            </div>
          )}
          {shown === "storyboard" && sb && (
            <div className="plan-body">
              {sb.summary && <div className="small">{sb.summary}</div>}
              <div className="beats">
                {sb.beats.map((b, i) => (
                  <BeatRow key={i} beat={b} i={i} edit={false} />
                ))}
              </div>
            </div>
          )}
          {shown === "review" && last && (
            <div className="plan-body">
              <ReviewBody review={last} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
