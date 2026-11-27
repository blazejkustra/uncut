import { useState, useRef, useEffect } from "react";
import type { ProjectModel } from "../state/project.ts";
import { useAppSelect, type AppStateShape } from "../state/store.ts";
import { agentsOf, runningTurns, turnAgent } from "../state/agents.ts";

/** How long an item shows its agent's outline after an agent edit (D348). */
export const FLASH_MS = 1000;

/** The running turns' edit revisions with their agent's colour, as one string ("12:#5b8def,13:#3fb68b"; the same while they don't change). */
const turnRevisions = ({ agent }: AppStateShape) => {
  const colours = new Map(agentsOf(agent).map((a) => [a.id, a.colour]));
  return runningTurns(agent)
    .flatMap((t) => t.edits.map((e) => `${e.revision}:${colours.get(turnAgent(t)) ?? ""}`))
    .join(",");
};

/** The colour turnRevisions lists for `revision`; undefined when no running turn made it. */
const colourOf = (revisions: string, revision: number) => {
  const entry = revisions.split(",").find((r) => r.startsWith(`${revision}:`));
  return entry === undefined ? undefined : entry.slice(entry.indexOf(":") + 1);
};

/**
 * U6 (D185): the items an agent edit just added or changed, for a moment, each with the colour of
 * the agent that made it (D348). An edit is the agent's when the running turn lists its revision;
 * the snapshot and the agent state come separately, in either order, so each arrival checks the
 * latest diff. Issue #118: only the running turn's edit revisions are read, so the agent's
 * streaming doesn't draw the timeline again.
 */
export function useAgentFlash(project: ProjectModel, revision: number | undefined): ReadonlyMap<string, string> {
  const [flash, setFlash] = useState<ReadonlyMap<string, string>>(() => new Map());
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
    const colour = d && colourOf(revisions, d.revision);
    if (!d || d.shown || !d.ids.length || colour === undefined) return;
    d.shown = true;
    setFlash(new Map(d.ids.map((id) => [id, colour])));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(new Map()), FLASH_MS);
  }, [revisions, revision]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return flash;
}
