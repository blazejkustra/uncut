// Imported review notes on the ruler: a pin at each note's frame, dimmed once resolved. A press on one
// scrubs as anywhere on the ruler; a right-click is its menu.
import { MessageSquareText } from "lucide-react";
import type React from "react";

import type { ProjectModel } from "../state/project.ts";
import { openMenu } from "./ContextMenu.tsx";
import { reviewNoteMenu } from "./menus.ts";

export function ReviewPins({ project, ppf, online }: { project: ProjectModel; ppf: number; online: boolean }) {
  const notes = project.reviewNotes ?? [];
  if (!notes.length) return null;
  const menu = (e: React.MouseEvent, note: (typeof notes)[number]) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, reviewNoteMenu(note, online), "Review note");
  };
  return (
    <>
      {notes.map((note) => (
        <span
          key={note.id}
          className={`tl-review-pin ${note.resolved ? "resolved" : ""}`}
          data-testid="review-pin"
          data-note={note.id}
          data-frame={note.frame}
          data-resolved={note.resolved === true}
          title={`${note.author ? `${note.author}: ` : ""}${note.text}`}
          style={{ left: note.frame * ppf }}
          onContextMenu={(e) => menu(e, note)}
        >
          <MessageSquareText />
        </span>
      ))}
    </>
  );
}
