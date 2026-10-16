// The independent critic (D195, issue #28; fix verification D196, issue #36). A review round isn't
// scored by the agent that built the video: Uncut renders the evidence itself (a contact sheet,
// phone-size frames, fresh frames of every claimed fix), adds its own layout checks and runs a
// separate, fresh `claude -p` with no tools, no MCP server, no session to resume and none of the
// builder's conversation: it sees the frames as images, the brief, the brand kit, the storyboard,
// the rubric, the last round's findings and the builder's fix claims, and answers with JSON. Any
// blocker fails the round whatever the scores; a claimed fix the critic can't see on the new frames
// is a blocker too. Pure functions plus runCritic (the process).
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { settingsArg, shellAuthReady, userAuthSettings } from "../app/shellEnv.ts";
import { resultError, resultFailed, turnLimits } from "./agentLimits.ts";

import type { Brief, IntendedFinding, Review, ReviewScores, Storyboard } from "@uncut/contracts";
import { REVIEW_SCORES } from "@uncut/contracts";
import { soundProfileText } from "@uncut/core";
import { isIntended, rubricBar, VIDEO_TYPE_NAMES, type Rubric, type RubricCategory } from "@uncut/core/skills";

/** The critic's bar: every score at least this. */
export const REVIEW_PASS = 8;
/** At most this many review rounds in a turn. */
export const REVIEW_ROUNDS = 3;
/** Rehearsal 4: past REVIEW_ROUNDS a turn keeps reviewing while its blockers shrink, up to this many rounds. */
export const REVIEW_ROUNDS_MAX = 6;

/**
 * Whether a turn may run another review round after these (its rounds, in order): always under
 * REVIEW_ROUNDS; then, up to REVIEW_ROUNDS_MAX, only while the last round still has blockers and
 * fewer than the round before it (it is converging). A pass, a stall or more blockers stop it.
 */
export function mayReviewAgain(rounds: ReadonlyArray<{ readonly passed?: boolean; readonly blockers?: ReadonlyArray<unknown> }>): boolean {
  if (rounds.length < REVIEW_ROUNDS) return true;
  if (rounds.length >= REVIEW_ROUNDS_MAX) return false;
  const last = rounds.at(-1)!, before = rounds.at(-2);
  const n = (x: { readonly blockers?: ReadonlyArray<unknown> } | undefined) => x?.blockers?.length ?? 0;
  return !last.passed && n(last) > 0 && !!before && n(last) < n(before);
}
/** A score whose category has a blocker is at most this. */
export const BLOCKER_CAP = 5;
/** A score with no frames cited is at most this (it can't pass). */
export const NO_EVIDENCE_CAP = REVIEW_PASS - 1;
/** How long the critic may take. */
export const criticMs = () => {
  const v = Number(process.env.UNCUT_CRITIC_MS);
  return Number.isFinite(v) && v > 0 ? v : 4 * 60_000;
};

/** In the critic's system prompt, so a test (and a log) can tell its process from the builder's. */
export const CRITIC_MARKER = "[uncut-critic]";

export const BLOCKER_KINDS = ["placeholder", "missing-asset", "font", "overflow", "illegible", "brand-colour", "invented", "blank", "off-centre", "unverified-fix", "sound", "other"] as const;
/** The score a blocker kind caps. */
const BLOCKER_SCORE: Readonly<Record<string, keyof ReviewScores>> = {
  placeholder: "brand",
  "missing-asset": "brand",
  font: "brand",
  "brand-colour": "brand",
  invented: "brand",
  overflow: "readability",
  illegible: "readability",
  "off-centre": "readability",
  blank: "variety",
  "unverified-fix": "readability",
  sound: "sound",
  motion: "motion",
};
type Category = keyof ReviewScores & RubricCategory;
const SCORE_NAMES: Readonly<Record<Category, string>> = {
  hook: "hook: the first 2 s make a stranger stop scrolling (motion or a claim on frame 0, no slow fade from black)",
  readability: "readability: every word meant to be read (titles, captions, headlines, the storyboard's quoted words, the line a moment is about) can be read at 360 px wide on a phone, in the time it's on screen; nothing clipped, overflowing or off-centre. Small labels inside a rebuilt interface are texture, not reading",
  motion: "motion: moves have intent and settle (springs, eases), no linear drifts, nothing jittery; over time (the frame strips and the <motion> scan): changes land on the music's beats, no single-frame pops, no hold over 1 s where something should move, and a film that loops meets its first frame at the seam",
  variety: "variety: shots change every 1 to 3 s, no two scenes look the same, no empty or held frames that say nothing",
  sound: "sound (from the <sound> sheet, you can't hear it): music whose tempo fits the cutting, cuts and big moments on its beats; sound effects that fit the video's sound profile, each on something that changes on screen; the voice never masked",
  brand: "brand: the kit's colours, fonts and logo files exactly, real product footage and copy where the brief planned them, nothing invented",
};

export const CRITIC_SYSTEM = `${CRITIC_MARKER} You are an independent critic of short product videos. You didn't make this video and owe its maker nothing. You see only rendered frames (images), the brief, the brand kit, the storyboard, the rubric and, from round 2, the last round's findings and what the editor says it fixed. You have no tools: judge only what is in the frames.
Score each category 0 to 10, where 8 means you would post it today as is and 10 is the best you've seen. Don't round up and don't default to the pass mark: a score needs evidence, the frames you looked at ("f 45", "f 90 to f 120") and what you saw there.
Score only the categories the <rubric> lists; a category marked "not applicable" gets no score (leave it out). Judge the video as the kind it is (the brief's type): a tutorial needs no hook, a talk no motion graphics, a meme may be loud on purpose.
Blockers are real defects, and they fail the video whatever the scores. The <rubric> says which kinds are blockers for this video; list every one you see:
- placeholder: an empty, blank or placeholder screen (a phone, browser or app frame with nothing real in it) where the brief or storyboard planned real footage or UI
- missing-asset: a planned real asset (logo file, screenshot, recording) that isn't there
- font: text drawn in a fallback or wrong font (not the kit's fonts; a generic system face where the kit names another)
- overflow: text cut off, running out of its box or past the frame's edge
- illegible: text meant to be read (a title, caption, headline, a quoted storyboard word, the line the moment is about) too small, too thin or too low in contrast to read at 360 px wide; small labels and chrome inside a rebuilt interface are texture, never this
- brand-colour: colours outside the kit where the kit should rule (backgrounds, text, accents), only when the rubric lists it
- invented: a logo, product UI, screen, metric, quote or customer that the brief and kit don't provide, or a number or status about the film's own making that differs from this run's facts in <motion>
- blank: a black or blank frame, or a nearly empty one (bare canvas with at most a cursor or a speck) for 0.2 s or more; Uncut measures these in <motion> ("Nearly empty frames"). A small element on a calm canvas is fine only while it fills a fair share of the frame and the next shape is already growing out of it
- off-centre: an element meant to be centred (a button glyph, a title, a logo) visibly off its centre
- sound: from the <sound> sheet, only when the rubric lists it: sound effects past the sound profile's limits, landing on nothing, a meme sound or a click on text the brief didn't ask for
Style rules (pacing, a hook, transitions, motion style, the sound's density or level) are defects, not blockers, unless the rubric lists them. Give every defect a kind: the category it belongs to (hook, readability, motion, variety, sound, brand) or a blocker kind.
Don't raise again what the user marked as intended (<intended>).
Sound, blindfold first: read the <sound> sheet alone before looking at the frames. Would those sounds by themselves feel like a meme reel or a click track? Then check each effect's time against the frames: does something change on screen right there?
The editor follows the skills in <skill-checklists>: check every line on the frames; a line the video fails is a defect (or a blocker when it is one of the kinds above), quoting the line.
Uncut's layout checks are listed as facts about the project: confirm what you see.
Motion over time: stills can't show timing, so you also get frame strips (a row of consecutive moments 1/12 s apart around each scene change, left to right) and Uncut's frame-difference scan in <motion>. From the strips judge whether each change lands on its beat (the storyboard's and the sound sheet's times), whether moves ease in and settle or snap, and whether text swapping inside a moving shape overlaps. The scan's pops (a frame unlike both its neighbours), one-frame jumps, holds over 1 s and the loop seam are measured, not guessed: confirm them on the strips and frames, and judge them as motion defects (a pop is always one; a cut or a hold is one only when the brief or the skills ask for one take with no holds).
Scale and words (in <motion>): Uncut measures how much of each strip's frames is flat background and the canvas around the picture; in a footage-first film, over 35 % at most scene changes means the footage sits small on an empty canvas: mark motion down for a card of footage on flat black with a caption under it. A wide shot of a whole app window (the full editor, every panel at once) where nothing the moment is about reads at 360 px is a readability defect with its time range ("f a to f b: the whole editor, nothing key reads"), not a blocker: the camera should push in on the part that matters (the timeline track that's filling, the preview, the line being typed). A UI-first film is one hero element at a time on a calm canvas: mark it down when the hero is muddy (dark panels on a near-black canvas, edges lost), cluttered (several panels at once), or the line it's about is cut mid-word at the frame's edge. Judge scale and sizes by the film's own direction (the brief, the storyboard, the skills), not by fixed numbers. Text ghosting into stacked copies (motion blur over a big jump in one frame) is a motion defect. Around the drop, check its strip: the reveal lands on the drop, not before. The storyboard's words are each beat's approved text: read them in that beat's frames; missing, cut or different words are a readability defect quoting both. Numbers and statuses a film shows about its own making (beat counts, review results, timings) must match this run's facts in <motion>: honesty first. One that states something false is an invented blocker, even when the brief scripted it. When the brief explicitly asks for such a fact and this run didn't produce it, say so in these words: "the brief asks for X, but this run shows Y", and give the true version to show instead (the real count or result, or the step without a result); a true text that differs from the brief's script is a brand defect with that wording, never a blocker.
From round 2: for every fix the editor claims, look at the new frames of that moment and say whether the defect is really gone (verified true) or not (false, and what you see instead). Believe the frames, not the claim. A fix you mark false fails the round like a blocker: your summary must agree (never "no blockers" while a claimed fix is unverified).
Answer with one JSON object and nothing else:
{"scores":{"hook":{"score":0,"evidence":"f 0, f 30: ..."},"readability":{...}},
 "blockers":[{"kind":"placeholder","what":"one sentence","at":3.2}],
 "defects":[{"kind":"motion","at":1.5,"what":"one sentence","fix":"one sentence"}],
 "fixes":[{"defect":"d1","verified":false,"note":"what the new frames show"}],
 "summary":"two sentences at most"}
at is seconds into the video. defects are the worst problems that aren't blockers, worst first, at most 6.`;

export interface CriticImage {
  readonly label: string;
  readonly jpeg: Buffer;
}
export interface CriticClaim {
  /** The defect or blocker id from the last round (d1, d2, …). */
  readonly defect: string;
  /** What the editor says it changed. */
  readonly what: string;
  /** Where the defect was (seconds), from the last round. */
  readonly at?: number;
  /** The defect as the critic described it. */
  readonly was?: string;
}
export interface CriticFinding {
  readonly rule: string;
  readonly message: string;
  readonly frame?: number;
  readonly hard: boolean;
  /** D217: the check's key ("sound:density:12") and the frames it covers. */
  readonly key?: string;
  readonly range?: { readonly start: number; readonly end: number };
}
/** An active skill's review checklist (D207). */
export interface CriticSkill {
  readonly name: string;
  readonly checklist: ReadonlyArray<string>;
}
export interface CriticInput {
  readonly round: number;
  readonly canvas: { readonly width: number; readonly height: number; readonly fps: number };
  readonly frames: number;
  readonly brief?: Brief | undefined;
  readonly storyboard?: Storyboard | undefined;
  readonly kit: ReadonlyArray<string>;
  readonly previous?: Review | undefined;
  readonly claims: ReadonlyArray<CriticClaim>;
  readonly checks: ReadonlyArray<CriticFinding>;
  readonly determinism: { readonly checked: ReadonlyArray<string>; readonly differed: ReadonlyArray<string> };
  readonly images: ReadonlyArray<CriticImage>;
  /** D207: the project's skills with their checklists. */
  readonly skills?: ReadonlyArray<CriticSkill>;
  /** D207: the sound as lines (core soundSheet), since the critic can't hear. */
  readonly sound?: ReadonlyArray<string>;
  /** D217: the rubric for this video (absent: every category required, as before). */
  readonly rubric?: Rubric;
  /** D217: findings the user marked Intended. */
  readonly intended?: ReadonlyArray<IntendedFinding>;
  /** D292: the frame-difference scan as facts (criticMotion.ts motionLines) and how many frame strips are among the images. */
  readonly motion?: { readonly lines: ReadonlyArray<string>; readonly strips: number };
}

/** The categories a rubric scores (all of them without one). */
export const scoredOf = (rubric: Pick<Rubric, "levels"> | undefined): Array<Category> => REVIEW_SCORES.filter((k) => !rubric || rubric.levels[k] !== "na");
/** A category's bar under a rubric (REVIEW_PASS without one). */
const barOf = (rubric: Pick<Rubric, "levels"> | undefined, k: Category) => (rubric ? rubricBar(rubric.levels[k]) : REVIEW_PASS);

/** A check's rule family: "sound:density:12" is "sound:density". */
const ruleOf = (c: CriticFinding) => (c.key ? c.key.split(":").slice(0, 2).join(":") : c.rule);
const secs = (frame: number, fps: number) => Math.round((frame / fps) * 100) / 100;
const checkKind = (c: CriticFinding) => (c.rule === "layout-off-centre" ? "off-centre" : c.rule === "font-missing" ? "font" : c.rule === "sound" ? "sound" : c.rule === "motion" ? "motion" : "overflow");
/** A check finding as Intended sees it (kind, rule family, time range in seconds). */
export const checkRef = (c: CriticFinding, fps: number) => ({ kind: checkKind(c), rule: ruleOf(c), ...(c.frame !== undefined ? { at: secs(c.frame, fps) } : {}), ...(c.range ? { to: secs(c.range.end, fps) } : {}) });

const join2 = (xs: ReadonlyArray<string> | undefined) => (xs ?? []).filter(Boolean).join("; ");

/** The critic's message: what it gets and only that (no builder conversation, no tool results). */
export function criticText(input: CriticInput): string {
  const { canvas } = input;
  const parts: Array<string> = [];
  parts.push(`Round ${input.round}. The video: ${canvas.width}×${canvas.height} at ${canvas.fps} fps, ${(input.frames / canvas.fps).toFixed(1)} s (${input.frames} frames). Frame n is at n / ${canvas.fps} s.`);
  const b = input.brief;
  parts.push(
    b
      ? ["<brief>", `film: ${b.film}`, `audience: ${b.audience}`, `duration: ${b.duration}`, `formats: ${join2(b.formats)}`, `assets: ${join2(b.assets)}`, `visual: ${b.visual}`, `hard lines: ${join2(b.hardLines)}`, b.notes ? `notes: ${b.notes}` : "", "</brief>"].filter(Boolean).join("\n")
      : "<brief>None written: judge it as a short product video.</brief>",
  );
  parts.push(`<brand>\n${input.kit.length ? input.kit.join("\n") : "No brand kit: judge brand on consistency and on nothing being invented."}\n</brand>`);
  const sb = input.storyboard;
  if (sb) parts.push(`<storyboard ${sb.status}>\n${sb.summary}\n${sb.beats.map((x, i) => `${i + 1}. ${x.start} to ${x.end} s ${x.title}: ${x.entry} to ${x.exit} (${x.purpose})${x.assets.length ? ` real assets: ${x.assets.join(", ")}` : ""}${x.sound ? `, on ${x.sound}` : ""}`).join("\n")}\n</storyboard>`);
  const skills = (input.skills ?? []).filter((x) => x.checklist.length);
  if (skills.length) parts.push(`<skill-checklists>\n${skills.map((x) => `${x.name}:\n${x.checklist.map((l) => `- ${l}`).join("\n")}`).join("\n")}\n</skill-checklists>`);
  // D217: findings the user marked Intended aren't shown.
  const checks = input.checks.filter((c) => !isIntended(checkRef(c, canvas.fps), input.intended));
  // Uncut's sound findings go with the sheet (they can't be seen on the frames).
  const soundChecks = checks.filter((c) => c.rule === "sound").map((c) => `${c.hard ? "fails" : "check"}${c.frame !== undefined ? ` at f ${c.frame}` : ""}: ${c.message}`);
  parts.push(`<sound>\n${[...(input.sound?.length ? input.sound : ["No sound sheet."]), ...soundChecks].join("\n")}\n</sound>`);
  const rb = input.rubric;
  if (rb) {
    const rows = REVIEW_SCORES.map((k) => {
      const level = rb.levels[k];
      if (level === "na") return `- ${k}: not applicable to this video, don't score it`;
      return `- ${level}, pass at ${barOf(rb, k)}: ${SCORE_NAMES[k]}${k === "sound" ? `; sound profile ${soundProfileText(rb.sound)}` : ""}`;
    });
    parts.push(`<rubric${rb.type ? ` ${VIDEO_TYPE_NAMES[rb.type]}` : ""}>\n${rows.join("\n")}\nBlockers for this video: ${rb.hardKinds.filter((k) => k !== "unverified-fix" && k !== "other").join(", ")}. Anything else is a defect.\nPass: no blockers, every scored category at its bar, every claimed fix verified.\n</rubric>`);
  } else parts.push(`<rubric>\n${REVIEW_SCORES.map((k) => `- ${SCORE_NAMES[k]}`).join("\n")}\nPass: every score ${REVIEW_PASS} or more, no blockers, every claimed fix verified.\n</rubric>`);
  if (input.intended?.length) parts.push(`<intended>\nThe user marked these as intended: don't raise them again.\n${input.intended.map((x) => `${x.kind}${x.from !== undefined ? ` at ${x.from}${x.to !== undefined && x.to !== x.from ? ` to ${x.to}` : ""} s` : ""}: ${x.what}`).join("\n")}\n</intended>`);
  const prev = input.previous;
  if (prev) {
    const found = [...(prev.blockers ?? []).map((x) => `${x.id ?? "?"} (blocker, ${x.kind})${x.at !== undefined ? ` at ${x.at} s` : ""}: ${x.what}`), ...prev.defects.map((d) => `${d.id ?? "?"} at ${d.at} s: ${d.what}`)];
    parts.push(`<last-round ${prev.round}>\n${found.join("\n") || "nothing listed"}\n</last-round>`);
  }
  if (input.claims.length) parts.push(`<claimed-fixes>\nThe editor says it fixed these. Check each on the new frames.\n${input.claims.map((c) => `${c.defect}${c.at !== undefined ? ` (at ${c.at} s)` : ""}${c.was ? `, was: ${c.was}` : ""}; the editor: ${c.what}`).join("\n")}\n</claimed-fixes>`);
  // D292: the motion scan (facts) and its findings.
  const motionChecks = checks.filter((c) => c.rule === "motion").map((c) => `${c.frame !== undefined ? `f ${c.frame}: ` : ""}${c.message}`);
  if (input.motion || motionChecks.length) parts.push(`<motion>\n${[...(input.motion?.lines ?? []), ...(input.motion?.strips ? [`${input.motion.strips} frame strip${input.motion.strips === 1 ? "" : "s"} among the images, one per scene change.`] : []), ...motionChecks].join("\n")}\n</motion>`);
  const layout = checks.filter((c) => c.rule !== "sound" && c.rule !== "motion");
  if (layout.length) parts.push(`<layout-checks>\n${layout.map((c) => `${c.hard ? "fails" : "check"}${c.frame !== undefined ? ` at f ${c.frame}` : ""}: ${c.message}`).join("\n")}\n</layout-checks>`);
  if (input.determinism.differed.length) parts.push(`Graphics that drew differently twice at the same frame: ${input.determinism.differed.join(", ")}.`);
  parts.push(`<images>\n${input.images.map((im, i) => `Image ${i + 1}: ${im.label}`).join("\n")}\n</images>`);
  parts.push("Answer with the JSON object only.");
  return parts.join("\n\n");
}

/** The stream-json user message: the text, then the images in order. */
export function criticMessage(input: CriticInput) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: criticText(input) }, ...input.images.map((im) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: im.jpeg.toString("base64") } }))],
    },
  };
}

export interface CriticAnswer {
  readonly scores: Partial<Record<Category, number>>;
  readonly evidence: Record<string, string>;
  readonly blockers: ReadonlyArray<{ kind: string; what: string; at?: number }>;
  readonly defects: ReadonlyArray<{ at: number; what: string; fix?: string; kind?: string }>;
  readonly fixes: ReadonlyArray<{ defect: string; verified: boolean; note?: string }>;
  readonly summary: string;
  /** Scores capped because they cited no frames. */
  readonly unproven: ReadonlyArray<string>;
}

const FRAME_REF = /\b(f|frame|frames)\s*\d+|\d+(\.\d+)?\s*s\b/i;
const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const sec = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : undefined);

/** The critic's JSON (the first object in its answer, fenced or not), or why it isn't one. */
export function parseCritic(text: string, scored: ReadonlyArray<Category> = REVIEW_SCORES): CriticAnswer | { problem: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text;
  const a = body.indexOf("{");
  const z = body.lastIndexOf("}");
  if (a < 0 || z <= a) return { problem: "no JSON object in the critic's answer" };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body.slice(a, z + 1));
  } catch {
    return { problem: "the critic's JSON didn't parse" };
  }
  const sc = (raw.scores && typeof raw.scores === "object" ? raw.scores : {}) as Record<string, unknown>;
  const scores: Partial<Record<Category, number>> = {};
  const evidence: Record<string, string> = {};
  const unproven: Array<string> = [];
  for (const k of scored) {
    const v = sc[k];
    const o = (v && typeof v === "object" ? v : { score: v }) as Record<string, unknown>;
    const n = o.score;
    if (typeof n !== "number" || !Number.isFinite(n)) return { problem: `the critic gave no ${k} score` };
    const ev = s(o.evidence, 400);
    let score = Math.max(0, Math.min(10, Math.round(n * 10) / 10));
    if (!FRAME_REF.test(ev)) {
      unproven.push(k);
      score = Math.min(score, NO_EVIDENCE_CAP);
    }
    scores[k] = score;
    if (ev) evidence[k] = ev;
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}));
  const blockers = list(raw.blockers).flatMap((b) => {
    const what = s(b.what, 300);
    const kind = (BLOCKER_KINDS as ReadonlyArray<string>).includes(s(b.kind, 40)) ? s(b.kind, 40) : "other";
    const at = sec(b.at);
    return what ? [{ kind, what, ...(at !== undefined ? { at } : {}) }] : [];
  });
  const defects = list(raw.defects).flatMap((d) => {
    const what = s(d.what, 300);
    const fix = s(d.fix, 300);
    const kind = s(d.kind, 40);
    return what ? [{ at: sec(d.at) ?? 0, what, ...(fix ? { fix } : {}), ...(kind ? { kind } : {}) }] : [];
  });
  const fixes = list(raw.fixes).flatMap((f) => {
    const defect = s(f.defect, 20);
    const note = s(f.note, 300);
    return defect ? [{ defect, verified: f.verified === true, ...(note ? { note } : {}) }] : [];
  });
  return { scores, evidence, blockers: blockers.slice(0, 12), defects: defects.slice(0, 6), fixes, summary: s(raw.summary, 600), unproven };
}

/** D217: the check findings that become review findings when they don't block (they can't be seen on frames). */
const CHECK_FINDING = /^sound:(density|loud|level):/;
/** D292: the motion scan's findings (pops; jumps, holds and the seam when asked for) are defects from the check, with or without a rubric. */
const MOTION_FINDING = /^motion:(pop|jump|hold|seam|empty|fast):/;

/**
 * The round as saved (D195, D196, D217): the critic's scores (only the categories the rubric scores)
 * and findings, Uncut's hard layout findings as blockers, every claimed fix the critic didn't verify
 * as a blocker, each blocker capping its score. Under a rubric, a blocker whose kind the video
 * doesn't treat as one (off-brand colour without a required brand, sound outside the strict profile,
 * "other") becomes a defect, and Uncut's soft sound findings (density, level) are defects from the
 * check. Findings the user marked Intended are left out (counted). Passed only with no blocker,
 * every scored category at its bar (required 8, optional 6; 8 for all without a rubric) and every
 * graphic deterministic.
 */
export function criticReview(answer: CriticAnswer, ctx: { round: number; claims: ReadonlyArray<CriticClaim>; checks: ReadonlyArray<CriticFinding>; determinism: { checked: Array<string>; differed: Array<string> }; looked: { sheet: boolean; phone: boolean }; revision: number; turnId: string; fps: number; rubric?: Rubric | undefined; intended?: ReadonlyArray<IntendedFinding> | undefined }): Review {
  const rubric = ctx.rubric;
  const hard = (kind: string) => !rubric || rubric.hardKinds.includes(kind);
  type Blocker = { id: string; kind: string; what: string; at?: number; source: string; rule?: string; to?: number };
  type Defect = { id: string; at: number; what: string; fix?: string; kind?: string; source?: string; rule?: string; to?: number };
  const rawBlockers: Array<Omit<Blocker, "id">> = [];
  const rawDefects: Array<Omit<Defect, "id">> = [];
  let dropped = 0;
  const keep = (f: { kind?: string; rule?: string; at?: number; to?: number }) => {
    if (isIntended(f, ctx.intended)) {
      dropped++;
      return false;
    }
    return true;
  };
  for (const b of answer.blockers) {
    if (!keep(b)) continue;
    if (hard(b.kind)) rawBlockers.push({ ...b, source: "critic" });
    else rawDefects.push({ at: b.at ?? 0, what: b.what, kind: b.kind, source: "critic" });
  }
  for (const c of ctx.checks) {
    const f = checkRef(c, ctx.fps);
    const at = f.at;
    if (c.hard) {
      if (keep(f)) rawBlockers.push({ ...f, what: c.message, source: "check" });
    } else if (c.key && ((rubric && CHECK_FINDING.test(c.key)) || MOTION_FINDING.test(c.key)) && keep(f)) rawDefects.push({ ...f, at: at ?? 0, what: c.message, source: "check" });
  }
  const blockers: Array<Blocker> = [];
  let n = 0;
  const id = () => `d${++n}`;
  for (const b of rawBlockers) blockers.push({ id: id(), ...b });
  const fixes = ctx.claims.map((c) => {
    const said = answer.fixes.find((f) => f.defect === c.defect);
    return { defect: c.defect, what: c.what, ...(c.at !== undefined ? { at: c.at } : {}), verified: said?.verified === true, ...(said?.note ? { note: said.note } : said ? {} : { note: "The critic didn't confirm it on the new frames." }) };
  });
  for (const f of fixes) if (!f.verified) blockers.push({ id: id(), kind: "unverified-fix", what: `The fix for ${f.defect} isn't visible on the new frames${f.note ? `: ${f.note}` : "."}`, ...(f.at !== undefined ? { at: f.at } : {}), source: "critic" });
  const scored = scoredOf(rubric);
  const scores: Partial<Record<Category, number>> = {};
  for (const k of scored) if (answer.scores[k] !== undefined) scores[k] = answer.scores[k];
  for (const b of blockers) {
    const k = BLOCKER_SCORE[b.kind] as Category | undefined;
    if (k && scores[k] !== undefined) scores[k] = Math.min(scores[k], BLOCKER_CAP);
  }
  const critic = answer.defects.filter((d) => keep(d)).map((d) => ({ ...d, ...(rubric ? { source: "critic" } : {}) }));
  const defects: Array<Defect> = [...critic, ...rawDefects].slice(0, 12).map((d) => ({ ...d, id: id() }));
  const passed = !blockers.length && scored.every((k) => (scores[k] ?? 0) >= (barOf(rubric, k) ?? 0)) && !ctx.determinism.differed.length;
  return {
    round: ctx.round,
    scores,
    defects,
    ...(answer.summary ? { notes: agreeingNotes(answer.summary, blockers) } : {}),
    by: "critic",
    blockers,
    evidence: answer.evidence,
    ...(fixes.length ? { fixes } : {}),
    ...(rubric ? { rubric: { ...rubric.levels }, ...(rubric.type ? { videoType: rubric.type } : {}), soundProfile: rubric.sound } : {}),
    ...(dropped ? { intended: dropped } : {}),
    determinism: ctx.determinism,
    looked: ctx.looked,
    passed,
    revision: ctx.revision,
    at: new Date().toISOString(),
    turnId: ctx.turnId,
  };
}

const NO_BLOCKERS = /\bno blockers?\b[^,.;]*?(?:,?\s*(?:and|but)\s+|[,;:]\s*|\.\s*|$)/i;
const KIND_WORDS: Readonly<Record<string, string>> = { "unverified-fix": "claimed fix not seen" };

/**
 * The critic's summary as the card shows it, agreeing with the round's blockers (rehearsal 4: round
 * 3 said "No blockers" under a "3 blockers" header, because Uncut adds a blocker for each claimed fix
 * the critic didn't verify, and its layout and motion blockers, after the critic wrote it). With
 * blockers, a "no blockers" clause goes and the count with its kinds leads.
 */
export function agreeingNotes(summary: string, blockers: ReadonlyArray<{ readonly kind: string }>): string {
  if (!blockers.length) return summary;
  const counts = new Map<string, number>();
  for (const b of blockers) counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  const kinds = [...counts].map(([k, n]) => `${KIND_WORDS[k] ?? k}${n > 1 ? ` ×${n}` : ""}`).join(", ");
  const lead = `${blockers.length} blocker${blockers.length === 1 ? "" : "s"} (${kinds}).`;
  const rest = summary.replace(NO_BLOCKERS, "").trim();
  if (rest === summary.trim() && new RegExp(`^${blockers.length} blockers?\\b`, "i").test(rest)) return summary;
  return rest ? `${lead} ${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : lead;
}

/** A saved review's rubric (its levels), for reviewNext and the cards; none before D217. */
const levelsOf = (review: Review) => (review.rubric ? { levels: review.rubric as Record<Category, "required" | "optional" | "na"> } : undefined);

/** What the builder does next after a round. */
export function reviewNext(review: Review, turnRound: number = review.round, more: boolean = turnRound < REVIEW_ROUNDS): string {
  const rb = levelsOf(review);
  const scored = scoredOf(rb);
  const low = scored.filter((k) => (review.scores[k] ?? 0) < (barOf(rb, k) ?? 0));
  const det = review.determinism?.differed.length ? ` The graphics ${review.determinism.differed.map((d) => `"${d}"`).join(", ")} drew differently twice at the same frame: they use the clock, timers or Math.random; make render(t) a pure function of t (seeded random from uncut:lib/random.js).` : "";
  const blockers = (review.blockers ?? []).map((b) => `${b.id} ${b.kind}${b.at !== undefined ? ` at ${b.at} s` : ""}: ${b.what}`);
  const scores = scored.map((k) => `${k} ${review.scores[k]}`).join(", ");
  const na = rb ? REVIEW_SCORES.filter((k) => rb.levels[k] === "na") : [];
  const naText = na.length ? ` Not scored for this video: ${na.join(", ")}.` : "";
  if (review.passed) return `Uncut's critic passed it (${scores}).${naText} Run project_check, fix its warnings, then tell the user in a line or two; the scores are the critic's, not yours.`;
  const open = `${blockers.length ? `Blockers (any one fails the round): ${blockers.join("; ")}.` : ""}${low.length ? ` Under the bar: ${low.map((k) => `${k} (${barOf(rb, k)})`).join(", ")}.` : ""}${det}`.trim();
  if (!more) return `That was round ${turnRound} in this turn, the last one${turnRound >= REVIEW_ROUNDS ? ` (past ${REVIEW_ROUNDS} rounds a turn goes on only while the blockers shrink, up to ${REVIEW_ROUNDS_MAX})` : ""}: stop fixing. Tell the user plainly that the critic didn't pass it and what is still wrong: ${open} Don't say it passed or is clean.`;
  const extra = turnRound >= REVIEW_ROUNDS ? `Round ${turnRound}: the blockers went down, so you get another round (at most ${REVIEW_ROUNDS_MAX}, and only while they keep going down). ` : "";
  return `Not passed. ${extra}${open} Fix every blocker first, then the worst defects (their ids are in the review); a defect the user wants as it is, they mark Intended on the review card. After the edit, render_frames the frames of each fixed moment and look: a fix you haven't seen at the new revision can't be claimed. Then review_submit with fixes [{"defect":"d1","what":"what you changed"}]; Uncut renders fresh frames and the critic checks each claim against them.`;
}

/**
 * The critic's command line: no tools, no MCP servers, no settings, no session kept; Uncut's critic
 * prompt replaces Claude Code's own (no tool talk, no hedging). D277: `settings`, when given, is
 * the --settings value (settingsArg: a 0600 file with the user's sign-in commands).
 */
export function criticArgs(model: string | undefined, settings?: string) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--permission-mode", "dontAsk", "--no-session-persistence", "--system-prompt", CRITIC_SYSTEM];
  if (settings) args.push("--settings", settings);
  if (model) args.push("--model", model);
  return args;
}

/**
 * Runs the critic: a fresh claude in an empty temp folder, the one message on stdin, its result
 * text back. Killed on the signal, after its result, or after criticMs.
 */
export async function runCritic(o: { bin: string; env: Record<string, string>; model: string | undefined; message: unknown; signal: AbortSignal }): Promise<string> {
  // D277 review: the login shell's sign-in first (bounded), then the user's sign-in commands in a
  // 0600 file inside the temp folder that is removed below, never on argv.
  await shellAuthReady();
  const cwd = await mkdtemp(join(tmpdir(), "uncut-critic-"));
  try {
    const auth = userAuthSettings(process.env).settings;
    const settings = Object.keys(auth).length ? settingsArg(cwd, {}, auth) : undefined;
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(o.bin, criticArgs(o.model, settings), { cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      let buf = "";
      let stderr = "";
      let settled = false;
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        o.signal.removeEventListener("abort", onAbort);
        kill();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`the critic didn't answer in ${Math.round(criticMs() / 1000)} s`))), criticMs());
      const onAbort = () => finish(() => reject(new Error("the turn was stopped")));
      if (o.signal.aborted) return onAbort();
      o.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout!.on("data", (d) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let m: Record<string, any>;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.type !== "result") continue;
          // D218: a usage limit or sign-in problem in the same words as the Agent tab.
          if (m.is_error === true || resultFailed(m) || typeof m.result !== "string") finish(() => reject(new Error(`the critic stopped: ${resultError(m, turnLimits(), Date.now()) ?? String(m.result ?? "no answer").slice(0, 300)}`)));
          else finish(() => resolve(m.result as string));
        }
      });
      child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      child.stdin!.on("error", () => {});
      child.stdin!.end(`${JSON.stringify(o.message)}\n`);
      child.once("error", (e) => finish(() => reject(new Error(`couldn't start Claude Code: ${e.message}`))));
      child.once("close", (code) => finish(() => reject(new Error(`the critic ended without an answer (code ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`))));
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
