// The Transcript panel's state and planners (D32, D69). The transcripts of the media under the
// main track come from the server's analysis cache (analysis.cached, no job); a transcript that
// isn't made yet is started with the Library's analysis job (analysis.start ["transcript"]). The
// selection is a span of words in edit order (what you hear), kept as "clip:index" keys so it
// survives re-renders and falls away when the words it names are cut. Cutting goes through core
// planTextCut, the same planner as the agent's transcript_edit, chained clip by clip into ONE
// project.edit, so one ⌘Z restores it.
import {
  editWords,
  planTextCut,
  speechItem,
  speechWords,
  transcriptScope,
  type CutWord,
  type EditWord,
  type SpeechEnvelope,
  type SpeechSegment,
  type TranscriptScope,
} from "@uncut/core/transcript";
import { planMakeCaptions, type CaptionMode } from "@uncut/core/captions";
import { withGraphicRetime } from "@uncut/core/retime";
import { useSyncExternalStore } from "react";

import { draftOf, type Plan } from "../timeline/edit.ts";
import type { ProjectModel } from "../state/project.ts";

export interface MediaTranscript {
  readonly words: ReadonlyArray<CutWord & { readonly p?: number }>;
  readonly language?: string | undefined;
  readonly seconds?: number | undefined;
  /** The loudness analysis's silences (seconds), when cached: pauses take their edges. */
  readonly silences?: ReadonlyArray<{ readonly start: number; readonly end: number }> | undefined;
  /** Whisper's segments: a sentence's last word ends no earlier than its segment (D74). */
  readonly segments?: ReadonlyArray<SpeechSegment> | undefined;
  /** The loudness analysis's speech envelope, when cached: words end where their sound does (D74). */
  readonly envelope?: SpeechEnvelope | undefined;
  /** Whether the loudness analysis was cached when this was read (else cutting runs it first). */
  readonly measured?: boolean;
}

export type TranscriptEntry =
  | { readonly state: "loading" }
  | { readonly state: "none" }
  | { readonly state: "silent" }
  | { readonly state: "done"; readonly transcript: MediaTranscript }
  | { readonly state: "error"; readonly message: string };

export interface TranscriptState {
  /** The project the entries belong to. */
  readonly dir: string | undefined;
  /** D215: what the tab reads: the main track (undefined), or an item off it (its transcript scope's anchor). */
  readonly source: string | undefined;
  readonly entries: ReadonlyMap<string, TranscriptEntry>;
  /** Selected words in edit order, from anchor to focus ("clip:index" keys). */
  readonly anchor: string | undefined;
  readonly focus: string | undefined;
}

let state: TranscriptState = { dir: undefined, source: undefined, entries: new Map(), anchor: undefined, focus: undefined };
const listeners = new Set<() => void>();
const set = (patch: Partial<TranscriptState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useTranscripts = <T>(select: (s: TranscriptState) => T): T => useSyncExternalStore(subscribe, () => select(state));
export const getTranscripts = () => state;

export const wordKey = (w: Pick<EditWord, "clip" | "index">) => `${w.clip}:${w.index}`;

export const transcriptStore = {
  /** Another project: forget the old one's transcripts and selection. */
  forProject(dir: string | undefined) {
    if (dir !== state.dir) set({ dir, source: undefined, entries: new Map(), anchor: undefined, focus: undefined });
  },
  /** Read the main track (undefined) or an item off it; the word selection goes. */
  setSource(source: string | undefined) {
    if (source === state.source) return;
    set({ source, anchor: undefined, focus: undefined });
  },
  setEntry(dir: string, mediaId: string, entry: TranscriptEntry) {
    if (dir !== state.dir) return;
    const entries = new Map(state.entries);
    entries.set(mediaId, entry);
    set({ entries });
  },
  select(anchor: string | undefined, focus = anchor) {
    if (anchor === state.anchor && focus === state.focus) return;
    set({ anchor, focus });
  },
  extend(focus: string) {
    if (state.anchor === undefined) set({ anchor: focus, focus });
    else if (focus !== state.focus) set({ focus });
  },
  clear: () => (state.anchor === undefined ? undefined : set({ anchor: undefined, focus: undefined })),
};

/** The done transcripts by media id. */
export const doneTranscripts = (entries: ReadonlyMap<string, TranscriptEntry>) => {
  const out = new Map<string, MediaTranscript>();
  for (const [id, e] of entries) if (e.state === "done") out.set(id, e.transcript);
  return out;
};

/**
 * Every word heard on the main track, in edit order: where the planner hears them (speechWords,
 * D74); with a scope (D215), the words of its items in timeline order.
 */
export const wordsOfEdit = (project: ProjectModel, transcripts: ReadonlyMap<string, MediaTranscript>, scope?: TranscriptScope) =>
  editWords(
    project,
    new Map(
      [...transcripts]
        .filter(([id]) => !scope || id === scope.media)
        .map(([id, t]) => [id, speechWords(t.words, { segments: t.segments, silences: t.silences, seconds: t.seconds, envelope: t.envelope })]),
    ),
    scope ? new Set(scope.items) : undefined,
  );

/** D215: the scope the tab reads for `source` (undefined: the main track, or a source that's gone or now heard through Main). */
export const scopeOf = (project: ProjectModel, source: string | undefined): TranscriptScope | undefined =>
  source === undefined ? undefined : transcriptScope(project, source);

/** Two scopes are the same source when they read the same media from the same items. */
export const scopeKey = (scope: TranscriptScope | undefined) => (scope ? `${scope.media}:${scope.items.join(",")}` : "main");

/** One entry of the tab's source picker: an item off Main whose speech can be read, and what it's called there. */
export interface SourceChoice {
  readonly id: string;
  readonly label: string;
  readonly scope: TranscriptScope;
}

/** D215: the items off Main with speech, one per scope (a take is one entry, named after its picture), in timeline order. */
export function sourceChoices(project: ProjectModel): Array<SourceChoice> {
  const out: Array<SourceChoice> = [];
  const seen = new Set<string>();
  for (const track of project.tracks) {
    if (track.role === "main") continue;
    for (const item of track.items) {
      if (item.type === "captions" || item.type === "text") continue;
      const scope = transcriptScope(project, item.id);
      if (!scope) continue;
      const key = scopeKey(scope);
      if (seen.has(key)) continue;
      seen.add(key);
      // Named after the first item of it from the top (a take's picture: its tracks are over its sounds).
      const media = project.media.find((m) => m.id === item.media);
      out.push({ id: item.id, label: `${item.name ?? media?.name ?? item.id}, ${track.name}`, scope });
    }
  }
  return out;
}

/** The selected words (edit order), or [] when the selection names words that aren't there. */
export function selectedWords(words: ReadonlyArray<EditWord>, anchor: string | undefined, focus: string | undefined): ReadonlyArray<EditWord> {
  if (anchor === undefined || focus === undefined) return [];
  const a = words.findIndex((w) => wordKey(w) === anchor);
  const b = words.findIndex((w) => wordKey(w) === focus);
  if (a === -1 || b === -1) return [];
  return words.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The media heard on the main track (clips with sound, or a main clip's linked microphone, D215), in edit order. */
export function mediaOnMain(project: ProjectModel): Array<string> {
  const main = project.tracks.find((t) => t.role === "main");
  const out: Array<string> = [];
  for (const item of main?.items ?? []) {
    if (item.type !== "clip" || !item.media) continue;
    const id = mainSpeechMedia(project, item);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The media a main clip's words come from: its linked microphone's (D215), else its own when it may have sound. */
export function mainSpeechMedia(project: ProjectModel, item: ProjectModel["tracks"][number]["items"][number]): string | undefined {
  const speech = speechItem(project, item);
  if (speech && speech.id !== item.id && speech.media !== item.media) return speech.media;
  const m = project.media.find((x) => x.id === item.media);
  return m && m.kind !== "image" && m.probe?.hasAudio !== false ? m.id : undefined;
}

export interface CutPlan extends Plan {
  readonly framesRemoved: number;
  readonly pauses: number;
  readonly fillers: number;
  readonly words: number;
  readonly notes: ReadonlyArray<string>;
}

type Step = { readonly media: string; readonly request: Parameters<typeof planTextCut>[3] };

/** planTextCut for each step against the project the previous one left, as one list of ops. */
function chain(
  project: ProjectModel,
  transcripts: ReadonlyMap<string, MediaTranscript>,
  steps: ReadonlyArray<Step>,
  summary: (p: Omit<CutPlan, "summary" | "ops">, one: string | undefined) => string,
): CutPlan | { readonly problem: string } {
  let current = project;
  const ops: Array<CutPlan["ops"][number]> = [];
  const notes: Array<string> = [];
  let framesRemoved = 0;
  let pauses = 0;
  let fillers = 0;
  let words = 0;
  let one: string | undefined;
  for (const step of steps) {
    const t = transcripts.get(step.media);
    if (!t) continue;
    const plan = planTextCut(
      current,
      step.media,
      { words: t.words, language: t.language, seconds: t.seconds, segments: t.segments },
      { ...step.request, silences: t.silences, envelope: t.envelope },
    );
    if ("problem" in plan) return plan;
    if (!plan.ops.length) {
      notes.push(...plan.notes);
      continue;
    }
    ops.push(...plan.ops);
    notes.push(...plan.notes);
    framesRemoved += plan.framesRemoved;
    for (const c of plan.cuts) {
      pauses += c.pauses;
      fillers += c.fillers;
      words += c.words ? c.words[1] - c.words[0] + 1 : 0;
    }
    one = one === undefined ? plan.summary : "";
    current = plan.project;
  }
  const base = { framesRemoved, pauses, fillers, words, notes };
  // C6: graphics the cuts run through lose the same stretch of their own time.
  const retimed = withGraphicRetime(project, ops).ops;
  return { ...base, ops: retimed, summary: ops.length ? summary(base, one || undefined) : "" };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Cut the selected words: each clip's part of the selection only from that clip (D215: in a scope, from its items). */
export function planCutWords(
  project: ProjectModel,
  transcripts: ReadonlyMap<string, MediaTranscript>,
  selected: ReadonlyArray<EditWord>,
  scope?: TranscriptScope,
): CutPlan | { readonly problem: string } {
  if (!selected.length) return { problem: "Select words in the transcript to cut them." };
  const groups: Array<{ media: string; clip: string; from: number; to: number }> = [];
  for (const w of selected) {
    const g = groups.at(-1);
    if (g && g.clip === w.clip) g.to = Math.max(g.to, w.index);
    else groups.push({ media: w.media, clip: w.clip, from: w.index, to: w.index });
  }
  // One call per media with every group's range tagged with its clip, so selected words in another
  // clip count as removed (no handle kept for them: no slivers at a clip seam).
  const steps: Array<Step> = [];
  for (const g of groups) {
    const step = steps.find((x) => x.media === g.media);
    const range = { from: g.from, to: g.to, clip: g.clip };
    if (step) (step.request.remove as Array<typeof range>).push(range);
    else steps.push({ media: g.media, request: { remove: [range], ...(scope ? { items: scope.items } : {}) } });
  }
  const fps = project.canvas.fps;
  return chain(project, transcripts, steps, (p, one) => one ?? `Cut ${plural(p.words, "word")} (${(p.framesRemoved / fps).toFixed(1)} s)`);
}

/** The media the tab reads (D215: a scope's one, else every transcribed media on main), each with its scope's items. */
const stepsOf = <R extends object>(project: ProjectModel, scope: TranscriptScope | undefined, request: R): Array<Step> =>
  (scope ? [scope.media] : mediaOnMain(project)).map((media) => ({ media, request: { ...request, ...(scope ? { items: scope.items } : {}) } }));

/** Remove the pauses at least `min` seconds long from every clip of every transcribed media on main (or the scope's items). */
export function planRemovePauses(
  project: ProjectModel,
  transcripts: ReadonlyMap<string, MediaTranscript>,
  min: number,
  scope?: TranscriptScope,
): CutPlan | { readonly problem: string } {
  const fps = project.canvas.fps;
  return chain(
    project,
    transcripts,
    stepsOf(project, scope, { pauses: { min } }),
    (p) => `Removed ${plural(p.pauses, "pause")} (${(p.framesRemoved / fps).toFixed(1)} s)`,
  );
}

/** Remove the hesitation fillers (um, uh, yyy, eee) the same way. */
export function planRemoveFillers(
  project: ProjectModel,
  transcripts: ReadonlyMap<string, MediaTranscript>,
  scope?: TranscriptScope,
): CutPlan | { readonly problem: string } {
  const fps = project.canvas.fps;
  return chain(
    project,
    transcripts,
    stepsOf(project, scope, { fillers: true }),
    (p) => `Removed ${plural(p.fillers, "filler")} (${(p.framesRemoved / fps).toFixed(1)} s)`,
  );
}

export interface CaptionsPlan extends Plan {
  /** The captions items made or remade, in edit order of their media. */
  readonly items: ReadonlyArray<string>;
  readonly remade: boolean;
}

/**
 * "Make captions" (D82): captions for every transcribed media on the main track (core
 * planMakeCaptions: the words where they're heard, a captions item over the main track on its own
 * track; remade in place when the media has captions), each planned on the project the one before
 * leaves, as one edit.
 */
export function planCaptions(
  project: ProjectModel,
  transcripts: ReadonlyMap<string, MediaTranscript>,
  options: { readonly mode: CaptionMode; readonly look: string; readonly captionStyle?: string },
  scope?: TranscriptScope,
): CaptionsPlan | { readonly problem: string } {
  let current = project;
  const ops: Array<Plan["ops"][number]> = [];
  const items: Array<string> = [];
  let remade = false;
  for (const media of scope ? [scope.media] : mediaOnMain(project)) {
    const t = transcripts.get(media);
    if (!t || !t.words.length) continue;
    const plan = planMakeCaptions(current, {
      media,
      transcript: { words: t.words, language: t.language, seconds: t.seconds, segments: t.segments },
      silences: t.silences,
      envelope: t.envelope,
      mode: options.mode,
      look: options.look,
      ...(options.captionStyle ? { captionStyle: options.captionStyle } : {}),
    });
    if ("problem" in plan) return plan;
    const next = draftOf(current, plan.ops);
    if ("problem" in next) return next;
    ops.push(...plan.ops);
    items.push(plan.itemId);
    remade ||= plan.remade;
    current = next.project;
  }
  if (!ops.length)
    return {
      problem: scope
        ? "Transcribe it first: captions are made from the transcript."
        : "Transcribe the speech on the main track first: captions are made from the transcript.",
    };
  return { ops, items, remade, summary: remade && items.length === 1 ? "Remake captions" : "Make captions" };
}
