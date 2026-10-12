// The History tab (D71): the project's revisions from history.db, newest first: who changed what and
// when. A turn's edits are one group with its prompt and "Undo turn". Clicking an entry previews that
// version in the viewer (the timeline keeps showing now); Restore brings it back as a new revision,
// so one ⌘Z takes the restore back. Everything comes from history.subscribe and agent.subscribe.
import type { AgentTurn, HistoryEntry, ProjectSnapshot } from "@uncut/contracts";
import { Download, Eye, FileText, FileWarning, History as HistoryIcon, RotateCcw, Sparkles, TriangleAlert, Undo2, User } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { getPlayback, playback, type PreviewDraft } from "./playback.ts";
import { actions, projectOf, useApp } from "./store.ts";

type Group = { readonly key: string; readonly entries: ReadonlyArray<HistoryEntry>; readonly turnId?: string };

/** Consecutive entries of one agent turn are one group; everything else stands alone. */
export function groupEntries(entries: ReadonlyArray<HistoryEntry>): Array<Group> {
  const groups: Array<{ key: string; entries: Array<HistoryEntry>; turnId?: string }> = [];
  for (const e of entries) {
    const last = groups.at(-1);
    if (e.turnId && last?.turnId === e.turnId) last.entries.push(e);
    else groups.push({ key: String(e.revision), entries: [e], ...(e.turnId ? { turnId: e.turnId } : {}) });
  }
  return groups;
}

const WHO: Readonly<Record<HistoryEntry["author"], string>> = { user: "You", agent: "Agent", external: "Outside Uncut", import: "You" };
/** Who an entry is by, in words: the start of a history for an existing file is the file's, not the user's. */
const who = (e: HistoryEntry) => (e.kind === "initial" && e.author === "import" ? "project.json" : WHO[e.author]);

/** "14:03" today, "Oct 11, 14:03" before. */
export function when(at: string, now = new Date()) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function AuthorIcon({ entry }: { entry: HistoryEntry }) {
  if (entry.kind === "external") return <FileWarning />;
  if (entry.kind === "jump") return <RotateCcw />;
  if (entry.kind === "initial" && entry.author === "import") return <FileText />;
  if (entry.author === "agent") return <Sparkles />;
  if (entry.author === "import") return <Download />;
  return <User />;
}

export function HistoryPanel({ snapshot, online }: { snapshot: ProjectSnapshot; online: boolean }) {
  const { history, agent } = useApp();
  const [selected, setSelected] = useState<number | undefined>();
  const [preview, setPreview] = useState<{ readonly revision: number; readonly draft: PreviewDraft } | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const project = projectOf(snapshot);
  const mine = history && history.dir === snapshot.dir ? history : undefined;
  const entries = mine?.entries ?? [];
  const groups = useMemo(() => groupEntries(entries), [entries]);
  const turns = useMemo(() => new Map((agent?.turns ?? []).map((t) => [t.id, t])), [agent]);
  // The entry that is "now": the newest one whose change is in the project as it is.
  const now = entries.find((e) => e.current)?.revision;
  // The preview asked for last, and the project it was asked against: an older answer is dropped.
  const wanted = useRef<{ readonly revision: number; readonly base: unknown } | undefined>(undefined);

  // A new snapshot (an edit, an undo, the restore itself) ends the preview: it showed another base.
  useEffect(() => {
    wanted.current = undefined;
    setSelected(undefined);
    setPreview(undefined);
    setProblem(undefined);
  }, [snapshot.revision, snapshot.dir]);
  // The preview draws through the playback draft (D53), ignored as soon as the project changes.
  useEffect(() => {
    if (!preview) return;
    playback.pause();
    playback.setDraft(preview.draft);
    return () => {
      if (getPlayback().draft === preview.draft) playback.setDraft(undefined);
    };
  }, [preview]);

  const pick = async (revision: number) => {
    if (selected === revision) return close();
    setSelected(revision);
    setProblem(undefined);
    if (revision === now) {
      wanted.current = undefined;
      return setPreview(undefined);
    }
    const ask = { revision, base: project };
    wanted.current = ask;
    const result = await actions.historyPreview(revision);
    if (wanted.current !== ask) return;
    if ("problem" in result) return setProblem(result.problem);
    setPreview({ revision, draft: { base: project, project: result.project } });
  };
  const close = () => {
    wanted.current = undefined;
    setSelected(undefined);
    setPreview(undefined);
    setProblem(undefined);
  };
  const restore = async (revision: number) => {
    const error = await actions.historyJump(revision);
    if (!error) close();
  };

  return (
    <div className="history" data-testid="history-panel">
      <div className="history-head">
        <HistoryIcon />
        <span className="grow">History</span>
        {mine && (
          <span className="muted small" data-testid="history-count">
            {mine.total} change{mine.total === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {mine?.problem && (
        <div className="history-problem" data-testid="history-problem">
          <TriangleAlert />
          <span>{mine.problem}</span>
        </div>
      )}
      {preview && (
        <div className="history-preview-note" data-testid="history-previewing">
          <Eye />
          <span className="grow">Previewing revision {preview.revision} in the viewer. The timeline still shows now.</span>
        </div>
      )}
      <div className="history-list" data-testid="history-list">
        {!mine && <div className="muted small history-empty">Loading…</div>}
        {groups.map((g) =>
          g.turnId ? (
            <TurnGroup key={g.key} group={g} turn={turns.get(g.turnId)} now={now} selected={selected} online={online} onPick={pick} onRestore={restore} />
          ) : (
            <Entry key={g.key} entry={g.entries[0]!} now={now} selected={selected} online={online} onPick={pick} onRestore={restore} />
          ),
        )}
        {problem && <div className="inline-error small">{problem}</div>}
        {mine && mine.total > entries.length && <div className="muted small history-empty">Older changes ({mine.total - entries.length}) aren't listed.</div>}
      </div>
    </div>
  );
}

interface RowProps {
  readonly now: number | undefined;
  readonly selected: number | undefined;
  readonly online: boolean;
  readonly onPick: (revision: number) => void;
  readonly onRestore: (revision: number) => void;
}

function Entry({ entry, now, selected, online, onPick, onRestore, nested = false }: RowProps & { entry: HistoryEntry; nested?: boolean }) {
  const open = selected === entry.revision;
  const isNow = entry.revision === now;
  return (
    <div
      className={`history-entry ${entry.current ? "" : "out"} ${entry.kind === "external" ? "external" : ""} ${open ? "open" : ""} ${nested ? "nested" : ""}`}
      data-testid="history-entry"
      data-revision={entry.revision}
      data-kind={entry.kind}
      data-author={entry.author}
      data-current={entry.current}
    >
      <button
        className="history-row"
        aria-expanded={open}
        onClick={() => onPick(entry.revision)}
        title={entry.current ? "Preview this version" : "Not in the project now (undone or gone back past). Preview it"}
      >
        {!nested && <AuthorIcon entry={entry} />}
        <span className="history-label">
          {!nested && <span className="history-who">{who(entry)}</span>}
          <span className="history-what">{entry.label}</span>
          {!entry.current && (
            <span className="history-tag" data-testid="history-not-current">
              Not in the project now
            </span>
          )}
        </span>
        <span className="history-when">{isNow ? <span className="history-now">Now</span> : when(entry.at)}</span>
      </button>
      {open && (
        <div className="history-detail">
          {entry.lines.map((line, i) => (
            <div key={i} className="history-line">
              {line}
            </div>
          ))}
          {!entry.current && <div className="history-line muted">Not in the project now: it was undone, or History went back past it.</div>}
          <div className="history-actions">
            <button className="btn" data-testid="history-restore" disabled={!online || isNow} onClick={() => onRestore(entry.revision)}>
              <RotateCcw />
              {isNow ? "This is now" : "Restore this version"}
            </button>
            <button className="btn ghost" onClick={() => onPick(entry.revision)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TurnGroup({ group, turn, ...rest }: RowProps & { group: Group; turn: AgentTurn | undefined }) {
  const newest = group.entries[0]!;
  const undo = turn?.undo;
  return (
    <div
      className={`history-turn ${group.entries.some((e) => e.current) ? "" : "out"}`}
      role="group"
      aria-label={`Agent turn${turn ? `: ${turn.prompt}` : ""}`}
      data-testid="history-turn"
      data-turn={group.turnId}
      data-undo={undo?.state ?? "none"}
    >
      <button className="history-turn-head" aria-expanded={rest.selected === newest.revision} title="Preview the project after this turn" onClick={() => rest.onPick(newest.revision)}>
        <Sparkles />
        <span className="history-label">
          <span className="history-who">Agent</span>
          <span className="history-what">{turn ? `“${turn.prompt}”` : "A turn"}</span>
        </span>
        <span className="history-when">{when(newest.at)}</span>
      </button>
      {group.entries.map((e) => (
        <Entry key={e.revision} entry={e} nested {...rest} />
      ))}
      {undo && (undo.state === "available" || undo.state === "blocked" || undo.state === "undone") && (
        <div className="history-turn-foot">
          {undo.state === "undone" ? (
            <span className="muted small">Turn undone</span>
          ) : (
            <button className="link-btn" data-testid="history-undo-turn" disabled={!rest.online || undo.state !== "available"} title={undo.reason ?? "Undo this turn's edits, keeping later ones"} onClick={() => void actions.agentUndoTurn(turn!.id)}>
              <Undo2 />
              Undo turn
            </button>
          )}
          {undo.state === "blocked" && undo.reason && <span className="muted small history-reason">{undo.reason}</span>}
        </div>
      )}
    </div>
  );
}

