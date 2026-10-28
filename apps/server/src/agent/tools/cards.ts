// The production process's cards (U7-U9, U15-U17, U19; D186-D191): ask_user, brief_write, storyboard_propose, review_submit.
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REVIEW_SCORES, type AgentCard, type AgentPlan, type AgentAnswer, type Storyboard, type Brief, type BrandKit, type BrandSkill } from "@uncut/contracts";
import {
  CHECK_IDS,
  fontRule,
  GRAPHIC_SRC,
  LAYOUT_HARD,
  LAYOUT_RULES,
  projectChecks,
  soundHard,
  soundProfileText,
  soundSheet,
  type Project,
  layout,
  motionBlurDefault,
  projectMotionBlur,
  safeMargin,
} from "@uncut/core";
import * as Effect from "effect/Effect";
import { CELL_WIDTH, clock, sheetFrames, sheetLayout } from "../agentFootage.ts";
import { answerOut, kitLines, questionOf } from "../agentPlan.ts";
import {
  blurStripLabel,
  criticMessage,
  criticReview,
  parseCritic,
  reviewNext,
  reviewOutlook,
  runCritic,
  scoredOf,
  type CriticClaim,
  type CriticFinding,
  type CriticImage,
  type CriticInput,
} from "../agentCritic.ts";
import { activeBrand, readBrand, readPlan, writeBrief, writeReview, writeStoryboard, normBrief, normBeats } from "../../brand/store.ts";
import { BUILTIN_IDS, guessVideoType, isVideoType, reviewRubric, skillChecklist, suggestSkills, VIDEO_TYPES } from "@uncut/core/skills";
import { FONT_ERRORS } from "../agentTools.ts";
import { readGraphics, type FrameSessionShape } from "../../export/exporter.ts";
import { projectFonts } from "../../export/fonts.ts";
import type { ProjectView } from "../../project/projects.ts";
import type { Running } from "../session/types.ts";
import { PHONE_WIDTH } from "./common.ts";
import { findClaude, sessionEnv } from "../session/config.ts";
import {
  beatWordLines,
  beatWords,
  budgetLine,
  canvasShare,
  chromaFrames,
  clipCutFrames,
  footageJump,
  dropBeat,
  dropLine,
  emptyRuns,
  flatFindings,
  flatFraction,
  flatLines,
  grayFrames,
  motionAnchors,
  motionFindings,
  motionFrames,
  motionIntent,
  motionLines,
  motionScan,
  REFINE_BUDGET_MS,
  REFINE_EMPTY_BUDGET_MS,
  refineEmpty,
  refineJumps,
  scanPlan,
  blurPicks,
  BLUR_CELL,
  scanSize,
  emptySize,
  emptyMeasure,
  thinMeasure,
  thinRuns,
  thinSize,
  scanRenderWidth,
  STILL_MAX_S,
  type ScanFrame,
  stripLayout,
  stripPlan,
  type FlatStrip,
  type MotionScan,
} from "../criticMotion.ts";
import { which } from "../../app/setup.ts";
import { fineJitter } from "../motionJitter.ts";
export { blurStripLabel } from "../agentCritic.ts";
import { rehearsalLine } from "../../export/exporter/rehearse.ts";
import { measuredMixLines } from "./measure.ts";
import { censusNear, legibilityFacts, legibilityFindings } from "../agentLegibility.ts";
import { typedPromptCheck } from "../agentTypedPrompt.ts";

/** How long review_submit may spend rehearsing the export's graphics (ms; a rehearsal that passed isn't run again). */
export const REHEARSE_REVIEW_MS = 30_000;
import type { CardAnswer } from "../agent.ts";
import type { GenerateCtx } from "./generate.ts";

/**
 * This run's facts for the critic: a film that shows the app making itself may only show true
 * numbers and statuses (the storyboard's beats, the review rounds so far and what each found).
 */
export function runFacts(
  beats: number | undefined,
  reviews: ReadonlyArray<{
    readonly round: number;
    readonly blockers?: ReadonlyArray<unknown>;
    readonly passed?: boolean;
    readonly scores?: Readonly<Partial<Record<string, number>>>;
  }>,
): string {
  // Round 2's A1: one round accepted an in-film card showing round 1's scores and the next flagged
  // it; with every round's result and exact scores here the check is the same every round.
  const rounds = reviews.map((x) => {
    const n = x.blockers?.length ?? 0;
    const result = x.passed === true ? "passed" : x.passed === false || n ? "not passed" : "";
    const scores = REVIEW_SCORES.filter((k) => typeof x.scores?.[k] === "number").map((k) => `${k} ${x.scores![k]}`);
    return `round ${x.round}: ${[result, n ? `${n} blocker${n === 1 ? "" : "s"}` : "no blockers", scores.length ? `scores ${scores.join(", ")}` : ""].filter(Boolean).join(", ")}`;
  });
  // A2: "the storyboard has no beats" read as a fact when none was proposed yet (the film was built first).
  const board = beats ? `the storyboard has ${beats} beat${beats === 1 ? "" : "s"}` : "no storyboard has been proposed yet (so its beat count isn't known)";
  return `This run's facts, for any number or status the film shows about its own making: ${board}; this is review ${reviews.length + 1}${rounds.length ? ` (before it: ${rounds.join("; ")})` : ", the first"}, and its own result isn't known while you judge it. A beat count, review result, score, round or timing on screen that states something these contradict is invented, and so is a round's scores shown without its result when it didn't pass (they read as a pass); when the brief scripted it, say "the brief asks for X, but this run shows Y" and give the true version.`;
}

/**
 * The user's own words for the critic: the project's main request (its longest message, where a
 * detailed brief lives) first, then this turn's message when it's another (a later "make it faster"
 * mustn't hide the brief). Each capped, so a pasted log can't crowd out the frames.
 */
export function userRequest(prompts: ReadonlyArray<string | undefined>, current: string | undefined, cap = 8000): string {
  const all = prompts.map((x) => x?.trim() ?? "").filter(Boolean);
  const main = all.reduce((a, x) => (x.length > a.length ? x : a), "");
  const now = current?.trim() ?? "";
  const cut = (x: string) => (x.length > cap ? `${x.slice(0, cap)} […]` : x);
  return [main, now && now !== main ? `Then, this turn: ${now}` : ""].filter(Boolean).map(cut).join("\n\n");
}

/**
 * The skills whose checklists the critic checks: all of them. D297 let the motion film's checklist
 * win over the others, whose rules its creative ones contradicted; since the ablations cut the film
 * to honesty and measured defects there is nothing left to contradict.
 */
export function criticSkills<S extends { readonly id: string }>(skills: ReadonlyArray<S>): ReadonlyArray<S> {
  return skills;
}

/** D297: what the critic hears when the scan couldn't run (rehearsal 3 marked motion down for it). */
export const UNMEASURED =
  "That's Uncut's problem, not the video's: don't mark anything down for what the scan would have measured (pops, holds, the seam); judge timing only from the strips and frames you have, and say what you couldn't check.";

/** D295: storyboard_propose renders at most this many stills, this wide. */
export const MAX_STILLS = 4;
const STILL_WIDTH = 480;

export const makeCardTools = (ctx: GenerateCtx) => {
  const { persist, publish, config, textResult, askUser, exporter } = ctx;

  // ---- the production process (U7–U9, U15–U17, U19; D186–D191) ----

  /** A card in the turn's history (D186–D190): the question and its answer, the brief, the storyboard, a review. */
  const addCard = (r: Running, card: AgentCard, text: string) => {
    r.turn.items.push({ kind: "card", text: text.slice(0, 300), card });
    persist(r.owner);
    publish();
  };
  // D232: the allowed plugins' skills come along (Uncut's own are the bundled uncut.skills).
  const brandDirs = (v: ProjectView) => ({ dataDir: config.dataDir, projectDir: v.dir, skills: ctx.plugins.skillsNow() });
  const refreshPlan = (r: Running, v: ProjectView) => Effect.promise(async () => (r.owner.plan = await readPlan(v.dir)));

  /** ask_user (D187): a question card; waits for the answer (QUESTION_MS). */
  const askUserTool = (r: Running, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const q = questionOf(args);
      if ("problem" in q) return textResult(q.problem, true);
      let got: AgentAnswer | undefined;
      const a = yield* askUser(
        r,
        q.question,
        0,
        undefined,
        (_card, answer, _source, extra) => {
          if (answer === "allow") got = extra?.answer;
        },
        undefined,
        { question: q },
      );
      const outcome = a === "allow" ? "answered" : a === "deny" ? "skipped" : a;
      const out = answerOut(q, outcome, got);
      if ("choices" in out && out.choices) r.picked.push(...out.choices);
      addCard(
        r,
        {
          type: "question",
          question: q,
          ...("choices" in out || "text" in out
            ? { answer: { choices: "choices" in out ? (out.choices ?? []) : [], ...("text" in out && out.text ? { text: out.text } : {}) } }
            : {}),
          outcome: out.answered ? "answered" : "skipped",
        },
        q.question,
      );
      return textResult(out);
    });

  /** brief_write (D188): brief.json, a Brief card. */
  const briefWrite = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const raw = normBrief(args);
      if (!raw || !raw.film.trim())
        return textResult(
          "film is the video in one sentence; write the whole brief (film, audience, duration, formats, assets, visual, hardLines, deliverables).",
          true,
        );
      if (args.type !== undefined && !isVideoType(args.type)) return textResult(`type is one of ${VIDEO_TYPES.join(", ")}.`, true);
      // D217: the type (the agent's, else what the brief's words say) and the suggested skills (the
      // agent's, else Uncut's for the type); suggestions only.
      const type = raw.type ?? guessVideoType(raw);
      const hasKit = yield* Effect.promise(() =>
        readBrand(brandDirs(v))
          .then((b) => !!b.active.kit)
          .catch(() => false),
      );
      const brief: Brief = {
        ...raw,
        ...(type ? { type } : {}),
        skills: raw.skills?.length ? raw.skills : suggestSkills({ ...raw, ...(type ? { type } : {}) }, { hasKit }),
      };
      const saved = yield* Effect.tryPromise({ try: () => writeBrief(v.dir, { ...brief, by: "agent" }), catch: (e) => e as Error }).pipe(
        Effect.map((b) => ({ ok: true as const, b })),
        Effect.catch((e) => Effect.succeed({ ok: false as const, message: e.message })),
      );
      if (!saved.ok) return textResult(`Couldn't save the brief: ${saved.message}`, true);
      // D237: this turn is planning the video, so its build waits for the storyboard.
      r.planned = true;
      yield* refreshPlan(r, v);
      addCard(r, { type: "brief", brief: saved.b }, brief.film);
      const sb = r.owner.plan.storyboard;
      // D232 (issue #60): nobody picks skills. The brief suggests the ones that fit; the agent reads
      // them with skill_read (which marks them used, so the critic follows them).
      const skills = yield* Effect.promise(async () => {
        try {
          const all = await readBrand(brandDirs(v));
          const suggested = (saved.b.skills ?? []).flatMap((id) => all.skills.filter((x) => x.id === id));
          const used = all.skills.filter((x) => all.active.skills.includes(x.id));
          return { suggested, used };
        } catch (error) {
          console.error(`[uncut] couldn't read the skills of ${v.dir}: ${(error as Error).message}`);
          return undefined;
        }
      });
      const rubric = yield* rubricOf(v, r);
      const skillsOut = skills
        ? {
            type: saved.b.type ?? "none (judged as a short product video)",
            suggestedSkills: skills.suggested.filter((x) => !skills.used.some((u) => u.id === x.id)).map((x) => ({ id: x.id, name: x.name })),
            skills: skills.used.map((x) => ({ id: x.id, name: x.name })),
            skillsNote: `${skills.suggested.some((x) => !skills.used.some((u) => u.id === x.id)) ? "Read each suggested skill that fits with skill_read before you build (no need to ask the user; leave out one the brief says it doesn't want, like motion graphics or sound design). " : ""}Follow the rules of the skills this project uses where the user's own direction doesn't decide; the critic checks their review checklists.`,
            rubric: Object.fromEntries(Object.entries(rubric.levels).map(([k, l]) => [k, l === "na" ? "not scored" : l])),
            sound: soundProfileText(rubric.sound),
          }
        : {};
      return textResult({
        saved: "brief.json",
        ...skillsOut,
        next:
          sb?.status === "approved"
            ? "The storyboard is approved: if the brief changed what it shows, propose it again with storyboard_propose."
            : "Now propose the storyboard with storyboard_propose; build once the user approves it.",
      });
    });

  /**
   * D217: the critic's rubric for the open project: its brief, its active skills, whether it has a
   * kit, and the user's own words (a "music only" there sets the sound profile over a skill's default).
   */
  const rubricOf = (v: ProjectView, r?: Running) =>
    Effect.promise(async () => {
      const plan = await readPlan(v.dir).catch(() => ({ reviews: [] }) as AgentPlan);
      const active = await readBrand(brandDirs(v))
        .then((b) => b.active)
        .catch(() => ({ kit: null, skills: [] as ReadonlyArray<string> }));
      const request = r
        ? userRequest(
            r.owner.turns.map((t) => t.prompt),
            r.turn.prompt,
          )
        : undefined;
      return reviewRubric(plan.brief, { skills: active.skills, hasKit: !!active.kit, ...(request ? { request } : {}) });
    });

  /** storyboard_propose (D188): saved as proposed, then a card the user approves (maybe editing beats) or sends back. */
  /** A still asked for: a timeline frame, or a graphic file and a moment of it (seconds). */
  const stillOf = (f: unknown): { readonly frame: number } | { readonly graphic: string; readonly t: number } | undefined => {
    if (typeof f === "number") return Number.isInteger(f) && f >= 0 ? { frame: f } : undefined;
    const o = f as { graphic?: unknown; t?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.graphic !== "string") return undefined;
    const src = o.graphic.startsWith("graphics/") ? o.graphic : `graphics/${o.graphic}`;
    const t = typeof o.t === "number" && Number.isFinite(o.t) && o.t >= 0 ? o.t : 0;
    return GRAPHIC_SRC.test(src) ? { graphic: src, t } : undefined;
  };
  /**
   * The stills in the order asked: timeline frames from the project as it is; a graphic's moment
   * from the project with that graphic alone on one track (its canvas and media, nothing placed).
   */
  const renderStills = (
    project: Project,
    stills: ReadonlyArray<{ readonly frame: number } | { readonly graphic: string; readonly t: number }>,
    width: number,
  ) =>
    Effect.gen(function* () {
      const out: Array<{ jpeg: Buffer }> = new Array(stills.length);
      const frames = stills.flatMap((s, k) => ("frame" in s ? [[k, s.frame] as const] : []));
      if (frames.length)
        (yield* exporter.renderFrames(
          frames.map(([, f]) => f),
          width,
        )).forEach((r, j) => (out[frames[j]![0]] = r));
      const fps = project.canvas.fps;
      for (const [k, s] of stills.entries()) {
        if ("frame" in s) continue;
        const at = Math.round(s.t * fps);
        const alone = {
          ...project,
          tracks: [
            { id: "still", kind: "video", name: "Still", items: [{ id: "still-graphic", type: "graphic", src: s.graphic, start: 0, duration: at + 1 }] },
          ],
        } as unknown as Project;
        const got = yield* exporter.renderFrames([at], width, alone);
        if (!got[0]) return yield* Effect.fail(new Error(`${s.graphic} at ${s.t} s drew nothing`));
        out[k] = got[0];
      }
      return out;
    });

  const storyboardPropose = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const raw = Array.isArray(args.beats) ? args.beats : [];
      // D295: a beat's still is a timeline frame; Uncut renders it and the card shows it with the beat.
      // Or a graphic file and a moment of it ({ graphic, t }), drawn alone without placing it, so
      // the user sees the look before the film is built.
      const asked = raw.map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>).still : undefined));
      const beats = normBeats(raw.map((b) => (b && typeof b === "object" ? { ...(b as Record<string, unknown>), still: undefined } : b)));
      if (!beats.length) return textResult("beats is the shot list: each {start, end (seconds), title, entry, exit, purpose, assets, sound}.", true);
      const summary = typeof args.summary === "string" ? args.summary.trim().slice(0, 600) : "";
      const all = asked.flatMap((f, i) => (f === undefined ? [] : [[i, f] as const]));
      const bad = all.find(([, f]) => !stillOf(f));
      if (bad)
        return textResult(
          `beats[${bad[0]}].still must be a timeline frame (an integer from 0) or a graphic and a moment of it: {"graphic":"film.html","t":12.5} (drawn alone, not placed).`,
          true,
        );
      // More than MAX_STILLS: the first ones are drawn and the rest left out, said in the answer (a note, not a refusal).
      const wanted = all.slice(0, MAX_STILLS);
      const skipped = all.slice(MAX_STILLS).map(([i]) => i + 1);
      const stillNote = skipped.length
        ? {
            stills: `Drew the first ${MAX_STILLS} stills; beat${skipped.length === 1 ? "" : "s"} ${skipped.join(", ")} asked for one too and ${skipped.length === 1 ? "was" : "were"} left out (${MAX_STILLS} at most: the open, the drop, the busiest state and the last frame).`,
          }
        : {};
      // Round 2's A2: approve "self" is for a run in Auto where nobody can answer, on a first proposal
      // nobody answered. Refused before anything renders or locks the edit (review of r3).
      if (args.approve === "self") {
        if (r.access !== "auto")
          return textResult(
            `approve "self" is for a run in Auto where nobody can answer; this chat is set to ${r.access === "look" ? "Look only" : "Ask first"}, so the user is here to approve it: propose it without approve.`,
            true,
          );
        const sb = r.owner.plan.storyboard;
        if (r.storyboardSentBack || (sb?.status === "declined" && sb.note))
          return textResult(
            `approve "self" is only for a first proposal nobody answered; the user sent the storyboard back${sb?.status === "declined" && sb.note ? ` ("${sb.note}")` : ""}, so they're here to approve it: change it as asked and propose it again without approve.`,
            true,
          );
      }
      // D296: from here the proposal locks the edit (run.ts): the stills render from this state and
      // the user approves what they see. Set before rendering, so a parallel edit can't slip in.
      r.planned = true;
      r.proposing = true;
      if (wanted.length) {
        const canvas = v.session.project.canvas;
        const width = Math.min(canvas.width, STILL_WIDTH);
        const rendered = yield* renderStills(
          v.session.project,
          wanted.map(([, f]) => stillOf(f)!),
          width,
        ).pipe(
          Effect.map((list) => ({ ok: true as const, list })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, message: (error as Error).message })),
        );
        if (!rendered.ok) {
          r.proposing = false;
          return textResult(`Couldn't render the stills: ${rendered.message}. Fix that, or propose without still.`, true);
        }
        r.stills = (r.stills ?? 0) + 1;
        const folder = join(v.dir, ".cache", "agent-images");
        const names = yield* Effect.promise(async () => {
          try {
            await mkdir(folder, { recursive: true });
            const out: Array<string> = [];
            for (const [k, frame] of rendered.list.entries()) {
              const name = `${r.turn.id}-s${r.stills! % 100}-${k}.jpg`;
              await writeFile(join(folder, name), frame.jpeg);
              out.push(name);
            }
            return out;
          } catch (error) {
            console.error(`[uncut] couldn't keep the storyboard stills in ${folder}: ${(error as Error).message}`);
            return [] as Array<string>;
          }
        });
        names.forEach((name, k) => {
          const i = wanted[k]![0];
          if (beats[i]) beats[i] = { ...beats[i]!, still: name };
        });
      }
      const write = (sb: Storyboard) =>
        Effect.promise(() => writeStoryboard(v.dir, sb).catch((e: Error) => (console.error(`[uncut] couldn't save the storyboard: ${e.message}`), sb)));
      r.planned = true;
      // Round 2's A2: a prompt that says nobody can answer ("decide yourself") approves its own
      // storyboard, shown as such on the card, rather than skipping it (and the critic with it).
      if (args.approve === "self") {
        r.proposing = false;
        const sb = yield* write({ summary, beats, status: "approved", approvedBy: "agent" });
        yield* refreshPlan(r, v);
        addCard(r, { type: "storyboard", storyboard: sb, outcome: "self" }, summary || "Storyboard");
        return textResult({
          ...stillNote,
          approved: true,
          by: "you",
          message:
            "Approved by you (the user said they can't answer); say so in your reply. Build it scene by scene, then run the critic loop as always: review_submit before you end (the critic never needs the user).",
        });
      }
      if (r.skipStoryboard) {
        r.proposing = false;
        const sb = yield* write({ summary, beats, status: "approved", approvedBy: "setting" });
        yield* refreshPlan(r, v);
        addCard(r, { type: "storyboard", storyboard: sb, outcome: "auto" }, summary || "Storyboard");
        return textResult({
          ...stillNote,
          approved: true,
          by: "setting",
          message: "Approved by the user's setting (Auto skips the storyboard approval). Build it scene by scene.",
        });
      }
      const proposed = yield* write({ summary, beats, status: "proposed" });
      yield* refreshPlan(r, v);
      let extra: CardAnswer | undefined;
      const a = yield* askUser(
        r,
        summary || "Storyboard",
        0,
        undefined,
        (_card, _a, _s, x) => {
          extra = x;
        },
        undefined,
        { storyboard: proposed },
      );
      // D296: approved or sent back, the edit is free again; unanswered, it stays locked for the turn.
      if (a === "allow" || a === "deny") r.proposing = false;
      if (a === "allow") {
        const edited = extra?.beats ? normBeats(extra.beats) : [];
        const final = yield* write({ summary, beats: edited.length ? edited : beats, status: "approved", approvedBy: "user" });
        yield* refreshPlan(r, v);
        addCard(r, { type: "storyboard", storyboard: final, outcome: "approved" }, summary || "Storyboard");
        return textResult({
          ...stillNote,
          approved: true,
          ...(edited.length
            ? { edited: true, beats: final.beats, message: "The user edited the beats: build these." }
            : {
                message:
                  "Approved as the stills show it. Build it scene by scene to match them; keep the copy, logo and end card they show (to change those, propose again).",
              }),
        });
      }
      if (a === "deny") {
        r.storyboardSentBack = true;
        const note = extra?.note?.trim().slice(0, 2000) ?? "";
        const final = yield* write({ summary, beats, status: "declined", ...(note ? { note } : {}) });
        yield* refreshPlan(r, v);
        addCard(r, { type: "storyboard", storyboard: final, outcome: "declined" }, summary || "Storyboard");
        return textResult({
          ...stillNote,
          approved: false,
          ...(note ? { change: note } : {}),
          next: note
            ? "Change the storyboard as asked and propose it again; don't build until it's approved."
            : "The user didn't approve it and said nothing: ask what to change (ask_user); don't build.",
        });
      }
      addCard(r, { type: "storyboard", storyboard: proposed, outcome: "skipped" }, summary || "Storyboard");
      return textResult(
        {
          approved: false,
          message: a === "stopped" ? "The turn was stopped." : "Nobody answered in 15 minutes.",
          next: "Don't build or edit (timeline_edit, graphic_write and shader_write are refused for the rest of this turn). End the turn now saying the storyboard waits for approval on the Plan card.",
        },
        a !== "timeout",
      );
    });

  /**
   * D196: what the edit looks like now: its revision, the graphic files written in this turn and the
   * graphics folder's newest change (a graphic edited with Claude Code's own Write or Edit too).
   */
  const stampOf = (r: Running, v: ProjectView) => {
    let newest = 0;
    try {
      const dir = join(v.dir, "graphics");
      for (const name of readdirSync(dir)) newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
    } catch {}
    return `${v.session.revision}/${r.graphicWrites}/${newest}`;
  };

  /**
   * review_submit (D189, D195, D196): a review round by Uncut's critic, never the agent's own
   * scores. The agent must have looked (a contact sheet and phone-size frames) and, for each fix it
   * claims, rendered that moment after its last change. Uncut checks graphics draw the same twice,
   * runs the layout checks, renders the evidence itself at this revision and asks a separate claude
   * (agentCritic.ts) that sees only those frames, the brief, the kit, the storyboard and the rubric.
   */
  const reviewSubmit = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      if (!r.looked.sheet || !r.looked.phone) {
        // Round 4's A1: a refusal says what is missing, what is already done and that nothing counted.
        const sheet = "contact_sheet with no media argument (the whole edit)";
        const phone = "render_frames with phone true (frame 0, the first 2 s and each beat's last frame)";
        const missing = [!r.looked.sheet ? sheet : "", !r.looked.phone ? phone : ""].filter(Boolean).join(" and ");
        const done = r.looked.sheet ? ` Already done: ${sheet.split(" (")[0]}.` : r.looked.phone ? ` Already done: ${phone.split(" (")[0]}.` : "";
        return textResult(
          `Look before you ask for a review: each round starts from the edit as it is now, so first run ${missing}${r.reviewRounds ? ` (not done since round ${r.reviewRounds})` : ""}.${done} Then call review_submit again with the same fixes; this call didn't reach the critic and doesn't count as a round.`,
          true,
        );
      }
      // Rehearsal 4: a ceiling, not a fixed count: past REVIEW_ROUNDS only while it converges (reviewOutlook says why).
      const turnReviews = () => r.owner.plan.reviews.filter((x) => x.turnId === r.turn.id);
      // A hard ceiling on the turn's own count too: a review that couldn't be saved isn't in the plan.
      const outlook = reviewOutlook(turnReviews(), r.reviewRounds);
      if (!outlook.more)
        return textResult(`No more review rounds in this turn (${outlook.why}): stop fixing and tell the user what the critic still found.`, true);
      const project = v.session.project as Project;
      const fps = project.canvas.fps;
      const { starts, duration } = layout(project);
      if (!project.tracks.some((t) => t.items.length) || duration <= 0) return textResult("The timeline is empty: there's nothing to review yet.", true);
      const stamp = stampOf(r, v);
      if (r.reviewedStamp === stamp)
        return textResult(
          `Nothing changed since round ${r.reviewRounds}: fix what the critic found (timeline_edit, graphic_write), look at the fixed moments, then review_submit again.`,
          true,
        );
      // The fix claims: ids from the last round, each moment rendered after the last change.
      const prev = r.owner.plan.reviews.at(-1);
      const findings = prev ? [...(prev.blockers ?? []), ...prev.defects] : [];
      const claims: Array<CriticClaim> = [];
      for (const raw of Array.isArray(args.fixes) ? args.fixes.slice(0, 10) : []) {
        const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const defect = typeof o.defect === "string" ? o.defect.trim() : "";
        const what = typeof o.what === "string" ? o.what.trim().slice(0, 300) : "";
        if (!defect || !what) return textResult("Each fix is {defect: an id from the last review (d1, d2, …), what: what you changed}.", true);
        const found = findings.find((x) => x.id === defect);
        if (!found)
          return textResult(
            `There's no ${defect} in the last review${
              findings.length
                ? ` (its ids: ${findings
                    .map((x) => x.id)
                    .filter(Boolean)
                    .join(", ")})`
                : ""
            }.`,
            true,
          );
        claims.push({ defect, what, ...(found.at !== undefined ? { at: found.at } : {}), was: found.what, ...(found.fix ? { fix: found.fix } : {}) });
      }
      const near = (at: number) => [Math.max(0, Math.round((at - 0.5) * fps)), Math.round((at + 0.5) * fps)] as const;
      const unseen = claims.filter((c) => {
        if (c.at === undefined) return false;
        const [lo, hi] = near(c.at);
        return !r.rendered.some((x) => x.stamp === stamp && x.frames.some((f) => f >= lo && f <= hi));
      });
      if (unseen.length) {
        return textResult(
          `Look at each fix before you claim it: render_frames a frame of ${unseen.map((c) => `${c.defect} (at ${c.at} s, frames ${near(c.at!).join(" to ")})`).join(", ")} after your last change, and check the defect is really gone. Frames rendered before the change don't count.`,
          true,
        );
      }
      // Determinism (D189): each graphic's middle frame in the round's session and once more in a
      // separate one; the same JPEG twice or it differed.
      const graphics = project.tracks
        .filter((t) => !t.hidden)
        .flatMap((t) => t.items.filter((i) => i.type === "graphic" && typeof i.src === "string"))
        .slice(0, 4);
      const twiceOf = graphics.map((g) => ({ name: g.name ?? g.src!.replace(/^graphics\//, ""), frame: (starts.get(g.id) ?? 0) + Math.floor(g.duration / 2) }));
      const sha = (jpeg: Buffer) => createHash("sha256").update(jpeg).digest("hex");
      const hashes = (session: FrameSessionShape) =>
        Effect.forEach(twiceOf, (x) =>
          session.render([x.frame], 480).pipe(
            Effect.map((a) => sha(a[0]!.jpeg)),
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        );
      // The evidence, rendered by Uncut at this revision: a contact sheet, phone-size frames, each claimed fix's moment.
      const last = duration - 1;
      const clampF = (f: number) => Math.max(0, Math.min(last, Math.round(f)));
      const sb = r.owner.plan.storyboard;
      const phoneFrames = [...new Set([0, clampF(2 * fps), ...(sb?.beats ?? []).map((b) => clampF(b.end * fps - 1)), last])].sort((a, b) => a - b).slice(0, 8);
      const phoneWidth = Math.max(64, Math.round(project.canvas.width * Math.min(1, PHONE_WIDTH / project.canvas.width)));
      const fixFrames = claims.flatMap((c) => (c.at === undefined ? [] : [{ defect: c.defect, frame: clampF(c.at * fps) }])).slice(0, 6);
      const sheetCells = sheetFrames(0, duration, undefined, 16);
      const brand = yield* Effect.promise(() =>
        activeBrand(brandDirs(v)).catch(
          () =>
            ({ files: {} as Record<string, string>, skills: [] as Array<BrandSkill> }) as {
              kit?: BrandKit;
              files: Record<string, string>;
              skills: Array<BrandSkill>;
            },
        ),
      );
      // D292: motion over time: a frame strip per scene change and a frame-difference scan (pops,
      // one-frame jumps, holds, the loop seam), as images and facts for the critic and findings for the agent.
      const hasFootage = project.tracks.some((t) => !t.hidden && t.items.some((i) => i.type === "clip"));
      const intent = motionIntent({
        skills: brand.skills.map((x) => x.id),
        words: [
          r.owner.plan.brief?.film,
          r.owner.plan.brief?.visual,
          r.owner.plan.brief?.notes,
          ...(r.owner.plan.brief?.assets ?? []),
          ...(r.owner.plan.brief?.hardLines ?? []),
        ]
          .filter(Boolean)
          .join("\n"),
        hasFootage,
        request: userRequest(
          r.owner.turns.map((t) => t.prompt),
          r.turn.prompt,
        ),
      });
      const anchors = motionAnchors(sb?.beats, fps, duration);
      const strips = stripPlan(anchors, fps, duration);
      const scanList = scanPlan(anchors, fps, duration);
      const aspect = project.canvas.width / project.canvas.height;
      // The project's motion blur on a graphic (its setting, else on as Standard and High export it;
      // the quality is picked at export time): its fast moves get blurred frames.
      const blurred =
        motionBlurDefault(project, "high") && project.tracks.some((t) => !t.hidden && t.items.some((i) => i.type === "graphic" && i.motionBlur !== false))
          ? projectMotionBlur(project)
          : undefined;
      // D292: one frame session for the round (one rasteriser, the plan once per width), small
      // frames captured small; the strips' and the scan's frames rendered once, under a time budget.
      const rendered = yield* exporter
        .frameSession(
          (session) =>
            Effect.gen(function* () {
              const mine = yield* hashes(session);
              const evidence = yield* Effect.gen(function* () {
                const cells = "refused" in sheetCells ? [0] : [...sheetCells];
                const list = yield* session.render(cells, CELL_WIDTH, { census: true });
                const sheet = yield* session.sheet(
                  list.map((f, i) => ({ jpeg: f.jpeg, caption: `${i + 1}   f ${f.frame}   ${clock(f.frame / fps)}` })),
                  sheetLayout(list.length, aspect),
                );
                const phone = yield* session.render(phoneFrames, phoneWidth);
                // Each claimed fix's frame measured too: a blocker's hint names what softens the words there
                // (T4-keynote's Export card, 0.08 s into a swap at the claimed 22.6 s, three rounds).
                const fixed = fixFrames.length
                  ? yield* session.render(
                      fixFrames.map((x) => x.frame),
                      Math.min(project.canvas.width, 720),
                      { census: true },
                    )
                  : [];
                const censusOfFrame = (f: (typeof list)[number]) => ({
                  frame: f.frame,
                  ...(f.small ? { small: f.small } : {}),
                  ...(f.measured !== undefined ? { measured: f.measured } : {}),
                  ...(f.unseen ? { unseen: f.unseen } : {}),
                  ...(f.soft ? { soft: f.soft } : {}),
                });
                return {
                  ok: true as const,
                  sheet,
                  shown: list.map((f) => f.frame),
                  census: list.map(censusOfFrame),
                  fixCensus: fixed.map(censusOfFrame),
                  phone,
                  fixed,
                };
              }).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })));
              if (!evidence.ok) return { mine, evidence, motion: { images: [] as Array<CriticImage>, scan: undefined } };
              const motion = yield* Effect.gen(function* () {
                const got = yield* Effect.tryPromise({
                  try: (signal) =>
                    motionFrames({
                      strips,
                      scanList,
                      anchors,
                      duration,
                      render: (frames, until) => Effect.runPromise(session.render(frames, scanRenderWidth(project.canvas), { until }), { signal }),
                    }),
                  catch: (e) => e as Error,
                });
                const stripImages: Array<CriticImage> = [];
                for (const st of strips) {
                  const cells = st.frames.flatMap((f) => (got.byFrame.has(f) ? [{ jpeg: got.byFrame.get(f)!, caption: `f ${f}   ${clock(f / fps)}` }] : []));
                  if (!cells.length) continue;
                  const jpeg = yield* session.sheet(cells, stripLayout(cells.length, aspect));
                  stripImages.push({
                    label: `frame strip around ${st.label} (f ${st.at}, ${(st.at / fps).toFixed(2)} s): frames ${st.frames.join(", ")} left to right, ${Math.round(1000 / 12)} ms apart`,
                    jpeg,
                  });
                }
                let scan: MotionScan | undefined;
                let drop: string | undefined;
                const flat: Array<FlatStrip> = [];
                const ffmpeg = yield* Effect.promise(async () => (await config.shellReady, which("ffmpeg", process.env.PATH ?? "")));
                // The scan's grey frames from the strips' size (grayFrames scales them to SCAN_WIDTH).
                const { w, h } = scanSize(project.canvas);
                if (ffmpeg && got.scanned.length > 2) {
                  // Review of 72a73b9: emptiness is judged on larger grey frames (EMPTY_WIDTH) than the differences.
                  const big = emptySize(project.canvas);
                  // And how much each frame says (low-information frames) at the strips' own size (wider for a landscape canvas).
                  const fine = thinSize(project.canvas);
                  // D306: with each pixel's colour (cuts between footage shots) and the fine grey itself (typing).
                  const decode = async (jpegs: ReadonlyArray<Buffer>, sig: AbortSignal) => {
                    const [gs, bs, ts, cs] = await Promise.all([
                      grayFrames(ffmpeg, jpegs, w, h, sig),
                      grayFrames(ffmpeg, jpegs, big.w, big.h, sig),
                      grayFrames(ffmpeg, jpegs, fine.w, fine.h, sig),
                      chromaFrames(ffmpeg, jpegs, w, h, sig),
                    ]);
                    return gs.map((gray, i) => ({
                      gray,
                      bare: emptyMeasure(bs[i]!, big.w, big.h),
                      info: thinMeasure(ts[i]!, fine.w, fine.h),
                      fine: ts[i]!,
                      chroma: cs[i]!,
                    }));
                  };
                  const decoded = yield* Effect.tryPromise({
                    try: (signal) =>
                      decode(
                        got.scanned.map((f) => got.byFrame.get(f)!),
                        AbortSignal.any([signal, r.abort.signal]),
                      ),
                    catch: (e) => e as Error,
                  });
                  const grays = decoded.map((x) => x.gray);
                  const sampled: Array<ScanFrame> = got.scanned.map((f, i) => ({ frame: f, ...decoded[i]! }));
                  // A1: a cut between two sampled frames, narrowed down to the frame it happens on;
                  // rehearsal 4: and each nearly empty stretch's exact edges, each on its own time budget.
                  const refined =
                    scanList.length === duration
                      ? []
                      : yield* Effect.tryPromise({
                          try: async (signal) => {
                            const sig = AbortSignal.any([signal, r.abort.signal]);
                            const phase = (ms: number) => {
                              const deadline = Date.now() + ms;
                              const until = () => Date.now() > deadline || sig.aborted;
                              const render = async (frames: ReadonlyArray<number>): Promise<Array<ScanFrame>> => {
                                const shot = await Effect.runPromise(
                                  session.render(frames, scanRenderWidth(project.canvas), { until: () => Date.now() > deadline }),
                                  { signal: sig },
                                );
                                const ds = await decode(
                                  shot.map((x) => x.jpeg),
                                  sig,
                                );
                                return shot.map((x, i) => ({ frame: x.frame, ...ds[i]! }));
                              };
                              return { until, render };
                            };
                            const jumps = await refineJumps({ frames: sampled, fps, duration, ...phase(REFINE_BUDGET_MS) });
                            const edges = await refineEmpty({
                              frames: [...sampled, ...jumps],
                              fps,
                              size: { w, h },
                              duration,
                              ...phase(REFINE_EMPTY_BUDGET_MS),
                            });
                            return [...jumps, ...edges];
                          },
                          catch: (e) => e as Error,
                        }).pipe(Effect.catch(() => Effect.succeed([] as Array<ScanFrame>)));
                  scan = motionScan([...sampled, ...refined], fps, { size: { w, h }, fine });
                  // Rehearsal 3: the reveal landed before the drop; say what changes on each side of it.
                  const di = dropBeat(sb?.beats);
                  if (di !== undefined)
                    drop = dropLine(
                      got.scanned.map((f, i) => ({ frame: f, gray: grays[i]! })),
                      clampF(sb!.beats[di]!.start * fps),
                      fps,
                    );
                }
                // Round 2's A1: the fast moves as the export draws them, with its motion blur (the
                // critic otherwise sees only sharp frames, so ghosting and smeared edges never show).
                if (scan?.fast.length && blurred) {
                  for (const run of blurPicks(scan.fast)) {
                    const shot = yield* session
                      .render(run.frames, BLUR_CELL, { motionBlur: true })
                      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ frame: number; jpeg: Buffer }>)));
                    if (!shot.length) continue;
                    const jpeg = yield* session
                      .sheet(
                        shot.map((f) => ({ jpeg: f.jpeg, caption: `f ${f.frame}   ${clock(f.frame / fps)}   blur` })),
                        stripLayout(shot.length, aspect, BLUR_CELL),
                      )
                      .pipe(Effect.catch(() => Effect.succeed(undefined)));
                    if (jpeg)
                      stripImages.push({
                        label: blurStripLabel(
                          run,
                          fps,
                          blurred,
                          shot.map((f) => f.frame),
                          project.motionBlur?.on === true,
                        ),
                        jpeg,
                      });
                  }
                }
                // D296: how much of each strip's frames is flat background (the median of its frames).
                const stripFrames = [...new Set(strips.flatMap((st) => st.frames.filter((f) => got.byFrame.has(f))))];
                if (ffmpeg && stripFrames.length) {
                  const grays = yield* Effect.tryPromise({
                    try: (signal) =>
                      grayFrames(
                        ffmpeg,
                        stripFrames.map((f) => got.byFrame.get(f)!),
                        w,
                        h,
                        AbortSignal.any([signal, r.abort.signal]),
                      ),
                    catch: (e) => e as Error,
                  });
                  const share = new Map(stripFrames.map((f, i) => [f, flatFraction(grays[i]!, w, h)]));
                  const canvas = new Map(stripFrames.map((f, i) => [f, canvasShare(grays[i]!, w, h)]));
                  for (const st of strips) {
                    const xs = st.frames.flatMap((f) => (share.has(f) ? [share.get(f)!] : [])).sort((a, b) => a - b);
                    const cs = st.frames.flatMap((f) => (canvas.has(f) ? [canvas.get(f)!] : [])).sort((a, b) => a.share - b.share);
                    const mid = cs[cs.length >> 1];
                    if (xs.length)
                      flat.push({ label: st.label, at: st.at, flat: xs[xs.length >> 1]!, ...(mid ? { canvas: mid.share, level: mid.level } : {}) });
                  }
                }
                const jitter = ffmpeg ? yield* fineJitter(session, ffmpeg, anchors, project.canvas, fps, duration, r.abort.signal) : [];
                return { images: stripImages, scan, flat, drop, planned: got.planned, scanned: got.scanned.length, cut: got.cut, jitter };
              }).pipe(Effect.catch((error) => Effect.succeed({ images: [] as Array<CriticImage>, scan: undefined, problem: (error as Error).message })));
              // Round 2's A2: the export's graphics run as the export runs them (every frame in order,
              // motion blur's sub-frames, the same page), so a graphic that only breaks on a long run
              // fails the round instead of the export.
              const rehearsal = yield* session.rehearse(REHEARSE_REVIEW_MS).pipe(Effect.catch(() => Effect.succeed(undefined)));
              return { mine, evidence, motion, rehearsal };
            }),
          { downscale: true },
        )
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({
              mine: [] as Array<string | undefined>,
              evidence: { ok: false as const, message: error.message },
              motion: { images: [] as Array<CriticImage>, scan: undefined },
            }),
          ),
        );
      const { evidence, motion } = rendered;
      const rehearsal = "rehearsal" in rendered ? rendered.rehearsal : undefined;
      if (!evidence.ok) return textResult(`Couldn't render the frames for the critic: ${evidence.message}`, true);
      // The second render of each graphic, in a session of its own.
      const theirs = twiceOf.length
        ? yield* exporter.frameSession(hashes, { downscale: true }).pipe(Effect.catch(() => Effect.succeed([] as Array<string | undefined>)))
        : [];
      const checked: Array<string> = [];
      const differed: Array<string> = [];
      twiceOf.forEach((x, i) => {
        const a = rendered.mine[i];
        const b = theirs[i];
        if (a === undefined || b === undefined) return;
        checked.push(x.name);
        if (a !== b) differed.push(x.name);
      });
      const images: Array<CriticImage> = [
        {
          label: `contact sheet of the whole video, ${evidence.shown.length} cells left to right, top to bottom, each captioned with its number, frame and time (frames ${evidence.shown.join(", ")})`,
          jpeg: evidence.sheet,
        },
        ...evidence.phone.map((f) => {
          // D296: a beat's last frame carries the words the storyboard says that beat shows.
          const beat = (sb?.beats ?? []).findIndex((b) => clampF(b.end * fps - 1) === f.frame);
          const words = beat >= 0 ? beatWords(sb!.beats[beat]!) : [];
          return {
            label: `frame ${f.frame} (${(f.frame / fps).toFixed(2)} s) at ${phoneWidth} px wide, as on a phone in a feed${words.length ? `; the last frame of storyboard beat ${beat + 1}, which says it shows ${words.map((w) => `"${w}"`).join(", ")}` : ""}`,
            jpeg: f.jpeg,
          };
        }),
        ...evidence.fixed.map((f, i) => ({
          label: `frame ${f.frame} (${(f.frame / fps).toFixed(2)} s), the moment of claimed fix ${fixFrames[i]!.defect}, rendered after the fix`,
          jpeg: f.jpeg,
        })),
      ];
      // Uncut's layout checks (D196) and the safe-area ones, as facts.
      // D207: and the sound rule (density and level fail a round as "sound" blockers; the rest the critic confirms).
      const keep = new Set(["text-edge", "small-text", "sound"]);
      // D198: a font that isn't there is a hard finding too (a "font" blocker).
      const fontCheck = yield* fontsRule(v);
      // D217: the rubric (the brief's type, the active skills, a kit) sets the sound profile; density
      // and level fail a round only under the strict one. Findings the user marked Intended stay out.
      const rubric = yield* rubricOf(v, r);
      const intended = r.owner.plan.intended ?? [];
      const checks: Array<CriticFinding> = projectChecks(project, {
        rules: [...LAYOUT_RULES, fontCheck],
        disabled: CHECK_IDS.filter((id) => !keep.has(id)),
        sound: rubric.sound,
      }).map((c) => ({
        rule: c.id,
        key: c.key,
        message: c.message,
        ...(c.frame !== undefined ? { frame: c.frame } : {}),
        ...(c.range ? { range: c.range } : {}),
        hard: LAYOUT_HARD.has(c.id) || FONT_ERRORS.has(c.id) || (c.id === "sound" && soundHard(c.key, rubric.sound)),
      }));
      images.push(...motion.images);
      const flatStrips = "flat" in motion ? (motion.flat ?? []) : [];
      // Why there's no scan without an error: no ffmpeg, or too few frames rendered to compare.
      const scanMissing = yield* Effect.promise(async () =>
        (await which("ffmpeg", process.env.PATH ?? "")) ? "too few frames were rendered to compare" : "ffmpeg isn't on PATH",
      );
      // A motion film (one take, or graphics over half the timeline): one still frame over STILL_MAX_S is a finding.
      const graphicFrames = project.tracks
        .filter((t) => !t.hidden)
        .flatMap((t) => t.items)
        .filter((i) => i.type === "graphic")
        .reduce((n, i) => n + i.duration, 0);
      const motionFilm = intent.oneTake || graphicFrames * 2 >= duration;
      // D306: the timeline's straight cuts between clips are footage cuts; when the user asked for the
      // footage cut on the beat, only their own one-take words make the other cuts block.
      const clipCuts = clipCutFrames(project.tracks, starts);
      const filmSkill = brand.skills.some((x) => x.id === BUILTIN_IDS.film);
      const motionChecks = [
        ...(motion.scan
          ? motionFindings(motion.scan, fps, {
              ...intent,
              hard: filmSkill || intent.asked,
              cutsHard: intent.asked || (filmSkill && !intent.footageCuts),
              clipCuts,
              ...(motionFilm ? { still: STILL_MAX_S } : {}),
            })
          : []),
        ...flatFindings(flatStrips, fps, intent.footage),
        ...("jitter" in motion ? (motion.jitter ?? []) : []),
      ];
      checks.push(...motionChecks);
      // The sheet's words measured (agentLegibility.ts): every small one at once, never a blocker.
      const census = evidence.census;
      checks.push(...legibilityFindings(census, fps, project.canvas.height));
      // The typed prompt (agentTypedPrompt.ts): the user's words when their message asks to show itself typed.
      const typed = typedPromptCheck(r.owner.turns.map((t) => t.prompt).concat(r.turn.prompt), [
        ...(yield* Effect.promise(() => readGraphics(v.dir, project).catch(() => new Map<string, string>()))).values(),
      ]);
      checks.push(...typed.findings);
      if (rehearsal?.failure)
        checks.push({
          rule: "motion",
          key: "motion:export",
          message: rehearsalLine(rehearsal),
          ...(rehearsal.frame !== undefined ? { frame: rehearsal.frame } : {}),
          hard: true,
        });
      // D292: the time budget left some of the scan's frames out.
      // (Counted on the sampled frames: the refinement's added frames don't make up for a cut.)
      const cut = "planned" in motion && motion.scan && motion.cut ? budgetLine(Math.min(motion.scanned, motion.planned), motion.planned) : undefined;
      const motionFacts = [
        ...(motion.scan
          ? motionLines(motion.scan, fps, {
              consecutive: scanList.length === duration && !cut,
              clipCuts,
              ...(cut && "planned" in motion ? { planned: motion.planned, covered: motion.scanned } : {}),
            })
          : [
              `${"problem" in motion ? `The frame-difference scan couldn't run: ${motion.problem}` : `No frame-difference scan (${scanMissing}).`} ${UNMEASURED}`,
            ]),
        ...flatLines(flatStrips, fps, intent.footage),
        ...(intent.footageCuts
          ? [
              "The user's request asks for the footage cut on the beat: straight cuts between footage shots are what it asks for (check they land on the beat), never a one-take defect.",
            ]
          : []),
        ...("drop" in motion && motion.drop ? [motion.drop] : []),
        ...beatWordLines(sb?.beats),
        ...legibilityFacts(census, fps),
        ...typed.facts,
        ...(rehearsal && !rehearsal.failure && rehearsal.total ? [rehearsalLine(rehearsal)] : []),
        // Rehearsal 3: a film that shows the app making itself showed invented counts and results.
        ...(intent.oneTake || r.owner.plan.reviews.length ? [runFacts(sb?.beats.length, r.owner.plan.reviews)] : []),
      ];
      const round = r.reviewRounds + 1;
      // The review's number across the project (the card's "round n"); the limit counts this turn's.
      const number = r.owner.plan.reviews.length + 1;
      const input: CriticInput = {
        round: number,
        canvas: project.canvas,
        frames: duration,
        brief: r.owner.plan.brief,
        storyboard: sb,
        kit: brand.kit ? kitLines(brand.kit, brand.files) : [],
        previous: prev,
        claims,
        checks,
        determinism: { checked, differed },
        images,
        skills: criticSkills(brand.skills).map((x) => ({ name: x.name, checklist: skillChecklist(x.body) })),
        request: userRequest(
          r.owner.turns.map((t) => t.prompt),
          r.turn.prompt,
        ),
        sound: [...soundSheet(project, { sound: rubric.sound }), ...(yield* measuredMixLines(exporter, project))],
        rubric,
        intended,
        motion: { lines: motionFacts, strips: motion.images.length },
      };
      const bin = yield* Effect.promise(() => findClaude());
      if (!bin)
        return textResult(
          "Uncut's critic needs Claude Code, and it isn't installed: the review couldn't run. Tell the user; don't say the video passed.",
          true,
        );
      const answer = yield* Effect.tryPromise({
        try: (signal) =>
          runCritic({
            bin,
            env: sessionEnv(process.env),
            model: r.session.model,
            message: criticMessage(input),
            signal: AbortSignal.any([signal, r.abort.signal]),
          }),
        catch: (e) => e as Error,
      }).pipe(
        Effect.map((text) => parseCritic(text, scoredOf(rubric))),
        Effect.catch((e) => Effect.succeed({ problem: e.message })),
      );
      if ("problem" in answer)
        return textResult(
          `Uncut's critic couldn't review it: ${answer.problem}. This round doesn't count and nothing passed; try review_submit once more, else tell the user the review couldn't run.`,
          true,
        );
      const review = criticReview(answer, {
        round: number,
        claims,
        checks,
        determinism: { checked, differed },
        looked: { ...r.looked },
        revision: v.session.revision,
        turnId: r.turn.id,
        fps,
        rubric,
        intended,
      });
      yield* Effect.promise(() => writeReview(v.dir, review).catch((e: Error) => (console.error(`[uncut] couldn't save the review: ${e.message}`), review)));
      r.reviewRounds = round;
      r.looked = { sheet: false, phone: false };
      r.reviewedStamp = review.passed ? undefined : stamp;
      yield* refreshPlan(r, v);
      addCard(r, { type: "review", review }, `Review round ${round}`);
      return textResult({
        round: number,
        passed: review.passed,
        by: "Uncut's critic (a separate Claude that sees only the frames, the brief, the kit and the storyboard)",
        ...(args.scores !== undefined ? { yourScores: "ignored: the critic scores, not you" } : {}),
        scores: review.scores,
        ...(review.rubric ? { rubric: review.rubric, sound: soundProfileText(rubric.sound) } : {}),
        ...(review.intended ? { intended: `${review.intended} finding${review.intended === 1 ? "" : "s"} the user marked Intended left out` } : {}),
        blockers: review.blockers,
        defects: review.defects,
        ...(review.fixes ? { fixes: review.fixes } : {}),
        motion: {
          strips: motion.images.length,
          ...(cut ? { scanCut: cut } : {}),
          ...(!motion.scan ? { scanFailed: "problem" in motion ? motion.problem : scanMissing } : {}),
          ...(motion.scan
            ? {
                scanned: motion.scan.frames,
                pops: motion.scan.pops.map((p) => p.frame),
                ...(intent.oneTake
                  ? {
                      jumps: motion.scan.jumps.filter((j) => !footageJump(j, clipCuts)).map((j) => j.frame),
                      footageCuts: motion.scan.jumps.filter((j) => footageJump(j, clipCuts)).map((j) => j.frame),
                      holds: motion.scan.holds,
                      empty: emptyRuns(motion.scan, fps),
                      thin: thinRuns(motion.scan, fps),
                    }
                  : {}),
                ...(intent.loop && motion.scan.seam ? { seam: motion.scan.seam } : {}),
              }
            : {}),
          found: motionChecks.map((c) => c.message),
          facts: motionFacts,
        },
        determinism: checked.length
          ? differed.length
            ? `differed: ${differed.join(", ")}`
            : `${checked.length} graphic${checked.length === 1 ? "" : "s"} drew the same twice`
          : "no graphics to check",
        next: reviewNext(
          review,
          round,
          reviewOutlook(turnReviews(), r.reviewRounds),
          (at) => {
            // Round 3's A/B: each blocker's frame, the graphic drawing it there (at its own time) and the frames to look at.
            const f = clampF(at * fps);
            const g = project.tracks
              .filter((t) => !t.hidden)
              .flatMap((t) => t.items)
              .find((i) => i.type === "graphic" && (starts.get(i.id) ?? 0) <= f && f < (starts.get(i.id) ?? 0) + i.duration);
            const name = g ? (g.name ?? (typeof g.src === "string" ? g.src : "a graphic")) : undefined;
            const measured = censusNear([...evidence.fixCensus, ...census], at, fps);
            return `f ${f}${g ? `, ${name} at ${((f - (starts.get(g.id) ?? 0)) / fps).toFixed(2)} s of it` : ""}; render_frames ${clampF(f - 6)} to ${clampF(f + 6)}${measured ? `; ${measured}` : ""}`;
          },
          { width: project.canvas.width, height: project.canvas.height, safe: safeMargin(project) },
        ),
      });
    });

  /** D198: the fonts rule for the open project (the fonts its graphics' own HTML names, the kit's and the installed ones). */
  const fontsRule = (v: ProjectView) =>
    Effect.promise(async () => {
      const project = v.session.project as Project;
      const [fonts, graphics] = await Promise.all([projectFonts(config.fontsDir, brandDirs(v), true), readGraphics(v.dir, project)]);
      return fontRule(fonts.available, graphics);
    });

  return { brandDirs, addCard, stampOf, askUserTool, briefWrite, storyboardPropose, reviewSubmit, fontsRule, rubricOf };
};

export type CardsCtx = GenerateCtx & ReturnType<typeof makeCardTools>;
