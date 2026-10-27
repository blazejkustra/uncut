// A critic round in the thread, shown like a subagent (user, 2026-10-27; T3 Code's rows): "Critic,
// round 2" with its status, the live step under it while it runs, the elapsed time on the right, and
// the findings when opened.
import type { AgentCard } from "@uncut/contracts";
import { ChevronDown, ChevronRight, Gauge, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../../state/store.ts";
import { criticLabel, elapsedText, statusOf } from "./criticWords.ts";
import { ReviewBody } from "./review.tsx";

/** Now, every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function CriticItem({ card }: { card: AgentCard }) {
  const [open, setOpen] = useState(false);
  const app = useApp();
  const review = card.review;
  const critic = card.critic;
  const status = critic?.status ?? (review ? statusOf(review) : "error");
  const running = status === "running";
  const now = useNow(running);
  const round = critic?.round ?? review?.round ?? 0;
  const line = critic?.line || review?.notes || "";
  const started = critic ? Date.parse(critic.startedAt) : NaN;
  const ended = critic?.endedAt ? Date.parse(critic.endedAt) : running ? now : NaN;
  const elapsed = Number.isFinite(started) && Number.isFinite(ended) ? elapsedText(ended - started) : "";
  return (
    <div
      className={`card-item critic-row ${open ? "open" : ""}`}
      data-testid="agent-card"
      data-type="review"
      data-status={status}
      data-passed={review ? String(review.passed) : undefined}
    >
      <button className="card-head critic-head" aria-expanded={open} disabled={!review} onClick={() => setOpen(!open)}>
        <span className={`critic-icon ${status}`}>{running ? <LoaderCircle className="spin" /> : <Gauge />}</span>
        <span className="critic-text">
          <span className="critic-title">
            <span className="critic-name">Critic, round {round}</span>
            <span className={`card-outcome critic-status ${status}`} data-testid="critic-status">
              {criticLabel(status, review)}
            </span>
          </span>
          {line && (
            <span className="critic-line" data-testid="critic-line" title={line}>
              {line}
            </span>
          )}
        </span>
        {elapsed && (
          <span className="critic-time" data-testid="critic-time">
            {elapsed}
          </span>
        )}
        {review && (open ? <ChevronDown /> : <ChevronRight />)}
      </button>
      {open && review && <ReviewBody review={review} intended={app.agent?.plan?.intended ?? []} online={app.connection === "connected"} />}
    </div>
  );
}
