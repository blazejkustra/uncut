// FCPXML import: the file's first sequence as a flat list of clips, then the ops that build it in an
// empty project. Times in the file are seconds; a project counts frames.
import type { CanvasFps, Id, Item, Op, Project, Track } from "../types.ts";
import { parseXml, type XmlNode } from "./xml.ts";

export interface TimelineClip {
  readonly kind: "picture" | "text";
  readonly path?: string;
  readonly text?: string;
  readonly name?: string;
  /** 0 is the main track; above 0 picture lanes, below 0 sound lanes. */
  readonly lane: number;
  readonly start: number;
  readonly in: number;
  readonly duration: number;
  readonly gainDb?: number;
  /** The dissolve into this clip, in frames. */
  readonly dissolve?: number;
}

export interface TimelineFile {
  readonly name: string;
  readonly canvas?: { readonly width: number; readonly height: number; readonly fps: CanvasFps };
  readonly fps: number;
  readonly clips: ReadonlyArray<TimelineClip>;
  readonly warnings: ReadonlyArray<string>;
}

const FPS: ReadonlyArray<CanvasFps> = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

/** "3003/30000s", "12s" as seconds; absent is 0. */
export function seconds(value: string | undefined): number {
  const m = /^(-?[\d.]+)(?:\/(\d+))?s$/.exec(value ?? "");
  const time = m ? Number(m[1]) / Number(m[2] ?? 1) : 0;
  return Number.isFinite(time) ? time : 0;
}

const pathOfUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" ? decodeURIComponent(parsed.pathname) : undefined;
  } catch {
    return undefined;
  }
};

const find = (node: XmlNode, name: string): XmlNode | undefined => {
  for (const child of node.children) {
    if (child.name === name) return child;
    const inner = find(child, name);
    if (inner) return inner;
  }
  return undefined;
};

const CLIPS = new Set(["asset-clip", "video", "audio", "title", "clip"]);
const NESTED = new Set(["ref-clip", "sync-clip", "mc-clip", "auditions", "spine"]);

export function readFcpxml(source: string): TimelineFile | { readonly problem: string } {
  const root = parseXml(source);
  if (root?.name !== "fcpxml") return { problem: "That isn't an FCPXML file." };
  const sequence = find(root, "sequence");
  const spine = sequence && find(sequence, "spine");
  const resources = root.children.find((c) => c.name === "resources");
  if (!sequence || !spine || !resources) return { problem: "That FCPXML file has no timeline." };

  const byId = new Map(resources.children.map((r) => [r.attributes.id, r]));
  const format = byId.get(sequence.attributes.format);
  const frame = seconds(format?.attributes.frameDuration) || 1 / 30;
  const rate = FPS.reduce((best, f) => (Math.abs(f - 1 / frame) < Math.abs(best - 1 / frame) ? f : best));
  const width = Number(format?.attributes.width);
  const height = Number(format?.attributes.height);
  const canvas = width > 0 && height > 0 ? { width, height, fps: rate } : undefined;
  const listedRate = Math.abs(rate - 1 / frame) < 0.01;
  const perSecond = listedRate ? 1 / frame : rate;
  const frames = (s: number) => Math.round(s * perSecond);

  const warnings = new Set<string>();
  if (!listedRate) warnings.add(`The file runs at ${Math.round((100 * 1) / frame) / 100} fps, which a project can't, so it's timed at ${rate} fps.`);
  const clips: Array<TimelineClip> = [];

  const assetPath = (node: XmlNode) => {
    const asset = byId.get(node.attributes.ref ?? "");
    const url = asset?.attributes.src ?? asset?.children.find((c) => c.name === "media-rep")?.attributes.src;
    return url ? pathOfUrl(url) : undefined;
  };
  /** Where an asset's own timecode begins: a clip's start counts from there. */
  const assetStart = (node: XmlNode) => seconds(byId.get(node.attributes.ref ?? "")?.attributes.start);
  /** A `clip` wraps its video or audio: the media is theirs, the timing its own. */
  const mediaNode = (node: XmlNode) => (node.name === "clip" ? (node.children.find((c) => c.name === "video" || c.name === "audio") ?? node) : node);

  const add = (node: XmlNode, at: number, lane: number, dissolve: number | undefined) => {
    const start = frames(at);
    const duration = frames(seconds(node.attributes.duration));
    const name = node.attributes.name;
    if (duration <= 0) return;
    if (node.name === "title") {
      clips.push({ kind: "text", text: find(node, "text-style")?.text ?? name ?? "", lane, start, in: 0, duration, ...(name ? { name } : {}) });
      return;
    }
    const path = assetPath(mediaNode(node));
    if (!path) {
      warnings.add(`${name ?? "A clip"} is left out: it names no local file.`);
      return;
    }
    const volume = /^(-?[\d.]+)dB$/.exec(node.children.find((c) => c.name === "adjust-volume")?.attributes.amount ?? "");
    clips.push({
      kind: "picture",
      path,
      lane,
      start,
      in: frames(Math.max(0, seconds(node.attributes.start ?? mediaNode(node).attributes.start) - assetStart(mediaNode(node)))),
      duration,
      ...(name ? { name } : {}),
      ...(volume ? { gainDb: Number(volume[1]) } : {}),
      ...(dissolve ? { dissolve } : {}),
    });
  };

  const walkConnected = (parent: XmlNode, offset: number) => {
    const localStart = seconds(parent.attributes.start);
    for (const child of parent.children) {
      if (CLIPS.has(child.name) && child.attributes.lane !== undefined)
        add(child, offset + seconds(child.attributes.offset) - localStart, Number(child.attributes.lane) || 1, undefined);
      else if (NESTED.has(child.name)) warnings.add(`${child.attributes.name ?? child.name} is left out: compound, sync and multicam clips don't carry over.`);
    }
  };

  const tcStart = seconds(sequence.attributes.tcStart);
  let cursor = 0;
  let dissolve: number | undefined;
  for (const node of spine.children) {
    if (node.name === "transition") {
      dissolve = frames(seconds(node.attributes.duration));
      continue;
    }
    const offset = node.attributes.offset === undefined ? cursor : Math.max(0, seconds(node.attributes.offset) - tcStart);
    if (CLIPS.has(node.name)) add(node, offset, 0, dissolve);
    else if (NESTED.has(node.name)) warnings.add(`${node.attributes.name ?? node.name} is left out: compound, sync and multicam clips don't carry over.`);
    dissolve = undefined;
    walkConnected(node, offset);
    cursor = offset + seconds(node.attributes.duration);
  }

  const name = find(root, "project")?.attributes.name ?? sequence.attributes.name ?? "Timeline";
  return { name, fps: rate, clips, warnings: [...warnings], ...(canvas ? { canvas } : {}) };
}

const freeId = (stem: string, taken: Set<string>) => {
  let id = stem;
  for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
  taken.add(id);
  return id;
};

type MediaRef = { readonly id: Id; readonly kind: "video" | "image" | "audio" };

/**
 * The ops that put a read timeline in `project`, its main track empty and no other items. Each clip's
 * media comes from `mediaOf` by path: one missing is left out, with a warning.
 */
export function planImportTimeline(
  project: Pick<Project, "tracks">,
  file: TimelineFile,
  mediaOf: (path: string) => MediaRef | undefined,
  taken: Set<string>,
): { readonly ops: ReadonlyArray<Op>; readonly warnings: ReadonlyArray<string>; readonly clips: number } | { readonly problem: string } {
  const main = project.tracks.find((t) => t.role === "main");
  if (!main || project.tracks.some((t) => t.items.length))
    return { problem: "A timeline file goes in an empty project: start a new project and import it there." };
  const warnings = [...file.warnings];
  const ops: Array<Op> = [];
  const itemOf = (clip: TimelineClip): Item | undefined => {
    const id = freeId(
      `i-${
        (clip.name ?? clip.kind)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "clip"
      }`,
      taken,
    );
    const name = clip.name ? { name: clip.name } : {};
    if (clip.kind === "text") return { id, type: "text", duration: clip.duration, text: clip.text ?? "", style: { preset: "text.title" }, ...name };
    const media = mediaOf(clip.path!);
    if (!media) {
      warnings.push(`${clip.name ?? clip.path} is left out: its file couldn't be imported.`);
      return undefined;
    }
    return {
      id,
      type: media.kind === "audio" ? "audio" : "clip",
      media: media.id,
      duration: clip.duration,
      ...(media.kind === "image" ? {} : { in: clip.in }),
      ...(clip.gainDb ? { gainDb: clip.gainDb } : {}),
      ...name,
    };
  };

  let end = 0;
  for (const clip of file.clips.filter((c) => c.lane === 0).sort((a, b) => a.start - b.start)) {
    const item = itemOf(clip);
    if (!item) continue;
    const gap = Math.max(0, clip.start - end);
    const transitionIn = clip.dissolve && !gap && end > 0 ? { module: "transition.crossfade", duration: clip.dissolve } : undefined;
    ops.push({ op: "insert_item", track: main.id, item: { ...item, ...(gap ? { gap } : {}), ...(transitionIn ? { transitionIn } : {}) } });
    end = clip.start + clip.duration;
  }

  const lanes = [...new Set(file.clips.map((c) => c.lane))].filter((l) => l !== 0).sort((a, b) => b - a);
  for (const lane of lanes) {
    const clips = file.clips.filter((c) => c.lane === lane);
    const kind: Track["kind"] = lane < 0 ? "audio" : clips.every((c) => c.kind === "text") ? "text" : "video";
    const id = freeId(`t-${kind}-${Math.abs(lane)}`, taken);
    const label = `${kind === "audio" ? "Audio" : kind === "text" ? "Text" : "Video"} ${Math.abs(lane)}`;
    ops.push({ op: "add_track", track: { id, kind, name: label, items: [] }, ...(lane > 0 ? { index: 0 } : {}) });
    for (const clip of clips) {
      const item = itemOf(clip);
      if (item) ops.push({ op: "insert_item", track: id, item: { ...item, start: clip.start } });
    }
  }
  return { ops, warnings, clips: ops.filter((o) => o.op === "insert_item").length };
}
