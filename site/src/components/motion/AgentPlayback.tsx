"use client";
import type { ReactNode } from "react";
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  ClipboardList,
  Gauge,
  Images,
  LoaderCircle,
  MousePointer,
  Paperclip,
  Pencil,
  PencilLine,
  Sparkles,
  Square,
  Undo,
} from "./icons.tsx";
import { usePlayback } from "./usePlayback.ts";

const PROMPT = "Cut a 20 second travel film from today's drone clips. Golden hour to blue hour, a quiet title up front, soft music under it.";
const REPLY = "Cut and passed: 21 s, the title over the coast road up front, six shots from golden hour to blue hour, soft music under it.";
const BRIEF = "Brief: A 21 s travel film of day four in Croatia: a quiet title, six drone shots from golden hour to blue hour, soft music under it";
const ALT =
  "The agent's turn on the Croatia film: the prompt asks for a 20 second travel film, then imported 7 files, wrote the brief, proposed a storyboard of 4 beats, cut the travel film into six shots with titles and music, critic round 1 passed, a closing summary, 2 edits and an Undo turn button.";

const IDLE_MS = 500;
const TYPE_MS = 20;
const SENT_MS = 650;
const DONE_MS = 220;
const WORD_MS = 55;
const HOLD_MS = 6500;

type RowKind = "media" | "step" | "card" | "log" | "edit" | "critic";
type Row = { kind: RowKind; doing?: string; done: string; icon?: ReactNode; runMs: number };

const ROWS: ReadonlyArray<Row> = [
  { kind: "media", doing: "Importing 7 files", done: "Imported 7 files", runMs: 850 },
  { kind: "step", doing: "Writing the brief", done: "Wrote the brief", runMs: 800 },
  { kind: "card", done: BRIEF, icon: <ClipboardList />, runMs: 420 },
  { kind: "step", doing: "Proposing a storyboard of 4 beats", done: "Proposed a storyboard of 4 beats", runMs: 900 },
  { kind: "card", done: "Storyboard, 4 beats", icon: <Clapperboard />, runMs: 420 },
  { kind: "log", doing: "Reading the timeline, and 1 more", done: "Read the timeline, and 1 more", runMs: 650 },
  {
    kind: "edit",
    doing: "Editing the timeline: Cut the travel film: six shots, titles, music",
    done: "Cut the travel film: six shots, titles, music",
    runMs: 1400,
  },
  { kind: "log", doing: "Asking the critic for a review, and 2 more", done: "Asked the critic for a review, and 2 more", runMs: 700 },
  { kind: "critic", doing: "Running", done: "Passed", runMs: 1200 },
];

const REPLY_WORD_ENDS = REPLY.split(" ").reduce<Array<number>>((ends, word) => [...ends, (ends.at(-1) ?? -1) + 1 + word.length], []);

function buildTimeline() {
  const waits: Array<number> = [];
  const mark = (ms: number, times = 1) => {
    const first = waits.length;
    for (let i = 0; i < times; i++) waits.push(ms);
    return first;
  };
  mark(IDLE_MS);
  const typing = mark(TYPE_MS, PROMPT.length);
  const sent = mark(SENT_MS);
  const rows = ROWS.map((row) => ({ row, runAt: mark(row.runMs), doneAt: mark(DONE_MS) }));
  const reply = mark(WORD_MS, REPLY_WORD_ENDS.length);
  const foot = mark(HOLD_MS);
  return { waits, typing, sent, rows, reply, foot };
}

const TIMELINE = buildTimeline();

type RowState = "off" | "run" | "done";

function rowState(step: number, runAt: number, doneAt: number): RowState {
  if (step < runAt) return "off";
  return step < doneAt ? "run" : "done";
}

/** Text that appears from the left while the rest keeps its place in the layout. */
function Revealing({ text, shown, live }: { text: string; shown: number; live: boolean }) {
  return (
    <>
      {text.slice(0, shown)}
      {live && <i className="pb-caret" />}
      <span className="pb-ghost">{text.slice(shown)}</span>
    </>
  );
}

function StatusIcon({ state, done }: { state: RowState; done: ReactNode }) {
  return (
    <span className="pb-icon" data-state={state}>
      <LoaderCircle className="pb-spin" />
      <span className="pb-final">{done}</span>
    </span>
  );
}

function Words({ doing, done }: { doing?: string | undefined; done: string }) {
  return (
    <span className="pb-swap">
      <span className="pb-doing">{doing}</span>
      <span className="pb-done">{done}</span>
    </span>
  );
}

function ThreadRow({ row, state }: { row: Row; state: RowState }) {
  if (row.kind === "card") {
    return (
      <div className="pb-row pb-card" data-state={state}>
        {row.icon}
        <span className="pb-ellipsis">{row.done}</span>
        <ChevronRight className="pb-chev" />
      </div>
    );
  }
  if (row.kind === "critic") {
    return (
      <div className="pb-row pb-card pb-critic" data-state={state}>
        <span className="pb-critic-icon">
          <StatusIcon state={state} done={<Gauge />} />
        </span>
        <span className="pb-critic-name">Critic, round 1</span>
        <Words doing={row.doing} done={row.done} />
        <ChevronRight className="pb-chev" />
      </div>
    );
  }
  const finalIcon = row.kind === "media" ? <Images /> : row.kind === "edit" ? <PencilLine /> : <Check />;
  return (
    <div className={`pb-row pb-step ${row.kind}`} data-state={state}>
      {row.kind === "log" && <ChevronRight className="pb-lead" />}
      <StatusIcon state={state} done={finalIcon} />
      <Words doing={row.doing} done={row.done} />
      {(row.kind === "media" || row.kind === "edit") && <ChevronRight className="pb-chev" />}
    </div>
  );
}

function Composer({ step }: { step: number }) {
  const { typing, sent, foot } = TIMELINE;
  const typed = step < sent ? Math.max(0, step - typing) : 0;
  const sendState = step >= foot ? "idle" : step >= sent ? "stop" : typed > 0 ? "ready" : "idle";
  return (
    <div className="pb-composer">
      <div className="pb-composer-ctx">
        <MousePointer />
        Playhead 00:00:01:15
      </div>
      <div className="pb-composer-box">
        <span className="pb-placeholder" data-hidden={typed > 0}>
          Ask for an edit; @ to point at media or a clip, / for a skill
        </span>
        <span className="pb-typed">
          <Revealing text={PROMPT} shown={typed} live={typed > 0} />
        </span>
      </div>
      <div className="pb-composer-foot">
        <Paperclip />
        <AtSign />
        <span className="pb-model">
          <b>Claude</b> Default <ChevronDown />
        </span>
        <span className="pb-spacer" />
        <Gauge />
        <Sparkles />
        <span className="pb-send" data-state={sendState}>
          <ArrowUp />
          <Square />
        </span>
      </div>
    </div>
  );
}

export default function AgentPlayback() {
  const { root, step, finished } = usePlayback(TIMELINE.waits);
  const { sent, rows, reply, foot } = TIMELINE;
  const wordsShown = Math.min(step - reply + 1, REPLY_WORD_ENDS.length);
  const replyChars = wordsShown > 0 ? REPLY_WORD_ENDS[wordsShown - 1]! : 0;
  return (
    <div ref={root} className="pb agent-pb" role="img" aria-label={ALT} data-finished={finished}>
      <div className="pb-body" aria-hidden="true">
        <div className="pb-thread">
          <div className="pb-row pb-user" data-state={step >= sent ? "done" : "off"}>
            {PROMPT}
          </div>
          {rows.map(({ row, runAt, doneAt }) => (
            <ThreadRow key={row.done} row={row} state={rowState(step, runAt, doneAt)} />
          ))}
          <div className="pb-row pb-reply" data-state={step >= reply ? "done" : "off"}>
            <Revealing text={REPLY} shown={replyChars} live={step >= reply && step < foot} />
          </div>
          <div className="pb-row pb-foot" data-state={step >= foot ? "done" : "off"}>
            <span className="pb-edits">
              <Pencil />2 edits
            </span>
            <span className="pb-turn">Claude Code, 24 s</span>
            <span className="pb-spacer" />
            <span className="pb-undo">
              <Undo />
              Undo turn
            </span>
          </div>
        </div>
        <Composer step={step} />
      </div>
    </div>
  );
}
