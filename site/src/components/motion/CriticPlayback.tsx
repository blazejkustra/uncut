"use client";
import { ChevronDown, ChevronRight, Gauge, LoaderCircle } from "./icons.tsx";
import { usePlayback } from "./usePlayback.ts";

const ALT =
  "The critic's scores for a cut. Round 1 is below the bar with phone readability at 5, so the edit goes back. Round 2 passes: hook in 2 s, phone readability, motion and variety, each 9 out of 10, with the frames each score is based on.";

const WAITS: ReadonlyArray<number> = [650, 820, 820, 820, 950, 1500, 1250, 1150, 7000];
const ROUND_ONE_ENDS = 5;
const ROUND_TWO_STARTS = 6;
const READABILITY_RISES = 7;
const PASSES = 8;

type Score = { name: string; scoredAt: number; roundOne?: number; frames: readonly [number, number]; evidence: string };

const FINAL_SCORE = 9;
const BAR = 8;
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const SCORES: ReadonlyArray<Score> = [
  { name: "Hook in 2 s", scoredAt: 1, frames: [0, 45], evidence: "f 0, f 45: the claim lands on frame 0" },
  { name: "Phone readability", scoredAt: 2, roundOne: 5, frames: [0, 45], evidence: "f 0, f 45: the claim reads at 360 px" },
  { name: "Motion", scoredAt: 3, frames: [0, 45], evidence: "f 0, f 45: the rise settles" },
  { name: "Variety", scoredAt: 4, frames: [390, 450], evidence: "f 390, f 450: road, then the lighthouse" },
];

function scoreAt(score: Score, step: number): number {
  if (step < score.scoredAt) return 0;
  return score.roundOne !== undefined && step < READABILITY_RISES ? score.roundOne : FINAL_SCORE;
}

function Reel({ value }: { value: number }) {
  return (
    <span className="cp-value" data-v={value}>
      <span className="cp-reel">
        {DIGITS.map((d) => (
          <i key={d}>{d}</i>
        ))}
      </span>
    </span>
  );
}

function ScoreRow({ score, step }: { score: Score; step: number }) {
  const value = scoreAt(score, step);
  const risen = score.roundOne !== undefined && step >= READABILITY_RISES;
  const proven = value === FINAL_SCORE;
  return (
    <div className="cp-score" data-on={step >= score.scoredAt} data-low={value > 0 && value < BAR}>
      <div className="cp-frames" data-on={proven}>
        {score.frames.map((f) => (
          <img key={f} src={`/assets/img/critic-f${f}.webp`} width={112} height={140} alt="" loading="lazy" />
        ))}
      </div>
      <div className="cp-main">
        <span className="cp-name">{score.name}</span>
        <span className="cp-bar" data-v={value}>
          <span />
        </span>
        <Reel value={value} />
        <span className="cp-rise" data-on={risen}>
          {score.roundOne !== undefined && `+${FINAL_SCORE - score.roundOne}`}
        </span>
        <span className="cp-evidence" data-on={proven}>
          {score.evidence}
        </span>
      </div>
    </div>
  );
}

function headStatus(step: number): "running" | "below" | "passed" {
  if (step >= PASSES) return "passed";
  if (step >= ROUND_TWO_STARTS) return "running";
  return step >= ROUND_ONE_ENDS ? "below" : "running";
}

function Head({ step }: { step: number }) {
  const status = headStatus(step);
  return (
    <div className="cp-head" data-status={status}>
      <span className="cp-head-icon">
        <LoaderCircle className="pb-spin" />
        <Gauge className="pb-gauge" />
      </span>
      <span className="cp-head-name">Critic, round {step >= ROUND_TWO_STARTS ? 2 : 1}</span>
      <span className="cp-status">
        <span data-for="running">Running</span>
        <span data-for="below">Below the bar</span>
        <span data-for="passed">Passed</span>
      </span>
      <ChevronDown className="pb-chev" />
    </div>
  );
}

function Trail({ step }: { step: number }) {
  return (
    <div className="cp-trail" data-on={step >= ROUND_TWO_STARTS}>
      <span className="cp-round failed">
        <b>Round 1</b> Below the bar
      </span>
      <span className="cp-round-next" data-on={step >= PASSES}>
        <ChevronRight />
        <span className="cp-round passed">
          <b>Round 2</b> Passed
        </span>
      </span>
    </div>
  );
}

function Verdict({ step }: { step: number }) {
  const shown = step >= PASSES ? "passed" : step >= ROUND_ONE_ENDS ? "failed" : "none";
  return (
    <div className="cp-verdict" data-shown={shown}>
      <div className="cp-verdict-text failed">
        <span className="cp-verdict-title">Failed round 1</span>
        <span className="cp-verdict-detail">Scores under the bar</span>
      </div>
      <div className="cp-verdict-text passed">
        <span className="cp-verdict-title">Passed on round 2</span>
        <span className="cp-verdict-detail">readability 5 to 9</span>
      </div>
    </div>
  );
}

export default function CriticPlayback() {
  const { root, step, finished } = usePlayback(WAITS);
  return (
    <div ref={root} className="pb critic-pb" role="img" aria-label={ALT} data-finished={finished}>
      <div className="pb-body" aria-hidden="true">
        <Head step={step} />
        <div className="cp-by">Independent critic</div>
        <div className="cp-scores">
          {SCORES.map((score) => (
            <ScoreRow key={score.name} score={score} step={step} />
          ))}
        </div>
        <Trail step={step} />
        <Verdict step={step} />
      </div>
    </div>
  );
}
