import type { PluginContributions, ProjectSnapshot } from "@uncut/contracts";
import { useSyncExternalStore } from "react";
import { bridge } from "../bridge.ts";
import type { CheckRule } from "@uncut/core/checks";
import { type PluginRule, pluginCheckRules, pluginRuleEntries, type PluginLook } from "@uncut/core/contributions";
import { type TextPreset, TEXT_PRESETS } from "../project.ts";
import type { AppStateShape, Project } from "./types.ts";
import { actions } from "./actions.ts";
import { environmentsUsable, flagOn, subscribeFlags } from "../../settings/labs.ts";
import { panels, panelShown, subscribePanels } from "../../editor/layout.ts";
import { linkImportReady } from "../../panels/library/linkImport.ts";

export let state: AppStateShape = {
  ready: false,
  connection: "connecting",
  appInfo: { homeDir: "", defaultParentDir: "" },
  snapshot: null,
  recents: [],
  newProjectOpen: false,
  changedOnDisk: false,
  setupOpen: false,
  settingsOpen: false,
  settingsSection: "project",
  shortcutsOpen: false,
  setupChecking: false,
  jobs: [],
  thumbIds: new Set(),
  agent: null,
  agentDraft: "",
  agentMentions: [],
  agentImages: [],
  agentFocus: 0,
  history: null,
  exportOpen: false,
  exportJobs: [],
  analysisJobs: [],
  proxies: [],
  generateJobs: [],
  environment: { id: "local", name: "This Mac", kind: "local" },
  environmentsOpen: false,
  downloads: {},
};
const listeners = new Set<() => void>();

export const set = (patch: Partial<AppStateShape>) => {
  const before = state;
  state = { ...state, ...patch };
  // An Analyze refusal belongs to the project it was about.
  if (state.analysisError && before.snapshot?.dir !== state.snapshot?.dir) state = { ...state, analysisError: undefined };
  for (const listener of listeners) listener();
  // D280: and the plugins (File › Import from Link… follows its plugin being installed and allowed).
  if (before.snapshot !== state.snapshot || before.recents !== state.recents || before.environment !== state.environment || before.plugins !== state.plugins) syncShell();
  // Plugins allowed, removed or installed: their looks, components and rules follow (D103).
  if (before.plugins !== state.plugins && state.connection === "connected") void actions.loadContributions();
};

// ---- plugin contributions (D103) ----

const rulesMemo = new WeakMap<object, { readonly rules: ReadonlyArray<CheckRule>; readonly entries: ReadonlyArray<CheckRule> }>();
const rulesOf = (c: PluginContributions | undefined) => {
  if (!c) return { rules: [], entries: [] };
  let m = rulesMemo.get(c);
  if (!m) {
    const list = c.rules as ReadonlyArray<PluginRule>;
    m = { rules: pluginCheckRules(list), entries: pluginRuleEntries(list) };
    rulesMemo.set(c, m);
  }
  return m;
};
/** The allowed plugins' data rules, compiled once per contributions answer (core runs them with the built-ins). */
export const pluginRules = () => rulesOf(state.contributions).rules;
/** Every plugin rule as a registry entry (titles, process ones too). */
export const pluginRuleList = () => rulesOf(state.contributions).entries;
/** The allowed plugins' looks (D103). */
export const pluginLooks = () => (state.contributions?.looks ?? []) as ReadonlyArray<PluginLook>;
const presetsMemo = new WeakMap<object, ReadonlyArray<TextPreset>>();
/** The Text tab's tiles: the built-in looks, then the allowed plugins' (D103), each with its plugin's name. */
export function textPresets(): ReadonlyArray<TextPreset> {
  const c = state.contributions;
  if (!c?.looks.length) return TEXT_PRESETS;
  let list = presetsMemo.get(c);
  if (!list) {
    list = [...TEXT_PRESETS, ...pluginLooks().map((l): TextPreset => ({ id: l.id, module: l.id, label: l.name, text: l.text, look: l, source: l.pluginName }))];
    presetsMemo.set(c, list);
  }
  return list;
}

/** Outside React: called after every state change (D144: the recorder watches an agent take). */
export const subscribeApp = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

export const useApp = () =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => state,
  );

/**
 * Issue #118: a slice of the app state; re-renders only when the selected value changes (useApp
 * re-renders on every change: a key typed in the chat, a job's progress). `select` must return the
 * same value for the same state (a field, a primitive), not a new object each time.
 */
export const useAppSelect = <T,>(select: (s: AppStateShape) => T): T =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => select(state),
  );

export const getState = () => state;
export const projectOf = (snapshot: ProjectSnapshot) => snapshot.project as Project;
export const online = () => state.connection === "connected";
/** The window shows a remote environment (D106): paths are the server's, not this Mac's. */
export const isRemote = (s: AppStateShape = state) => s.environment.kind === "remote";

// A Labs flag turned on or off (D245) changes the menu too.
subscribeFlags(() => syncShell());
// #76 (D256): so do hidden panels and focus mode (the View menu's checkmarks).
subscribePanels(() => syncShell());

/** Keep the native menu (Open Recent, ⌘W) and the window title in step with the screen. */
function syncShell() {
  bridge.setAppState({
    projectOpen: state.snapshot !== null,
    recents: state.recents.map(({ name, dir }) => ({ name, dir })),
    // D245: the menu's Environments… is disabled while the Labs flag is off (and a remote isn't active).
    environments: environmentsUsable(flagOn("environments"), state.environment.kind),
    panels: { lib: panelShown(panels.get(), "lib"), side: panelShown(panels.get(), "side"), bottom: panelShown(panels.get(), "bottom"), focus: panels.get().focus },
    // #94 (D263, D280): File › Import from Link… only while its plugin is installed and allowed.
    importLink: linkImportReady(state.plugins),
  });
  document.title = state.snapshot ? projectOf(state.snapshot).name : "Uncut";
}
