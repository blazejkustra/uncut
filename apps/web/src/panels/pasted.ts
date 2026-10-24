// D201: pasted and dropped files in the composer: which go in as path chips and which attach as
// images. Pure, so it is tested without the app.
import { AGENT_IMAGE_TYPES } from "@uncut/contracts";

/** D201: only these attach as images; anything else from disk (a folder, an SVG, a video, a font) goes in as its path. */
export const isAttachable = (f: File) => (AGENT_IMAGE_TYPES as ReadonlyArray<string>).includes(f.type);
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const stem = (name: string) => name.replace(/\.[^./]+$/, "");
/** Paths as the composer writes them: a space escaped as Terminal does (D200's path chips read it). */
export const quotePaths = (paths: ReadonlyArray<string>) => paths.map((p) => p.replace(/ /g, "\\ ")).join(" ");

/**
 * D201: what a paste with files means. A File with a disk path is that path (an image file of an
 * attachable type attaches). Finder's copy can come as a File with no path (macOS hands over the
 * icon, a TIFF named after the folder): the clipboard's own file list (the desktop reads Finder's
 * pasteboard) gives the real path, matched by name. A picture with no file behind it (a
 * screenshot, an image copied from a page) attaches; `unknown` is anything else.
 */
export function sortPasted(
  files: ReadonlyArray<{ readonly name: string; readonly type: string; readonly path: string }>,
  copied: ReadonlyArray<string>,
): { paths: Array<string>; attach: Array<number>; unknown: Array<number> } {
  const paths: Array<string> = [];
  const attach: Array<number> = [];
  const unknown: Array<number> = [];
  const attachable = (type: string) => (AGENT_IMAGE_TYPES as ReadonlyArray<string>).includes(type);
  const used = new Set<string>();
  const addPath = (p: string) => {
    used.add(p);
    if (!paths.includes(p)) paths.push(p);
  };
  files.forEach((f, i) => {
    if (f.path.startsWith("/")) return attachable(f.type) && IMAGE_FILE.test(f.path) ? attach.push(i) : addPath(f.path);
    const match = copied.find((p) => !used.has(p) && (baseName(p) === f.name || stem(baseName(p)) === stem(f.name)));
    if (match) {
      used.add(match);
      return attachable(f.type) && IMAGE_FILE.test(match) ? attach.push(i) : addPath(match);
    }
    if (attachable(f.type) && !copied.length) return attach.push(i);
    unknown.push(i);
  });
  // Finder copied more items than the paste carried Files for: the rest go in as paths too (an image among them as its path: no picture came with it).
  if (copied.length && files.every((f) => !f.path.startsWith("/"))) for (const p of copied) if (!used.has(p)) addPath(p);
  return { paths, attach, unknown: copied.length ? unknown.filter((i) => !files[i]!.type.startsWith("image/")) : unknown };
}
