// What the timeline's right-click menus hold (T7, D126): on items (the selection when the item is
// in it), on track heads and on empty timeline. Every entry is an existing action (one edit, one
// ⌘Z) or a UI step (rename in place, the Inspector's custom speed).
import { soundMedia } from "@uncut/core/audio";
import { SPEED_PRESETS, speedLabel } from "@uncut/core/arrange";

import { clipboardItems, copySelection, deleteSelection, duplicate, paste } from "../editor/keys.ts";
import { getPlayback, playback } from "../preview/playback.ts";
import { itemLabel, type ProjectModel, type Track } from "../state/project.ts";
import { actions, getState, isRemote } from "../state/store.ts";
import type { MenuItems } from "./ContextMenu.tsx";
import { findItem, trackFlag } from "./edit.ts";
import { keysOf } from "../editor/keymap.ts";

/** A menu row's key hint: the keymap's first key for the action (#78), so a rebinding shows. */
const keyHint = (id: Parameters<typeof keysOf>[0]) => {
  const key = keysOf(id)[0];
  return key ? { shortcut: key } : {};
};

export interface MenuUi {
  /** Rename the item in place on its clip. */
  readonly renameItem: (id: string) => void;
  readonly renameTrack: (id: string) => void;
  /** The Inspector's custom speed field. */
  readonly customSpeed: (id: string) => void;
}

/** The ids a menu on `itemId` acts on: the selection when the item is in it, else just the item (which gets selected). */
export function menuSelection(itemId: string): ReadonlyArray<string> {
  const { selected, also } = getPlayback();
  const current = selected === undefined ? [] : [selected, ...also];
  if (current.includes(itemId)) return current;
  playback.select(itemId);
  return [itemId];
}

export function itemMenu(project: ProjectModel, itemId: string, ui: MenuUi, online: boolean): MenuItems {
  const placed = findItem(project, itemId);
  if (!placed) return [];
  const ids = menuSelection(itemId);
  const many = ids.length > 1;
  const { item, track, start } = placed;
  const locked = !!(track.locked || item.locked);
  const off = !online;
  const frame = getPlayback().frame;
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  const timed = (item.type === "clip" || item.type === "audio") && media && media.kind !== "image";
  const sound = soundMedia(project, item);
  const speed = item.speed ?? 1;
  const others = project.media.filter((m) => m.id !== item.media && (item.type === "audio" ? m.kind === "audio" || (m.kind === "video" && m.probe?.hasAudio) : m.kind !== "audio"));
  const local = !isRemote();
  return [
    // D141: the item as a chip in the Agent tab's composer, with its time range.
    { id: "add-to-chat", label: many ? `Add ${ids.length} items to chat` : "Add to chat", ...keyHint("addToChat"), run: () => ids.forEach((id) => actions.addItemToChat(id)) },
    "-",
    { id: "split", label: "Split", shortcut: "S", disabled: off || many || locked || !(frame > start && frame < start + item.duration) || item.type === "captions", run: () => void actions.split() },
    "-",
    { id: "copy", label: "Copy", shortcut: "⌘C", disabled: item.type === "captions", run: () => void copySelection() },
    { id: "paste", label: "Paste", shortcut: "⌘V", disabled: off || !clipboardItems().length, run: () => void paste() },
    { id: "duplicate", label: "Duplicate", shortcut: "⌘D", disabled: off || locked || item.type === "captions", run: () => void duplicate() },
    "-",
    { id: "delete", label: many ? `Delete ${ids.length} items` : "Delete", shortcut: "⌫", danger: true, disabled: off || locked, run: () => void deleteSelection() },
    { id: "ripple-delete", label: "Ripple delete", shortcut: "⇧⌫", danger: true, disabled: off || locked, run: () => void actions.rippleDelete(ids) },
    "-",
    // D215: a picture off Main goes on it (a take from any of its parts: its picture, sounds linked under it).
    ...(track.role !== "main" && item.type !== "captions" && !item.linkedTo && (item.type !== "audio" || !!item.group)
      ? [{ id: "put-on-main", label: "Put on Main", disabled: off || locked || (item.type === "audio" && !takeHasPicture(project, item)), run: () => void actions.putOnMain(item.id) }]
      : []),
    ...(item.type === "clip" && media?.kind === "video" && media.probe?.hasAudio
      ? [{ id: "detach-audio", label: item.mute ? "Audio detached" : "Detach audio", disabled: off || many || locked || !sound, run: () => void actions.detachAudio(item.id) }]
      : []),
    ...(timed
      ? [
          {
            id: "speed",
            label: `Speed${speed !== 1 ? `  ${speedLabel(speed)}` : ""}`,
            disabled: off || many || locked,
            submenu: [
              ...SPEED_PRESETS.map((s) => ({ id: `speed-${s}`, label: speedLabel(s), checked: Math.abs(s - speed) < 1e-6, run: () => void actions.setSpeed(item.id, s) })),
              "-" as const,
              { id: "speed-custom", label: "Custom…", run: () => ui.customSpeed(item.id) },
              { id: "speed-pitch", label: "Keep pitch", checked: item.keepPitch !== false, run: () => void actions.setSpeed(item.id, speed, item.keepPitch === false) },
            ],
          },
        ]
      : []),
    // F27 (D169): music trimmed or looped to the end of the picture, with a fade out.
    ...(item.type === "audio" && track.role !== "main" ? [{ id: "fit-to-video", label: "Fit to video", disabled: off || many || locked, run: () => void actions.fitToVideo(item.id) }] : []),
    { id: "rename", label: "Rename", disabled: off || many || locked || item.type === "captions", run: () => ui.renameItem(item.id) },
    ...(item.media && (item.type === "clip" || item.type === "audio")
      ? [
          {
            id: "replace-media",
            label: "Replace media",
            disabled: off || many || locked || !others.length,
            submenu: others.length ? others.map((m) => ({ id: `replace-${m.id}`, label: m.name, run: () => void actions.replaceMedia(item.id, m.id) })) : [{ id: "replace-none", label: "No other media", disabled: true }],
          },
          { id: "show-in-media", label: "Show in Media", disabled: !media, run: () => media && actions.showInMedia(media.id) },
          ...(local && media ? [{ id: "reveal", label: "Reveal in Finder", run: () => void actions.showInFolder(media.path.startsWith("/") ? media.path : `${getState().snapshot?.dir ?? ""}/${media.path}`) }] : []),
        ]
      : []),
    "-",
    ...((item.type === "clip" && media?.kind === "video" && media.probe?.hasAudio) || item.type === "audio"
      ? [{ id: "mute", label: item.mute ? "Unmute" : "Mute", checked: !!item.mute, disabled: off || many || locked, run: () => void actions.toggleItem(item.id, "mute") }]
      : []),
    { id: "lock", label: item.locked ? "Unlock" : "Lock", checked: !!item.locked, disabled: off || many || track.locked, run: () => void actions.toggleItem(item.id, "locked") },
    // D157: a kicker and its title (or any items grouped here) move, trim and delete together.
    ...(item.group
      ? ["-" as const, { id: "ungroup", label: "Ungroup", disabled: off || locked, run: () => void actions.grouping(ids, false) }]
      : many && track.role !== "main"
        ? ["-" as const, { id: "group", label: `Group ${ids.length} items`, disabled: off || locked, run: () => void actions.grouping(ids, true) }]
        : []),
  ];
}

/** A sound's group has a picture to put on Main (D215). */
const takeHasPicture = (project: ProjectModel, item: { readonly group?: string | undefined; readonly id: string }) => !!item.group && project.tracks.some((t) => t.role !== "main" && t.items.some((i) => i.group === item.group && i.id !== item.id && i.type === "clip"));

const KIND_NAMES = { video: "video", text: "text", audio: "audio" } as const;

export function trackMenu(project: ProjectModel, track: Track, ui: MenuUi, online: boolean): MenuItems {
  const off = !online;
  const audio = track.kind === "audio";
  const sound = audio || track.items.some((i) => soundMedia(project, i));
  return [
    // D264 (#77): the track as a chip in the Agent tab's composer.
    { id: "add-to-chat", label: "Add to chat", run: () => void actions.addTrackToChat(track.id) },
    "-",
    { id: "track-rename", label: "Rename track", disabled: off || track.locked, run: () => ui.renameTrack(track.id) },
    "-",
    ...(!audio ? [{ id: "track-hide", label: trackFlag(track, "hidden") ? "Show" : "Hide", checked: trackFlag(track, "hidden"), disabled: off, run: () => void actions.toggleTrack(track.id, "hidden") }] : []),
    ...(sound ? [{ id: "track-mute", label: trackFlag(track, "mute") ? "Unmute" : "Mute", checked: trackFlag(track, "mute"), disabled: off, run: () => void actions.toggleTrack(track.id, "mute") }] : []),
    ...(sound ? [{ id: "track-solo", label: "Solo", checked: trackFlag(track, "solo"), disabled: off, run: () => void actions.toggleTrack(track.id, "solo") }] : []),
    { id: "track-lock", label: track.locked ? "Unlock" : "Lock", checked: !!track.locked, disabled: off, run: () => void actions.toggleTrack(track.id, "locked") },
    "-",
    { id: "track-select", label: "Select all on this track", disabled: !track.items.length, run: () => playback.selectMany(track.items.filter((i) => i.type !== "captions").map((i) => i.id)) },
    ...addTrackEntries(project, off, track),
    ...(track.role !== "main"
      ? [{ id: "track-delete", label: "Delete track", danger: true, disabled: off || track.locked || track.items.some((i) => i.locked), run: () => void actions.deleteTrack(track.id) }]
      : []),
  ];
}

function addTrackEntries(project: ProjectModel, off: boolean, near?: Track): MenuItems {
  return [
    {
      id: "add-track",
      label: "Add track",
      disabled: off,
      submenu: (["video", "text", "audio"] as const).map((kind) => ({ id: `add-track-${kind}`, label: `${KIND_NAMES[kind][0]!.toUpperCase()}${KIND_NAMES[kind].slice(1)} track`, run: () => void actions.addTrack(kind, near?.id) })),
    },
  ];
}

/** Right-click on empty timeline (a lane's background or below the tracks) at `frame`. */
/** D183: right-click on the ruler or the playhead: that moment, or the In/Out range, into the chat. */
export function rulerMenu(frame: number, marks: { readonly markIn?: number | undefined; readonly markOut?: number | undefined; readonly end: number }): MenuItems {
  const hasRange = marks.markIn !== undefined || marks.markOut !== undefined;
  const start = marks.markIn ?? 0;
  const end = marks.markOut ?? marks.end;
  return [
    { id: "add-moment-to-chat", label: "Add this moment to chat", run: () => actions.addMomentToChat(frame) },
    ...(hasRange ? [{ id: "add-range-to-chat", label: "Add range to chat", disabled: end <= start, run: () => actions.addRangeToChat(start, end) }] : []),
  ];
}

export function emptyMenu(project: ProjectModel, frame: number, track: Track | undefined, online: boolean): MenuItems {
  const off = !online;
  const label = track ? itemsLabel(project, track) : undefined;
  return [
    { id: "paste-here", label: "Paste here", shortcut: "⌘V", disabled: off || !clipboardItems().length, run: () => void paste(frame) },
    { id: "split-playhead", label: "Split at the playhead", shortcut: "S", disabled: off, run: () => void actions.split() },
    "-",
    { id: "select-all", label: "Select all", shortcut: "⌘A", run: () => playback.selectMany(project.tracks.flatMap((t) => t.items.filter((i) => i.type !== "captions").map((i) => i.id))) },
    ...(track && label ? [{ id: "track-select", label: "Select all on this track", run: () => playback.selectMany(track.items.filter((i) => i.type !== "captions").map((i) => i.id)) }] : []),
    "-",
    ...addTrackEntries(project, off, track),
  ];
}

const itemsLabel = (project: ProjectModel, track: Track) => (track.items.length ? itemLabel(project, track.items[0]!) : undefined);
