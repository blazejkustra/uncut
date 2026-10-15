import { realpath, stat, readFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { type Project, type FontSource, GRAPHIC_SRC, MAX_GRAPHIC_BYTES, resolveGraphicLibs, resolveGraphicBrand, MAX_GRAPHIC_FONT_BYTES, MAX_GRAPHIC_DOC_BYTES, resolveGraphicFonts, type Media } from "@uncut/core";
import { loadGraphicLibs } from "../graphicLibs.ts";
import { type ProjectFonts, projectFonts } from "../fonts.ts";
import { MEDIA_TOKEN } from "../exportPlan.ts";

/**
 * A project's graphic files (D78), read once: src → its HTML. Only files inside the project's
 * graphics/ folder (by realpath, so a symlink can't reach out), named as the format says, at most
 * MAX_GRAPHIC_BYTES; anything else is left out (the plan then warns that it isn't drawn). Its
 * uncut:lib/ markers come back resolved with `libs` (D193, core resolveGraphicLibs: the bundled
 * libraries inlined; the size cap is the author's file's): the preview route, the export and
 * render_frames all read graphics here, so they all draw the same document.
 */
export async function readGraphics(dir: string, project: Project, libs: Readonly<Record<string, string>> = {}, extras: { readonly fonts?: ReadonlyArray<FontSource>; readonly logos?: Readonly<Partial<Record<"light" | "dark" | "mark", string>>> } = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const srcs = new Set(project.tracks.flatMap((t) => t.items).filter((i) => i.type === "graphic" && typeof i.src === "string").map((i) => i.src!));
  if (!srcs.size) return out;
  const folder = await realpath(join(dir, "graphics")).catch(() => undefined);
  const home = await realpath(dir).catch(() => undefined);
  // A graphics folder that is a symlink out of the project is no source of graphics.
  if (!folder || !home || !folder.startsWith(`${home}/`)) return out;
  for (const src of srcs) {
    if (!GRAPHIC_SRC.test(src)) continue;
    try {
      const real = await realpath(resolve(dir, src));
      if (!real.startsWith(`${folder}/`)) continue;
      const s = await stat(real);
      if (!s.isFile() || s.size > MAX_GRAPHIC_BYTES) continue;
      // D198: the fonts the author's HTML names (bundled and the kit's), the kit's logos for
      // uncut:brand/ markers, then the libraries (whose own code isn't searched for fonts).
      // The fonts get what's left of the document's cap (D193: the export loads it as a data: URL)
      // after the author's file, its logos and its libraries, at most MAX_GRAPHIC_FONT_BYTES.
      const raw = await readFile(real, "utf8");
      const inline = (html: string) => resolveGraphicLibs(resolveGraphicBrand(html, extras.logos ?? {}), libs);
      const budget = Math.min(MAX_GRAPHIC_FONT_BYTES, MAX_GRAPHIC_DOC_BYTES - Buffer.byteLength(inline(raw)) - 16_000);
      out.set(src, inline(extras.fonts?.length ? resolveGraphicFonts(raw, extras.fonts, Math.max(0, budget)) : raw));
    } catch {}
  }
  return out;
}

/**
 * A project's graphics as every drawer reads them (D193, D198): the bundled libraries, the kit's
 * logos and the fonts they name inlined; with the project's fonts (the kit's faces for the
 * rasteriser's CSS, and which families are there).
 */
export async function projectGraphics(paths: { readonly graphicLibsDir: string; readonly fontsDir: string; readonly dataDir: string }, dir: string, project: Project): Promise<{ readonly graphics: Map<string, string>; readonly fonts: ProjectFonts }> {
  const [libs, fonts] = await Promise.all([loadGraphicLibs(paths.graphicLibsDir), projectFonts(paths.fontsDir, { dataDir: paths.dataDir, projectDir: dir })]);
  return { graphics: await readGraphics(dir, project, libs, { fonts: fonts.sources, logos: fonts.logos }), fonts };
}

/** Images a component can show (as data: URLs in the rasteriser): what Chromium decodes. TIFF and HEIC it doesn't, so the Inspector doesn't offer them (core COMPONENT_IMAGE). */
const IMAGE_MIME: Readonly<Record<string, string>> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const TOKEN = new RegExp(`${MEDIA_TOKEN}([a-z0-9][a-z0-9-]*)`, "g");

/**
 * HTML from the plan with each media placeholder (a component's logo, an SVG clip) replaced by the
 * file as a data: URL, which is all the rasteriser page may load. A file it can't read (or a kind
 * Chromium can't show) becomes a transparent pixel. `cache` keeps each file's URL for the run.
 */
export async function withMedia(html: string, project: Project, mediaPath: (m: Media) => string, cache: Map<string, string>): Promise<string> {
  const ids = [...new Set([...html.matchAll(TOKEN)].map((m) => m[1]!))];
  for (const id of ids) {
    if (cache.has(id)) continue;
    const media = project.media.find((m) => m.id === id);
    const mime = media ? IMAGE_MIME[extname(media.path).toLowerCase()] : undefined;
    let url = BLANK_PIXEL;
    if (media && mime) url = await readFile(mediaPath(media)).then((b) => `data:${mime};base64,${b.toString("base64")}`, () => BLANK_PIXEL);
    cache.set(id, url);
  }
  return html.replace(TOKEN, (_, id: string) => cache.get(id) ?? BLANK_PIXEL);
}
