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
  readonly items?: ReadonlyArray<Item>;
}

const readJson = async (file: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

function trackOutline(track: Track) {
  const items = track.items ?? [];
  const types: Record<string, number> = {};
  for (const item of items) if (typeof item.type === "string") types[item.type] = (types[item.type] ?? 0) + 1;
  return { id: track.id, kind: track.kind, name: track.name, ...(track.role ? { role: track.role } : {}), types };
}

const pick = (from: Record<string, unknown> | undefined, keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.filter((k) => from?.[k] !== undefined).map((k) => [k, from![k]]));

async function graphicSizes(dir: string) {
  const names = await readdir(join(dir, "graphics")).catch(() => [] as Array<string>);
  const shown = names.filter((name) => GRAPHIC_FILE.test(name));
  return Promise.all(shown.map(async (name) => ({ name, bytes: (await stat(join(dir, "graphics", name)).catch(() => undefined))?.size ?? 0 })));
}

/** Where a tool's `project` points: a path (~ too), or a project's name beside this one. */
function projectPath(project: string, current: string, home: string) {
  if (project === "~" || project.startsWith("~/")) return join(home, project.slice(1));
  if (isAbsolute(project)) return project;
  if (project.includes("/") || project.includes(sep) || project.startsWith(".")) return undefined;
  return join(dirname(current), /\.uncut$/i.test(project) ? project : `${project}.uncut`);
}

async function graphicFile(dir: string, name: string, current: string, home: string, dataDir: string | undefined): Promise<Peek> {
  if (!GRAPHIC_FILE.test(name)) return { problem: "graphic is a file name from this project's graphics list." };
  const file = await realpath(join(dir, "graphics", name)).catch(() => undefined);
  if (!file || referencePart(file, current, home, dataDir) !== "read" || !file.startsWith(join(dir, "graphics") + sep))
    return { problem: `There's no graphic ${name} to read in that project.` };
  const { size } = await stat(file);
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
  if (o.graphic !== undefined) return graphicFile(dir, o.graphic, current, home, o.dataDir);
  const project = await readJson(join(dir, "project.json"));
  if (!project) return { problem: `${o.project} has no readable project.json.` };
  const tracks = Array.isArray(project.tracks) ? (project.tracks as ReadonlyArray<Track>) : [];
  return {
    name: project.name,
    canvas: project.canvas,
    brief: pick(await readJson(join(dir, "brief.json")), BRIEF_FIELDS),
    look: pick(project, ["theme", "master"]),
    tracks: tracks.map(trackOutline),
    graphics: await graphicSizes(dir),
    note: "Read-only. project_peek with graphic gives one file; media_search finds its footage. Copy the look, not the words: this project's brief decides.",
  };
}
