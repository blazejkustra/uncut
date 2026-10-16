import type { AgentUi, AgentState } from "@uncut/contracts";
import { changeRange } from "../agentChange.ts";
import { layoutOf } from "../project.ts";
import { state, set, projectOf } from "./core.ts";

// The agent's ui_show (D65): each request is applied once, when its id is new. The first state
// for a project this window shows only records the request it carries: that one is old news,
// from before this window was looking.
// A request waits until the project snapshot it was made against (or a newer one) is here, so the
// playhead isn't clamped to an older, shorter project (the two streams can arrive in either order).
let uiDir: string | undefined;
let uiSeen: string | undefined;
let uiWaiting: AgentUi | undefined;
let panelSeq = 0;
/** The next panel request's sequence number (the agent's ui_show and the actions share it). */
export const nextPanelSeq = () => ++panelSeq;
export function applyAgentUi(agent: AgentState | null) {
  if (!agent) return void ((uiDir = undefined), (uiWaiting = undefined));
  const ui = agent.ui;
  if (agent.dir !== uiDir) {
    uiDir = agent.dir;
    uiSeen = ui?.id;
    uiWaiting = undefined;
    return;
  }
  if (!ui || ui.id === uiSeen) return;
  uiSeen = ui.id;
  uiWaiting = ui;
  applyWaitingUi();
}
export function applyWaitingUi() {
  const ui = uiWaiting;
  const snap = state.snapshot;
  if (!ui || !snap || snap.dir !== uiDir || snap.revision < ui.revision) return;
  uiWaiting = undefined;
  // D202, D235 (issue #64): the agent never moves the playhead or the selection; a frame or an item
  // becomes the pill "Agent changed 0:12–0:18" the user can click to jump there. A panel request
  // opens its panel (playback goes on).
  if (ui.panel) set({ panelRequest: { panel: ui.panel, seq: ++panelSeq } });
  if (ui.frame === undefined && ui.select === undefined) return;
  const project = projectOf(snap);
  const { starts } = layoutOf(project);
  const range = changeRange(project.tracks.map((t) => ({ items: t.items.map((i) => ({ id: i.id, start: starts.get(i.id) ?? i.start ?? 0, duration: i.duration ?? 0 })) })), ui);
  if (range) set({ agentChange: { ...range, select: ui.select, seq: ++panelSeq } });
}
