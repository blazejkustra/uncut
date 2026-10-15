import { bridge, type EnvironmentTest } from "../../bridge.ts";
import { set, state } from "../core.ts";
import { chooseFolder } from "./remote.ts";
import { confirmLeave } from "../edits.ts";
import { actions } from "../actions.ts";

export const environmentActions = {
  showNewProject: () => set({ newProjectOpen: true }),
  hideNewProject: () => set({ newProjectOpen: false }),

  chooseParentFolder: () => chooseFolder("parent"),

  // ---- environments (D106) ----
  async openEnvironments() {
    set({ environmentsOpen: true });
    await actions.loadEnvironments();
  },
  closeEnvironments: () => set({ environmentsOpen: false }),
  async loadEnvironments() {
    const { environments } = await bridge.environments();
    set({ environments });
  },
  /** Adds a remote (after a passing test); undefined, or why not. */
  async addEnvironment(input: { name: string; url: string; token: string }): Promise<string | undefined> {
    const result = await bridge.addEnvironment(input);
    if ("problem" in result) return result.problem;
    await actions.loadEnvironments();
    return undefined;
  },
  testEnvironment: (input: { url: string; token: string } | { id: string }): Promise<EnvironmentTest> => bridge.testEnvironment(input),
  async renameEnvironment(id: string, name: string) {
    await bridge.renameEnvironment(id, name);
    await actions.loadEnvironments();
    if (id === state.environment.id && name.trim()) set({ environment: { ...state.environment, name: name.trim() } });
  },
  async removeEnvironment(id: string) {
    // Removing the one on screen goes back to Local (the window reloads): ask first (U12).
    if (id === state.environment.id && !(await confirmLeave("environment"))) return;
    await bridge.removeEnvironment(id);
    await actions.loadEnvironments();
  },
  /** The window reloads into the other environment: nothing carries over (D106). */
  async switchEnvironment(id: string): Promise<boolean> {
    if (id === state.environment.id || !(await confirmLeave("environment"))) return false;
    return bridge.switchEnvironment(id);
  },
};
