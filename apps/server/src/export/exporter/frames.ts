import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Project, type Media, layout, visualsAt, isSvg, SOLID, isDrawnComponent, textHtml, solidHtml, componentHtml, MAX_GRAPHIC_BYTES, graphicDocument, graphicInfo, irisRadius, maskGeq, clipFx, needsPicturePass, hasOverlay, fxOverlayHtml, isPlainBox, baseBox, fitRect, colourLut, cubeText, moveBox, canvasBox } from "@uncut/core";
import { clipShader, shaderParamBytes, shaderModuleCode, shaderFrameBytes, shaderTime } from "@uncut/core/shaders";
import { RASTER_CSS, planExport, mediaToken, sourceFramePick, svgClipHtml, untaggedFilter, blurFilters, placementOf, fxGraph, boxGraph } from "../exportPlan.ts";
import { rasterizerCommand, type Rasterizer, startRasterizer } from "../rasterizer.ts";
import { withPictureSizes, capsOf, untaggedFiles, run, ffmpegError } from "./ffmpeg.ts";
import { makeTemp } from "./files.ts";
import { withMedia } from "./graphics.ts";
import { graphicMediaSource } from "../graphicMedia.ts";

export interface RenderedFrame {
  readonly frame: number;
  readonly jpeg: Buffer;
  /** What this frame leaves out (a graphic whose file couldn't be read), as sentences. */
  readonly notes?: ReadonlyArray<string>;
}

/**
 * Frames of the edit as JPEGs, built the way export builds them: the canvas colour, then every
 * visual at f in visualsAt order (footage at its source time, text and backgrounds drawn by
 * Chromium with the frame's opacity and motion), one ffmpeg run per frame.
 */
export async function renderFramesWith(bin: string, unsized: Project, mediaPath: (m: Media) => string, graphics: ReadonlyMap<string, string>, frames: ReadonlyArray<number>, width: number, signal: AbortSignal, css: string = RASTER_CSS): Promise<Array<RenderedFrame>> {
  const project = await withPictureSizes(bin, unsized, mediaPath, signal);
  const { starts, duration } = layout(project);
  const W = Math.max(2, Math.round(width / 2) * 2);
  const H = Math.max(2, Math.round((W * project.canvas.height) / project.canvas.width / 2) * 2);
  const caps = await capsOf(bin);
  const command = rasterizerCommand();
  if ("problem" in command) throw new Error(command.problem);
  const temp = await makeTemp();
  let raster: Rasterizer | undefined;
  // D290: project media its graphics draw, as the export gets them.
  const media = graphicMediaSource({ bin, media: () => project.media, mediaPath, videotoolbox: caps.videotoolboxDecode });
  const onAbort = () => void raster?.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    raster = await startRasterizer(command, undefined, { media: media.file });
    const { width: cw, height: ch } = project.canvas;
    const background = join(temp, "bg.png");
    const plan = planExport(project, { mediaPath, width: W, height: H, graphic: (src) => graphics.get(src) });
    const urls = new Map<string, string>();
    // Components' media references as placeholders, swapped for data: URLs before drawing (as the export does).
    const target = { ...project, mediaUrl: (id: string) => (project.media.find((m) => m.id === id)?.kind === "image" ? mediaToken(id) : undefined) };
    const draw = async (html: string, png: string) => raster!.render({ width: cw, height: ch, css, html: await withMedia(html, project, mediaPath, urls), out: png });
    await raster.render({ width: cw, height: ch, css, html: "problem" in plan ? "" : plan.backgroundHtml, out: background });
    const untagged = "problem" in plan ? new Map<string, number>() : await untaggedFiles(bin, plan, signal);
    const out: Array<RenderedFrame> = [];
    // The colour tables (D136) written so far, by key.
    const luts = new Map<string, string>();
    for (const requested of frames) {
      const f = Math.max(0, Math.min(duration - 1, Math.floor(requested)));
      const notes: Array<string> = [];
      const inputs: Array<string> = ["-i", background];
      const graph: Array<string> = [`[0:v]scale=${W}:${H},format=rgba[b0]`];
      let base = "b0";
      let k = 0;
      for (const v of visualsAt(project, starts, f)) {
        const media = v.item.media ? project.media.find((m) => m.id === v.item.media) : undefined;
        let input: Array<string> | undefined;
        // The source frame on screen at that moment, picked like the export picks it (exportPlan.ts).
        const pick = sourceFramePick(v.source, project.canvas.fps, v.item.type === "clip" && v.item.hold === true && !v.item.loop);
        const local = f - (starts.get(v.item.id) ?? 0);
        const svg = v.item.type === "clip" && isSvg(media) && !!v.box;
        if (v.item.type === "clip" && media && media.kind === "video") input = [...(caps.videotoolboxDecode ? ["-hwaccel", "videotoolbox"] : []), ...pick.seekArgs, "-i", mediaPath(media)];
        else if (svg) {
          // An SVG (D76): drawn by Chromium in its box, as the export does.
          const png = join(temp, `f${f}-${k}.png`);
          await draw(svgClipHtml(v.item, v.box!, mediaToken(media!.id), v.opacity), png);
          input = ["-f", "image2", "-pattern_type", "none", "-i", png];
        } else if (v.item.type === "clip" && media && media.kind === "image") input = ["-f", "image2", "-pattern_type", "none", "-i", mediaPath(media)];
        else if ((v.item.type === "text" && typeof v.item.text === "string") || (v.item.type === "component" && v.item.component === SOLID) || isDrawnComponent(v.item)) {
          const png = join(temp, `f${f}-${k}.png`);
          const html =
            v.item.type === "text"
              ? textHtml(v.item, project, { opacity: v.opacity, motion: v.motion })
              : v.item.component === SOLID
                ? solidHtml(v.item, project, { opacity: v.opacity })
                : componentHtml(v.item, target, local, { opacity: v.opacity, motion: v.motion, fps: project.canvas.fps, ...(v.box ? { box: v.box } : {}) });
          await draw(html, png);
          input = ["-f", "image2", "-pattern_type", "none", "-i", png];
        } else if (v.item.type === "graphic" && typeof v.item.src === "string") {
          // A graphic (D78) at this frame; its opacity goes on below, like a clip's.
          const html = graphics.get(v.item.src);
          if (html === undefined) {
            notes.push(`the graphic "${v.item.name ?? v.item.id}" isn't drawn: ${v.item.src} couldn't be read (missing, outside graphics/, over ${MAX_GRAPHIC_BYTES / 1024} KB or a name it doesn't take)`);
            continue;
          }
          const png = join(temp, `f${f}-${k}-g.png`);
          const at = Math.max(0, Math.min(v.item.duration - 1, local));
          await raster.render({ kind: "graphic", width: cw, height: ch, doc: graphicDocument(html, project.canvas), t: at / project.canvas.fps, info: graphicInfo(v.item, project.canvas, at), out: png, name: `"${v.item.name ?? v.item.id}" (${v.item.src})` });
          input = ["-f", "image2", "-pattern_type", "none", "-i", png];
        }
        if (!input) continue;
        // A wipe transition shows the left X pixels (even, as the export's crop does).
        const shown = v.wipe === undefined ? W : 2 * Math.floor((W * v.wipe) / 2);
        if (shown <= 0) continue;
        const fade = (v.item.type === "clip" && !svg) || v.item.type === "graphic" ? `,colorchannelmixer=aa=${v.opacity.toFixed(4)}` : "";
        const tag = media ? untaggedFilter(untagged.get(mediaPath(media))) : "";
        const picked = v.item.type === "clip" && media?.kind === "video" ? `${tag}${pick.filter},` : "trim=end_frame=1,setpts=0,";
        // An iris (D79): alpha times the disc at the canvas's centre, for a layer whose top-left is at (ox, oy).
        // A reveal shape (D133): alpha times core's coverage, the same way.
        const iris = (ox: number, oy: number) =>
          v.iris !== undefined
            ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${irisRadius(v.iris, { width: W, height: H }).toFixed(4)}-hypot(X+${ox + 0.5}-${W / 2},Y+${oy + 0.5}-${H / 2})+0.5,0,1)'`
            : v.mask
              ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${maskGeq(v.mask.shape, v.mask.p.toFixed(6), W, H, `(X+${ox + 0.5})`, `(Y+${oy + 0.5})`)}+0.5,0,1)'`
              : "";
        // A blur dissolve (D133): gblur at the frame's sigma (output px).
        const blur = v.blur ? `,${blurFilters((v.blur * H) / ch)}` : "";
        // A clip's looks and effects (D136): picture effects before its box (which it then always has), overlays after it.
        const effects = v.item.type === "clip" && media && !svg ? clipFx(v.item) : undefined;
        // D213: a shader effect is a picture pass, drawn first with the rasteriser's WebGPU as the export does.
        const shader = v.item.type === "clip" && media && !svg ? clipShader(v.item) : undefined;
        const picture = needsPicturePass(effects) || effects?.blur !== undefined || !!shader;
        const overlay = async () => {
          if (!effects || !hasOverlay(effects) || !v.box) return;
          const png = join(temp, `f${f}-${k}-fx.png`);
          await draw(fxOverlayHtml(effects, v.box, local), png);
          k++;
          inputs.push("-f", "image2", "-pattern_type", "none", "-i", png);
          graph.push(`[${k}:v:0]scale=${W}:${H},format=rgba,colorchannelmixer=aa=${v.opacity.toFixed(4)}${blur}${iris(0, 0)}${shown < W ? `,crop=w=${shown}:h=${H}:x=0:y=0,pad=${W}:${H}:0:0:color=black@0` : ""}[l${k}]`);
          graph.push(`[${base}][l${k}]overlay=format=auto[b${k}]`);
          base = `b${k}`;
        };
        if (v.box && media && !svg && (picture || !isPlainBox(v.box, project.canvas))) {
          // A box (D75; moved by a push or zoom, D79), made as the export makes it; a wipe or iris reveals the canvas.
          const p = placementOf(v.box, W / cw, H / ch, baseBox(v.item, project.canvas, media.probe));
          const visible = Math.min(p.w, shown - p.x);
          if (visible <= 0) continue;
          let source = input;
          let pick = picked;
          if (shader) {
            // The source frame at the effects' size, drawn by the shader, then the rest as for any clip.
            const fit = fitRect(baseBox(v.item, project.canvas, media.probe), v.box.fit, media.probe);
            const sw = v.box.scale !== 1 ? Math.max(1, Math.round((fit.w * W) / cw)) : p.cw;
            const sh = v.box.scale !== 1 ? Math.max(1, Math.round((fit.h * H) / ch)) : p.ch;
            const raw = join(temp, `f${f}-${k}-src.rgba`);
            const drawn = join(temp, `f${f}-${k}-shader.rgba`);
            const d = await run(bin, ["-hide_banner", "-nostdin", "-y", "-v", "error", ...input, "-filter_complex", `[0:v:0]${picked}scale=w=${sw}:h=${sh}:out_range=pc,format=rgba[o]`, "-map", "[o]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", raw], signal);
            if (d.code !== 0) throw new Error(`Frame ${f} couldn't be rendered: ${ffmpegError(d.stderr)}`);
            const params = shaderParamBytes(shader.def.params, shader.values);
            try {
              await raster.render({ kind: "shader", width: sw, height: sh, code: shaderModuleCode(shader.def), frame: [...new Float32Array(shaderFrameBytes(sw, sh, shaderTime(f, starts.get(v.item.id) ?? 0, project.canvas.fps), false))], ...(params ? { params: [...new Float32Array(params)] } : {}), input: raw, out: drawn, name: `the shader effect ${shader.def.name}` });
              source = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${sw}x${sh}`, "-i", drawn];
              pick = "trim=end_frame=1,setpts=0,";
            } catch (error) {
              // Never silently different (D213): the frame shows the clip plain and says why.
              notes.push(`the shader effect ${shader.def.name} on "${v.item.name ?? v.item.id}" isn't drawn: ${(error as Error).message.replace(/^The text renderer failed: /, "").replace(/^no-webgpu: /, "this Mac has no WebGPU: ")}`);
            }
          }
          k++;
          inputs.push(...source);
          if (picture && (effects || shader)) {
            const lut = effects?.colour ? colourLut(effects.colour) : undefined;
            if (lut && !luts.has(lut.key)) {
              const file = join(temp, `lut-${lut.key}.cube`);
              await writeFile(file, cubeText(lut));
              luts.set(lut.key, file);
            }
            // The effects' size as the export's: the picture's fit before any zoom (its placement's when unzoomed).
            const fit = fitRect(baseBox(v.item, project.canvas, media.probe), v.box.fit, media.probe);
            const zoomed = v.box.scale !== 1;
            const lf = { fx: effects ?? {}, start: starts.get(v.item.id) ?? 0, w: zoomed ? Math.max(1, Math.round((fit.w * W) / cw)) : p.cw, h: zoomed ? Math.max(1, Math.round((fit.h * H) / ch)) : p.ch, k: H / ch, ...(lut ? { lut } : {}) };
            graph.push(`[${k}:v:0]${pick}null[e${k}]`, ...fxGraph(lf, `e${k}`, `s${k}`, project.canvas.fps, f, luts), ...boxGraph([p], `s${k}`, `r${k}`, project.canvas.fps));
          } else graph.push(`[${k}:v:0]${pick}null[s${k}]`, ...boxGraph([p], `s${k}`, `r${k}`, project.canvas.fps));
          graph.push(`[r${k}]format=rgba${fade}${blur}${visible < p.w ? `,crop=w=${visible}:h=${p.h}:x=0:y=0:exact=1` : ""}${iris(p.x, p.y)}[l${k}]`);
          graph.push(`[${base}][l${k}]overlay=x=${p.x}:y=${p.y}:format=auto[b${k}]`);
          base = `b${k}`;
          await overlay();
          continue;
        }
        k++;
        inputs.push(...input);
        const full = `[${k}:v:0]${picked}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba${fade}`;
        if (!v.box && (v.shift !== undefined || v.shiftY !== undefined || v.zoom !== undefined)) {
          // Text, a background or a graphic pushed or zoomed (D79): the canvas as its box, moved.
          const p = placementOf(moveBox(canvasBox(project.canvas), v.shift, v.zoom, v.shiftY), W / cw, H / ch, canvasBox(project.canvas));
          graph.push(`${full}[s${k}]`, ...boxGraph([p], `s${k}`, `r${k}`, project.canvas.fps));
          graph.push(`[r${k}]format=rgba${blur}[l${k}]`);
          graph.push(`[${base}][l${k}]overlay=x=${p.x}:y=${p.y}:format=auto[b${k}]`);
          base = `b${k}`;
          continue;
        }
        graph.push(`${full}${blur}${iris(0, 0)}${shown < W ? `,crop=w=${shown}:h=${H}:x=0:y=0,pad=${W}:${H}:0:0:color=black@0` : ""}[l${k}]`);
        graph.push(`[${base}][l${k}]overlay=format=auto[b${k}]`);
        base = `b${k}`;
        await overlay();
      }
      graph.push(`[${base}]format=yuvj420p[out]`);
      const file = join(temp, `frame-${f}.jpg`);
      const r = await run(bin, ["-hide_banner", "-nostdin", "-y", "-v", "error", ...inputs, "-filter_complex", graph.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "4", "-update", "1", file], signal);
      if (r.code !== 0) throw new Error(`Frame ${f} couldn't be rendered: ${ffmpegError(r.stderr)}`);
      out.push({ frame: f, jpeg: await readFile(file), ...(notes.length ? { notes } : {}) });
    }
    return out;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await raster?.close().catch(() => {});
    media.close();
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
