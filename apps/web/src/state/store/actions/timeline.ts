import { transitionSeconds } from "../../../timeline/transitionLength.ts";
import { type AgentUiPanel } from "@uncut/contracts";
import { playback, getPlayback } from "../../../preview/playback.ts";
import { planSplit, findItem, planSetTransition, planDelete, nearestCut, type TrackFlag, planTrackFlag, planGrouping, planLayer, planRippleDelete } from "../../../timeline/edit.ts";
import { planResetPosition } from "../../../timeline/clip.ts";
import { planPutOnMain, planDetachAudio, takenIds } from "@uncut/core/arrange";
import { planSetLook, type LookDef, planEffect, lookInfo, effectInfo } from "@uncut/core/fx";
import { planShader, planShaderValues } from "@uncut/core/shaders";
import { planForAll } from "../../../timeline/multi.ts";
import { type TextPreset, planAddText, planDropMedia, type ProjectModel, uniqueId } from "../../project.ts";
import { type BackgroundProps, planAddBackground } from "../../../preview/text.ts";
import { draggedComponentProps, planAddComponent, planAddGraphic } from "../../../preview/components.ts";
import { planRemoveGainKey } from "../../../audio/sound.ts";
import { planRemoveMedia, planFitToVideo } from "@uncut/core/mediaPlan";
import { set, state, online, projectOf } from "../core.ts";
import { addPlanned, adding, timelineEdit, itemEdit, shaderDefOf, speedPlan } from "../edits.ts";
import { call, plainError } from "../server.ts";
import { nextPanelSeq } from "../agentUi.ts";

export const timelineActions = {
  /** Open a panel as the agent's ui_show does. */
  openPanel: (panel: AgentUiPanel) => set({ panelRequest: { panel, seq: nextPanelSeq() } }),
  /** Text tab preset → a text item at the playhead (see planAddText). */
  /** Text tab → a preset at the playhead (or the dropped frame), placed where it was dropped on the canvas (D80). */
  addText: (preset: TextPreset, opts: { at?: { x: number; y: number }; frame?: number } = {}) => addPlanned((project) => planAddText(project, preset, opts.frame ?? getPlayback().frame, opts.at)),
  /** A planned move or trim from the timeline (see edit.ts). */
  timelineEdit,
  /** A text or background change from the Inspector or the preview (see text.ts). */
  itemEdit,
  /** Elements tab → a component at the playhead, or where it was dropped (see planAddComponent, D76). */
  addComponent: (id: string, opts: { at?: { x: number; y: number }; frame?: number; props?: Record<string, unknown> } = {}) => {
    // A drop (canvas or timeline) of a tile that carries props (a sticker from the set, D251): read now, before the drag ends.
    const props = opts.props ?? (opts.at || opts.frame !== undefined ? draggedComponentProps(id) : undefined);
    return addPlanned((project) => planAddComponent(project, id, opts.frame ?? getPlayback().frame, { ...(opts.at ? { at: opts.at } : {}), ...(props ? { props } : {}) }));
  },
  /** Elements tab → a plugin's component (D103): the server copies it into graphics/, then a graphic item at the playhead. */
  async addPluginComponent(id: string) {
    if (adding || !state.snapshot || !online()) return;
    const result = await call((c) => c["plugins.addComponent"]({ id }));
    if (!result.ok) return set({ notice: { text: plainError(result.error) } });
    const { src, name, props } = result.value;
    await addPlanned((project) => planAddGraphic(project, { src, name, props: (props ?? {}) as Record<string, unknown>, idBase: id.split(".").at(-1) ?? "graphic" }, getPlayback().frame));
  },
  /** Elements tab → a full-frame background (see planAddBackground): over the whole edit, or behind the selected item (D220). */
  addBackground: (props: BackgroundProps, behindSelected = false) => addPlanned((project) => planAddBackground(project, props, getPlayback().frame, behindSelected ? getPlayback().selected : undefined)),
  /** S: split at the playhead (see planSplit); the part after the playhead is selected. */
  async split() {
    if (!state.snapshot) return;
    const { selected, frame } = getPlayback();
    const plan = planSplit(projectOf(state.snapshot), selected, frame);
    if (await timelineEdit(plan)) playback.select("newId" in plan ? plan.newId : undefined);
  },
  /** ⌫: delete the selected item; on main the rest closes up. A selected cut: remove its transition (D73). */
  async deleteSelected() {
    if (!state.snapshot) return;
    const cut = getPlayback().cut;
    if (cut !== undefined) {
      const placed = findItem(projectOf(state.snapshot), cut);
      if (placed?.item.transitionIn) await timelineEdit(planSetTransition(projectOf(state.snapshot), cut, null));
      return;
    }
    // A selected volume key (D83): ⌫ removes the key, not its item.
    const { selected, gainKey } = getPlayback();
    if (selected !== undefined && gainKey !== undefined) {
      if (await timelineEdit(planRemoveGainKey(projectOf(state.snapshot), selected, gainKey))) playback.selectGainKey(selected, undefined);
      return;
    }
    if (await timelineEdit(planDelete(projectOf(state.snapshot), selected))) playback.select(undefined);
  },
  /**
   * Put a transition on a cut (D73): `cut` (the id of the clip after it), else the selected cut;
   * with `nearest`, the cut nearest the playhead. The cut is selected afterwards, so the Inspector
   * shows it. Replaces a transition already there (keeping its length, clamped).
   */
  async applyTransition(module: string, { cut, nearest = false }: { cut?: string; nearest?: boolean } = {}) {
    if (!state.snapshot) return false;
    const project = projectOf(state.snapshot);
    const target = cut ?? (nearest ? nearestCut(project, getPlayback().frame)?.item.id : getPlayback().cut);
    if (target === undefined) {
      set({ notice: { text: nearest ? "There's no cut yet: put two clips on the main track first." : "Pick a cut first: click between two clips on the main track, drag the transition onto a cut, or use + for the cut nearest the playhead." } });
      return false;
    }
    // D133: the panel's length for all, when one is chosen (else the transition's default).
    const seconds = transitionSeconds();
    const ok = await timelineEdit(planSetTransition(project, target, { module, ...(seconds ? { duration: Math.round(seconds * project.canvas.fps) } : {}) }));
    if (ok || findItem(project, target)?.item.transitionIn?.module === module) playback.selectCut(target);
    return ok;
  },
  /** Change (or with null remove) the transition at the cut before main item `itemId`. */
  setTransition: (itemId: string, next: { module: string; duration?: number } | null, origin?: { baseRevision?: number; dir?: string }) =>
    state.snapshot ? timelineEdit(planSetTransition(projectOf(state.snapshot), itemId, next), origin) : Promise.resolve(false),
  toggleTrack: (trackId: string, flag: TrackFlag) => (state.snapshot ? timelineEdit(planTrackFlag(projectOf(state.snapshot), trackId, flag)) : undefined),
  /** Media dropped on a lane (T1, D122): at the drop frame on that lane when it takes it (see planDropMedia). */
  dropMedia: (mediaId: string, at: { frame: number; track?: string | undefined }) => addPlanned((project) => planDropMedia(project, mediaId, at)),
  /** Detach audio (T3, D123): the clip's sound to its own audio item, the clip muted; the new item is selected. */
  /** D215: a picture off Main (or a take, from any of its parts) goes on the main track, its sounds linked under it. */
  async putOnMain(itemId: string) {
    if (!state.snapshot) return;
    const plan = planPutOnMain(projectOf(state.snapshot), itemId);
    if (await timelineEdit(plan)) playback.select("itemId" in plan ? plan.itemId : undefined);
  },
  async detachAudio(itemId: string) {
    if (!state.snapshot) return;
    const project = projectOf(state.snapshot);
    const plan = planDetachAudio(project, itemId, takenIds(project));
    if (await timelineEdit(plan)) playback.select("itemId" in plan ? plan.itemId : undefined);
  },
  /**
   * Effects tab (D136): "look:<id>" puts a look on the clip ("look:" takes it off), "effect:<module>"
   * adds an effect; on `itemId` (a drop) or else the selected clip. With several items selected
   * (and the drop on one of them), on every selected clip, as one edit (F2, D147).
   */
  applyFx: (what: string, itemId?: string) =>
    itemEdit((project) => {
      const { selected, also } = getPlayback();
      const selection = selected === undefined ? [] : [selected, ...also];
      const targets = itemId === undefined ? selection : selection.length > 1 && selection.includes(itemId) ? selection : [itemId];
      const [kind, id = ""] = what.split(/:(.*)/s);
      const custom = kind === "look" ? state.contributions?.filters?.find((f) => f.id === id) : undefined;
      // A shader effect (D213): a plugin's, or one a clip in this project already carries.
      const shader = kind === "shader" ? shaderDefOf(project, id) : undefined;
      if (kind === "shader" && !shader) return { problem: "That shader effect isn't available any more." };
      const one = (p: ProjectModel, target: string) => (kind === "look" ? planSetLook(p, target, id || undefined, custom ? { custom: custom.look as LookDef, label: custom.name } : {}) : kind === "shader" ? planShader(p, target, shader) : planEffect(p, target, id));
      if (targets.length <= 1) return one(project, targets[0] ?? "");
      if (shader) return planForAll(project, targets, one, (n) => `${shader.name} on ${n} clips`);
      const look = lookInfo(id)?.name ?? custom?.name ?? id;
      const effect = effectInfo(id)?.name.toLowerCase() ?? id;
      return planForAll(project, targets, one, (n) => (kind !== "look" ? `Add ${effect} to ${n} clips` : id ? `Filter ${look} on ${n} clips` : `Remove the filter from ${n} clips`));
    }),
  /** Change a clip's shader effect's values (D213): one edit. */
  setShaderValues: (itemId: string, values: Readonly<Record<string, number | string | boolean>>) => itemEdit((project) => planShaderValues(project, itemId, values)),
  /** Speed (G9, D125): presets and custom, keep pitch or not; the item's length follows. */
  setSpeed: (itemId: string, speed: number, keepPitch?: boolean) => itemEdit((project) => speedPlan(project, itemId, speed, keepPitch)),
  /** Rename a timeline item (T7): its own name, shown on the timeline and in the Inspector; "" goes back to the media's. */
  renameItem: (itemId: string, name: string) => itemEdit(() => ({ ops: [{ op: "update_item", item: itemId, set: { name: name.trim() ? name.trim() : null } }], summary: name.trim() ? `Rename ${itemId} to ${name.trim()}` : `Reset the name of ${itemId}` })),
  renameTrack: (trackId: string, name: string) => (name.trim() ? itemEdit(() => ({ ops: [{ op: "update_track", track: trackId, set: { name: name.trim() } }], summary: `Rename track to ${name.trim()}` })) : Promise.resolve(false)),
  /** G4: a media item's display name (its file stays where it is), shown everywhere it appears. */
  renameMedia: (mediaId: string, name: string) => (name.trim() ? itemEdit(() => ({ ops: [{ op: "update_media", media: mediaId, set: { name: name.trim() } }], summary: `Rename media to ${name.trim()}` })) : Promise.resolve(false)),
  /** F8 (D167): a media out of the project with every item using it, in one edit (core planRemoveMedia); its file stays on disk. */
  removeMedia: (mediaId: string) => itemEdit((project) => planRemoveMedia(project, mediaId)),
  /** F27 (D169): a sound trimmed or looped to the end of the picture, with a fade out (core planFitToVideo). */
  fitToVideo: (itemId: string) =>
    itemEdit((project) => {
      const plan = planFitToVideo(project, itemId);
      return "ops" in plan && !plan.ops.length ? { problem: "The sound already fits the video." } : plan;
    }),
  /** Group or ungroup items (F19, D157): see planGrouping. */
  grouping: (ids: ReadonlyArray<string>, group: boolean) => itemEdit((project) => planGrouping(project, ids, group)),
  /** Bring forward / Send backward (F15, D151): one layer up or down (see planLayer). */
  layer: (itemId: string, dir: -1 | 1) => itemEdit((project) => planLayer(project, itemId, dir)),
  /** Reset position (F15, D151): see planResetPosition. */
  resetPosition: (itemId: string) => itemEdit((project) => planResetPosition(project, itemId)),
  /** Ripple delete (T7): delete and close the gaps on their tracks. */
  async rippleDelete(ids: ReadonlyArray<string>) {
    if (!state.snapshot) return;
    if (await timelineEdit(planRippleDelete(projectOf(state.snapshot), ids))) playback.select(undefined);
  },
  /** Mute or lock one item (T7): mute silences a clip or audio item (D123), lock keeps hands and the agent off it. */
  toggleItem: (itemId: string, flag: "mute" | "locked") =>
    itemEdit((project) => {
      const item = findItem(project, itemId)?.item;
      if (!item) return { problem: "That item isn't in the project any more." };
      const on = !item[flag];
      return { ops: [{ op: "update_item", item: itemId, set: { [flag]: on ? true : null } }], summary: `${flag === "mute" ? (on ? "Mute" : "Unmute") : on ? "Lock" : "Unlock"} ${item.name ?? itemId}` };
    }),
  /** Replace media (T7): the clip plays another media file of the project from its start, as long as it was (or as the file is). */
  replaceMedia: (itemId: string, mediaId: string) =>
    itemEdit((project) => {
      const placed = findItem(project, itemId);
      const media = project.media.find((m) => m.id === mediaId);
      if (!placed || !media) return { problem: "That media isn't in the project any more." };
      const frames = media.kind === "image" ? undefined : media.probe?.frames;
      const duration = frames && !placed.item.loop ? Math.max(1, Math.min(placed.item.duration, Math.floor(frames / (placed.item.speed ?? 1)))) : placed.item.duration;
      return { ops: [{ op: "update_item", item: itemId, set: { media: mediaId, in: media.kind === "image" ? null : 0, duration, ...(media.kind === "image" ? { speed: null } : {}) } }], summary: `Replace the media of ${itemId} with ${media.name}` };
    }),
  /** Add an empty track (T7): video and text tracks go on top (or just above `near`), audio at the bottom (or just below `near`). */
  addTrack: (kind: "video" | "text" | "audio", near?: string) =>
    itemEdit((project) => {
      const base = kind === "audio" ? "Audio" : kind === "text" ? "Text" : "Video";
      const used = new Set(project.tracks.map((t) => t.name));
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
      const at = near !== undefined ? project.tracks.findIndex((t) => t.id === near) : -1;
      const nearTrack = at >= 0 ? project.tracks[at] : undefined;
      const sameSide = nearTrack && (nearTrack.kind === "audio") === (kind === "audio");
      const index = sameSide ? (kind === "audio" ? at + 1 : at) : kind === "audio" ? project.tracks.length : 0;
      const id = uniqueId(project, `${kind}-track`);
      return { ops: [{ op: "add_track", track: { id, kind, name }, index }], summary: `Add ${name} track` };
    }),
  /** Delete a track and what's on it (T7), as one edit. */
  deleteTrack: (trackId: string) =>
    itemEdit((project) => {
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) return { problem: "That track isn't in the project any more." };
      if (track.role === "main") return { problem: "The main track can't be deleted." };
      return { ops: [{ op: "delete_track", track: trackId }], summary: `Delete track ${track.name}` };
    }),
  /** Show in Media (T7): the Media tab with the tile scrolled into view and flashed. */
  showInMedia(mediaId: string) {
    set({ panelRequest: { panel: "media" as AgentUiPanel, seq: nextPanelSeq() }, mediaFocus: { id: mediaId, seq: nextPanelSeq() } });
  },
};
