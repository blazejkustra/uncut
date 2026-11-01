// FCPXML 1.10 export: the timeline for Final Cut Pro and DaVinci Resolve. The main track is the
// spine, other tracks are connected clips in lanes, source files are referenced where they are.
// docs/timeline-interchange.md says what maps and what's lost.
import type { Item, Media, Project, Track } from "../types.ts";
import { layout } from "../timeline.ts";
import { gapOf } from "../rules.ts";
import { itemLosses, sameTransition } from "./losses.ts";
import { escapeXml as esc } from "./xml.ts";

export const TITLE_EFFECT = ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti";

/** A frame's length as a fraction of a second: the NTSC rates are 1001 over the rate's thousands. */
export function frameFraction(fps: number): { readonly num: number; readonly den: number } {
  const whole = Math.round(fps);
  return Math.abs(whole - fps) < 1e-6 ? { num: 100, den: whole * 100 } : { num: 1001, den: whole * 1000 };
}

const fileUrl = (path: string) => `file://${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`;

interface Placed {
  readonly item: Item;
  readonly start: number;
  readonly lane: number;
}

export function writeFcpxml(project: Project, mediaPath: (media: Media) => string): { readonly text: string; readonly warnings: ReadonlyArray<string> } {
  const { canvas } = project;
  const { num, den } = frameFraction(canvas.fps);
  const time = (frames: number) => (frames === 0 ? "0s" : `${Math.round(frames * 2) * num}/${den * 2}s`);
  const { starts, duration } = layout(project);
  const warnings = new Set<string>();

  const usable = (item: Item) => (item.type === "clip" || item.type === "audio") && project.media.some((m) => m.id === item.media);
  const assetIds = new Map(project.media.map((m, i) => [m.id, `r${i + 3}`]));
  const used = new Set<string>();

  const clipXml = (item: Item, attributes: string, inner = "") => {
    const media = project.media.find((m) => m.id === item.media)!;
    used.add(media.id);
    const gain = item.gainDb ? `<adjust-volume amount="${item.gainDb}dB"/>` : "";
    const element = media.kind === "image" ? "video" : "asset-clip";
    const start = media.kind === "image" ? "" : ` start="${time(item.in ?? 0)}"`;
    return `<${element} ref="${assetIds.get(media.id)}" name="${esc(item.name ?? media.name)}" duration="${time(item.duration)}"${start}${attributes}>${gain}${inner}</${element}>`;
  };
  const titleXml = (item: Item, attributes: string, index: number) =>
    `<title ref="r2" name="${esc(item.name ?? "Title")}" duration="${time(item.duration)}"${attributes}><text><text-style ref="ts${index}">${esc(item.text ?? "")}</text-style></text><text-style-def id="ts${index}"><text-style font="Helvetica" fontSize="63"/></text-style-def></title>`;

  const main = project.tracks.find((t) => t.role === "main");
  const connected: Array<Placed> = [];
  const others = project.tracks.filter((t) => t !== main);
  const mainAt = project.tracks.findIndex((t) => t === main);
  const laneOf = (track: Track) => {
    if (track.kind === "audio") return -1 - others.filter((t) => t.kind === "audio").indexOf(track);
    return Math.max(1, mainAt - project.tracks.indexOf(track));
  };
  for (const track of others) {
    if (track.hidden) warnings.add(`Hidden track ${track.name ?? track.id} is left out.`);
    else
      for (const item of track.items) {
        for (const lost of itemLosses(item)) warnings.add(lost);
        if (usable(item) || (item.type === "text" && item.text)) connected.push({ item, start: starts.get(item.id)!, lane: laneOf(track) });
        else warnings.add(`${item.name ?? item.id} is left out: only clips, sounds and plain text carry over.`);
      }
  }

  const spine: Array<{ item?: Item; offset: number; length: number }> = [];
  let cursor = 0;
  for (const item of main?.items ?? []) {
    for (const lost of itemLosses(item)) warnings.add(lost);
    const gap = gapOf(item);
    if (gap) spine.push({ offset: cursor, length: gap });
    cursor += gap;
    if (usable(item)) spine.push({ item, offset: cursor, length: item.duration });
    else {
      warnings.add(`${item.name ?? item.id} is a gap in the file: only clips carry over.`);
      spine.push({ offset: cursor, length: item.duration });
    }
    cursor += item.duration;
  }
  if (cursor < duration) spine.push({ offset: cursor, length: duration - cursor });

  let titles = 0;
  const anchored = (parent: { offset: number; length: number; item?: Item }, from: number) => {
    const local = (at: number) => (parent.item?.in ?? 0) + at - parent.offset;
    return connected
      .filter((c) => c.start >= parent.offset && c.start < parent.offset + parent.length)
      .filter((c) => c.start >= from)
      .map((c) => {
        const attributes = ` lane="${c.lane}" offset="${time(local(c.start))}"`;
        return c.item.type === "text" ? titleXml(c.item, attributes, ++titles) : clipXml(c.item, attributes);
      })
      .join("");
  };

  const body = spine.map((element) => {
    const children = anchored(element, 0);
    const offset = ` offset="${time(element.offset)}"`;
    if (!element.item) return `<gap name="Gap" offset="${time(element.offset)}" start="0s" duration="${time(element.length)}">${children}</gap>`;
    const transition = element.item.transitionIn;
    if (transition && !sameTransition(transition)) warnings.add(`${element.item.name ?? element.item.id}'s transition is written as a dissolve.`);
    const cut = transition
      ? `<transition name="Cross Dissolve" offset="${time(element.offset - transition.duration / 2)}" duration="${time(transition.duration)}"/>`
      : "";
    return cut + clipXml(element.item, offset, children);
  });

  const assets = project.media
    .filter((m) => used.has(m.id))
    .map((m) => {
      const video = m.kind !== "audio";
      const audio = m.kind === "audio" || (m.kind === "video" && m.probe?.hasAudio !== false);
      const length = m.kind === "image" ? "0s" : time(m.probe?.frames ?? 0);
      const sound = audio ? ' hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"' : "";
      return `<asset id="${assetIds.get(m.id)}" name="${esc(m.name)}" start="0s" duration="${length}"${video ? ' hasVideo="1" format="r1"' : ""}${sound}><media-rep kind="original-media" src="${esc(fileUrl(mediaPath(m)))}"/></asset>`;
    });

  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE fcpxml>",
    '<fcpxml version="1.10">',
    "<resources>",
    `<format id="r1" frameDuration="${num}/${den}s" width="${canvas.width}" height="${canvas.height}" colorSpace="1-1-1 (Rec. 709)"/>`,
    `<effect id="r2" name="Basic Title" uid="${TITLE_EFFECT}"/>`,
    ...assets,
    "</resources>",
    "<library>",
    `<event name="${esc(project.name)}">`,
    `<project name="${esc(project.name)}">`,
    `<sequence format="r1" duration="${time(duration)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    "<spine>",
    ...body,
    "</spine>",
    "</sequence>",
    "</project>",
    "</event>",
    "</library>",
    "</fcpxml>",
    "",
  ].join("\n");
  return { text, warnings: [...warnings] };
}
