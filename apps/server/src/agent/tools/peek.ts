// project_peek: a read-only look at another Uncut project (its brief, canvas, look, outline and
// graphics), within the boundary reads have there (referencePart). It reads files only: never
// history.db, never the project's lock, and nothing is written.
import { homedir } from "node:os";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

import { hideSecrets, referencePart } from "../agentPermissions.ts";

/** A graphic file is refused past this size: the whole file goes into the conversation. */
const MAX_FILE_BYTES = 64 * 1024;
const GRAPHIC_FILE = /^[\w][\w .-]*\.(html|js|css|svg|json)$/i;
const BRIEF_FIELDS = ["film", "audience", "duration", "formats", "visual", "hardLines", "type", "skills"] as const;

type Peek = { readonly problem: string } | Record<string, unknown>;

interface Item {
  readonly type?: unknown;
}
interface Track {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly name?: unknown;
  readonly role?: unknown;
  readonly items?: ReadonlyArray<Item | null>;
}
interface Here {
  readonly current: string;
  readonly home: string;
  readonly dataDir: string | undefined;
}

/** A file's real path when reads may open it there, so a link can't lead out of the boundary. */
async function readablePath(file: string, here: Here) {
  const real = await realpath(file).catch(() => undefined);
  return real && referencePart(real, here.current, here.home, here.dataDir) === "read" ? real : undefined;
}

async function readJson(file: string, here: Here): Promise<Record<string, unknown> | undefined> {
  const real = await readablePath(file, here);
  if (!real) return undefined;
  try {
    return JSON.parse(await readFile(real, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function trackOutline(track: Track | null) {
  const items = Array.isArray(track?.items) ? track.items : [];
  const types: Record<string, number> = {};
  for (const item of items) if (typeof item?.type === "string") types[item.type] = (types[item.type] ?? 0) + 1;
  return { id: track?.id, kind: track?.kind, name: track?.name, ...(track?.role ? { role: track.role } : {}), types };
}

const pick = (from: Record<string, unknown> | undefined, keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.filter((k) => from?.[k] !== undefined).map((k) => [k, from![k]]));

/** A graphic's real path, when it is in the project's own graphics folder. */
async function graphicPath(dir: string, name: string, here: Here) {
  const file = await readablePath(join(dir, "graphics", name), here);
  return file?.startsWith(join(dir, "graphics") + sep) ? file : undefined;
}

async function graphicSizes(dir: string, here: Here) {
  const names = await readdir(join(dir, "graphics")).catch(() => [] as Array<string>);
  const sized = await Promise.all(
    names
      .filter((name) => GRAPHIC_FILE.test(name))
      .map(async (name) => {
        const file = await graphicPath(dir, name, here);
        const info = file ? await stat(file).catch(() => undefined) : undefined;
        return info?.isFile() ? [{ name, bytes: info.size }] : [];
      }),
  );
  return sized.flat();
}

function secretsHidden(value: unknown): unknown {
  if (typeof value === "string") return hideSecrets(value);
  if (Array.isArray(value)) return value.map(secretsHidden);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretsHidden(v)]));
  return value;
}

/** Where a tool's `project` points: a path (~ too), or a project's name beside this one. */
function projectPath(project: string, current: string, home: string) {
  if (project === "~" || project.startsWith("~/")) return join(home, project.slice(1));
  if (isAbsolute(project)) return project;
  if (project.includes("/") || project.includes(sep) || project.startsWith(".")) return undefined;
  return join(dirname(current), /\.uncut$/i.test(project) ? project : `${project}.uncut`);
}

async function graphicFile(dir: string, name: string, here: Here): Promise<Peek> {
  if (!GRAPHIC_FILE.test(name)) return { problem: "graphic is a file name from this project's graphics list." };
  const file = await graphicPath(dir, name, here);
  const info = file ? await stat(file) : undefined;
  if (!file || !info?.isFile()) return { problem: `There's no graphic ${name} to read in that project.` };
  const { size } = info;
  if (size > MAX_FILE_BYTES) return { problem: `${name} is ${size} bytes, over the ${MAX_FILE_BYTES} a peek shows. Use Read with an offset and limit.` };
  return { graphic: name, bytes: size, html: hideSecrets(await readFile(file, "utf8")) };
}

export async function peekProject(o: {
  readonly project: string;
  readonly graphic?: string | undefined;
  /** This project's folder. */
  readonly current: string;
  readonly dataDir?: string | undefined;
  readonly home?: string;
}): Promise<Peek> {
  const home = o.home ?? homedir();
  const current = await realpath(o.current).catch(() => o.current);
  const named = projectPath(o.project, current, home);
  const dir = named && (await realpath(named).catch(() => undefined));
  if (!dir) return { problem: `There's no project at ${o.project}. Pass its .uncut folder, or its name when it sits beside this project.` };
  if (referencePart(join(dir, "project.json"), current, home, o.dataDir) !== "read")
    return { problem: `${o.project} isn't another project Uncut can read (this project itself and folders in ~/Library or hidden ones aren't).` };
  const here = { current, home, dataDir: o.dataDir };
  if (o.graphic !== undefined) return graphicFile(dir, o.graphic, here);
  const project = await readJson(join(dir, "project.json"), here);
  if (!project) return { problem: `${o.project} has no readable project.json.` };
  const tracks = Array.isArray(project.tracks) ? (project.tracks as ReadonlyArray<Track | null>) : [];
  return {
    name: project.name,
    canvas: project.canvas,
    brief: secretsHidden(pick(await readJson(join(dir, "brief.json"), here), BRIEF_FIELDS)),
    look: pick(project, ["theme", "master"]),
    tracks: tracks.map(trackOutline),
    graphics: await graphicSizes(dir, here),
    note: "Read-only. project_peek with graphic gives one file; media_search finds its footage. Copy the look, not the words: this project's brief decides.",
  };
}
