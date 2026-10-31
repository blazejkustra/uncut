// runTool: one Uncut tool call of the running turn; allowed: what the turn's access lets it do.
import type { BrandKit } from "@uncut/contracts";
import {
  brandColourRule,
  LAYOUT_RULES,
  type Project,
  describeOp,
  layout,
  type Op,
  pluginCheckRules,
  type Problem,
  retimeNotes,
  withGraphicRetime,
} from "@uncut/core";
import { friendlyText } from "@uncut/core/mentions";
import { expandPlacement, projectDiff, refusalFixes } from "@uncut/core/agentPlace";
import * as Effect from "effect/Effect";
import { planOnly } from "../agentPlan.ts";
import { activeBrand, readPlan } from "../../brand/store.ts";
import {
  bigChange,
  checksOut,
  FONT_ERRORS,
  expandArrangeOps,
  expandCaptionEdits,
  expandDeviceFrames,
  expandTextLooks,
  MAX_LOOSE_FRAMES,
  LOOK_TOOLS,
  MAX_FRAMES,
  MAX_RUN,
  modulesIndex,
  modulesList,
  projectSummary,
  docsRead,
} from "../agentTools.ts";
import { shaderForAgent } from "../../plugins/plugins.ts";
import { loadGraphicLibs } from "../../export/graphicLibs.ts";
import { writeProjectShader } from "../agentShaders.ts";
import { expandShaderEffects } from "@uncut/core/shaders";
import { applyDeclared, appliedNote } from "../../capture/capture.ts";
import { type Running, pushEdit } from "../session/types.ts";
import { noteFor, noteShowsAll } from "../turns/notes.ts";
import { shapeHint, unknownOp } from "./opShapes.ts";
import { PHONE_WIDTH, frameScale } from "./common.ts";
import { rehearsalLine } from "../../export/exporter/rehearse.ts";
import { legibilityNote } from "../agentLegibility.ts";
import { makeExportVideo } from "./exportVideo.ts";
import { clock, frameSheetLayout, sheetLayout } from "../agentFootage.ts";
import { jitterFindings, measureRun } from "../motionJitter.ts";
import { peekProject } from "./peek.ts";
import { which } from "../../app/setup.ts";
import { graphicElementsOf } from "../../export/graphicElements.ts";
import { elementEditOp, elementRows, graphicItem, type ElementEditArgs } from "./graphicElements.ts";
import type { ProjectView } from "../../project/projects.ts";

/** How long render_frames may spend rehearsing the export's graphics (ms; a rehearsal that passed isn't run again). */
export const REHEARSE_RENDER_MS = 15_000;
import type { McpResult } from "../agent.ts";
import type { LibraryCtx } from "./library.ts";

/** D285: a dry run's line per op is cut at this many characters. */
const DRY_LINE = 200;

export const makeRunTool = (ctx: LibraryCtx) => {
  const {
    view,
    textResult,
    shaderDefsOf,
    format,
    plugins,
    exporter,
    stampOf,
    askUserTool,
    briefWrite,
    storyboardPropose,
    reviewSubmit,
    brandRead,
    brandWrite,
    skillRead,
    referenceFrames,
    beatGridTool,
    mediaImport,
    mediaDownload,
    contactSheet,
    uiShow,
    brandDirs,
    fontsRule,
    rubricOf,
    librarySearch,
    libraryAdd,
    graphicWrite,
    keysSet,
    generateMedia,
    screenRecord,
    argentBoot,
    mediaSearch,
    mediaAnalyze,
    measure,
    mediaRank,
    transcriptRead,
    transcriptEdit,
    captionsMake,
    subtitlesExport,
    projects,
    persist,
    duckAnalysis,
    media,
    analysis,
    publish,
    askUser,
    config,
    readerOf,
    seeOwn,
  } = ctx;

  const exportVideo = makeExportVideo(ctx);

  const sheetCells = (list: ReadonlyArray<{ jpeg: Buffer; frame: number }>, fps: number) =>
    list.map((f, i) => ({ jpeg: f.jpeg, caption: `${i + 1}   f ${f.frame}   ${clock(f.frame / fps)}` }));
  const cellLines = (list: ReadonlyArray<{ frame: number }>, fps: number) => list.map((f, i) => `${i + 1}: frame ${f.frame} (${clock(f.frame / fps)})`);

  // render_frames' run: consecutive frames at the canvas size (a pixel of motion only shows there),
  // shown as one contact sheet, with the shakes and edge slivers measured on them.
  const renderRun = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const run = args.run as { start?: unknown; count?: unknown } | null;
      if (args.frames !== undefined) return textResult("Pass frames or run, not both.", true);
      if (
        !run ||
        typeof run !== "object" ||
        !Number.isInteger(run.start) ||
        (run.start as number) < 0 ||
        !Number.isInteger(run.count) ||
        (run.count as number) < 2 ||
        (run.count as number) > MAX_RUN
      ) {
        return textResult(`run must be { start, count }: a frame from 0 and 2 to ${MAX_RUN} frames.`, true);
      }
      const project = v.session.project;
      const { width, height, fps } = project.canvas;
      const { duration } = layout(project);
      const start = run.start as number;
      if (start >= duration) return textResult(`The edit is ${duration} frames long; the run starts after its end.`, true);
      const frames = Array.from({ length: Math.min(run.count as number, duration - start) }, (_, i) => start + i);
      const rendered = yield* exporter
        .frameSession((session) =>
          Effect.gen(function* () {
            const list = yield* session.render(frames, width);
            const sheet = yield* session.sheet(
              list.map((f) => ({ jpeg: f.jpeg, caption: `f ${f.frame}   ${clock(f.frame / fps)}` })),
              sheetLayout(list.length, width / height),
            );
            return { list, sheet };
          }),
        )
        .pipe(
          Effect.map((x) => ({ ok: true as const, ...x })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
        );
      if (!rendered.ok) return textResult(`Couldn't render the frames: ${rendered.message}`, true);
      r.rendered.push({ stamp: stampOf(r, v), frames: rendered.list.map((x) => x.frame) });
      const ffmpeg = yield* Effect.promise(async () => (await config.shellReady, which("ffmpeg", process.env.PATH ?? "")));
      const measured = ffmpeg
        ? yield* Effect.tryPromise(() => measureRun(ffmpeg, rendered.list, width, height)).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined;
      const findings = measured ? jitterFindings(measured.shakes, measured.slivers, fps).map((f) => f.message) : [];
      const verdict = !measured
        ? "The motion couldn't be measured (ffmpeg isn't there or couldn't read the frames)."
        : findings.length
          ? `Measured at ${width}×${height}: ${findings.join(" ")}`
          : `Measured at ${width}×${height}: no text shaking by a pixel and no 1 px line along the frame's edges.`;
      const last = frames[frames.length - 1]!;
      return {
        content: [
          {
            type: "text" as const,
            text: `Frames ${start} to ${last} of the edit (revision ${v.session.revision}), every frame, as one contact sheet read left to right, top to bottom, drawn as the export draws them.${last < start + (run.count as number) - 1 ? ` The edit ends at frame ${duration - 1}.` : ""} ${verdict}`,
          },
          { type: "image" as const, data: rendered.sheet.toString("base64"), mimeType: "image/jpeg" },
        ],
      };
    });

  const runTool = (r: Running, name: string, args: Record<string, unknown>): Effect.Effect<McpResult> =>
    Effect.gen(function* () {
      const v = view();
      if (!v || v.openId !== r.openId) return textResult("The project was closed.", true);
      switch (name) {
        case "project_read": {
          r.owner.agentSeen = Math.max(r.owner.agentSeen, v.session.revision);
          r.owner.seen.add(v.session.revision);
          const range = args.range as { start: number; end: number } | undefined;
          const items = Array.isArray(args.items) ? args.items.filter((x): x is string => typeof x === "string").slice(0, 100) : undefined;
          return textResult(
            JSON.stringify(
              args.detail === "full"
                ? { revision: v.session.revision, project: v.session.project }
                : projectSummary(v.session.project, v.session.revision, range, {
                    ...(args.detail === "items" ? { detail: "items" as const } : {}),
                    ...(items ? { items } : {}),
                  }),
            ),
          );
        }
        case "modules_list": {
          const kind = typeof args.kind === "string" ? args.kind : undefined;
          // D213: the shader effects there are (allowed plugins', the project's), each with its params.
          const shaders =
            kind === undefined || kind === "effect"
              ? [...(yield* shaderDefsOf(v)).values()].map((d) => ({
                  kind: "effect",
                  module: "effect.shader",
                  ...shaderForAgent({ id: d.id, name: d.name, description: d.description ?? "", params: d.params }),
                  source: d.id.startsWith("project.") ? "project" : "plugin",
                }))
              : [];
          // The built-in modules, then the plugins (D97) with their source, approval and warnings.
          const listed = [...modulesList(format.modules, kind), ...shaders, ...(yield* plugins.modules(kind))] as ReadonlyArray<Record<string, unknown>>;
          // D285: ids gives just those modules whole; no kind and no ids an index (id: purpose by kind), not ~70k of manifests.
          const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : undefined;
          if (ids?.length) {
            const found = listed.filter((m) => ids.includes(m.id as string));
            const missing = ids.filter((id) => !found.some((m) => m.id === id));
            return textResult(
              missing.length ? { modules: found, unknown: missing, note: "modules_list without arguments lists every id." } : found,
              !found.length,
            );
          }
          if (kind === undefined) return textResult({ ...modulesIndex(listed), keys: yield* keysSet });
          return textResult(kind === "generator" ? { modules: listed, keys: yield* keysSet } : listed);
        }
        case "shader_write": {
          const out = yield* Effect.promise(() => writeProjectShader(v.dir, args as Parameters<typeof writeProjectShader>[1]));
          if (!out.ok) return textResult({ refused: out.problems.join(" ") }, true);
          const answer = {
            ok: true,
            id: out.def.id,
            file: out.file,
            ...(out.replaced
              ? { replaced: "It replaced the earlier file of that name; clips that have the effect keep the copy they carry until you apply it again." }
              : {}),
            params: out.def.params.map((p) => p.key),
            ...(out.note ? { note: out.note } : {}),
            next: `Apply it with timeline_edit: update_item set effects [...the clip's other effects, {"module":"effect.shader","params":{"shader":"${out.def.id}","values":{}}}] (Uncut fills in the code; one shader per clip). Then look with render_frames.`,
          };
          return out.png
            ? {
                content: [
                  { type: "text", text: JSON.stringify(answer) },
                  { type: "image", data: out.png.toString("base64"), mimeType: "image/png" },
                ],
              }
            : textResult(answer);
        }
        case "render_frames": {
          if (args.run !== undefined) return yield* renderRun(r, v, args);
          const frames = Array.isArray(args.frames) ? args.frames : [];
          if (!frames.length || frames.length > MAX_FRAMES || !frames.every((f) => Number.isInteger(f) && f >= 0))
            return textResult(`frames must be 1 to ${MAX_FRAMES} frame numbers (integers from 0).`, true);
          const canvas = v.session.project.canvas;
          // D189: phone true draws them 360 px wide, as in a feed on a phone.
          const scale = frameScale(canvas, frames.length, args.scale, args.phone === true);
          const grid =
            frames.length > MAX_LOOSE_FRAMES && args.sheet !== false && args.phone !== true
              ? frameSheetLayout(frames.length, canvas.width / canvas.height)
              : undefined;
          const width = grid ? grid.cellWidth : Math.max(64, Math.round(canvas.width * scale));
          // The frames, then the export's graphics rehearsed on the same rasteriser (every frame in
          // order, as the export runs them): a graphic that breaks only on a long run shows here.
          const rendered = yield* exporter
            .frameSession((session) =>
              Effect.gen(function* () {
                const list = yield* session.render(frames as Array<number>, width, { census: true });
                const rehearsal = yield* session.rehearse(REHEARSE_RENDER_MS).pipe(Effect.catch(() => Effect.succeed(undefined)));
                const sheet = grid ? yield* session.sheet(sheetCells(list, canvas.fps), grid) : undefined;
                return { list, rehearsal, sheet };
              }),
            )
            .pipe(
              Effect.map((x) => ({ ok: true as const, ...x })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
            );
          if (!rendered.ok) return textResult(`Couldn't render the frames: ${rendered.message}`, true);
          if (!grid && width <= PHONE_WIDTH + 40) r.looked.phone = true;
          r.rendered.push({ stamp: stampOf(r, v), frames: rendered.list.map((x) => x.frame) });
          const height = Math.round((width * canvas.height) / canvas.width / 2) * 2;
          // Frames past the last one are drawn as the last one: say so, not silently.
          const clamped = rendered.list.flatMap((r, i) =>
            r.frame !== frames[i] ? [`frame ${frames[i]} is past the last frame, so frame ${r.frame} is shown for it`] : [],
          );
          // What a frame leaves out (a graphic it couldn't read, D78), once each.
          clamped.push(...new Set(rendered.list.flatMap((r) => r.notes ?? [])));
          const rehearsal = rendered.rehearsal?.failure ? ` ${rehearsalLine(rendered.rehearsal)}` : "";
          const legible = legibilityNote(rendered.list, canvas.height, canvas.fps);
          if (grid && rendered.sheet)
            return {
              content: [
                {
                  type: "text",
                  text: `One sheet of ${rendered.list.length} frames of the edit (revision ${v.session.revision}), ${grid.columns} columns, ${grid.width}×${grid.height}, each cell ${grid.cellWidth}×${grid.cellHeight} and labelled with its frame and time, read left to right, top to bottom, drawn as the export draws them. For one frame bigger: render_frames {frames:[n]} (add scale:1 for full size); for every frame as its own image: the same call with sheet:false.${clamped.length ? ` Note: ${clamped.join("; ")}.` : ""}${rehearsal}${legible ? ` ${legible}` : ""}\n${cellLines(rendered.list, canvas.fps).join("\n")}`,
                },
                { type: "image", data: rendered.sheet.toString("base64"), mimeType: "image/jpeg" },
              ],
            };
          return {
            content: [
              {
                type: "text",
                text: `Frame${rendered.list.length === 1 ? "" : "s"} ${rendered.list.map((r) => r.frame).join(", ")} of the edit (revision ${v.session.revision}) at ${Math.round(width / 2) * 2}×${height}, drawn as the export draws them, in that order.${clamped.length ? ` Note: ${clamped.join("; ")}.` : ""}${rehearsal}${legible ? ` ${legible}` : ""}`,
              },
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
        case "project_peek": {
          if (r.owner.webUsed && r.access !== "auto")
            return textResult("Not done: after web content, other projects are read only on the user's say. Read the file with Read, which asks them.", true);
          const peeked = yield* Effect.promise(() =>
            peekProject({
              project: typeof args.project === "string" ? args.project : "",
              graphic: typeof args.graphic === "string" ? args.graphic : undefined,
              current: v.dir,
              dataDir: config.dataDir,
            }),
          );
          return "problem" in peeked ? textResult(peeked.problem as string, true) : textResult(peeked);
        }
        case "plan_read": {
          // D266: the brief, storyboard and last review with its defect ids, read back (a message
          // says "Unchanged" for them, and a compacted conversation may have lost them).
          const plan = yield* Effect.promise(() => readPlan(v.dir).catch(() => r.owner.plan));
          r.owner.plan = plan;
          return textResult(planOnly(plan) || "Nothing is planned: no brief, storyboard or review yet.");
        }
        case "skill_read":
          return yield* skillRead(v, args);
        case "docs_read": {
          // D260 (issue #81): an area's reference, on demand instead of in the system prompt.
          // The graphics topic lists the bundled libraries; library gives one's API, from the file Uncut inlines.
          const libs = args.topic === "graphics" ? yield* Effect.promise(() => loadGraphicLibs(config.graphicLibsDir).catch(() => undefined)) : undefined;
          const doc = docsRead(args.topic, libs, args.library);
          return textResult(doc.text, doc.isError);
        }
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
          if (args.severity !== undefined && args.severity !== "warn" && args.severity !== "info")
            return textResult('severity must be "warn" or "info".', true);
          // Its fixes are planned on this revision, so it may be passed back as baseRevision when
          // nobody else changed the project since the agent's last look (C12: else it reads again).
          seeOwn(r, v.session.revision);
          // The allowed plugins' rules too (D103): data rules run here, process plugins are asked (5 s each).
          const contributed = yield* plugins.contributions;
          const asked = yield* plugins.processChecks(v.session.project, v.dir);
          // D186: with a brand kit, its colours are a rule too.
          const kit: BrandKit | undefined = (yield* Effect.promise(() => activeBrand(brandDirs(v)).catch(() => undefined)))?.kit;
          const brandRules =
            kit && kit.colors.length ? [brandColourRule(kit.name, [...kit.colors.map((c) => c.hex), ...(kit.style?.palette.map((c) => c.hex) ?? [])])] : [];
          // D198: fonts that aren't there are an error, not a silent fallback.
          const fonts = yield* fontsRule(v);
          // D217: the sound rule follows the video's sound profile; what the user marked Intended stays out.
          const rubric = yield* rubricOf(v, r);
          return textResult(
            checksOut(
              v.session.project as Project,
              v.session.revision,
              { rules, severity: args.severity as string | undefined },
              {
                rules: [...pluginCheckRules(contributed.rules), ...brandRules, ...LAYOUT_RULES, fonts],
                found: asked.checks,
                notes: asked.notes,
                errors: FONT_ERRORS,
                sound: rubric.sound,
                intended: r.owner.plan.intended ?? [],
              },
            ),
          );
        }
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
        case "graphic_elements":
        case "graphic_element_edit": {
          const project = v.session.project as Project;
          const placed = graphicItem(project, args.item);
          if ("problem" in placed) return textResult(placed.problem, true);
          const bin = yield* Effect.promise(async () => {
            await config.shellReady;
            return which("ffmpeg", process.env.PATH ?? "");
          });
          const found = yield* Effect.promise(() => graphicElementsOf(config, bin, v.dir, project, placed.item.src!));
          if (name === "graphic_elements")
            return textResult({
              item: placed.item.id,
              src: placed.item.src,
              revision: v.session.revision,
              ...(found.reason ? { reason: found.reason } : {}),
              elements: elementRows(found, placed.item, placed.start),
            });
          if (!Array.isArray(args.edits) || !args.edits.length) return textResult("edits must list at least one element.", true);
          const planned = elementEditOp(found, placed.item, placed.start, args.edits as ReadonlyArray<ElementEditArgs>);
          if ("problem" in planned) return textResult(found.reason ?? planned.problem, true);
          return yield* runTool(r, "timeline_edit", {
            baseRevision: args.baseRevision,
            summary: args.summary ?? "Edited the graphic's elements",
            ops: [planned.op],
          });
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
        case "measure":
          if (args.what === "position") r.measuredPosition = true;
          return yield* measure(v, args);
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
        case "export_video":
          return yield* exportVideo(r, v, args);
        case "timeline_edit": {
          const dryRun = args.dryRun === true;
          const { baseRevision, summary } = args;
          if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision))
            return textResult("Pass baseRevision: the revision from your last project_read.", true);
          if (!Array.isArray(args.ops)) return textResult("ops must be a list of edit ops.", true);
          // D285: the tool list carries the convenience ops loosely, so every op is checked here
          // (and by the expanders and core validateOps); a refusal names the shape of the ops it names.
          const refuse = (problem: string) => {
            const shapes = shapeHint(problem);
            return textResult({ refused: problem, ...(shapes ? { shapes } : {}), revision: v.session.revision }, true);
          };
          const unknown = unknownOp(args.ops);
          if (unknown) return refuse(unknown);
          // insert_device_frame (D76) becomes the edit ops that make it (tracks, the screen clip, the frame).
          const expanded = expandDeviceFrames(v.session.project as Project, args.ops);
          if ("problem" in expanded) return refuse(expanded.problem);
          // insert_text (D80) becomes the inserts (and text tracks) of a text in a look.
          const pluginLooks = Object.fromEntries((yield* plugins.contributions).looks.map((l) => [l.id, l]));
          const texts = expandTextLooks(v.session.project as Project, expanded.ops, pluginLooks);
          if ("problem" in texts) return refuse(texts.problem);
          // edit_captions (D82) becomes the update_item of the captions it changes.
          const captions = expandCaptionEdits(v.session.project as Project, texts.ops);
          if ("problem" in captions) return refuse(captions.problem);
          // detach_audio (D123), set_speed (D125) and replace_range (issue #118) become the item ops that do them.
          const arranged = expandArrangeOps(v.session.project as Project, captions.ops);
          if ("problem" in arranged) return refuse(arranged.problem);
          // D206: place_item (overlaps resolved as asked) and set_transition's allowTrim.
          const placed = expandPlacement(v.session.project as Project, arranged.ops);
          if ("problem" in placed) return refuse(placed.problem);
          // D213: effect.shader entries named by id get their definition (a plugin's or the project's).
          const shaded = expandShaderEffects(placed.ops, yield* shaderDefsOf(v));
          if ("problem" in shaded) return refuse(shaded.problem);
          // C6: graphics a ripple cut runs through lose the same stretch of their own time.
          const retime = withGraphicRetime(v.session.project as Project, shaded.ops as ReadonlyArray<Op>);
          const ops = retime.ops;
          const placements = placed.notes.length ? { placed: placed.notes } : {};
          const retimed = retime.retimed.length ? { graphicsRetimed: retimeNotes(retime.retimed, v.session.project.canvas.fps) } : {};
          if (!r.owner.seen.has(baseRevision)) {
            return textResult(
              {
                refused: `baseRevision ${baseRevision} isn't a revision you were given in this session (by project_read, an edit's result, the turn's note or a refusal). Call project_read and edit from what it returns.`,
                revision: v.session.revision,
              },
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
            const userChanges = now ? noteFor(now, baseRevision, readerOf(r.owner)) : "";
            // The refusal gives the revision now and what the user changed since the agent's base: it
            // may edit from there when that shows every change (D6: else it reads again).
            if (now && noteShowsAll(now, baseRevision)) r.owner.seen.add(now.session.revision);
            // D206: each problem with a concrete fix (a start frame, a track, an id, the missing frames).
            const details =
              "details" in outcome.error && Array.isArray(outcome.error.details)
                ? refusalFixes(v.session.project as Project, ops, outcome.error.details as ReadonlyArray<Problem>)
                : [];
            const fixes = [...new Set(details.flatMap((d) => (d.fix ? [d.fix] : [])))];
            const shapes = shapeHint(...details.filter((d) => d.code === "schema" || d.code === "unknown-op").map((d) => d.message));
            return textResult(
              {
                ...(dryRun ? { dryRun: true } : {}),
                refused: outcome.error.message,
                details: details.length ? details : "details" in outcome.error ? outcome.error.details : [],
                ...(fixes.length ? { fix: fixes.slice(0, 6).join(" ") } : {}),
                ...(shapes ? { shapes } : {}),
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
              // D285: not the ops themselves (the model sent them; a keyframed update echoed 20k
              // chars back): one line per planned op, convenience ops expanded, says what runs; a long
              // line (every key time of a shake) cut at DRY_LINE chars.
              lines: (ops as ReadonlyArray<Op>).map((op) => {
                let line: string;
                try {
                  line = describeOp(op, planned);
                } catch {
                  line = String((op as { op?: unknown }).op ?? "edit");
                }
                return line.length > DRY_LINE ? `${line.slice(0, DRY_LINE - 1)}…` : line;
              }),
              diff: projectDiff(v.session.project as Project, planned),
              ...placements,
              ...retimed,
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
          for (const op of ops as ReadonlyArray<Op>)
            if (op.op === "add_track" && typeof (op.track as { id?: unknown }).id === "string") r.addedTracks.add((op.track as { id: string }).id);
          persist(r.owner);
          // agentSeen doesn't move: user edits made since the agent's last read (they didn't
          // touch what this edit touched, or it would have been refused) are still news. They
          // come back with the result; with none, the new revision is as good as read.
          const now = view();
          const userChanges = now ? noteFor(now, baseRevision, readerOf(r.owner)) : "";
          if (!userChanges) r.owner.seen.add(snapshot.revision);
          else if (now && noteShowsAll(now, baseRevision)) r.owner.seen.add(now.session.revision);
          const end = projectSummary(project, snapshot.revision).duration;
          // Ducking (D85) needs its key media's loudness: a mixer change starts the analysis
          // where it's missing (waits up to SILENCES_WAIT_MS, as transcript_edit) and says so.
          const ducking = (ops as ReadonlyArray<Op>).some((op) => op.op === "update_track" && "mixer" in op.set)
            ? yield* Effect.promise(() => duckAnalysis(v.dir, project))
            : undefined;
          return textResult({
            ok: true,
            revision: snapshot.revision,
            ...placements,
            ...retimed,
            duration: end,
            seconds: Number((end / project.canvas.fps).toFixed(2)),
            ...(ducking ? { ducking } : {}),
            ...(userChanges
              ? { userChanges, note: "The user or another agent changed the project since your read: userChanges shows what. Keep their changes." }
              : {}),
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
            seeOwn(r, snapshot.revision);
          }
          const fps = ((snapshot?.project ?? v.session.project) as Project).canvas.fps;
          return { ...out, content: [...out.content, { type: "text" as const, text: JSON.stringify(appliedNote(applied, fps)) }] };
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
        return textResult(
          `Not done: the user set this chat to "Look only", so you can read and look but not change anything (${tool} refused). Say what you would do instead; they can switch to "Auto" or "Ask first" in the composer.`,
          true,
        );
      }
      const v = view();
      const big = v ? bigChange(tool, input, v.session.project as Project) : undefined;
      if (!big) return undefined;
      const answer = yield* askUser(r, big.text, 0, undefined, undefined, { lines: big.lines.map((l) => friendlyText(v?.session.project as Project, l)) });
      if (answer === "allow") return undefined;
      return textResult(
        answer === "stopped"
          ? "The turn was stopped."
          : `Not done: the user ${answer === "timeout" ? "didn't answer" : "said no"} to "${big.text}" (this chat asks before big changes). Don't try it again in this turn; say what you'd change and ask.`,
        true,
      );
    });

  return { allowed, runTool };
};

export type RunCtx = LibraryCtx & ReturnType<typeof makeRunTool>;
