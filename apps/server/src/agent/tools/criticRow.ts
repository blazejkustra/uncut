// A critic round as a row in the thread (user, 2026-10-27: like a subagent in T3 Code): added when
// the round starts, its one-line step kept current while it runs, then its result (passed, its
// blockers, unresolved, or why it couldn't run) with the review to open.
import type { AgentCard, CriticRun, Review } from "@uncut/contracts";

import type { Running } from "../session/types.ts";

/** How the row reads once the critic answered. */
export const criticStatus = (review: Review): CriticRun["status"] => {
  if (review.passed) return "passed";
  const blockers = review.blockers ?? [];
  return blockers.length && blockers.every((b) => b.unresolved) ? "unresolved" : "failed";
};

export interface CriticRow {
  /** The live line while it runs ("Rendering the frames"). */
  readonly step: (line: string) => void;
  /** The critic answered: the review and its status. */
  readonly done: (review: Review) => void;
  /** The round couldn't run: why. */
  readonly fail: (line: string) => void;
  /** Ends a row still running (the turn stopped, or the round ended without done or fail). */
  readonly settle: () => void;
}

export function criticRow(r: Running, round: number, save: () => void, publish: () => void): CriticRow {
  const at = r.turn.items.length;
  let critic: CriticRun = { round, status: "running", line: "Rendering the frames", startedAt: new Date().toISOString() };
  let review: Review | undefined;
  const write = () => {
    const card: AgentCard = { type: "review", critic, ...(review ? { review } : {}) };
    r.turn.items[at] = { kind: "card", text: `Critic, round ${round}`, card };
  };
  const end = (status: CriticRun["status"], line: string) => {
    critic = { ...critic, status, line, endedAt: new Date().toISOString() };
    write();
    save();
    publish();
  };
  write();
  save();
  publish();
  return {
    step: (line) => {
      if (critic.status !== "running") return;
      critic = { ...critic, line };
      write();
      publish();
    },
    done: (got) => {
      review = got;
      end(criticStatus(got), got.notes ?? "");
    },
    fail: (line) => end("error", line),
    settle: () => {
      if (critic.status === "running") end("error", r.cancelled ? "Stopped with the turn." : "The round ended before the critic answered.");
    },
  };
}
