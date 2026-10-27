import { useState, useRef, useEffect } from "react";
import type { ProjectModel } from "../state/project.ts";
import { useAppSelect, type AppStateShape } from "../state/store.ts";
import { runningTurns } from "../state/agents.ts";

/** The revisions of the running turns' edits, as one string (the same string while they don't change). */
const turnRevisions = ({ agent }: AppStateShape) =>
  runningTurns(agent)
    .flatMap((t) => t.edits.map((e) => e.revision))
    .join(",");

/**
 * U6 (D185): the items an agent edit just added or changed, for a moment. An edit is the agent's
 * when the running turn lists its revision; the snapshot and the agent state come separately, in
 * either order, so each arrival checks the latest diff. Issue #118: only the running turn's edit
 * revisions are read, so the agent's streaming doesn't draw the timeline again.
 */
export function useAgentFlash(project: ProjectModel, revision: number | undefined): ReadonlySet<string> {
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set());
  const seen = useRef<Map<string, string> | undefined>(undefined);
  const diff = useRef<{ revision: number; ids: Array<string>; shown: boolean } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revisions = useAppSelect(turnRevisions);
  useEffect(() => {
    const now = new Map(project.tracks.flatMap((t) => t.items.map((i) => [i.id, JSON.stringify(i)] as const)));
    const before = seen.current;
    seen.current = now;
    if (before && revision !== undefined)
      diff.current = { revision, ids: [...now].filter(([id, json]) => before.get(id) !== json).map(([id]) => id), shown: false };
  }, [project, revision]);
  useEffect(() => {
    const d = diff.current;
    if (!d || d.shown || !d.ids.length || !revisions.split(",").includes(String(d.revision))) return;
    d.shown = true;
    setFlash(new Set(d.ids));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(new Set()), 1800);
  }, [revisions, revision]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return flash;
}
