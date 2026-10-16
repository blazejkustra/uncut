// The production process's cards (U7-U9, U15-U17, U19; D186-D191): ask_user, brief_write, storyboard_propose, review_submit.
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCard, AgentPlan, AgentAnswer, Storyboard, Brief, BrandKit, BrandSkill } from "@uncut/contracts";
import { CHECK_IDS, fontRule, LAYOUT_HARD, LAYOUT_RULES, projectChecks, soundHard, soundProfileText, soundSheet, type Project, layout } from "@uncut/core";
import * as Effect from "effect/Effect";
import { CELL_WIDTH, clock, sheetFrames, sheetLayout } from "../agentFootage.ts";
import { answerOut, kitLines, questionOf } from "../agentPlan.ts";
import { criticMessage, criticReview, parseCritic, reviewNext, REVIEW_ROUNDS, runCritic, scoredOf, type CriticClaim, type CriticFinding, type CriticImage, type CriticInput } from "../agentCritic.ts";
import { activeBrand, readBrand, readPlan, writeBrief, writeReview, writeStoryboard, normBrief, normBeats } from "../../brand/store.ts";
import { guessVideoType, isVideoType, reviewRubric, skillChecklist, suggestSkills, VIDEO_TYPES } from "@uncut/core/skills";
import { FONT_ERRORS } from "../agentTools.ts";
import { readGraphics, type FrameSessionShape } from "../../export/exporter.ts";
import { projectFonts } from "../../export/fonts.ts";
import type { ProjectView } from "../../project/projects.ts";
import type { Running } from "../session/types.ts";
import { PHONE_WIDTH } from "./common.ts";
import { findClaude, sessionEnv } from "../session/config.ts";
import { beatWordLines, beatWords, budgetLine, flatFindings, flatFraction, flatLines, grayFrames, motionAnchors, motionFindings, motionFrames, motionIntent, motionLines, motionScan, scanPlan, scanSize, STRIP_CELL, stripLayout, stripPlan, type FlatStrip, type MotionScan } from "../criticMotion.ts";
import { which } from "../../app/setup.ts";
import type { CardAnswer } from "../agent.ts";
import type { GenerateCtx } from "./generate.ts";

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
      const a = yield* askUser(r, q.question, 0, undefined, (_card, answer, _source, extra) => {
        if (answer === "allow") got = extra?.answer;
      }, undefined, { question: q });
      const outcome = a === "allow" ? "answered" : a === "deny" ? "skipped" : a;
      const out = answerOut(q, outcome, got);
      if ("choices" in out && out.choices) r.picked.push(...out.choices);
      addCard(r, { type: "question", question: q, ...("choices" in out || "text" in out ? { answer: { choices: "choices" in out ? (out.choices ?? []) : [], ...("text" in out && out.text ? { text: out.text } : {}) } } : {}), outcome: out.answered ? "answered" : "skipped" }, q.question);
      return textResult(out);
    });

  /** brief_write (D188): brief.json, a Brief card. */
  const briefWrite = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const raw = normBrief(args);
      if (!raw || !raw.film.trim()) return textResult("film is the video in one sentence; write the whole brief (film, audience, duration, formats, assets, visual, hardLines, deliverables).", true);
      if (args.type !== undefined && !isVideoType(args.type)) return textResult(`type is one of ${VIDEO_TYPES.join(", ")}.`, true);
      // D217: the type (the agent's, else what the brief's words say) and the suggested skills (the
      // agent's, else Uncut's for the type); suggestions only.
      const type = raw.type ?? guessVideoType(raw);
      const hasKit = yield* Effect.promise(() => readBrand(brandDirs(v)).then((b) => !!b.active.kit).catch(() => false));
      const brief: Brief = { ...raw, ...(type ? { type } : {}), skills: raw.skills?.length ? raw.skills : suggestSkills({ ...raw, ...(type ? { type } : {}) }, { hasKit }) };
      const saved = yield* Effect.tryPromise({ try: () => writeBrief(v.dir, { ...brief, by: "agent" }), catch: (e) => e as Error }).pipe(Effect.map((b) => ({ ok: true as const, b })), Effect.catch((e) => Effect.succeed({ ok: false as const, message: e.message })));
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
      const rubric = yield* rubricOf(v);
      const skillsOut = skills
        ? {
            type: saved.b.type ?? "none (judged as a short product video)",
            suggestedSkills: skills.suggested.filter((x) => !skills.used.some((u) => u.id === x.id)).map((x) => ({ id: x.id, name: x.name })),
            skills: skills.used.map((x) => ({ id: x.id, name: x.name })),
            skillsNote: `${skills.suggested.some((x) => !skills.used.some((u) => u.id === x.id)) ? "Read each suggested skill that fits with skill_read before you build (no need to ask the user; leave out one the brief says it doesn't want, like motion graphics or sound design). " : ""}Follow every rule of the skills this project uses; the critic checks their review checklists.`,
            rubric: Object.fromEntries(Object.entries(rubric.levels).map(([k, l]) => [k, l === "na" ? "not scored" : l])),
            sound: soundProfileText(rubric.sound),
          }
        : {};
      return textResult({ saved: "brief.json", ...skillsOut, next: sb?.status === "approved" ? "The storyboard is approved: if the brief changed what it shows, propose it again with storyboard_propose." : "Now propose the storyboard with storyboard_propose; build once the user approves it." });
    });

  /** D217: the critic's rubric for the open project: its brief, its active skills and whether it has a kit. */
  const rubricOf = (v: ProjectView) =>
    Effect.promise(async () => {
      const plan = await readPlan(v.dir).catch(() => ({ reviews: [] }) as AgentPlan);
      const active = await readBrand(brandDirs(v)).then((b) => b.active).catch(() => ({ kit: null, skills: [] as ReadonlyArray<string> }));
      return reviewRubric(plan.brief, { skills: active.skills, hasKit: !!active.kit });
    });

  /** storyboard_propose (D188): saved as proposed, then a card the user approves (maybe editing beats) or sends back. */
  const storyboardPropose = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const raw = Array.isArray(args.beats) ? args.beats : [];
      // D295: a beat's still is a timeline frame; Uncut renders it and the card shows it with the beat.
      const asked = raw.map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>).still : undefined));
      const beats = normBeats(raw.map((b) => (b && typeof b === "object" ? { ...(b as Record<string, unknown>), still: undefined } : b)));
      if (!beats.length) return textResult("beats is the shot list: each {start, end (seconds), title, entry, exit, purpose, assets, sound}.", true);
      const summary = typeof args.summary === "string" ? args.summary.trim().slice(0, 600) : "";
      const wanted = asked.flatMap((f, i) => (f === undefined ? [] : [[i, f] as const]));
      if (wanted.length > MAX_STILLS || wanted.some(([, f]) => !Number.isInteger(f) || (f as number) < 0)) {
        const many = wanted.length > MAX_STILLS ? ` You gave ${wanted.length} (beats ${wanted.map(([i]) => i + 1).join(", ")}): keep ${MAX_STILLS}, say the open, the drop, the busiest state and the last frame, and propose again.` : "";
        return textResult(`still is a timeline frame (an integer from 0) on at most ${MAX_STILLS} beats.${many}`, true);
      }
      // D296: from here the proposal locks the edit (run.ts): the stills render from this state and
      // the user approves what they see. Set before rendering, so a parallel edit can't slip in.
      r.planned = true;
      r.proposing = true;
      if (wanted.length) {
        const canvas = v.session.project.canvas;
        const width = Math.min(canvas.width, STILL_WIDTH);
        const rendered = yield* exporter.renderFrames(wanted.map(([, f]) => f as number), width).pipe(
          Effect.map((list) => ({ ok: true as const, list })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
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
      const write = (sb: Storyboard) => Effect.promise(() => writeStoryboard(v.dir, sb).catch((e: Error) => (console.error(`[uncut] couldn't save the storyboard: ${e.message}`), sb)));
      r.planned = true;
      if (r.skipStoryboard) {
        r.proposing = false;
        const sb = yield* write({ summary, beats, status: "approved", approvedBy: "setting" });
        yield* refreshPlan(r, v);
        addCard(r, { type: "storyboard", storyboard: sb, outcome: "auto" }, summary || "Storyboard");
        return textResult({ approved: true, by: "setting", message: "Approved by the user's setting (Auto skips the storyboard approval). Build it scene by scene." });
      }
      const proposed = yield* write({ summary, beats, status: "proposed" });
      yield* refreshPlan(r, v);
      let extra: CardAnswer | undefined;
      const a = yield* askUser(r, summary || "Storyboard", 0, undefined, (_card, _a, _s, x) => {
        extra = x;
      }, undefined, { storyboard: proposed });
      // D296: approved or sent back, the edit is free again; unanswered, it stays locked for the turn.
      if (a === "allow" || a === "deny") r.proposing = false;
      if (a === "allow") {
        const edited = extra?.beats ? normBeats(extra.beats) : [];
        const final = yield* write({ summary, beats: edited.length ? edited : beats, status: "approved", approvedBy: "user" });
        yield* refreshPlan(r, v);
        addCard(r, { type: "storyboard", storyboard: final, outcome: "approved" }, summary || "Storyboard");
        return textResult({ approved: true, ...(edited.length ? { edited: true, beats: final.beats, message: "The user edited the beats: build these." } : { message: "Approved as the stills show it. Build it scene by scene to match them; keep the copy, logo and end card they show (to change those, propose again)." }) });
      }
      if (a === "deny") {
        const note = extra?.note?.trim().slice(0, 2000) ?? "";
        const final = yield* write({ summary, beats, status: "declined", ...(note ? { note } : {}) });
        yield* refreshPlan(r, v);
        addCard(r, { type: "storyboard", storyboard: final, outcome: "declined" }, summary || "Storyboard");
        return textResult({ approved: false, ...(note ? { change: note } : {}), next: note ? "Change the storyboard as asked and propose it again; don't build until it's approved." : "The user didn't approve it and said nothing: ask what to change (ask_user); don't build." });
      }
      addCard(r, { type: "storyboard", storyboard: proposed, outcome: "skipped" }, summary || "Storyboard");
      return textResult({ approved: false, message: a === "stopped" ? "The turn was stopped." : "Nobody answered in 15 minutes.", next: "Don't build or edit (timeline_edit, graphic_write and shader_write are refused for the rest of this turn). End the turn now saying the storyboard waits for approval on the Plan card." }, a !== "timeout");
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
        const missing = [!r.looked.sheet ? "a contact_sheet of the edit (no media)" : "", !r.looked.phone ? "render_frames with phone true (frame 0, the first 2 s and each beat's last frame)" : ""].filter(Boolean).join(" and ");
        return textResult(`Look before you ask for a review: ${missing}${r.reviewRounds ? " since the last round" : ""}, then review_submit.`, true);
      }
      if (r.reviewRounds >= REVIEW_ROUNDS) return textResult(`That was the last review round in this turn (${REVIEW_ROUNDS}): stop fixing and tell the user what the critic still found.`, true);
      const project = v.session.project as Project;
      const fps = project.canvas.fps;
      const { starts, duration } = layout(project);
      if (!project.tracks.some((t) => t.items.length) || duration <= 0) return textResult("The timeline is empty: there's nothing to review yet.", true);
      const stamp = stampOf(r, v);
      if (r.reviewedStamp === stamp) return textResult(`Nothing changed since round ${r.reviewRounds}: fix what the critic found (timeline_edit, graphic_write), look at the fixed moments, then review_submit again.`, true);
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
        if (!found) return textResult(`There's no ${defect} in the last review${findings.length ? ` (its ids: ${findings.map((x) => x.id).filter(Boolean).join(", ")})` : ""}.`, true);
        claims.push({ defect, what, ...(found.at !== undefined ? { at: found.at } : {}), was: found.what });
      }
      const near = (at: number) => [Math.max(0, Math.round((at - 0.5) * fps)), Math.round((at + 0.5) * fps)] as const;
      const unseen = claims.filter((c) => {
        if (c.at === undefined) return false;
        const [lo, hi] = near(c.at);
        return !r.rendered.some((x) => x.stamp === stamp && x.frames.some((f) => f >= lo && f <= hi));
      });
      if (unseen.length) {
        return textResult(`Look at each fix before you claim it: render_frames a frame of ${unseen.map((c) => `${c.defect} (at ${c.at} s, frames ${near(c.at!).join(" to ")})`).join(", ")} after your last change, and check the defect is really gone. Frames rendered before the change don't count.`, true);
      }
      // Determinism (D189): each graphic's middle frame in the round's session and once more in a
      // separate one; the same JPEG twice or it differed.
      const graphics = project.tracks.filter((t) => !t.hidden).flatMap((t) => t.items.filter((i) => i.type === "graphic" && typeof i.src === "string")).slice(0, 4);
      const twiceOf = graphics.map((g) => ({ name: g.name ?? g.src!.replace(/^graphics\//, ""), frame: (starts.get(g.id) ?? 0) + Math.floor(g.duration / 2) }));
      const sha = (jpeg: Buffer) => createHash("sha256").update(jpeg).digest("hex");
      const hashes = (session: FrameSessionShape) => Effect.forEach(twiceOf, (x) => session.render([x.frame], 480).pipe(Effect.map((a) => sha(a[0]!.jpeg)), Effect.catch(() => Effect.succeed(undefined))));
      // The evidence, rendered by Uncut at this revision: a contact sheet, phone-size frames, each claimed fix's moment.
      const last = duration - 1;
      const clampF = (f: number) => Math.max(0, Math.min(last, Math.round(f)));
      const sb = r.owner.plan.storyboard;
      const phoneFrames = [...new Set([0, clampF(2 * fps), ...(sb?.beats ?? []).map((b) => clampF(b.end * fps - 1)), last])].sort((a, b) => a - b).slice(0, 8);
      const phoneWidth = Math.max(64, Math.round(project.canvas.width * Math.min(1, PHONE_WIDTH / project.canvas.width)));
      const fixFrames = claims.flatMap((c) => (c.at === undefined ? [] : [{ defect: c.defect, frame: clampF(c.at * fps) }])).slice(0, 6);
      const sheetCells = sheetFrames(0, duration, undefined, 16);
      const brand = yield* Effect.promise(() => activeBrand(brandDirs(v)).catch(() => ({ files: {} as Record<string, string>, skills: [] as Array<BrandSkill> }) as { kit?: BrandKit; files: Record<string, string>; skills: Array<BrandSkill> }));
      // D292: motion over time: a frame strip per scene change and a frame-difference scan (pops,
      // one-frame jumps, holds, the loop seam), as images and facts for the critic and findings for the agent.
      const hasFootage = project.tracks.some((t) => !t.hidden && t.items.some((i) => i.type === "clip"));
      const intent = motionIntent({ skills: brand.skills.map((x) => x.name), words: [r.owner.plan.brief?.film, r.owner.plan.brief?.visual, r.owner.plan.brief?.notes, ...(r.owner.plan.brief?.assets ?? []), ...(r.owner.plan.brief?.hardLines ?? [])].filter(Boolean).join("\n"), hasFootage });
      const anchors = motionAnchors(sb?.beats, fps, duration);
      const strips = stripPlan(anchors, fps, duration);
      const scanList = scanPlan(anchors, fps, duration);
      const aspect = project.canvas.width / project.canvas.height;
      // D292: one frame session for the round (one rasteriser, the plan once per width), small
      // frames captured small; the strips' and the scan's frames rendered once, under a time budget.
      const rendered = yield* exporter
        .frameSession(
          (session) =>
            Effect.gen(function* () {
              const mine = yield* hashes(session);
              const evidence = yield* Effect.gen(function* () {
                const cells = "refused" in sheetCells ? [0] : [...sheetCells];
                const list = yield* session.render(cells, CELL_WIDTH);
                const sheet = yield* session.sheet(list.map((f, i) => ({ jpeg: f.jpeg, caption: `${i + 1}   f ${f.frame}   ${clock(f.frame / fps)}` })), sheetLayout(list.length, aspect));
                const phone = yield* session.render(phoneFrames, phoneWidth);
                const fixed = fixFrames.length ? yield* session.render(fixFrames.map((x) => x.frame), Math.min(project.canvas.width, 720)) : [];
                return { ok: true as const, sheet, shown: list.map((f) => f.frame), phone, fixed };
              }).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })));
              if (!evidence.ok) return { mine, evidence, motion: { images: [] as Array<CriticImage>, scan: undefined } };
              const motion = yield* Effect.gen(function* () {
                const got = yield* Effect.tryPromise({ try: (signal) => motionFrames({ strips, scanList, anchors, duration, render: (frames, until) => Effect.runPromise(session.render(frames, STRIP_CELL, { until }), { signal }) }), catch: (e) => e as Error });
                const stripImages: Array<CriticImage> = [];
                for (const st of strips) {
                  const cells = st.frames.flatMap((f) => (got.byFrame.has(f) ? [{ jpeg: got.byFrame.get(f)!, caption: `f ${f}   ${clock(f / fps)}` }] : []));
                  if (!cells.length) continue;
                  const jpeg = yield* session.sheet(cells, stripLayout(cells.length, aspect));
                  stripImages.push({ label: `frame strip around ${st.label} (f ${st.at}, ${(st.at / fps).toFixed(2)} s): frames ${st.frames.join(", ")} left to right, ${Math.round(1000 / 12)} ms apart`, jpeg });
                }
                let scan: MotionScan | undefined;
                const flat: Array<FlatStrip> = [];
                const ffmpeg = yield* Effect.promise(async () => (await config.shellReady, which("ffmpeg", process.env.PATH ?? "")));
                // The scan's grey frames from the strips' size (grayFrames scales them to SCAN_WIDTH).
                const { w, h } = scanSize(project.canvas);
                if (ffmpeg && got.scanned.length > 2) {
                  const grays = yield* Effect.tryPromise({ try: (signal) => grayFrames(ffmpeg, got.scanned.map((f) => got.byFrame.get(f)!), w, h, AbortSignal.any([signal, r.abort.signal])), catch: (e) => e as Error });
                  scan = motionScan(got.scanned.map((f, i) => ({ frame: f, gray: grays[i]! })), fps);
                }
                // D296: how much of each strip's frames is flat background (the median of its frames).
                const stripFrames = [...new Set(strips.flatMap((st) => st.frames.filter((f) => got.byFrame.has(f))))];
                if (ffmpeg && stripFrames.length) {
                  const grays = yield* Effect.tryPromise({ try: (signal) => grayFrames(ffmpeg, stripFrames.map((f) => got.byFrame.get(f)!), w, h, AbortSignal.any([signal, r.abort.signal])), catch: (e) => e as Error });
                  const share = new Map(stripFrames.map((f, i) => [f, flatFraction(grays[i]!, w, h)]));
                  for (const st of strips) {
                    const xs = st.frames.flatMap((f) => (share.has(f) ? [share.get(f)!] : [])).sort((a, b) => a - b);
                    if (xs.length) flat.push({ label: st.label, at: st.at, flat: xs[xs.length >> 1]! });
                  }
                }
                return { images: stripImages, scan, flat, planned: got.planned, cut: got.cut };
              }).pipe(Effect.catch((error) => Effect.succeed({ images: [] as Array<CriticImage>, scan: undefined, problem: (error as Error).message })));
              return { mine, evidence, motion };
            }),
          { downscale: true },
        )
        .pipe(Effect.catch((error) => Effect.succeed({ mine: [] as Array<string | undefined>, evidence: { ok: false as const, message: error.message }, motion: { images: [] as Array<CriticImage>, scan: undefined } })));
      const { evidence, motion } = rendered;
      if (!evidence.ok) return textResult(`Couldn't render the frames for the critic: ${evidence.message}`, true);
      // The second render of each graphic, in a session of its own.
      const theirs = twiceOf.length ? yield* exporter.frameSession(hashes, { downscale: true }).pipe(Effect.catch(() => Effect.succeed([] as Array<string | undefined>))) : [];
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
        { label: `contact sheet of the whole video, ${evidence.shown.length} cells left to right, top to bottom, each captioned with its number, frame and time (frames ${evidence.shown.join(", ")})`, jpeg: evidence.sheet },
        ...evidence.phone.map((f) => {
          // D296: a beat's last frame carries the words the storyboard says that beat shows.
          const beat = (sb?.beats ?? []).findIndex((b) => clampF(b.end * fps - 1) === f.frame);
          const words = beat >= 0 ? beatWords(sb!.beats[beat]!) : [];
          return { label: `frame ${f.frame} (${(f.frame / fps).toFixed(2)} s) at ${phoneWidth} px wide, as on a phone in a feed${words.length ? `; the last frame of storyboard beat ${beat + 1}, which says it shows ${words.map((w) => `"${w}"`).join(", ")}` : ""}`, jpeg: f.jpeg };
        }),
        ...evidence.fixed.map((f, i) => ({ label: `frame ${f.frame} (${(f.frame / fps).toFixed(2)} s), the moment of claimed fix ${fixFrames[i]!.defect}, rendered after the fix`, jpeg: f.jpeg })),
      ];
      // Uncut's layout checks (D196) and the safe-area ones, as facts.
      // D207: and the sound rule (density and level fail a round as "sound" blockers; the rest the critic confirms).
      const keep = new Set(["text-edge", "small-text", "sound"]);
      // D198: a font that isn't there is a hard finding too (a "font" blocker).
      const fontCheck = yield* fontsRule(v);
      // D217: the rubric (the brief's type, the active skills, a kit) sets the sound profile; density
      // and level fail a round only under the strict one. Findings the user marked Intended stay out.
      const rubric = yield* rubricOf(v);
      const intended = r.owner.plan.intended ?? [];
      const checks: Array<CriticFinding> = projectChecks(project, { rules: [...LAYOUT_RULES, fontCheck], disabled: CHECK_IDS.filter((id) => !keep.has(id)), sound: rubric.sound })
        .map((c) => ({ rule: c.id, key: c.key, message: c.message, ...(c.frame !== undefined ? { frame: c.frame } : {}), ...(c.range ? { range: c.range } : {}), hard: LAYOUT_HARD.has(c.id) || FONT_ERRORS.has(c.id) || (c.id === "sound" && soundHard(c.key, rubric.sound)) }));
      images.push(...motion.images);
      const flatStrips = "flat" in motion ? (motion.flat ?? []) : [];
      const motionChecks = [...(motion.scan ? motionFindings(motion.scan, fps, intent) : []), ...flatFindings(flatStrips, fps, intent.footage)];
      checks.push(...motionChecks);
      // D292: the time budget left some of the scan's frames out.
      const cut = "planned" in motion && motion.scan && motion.scan.frames < motion.planned ? budgetLine(motion.scan.frames, motion.planned) : undefined;
      const motionFacts = [
        ...(motion.scan ? motionLines(motion.scan, fps, { consecutive: scanList.length === duration && !cut, ...("planned" in motion ? { planned: motion.planned } : {}) }) : ["problem" in motion ? `The frame-difference scan couldn't run: ${motion.problem}` : "No frame-difference scan (ffmpeg isn't on PATH)."]),
        ...flatLines(flatStrips, fps, intent.footage),
        ...beatWordLines(sb?.beats),
      ];
      const round = r.reviewRounds + 1;
      // The review's number across the project (the card's "round n"); the limit counts this turn's.
      const number = r.owner.plan.reviews.length + 1;
      const input: CriticInput = { round: number, canvas: project.canvas, frames: duration, brief: r.owner.plan.brief, storyboard: sb, kit: brand.kit ? kitLines(brand.kit, brand.files) : [], previous: prev, claims, checks, determinism: { checked, differed }, images, skills: brand.skills.map((x) => ({ name: x.name, checklist: skillChecklist(x.body) })), sound: soundSheet(project, { sound: rubric.sound }), rubric, intended, motion: { lines: motionFacts, strips: motion.images.length } };
      const bin = yield* Effect.promise(() => findClaude());
      if (!bin) return textResult("Uncut's critic needs Claude Code, and it isn't installed: the review couldn't run. Tell the user; don't say the video passed.", true);
      const answer = yield* Effect.tryPromise({ try: (signal) => runCritic({ bin, env: sessionEnv(process.env), model: r.session.model, message: criticMessage(input), signal: AbortSignal.any([signal, r.abort.signal]) }), catch: (e) => e as Error }).pipe(
        Effect.map((text) => parseCritic(text, scoredOf(rubric))),
        Effect.catch((e) => Effect.succeed({ problem: e.message })),
      );
      if ("problem" in answer) return textResult(`Uncut's critic couldn't review it: ${answer.problem}. This round doesn't count and nothing passed; try review_submit once more, else tell the user the review couldn't run.`, true);
      const review = criticReview(answer, { round: number, claims, checks, determinism: { checked, differed }, looked: { ...r.looked }, revision: v.session.revision, turnId: r.turn.id, fps, rubric, intended });
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
        motion: { strips: motion.images.length, ...(cut ? { scanCut: cut } : {}), ...(motion.scan ? { scanned: motion.scan.frames, pops: motion.scan.pops.map((p) => p.frame), ...(intent.oneTake ? { jumps: motion.scan.jumps.map((j) => j.frame), holds: motion.scan.holds } : {}), ...(intent.loop && motion.scan.seam ? { seam: motion.scan.seam } : {}) } : {}), found: motionChecks.map((c) => c.message), facts: motionFacts },
        determinism: checked.length ? (differed.length ? `differed: ${differed.join(", ")}` : `${checked.length} graphic${checked.length === 1 ? "" : "s"} drew the same twice`) : "no graphics to check",
        next: reviewNext(review, round),
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
