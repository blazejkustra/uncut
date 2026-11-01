// The Review tab: the comments from a review page (Export › Review page), imported from the file or
// block it gives. There is no sync: each reviewer's comments arrive when the user imports them.
// The notes are the reviewers' text, shown as text and sent to the agent as untrusted data (core review.ts).
import { parseReviewNotes, planRemoveReviewNote, planResolveReviewNote, planReviewImport, type ReviewImport } from "@uncut/core/review";
import type { ReviewNote, ReviewRegion } from "@uncut/core/types";
import { FileUp, X } from "lucide-react";
import { useRef, useState } from "react";

import { playback } from "../preview/playback.ts";
import { frameTimecode } from "../state/format.ts";
import { actions, useApp, type Project } from "../state/store.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import "./review.css";

type Outcome = { readonly problem: string } | ReviewImport;

function importWords(result: ReviewImport): string {
  const added = result.added === 1 ? "1 note added." : `${result.added} notes added.`;
  return result.already ? `${added} ${result.already} already here.` : added;
}

function RegionBox({ region }: { region: ReviewRegion }) {
  const percent = (n: number) => `${n * 100}%`;
  return (
    <span className="review-region" title="The part of the frame the reviewer marked" data-testid="review-note-region">
      <i style={{ left: percent(region.x), top: percent(region.y), width: percent(region.w), height: percent(region.h) }} />
    </span>
  );
}

function NoteRow({ note, fps, project, online }: { note: ReviewNote; fps: number; project: Project; online: boolean }) {
  return (
    <li className={`review-note ${note.resolved ? "resolved" : ""}`} data-testid="review-note" data-note={note.id} data-frame={note.frame}>
      <div className="review-note-head">
        <button className="review-time mono" data-testid="review-note-seek" onClick={() => playback.seek(note.frame)}>
          {frameTimecode(note.frame, fps)}
        </button>
        {note.author && <span className="review-author ellipsis">{note.author}</span>}
        {note.region && <RegionBox region={note.region} />}
        <Tooltip label="Remove this note">
          <button
            className="icon-btn"
            data-testid="review-note-remove"
            disabled={!online}
            onClick={() => void actions.timelineEdit(planRemoveReviewNote(project, note.id))}
          >
            <X />
          </button>
        </Tooltip>
      </div>
      <p className="review-text" data-testid="review-note-text">
        {note.text}
      </p>
      <label className="review-resolve">
        <input
          type="checkbox"
          data-testid="review-note-resolve"
          checked={note.resolved === true}
          disabled={!online}
          onChange={(e) => void actions.timelineEdit(planResolveReviewNote(note.id, e.target.checked))}
        />
        Resolved
      </label>
    </li>
  );
}

export function ReviewPanel({ project }: { project: Project }) {
  const online = useApp().connection === "connected";
  const [block, setBlock] = useState("");
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const notes = project.reviewNotes ?? [];

  const importText = async (text: string) => {
    const parsed = parseReviewNotes(text);
    const planned = "problem" in parsed ? parsed : planReviewImport(project, parsed);
    if (!("problem" in planned) && planned.ops.length) await actions.timelineEdit(planned);
    setOutcome(planned);
    if (!("problem" in planned)) setBlock("");
  };
  const importFile = async (file: File | undefined) => {
    if (file) await importText(await file.text());
  };

  return (
    <aside className="library" data-testid="library">
      <div className="lib-head">Review notes</div>
      <div
        className={`review-panel ${over ? "over" : ""}`}
        data-testid="review-panel"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          void importFile(e.dataTransfer.files[0]);
        }}
      >
        <p className="review-limit" data-testid="review-limit">
          Export › Review page makes a page for reviewers. Their comments stay in their browser until they send you the file or block: there is no live sync, so
          import each one here.
        </p>
        <button className="btn" data-testid="review-choose" disabled={!online} onClick={() => picker.current?.click()}>
          <FileUp />
          Choose or drop a file
        </button>
        <input
          ref={picker}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="review-file"
          onChange={(e) => {
            void importFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <textarea
          data-testid="review-paste"
          rows={3}
          placeholder="Or paste the copied block"
          spellCheck={false}
          value={block}
          onChange={(e) => setBlock(e.target.value)}
        />
        {block.trim() && (
          <button className="btn primary" data-testid="review-import" disabled={!online} onClick={() => void importText(block)}>
            Import
          </button>
        )}
        {outcome && "problem" in outcome && (
          <div className="inline-error" role="alert" data-testid="review-problem">
            {outcome.problem}
          </div>
        )}
        {outcome && !("problem" in outcome) && (
          <div className="review-outcome" data-testid="review-outcome">
            <p>{importWords(outcome)}</p>
            {outcome.warnings.map((w) => (
              <p key={w} className="review-warning" data-testid="review-warning">
                {w}
              </p>
            ))}
          </div>
        )}
        {notes.length > 0 && (
          <>
            <p className="review-limit">
              Pins stay on their frame while you edit. Ask the agent to address the review notes and it resolves each one it handles.
            </p>
            <ol className="review-notes">
              {notes.map((n) => (
                <NoteRow key={n.id} note={n} fps={project.canvas.fps} project={project} online={online} />
              ))}
            </ol>
          </>
        )}
      </div>
    </aside>
  );
}
