import { REVIEW_SCORES, type Review, type IntendedFinding } from "@uncut/contracts";
import { OPTIONAL_BAR, REQUIRED_BAR, type FindingRef, intendedOf, isVideoType, VIDEO_TYPE_NAMES, isIntended } from "@uncut/core/skills";
import { Check, ChevronRight, X } from "lucide-react";
import { Fragment, type CSSProperties } from "react";
import { playback } from "../../preview/playback.ts";
import { actions, agentImageUrl } from "../../state/store.ts";
import { momentText, roundOutcome, roundTrail, roundVerdict } from "./criticWords.ts";

const SCORE_NAMES: Readonly<Record<(typeof REVIEW_SCORES)[number], string>> = {
  hook: "Hook in 2 s",
  readability: "Phone readability",
  motion: "Motion",
  variety: "Variety",
  sound: "Sound sync",
  brand: "Brand",
};

/**
 * A review's scores as bars, with the critic's evidence under each (D217: only the categories the
 * video's rubric scores; a required one passes at 8, an optional one at 6; not applicable ones greyed).
 */
export function ScoreBars({ review, previous }: { review: Review; previous?: Review | undefined }) {
  return (
    <div className={`scores ${previous ? "with-rise" : ""}`} data-testid="agent-review-scores">
      {REVIEW_SCORES.map((k) => {
        const level = review.rubric?.[k] ?? "required";
        if (level === "na") {
          return (
            <div key={k} className="score na" data-testid="agent-review-score" data-score={k} data-applies="na">
              <span className="score-name">{SCORE_NAMES[k]}</span>
              <span className="score-bar" />
              <span className="score-value">N/A</span>
              <span className="score-evidence">Not judged for this video</span>
            </div>
          );
        }
        const v = review.scores[k] ?? 0;
        const bar = level === "optional" ? OPTIONAL_BAR : REQUIRED_BAR;
        const ev = review.evidence?.[k];
        const was = previous?.scores[k];
        const rise = was === undefined ? 0 : Math.round((v - was) * 10) / 10;
        const fill = { width: `${v * 10}%`, ...(rise > 0 ? { "--was": `${was! * 10}%` } : {}) } as CSSProperties;
        return (
          <div
            key={k}
            className={`score ${v >= bar ? "ok" : "low"} ${level}`}
            data-testid="agent-review-score"
            data-score={k}
            data-value={v}
            data-applies={level}
            title={ev}
          >
            <span className="score-name">
              {SCORE_NAMES[k]}
              {level === "optional" && <span className="muted"> (optional)</span>}
            </span>
            <span className="score-bar">
              <span className={rise > 0 ? "rose" : undefined} style={fill} />
            </span>
            <span className="score-value">{v}</span>
            {previous && (
              <span className={`score-rise ${rise > 0 ? "up" : rise < 0 ? "down" : ""}`} data-testid="agent-review-rise">
                {rise > 0 ? `+${rise}` : rise < 0 ? rise : ""}
              </span>
            )}
            {ev && v < bar && (
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

/** The frame a finding refers to: its picture and number; a click puts the playhead there. */
function FindingFrame({ at, frame, still }: { at: number; frame?: number | undefined; still?: string | undefined }) {
  const moment = momentText(at, frame);
  if (frame === undefined) return <span className="defect-at">{moment}</span>;
  return (
    <button
      className="finding-frame"
      data-testid="agent-review-frame"
      data-frame={frame}
      title="Show this frame in the preview"
      onClick={() => playback.seek(frame)}
    >
      {still && <img src={agentImageUrl(still)} alt={`Frame ${frame}`} loading="lazy" />}
      <span className="finding-moment">{moment}</span>
    </button>
  );
}

/** Where this round sits among the project's rounds, the turn from failed to passed included. */
function RoundTrail({ reviews, round }: { reviews: ReadonlyArray<Review>; round: number }) {
  const trail = roundTrail(reviews, round);
  if (trail.length < 2) return null;
  return (
    <div className="critic-rounds" data-testid="agent-review-rounds">
      {trail.map((r, i) => (
        <Fragment key={r.round}>
          {i > 0 && <ChevronRight />}
          <span className={`critic-round ${r.passed ? "passed" : "failed"}`} data-testid="agent-review-round" data-passed={r.passed}>
            <b>Round {r.round}</b> {roundOutcome(r)}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** D217: mark a finding Intended (the critic stops raising it), or take the mark back. */
function IntendedButton({ finding, what, marked, online }: { finding: FindingRef; what: string; marked: boolean; online: boolean }) {
  return (
    <button
      className={`link-btn intended-btn ${marked ? "active" : ""}`}
      data-testid="agent-review-intended"
      aria-pressed={marked}
      disabled={!online}
      title={marked ? "The critic won't raise this again. Click to take it back." : "This is on purpose: the critic stops raising it"}
      onClick={() => void actions.agentMarkIntended({ ...intendedOf(finding), what }, !marked)}
    >
      {marked ? <Check /> : null}
      Intended
    </button>
  );
}

export function ReviewBody({
  review,
  reviews,
  intended,
  online,
}: {
  review: Review;
  reviews: ReadonlyArray<Review>;
  intended: ReadonlyArray<IntendedFinding>;
  online: boolean;
}) {
  const blockers = review.blockers ?? [];
  const type = isVideoType(review.videoType) ? VIDEO_TYPE_NAMES[review.videoType] : undefined;
  const previous = reviews.filter((r) => r.round < review.round).at(-1);
  const verdict = roundVerdict(review, previous);
  return (
    <>
      <RoundTrail reviews={reviews} round={review.round} />
      {review.by === "critic" && !review.error && (
        <div
          className={`critic-verdict ${review.passed ? "passed" : "failed"} ${verdict.turned ? "turned" : ""}`}
          data-testid="agent-review-verdict"
          data-turned={verdict.turned}
        >
          <span className="critic-verdict-title">{verdict.title}</span>
          {verdict.detail && <span className="critic-verdict-detail">{verdict.detail}</span>}
        </div>
      )}
      <div
        className="review-by small muted"
        data-testid="agent-review-by"
        data-by={review.by ?? "agent"}
        title={review.by === "critic" ? "A separate Claude that sees only the frames, the brief, the kit and the storyboard" : undefined}
      >
        {review.by === "critic" ? "Independent critic" : "Self-scored"}
        {type && <span data-testid="agent-review-type">, judged as {type.toLowerCase()}</span>}
        {review.intended ? (
          <span data-testid="agent-review-left-out">, {review.intended === 1 ? "1 finding" : `${review.intended} findings`} you marked Intended left out</span>
        ) : null}
      </div>
      {review.error && <div className="small err">{review.error}</div>}
      <ScoreBars review={review} previous={previous} />
      {blockers.length > 0 && (
        <div className="blockers" data-testid="agent-review-blockers">
          {blockers.map((b, i) => {
            const marked = isIntended(b, intended);
            return (
              <div
                key={i}
                className={`blocker ${marked ? "marked" : ""}`}
                data-testid="agent-review-blocker"
                data-kind={b.kind}
                data-source={b.source}
                data-intended={marked}
              >
                {b.at !== undefined && <FindingFrame at={b.at} frame={b.frame} still={b.still} />}
                <span className="blocker-kind">{BLOCKER_NAMES[b.kind] ?? b.kind}</span>
                {b.kind !== "unverified-fix" && <IntendedButton finding={b} what={b.what} marked={marked} online={online} />}
                <span className="grow">
                  {b.what}
                  {b.fix && <span className="muted"> Fix: {b.fix}</span>}
                  {b.source === "check" && <span className="muted"> (Uncut's {b.kind === "sound" ? "sound" : "layout"} check)</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {review.fixes && review.fixes.length > 0 && (
        <div className="fixes" data-testid="agent-review-fixes">
          {review.fixes.map((f, i) => (
            <div key={i} className={`fix ${f.verified ? "ok" : "bad"}`} data-testid="agent-review-fix" data-verified={f.verified}>
              {f.verified ? <Check /> : <X />}
              {f.at !== undefined && <span className="defect-at">{momentText(f.at, undefined)}</span>}
              <span className="grow">
                {f.what}
                {f.note && <span className="muted">, {f.note}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {review.defects.length > 0 && (
        <div className="defects" data-testid="agent-review-defects">
          {review.defects.map((d, i) => {
            const marked = isIntended(d, intended);
            return (
              <div
                key={i}
                className={`defect ${marked ? "marked" : ""}`}
                data-testid="agent-review-defect"
                data-kind={d.kind}
                data-source={d.source}
                data-rule={d.rule}
                data-intended={marked}
              >
                <FindingFrame at={d.at} frame={d.frame} still={d.still} />
                <span className="grow">
                  {d.what}
                  {d.fix && <span className="muted">, fix: {d.fix}</span>}
                  {d.source === "check" && <span className="muted"> (Uncut's {d.rule?.startsWith("sound") ? "sound" : "layout"} check)</span>}
                </span>
                {review.by === "critic" && <IntendedButton finding={d} what={d.what} marked={marked} online={online} />}
              </div>
            );
          })}
        </div>
      )}
      {review.notes && review.by === "critic" && <div className="small">{review.notes}</div>}
      {review.determinism && review.determinism.checked.length > 0 && (
        <div className="small muted" data-testid="agent-review-determinism">
          {review.determinism.differed.length
            ? `Drew differently twice: ${review.determinism.differed.join(", ")}`
            : `${review.determinism.checked.length === 1 ? "1 graphic" : `${review.determinism.checked.length} graphics`} drew the same twice`}
        </div>
      )}
    </>
  );
}
