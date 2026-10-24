// The agent's brand and look tools: brand_read, brand_write, skill_read, reference_frames, beat_grid, shaders.
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { BrandKit } from "@uncut/contracts";
import { familyKey, type Project, layout } from "@uncut/core";
import * as Effect from "effect/Effect";
import { targetOf } from "../../analysis/analysis.ts";
import type { BeatsResult } from "../../analysis/beats.ts";
import { shortName, CELL_WIDTH, clock, MAX_CELLS, sheetLayout } from "../agentFootage.ts";
import { beatGrid, kitChanges, kitLines, mergeKit, type GridItem } from "../agentPlan.ts";
import { readBrand, saveKit, slug, useSkills, writeActive } from "../../brand/store.ts";
import { skillIdOf } from "@uncut/core/skills";
import { fontFileFamilies, projectFonts } from "../../export/fonts.ts";
import { fillLogos, importIntoKit, type LogoSlot } from "../../brand/importer.ts";
import { logoPictures } from "../../brand/logoImages.ts";
import { projectShaders } from "../agentShaders.ts";
import { SHADER, shaderUseOf, type ShaderDef } from "@uncut/core/shaders";
import type { ProjectView } from "../../project/projects.ts";
import { expandHome } from "../../paths.ts";
import type { Running } from "../session/types.ts";
import type { CardsCtx } from "./cards.ts";

export const makeBrandTools = (ctx: CardsCtx) => {
  const { brandDirs, textResult, config, askUser, addCard, mediaCore, exporter, requestAndWait, pendingOut, cancelledNote, plugins } = ctx;

  /**
   * skill_read (D232, issue #60): an installed skill's instructions (a plugin's, or the user's own);
   * the project uses it from then on, so the critic checks its review checklist.
   */
  const skillRead = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const asked = typeof args.name === "string" ? args.name.trim().replace(/^\//, "") : "";
      const all = yield* Effect.promise(() => readBrand(brandDirs(v)));
      const skill = all.skills.find((x) => x.id === skillIdOf(asked)) ?? all.skills.find((x) => x.name.toLowerCase() === asked.toLowerCase());
      if (!skill) return textResult(`There's no skill "${asked.slice(0, 64)}". The installed ones: ${all.skills.map((x) => x.id).join(", ") || "none"}.`, true);
      yield* Effect.promise(() =>
        useSkills(v.dir, [skill.id]).catch((error) => console.error(`[uncut] couldn't note the skill ${skill.id} in ${v.dir}: ${(error as Error).message}`)),
      );
      return textResult({
        name: skill.id,
        title: skill.name,
        description: skill.description,
        from: skill.pluginName ? `the plugin ${skill.pluginName}` : "the user's own skills",
        instructions: skill.body,
        next: "Follow its rules for this task where the user's own direction doesn't decide (what the message sets wins); the critic checks its review checklist.",
      });
    });

  /** brand_read (D186, D198): the kit and skills with its logos as pictures, or one of the kit's files. */
  const brandRead = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const all = yield* Effect.promise(() => readBrand(brandDirs(v)));
      const id = typeof args.kit === "string" ? args.kit : all.active.kit;
      const kit = all.kits.find((k) => k.id === id);
      if (!kit) {
        return textResult({
          kit: null,
          kits: all.kits.map((k) => ({ id: k.id, name: k.name, scope: k.scope })),
          message: typeof args.kit === "string" ? `There's no kit "${args.kit}".` : "This project has no brand kit.",
          next: all.kits.length
            ? "Don't invent a logo, colours or fonts. Ask the user (ask_user) which of their kits this video uses (they choose it in the Brand panel), or find the brand on its own site and save it with brand_write."
            : "Don't invent a logo, colours or fonts. Find the brand on its own site (the logo file, colours, fonts) or in the folders the user named, and save it with brand_write (logos and font files from a path or an https address); ask_user only when you can't.",
        });
      }
      const files = all.files[kit.id] ?? {};
      const picture = (png: Buffer) => ({ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" });
      if (typeof args.file === "string") {
        const path = files[args.file];
        if (!path) return textResult(`The kit has no file "${args.file}". Its files: ${Object.keys(files).join(", ") || "(none)"}.`, true);
        const ext = path.toLowerCase().split(".").pop() ?? "";
        const logoSlot = (["light", "dark", "mark"] as const).find((k) => kit.logos[k] === args.file);
        const isLogo = logoSlot !== undefined;
        const slot = logoSlot ?? "mark";
        if (["svg", "png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
          // D198: drawn as a PNG (an SVG too) on the background it's for.
          const [drawn] = yield* Effect.promise(() => logoPictures([{ slot, path }]));
          if (drawn?.png)
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${args.file} from the kit "${kit.name}": ${path}${ext === "svg" ? ` (an SVG: drawn here as a PNG; media_import keeps it vector, and in a graphic ${isLogo ? `uncut:brand/logo-${slot} inlines it` : "paste its <svg> inline, read from this path as it is, never redrawn"})` : ""}. media_import this path to place it.`,
                },
                picture(drawn.png),
              ],
            };
          if (ext !== "svg") {
            const data = yield* Effect.promise(() => readFile(path).catch(() => undefined));
            const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[ext]!;
            if (data && data.length <= 5 * 1024 * 1024)
              return {
                content: [
                  { type: "text" as const, text: `${args.file} from the kit "${kit.name}": ${path} (media_import this path to place it).` },
                  { type: "image" as const, data: data.toString("base64"), mimeType: mime },
                ],
              };
          }
          return textResult({
            file: args.file,
            path,
            note: `Couldn't draw it${drawn?.problem ? ` (${drawn.problem})` : ""}; media_import this path to place it.`,
          });
        }
        return textResult({ file: args.file, path, note: "media_import this path to use it." });
      }
      const slots = (["light", "dark", "mark"] as const).flatMap((k) =>
        kit.logos[k] && files[kit.logos[k]!] ? [{ slot: k, name: kit.logos[k]!, path: files[kit.logos[k]!]! }] : [],
      );
      const drawn = yield* Effect.promise(() => logoPictures(slots));
      const fonts = yield* Effect.promise(() => projectFonts(config.fontsDir, brandDirs(v), true).catch(() => undefined));
      const label = { light: "the logo for light backgrounds", dark: "the logo for dark backgrounds", mark: "the logo mark" } as const;
      const summary = {
        kit: kitLines(kit, files).join("\n"),
        colors: kit.colors,
        fonts: kit.fonts.map((f) => ({ ...f, ...(f.file ? { path: files[f.file] ?? null } : {}), available: fonts ? fonts.available(f.family) : null })),
        logos: Object.fromEntries(Object.entries(kit.logos).map(([k, name]) => [k, { name, path: files[name!] ?? null, inGraphics: `uncut:brand/logo-${k}` }])),
        files,
        // D232: the skills the project uses, by name (skill_read gives their instructions).
        skills: all.skills.filter((s) => all.active.skills.includes(s.id)).map((s) => ({ name: s.id, title: s.name, description: s.description })),
        ...(fonts?.kitMissing.length
          ? {
              fontsMissing: `${fonts.kitMissing.map((f) => `"${f}"`).join(", ")} ${fonts.kitMissing.length === 1 ? "has" : "have"} no font file in the kit and ${fonts.kitMissing.length === 1 ? "isn't" : "aren't"} installed: add the file (brand_write fonts with file) or it falls back to another font.`,
            }
          : {}),
        ...(!slots.length
          ? {
              logosMissing:
                "The kit has no logo files: find them (the brand's site, the folders the user named) and add them with brand_write logos; never draw or retype a logo.",
            }
          : {}),
        next: "Use these by default: media_import a logo's path to place it (or uncut:brand/logo-… in a graphic), the colours by role in backgrounds, text and graphics (and the project's theme), the fonts in text style.font and graphics CSS, the tone in every line of copy.",
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary) },
          ...drawn.flatMap((d, i) =>
            d.png
              ? [{ type: "text" as const, text: `Logo: ${label[slots[i]!.slot]}, ${slots[i]!.name}:` }, picture(d.png)]
              : [{ type: "text" as const, text: `Logo ${slots[i]!.name} couldn't be drawn: ${d.problem ?? "unknown"}.` }],
          ),
        ],
      };
    });

  /**
   * brand_write (D186, D190, D198): merged into a kit; a new kit (with a name) goes in the user's
   * library and becomes the project's when it has none. Logos and font files come in from kit
   * names, paths, folders or https addresses. Changing an existing kit's colours or fonts waits for
   * the user's Apply on a before / after card, in every access mode.
   */
  const brandWrite = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const dirs = brandDirs(v);
      const all = yield* Effect.promise(() => readBrand(dirs));
      let base = typeof args.kit === "string" ? all.kits.find((k) => k.id === args.kit) : undefined;
      if (typeof args.kit === "string" && !base)
        return textResult(`There's no kit "${args.kit}". brand_read lists them; pass name (and no kit) to make a new one.`, true);
      const fresh = !base && typeof args.name === "string" && args.name.trim() !== "" && !all.kits.some((k) => k.id === slug(String(args.name)));
      if (!base && !fresh) base = all.kits.find((k) => k.id === (typeof args.name === "string" ? slug(args.name) : all.active.kit));
      if (!base && !fresh) return textResult("No kit to write into: pass kit (an id from brand_read) or name for a new kit.", true);
      // D198: a new kit goes in the user's library unless the call pins it to this project.
      const start: BrandKit = base ?? {
        id: slug(String(args.name)),
        name: String(args.name).trim().slice(0, 80),
        scope: args.scope === "project" ? "project" : "global",
        logos: {},
        colors: [],
        fonts: [],
        tone: "",
        taglines: [],
        urls: [],
        dos: [],
        donts: [],
        examples: [],
      };
      const merged = mergeKit(start, args);
      if ("problem" in merged) return textResult(merged.problem, true);
      // Files first (into the kit's folder; kit.json is written below): logos, font files, an import.
      const files = { ...all.files[start.id] };
      const notes: Array<string> = [];
      const bring = (source: string) =>
        Effect.promise(() => importIntoKit(dirs, start.id, start.scope, source, r.abort.signal).catch((e: Error) => ({ problem: e.message }) as const));
      const logos: { -readonly [K in LogoSlot]?: string } = { ...merged.logos };
      if (args.logos && typeof args.logos === "object") {
        for (const slot of ["light", "dark", "mark"] as const) {
          const want = (args.logos as Record<string, unknown>)[slot];
          if (typeof want !== "string" || !want.trim()) continue;
          if (Object.hasOwn(files, want)) {
            logos[slot] = want;
            continue;
          }
          const got = yield* bring(want);
          if ("problem" in got) return textResult(`Couldn't bring in the ${slot} logo: ${got.problem}`, true);
          const logo = got.files.find((f) => f.kind === "logo");
          if (!logo) return textResult(`${want} has no logo picture (SVG, PNG, JPEG, WebP, GIF).`, true);
          logos[slot] = logo.name;
        }
      }
      let fontsOut = [...merged.fonts];
      if (Array.isArray(args.fonts)) {
        const next: Array<BrandKit["fonts"][number]> = [];
        for (const f of merged.fonts) {
          if (!f.file || Object.hasOwn(files, f.file)) {
            next.push(f);
            continue;
          }
          const got = yield* bring(f.file);
          if ("problem" in got) return textResult(`Couldn't bring in the font file for ${f.family}: ${got.problem}`, true);
          const font = got.files.find((x) => x.kind === "font");
          if (!font) return textResult(`${f.file} isn't a font file (WOFF2, WOFF, TTF, OTF).`, true);
          next.push({ ...f, file: font.name });
        }
        fontsOut = next;
      }
      if (typeof args.import === "string" && args.import.trim()) {
        const got = yield* bring(args.import);
        if ("problem" in got) return textResult(`Couldn't import from ${args.import}: ${got.problem}`, true);
        Object.assign(logos, fillLogos(logos, got.files));
        for (const f of got.files.filter((x) => x.kind === "font")) {
          const path = (yield* Effect.promise(() => readBrand(dirs))).files[start.id]?.[f.name];
          const family = (path ? (yield* Effect.promise(() => fontFileFamilies(path)))[0] : undefined) ?? f.family ?? f.name;
          const same = fontsOut.findIndex((x) => familyKey(x.family) === familyKey(family) && !x.file);
          if (same >= 0) fontsOut[same] = { ...fontsOut[same]!, file: f.name };
          else if (!fontsOut.some((x) => x.file === f.name)) fontsOut.push({ family, role: fontsOut.length ? "body" : "headline", file: f.name });
        }
        notes.push(`Imported ${got.files.map((f) => (f.kind === "logo" ? `${f.name} (logo, ${f.slot})` : `${f.name} (font)`)).join(", ")}.`);
      }
      let kit: BrandKit = { ...merged, logos, fonts: fontsOut };
      // D198: an existing kit's colours and fonts change only with the user's approval.
      const changes = base ? kitChanges(base, kit) : [];
      if (changes.length) {
        const answer = yield* askUser(
          r,
          `Change the ${changes.map((c) => c.field.toLowerCase()).join(" and ")} of the kit "${base!.name}"`,
          0,
          undefined,
          undefined,
          undefined,
          { brand: { kit: base!.name, changes } },
        );
        if (answer !== "allow") {
          kit = { ...kit, colors: base!.colors, fonts: base!.fonts };
          notes.push(
            answer === "stopped"
              ? "The turn was stopped: the kit's colours and fonts stay as they were."
              : `The user ${answer === "timeout" ? "didn't answer" : "kept the kit as it is"}: its colours and fonts weren't changed. Don't put them in again in this turn; a reference's colours belong in style.`,
          );
        }
      }
      const saved = yield* Effect.tryPromise({ try: () => saveKit(dirs, kit), catch: (e) => e as Error }).pipe(
        Effect.map((k) => ({ ok: true as const, k })),
        Effect.catch((e) => Effect.succeed({ ok: false as const, message: e.message })),
      );
      if (!saved.ok) return textResult(`Couldn't save the kit: ${saved.message}`, true);
      if (fresh && !all.active.kit) yield* Effect.promise(() => writeActive(v.dir, { kit: saved.k.id, skills: all.active.skills }).catch(() => {}));
      const what = args.style ? `Style guide written into ${saved.k.name}` : fresh ? `New kit ${saved.k.name}` : `Saved the kit ${saved.k.name}`;
      addCard(r, { type: "brand", text: what }, what);
      return textResult({
        saved: saved.k.id,
        scope: saved.k.scope === "global" ? "the user's library: every project can pick it" : "pinned to this project",
        kit: kitLines(saved.k, (yield* Effect.promise(() => readBrand(dirs))).files[saved.k.id] ?? {}).join("\n"),
        ...(fresh && !all.active.kit ? { note: "It's now this project's kit." } : {}),
        ...(notes.length ? { notes } : {}),
      });
    });

  /** reference_frames (D190): a contact sheet of a file on disk that isn't imported. */
  const referenceFrames = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      if (typeof args.path !== "string" || !args.path.trim()) return textResult("path is the reference file's absolute path.", true);
      const asked = expandHome(args.path);
      const path = isAbsolute(asked) ? asked : resolve(v.dir, asked);
      const count = Number.isInteger(args.count) && (args.count as number) >= 1 && (args.count as number) <= MAX_CELLS ? (args.count as number) : 16;
      // D198: an SVG (a logo, a mockup) is drawn as a PNG, as brand_read does.
      if (/\.svg$/i.test(path)) {
        const [drawn] = yield* Effect.promise(() => logoPictures([{ slot: "mark", path }]));
        if (!drawn?.png) return textResult(`Couldn't draw ${shortName(path)}: ${drawn?.problem ?? "it isn't there"}.`, true);
        return {
          content: [
            {
              type: "text" as const,
              text: `The reference ${shortName(path)} (an SVG, drawn as a PNG on grey). Read its grammar (palette, type, layout), not its content.`,
            },
            { type: "image" as const, data: drawn.png.toString("base64"), mimeType: "image/png" },
          ],
        };
      }
      const probed = yield* mediaCore.probeMany([path]).pipe(
        Effect.map((list) => list[0]),
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (!probed || !probed.ok)
        return textResult(`Couldn't read ${shortName(path)}: ${probed && !probed.ok ? probed.message : "it isn't a media file Uncut can open"}.`, true);
      const info = probed.info;
      if (info.kind === "audio") return textResult(`${shortName(path)} is a sound file, with no picture to read a style from.`, true);
      if (info.kind === "image") {
        const data = yield* Effect.promise(() => readFile(path).catch(() => undefined));
        const ext = path.toLowerCase().split(".").pop() ?? "";
        const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[ext];
        if (!data || !mime || data.length > 5 * 1024 * 1024)
          return textResult(`${shortName(path)} is a picture Uncut can't hand over (${mime ? "over 5 MB" : "not PNG, JPEG, WebP or GIF"}).`, true);
        return {
          content: [
            {
              type: "text" as const,
              text: `The reference ${shortName(path)}, ${info.width ?? "?"}×${info.height ?? "?"}. Read its grammar (palette, type, layout, grain), not its content.`,
            },
            { type: "image" as const, data: data.toString("base64"), mimeType: mime },
          ],
        };
      }
      const seconds = info.durationSeconds ?? 0;
      if (!seconds) return textResult(`${shortName(path)} has no known length.`, true);
      const fps = info.fpsValue && info.fpsValue > 0 ? info.fpsValue : 30;
      const times = Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * seconds);
      const grid = sheetLayout(count, info.width && info.height ? info.width / info.height : 16 / 9);
      const sheet = yield* exporter.mediaFrames(path, times, CELL_WIDTH, fps).pipe(
        Effect.flatMap((pulled) =>
          exporter.sheetImage(
            pulled.map((p, i) => ({ jpeg: p.jpeg, caption: `${i + 1}   ${clock(p.seconds)}` })),
            grid,
          ),
        ),
        Effect.map((jpeg) => ({ ok: true as const, jpeg })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
      );
      if (!sheet.ok) return textResult(`Couldn't make the sheet: ${sheet.message}`, true);
      return {
        content: [
          {
            type: "text" as const,
            text: `The reference ${shortName(path)}: ${seconds.toFixed(1)} s, ${info.width ?? "?"}×${info.height ?? "?"}, ${count} frames spread evenly (cell n at ${times.map((t) => clock(t)).join(", ")}). Read its grammar (palette as hex, type, shot lengths, transitions, camera, grain), never its content; then brand_write the style.`,
          },
          { type: "image" as const, data: sheet.jpeg.toString("base64"), mimeType: "image/jpeg" },
        ],
      };
    });

  /** beat_grid (D191): the music's beats, downbeats and hits in timeline frames, and snaps. */
  const beatGridTool = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const project = v.session.project as Project;
      const fps = project.canvas.fps;
      const audio = project.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.items.filter((i) => i.type === "audio" && typeof i.media === "string"));
      const item = typeof args.item === "string" ? audio.find((i) => i.id === args.item) : [...audio].sort((a, b) => b.duration - a.duration)[0];
      if (!item)
        return textResult(
          typeof args.item === "string"
            ? `There's no audio item "${args.item}" on an audio track.`
            : "There's no music on the timeline yet: add it (library_add or media_import, then timeline_edit) first.",
          true,
        );
      const m = project.media.find((x) => x.id === item.media);
      if (!m) return textResult(`The media of ${item.id} is missing.`, true);
      const range = args.range as { start?: unknown; end?: unknown } | undefined;
      if (range !== undefined && (typeof range !== "object" || !Number.isInteger(range.start) || !Number.isInteger(range.end)))
        return textResult("range is { start, end } in timeline frames.", true);
      const snap = Array.isArray(args.snap) ? args.snap.filter((f): f is number => Number.isInteger(f) && f >= 0).slice(0, 60) : undefined;
      const [answer] = yield* requestAndWait([{ target: targetOf(v.dir, m, fps), analyzer: "beats" }]);
      const outcome = answer!.outcome;
      if (!outcome)
        return textResult({
          item: item.id,
          beats: pendingOut(answer!.jobId),
          note: "Finding the beats is still running: call beat_grid again with the same arguments.",
        });
      if (outcome.state !== "done")
        return textResult(`Couldn't find the beats of ${m.name}: ${outcome.state === "failed" ? outcome.error : cancelledNote}`, true);
      const result = outcome.result as BeatsResult;
      if (!result.hasAudio || !result.bpm)
        return textResult({
          item: item.id,
          bpm: null,
          note: "No steady beat in this sound (speech, ambience or silence): cut on the picture and the words instead.",
        });
      return textResult(
        beatGrid(
          result,
          {
            id: item.id,
            media: m.id,
            start: layout(project).starts.get(item.id) ?? item.start ?? 0,
            in: item.in ?? 0,
            duration: item.duration,
            speed: item.speed ?? 1,
          } satisfies GridItem,
          fps,
          range as { start: number; end: number } | undefined,
          snap,
        ),
      );
    });

  /** The shader effects the agent can name (D213): allowed plugins', the project's shaders/ folder's, and those clips carry. */
  const shaderDefsOf = (v: ProjectView) =>
    Effect.gen(function* () {
      const defs = new Map<string, ShaderDef>();
      for (const it of (v.session.project as Project).tracks.flatMap((t) => t.items))
        for (const e of it.effects ?? []) {
          const use = e.module === SHADER ? shaderUseOf(e) : undefined;
          if (use) defs.set(use.def.id, use.def);
        }
      for (const [id, def] of yield* Effect.promise(() => projectShaders(v.dir))) defs.set(id, def);
      for (const s of (yield* plugins.contributions).shaders ?? []) defs.set(s.id, s);
      return defs as ReadonlyMap<string, ShaderDef>;
    });

  return { shaderDefsOf, brandRead, brandWrite, skillRead, referenceFrames, beatGridTool };
};

export type BrandCtx = CardsCtx & ReturnType<typeof makeBrandTools>;
