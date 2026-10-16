// The agent's library tools: media_rank, graphic_write, music_add, library_search, library_add.
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { familyKey, GENERIC_FAMILIES, graphicAskedFamilies, graphicLogosUsed, graphicLibsUsed, GRAPHIC_LIBS, musicInProject, type Project, musicMedia, musicTrack, projectIds, describeOp, type Op, GRAPHIC_SRC, MAX_GRAPHIC_BYTES } from "@uncut/core";
import { aliasOf, clipNote, filterFolderSounds, filterSfx, hitKey, libraryMediaOf, limitSentence, onlyWhenAsked } from "@uncut/core/library";
import { mediaIdFor } from "@uncut/core/music";
import * as Effect from "effect/Effect";
import { targetOf } from "../../analysis/analysis.ts";
import { framesFor, MAX_RANKED, rankEntry, VIDEO_NOTE } from "../agentVideo.ts";
import { copyLibraryTrack } from "../../media/music.ts";
import { projectFonts } from "../../export/fonts.ts";
import type { ProjectView } from "../../project/projects.ts";
import type { VideoResult } from "../../analysis/videoAnalysis.ts";
import { DEFAULT_BEST_SECONDS, RANK_BY, rankValue, type RankBy } from "../../analysis/videoScores.ts";
import { expandHome } from "../../paths.ts";
import { type Running, pushEdit } from "../session/types.ts";
import { noteFor } from "../turns/notes.ts";
import { realOr, analyzeWaitMs } from "./common.ts";
import type { McpResult } from "../agent.ts";
import type { BrandCtx } from "./brand.ts";

export const makeLibraryTools = (ctx: BrandCtx) => {
  const { textResult, requestAndWait, pendingOut, cancelledNote, config, brandDirs, view, projects, persist, publish, sounds } = ctx;

  // media_rank (D67): the video analysis of several takes (run, joined or cached), ranked by
  // clean score (or one component), each with its best stretch inside one shot.
  const mediaRank = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const project = v.session.project;
      const fps = project.canvas.fps;
      const by = (args.by ?? "clean") as RankBy;
      if (!RANK_BY.includes(by)) return textResult(`by must be one of ${RANK_BY.join(", ")}.`, true);
      const windowSeconds = args.window ?? DEFAULT_BEST_SECONDS;
      if (typeof windowSeconds !== "number" || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 600) return textResult("window must be a whole number of seconds, 1 to 600.", true);
      if (args.media !== undefined && args.folder !== undefined) return textResult("Pass media or folder, not both: media ranks those ids, folder the project's media from that folder.", true);
      const skipped: Array<{ media: string; reason: string }> = [];
      let chosen: Array<(typeof project.media)[number]>;
      if (args.media !== undefined) {
        const ids = typeof args.media === "string" ? [args.media] : Array.isArray(args.media) ? args.media : null;
        if (!ids || !ids.length || !ids.every((x) => typeof x === "string")) return textResult("media must be a list of media ids from project_read.", true);
        const unknown = ids.filter((id) => !project.media.some((x) => x.id === id));
        if (unknown.length) return textResult(`There's no media ${unknown.map((u) => `"${u}"`).join(", ")}. project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`, true);
        chosen = [...new Set(ids as Array<string>)].map((id) => project.media.find((x) => x.id === id)!);
      } else if (args.folder !== undefined) {
        if (typeof args.folder !== "string" || !args.folder.trim()) return textResult("folder must be a folder's absolute path.", true);
        const raw = expandHome(args.folder);
        if (!isAbsolute(raw)) return textResult(`"${args.folder}" isn't an absolute path. Pass the full path of the folder the takes are in.`, true);
        const folder = yield* Effect.promise(() => realOr(raw, v.dir));
        const paths = yield* Effect.promise(() => Promise.all(project.media.map((x) => realOr(x.path, v.dir))));
        chosen = project.media.filter((_, i) => paths[i] === folder || paths[i]!.startsWith(folder + sep));
        if (!chosen.length) return textResult(`No media in this project is from ${raw}. Import the takes first (media_import with that folder), then rank them.`, true);
      } else {
        chosen = project.media.filter((x) => x.kind === "video");
        if (!chosen.length) return textResult("This project has no video yet. Import the takes first (media_import), then rank them.", true);
      }
      const video = chosen.filter((x) => {
        if (x.kind === "video") return true;
        skipped.push({ media: x.id, reason: x.kind === "audio" ? "A sound file, with no picture." : "A still image: there's no take to rank." });
        return false;
      });
      if (!video.length) return textResult({ ranked: [], skipped, note: "Nothing to rank: media_rank ranks video takes." }, true);
      if (video.length > MAX_RANKED) return textResult(`That's ${video.length} videos; media_rank ranks at most ${MAX_RANKED} per call. Pass media with fewer ids.`, true);
      const results = yield* requestAndWait(video.map((x) => ({ target: targetOf(v.dir, x, fps), analyzer: "video" as const })));
      const ranked: Array<{ value: number; out: Record<string, unknown> }> = [];
      const pending: Array<Record<string, unknown>> = [];
      const failed: Array<{ media: string; error: string }> = [];
      for (const [i, { jobId, outcome }] of results.entries()) {
        const x = video[i]!;
        if (!outcome) pending.push({ media: x.id, ...pendingOut(jobId) });
        else if (outcome.state === "failed") failed.push({ media: x.id, error: outcome.error });
        else if (outcome.state === "cancelled") failed.push({ media: x.id, error: cancelledNote });
        else {
          const result = outcome.result as VideoResult;
          if (!result.hasVideo) {
            skipped.push({ media: x.id, reason: "ffmpeg found no picture in it." });
            continue;
          }
          const e = rankEntry(x, result, outcome.cached, framesFor(fps, x.probe?.frames), windowSeconds);
          ranked.push({ value: rankValue(e.scores, e.best, by), out: e.out });
        }
      }
      ranked.sort((a, b) => b.value - a.value);
      return textResult({
        by,
        ranked: ranked.map((r, i) => ({ rank: i + 1, ...r.out })),
        ...(pending.length ? { pending } : {}),
        ...(failed.length ? { failed } : {}),
        ...(skipped.length ? { skipped } : {}),
        note: [
          pending.length ? `${pending.length} take${pending.length === 1 ? " is" : "s are"} still being analysed after ${Math.round(analyzeWaitMs() / 1000)} s and aren't ranked yet: call media_rank again with the same arguments (it joins the running jobs; finished ones come from the cache).` : "",
          `Ranked by ${by === "clean" ? "cleanScore (the whole take)" : by === "best" ? "the best stretch's cleanScore" : by}, best first. best is the cleanest ${windowSeconds} s inside one shot (shorter when no shot is that long): start and end are project frames of the media, usable as in and in + duration. ${VIDEO_NOTE}`,
        ]
          .filter(Boolean)
          .join(" "),
      });
    });

  // ui_show (D65): the renderer moves the playhead, selects and opens a panel once per request.
  /**
   * graphic_write (D78): a graphic's HTML into the project's graphics/ folder. A new file only
   * (earlier revisions keep pointing at the files they used), a plain name, at most
   * MAX_GRAPHIC_BYTES, inside the project by realpath (a symlinked graphics/ folder pointing out is refused).
   */
  const graphicWrite = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.promise(async (): Promise<McpResult> => {
      const name = args.name;
      const html = args.html;
      const src = `graphics/${String(name)}`;
      if (typeof name !== "string" || !GRAPHIC_SRC.test(src)) return textResult("name must be a plain file name ending in .html, e.g. counter.html (letters, digits, dots, dashes, underscores).", true);
      if (typeof html !== "string" || !html.trim()) return textResult("html must be the graphic's HTML: markup, <style> and a <script> defining render(t, info).", true);
      if (Buffer.byteLength(html) > MAX_GRAPHIC_BYTES) return textResult(`The HTML is over ${MAX_GRAPHIC_BYTES / 1024} KB; keep a graphic small (no embedded videos or large images).`, true);
      const folder = join(v.dir, "graphics");
      try {
        await mkdir(folder, { recursive: true });
        const real = await realpath(folder);
        const project = await realpath(v.dir);
        if (!real.startsWith(`${project}${sep}`)) return textResult("The project's graphics folder points outside the project, so nothing was written.", true);
        await writeFile(join(real, name), html, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return textResult(`${src} already exists, and graphics are never overwritten (earlier revisions use them). Write the new version under another name, e.g. ${name.replace(/(\.html)$/, "-2$1")}, and point the item's src at it.`, true);
        return textResult(`Couldn't write ${src}: ${(error as Error).message}`, true);
      }
      const hasRender = /\brender\s*(=|\(|:)|function\s+render\b/.test(html);
      // D193: the bundled libraries it loads, and any marker that names none.
      const libs = graphicLibsUsed(html);
      const libNote = libs.unknown.length ? { libraries: `${libs.unknown.map((x) => `uncut:lib/${x}`).join(", ")} ${libs.unknown.length === 1 ? "isn't a bundled library" : "aren't bundled libraries"} and won't load (bundled: ${GRAPHIC_LIBS.join(", ")}).` } : libs.known.length ? { libraries: `Loads ${libs.known.join(", ")}.` } : {};
      // D198: fonts it asks for that aren't there (a fallback would draw them), and kit logos it asks for that the kit lacks.
      const fonts = await projectFonts(config.fontsDir, brandDirs(v), true).catch(() => undefined);
      const missingFonts = fonts ? graphicAskedFamilies(html).filter((f) => !GENERIC_FAMILIES.has(familyKey(f)) && !fonts.available(f)) : [];
      const missingLogos = fonts ? graphicLogosUsed(html).filter((slot) => !fonts.logos[slot]) : [];
      const fontNote = missingFonts.length ? { fonts: `Not available: ${missingFonts.map((f) => `"${f}"`).join(", ")} (not bundled, not a font file of the brand kit, not installed), so ${missingFonts.length === 1 ? "it" : "they"} would fall back to another font and project_check fails. Use DM Sans, DM Mono or the kit's fonts, or add the font's file to the kit with brand_write.` } : {};
      const logoNote = missingLogos.length ? { logos: `The kit has no ${missingLogos.map((x) => `logo-${x}`).join(", ")}: ${missingLogos.length === 1 ? "that marker draws" : "those markers draw"} nothing. brand_read lists its logos.` } : {};
      return textResult({ ok: true, src, bytes: Buffer.byteLength(html), ...libNote, ...fontNote, ...logoNote, ...(hasRender ? {} : { note: "No render function found: define window.render = (t, info) => { ... } (or function render(t, info)) so the graphic can move; without it the page is drawn as is." }), next: `Insert it with timeline_edit: {"op":"insert_item","track":"<a video track>","item":{"id":"…","type":"graphic","src":"${src}","start":0,"duration":90}}` });
    });

  /**
   * music_add (D91): a library track copied into the project's media/ (copyLibraryTrack) and
   * added as audio media, an edit on the turn (Undo turn removes the media; the copy stays, and a
   * later add reuses it). A track already in the project answers with its media id.
   */
  const musicAdd = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const track = typeof args.id === "string" ? musicTrack(args.id) : undefined;
      if (!track) return textResult(`id must be a library track id from music_list${typeof args.id === "string" ? ` ("${args.id}" isn't one)` : ""}.`, true);
      const fps = v.session.project.canvas.fps;
      const already = musicInProject(v.session.project, track);
      if (already) return textResult({ media: already.id, frames: already.probe?.frames, seconds: Number(((already.probe?.frames ?? 0) / fps).toFixed(2)), revision: v.session.revision, note: `${track.title} is already in the project as ${already.id}: put it on an audio track with timeline_edit.` });
      const copied = yield* Effect.promise(() => copyLibraryTrack(config.musicDir, v.dir, track.id));
      if ("problem" in copied) return textResult(copied.problem, true);
      const fresh = view();
      if (!fresh || fresh.openId !== r.openId) return textResult("The project was closed.", true);
      const media = musicMedia(track, copied.path, fps, projectIds(fresh.session.project));
      const summary = `Added ${track.title} from the music library`;
      const outcome = yield* projects.agentEdit(r.openId, { turnId: r.turn.id, ops: [{ op: "add_media", media }], baseRevision: fresh.session.revision, summary }).pipe(
        Effect.map((snapshot) => ({ ok: true as const, snapshot })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (!outcome.ok) return textResult({ refused: outcome.error.message, details: outcome.error.details }, true);
      const { snapshot } = outcome;
      pushEdit(r, { revision: snapshot.revision, summary, lines: [describeOp({ op: "add_media", media }, snapshot.project as Project)], media: [media.id] });
      persist(r.owner);
      publish();
      r.owner.seen.add(snapshot.revision);
      const now = view();
      const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
      const frames = media.probe!.frames!;
      return textResult({
        media: media.id,
        path: media.path,
        frames,
        seconds: track.seconds,
        revision: snapshot.revision,
        next: `Put it on an audio track that is free for that stretch with timeline_edit (when a voice is on the only audio track, add one first: {"op":"add_track","track":{"id":"music","kind":"audio","name":"Music"}}), e.g. {"op":"insert_item","track":"music","item":{"id":"music-1","type":"audio","media":"${media.id}","in":0,"start":0,"duration":<from start to the video's end, at most ${frames}>,"fadeIn":${fps},"fadeOut":${2 * fps}}}, then duck it under the voice.`,
        ...(userChanges ? { userChanges, userNote: "The user changed the project since your read; the revision above includes their changes. Keep them." } : {}),
      });
    });

  /**
   * library_search (D134): the online library (Openverse; Freesound with the user's key), CC0 and
   * CC BY only, or with source "included" the bundled sound effects. Same cache and limits as the
   * panel's searches.
   */
  const librarySearch = (args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const kind = args.kind === "sfx" ? "sfx" : args.kind === "music" ? "music" : undefined;
      if (!kind) return textResult('kind must be "music" or "sfx".', true);
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const fps = view()?.session.project.canvas.fps ?? 30;
      if (args.source === "included") {
        if (kind !== "sfx") return textResult('The bundled music is music_list; source "included" is for sound effects.', true);
        const category = typeof args.category === "string" ? args.category : undefined;
        const sfx = filterSfx({ query, category });
        // D208: the user's own sound folders too (their files, referenced until added).
        const folders = category ? [] : yield* sounds.folders.list().pipe(Effect.catch(() => Effect.succeed([])));
        const yours = query ? filterFolderSounds(folders, query).slice(0, 30) : [];
        const alias = query ? aliasOf(query) : undefined;
        return textResult({
          sounds: sfx.map((s) => ({ id: `sfx:${s.id}`, title: s.title, category: s.category, seconds: s.seconds, frames: Math.round(s.seconds * fps), author: s.author, license: "CC0", ...(onlyWhenAsked(s) ? { onlyWhenAsked: true } : {}) })),
          ...(yours.length ? { yours: yours.map((f) => ({ id: `folder:${f.id}`, title: f.name, folder: f.folderName, file: f.rel })) } : {}),
          ...(alias?.clip ? { clip: clipNote(alias) } : {}),
          note: "Bundled CC0 sounds (no credit needed); `yours` are files from the user's own sound folders (theirs to use). library_add copies one into the project. Sound effects go only on real visual events, at most 4 in any 10 s, 6 to 12 dB under the music; onlyWhenAsked ones (memes, crowds) only when the user asked for that joke (D207).",
        });
      }
      if (!query) return textResult("query must say what to search for, e.g. whoosh, bass boom, upbeat piano.", true);
      if (args.source !== undefined && args.source !== "openverse" && args.source !== "freesound" && args.source !== "jamendo") return textResult('source must be "openverse", "freesound", "jamendo" or "included".', true);
      const length = args.length === "short" || args.length === "medium" || args.length === "long" ? args.length : undefined;
      const outcome = yield* sounds
        .search({ kind, query, ...(args.source ? { source: args.source as "openverse" | "freesound" | "jamendo" } : {}), ...(args.license === "cc0" ? { license: "cc0" as const } : {}), ...(length ? { length } : {}), ...(args.songs === true ? { songs: true } : {}), ...(typeof args.page === "number" ? { page: args.page } : {}) })
        .pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
      if (!outcome.ok) return textResult(outcome.error.message, true);
      const { result } = outcome;
      if (result.limit) return textResult({ hits: [], limit: limitSentence(result.source, result.limit), note: "Use the bundled sounds meanwhile (music_list, or library_search with source included)." }, true);
      return textResult({
        source: result.source,
        total: result.total,
        page: result.page,
        pages: result.pages,
        hits: result.hits.map((h) => ({ id: hitKey(h), title: h.title, creator: h.creator, seconds: h.seconds, ...(h.seconds ? { frames: Math.round(h.seconds * fps) } : {}), license: h.license === "by" ? `CC BY ${h.licenseVersion}` : "CC0", tags: h.tags.slice(0, 6) })),
        ...(result.searched ? { searched: result.searched } : {}),
        ...(result.note ? { clip: result.note } : {}),
        note: "CC BY sounds need credit in the video's description (project_read lists credits). library_add downloads one into the project.",
      });
    });

  /** library_add (D134): a hit (or a bundled sound effect) downloaded into media/ and added as audio media with its credits, an edit on the turn. */
  const libraryAdd = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return textResult("id must be a library_search hit id (openverse:…, freesound:…, jamendo:…), a bundled sound (sfx:…) or one of the user's (folder:…).", true);
      const fps = v.session.project.canvas.fps;
      const already = libraryMediaOf(v.session.project, id);
      if (already) return textResult({ media: already.id, frames: already.probe?.frames, revision: v.session.revision, note: `It's already in the project as ${already.id}: put it on an audio track with timeline_edit.` });
      const added = yield* sounds.add(id, v.dir, r.abort.signal).pipe(
        Effect.map((a) => ({ ok: true as const, a })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (!added.ok) return textResult(added.error.message, true);
      const fresh = view();
      if (!fresh || fresh.openId !== r.openId) return textResult("The project was closed.", true);
      const { a } = added;
      const media = { id: mediaIdFor(a.name, projectIds(fresh.session.project)), kind: "audio" as const, name: a.name, path: a.path, source: { ...a.source }, probe: { frames: Math.max(1, Math.floor(a.seconds * fps)), hasAudio: true } };
      const summary = `Added ${a.name} from the sound library`;
      const outcome = yield* projects.agentEdit(r.openId, { turnId: r.turn.id, ops: [{ op: "add_media", media }], baseRevision: fresh.session.revision, summary }).pipe(
        Effect.map((snapshot) => ({ ok: true as const, snapshot })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (!outcome.ok) return textResult({ refused: outcome.error.message, details: outcome.error.details }, true);
      const { snapshot } = outcome;
      pushEdit(r, { revision: snapshot.revision, summary, lines: [describeOp({ op: "add_media", media } as Op, snapshot.project as Project)], media: [media.id] });
      persist(r.owner);
      publish();
      r.owner.seen.add(snapshot.revision);
      return textResult({
        media: media.id,
        path: media.path,
        frames: media.probe.frames,
        seconds: a.seconds,
        license: !("license" in a.source) ? "the user's own file" : a.source.license === "by" ? `CC BY ${a.source.licenseVersion}: credit "${a.source.title}" by ${a.source.creator} (project_read's credits has the line)` : "CC0",
        revision: snapshot.revision,
        next: `Put it on an audio track free at that moment with timeline_edit, e.g. {"op":"insert_item","track":"<audio track>","item":{"id":"sfx-1","type":"audio","media":"${media.id}","in":0,"start":<frame>,"duration":${media.probe.frames}}} (add a track first when none is free: {"op":"add_track","track":{"id":"sfx","kind":"audio","name":"Sound effects"}}).`,
      });
    });

  return { musicAdd, librarySearch, libraryAdd, graphicWrite, mediaRank };
};

export type LibraryCtx = BrandCtx & ReturnType<typeof makeLibraryTools>;
