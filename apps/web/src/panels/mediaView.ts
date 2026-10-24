// How the Media panel lists the project's media (F26, D168): a grid or a list, sorted by name, date
// added, length or kind. Remembered on this Mac (localStorage, like the Elements grid's hidden list).
import { useSyncExternalStore } from "react";

export type MediaViewMode = "grid" | "list";
export type MediaSort = "name" | "date" | "duration" | "type";
export interface MediaView {
  readonly mode: MediaViewMode;
  readonly sort: MediaSort;
}

export const MEDIA_SORTS: ReadonlyArray<{ readonly id: MediaSort; readonly label: string }> = [
  { id: "date", label: "Date added" },
  { id: "name", label: "Name" },
  { id: "duration", label: "Length" },
  { id: "type", label: "Type" },
];

const KEY = "uncut.media.view";
const DEFAULT: MediaView = { mode: "grid", sort: "date" };

const read = (): MediaView => {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const v = JSON.parse(raw) as Partial<MediaView>;
    return {
      mode: v.mode === "list" ? "list" : "grid",
      sort: MEDIA_SORTS.some((s) => s.id === v.sort) ? (v.sort as MediaSort) : DEFAULT.sort,
    };
  } catch {
    return DEFAULT;
  }
};

let view = read();
const listeners = new Set<() => void>();
const save = (next: MediaView) => {
  view = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  for (const l of listeners) l();
};

export const useMediaView = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => view,
  );
export const setMediaMode = (mode: MediaViewMode) => mode !== view.mode && save({ ...view, mode });
export const setMediaSort = (sort: MediaSort) => sort !== view.sort && save({ ...view, sort });

const KIND_ORDER = { video: 0, image: 1, audio: 2 } as const;

/**
 * The media in the panel's order: date added is the project's order (imports append), newest
 * first; name A to Z (numbers in order); length longest first (pictures have none, last); type
 * video, image, sound, then by name.
 */
export function sortMedia<
  M extends { readonly name: string; readonly kind: "video" | "image" | "audio"; readonly probe?: { readonly frames?: number | undefined } | undefined },
>(media: ReadonlyArray<M>, sort: MediaSort): Array<M> {
  const byName = (a: M, b: M) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const list = [...media];
  switch (sort) {
    case "date":
      return list.reverse();
    case "name":
      return list.sort(byName);
    case "duration":
      return list.sort((a, b) => (b.kind === "image" ? -1 : (b.probe?.frames ?? -1)) - (a.kind === "image" ? -1 : (a.probe?.frames ?? -1)) || byName(a, b));
    case "type":
      return list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a, b));
  }
}
