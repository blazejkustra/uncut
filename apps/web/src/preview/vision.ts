// D328: what background removal and face blur show in the preview. The server makes a clip's matte
// and faces in the background (their state is in the proxies stream); the preview plays the
// matte's H.264 copy in a hidden <video> kept at the matte frame of the clip's frame (core
// visionSeconds and frameIndex, as the export picks it) and reads the faces once, as JSON. Until
// they're there the clip shows as it is, with a note on it saying how far along they are.
import type { ProxyState } from "@uncut/contracts";
import type { ClipMask } from "@uncut/core/fx";
import { faceMasks, facesAt, frameIndex, visionRange, visionSeconds, type Cutout, type FaceFrames } from "@uncut/core/vision";
import type { ClipFx } from "@uncut/core/fx";
import type { Item, Project } from "@uncut/core/types";
import { getState, visionOf, visionUrl } from "../state/store.ts";
import { drive } from "./compositor/media.ts";
import "./vision.css";

type MatteInfo = { readonly fps: number; readonly times: ReadonlyArray<number> };
type Output = "matte" | "faces";

/** Files read once per URL; `changed` runs when one arrives. */
const loaded = new Map<string, { value?: unknown; failed?: boolean }>();

function readJson<T>(url: string, changed: () => void): T | undefined {
  const known = loaded.get(url);
  if (known) return known.value as T | undefined;
  loaded.set(url, {});
  fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(
      (value) => loaded.set(url, { value }),
      () => loaded.set(url, { failed: true }),
    )
    .finally(changed);
  return undefined;
}

const requestOf = (project: Pick<Project, "media" | "canvas" | "tracks">, item: Item, output: Output, fx: ClipFx) => {
  const range = visionRange(project, item);
  return range ? { output, ...(output === "matte" ? { mode: fx.cutout?.mode } : {}), ...range } : undefined;
};

/** A clip's vision result state (undefined until the server lists it). */
export function visionStateOf(project: Pick<Project, "media" | "canvas" | "tracks">, item: Item, output: Output, fx: ClipFx): ProxyState | undefined {
  const request = requestOf(project, item, output, fx);
  return request && item.media ? visionOf(getState(), item.media, request) : undefined;
}

const VERBS: Readonly<Record<Output | "track", string>> = { matte: "Removing background", faces: "Finding faces", track: "Tracking" };
const verb = (output: Output | "track") => VERBS[output];

/** What a clip's preview says while a vision result is on its way or couldn't be made (undefined once it's there). */
export function visionNote(state: ProxyState | undefined, output: Output | "track"): string | undefined {
  if (state?.phase === "done") return undefined;
  if (state?.phase === "failed") return state.error ?? `${verb(output)} didn't work.`;
  if (state?.waiting === "export") return `${verb(output)} after the export…`;
  if (state?.phase === "running") return `${verb(output)} ${Math.round((state.progress ?? 0) * 100)}%`;
  return `${verb(output)}…`;
}

export interface VisionFrame {
  readonly matte?: { readonly source: HTMLVideoElement; readonly cutout: Cutout };
  readonly faces?: { readonly masks: ReadonlyArray<ClipMask>; readonly sigma: number };
  readonly notes: ReadonlyArray<string>;
}

/** The preview's matte videos and notes, one per clip. */
export class VisionViews {
  private readonly mattes = new Map<string, HTMLVideoElement>();
  private readonly notes = new Map<string, HTMLDivElement>();
  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
  }

  /** The matte frame and face masks a clip draws at `local` frames from its start, its picture drawn at `size` (canvas px). */
  frame(
    project: Pick<Project, "media" | "canvas" | "tracks">,
    item: Item,
    fx: ClipFx,
    local: number,
    size: { readonly w: number; readonly h: number },
    playing: boolean,
    rate: number,
  ): VisionFrame {
    const notes: Array<string> = [];
    const out: { matte?: VisionFrame["matte"]; faces?: VisionFrame["faces"] } = {};
    const seconds = visionSeconds(project, item, local);
    if (fx.cutout && item.media) {
      const state = visionStateOf(project, item, "matte", fx);
      const note = visionNote(state, "matte");
      const info = state?.phase === "done" && state.key ? readJson<MatteInfo>(visionUrl(item.media, `${state.key}.json`) ?? "", this.changed) : undefined;
      const el = state?.phase === "done" && state.key ? this.matteFor(item.id, visionUrl(item.media, `${state.key}.mp4`)) : undefined;
      if (note) notes.push(note);
      if (el && info) {
        const i = frameIndex(info.times, seconds);
        drive(el, (i + 0.5) / info.fps, playing, rate, false);
        if (el.readyState >= 2) out.matte = { source: el, cutout: fx.cutout };
      }
    } else this.dropMatte(item.id);
    if (fx.faceBlur && item.media) {
      const state = visionStateOf(project, item, "faces", fx);
      const note = visionNote(state, "faces");
      if (note) notes.push(note);
      const faces = state?.phase === "done" && state.key ? readJson<FaceFrames>(visionUrl(item.media, `${state.key}.json`) ?? "", this.changed) : undefined;
      if (faces) out.faces = { masks: faceMasks(facesAt(faces, seconds, fx.faceBlur.faces), fx.faceBlur, size.w, size.h), sigma: Math.max(0.5, fx.faceBlur.amount) };
    }
    return { ...out, notes };
  }

  /** The note on a clip's box (none: removed). */
  note(id: string, wrap: HTMLElement, text: string | undefined) {
    let el = this.notes.get(id);
    if (!text) {
      el?.remove();
      this.notes.delete(id);
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.className = "pv-vision-note";
      el.dataset.visionNote = id;
      this.notes.set(id, el);
    }
    if (el.parentElement !== wrap) wrap.append(el);
    if (el.textContent !== text) el.textContent = text;
  }

  drop(id: string) {
    this.dropMatte(id);
    this.note(id, document.body, undefined);
  }

  private matteFor(id: string, src: string | undefined): HTMLVideoElement | undefined {
    if (!src) return undefined;
    const known = this.mattes.get(id);
    if (known?.dataset.src === src) return known;
    this.dropMatte(id);
    const el = document.createElement("video");
    el.muted = true;
    el.crossOrigin = "anonymous";
    el.playsInline = true;
    el.preload = "auto";
    el.dataset.src = src;
    el.dataset.matte = id;
    el.className = "pv-matte";
    el.addEventListener("seeked", this.changed);
    el.addEventListener("loadeddata", this.changed);
    el.src = src;
    document.body.append(el);
    this.mattes.set(id, el);
    return el;
  }

  private dropMatte(id: string) {
    const el = this.mattes.get(id);
    if (!el) return;
    el.pause();
    el.removeAttribute("src");
    el.load();
    el.remove();
    this.mattes.delete(id);
  }
}
