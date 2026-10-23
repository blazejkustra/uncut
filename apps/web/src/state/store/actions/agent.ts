import { type AgentMention, type AgentImage, type AgentAccess, type AgentAnswer, type StoryboardBeat, type Brief, type Storyboard, type IntendedFinding, type TakeKind, takeUploadName, type ProjectSnapshot, type MediaRecentEntry } from "@uncut/contracts";
import { type Result } from "../../connection.ts";
import { playback, getPlayback } from "../../../preview/playback.ts";
import { findItem } from "../../../timeline/edit.ts";
import { exportSpans } from "../../../panels/exportSpans.ts";
import { momentLabel, itemName, mentionCandidates, effectMentionId, type MentionKind } from "@uncut/core/mentions";
import { agentPrefs, DEFAULT_AGENT_PREFS, skipStoryboardSetting } from "../../agentPrefs.ts";
import { set, state, online, projectOf } from "../core.ts";
import { call, plainError, uploadOne } from "../server.ts";
import { applyFromCall } from "../sync.ts";
import { nextPanelSeq } from "../agentUi.ts";
import { actions } from "../actions.ts";

export const agentActions = {
  /** Start an agent turn; returns false (and says why in the Agent tab) when it didn't start. */
  async agentSend(prompt: string, mentions: ReadonlyArray<AgentMention> = [], images: ReadonlyArray<AgentImage> = [], opts: { readonly access?: AgentAccess } = {}): Promise<boolean> {
    if (!online()) return false;
    set({ agentError: undefined });
    // The agent works on what's on screen: stop playback so the frame it's told about stays put.
    playback.pause();
    const { frame, selected, markIn, markOut, also } = getPlayback();
    // export_video's range choices, as the Export dialog would read them now.
    const ranges = state.snapshot ? exportSpans(projectOf(state.snapshot), { markIn, markOut, selected, also }) : {};
    // Only the chips whose @label is still in the prompt.
    const kept = mentions.filter((m, i) => prompt.includes(`@${m.label}`) && mentions.findIndex((x) => x.kind === m.kind && x.id === m.id && x.label === m.label) === i);
    // The composer's choices for this project (D184): provider, model, effort, access.
    const prefs = state.snapshot ? agentPrefs(state.snapshot.dir) : DEFAULT_AGENT_PREFS;
    const result = await call((c) =>
      c["agent.send"]({
        prompt,
        frame: Math.floor(frame),
        ...(selected ? { selected } : {}),
        ...(kept.length ? { mentions: kept } : {}),
        // Issue #106: the agent CLI (Claude Code when never chosen).
        ...(prefs.provider !== "claude" ? { provider: prefs.provider } : {}),
        ...(prefs.model ? { model: prefs.model } : {}),
        ...(prefs.effort ? { effort: prefs.effort } : {}),
        access: opts.access ?? prefs.access,
        ...(images.length ? { images: [...images] } : {}),
        // D188: Settings › App › Agent, remembered on this Mac.
        ...(skipStoryboardSetting() ? { skipStoryboard: true } : {}),
        ...(ranges.marks || ranges.selection ? { ranges } : {}),
      }),
    );
    if (result.ok) return true;
    set({ agentError: plainError(result.error) });
    // "Not installed" may be news to the setup rows too.
    if (result.error.reason === "not-installed") void actions.checkSetup();
    return false;
  },
  agentCancel: () => call((c) => c["agent.cancel"]({})),
  /** The composer's text and chips (D140). */
  /** D202: the pill's jump: the playhead to where the agent changed things (playback carries on from there), its item selected. */
  agentJump: () => {
    const change = state.agentChange;
    if (!change) return;
    set({ agentChange: undefined });
    playback.seek(change.from);
    if (change.select !== undefined) playback.select(change.select);
  },
  dismissAgentChange: () => set({ agentChange: undefined }),
  setAgentDraft: (agentDraft: string, agentMentions?: ReadonlyArray<AgentMention>) => set({ agentDraft, ...(agentMentions ? { agentMentions } : {}) }),
  /** Hold a message until the running turn ends (D140); undefined takes it back. */
  agentQueue: (queued: { prompt: string; mentions: ReadonlyArray<AgentMention>; images?: ReadonlyArray<AgentImage> } | undefined) => set({ agentQueued: queued }),
  /** The composer's attached images (D184). */
  setAgentImages: (agentImages: ReadonlyArray<AgentImage>) => set({ agentImages }),
  /** Add a moment (D183) or the In/Out range of the timeline to the chat, as a chip with its timecode. */
  addMomentToChat(frame: number) {
    const snap = state.snapshot;
    if (!snap) return;
    const label = momentLabel(Math.max(0, Math.floor(frame)), projectOf(snap).canvas.fps);
    actions.addToChat({ kind: "moment", id: `frame:${Math.floor(frame)}`, label, frame: Math.max(0, Math.floor(frame)) });
  },
  addRangeToChat(start: number, end: number) {
    const snap = state.snapshot;
    if (!snap || end <= start) return;
    const fps = projectOf(snap).canvas.fps;
    const label = `${momentLabel(start, fps)}–${momentLabel(end, fps)}`;
    actions.addToChat({ kind: "range", id: `range:${start}-${end}`, label, range: { start: Math.floor(start), end: Math.floor(end) } });
  },
  /**
   * Issue #118: an area of the picture (canvas pixels, dragged over the preview) at a frame or over
   * a stretch, as a chip; the agent gets the rectangle and what's drawn in it (core regionLine).
   */
  addRegionToChat(area: { x: number; y: number; w: number; h: number }, at: { readonly frame: number } | { readonly start: number; readonly end: number }) {
    const snap = state.snapshot;
    if (!snap) return;
    const fps = projectOf(snap).canvas.fps;
    const box = { x: Math.round(area.x), y: Math.round(area.y), w: Math.max(1, Math.round(area.w)), h: Math.max(1, Math.round(area.h)) };
    const frame = "frame" in at ? Math.max(0, Math.floor(at.frame)) : undefined;
    const range = "frame" in at ? undefined : { start: Math.floor(at.start), end: Math.floor(at.end) };
    const time = range ? `${momentLabel(range.start, fps)}–${momentLabel(range.end, fps)}` : momentLabel(frame!, fps);
    // Two areas at the same time get their own labels: the prompt's @label picks the chip.
    const taken = new Set(state.agentMentions.filter((m) => m.kind === "region").map((m) => m.label));
    let label = `Area ${time}`;
    for (let n = 2; taken.has(label); n++) label = `Area ${n} ${time}`;
    const span = range ? `${range.start}-${range.end}` : `${frame}`;
    actions.addToChat({ kind: "region", id: `region:${box.x},${box.y},${box.w},${box.h}@${span}`, label, area: box, ...(range ? { range } : { frame: frame! }) });
  },
  /** Add to chat (D141) for a timeline item: its name, with the stretch of the timeline it covers. */
  addItemToChat(itemId: string, frame?: number) {
    const snap = state.snapshot;
    const placed = snap ? findItem(projectOf(snap), itemId) : undefined;
    if (!snap || !placed) return;
    actions.addToChat({ kind: "item", id: itemId, label: itemName(projectOf(snap) as never, placed.item as never), range: { start: Math.round(placed.start), end: Math.round(placed.start + placed.item.duration) }, ...(frame !== undefined ? { frame: Math.floor(frame) } : {}) });
  },
  /**
   * D264 (#77): Add to chat for anything the composer's @ picker offers (media, tracks, effects,
   * transitions, markers): the same label and id the picker would give, so the agent gets the same
   * <context> line either way. False when it's no longer in the project.
   */
  addRefToChat(kind: MentionKind, id: string): boolean {
    const snap = state.snapshot;
    const c = snap ? mentionCandidates(projectOf(snap) as never).find((x) => x.kind === kind && x.id === id) : undefined;
    if (!c) return false;
    actions.addToChat({ kind: c.kind, id: c.id, label: c.label, ...(c.frame !== undefined ? { frame: c.frame } : {}) });
    return true;
  },
  addMediaToChat: (mediaId: string) => actions.addRefToChat("media", mediaId),
  addTrackToChat: (trackId: string) => actions.addRefToChat("track", trackId),
  addEffectToChat: (itemId: string, module: string) => actions.addRefToChat("effect", effectMentionId(itemId, module)),
  addTransitionToChat: (itemId: string) => actions.addRefToChat("transition", itemId),
  /** D264: words picked in the Transcript, as the stretch of the timeline they're heard over; the chip quotes them. */
  addWordsToChat(start: number, end: number, words: string) {
    const snap = state.snapshot;
    if (!snap || end <= start) return;
    const fps = projectOf(snap).canvas.fps;
    const text = words.replace(/[\r\n<>@]+/g, " ").replace(/\s+/g, " ").trim();
    const quoted = text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text;
    const label = quoted ? `"${quoted}" ${momentLabel(start, fps)}` : `${momentLabel(start, fps)}–${momentLabel(end, fps)}`;
    actions.addToChat({ kind: "range", id: `words:${Math.floor(start)}-${Math.floor(end)}`, label, range: { start: Math.floor(start), end: Math.floor(end) } });
  },
  /** Add to chat (D141): a chip at the end of the composer, the Agent tab open, the caret there. */
  addToChat(mention: AgentMention) {
    const draft = state.agentDraft;
    const sep = draft && !/\s$/.test(draft) ? " " : "";
    set({
      agentDraft: `${draft}${sep}@${mention.label} `,
      // The same thing twice is one chip: what each add knew (a frame, a range) is kept.
      agentMentions: [
        ...state.agentMentions.filter((m) => !(m.kind === mention.kind && m.id === mention.id && m.label === mention.label)),
        { ...state.agentMentions.find((m) => m.kind === mention.kind && m.id === mention.id && m.label === mention.label), ...mention },
      ],
      agentFocus: state.agentFocus + 1,
      panelRequest: { panel: "agent", seq: nextPanelSeq() },
    });
  },
  /** Allow or Don't on the running turn's approval card (D99). */
  /** Whether the server took the answer (false: the card was no longer open). */
  async agentApprove(id: string, allow: boolean, source?: string, extra: { readonly answer?: AgentAnswer; readonly beats?: ReadonlyArray<StoryboardBeat>; readonly note?: string; readonly always?: boolean } = {}): Promise<boolean> {
    const result = await call((c) => c["agent.approve"]({ id, allow, ...(source ? { source } : {}), ...(extra.answer ? { answer: extra.answer } : {}), ...(extra.beats ? { beats: [...extra.beats] } : {}), ...(extra.note ? { note: extra.note } : {}), ...(extra.always ? { always: true } : {}) }));
    return result.ok && result.value.accepted;
  },
  /** D188: the user's own brief or storyboard (approved on the Plan card); false with the reason in the Agent tab when it didn't save. */
  async agentPlanSave(input: { readonly brief?: Brief; readonly storyboard?: Storyboard; readonly intended?: ReadonlyArray<IntendedFinding> }): Promise<boolean> {
    const result = await call((c) => c["agent.planSave"]({ ...(input.brief ? { brief: input.brief } : {}), ...(input.storyboard ? { storyboard: input.storyboard } : {}), ...(input.intended ? { intended: [...input.intended] } : {}) }));
    if (!result.ok) set({ agentError: plainError(result.error) });
    return result.ok;
  },
  /** D217: a review finding the user marked Intended (the critic stops raising it), or unmarked. */
  async agentMarkIntended(finding: Omit<IntendedFinding, "at">, on = true): Promise<boolean> {
    const now = state.agent?.plan?.intended ?? [];
    const same = (x: IntendedFinding) => x.kind === finding.kind && x.from === finding.from && x.to === finding.to;
    const next = on ? [...now.filter((x) => !same(x as IntendedFinding)), { ...finding, at: new Date().toISOString() }] : now.filter((x) => !same(x as IntendedFinding));
    return actions.agentPlanSave({ intended: next });
  },
  /** D144: the take an allowed screen_record recorded (uploaded), or why there's none. */
  agentScreenTake: (id: string, answer: { readonly path?: string; readonly source?: string; readonly problem?: string }) => call((c) => c["agent.screenTake"]({ id, ...answer })),
  /** D144: a take's file up to the active server's media/uploads/ (the agent's screen_record imports it). */
  async uploadTake(blob: Blob, kind: TakeKind): Promise<{ readonly path: string } | { readonly message: string }> {
    const ext = blob.type.startsWith("audio/") ? "webm" : blob.type.includes("mp4") ? "mp4" : "webm";
    return uploadOne(new File([blob], takeUploadName(kind, ext), { type: blob.type }));
  },
  async agentUndoTurn(turnId: string) {
    set({ agentError: undefined });
    const result = (await call((c) => c["agent.undoTurn"]({ turnId }))) as Result<ProjectSnapshot>;
    if (result.ok) applyFromCall(result.value);
    else if (result.error.reason === "changed-on-disk") set({ changedOnDisk: true, reloadProblem: undefined });
    else set({ agentError: plainError(result.error) });
  },
  /** D295: New chat: the next message starts a fresh Claude conversation. */
  async agentNewThread() {
    set({ agentError: undefined });
    const result = await call((c) => c["agent.newThread"]({}));
    if (!result.ok) set({ agentError: plainError(result.error) });
  },
  /** D206: puts back the graphics a turn's clean-up moved to the trash. */
  async agentRestoreCleanup(turnId: string) {
    const result = await call((c) => c["agent.restoreCleanup"]({ turnId }));
    if (!result.ok) set({ agentError: plainError(result.error) });
  },
  /** D205: other projects' recent captures, imports and generations (the user's media index). */
  async mediaRecent(query?: string): Promise<ReadonlyArray<MediaRecentEntry>> {
    const result = await call((c) => c["media.recent"]({ ...(query ? { query } : {}), limit: 30 }));
    return result.ok ? result.value.entries : [];
  },
  /** D205: one of them into the open project (copied when it lives in another project, D12); one ⌘Z. */
  async mediaRecentImport(id: string): Promise<{ readonly ok: true; readonly copied: boolean; readonly name: string } | { readonly ok: false; readonly message: string }> {
    const result = await call((c) => c["media.recentImport"]({ id }));
    return result.ok ? { ok: true, copied: result.value.copied, name: result.value.name } : { ok: false, message: plainError(result.error) };
  },
  dismissAgentError: () => set({ agentError: undefined }),
};
