// The agent's speech tools: transcript_read, transcript_edit, subtitles_export, captions_make.
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import {
  captionCardList,
  subtitleCues,
  subtitleFormatOf,
  subtitleTime,
  type Project,
  DEFAULT_PAUSE_MIN_S,
  planMakeCaptions,
  planTextCut,
  type CaptionLines,
  type CaptionMode,
  type TextCutRequest,
} from "@uncut/core";
import * as Effect from "effect/Effect";
import { targetOf } from "../../analysis/analysis.ts";
import { PHRASES_NOTE, transcriptOut, TRANSCRIPT_NOTE } from "../agentTranscript.ts";
import { isLanguage, type TranscriptResult } from "../../analysis/transcription.ts";
import { MAX_CAPTION_CARDS, projectSummary } from "../agentTools.ts";
import { canonicalPath } from "../../export/subtitleSources.ts";
import type { ProjectView } from "../../project/projects.ts";
import { expandHome } from "../../paths.ts";
import { type Running, pushEdit } from "../session/types.ts";
import { noteFor, speechOfItem, mediaHeardOnMain } from "../turns/notes.ts";
import { analyzeWaitMs } from "./common.ts";
import type { MediaCtx } from "./media.ts";

export const makeTranscriptTools = (ctx: MediaCtx) => {
  const { textResult, requestAndWait, pendingOut, cancelledNote, silencesOf, view, projects, persist, publish, exporter } = ctx;

  // transcript_read (D68): starts (or joins) the transcript job like media_analyze (the first one
  // may download the speech model first), then the words in project frames of the media, paged.
  const transcriptRead = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const project = v.session.project;
      // D215: an item on any track reads the file its speech is.
      const spoken = args.item !== undefined ? speechOfItem(project as Project, args.item) : undefined;
      if (spoken && "problem" in spoken) return textResult(spoken.problem, true);
      if (spoken && args.media !== undefined && args.media !== spoken.media)
        return textResult(`${String(args.item)}'s speech is ${spoken.media}, not ${String(args.media)}: pass one of them.`, true);
      if (spoken) args = { ...args, media: spoken.media };
      if (typeof args.media !== "string") return textResult("Pass media (a media id from project_read) or item (an item id on any track).", true);
      const m = project.media.find((x) => x.id === args.media);
      if (!m)
        return textResult(
          `There's no media "${args.media}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`,
          true,
        );
      const range = args.range as { start?: unknown; end?: unknown } | undefined;
      if (
        range !== undefined &&
        (typeof range !== "object" ||
          range === null ||
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          (range.start as number) < 0 ||
          (range.end as number) <= (range.start as number))
      ) {
        return textResult("range must be { start, end } in whole project frames of the media, start from 0 and before end.", true);
      }
      if (args.format !== undefined && args.format !== "text" && args.format !== "words")
        return textResult('format must be "text" (lines, the default) or "words" (each word with its frames).', true);
      if (args.from !== undefined && (!Number.isInteger(args.from) || (args.from as number) < 0))
        return textResult("from must be a word index (a whole number from 0), as next.from gave it.", true);
      if (args.language !== undefined && !isLanguage(args.language))
        return textResult('language must be a language code like "en" or "pl", or "auto" (detect it).', true);
      if (m.kind === "image") return textResult(`${m.id} is a still image: there's no sound to transcribe.`, true);
      const fps = project.canvas.fps;
      const target = targetOf(v.dir, m, fps);
      const language = args.language as string | undefined;
      const [answer] = yield* requestAndWait([{ target, analyzer: "transcript", options: { language } }]);
      const { outcome, jobId } = answer!;
      if (!outcome) {
        const p = pendingOut(jobId);
        const what =
          "stage" in p && p.stage
            ? "is downloading the speech model (once, then it's kept)"
            : p.state === "queued"
              ? "is waiting its turn"
              : "is still transcribing";
        return textResult({
          media: m.id,
          transcript: p,
          note: `The transcript ${what} after ${Math.round(analyzeWaitMs() / 1000)} s. Call transcript_read again with the same arguments; it joins the running job.`,
        });
      }
      if (outcome.state === "failed") return textResult({ media: m.id, transcript: { state: "failed", error: outcome.error } }, true);
      if (outcome.state === "cancelled") return textResult({ media: m.id, transcript: { state: "cancelled", note: cancelledNote } }, true);
      const result = outcome.result as TranscriptResult;
      const { silences, envelope } = yield* Effect.promise(() => silencesOf(target, false));
      const out = transcriptOut(result, {
        cached: outcome.cached,
        fps,
        length: m.probe?.frames,
        range: range as { start: number; end: number } | undefined,
        ...(args.from !== undefined ? { from: args.from as number } : {}),
        format: (args.format as "text" | "words" | undefined) ?? "text",
        silences,
        envelope,
      });
      return textResult({
        media: m.id,
        ...(spoken ? { item: args.item } : {}),
        ...out,
        note: ["note" in out && typeof out.note === "string" ? out.note : "", result.hasAudio ? TRANSCRIPT_NOTE : "", result.phrases ? PHRASES_NOTE : ""]
          .filter(Boolean)
          .join(" "),
      });
    });

  // transcript_edit (D69): cut words (w12–w20 ranges), pauses and/or hesitation fillers of a media
  // file out of the main track with core planTextCut (the Transcript panel's planner), as one
  // agent edit on the turn (Undo turn reverts it). Gets the transcript like transcript_read (it
  // may have to be made first); dryRun answers with the plan and applies nothing.
  const transcriptEdit = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const project = v.session.project;
      const fps = project.canvas.fps;
      // D215: item cuts that item (any track) and what belongs to it.
      const spoken = args.item !== undefined ? speechOfItem(project as Project, args.item) : undefined;
      if (spoken && "problem" in spoken) return textResult(spoken.problem, true);
      if (spoken && args.media !== undefined && args.media !== spoken.media)
        return textResult(`${String(args.item)}'s speech is ${spoken.media}, not ${String(args.media)}: pass one of them.`, true);
      let mediaId = spoken ? spoken.media : args.media;
      if (mediaId === undefined) {
        const heard = mediaHeardOnMain(project as Project);
        if (heard.length !== 1)
          return textResult(
            heard.length
              ? `Several media with sound are on the main track (${heard.join(", ")}): pass media.`
              : "No clip with sound is on the main track. Pass media or item, or put the talk on the timeline first.",
            true,
          );
        mediaId = heard[0];
      }
      if (typeof mediaId !== "string") return textResult("media must be a media id from project_read.", true);
      const m = project.media.find((x) => x.id === mediaId);
      if (!m)
        return textResult(
          `There's no media "${mediaId}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`,
          true,
        );
      if (m.kind === "image") return textResult(`${m.id} is a still image: there's no speech to cut.`, true);
      const word = (value: unknown) =>
        Number.isInteger(value) && (value as number) >= 0
          ? (value as number)
          : typeof value === "string" && /^w?\d+$/.test(value)
            ? Number(value.replace(/^w/, ""))
            : undefined;
      const request: {
        remove?: Array<{ from: number; to: number }>;
        pauses?: { min: number };
        fillers?: boolean;
        items?: ReadonlyArray<string>;
        clips?: ReadonlyArray<string>;
      } = { ...spoken?.request };
      if (args.remove !== undefined) {
        if (!Array.isArray(args.remove) || !args.remove.length)
          return textResult('remove must be a list of word ranges like {"from":"w12","to":"w20"} (word ids from transcript_read).', true);
        const ranges: Array<{ from: number; to: number }> = [];
        for (const x of args.remove as ReadonlyArray<unknown>) {
          const range = (x && typeof x === "object" ? x : {}) as { from?: unknown; to?: unknown };
          const from = word(range.from);
          const to = range.to === undefined ? from : word(range.to);
          if (from === undefined || to === undefined)
            return textResult(`Each remove entry needs from (and optionally to) as word ids like "w12" from transcript_read; got ${JSON.stringify(x)}.`, true);
          ranges.push({ from, to });
        }
        request.remove = ranges;
      }
      if (args.pauses !== undefined) {
        const raw = args.pauses === true ? {} : args.pauses;
        const min = raw && typeof raw === "object" ? ((raw as { min?: unknown }).min ?? DEFAULT_PAUSE_MIN_S) : undefined;
        if (typeof min !== "number" || !Number.isFinite(min) || min < 0.1 || min > 60)
          return textResult(`pauses must be {"min": seconds} (0.1 to 60; ${DEFAULT_PAUSE_MIN_S} if left out).`, true);
        request.pauses = { min };
      }
      if (args.fillers !== undefined && typeof args.fillers !== "boolean") return textResult("fillers must be true or false.", true);
      if (args.fillers === true) request.fillers = true;
      if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") return textResult("dryRun must be true or false.", true);
      if (!request.remove && !request.pauses && !request.fillers)
        return textResult("Say what to cut: remove (word ranges), pauses ({min} seconds) and/or fillers: true.", true);
      const target = targetOf(v.dir, m, fps);
      const [answer] = yield* requestAndWait([{ target, analyzer: "transcript" }]);
      const { outcome, jobId } = answer!;
      if (!outcome) {
        const p = pendingOut(jobId);
        return textResult({
          media: m.id,
          transcript: p,
          note: `There's no transcript yet and it's still being made after ${Math.round(analyzeWaitMs() / 1000)} s. Call transcript_edit again with the same arguments (it joins the running job), or transcript_read to follow it.`,
        });
      }
      if (outcome.state === "failed") return textResult({ media: m.id, transcript: { state: "failed", error: outcome.error } }, true);
      if (outcome.state === "cancelled") return textResult({ media: m.id, transcript: { state: "cancelled", note: cancelledNote } }, true);
      const result = outcome.result as TranscriptResult;
      if (!result.hasAudio || !result.words?.length)
        return textResult(`${m.id} has ${result.hasAudio ? "no speech in its transcript" : "no sound"}, so there's nothing to cut by text.`, true);
      const { silences, envelope } = yield* Effect.promise(() => silencesOf(target));
      // The wait can be long: plan on the project as it is now, not as it was when the call came in.
      const fresh = view();
      if (!fresh || fresh.openId !== r.openId) return textResult("The project was closed.", true);
      if (!fresh.session.project.media.some((x) => x.id === m.id)) return textResult(`${m.id} isn't in the project any more.`, true);
      // A media no main clip plays is cut where it plays (D215), as the user's items there.
      if (!spoken && !request.items && !mediaHeardOnMain(fresh.session.project as Project).includes(m.id)) {
        const elsewhere = fresh.session.project.tracks
          .filter((t) => t.role !== "main")
          .flatMap((t) => t.items.filter((i) => (i.type === "clip" || i.type === "audio") && i.media === m.id).map((i) => i.id));
        if (elsewhere.length) request.items = elsewhere;
      }
      // The item's pieces as they are now (an earlier cut may have split it).
      if (spoken?.itemId) {
        const now = speechOfItem(fresh.session.project as Project, spoken.itemId);
        if ("problem" in now) return textResult(now.problem, true);
        delete request.items;
        delete request.clips;
        Object.assign(request, now.request);
      }
      const plan = planTextCut(
        fresh.session.project,
        m.id,
        { words: result.words, language: result.language, seconds: result.seconds, segments: result.segments },
        { ...request, silences, envelope } as TextCutRequest,
      );
      if ("problem" in plan) return textResult(plan.problem, true);
      const secs = (frames: number) => Number((frames / fps).toFixed(2));
      const removed = plan.cuts.map((c) => ({
        ...(c.words ? { words: c.words[0] === c.words[1] ? `w${c.words[0]}` : `w${c.words[0]}–w${c.words[1]}` } : {}),
        text: c.text || "(pause)",
        ...(c.pauses ? { pauses: c.pauses } : {}),
        ...(c.fillers ? { fillers: c.fillers } : {}),
        mediaFrames: { start: c.from, end: c.to },
        frames: c.frames,
        seconds: secs(c.frames),
        clips: c.clips,
      }));
      const base = {
        media: m.id,
        ...(spoken ? { item: spoken.itemId } : {}),
        removed,
        framesRemoved: plan.framesRemoved,
        secondsSaved: secs(plan.framesRemoved),
        ...(plan.notes.length ? { notes: plan.notes } : {}),
      };
      if (args.dryRun === true || !plan.ops.length) {
        return textResult({
          ...base,
          applied: false,
          revision: fresh.session.revision,
          duration: plan.after,
          seconds: secs(plan.after),
          durationBefore: plan.before,
          note:
            args.dryRun === true
              ? "A dry run: nothing changed. duration is what the edit would be; call again without dryRun to cut."
              : "Nothing to cut, so nothing changed.",
        });
      }
      const outcome2 = yield* projects
        .agentEdit(r.openId, { turnId: r.turn.id, ops: plan.ops, baseRevision: fresh.session.revision, summary: plan.summary })
        .pipe(
          Effect.map((snapshot) => ({ ok: true as const, snapshot })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
      if (!outcome2.ok) {
        const now = view();
        const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
        return textResult(
          {
            refused: outcome2.error.message,
            details: outcome2.error.details,
            revision: now?.session.revision,
            ...(userChanges ? { userChanges } : {}),
            note: "Nothing was cut. transcript_edit plans on the newest project each time, so call it again with the same arguments (the user's changes stay).",
          },
          true,
        );
      }
      const { snapshot } = outcome2;
      const lines = plan.cuts.map(
        (c) =>
          `${c.text ? `Cut "${c.text.length > 50 ? `${c.text.slice(0, 49)}…` : c.text}"` : `Removed ${c.pauses === 1 ? "a pause" : `${c.pauses} pauses`}`}${c.text && c.pauses ? ` and ${c.pauses === 1 ? "a pause" : `${c.pauses} pauses`}` : ""} (${(c.frames / fps).toFixed(1)} s${c.text && c.pauses ? " in all" : ""}) from ${c.clips.join(", ")}`,
      );
      pushEdit(r, { revision: snapshot.revision, summary: plan.summary, lines });
      persist(r.owner);
      publish();
      // As media_import: the new revision is read; user edits since the agent's read come back with it.
      r.owner.seen.add(snapshot.revision);
      const now = view();
      const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
      const end = projectSummary(snapshot.project as Project, snapshot.revision).duration;
      return textResult({
        ...base,
        applied: true,
        revision: snapshot.revision,
        duration: end,
        seconds: secs(end),
        durationBefore: plan.before,
        note: "One edit on your turn (Undo turn reverts it). Word ids don't change (they belong to the media's transcript): transcript_read still lists every word of the file, including the ones now cut; project_read shows the clips that are left.",
        ...(userChanges
          ? { userChanges, userNote: "The user changed the project since your read; the revision above includes their changes. Keep them." }
          : {}),
      });
    });

  // captions_make (D82): captions from a media's transcript (core planMakeCaptions, the Transcript
  // panel's planner), the words stored where they're heard (the loudness pass, as transcript_edit),
  // as one agent edit on the turn. Gets the transcript like transcript_read.
  // subtitles_export (D105): the project's subtitles (captions cards and Subtitles tracks, merged
  // by time) as a .srt or .vtt file; next to project.json unless a path is given. No video.
  const subtitlesExport = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      if (args.format !== undefined && args.format !== "srt" && args.format !== "vtt") return textResult('format must be "srt" or "vtt".', true);
      if (args.path !== undefined && (typeof args.path !== "string" || !args.path.trim()))
        return textResult("path must be an absolute path to a .srt or .vtt file.", true);
      if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") return textResult("overwrite must be true or false.", true);
      const project = v.session.project as Project;
      let path = typeof args.path === "string" ? expandHome(args.path) : undefined;
      if (path !== undefined && !isAbsolute(path))
        return textResult(`"${args.path}" isn't an absolute path. Pass the full path, like /Users/you/Movies/talk.srt.`, true);
      const byName = path ? subtitleFormatOf(path) : undefined;
      if (path && !byName && /\.[^./]+$/.test(basename(path))) return textResult("path must end in .srt or .vtt.", true);
      if (byName && args.format !== undefined && byName !== args.format)
        return textResult(`path ends in .${byName} but format is ${String(args.format)}: pass one or make them agree.`, true);
      const format = byName ?? (args.format as "srt" | "vtt" | undefined) ?? "srt";
      if (!path) path = join(v.dir, `${project.name.replace(/[/:\\]/g, "-").trim() || "Subtitles"}.${format}`);
      else if (!byName) path = `${path}.${format}`;
      // The agent writes inside the project folder only (real paths, as graphic_write); elsewhere is the user's Export dialog.
      const target = path;
      const inside = yield* Effect.promise(async () => {
        const project = await realpath(v.dir).catch(() => v.dir);
        const real = await canonicalPath(target);
        return real.startsWith(`${project}${sep}`);
      });
      if (!inside)
        return textResult(
          `subtitles_export saves inside the project folder only (${v.dir}). Pass a path in it, or leave path out; the user can save the subtitles anywhere from the Export dialog (Subtitles only).`,
          true,
        );
      const saved = yield* exporter.saveSubtitles({ output: path, overwrite: args.overwrite === true }).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (!saved.ok)
        return textResult(
          { refused: saved.error.message, ...(saved.error.reason === "exists" ? { note: "Pass overwrite: true to replace it, or another path." } : {}) },
          true,
        );
      const fps = project.canvas.fps;
      const cues = subtitleCues(project);
      return textResult({
        path: saved.value.path,
        format: saved.value.format,
        cues: saved.value.cues,
        first: cues
          .slice(0, 5)
          .map((c) => ({ from: c.from, to: c.to, time: `${subtitleTime(c.from, fps, format)} --> ${subtitleTime(c.to, fps, format)}`, text: c.text })),
        note: "Cue times are the edit's (after cuts), from the captions' cards and Subtitles tracks; the video export can also write this file next to the video or add a soft subtitle track.",
      });
    });

  const captionsMake = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const project = v.session.project;
      const fps = project.canvas.fps;
      // D215: an item on any track makes captions of its speech.
      const spoken = args.item !== undefined ? speechOfItem(project as Project, args.item) : undefined;
      if (spoken && "problem" in spoken) return textResult(spoken.problem, true);
      if (spoken && args.media !== undefined && args.media !== spoken.media)
        return textResult(`${String(args.item)}'s speech is ${spoken.media}, not ${String(args.media)}: pass one of them.`, true);
      let mediaId = spoken ? spoken.media : args.media;
      if (mediaId === undefined) {
        const heard = mediaHeardOnMain(project as Project);
        if (heard.length !== 1)
          return textResult(
            heard.length
              ? `Several media with sound are on the main track (${heard.join(", ")}): pass media.`
              : "No clip with sound is on the main track. Pass media or item, or put the talk on the timeline first.",
            true,
          );
        mediaId = heard[0];
      }
      if (typeof mediaId !== "string") return textResult("media must be a media id from project_read.", true);
      const m = project.media.find((x) => x.id === mediaId);
      if (!m)
        return textResult(
          `There's no media "${mediaId}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`,
          true,
        );
      if (m.kind === "image") return textResult(`${m.id} is a still image: there's no speech to caption.`, true);
      if (args.mode !== undefined && !["line", "word", "single"].includes(args.mode as string))
        return textResult('mode must be "line", "word" or "single".', true);
      if (args.look !== undefined && typeof args.look !== "string") return textResult("look must be a text-style module id, e.g. text.caption.", true);
      if (args.lines !== undefined && (typeof args.lines !== "object" || args.lines === null || Array.isArray(args.lines)))
        return textResult("lines must be an object (maxChars, maxLines, maxSeconds, maxWords, pause).", true);
      if (args.hideFillers !== undefined && typeof args.hideFillers !== "boolean") return textResult("hideFillers must be true or false.", true);
      const target = targetOf(v.dir, m, fps);
      const [answer] = yield* requestAndWait([{ target, analyzer: "transcript" }]);
      const { outcome, jobId } = answer!;
      if (!outcome) {
        const p = pendingOut(jobId);
        return textResult({
          media: m.id,
          transcript: p,
          note: `There's no transcript yet and it's still being made after ${Math.round(analyzeWaitMs() / 1000)} s. Call captions_make again with the same arguments (it joins the running job).`,
        });
      }
      if (outcome.state === "failed") return textResult({ media: m.id, transcript: { state: "failed", error: outcome.error } }, true);
      if (outcome.state === "cancelled") return textResult({ media: m.id, transcript: { state: "cancelled", note: cancelledNote } }, true);
      const result = outcome.result as TranscriptResult;
      if (!result.hasAudio || !result.words?.length)
        return textResult(`${m.id} has ${result.hasAudio ? "no speech in its transcript" : "no sound"}, so there's nothing to caption.`, true);
      const { silences, envelope } = yield* Effect.promise(() => silencesOf(target));
      const fresh = view();
      if (!fresh || fresh.openId !== r.openId) return textResult("The project was closed.", true);
      const plan = planMakeCaptions(fresh.session.project, {
        media: m.id,
        transcript: { words: result.words, language: result.language, seconds: result.seconds, segments: result.segments },
        silences,
        envelope,
        ...(args.mode !== undefined ? { mode: args.mode as CaptionMode } : {}),
        ...(args.look !== undefined ? { look: args.look as string } : {}),
        ...(args.lines !== undefined ? { lines: args.lines as CaptionLines } : {}),
        ...(args.hideFillers !== undefined ? { hideFillers: args.hideFillers as boolean } : {}),
      });
      if ("problem" in plan) return textResult(plan.problem, true);
      const outcome2 = yield* projects
        .agentEdit(r.openId, { turnId: r.turn.id, ops: plan.ops, baseRevision: fresh.session.revision, summary: plan.summary })
        .pipe(
          Effect.map((snapshot) => ({ ok: true as const, snapshot })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
      if (!outcome2.ok) {
        const now = view();
        const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
        return textResult(
          {
            refused: outcome2.error.message,
            details: outcome2.error.details,
            revision: now?.session.revision,
            ...(userChanges ? { userChanges } : {}),
            note: "No captions were made. Call captions_make again (it plans on the newest project).",
          },
          true,
        );
      }
      const { snapshot } = outcome2;
      const saved = snapshot.project as Project;
      const item = saved.tracks.flatMap((t) => t.items).find((i) => i.id === plan.itemId)!;
      const cards = captionCardList(saved, item);
      const mode = item.mode ?? "line";
      pushEdit(r, {
        revision: snapshot.revision,
        summary: plan.summary,
        lines: [
          `${plan.remade ? "Remade" : "Made"} ${mode === "word" ? "word-by-word " : mode === "single" ? "one-word " : ""}captions of ${m.name} (${cards.length} card${cards.length === 1 ? "" : "s"}, ${plan.words} words) as ${plan.itemId}${plan.fixesDropped ? `; ${plan.fixesDropped} fix${plan.fixesDropped === 1 ? "" : "es"} dropped (the transcript changed)` : ""}`,
        ],
      });
      persist(r.owner);
      publish();
      r.owner.seen.add(snapshot.revision);
      const now = view();
      const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
      return textResult({
        media: m.id,
        item: plan.itemId,
        remade: plan.remade,
        ...(plan.fixesDropped
          ? {
              fixesDropped: plan.fixesDropped,
              fixesNote:
                "The transcript changed since the captions were made, so their word fixes and forced card starts were dropped: redo them with edit_captions.",
            }
          : {}),
        mode,
        words: plan.words,
        cardCount: cards.length,
        cards: cards.slice(0, MAX_CAPTION_CARDS),
        revision: snapshot.revision,
        ...(item.anyTrack ? { follows: "every item that plays the media, on any track (it isn't heard through the main track)" } : {}),
        ...(cards.length
          ? {}
          : {
              notes: [
                item.anyTrack
                  ? "No speech of this media plays on the timeline yet, so no card shows."
                  : "No speech of this media plays on the main track yet, so no card shows.",
              ],
            }),
        note: `One edit on your turn (Undo turn reverts it). Frames are the edit's. Fix words with timeline_edit {"op":"edit_captions","item":"${plan.itemId}","words":[{"word":"w12","text":"…"}]}; look at a card with render_frames.`,
        ...(userChanges
          ? { userChanges, userNote: "The user changed the project since your read; the revision above includes their changes. Keep them." }
          : {}),
      });
    });

  return { transcriptRead, transcriptEdit, captionsMake, subtitlesExport };
};

export type TranscriptCtx = MediaCtx & ReturnType<typeof makeTranscriptTools>;
