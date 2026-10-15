// runTool: one Uncut tool call of the running turn; allowed: what the turn's access lets it do.
import type { BrandKit } from "@uncut/contracts";
import { brandColourRule, LAYOUT_RULES, MUSIC_TEMPOS, type Project, describeOp, type Op, pluginCheckRules, type MusicTempo, type Problem } from "@uncut/core";
import { friendlyText } from "@uncut/core/mentions";
import { expandPlacement, projectDiff, refusalFixes } from "@uncut/core/agentPlace";
import * as Effect from "effect/Effect";
import { gateOf, gateRefusal } from "../agentPlan.ts";
import { activeBrand } from "../../brand/store.ts";
import { bigChange, checksOut, FONT_ERRORS, expandArrangeOps, expandCaptionEdits, expandDeviceFrames, expandTextLooks, FRAME_WIDTH, LOOK_TOOLS, MAX_FRAMES, modulesList, musicOut, projectSummary } from "../agentTools.ts";
import { shaderForAgent } from "../../plugins/plugins.ts";
import { writeProjectShader } from "../agentShaders.ts";
import { expandShaderEffects } from "@uncut/core/shaders";
import { applyDeclared, appliedNote } from "../../capture/capture.ts";
import { type Running, pushEdit } from "../session/types.ts";
import { noteFor } from "../turns/notes.ts";
import { PHONE_WIDTH } from "./common.ts";
import type { McpResult } from "../agent.ts";
import type { LibraryCtx } from "./library.ts";

export const makeRunTool = (ctx: LibraryCtx) => {
  const { view, textResult, shaderDefsOf, format, plugins, exporter, stampOf, askUserTool, briefWrite, storyboardPropose, reviewSubmit, brandRead, brandWrite, referenceFrames, beatGridTool, mediaImport, mediaDownload, contactSheet, uiShow, brandDirs, fontsRule, rubricOf, musicAdd, librarySearch, libraryAdd, graphicWrite, generateMedia, screenRecord, argentBoot, mediaSearch, mediaAnalyze, mediaRank, transcriptRead, transcriptEdit, captionsMake, subtitlesExport, projects, persist, duckAnalysis, media, analysis, publish, askUser } = ctx;

  const runTool = (r: Running, name: string, args: Record<string, unknown>): Effect.Effect<McpResult> =>
    Effect.gen(function* () {
      const v = view();
      if (!v || v.openId !== r.openId) return textResult("The project was closed.", true);
      switch (name) {
        case "project_read": {
          r.owner.agentSeen = Math.max(r.owner.agentSeen, v.session.revision);
          r.owner.seen.add(v.session.revision);
          const range = args.range as { start: number; end: number } | undefined;
          return textResult(args.detail === "full" ? { revision: v.session.revision, project: v.session.project } : projectSummary(v.session.project, v.session.revision, range));
        }
        case "modules_list": {
          const kind = typeof args.kind === "string" ? args.kind : undefined;
          // D213: the shader effects there are (allowed plugins', the project's), each with its params.
          const shaders = kind === undefined || kind === "effect" ? [...(yield* shaderDefsOf(v)).values()].map((d) => ({ kind: "effect", module: "effect.shader", ...shaderForAgent({ id: d.id, name: d.name, description: d.description ?? "", params: d.params }), source: d.id.startsWith("project.") ? "project" : "plugin" })) : [];
          // The built-in modules, then the plugins (D97) with their source, approval and warnings.
          return textResult([...modulesList(format.modules, kind), ...shaders, ...(yield* plugins.modules(kind))]);
        }
        case "shader_write": {
          const out = yield* Effect.promise(() => writeProjectShader(v.dir, args as Parameters<typeof writeProjectShader>[1]));
          if (!out.ok) return textResult({ refused: out.problems.join(" ") }, true);
          const answer = {
            ok: true,
            id: out.def.id,
            file: out.file,
            ...(out.replaced ? { replaced: "It replaced the earlier file of that name; clips that have the effect keep the copy they carry until you apply it again." } : {}),
            params: out.def.params.map((p) => p.key),
            ...(out.note ? { note: out.note } : {}),
            next: `Apply it with timeline_edit: update_item set effects [...the clip's other effects, {"module":"effect.shader","params":{"shader":"${out.def.id}","values":{}}}] (Uncut fills in the code; one shader per clip). Then look with render_frames.`,
          };
          return out.png
            ? { content: [{ type: "text", text: JSON.stringify(answer) }, { type: "image", data: out.png.toString("base64"), mimeType: "image/png" }] }
            : textResult(answer);
        }
        case "render_frames": {
          const frames = Array.isArray(args.frames) ? args.frames : [];
          if (!frames.length || frames.length > MAX_FRAMES || !frames.every((f) => Number.isInteger(f) && f >= 0)) return textResult(`frames must be 1 to ${MAX_FRAMES} frame numbers (integers from 0).`, true);
          const canvas = v.session.project.canvas;
          // D189: phone true draws them 360 px wide, as in a feed on a phone.
          const scale = args.phone === true ? Math.min(1, PHONE_WIDTH / canvas.width) : typeof args.scale === "number" && args.scale > 0 && args.scale <= 1 ? args.scale : Math.min(1, FRAME_WIDTH / canvas.width);
          const width = Math.max(64, Math.round(canvas.width * scale));
          const rendered = yield* exporter.renderFrames(frames as Array<number>, width).pipe(
            Effect.map((list) => ({ ok: true as const, list })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
          );
          if (!rendered.ok) return textResult(`Couldn't render the frames: ${rendered.message}`, true);
          if (width <= PHONE_WIDTH + 40) r.looked.phone = true;
          r.rendered.push({ stamp: stampOf(r, v), frames: rendered.list.map((x) => x.frame) });
          const height = Math.round((width * canvas.height) / canvas.width / 2) * 2;
          // Frames past the last one are drawn as the last one: say so, not silently.
          const clamped = rendered.list.flatMap((r, i) => (r.frame !== frames[i] ? [`frame ${frames[i]} is past the last frame, so frame ${r.frame} is shown for it`] : []));
          // What a frame leaves out (a graphic it couldn't read, D78), once each.
          clamped.push(...new Set(rendered.list.flatMap((r) => r.notes ?? [])));
          return {
            content: [
              { type: "text", text: `Frame${rendered.list.length === 1 ? "" : "s"} ${rendered.list.map((r) => r.frame).join(", ")} of the edit (revision ${v.session.revision}) at ${Math.round(width / 2) * 2}×${height}, drawn as the export draws them, in that order.${clamped.length ? ` Note: ${clamped.join("; ")}.` : ""}` },
              ...rendered.list.map((r) => ({ type: "image" as const, data: r.jpeg.toString("base64"), mimeType: "image/jpeg" })),
            ],
          };
        }
        case "ask_user":
          return yield* askUserTool(r, args);
        case "brief_write":
          return yield* briefWrite(r, v, args);
        case "storyboard_propose":
          return yield* storyboardPropose(r, v, args);
        case "review_submit":
          return yield* reviewSubmit(r, v, args);
        case "brand_read":
          return yield* brandRead(v, args);
        case "brand_write":
          return yield* brandWrite(r, v, args);
        case "reference_frames":
          return yield* referenceFrames(v, args);
        case "beat_grid":
          return yield* beatGridTool(v, args);
        case "media_import":
          return yield* mediaImport(r, v, args);
        case "media_download":
          return yield* mediaDownload(r, v, args);
        case "contact_sheet": {
          const out = yield* contactSheet(v, args, (frames) => r.rendered.push({ stamp: stampOf(r, v), frames }));
          // D189: a sheet of the edit counts as the critic's look.
          if (args.media === undefined && !out.isError) r.looked.sheet = true;
          return out;
        }
        case "ui_show":
          return uiShow(r, v, args);
        case "project_check": {
          const rules = Array.isArray(args.rules) ? args.rules.filter((x): x is string => typeof x === "string") : undefined;
          if (args.severity !== undefined && args.severity !== "warn" && args.severity !== "info") return textResult('severity must be "warn" or "info".', true);
          // Its fixes are planned on this revision, so it may be passed back as baseRevision (the
          // user's edits stay news for the next note: agentSeen doesn't move).
          r.owner.seen.add(v.session.revision);
          // The allowed plugins' rules too (D103): data rules run here, process plugins are asked (5 s each).
          const contributed = yield* plugins.contributions;
          const asked = yield* plugins.processChecks(v.session.project, v.dir);
          // D186: with a brand kit, its colours are a rule too.
          const kit: BrandKit | undefined = (yield* Effect.promise(() => activeBrand(brandDirs(v)).catch(() => undefined)))?.kit;
          const brandRules = kit && kit.colors.length ? [brandColourRule(kit.name, [...kit.colors.map((c) => c.hex), ...(kit.style?.palette.map((c) => c.hex) ?? [])])] : [];
          // D198: fonts that aren't there are an error, not a silent fallback.
          const fonts = yield* fontsRule(v);
          // D217: the sound rule follows the video's sound profile; what the user marked Intended stays out.
          const rubric = yield* rubricOf(v);
          return textResult(checksOut(v.session.project as Project, v.session.revision, { rules, severity: args.severity as string | undefined }, { rules: [...pluginCheckRules(contributed.rules), ...brandRules, ...LAYOUT_RULES, fonts], found: asked.checks, notes: asked.notes, errors: FONT_ERRORS, sound: rubric.sound, intended: r.owner.plan.intended ?? [] }));
        }
        case "music_list": {
          if (args.tempo !== undefined && !(MUSIC_TEMPOS as ReadonlyArray<unknown>).includes(args.tempo)) return textResult(`tempo must be one of ${MUSIC_TEMPOS.join(", ")}.`, true);
          return textResult(musicOut(v.session.project as Project, { mood: typeof args.mood === "string" ? args.mood : undefined, tempo: args.tempo as MusicTempo | undefined, query: typeof args.query === "string" ? args.query : undefined }));
        }
        case "music_add":
          return yield* musicAdd(r, v, args);
        case "library_search":
          return yield* librarySearch(args);
        case "library_add":
          return yield* libraryAdd(r, v, args);
        case "graphic_write": {
          const out = yield* graphicWrite(v, args);
          if (!out.isError) {
            r.graphicWrites++;
            // D206: the agent's own graphics, the only ones the turn-end clean-up may move.
            if (typeof args.name === "string") r.turn.graphics = [...new Set([...(r.turn.graphics ?? []), args.name])].slice(-200);
          }
          return out;
        }
        case "generate_media":
          return yield* generateMedia(r, v, args);
        case "screen_record":
          return yield* screenRecord(r, v, args);
        case "argent_boot":
          return yield* argentBoot(r, args);
        case "media_search":
          return yield* mediaSearch(args);
        case "media_analyze":
          return yield* mediaAnalyze(v, args);
        case "media_rank":
          return yield* mediaRank(v, args);
        case "transcript_read":
          return yield* transcriptRead(v, args);
        case "transcript_edit":
          return yield* transcriptEdit(r, v, args);
        case "captions_make":
          return yield* captionsMake(r, v, args);
        case "subtitles_export":
          return yield* subtitlesExport(v, args);
        case "timeline_edit": {
          // D188: once a brief exists, the build waits for an approved storyboard.
          // D206: a dry run checks the edit and changes nothing, so the storyboard gate doesn't apply.
          const dryRun = args.dryRun === true;
          const gated = dryRun ? undefined : gateRefusal(r.owner.plan, gateOf(r.owner.plan, r.skipStoryboard));
          if (gated) return textResult(gated, true);
          const { baseRevision, summary } = args;
          if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision)) return textResult("Pass baseRevision: the revision from your last project_read.", true);
          if (!Array.isArray(args.ops)) return textResult("ops must be a list of edit ops.", true);
          // insert_device_frame (D76) becomes the edit ops that make it (tracks, the screen clip, the frame).
          const expanded = expandDeviceFrames(v.session.project as Project, args.ops);
          if ("problem" in expanded) return textResult({ refused: expanded.problem, revision: v.session.revision }, true);
          // insert_text (D80) becomes the inserts (and text tracks) of a text in a look.
          const pluginLooks = Object.fromEntries((yield* plugins.contributions).looks.map((l) => [l.id, l]));
          const texts = expandTextLooks(v.session.project as Project, expanded.ops, pluginLooks);
          if ("problem" in texts) return textResult({ refused: texts.problem, revision: v.session.revision }, true);
          // edit_captions (D82) becomes the update_item of the captions it changes.
          const captions = expandCaptionEdits(v.session.project as Project, texts.ops);
          if ("problem" in captions) return textResult({ refused: captions.problem, revision: v.session.revision }, true);
          // detach_audio (D123) and set_speed (D125) become the item ops that do them.
          const arranged = expandArrangeOps(v.session.project as Project, captions.ops);
          if ("problem" in arranged) return textResult({ refused: arranged.problem, revision: v.session.revision }, true);
          // D206: place_item (overlaps resolved as asked) and set_transition's allowTrim.
          const placed = expandPlacement(v.session.project as Project, arranged.ops);
          if ("problem" in placed) return textResult({ refused: placed.problem, revision: v.session.revision }, true);
          // D213: effect.shader entries named by id get their definition (a plugin's or the project's).
          const shaded = expandShaderEffects(placed.ops, yield* shaderDefsOf(v));
          if ("problem" in shaded) return textResult({ refused: shaded.problem, revision: v.session.revision }, true);
          const ops = shaded.ops;
          const placements = placed.notes.length ? { placed: placed.notes } : {};
          if (!r.owner.seen.has(baseRevision)) {
            return textResult(
              { refused: `baseRevision ${baseRevision} isn't a revision you read in this session. Call project_read and edit from what it returns.`, revision: v.session.revision },
              true,
            );
          }
          const line = typeof summary === "string" && summary.trim() ? summary.trim() : "Edited the timeline";
          const outcome = yield* projects.agentEdit(r.openId, { turnId: r.turn.id, ops, baseRevision, summary: line, dryRun }).pipe(
            Effect.map((snapshot) => ({ ok: true as const, snapshot })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );
          if (!outcome.ok) {
            const now = view();
            const userChanges = now ? noteFor(now, baseRevision) : "";
            // D206: each problem with a concrete fix (a start frame, a track, an id, the missing frames).
            const details = "details" in outcome.error && Array.isArray(outcome.error.details) ? refusalFixes(v.session.project as Project, ops, outcome.error.details as ReadonlyArray<Problem>) : [];
            const fixes = [...new Set(details.flatMap((d) => (d.fix ? [d.fix] : [])))];
            return textResult(
              {
                ...(dryRun ? { dryRun: true } : {}),
                refused: outcome.error.message,
                details: details.length ? details : "details" in outcome.error ? outcome.error.details : [],
                ...(fixes.length ? { fix: fixes.slice(0, 6).join(" ") } : {}),
                revision: now?.session.revision,
                ...(userChanges ? { userChanges } : {}),
              },
              true,
            );
          }
          const { snapshot } = outcome;
          if (dryRun) {
            // D206: what the edit would do, nothing saved: the ops after the convenience ops are
            // expanded, each as a line, the items it adds, removes or moves, and the new length.
            const planned = snapshot.project as Project;
            const end = projectSummary(planned, snapshot.revision).duration;
            return textResult({
              dryRun: true,
              ok: true,
              revision: v.session.revision,
              ops,
              lines: (ops as ReadonlyArray<Op>).map((op) => {
                try {
                  return describeOp(op, planned);
                } catch {
                  return String((op as { op?: unknown }).op ?? "edit");
                }
              }),
              diff: projectDiff(v.session.project as Project, planned),
              ...placements,
              duration: end,
              seconds: Number((end / planned.canvas.fps).toFixed(2)),
              note: "Nothing changed. Send the same edit without dryRun to make it.",
            });
          }
          const project = snapshot.project as Project;
          const lines = (ops as ReadonlyArray<Op>).map((op) => {
            try {
              return describeOp(op, project);
            } catch {
              return String((op as { op?: unknown }).op ?? "edit");
            }
          });
          pushEdit(r, { revision: snapshot.revision, summary: line, lines });
          // D206: tracks it made, for the turn-end clean-up.
          for (const op of ops as ReadonlyArray<Op>) if (op.op === "add_track" && typeof (op.track as { id?: unknown }).id === "string") r.addedTracks.add((op.track as { id: string }).id);
          persist(r.owner);
          // agentSeen doesn't move: user edits made since the agent's last read (they didn't
          // touch what this edit touched, or it would have been refused) are still news. They
          // come back with the result; with none, the new revision is as good as read.
          const now = view();
          const userChanges = now ? noteFor(now, baseRevision) : "";
          if (!userChanges) r.owner.seen.add(snapshot.revision);
          const end = projectSummary(project, snapshot.revision).duration;
          // Ducking (D85) needs its key media's loudness: a mixer change starts the analysis
          // where it's missing (waits up to SILENCES_WAIT_MS, as transcript_edit) and says so.
          const ducking = (ops as ReadonlyArray<Op>).some((op) => op.op === "update_track" && "mixer" in op.set) ? yield* Effect.promise(() => duckAnalysis(v.dir, project)) : undefined;
          return textResult({
            ok: true,
            revision: snapshot.revision,
            ...placements,
            duration: end,
            seconds: Number((end / project.canvas.fps).toFixed(2)),
            ...(ducking ? { ducking } : {}),
            ...(userChanges ? { userChanges, note: "The user changed the project since your read. project_read before your next edit." } : {}),
          });
        }
        default: {
          // A plugin's tool (D97): forwarded to its process; it returns data, never edits.
          const result = yield* plugins.call(name, args, r.abort.signal, v.dir);
          if (!result) return textResult(`Unknown tool ${name}`, true);
          const { declared, structured: _structured, plugin, ...out } = result;
          if (!declared || out.isError) return out;
          // ...except what it declares for Uncut (D98): a recording to import, a re-shot take to
          // swap in. Uncut does that as an edit of this turn (Undo turn takes it back).
          const applied = yield* Effect.uninterruptible(applyDeclared({ declared, plugin, openId: r.openId, dir: v.dir, turnId: r.turn.id, media, analysis }));
          if (!applied) return out;
          if ("problem" in applied) return { content: [...out.content, { type: "text" as const, text: applied.problem }], isError: true };
          const snapshot = applied.result.snapshot;
          if (snapshot) {
            const project = snapshot.project as Project;
            const lines =
              applied.kind === "imported"
                ? applied.result.entries.map((entry) => describeOp({ op: "add_media", media: entry } as Op, project))
                : [...(applied.result.ops as ReadonlyArray<Op>).map((op) => describeOp(op, project)), ...applied.result.warnings];
            const summary = applied.kind === "imported" ? `Recorded ${applied.result.entries[0]?.name ?? "a take"}` : `Re-shot ${applied.result.entry.name}`;
            pushEdit(r, { revision: snapshot.revision, summary, lines });
            persist(r.owner);
            publish();
            r.owner.seen.add(snapshot.revision);
          }
          const fps = ((snapshot?.project ?? v.session.project) as Project).canvas.fps;
          return { ...out, content: [...out.content, { type: "text" as const, text: JSON.stringify(appliedNote(applied, fps), null, 1) }] };
        }
      }
    });

  /**
   * D184: the turn's access. "look": only the tools that read and look (LOOK_TOOLS) run, the
   * rest are refused with why; "ask": a big change (bigChange) waits for Allow on a card first;
   * "auto": everything (spending over $1 still asks, D99). undefined = go ahead.
   */
  const allowed = (r: Running, tool: string, input: Record<string, unknown>): Effect.Effect<McpResult | undefined> =>
    Effect.gen(function* () {
      if (r.access === "auto") return undefined;
      if (r.access === "look") {
        if ((LOOK_TOOLS as ReadonlyArray<string>).includes(tool)) return undefined;
        // D206: a timeline_edit dry run changes nothing.
        if (tool === "timeline_edit" && input.dryRun === true) return undefined;
        return textResult(`Not done: the user set this chat to "Look only", so you can read and look but not change anything (${tool} refused). Say what you would do instead; they can switch to "Auto" or "Ask first" in the composer.`, true);
      }
      const v = view();
      const big = v ? bigChange(tool, input, v.session.project as Project) : undefined;
      if (!big) return undefined;
      const answer = yield* askUser(r, big.text, 0, undefined, undefined, { lines: big.lines.map((l) => friendlyText(v?.session.project as Project, l)) });
      if (answer === "allow") return undefined;
      return textResult(
        answer === "stopped" ? "The turn was stopped." : `Not done: the user ${answer === "timeout" ? "didn't answer" : "said no"} to "${big.text}" (this chat asks before big changes). Don't try it again in this turn; say what you'd change and ask.`,
        true,
      );
    });

  return { allowed, runTool };
};

export type RunCtx = LibraryCtx & ReturnType<typeof makeRunTool>;
