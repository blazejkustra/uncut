// Marked sections on the timeline (issue #118): a band on the ruler for each, hatched grey with a
// lock where it's locked, red where it's flagged "not OK" for the agent to redo, and a faint wash of
// the same over the lanes. A right-click on a band is its menu (unlock, mark as OK, lock the rest);
// a press on it scrubs as anywhere on the ruler.
import { Lock, RotateCcw } from "lucide-react";
import type React from "react";

import type { ProjectModel } from "../state/project.ts";
import { openMenu } from "./ContextMenu.tsx";
import { sectionMenu } from "./menus.ts";

export function Sections({ project, ppf, online }: { project: ProjectModel; ppf: number; online: boolean }) {
  const sections = project.sections ?? [];
  if (!sections.length) return null;
  const menu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, sectionMenu(project, id, online), "Section");
  };
  return (
    <>
      {sections.map((s) => (
        <div
          key={s.id}
          className={`tl-section ${s.state}`}
          data-testid="section"
          data-section={s.id}
          data-state={s.state}
          data-start={s.start}
          data-end={s.end}
          title={s.state === "locked" ? "Locked: nothing here can move or change (right-click to unlock)" : `Not OK: for the agent to redo${s.note ? `: ${s.note}` : ""}`}
          style={{ left: s.start * ppf, width: Math.max(2, (s.end - s.start) * ppf) }}
          onContextMenu={(e) => menu(e, s.id)}
        >
          <span className="tl-section-tag">
            {s.state === "locked" ? <Lock /> : <RotateCcw />}
            {(s.end - s.start) * ppf > 70 && <span>{s.state === "locked" ? "Locked" : "Redo"}</span>}
          </span>
          <div className="tl-section-wash" />
        </div>
      ))}
    </>
  );
}
