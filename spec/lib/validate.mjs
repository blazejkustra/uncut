// Reference validator for the Uncut project format and module manifests.
// Schema checks catch shape errors; the rules below catch what a schema can't:
// references, overlaps, ranges and module kinds.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const schemaDir = fileURLToPath(new URL("../schema/", import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
const projectSchema = ajv.compile(await readJson(join(schemaDir, "project.schema.json")));
const moduleSchema = ajv.compile(await readJson(join(schemaDir, "module.schema.json")));
const paramsCache = new Map();

const ITEM_TRACK_KINDS = {
  clip: ["video"],
  component: ["video"],
  graphic: ["video"],
  text: ["text"],
  captions: ["text"],
  audio: ["audio"],
};

/** Load every *.json manifest in the given directories into a Map by id. */
export async function loadModules(...dirs) {
  const modules = new Map();
  for (const dir of dirs) {
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
      const manifest = await readJson(join(dir, file));
      modules.set(manifest.id, manifest);
    }
  }
  return modules;
}

export function validateModule(manifest) {
  const ok = moduleSchema(manifest);
  return ok ? [] : moduleSchema.errors.map((e) => err("schema", e.instancePath || "/", `${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ""}`));
}

/** Start frame of every item: main-track items play back to back, free items carry `start`. */
export function resolveStarts(project) {
  const starts = new Map();
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

export function projectDuration(project) {
  const starts = resolveStarts(project);
  let end = 0;
  for (const track of project.tracks) for (const item of track.items) end = Math.max(end, starts.get(item.id) + item.duration);
  return end;
}

function err(code, path, message) {
  return { code, path, message };
}

export function validateProject(project, modules) {
  if (!projectSchema(project)) {
    return projectSchema.errors.map((e) => err("schema", e.instancePath || "/", `${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ""}${e.params?.unevaluatedProperty ? `: ${e.params.unevaluatedProperty}` : ""}`));
  }
  const errors = [];
  const media = new Map(project.media.map((m) => [m.id, m]));
  const trackIds = new Set(project.tracks.map((t) => t.id));
  const starts = resolveStarts(project);
  const duration = projectDuration(project);

  // Unique ids across media, tracks, items and scenes.
  const seen = new Set();
  const ids = [
    ...project.media.map((m) => [m.id, `/media/${m.id}`]),
    ...project.tracks.map((t) => [t.id, `/tracks/${t.id}`]),
    ...project.tracks.flatMap((t) => t.items.map((i) => [i.id, `/tracks/${t.id}/items/${i.id}`])),
    ...(project.scenes ?? []).map((s) => [s.id, `/scenes/${s.id}`]),
  ];
  for (const [id, path] of ids) {
    if (seen.has(id)) errors.push(err("duplicate-id", path, `id "${id}" is used more than once`));
    seen.add(id);
  }

  const mains = project.tracks.filter((t) => t.role === "main");
  if (mains.length !== 1) errors.push(err("main-track-count", "/tracks", `expected exactly one main track, found ${mains.length}`));

  const useModule = (id, kinds, path) => {
    const m = modules.get(id);
    if (!m) errors.push(err("unknown-module", path, `module "${id}" is not installed`));
    else if (!kinds.includes(m.kind)) errors.push(err("module-kind", path, `module "${id}" is a ${m.kind}, expected ${kinds.join(" or ")}`));
    return m;
  };
  const checkParams = (manifest, value, path) => {
    if (!manifest?.params) return;
    if (!paramsCache.has(manifest.id)) paramsCache.set(manifest.id, ajv.compile(manifest.params));
    const check = paramsCache.get(manifest.id);
    if (!check(value ?? {})) {
      for (const e of check.errors) errors.push(err("params", path + e.instancePath, `${manifest.id}: ${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ""}`));
    }
  };
  const checkMediaRefs = (value, path) => {
    if (value && typeof value === "object") {
      if (typeof value.media === "string" && Object.keys(value).length === 1 && !media.has(value.media)) {
        errors.push(err("unknown-media", path, `media "${value.media}" does not exist`));
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
      for (const under of fx.params?.under ?? []) {
        if (!trackIds.has(under)) errors.push(err("unknown-track", `${tpath}/mixer`, `duck target track "${under}" does not exist`));
      }
    }

    const sorted = [...track.items].sort((a, b) => starts.get(a.id) - starts.get(b.id));
    track.items.forEach((item, index) => {
      const ipath = `${tpath}/items/${item.id}`;
      const start = starts.get(item.id);
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
        const m = useModule(item.component, ["component"], ipath);
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
        const kinds = track.kind === "audio" ? ["audio-processor"] : ["effect"];
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
          const prev = track.items[index - 1];
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
        const a = sorted[i - 1];
        const b = sorted[i];
        if (starts.get(b.id) < starts.get(a.id) + a.duration) {
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
    if (i > 0 && s.start < scenes[i - 1].end) errors.push(err("scene-overlap", `/scenes/${s.id}`, `overlaps "${scenes[i - 1].id}"`));
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
