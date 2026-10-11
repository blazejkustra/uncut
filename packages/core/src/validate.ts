// Reference validator for the Uncut project format and module manifests.
// Schema checks catch shape errors; the rules below catch what a schema can't:
// references, overlaps, ranges and module kinds.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
// The schemas stay in spec/schema (they're the published spec). Importing them, rather than
// reading them at run time, lets the server bundle carry them.
import projectSchemaJson from "../../../spec/schema/project.schema.json" with { type: "json" };
import moduleSchemaJson from "../../../spec/schema/module.schema.json" with { type: "json" };
import editOpsSchemaJson from "../../../spec/schema/edit-ops.schema.json" with { type: "json" };
import type { Item, ItemType, Media, ModuleKind, ModuleManifest, Modules, Problem, Project, Track } from "./types.ts";

// ajv is CommonJS: Node hands over module.exports (the class, which also carries .default) and
// TypeScript sees the module object, so take .default, which is the class either way.
const Ajv2020 = Ajv2020Module.default;

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
const projectSchema = ajv.compile(projectSchemaJson);
const moduleSchema = ajv.compile(moduleSchemaJson);
ajv.addSchema(editOpsSchemaJson);
// One validator per op kind, so a bad op gets that kind's errors, not every oneOf branch's.
const opSchemas = new Map<unknown, ValidateFunction>(
  editOpsSchemaJson.$defs.op.oneOf.map((branch, i) => [branch.properties.op.const, ajv.compile({ $ref: `${editOpsSchemaJson.$id}#/$defs/op/oneOf/${i}` })]),
);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const paramsCache = new Map<string, ValidateFunction>();

const ITEM_TRACK_KINDS: Readonly<Record<ItemType, ReadonlyArray<Track["kind"]>>> = {
  clip: ["video"],
  component: ["video"],
  graphic: ["video"],
  text: ["text"],
  captions: ["text"],
  audio: ["audio"],
};

/** ajv's extra detail for "additional/unevaluated property" errors. */
const extra = (e: ErrorObject, key: "additionalProperty" | "unevaluatedProperty") => {
  const value = (e.params as Record<string, unknown> | undefined)?.[key];
  return value ? `: ${value}` : "";
};

/** Load every *.json manifest in the given directories into a Map by id. */
export async function loadModules(...dirs: ReadonlyArray<string>): Promise<Map<string, ModuleManifest>> {
  const modules = new Map<string, ModuleManifest>();
  for (const dir of dirs) {
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
      const manifest = (await readJson(join(dir, file))) as ModuleManifest;
      modules.set(manifest.id, manifest);
    }
  }
  return modules;
}

export function validateModule(manifest: unknown): Array<Problem> {
  const ok = moduleSchema(manifest);
  return ok ? [] : moduleSchema.errors!.map((e) => err("schema", e.instancePath || "/", `${e.message}${extra(e, "additionalProperty")}`));
}

/**
 * Check a list of edit ops against spec/schema/edit-ops.schema.json, plus what the schema
 * can't say: no prototype keys anywhere and no renaming an item through update_item.
 * Returns problems ({ code, path, message }); empty when the ops are well-formed.
 */
export function validateOps(ops: unknown): Array<Problem> {
  if (!Array.isArray(ops) || ops.length === 0) return [err("ops", "/", "an edit needs at least one op")];
  const errors: Array<Problem> = [];
  const findUnsafe = (value: unknown, path: string) => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) errors.push(err("unsafe-key", `${path}/${key}`, `"${key}" is not allowed`));
      else findUnsafe((value as Record<string, unknown>)[key], `${path}/${key}`);
    }
  };
  ops.forEach((op: { op?: unknown; set?: unknown } | null | undefined, i) => {
    const path = `/${i}`;
    findUnsafe(op, path);
    const check = opSchemas.get(op?.op);
    if (!check) return errors.push(err("unknown-op", `${path}/op`, `unknown op ${JSON.stringify(op?.op)}`));
    if (!(check(op) as boolean)) {
      for (const e of check.errors!) errors.push(err("schema", path + (e.instancePath || ""), `${op!.op}: ${e.message}${extra(e, "additionalProperty")}`));
    }
    if (op!.op === "update_item" && op!.set && typeof op!.set === "object" && "id" in op!.set) {
      errors.push(err("rename", `${path}/set/id`, "an item's id can't be changed"));
    }
  });
  return errors;
}

/** Start frame of every item: main-track items play back to back, free items carry `start`. */
export function resolveStarts(project: Pick<Project, "tracks">): Map<string, number> {
  const starts = new Map<string, number>();
  for (const track of project.tracks) {
    let t = 0;
    for (const item of track.items) {
      if (track.role === "main") {
        starts.set(item.id, t);
        t += item.duration;
      } else {
        starts.set(item.id, item.start ?? 0);
      }
    }
  }
  return starts;
}

export function projectDuration(project: Pick<Project, "tracks">): number {
  const starts = resolveStarts(project);
  let end = 0;
  for (const track of project.tracks) for (const item of track.items) end = Math.max(end, starts.get(item.id)! + item.duration);
  return end;
}

function err(code: string, path: string, message: string): Problem {
  return { code, path, message };
}

export function validateProject(input: unknown, modules: Modules): Array<Problem> {
  if (!projectSchema(input)) {
    return projectSchema.errors!.map((e) => err("schema", e.instancePath || "/", `${e.message}${extra(e, "additionalProperty")}${extra(e, "unevaluatedProperty")}`));
  }
  const project = input as unknown as Project;
  const errors: Array<Problem> = [];
  const media = new Map<string, Media>(project.media.map((m) => [m.id, m]));
  const trackIds = new Set(project.tracks.map((t) => t.id));
  const starts = resolveStarts(project);
  const startOf = (item: Item) => starts.get(item.id)!;
  const duration = projectDuration(project);

  // Unique ids across media, tracks, items and scenes.
  const seen = new Set<string>();
  const ids: Array<[string, string]> = [
    ...project.media.map((m): [string, string] => [m.id, `/media/${m.id}`]),
    ...project.tracks.map((t): [string, string] => [t.id, `/tracks/${t.id}`]),
    ...project.tracks.flatMap((t) => t.items.map((i): [string, string] => [i.id, `/tracks/${t.id}/items/${i.id}`])),
    ...(project.scenes ?? []).map((s): [string, string] => [s.id, `/scenes/${s.id}`]),
  ];
  for (const [id, path] of ids) {
    if (seen.has(id)) errors.push(err("duplicate-id", path, `id "${id}" is used more than once`));
    seen.add(id);
  }

  const mains = project.tracks.filter((t) => t.role === "main");
  if (mains.length !== 1) errors.push(err("main-track-count", "/tracks", `expected exactly one main track, found ${mains.length}`));

  const useModule = (id: string, kinds: ReadonlyArray<ModuleKind>, path: string) => {
    const m = modules.get(id);
    if (!m) errors.push(err("unknown-module", path, `module "${id}" is not installed`));
    else if (!kinds.includes(m.kind)) errors.push(err("module-kind", path, `module "${id}" is a ${m.kind}, expected ${kinds.join(" or ")}`));
    return m;
  };
  const checkParams = (manifest: ModuleManifest | undefined, value: unknown, path: string) => {
    if (!manifest?.params) return;
    if (!paramsCache.has(manifest.id)) paramsCache.set(manifest.id, ajv.compile(manifest.params));
    const check = paramsCache.get(manifest.id)!;
    if (!check(value ?? {})) {
      for (const e of check.errors!) errors.push(err("params", path + e.instancePath, `${manifest.id}: ${e.message}${extra(e, "additionalProperty")}`));
    }
  };
  const checkMediaRefs = (value: unknown, path: string) => {
    if (value && typeof value === "object") {
      const ref = value as { media?: unknown };
      if (typeof ref.media === "string" && Object.keys(value).length === 1 && !media.has(ref.media)) {
        errors.push(err("unknown-media", path, `media "${ref.media}" does not exist`));
      }
      for (const [k, v] of Object.entries(value)) checkMediaRefs(v, `${path}/${k}`);
    }
  };

  for (const m of project.media) {
    if (m.source) useModule(m.source.module, ["capture-source", "generator"], `/media/${m.id}/source`);
  }

  for (const track of project.tracks) {
    const tpath = `/tracks/${track.id}`;
    const main = track.role === "main";
    if (main && track.kind !== "video") errors.push(err("main-track-kind", tpath, "the main track must be a video track"));
    for (const fx of track.mixer?.effects ?? []) {
      const m = useModule(fx.module, ["audio-processor"], `${tpath}/mixer`);
      checkParams(m, fx.params, `${tpath}/mixer/${fx.module}`);
      for (const under of (fx.params?.under as ReadonlyArray<string> | undefined) ?? []) {
        if (!trackIds.has(under)) errors.push(err("unknown-track", `${tpath}/mixer`, `duck target track "${under}" does not exist`));
      }
    }

    const sorted = [...track.items].sort((a, b) => startOf(a) - startOf(b));
    track.items.forEach((item, index) => {
      const ipath = `${tpath}/items/${item.id}`;
      if (!ITEM_TRACK_KINDS[item.type].includes(track.kind)) {
        errors.push(err("item-track-kind", ipath, `a ${item.type} item can't go on a ${track.kind} track`));
      }
      if (main && item.start !== undefined) errors.push(err("main-item-start", ipath, "main-track items play back to back and must not have a start"));
      if (!main && item.start === undefined) errors.push(err("missing-start", ipath, "items on free tracks need a start frame"));

      // Media references and ranges.
      const mediaId = item.type === "captions" ? item.source : item.media;
      if (mediaId !== undefined) {
        const m = media.get(mediaId);
        if (!m) errors.push(err("unknown-media", ipath, `media "${mediaId}" does not exist`));
        else {
          const needsAudio = item.type === "audio" || item.type === "captions";
          if (needsAudio && !(m.kind === "audio" || m.probe?.hasAudio)) errors.push(err("media-kind", ipath, `"${mediaId}" has no audio`));
          if (!needsAudio && m.kind === "audio") errors.push(err("media-kind", ipath, `"${mediaId}" is audio-only`));
          const used = (item.in ?? 0) + item.duration * (item.speed ?? 1);
          if (m.kind !== "image" && m.probe?.frames && !item.loop && item.type !== "captions" && used > m.probe.frames) {
            errors.push(err("media-range", ipath, `uses frames up to ${used} but "${mediaId}" has ${m.probe.frames}`));
          }
        }
      }

      if (item.type === "component") {
        const m = useModule(item.component!, ["component"], ipath);
        checkParams(m, item.props, `${ipath}/props`);
      }
      if (item.props) checkMediaRefs(item.props, `${ipath}/props`);
      if (item.type === "text" && item.style?.preset) useModule(item.style.preset, ["text-style"], `${ipath}/style`);
      if (item.type === "captions" && item.style?.preset) useModule(item.style.preset, ["text-style"], `${ipath}/style`);
      for (const [k, a] of Object.entries(item.animation ?? {})) {
        useModule(a.module, ["move"], `${ipath}/animation/${k}`);
        if (a.duration > item.duration) errors.push(err("animation-too-long", `${ipath}/animation/${k}`, `${k} animation is longer than the item`));
      }
      for (const fx of item.effects ?? []) {
        const kinds: ReadonlyArray<ModuleKind> = track.kind === "audio" ? ["audio-processor"] : ["effect"];
        const m = useModule(fx.module, kinds, `${ipath}/effects`);
        checkParams(m, fx.params, `${ipath}/effects/${fx.module}`);
      }
      for (const k of item.gainKeys ?? []) {
        if (k.frame > item.duration) errors.push(err("key-range", `${ipath}/gainKeys`, `key at ${k.frame} is past the item's end (${item.duration})`));
      }
      for (const k of item.keys ?? []) {
        if (k.frame > item.duration) errors.push(err("key-range", `${ipath}/keys`, `key at ${k.frame} is past the item's end (${item.duration})`));
      }
      if ((item.fadeIn ?? 0) + (item.fadeOut ?? 0) > item.duration) errors.push(err("fade-too-long", ipath, "fades are longer than the item"));

      // Transitions only between two main-track items, and no longer than either.
      if (item.transitionIn) {
        const tr = item.transitionIn;
        const m = useModule(tr.module, ["transition"], `${ipath}/transitionIn`);
        if (!main) errors.push(err("transition-track", ipath, "transitions only go between items on the main track"));
        else if (index === 0) errors.push(err("transition-first", ipath, "the first main-track item has nothing to transition from"));
        else {
          const prev = track.items[index - 1]!;
          if (tr.duration > Math.min(prev.duration, item.duration) / 2) {
            errors.push(err("transition-too-long", ipath, `a ${tr.duration}-frame transition needs both items to be at least ${tr.duration * 2} frames`));
          }
          // A transition is centred on the cut, so both clips need spare media (handles) past the cut.
          const half = Math.ceil(tr.duration / 2);
          const prevMedia = prev.media && media.get(prev.media);
          const curMedia = item.media && media.get(item.media);
          if (curMedia && curMedia.kind === "video" && (item.in ?? 0) < half) {
            errors.push(err("transition-handles", ipath, `needs ${half} frames of "${item.media}" before its in-point for the ${tr.module}`));
          }
          if (prevMedia && prevMedia.kind === "video" && prevMedia.probe?.frames && (prev.in ?? 0) + prev.duration + half > prevMedia.probe.frames) {
            errors.push(err("transition-handles", ipath, `"${prev.id}" needs ${half} frames of "${prev.media}" after its out-point for the ${tr.module}`));
          }
          const limits = m?.transition;
          if (limits && (tr.duration < (limits.minFrames ?? 1) || tr.duration > (limits.maxFrames ?? Infinity))) {
            errors.push(err("transition-length", ipath, `${tr.module} takes ${limits.minFrames} to ${limits.maxFrames} frames`));
          }
        }
      }
    });

    // Free tracks: nothing may overlap on one track.
    if (!main) {
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1]!;
        const b = sorted[i]!;
        if (startOf(b) < startOf(a) + a.duration) {
          errors.push(err("overlap", `${tpath}/items/${b.id}`, `"${b.id}" overlaps "${a.id}" on track "${track.id}"`));
        }
      }
    }
  }

  // Scenes and markers sit inside the video, scenes don't overlap.
  const scenes = [...(project.scenes ?? [])].sort((a, b) => a.start - b.start);
  scenes.forEach((s, i) => {
    if (s.end <= s.start) errors.push(err("scene-range", `/scenes/${s.id}`, "a scene must end after it starts"));
    if (s.end > duration) errors.push(err("scene-range", `/scenes/${s.id}`, `ends at ${s.end}, after the video ends (${duration})`));
    if (i > 0 && s.start < scenes[i - 1]!.end) errors.push(err("scene-overlap", `/scenes/${s.id}`, `overlaps "${scenes[i - 1]!.id}"`));
  });
  for (const mk of project.markers ?? []) {
    if (mk.frame > duration) errors.push(err("marker-range", "/markers", `marker at ${mk.frame} is after the video ends (${duration})`));
  }
  for (const fx of project.master?.effects ?? []) {
    const m = useModule(fx.module, ["audio-processor"], "/master/effects");
    checkParams(m, fx.params, `/master/effects/${fx.module}`);
  }
  return errors;
}
