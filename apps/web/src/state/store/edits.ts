import type { ProjectSnapshot } from "@uncut/contracts";
import { type Connection, type CallError, type Result, isTransportError } from "../connection.ts";
import { playback, getPlayback } from "../../preview/playback.ts";
import { type Plan, draftOf, findItem, withOverlayRipple } from "../../timeline/edit.ts";
import { planSetSpeed } from "@uncut/core/arrange";
import { type ShaderDef, SHADER, shaderUseOf } from "@uncut/core/shaders";
import type { ProjectModel, Planned } from "../project.ts";
import { call, refreshRecents, plainError } from "./server.ts";
import { state, projectOf, set, online, subscribeApp } from "./core.ts";
import { applyFromCall } from "./sync.ts";

/**
 * Runs a call that changes the project. Success clears the banner. A transport failure is
 * "unknown", not "didn't happen": nothing is rolled back here, the subscription will show
 * what the server did. Returns the error (if any) for callers that show it inline.
 */
// U12 (D178): asked before leaving the project or the environment; state/leave.tsx sets it (it
// imports this module, so it registers itself instead of being imported here).
type LeaveGate = (reason: "close-project" | "open-project" | "new-project" | "environment") => Promise<boolean>;
export let confirmLeave: LeaveGate = () => Promise.resolve(true);
export const setLeaveGate = (gate: LeaveGate) => void (confirmLeave = gate);

// Project changes sent and not answered yet, and item edits queued behind them (U12: leaving waits for them).
let inflight = 0;
let queuedEdits = 0;
export const pendingSaves = () => inflight + queuedEdits;

export async function change(run: Parameters<Connection["call"]>[0], { inline = false } = {}): Promise<CallError | undefined> {
  inflight++;
  let result: Result<ProjectSnapshot>;
  try {
    result = (await call(run)) as Result<ProjectSnapshot>;
  } finally {
    inflight--;
  }
  if (result.ok) {
    const renamed = state.snapshot && projectOf(state.snapshot).name !== projectOf(result.value).name;
    applyFromCall(result.value);
    set({ notice: undefined });
    if (renamed) void refreshRecents(); // the Open Recent menu shows the new name
    return undefined;
  }
  const error = result.error;
  if (error.reason === "changed-on-disk") set({ changedOnDisk: true, reloadProblem: undefined, notice: undefined });
  else if (!inline) set({ notice: { text: plainError(error), transport: isTransportError(error) } });
  return error;
}

/** Plan an edit against the project on screen, send it, then select (and go to) the new item. */
// One add at a time: a double click must not plan two edits against the same project (they'd
// pick the same new id, and the second would be refused). Clicks while one is in flight are dropped.
export let adding = false;

export async function addPlanned(plan: (project: ProjectModel) => Planned | { readonly problem: string }) {
  if (adding || !state.snapshot || !online()) return;
  const planned = plan(projectOf(state.snapshot));
  if ("problem" in planned) return set({ notice: { text: planned.problem } });
  adding = true;
  let error: CallError | undefined;
  try {
    error = await change((c) => c["project.edit"]({ ops: planned.ops, summary: planned.summary }));
  } finally {
    adding = false;
  }
  if (error) return;
  playback.pause();
  playback.select(planned.itemId);
  playback.seek(planned.show ?? planned.start);
  // F20 (D158): the timeline scrolls to show what was added.
  revealItem(planned.itemId);
}

/** Scroll the timeline so an item is in view (after it was added somewhere off screen). */
export function revealItem(itemId: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-testid=timeline-item][data-item="${CSS.escape(itemId)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

/**
 * A manual timeline edit (D52): ops planned against the project at `baseRevision`, sent as one
 * project.edit, so it is validated, undoes in one step and is listed in the agent's next note.
 * If the agent changed the same item after that revision the server refuses it (D6) and the
 * banner says so. Shares the one-at-a-time guard with adds. Returns whether it was applied.
 */
// ---- a number field's scrub (D209): edits become a preview while it drags ----

let previewing = false;
let scrubDraft: { base: ProjectModel; project: ProjectModel } | undefined;

/** Shows a plan in the preview (and the mix) without sending it. */
function previewPlan(plan: Plan | { readonly problem: string }) {
  const snapshot = state.snapshot;
  if (!snapshot || "problem" in plan || !plan.ops.length) return;
  const base = projectOf(snapshot);
  const result = draftOf(base, plan.ops);
  if (!("project" in result)) return;
  scrubDraft = { base, project: result.project };
  playback.setDraft(scrubDraft);
}

/**
 * Runs `fn` with every edit it makes (itemEdit, timelineEdit) shown in the preview instead of sent:
 * a number field calls its own commit this way while it's dragged, then once for real on release
 * (one undoable edit).
 */
export function previewEdits(fn: () => void) {
  previewing = true;
  try {
    fn();
  } finally {
    previewing = false;
  }
}

/** Drops a scrub's preview, now or once the edit it ended with has come back (a new revision, at most 2 s). */
export function endPreview(afterEdit: boolean) {
  const draft = scrubDraft;
  scrubDraft = undefined;
  if (!draft) return;
  const drop = () => {
    if (getPlayback().draft === draft) playback.setDraft(undefined);
  };
  if (!afterEdit) return drop();
  const revision = state.snapshot?.revision;
  const timer = setTimeout(() => (stop(), drop()), 2000);
  const stop = subscribeApp(() => {
    if (state.snapshot?.revision !== revision) {
      clearTimeout(timer);
      stop();
      drop();
    }
  });
}

export async function timelineEdit(plan: Plan | { readonly problem: string }, origin: { readonly baseRevision?: number | undefined; readonly dir?: string | undefined } = {}): Promise<boolean> {
  if (previewing) return (previewPlan(plan), false);
  const snapshot = state.snapshot;
  if (!snapshot || !online()) return false;
  // Planned in another project (it was switched mid-gesture): never send it to this one.
  if (origin.dir !== undefined && origin.dir !== snapshot.dir) return false;
  if ("problem" in plan) {
    set({ notice: { text: plan.problem } });
    return false;
  }
  if (!plan.ops.length) return false;
  if (adding) {
    set({ notice: { text: "The last change is still being saved. Try that again in a moment." } });
    return false;
  }
  // Checked with the server's timeline rules first, so a refusal reads as a sentence, not jargon.
  const draft = draftOf(projectOf(snapshot), plan.ops);
  if ("problem" in draft && origin.baseRevision === undefined) {
    set({ notice: { text: draft.problem } });
    return false;
  }
  const baseRevision = origin.baseRevision ?? snapshot.revision;
  adding = true;
  try {
    return !(await change((c) => c["project.edit"]({ ops: plan.ops, summary: plan.summary, baseRevision })));
  } finally {
    adding = false;
  }
}

// Inspector and canvas edits run one after another: a colour click right after a size change
// waits for it instead of being refused as "still being saved", and each is planned against the
// project as it is when its turn comes (update_item replaces nested objects whole).
let itemChain: Promise<unknown> = Promise.resolve();
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/**
 * An item edit from the Inspector or the preview (D53): `makePlan` runs against the newest
 * project when it's this edit's turn. `baseRevision` is what the user saw when the gesture began
 * (a typing burst, a drag), so the server refuses it if the agent changed the item since (D6).
 */
export function itemEdit(makePlan: (project: ProjectModel) => Plan | { readonly problem: string }, origin: { readonly baseRevision?: number | undefined; readonly dir?: string | undefined } = {}): Promise<boolean> {
  if (previewing) {
    const snapshot = state.snapshot;
    if (snapshot && (origin.dir === undefined || origin.dir === snapshot.dir)) previewPlan(makePlan(projectOf(snapshot)));
    return Promise.resolve(false);
  }
  queuedEdits++;
  let started = false;
  const run = async () => {
    if (!started) (started = true, queuedEdits--);
    while (adding) await settled();
    const snapshot = state.snapshot;
    if (!snapshot || (origin.dir !== undefined && origin.dir !== snapshot.dir)) return false;
    return timelineEdit(makePlan(projectOf(snapshot)), origin);
  };
  const next = itemChain.then(run, run);
  itemChain = next.catch(() => undefined);
  return next;
}

/** A speed change (G9, D125); with linked overlays on (F11, D156), what's over a main clip follows its footage. */
export function speedPlan(project: ProjectModel, itemId: string, speed: number, keepPitch?: boolean): Plan | { readonly problem: string } {
  const plan = planSetSpeed(project, itemId, speed, keepPitch);
  if ("problem" in plan || !getPlayback().linkOverlays || findItem(project, itemId)?.track.role !== "main") return plan;
  return withOverlayRipple(project, plan);
}

/**
 * The shader effects the Effects tab offers (D213): the allowed plugins' and those clips in the
 * project carry (written by the agent's shader_write, or from a plugin since removed), by id.
 */
export function shaderDefs(project: ProjectModel | undefined): Array<ShaderDef & { readonly from: string }> {
  const out = new Map<string, ShaderDef & { readonly from: string }>();
  for (const s of state.contributions?.shaders ?? []) out.set(s.id, { id: s.id, name: s.name, description: s.description, params: s.params as ShaderDef["params"], wgsl: s.wgsl, from: s.pluginName });
  for (const t of project?.tracks ?? [])
    for (const it of t.items)
      for (const e of it.effects ?? []) {
        if (e.module !== SHADER) continue;
        const use = shaderUseOf(e);
        if (use && !out.has(use.def.id)) out.set(use.def.id, { ...use.def, from: "This project" });
      }
  return [...out.values()];
}
export const shaderDefOf = (project: ProjectModel, id: string) => shaderDefs(project).find((d) => d.id === id);
