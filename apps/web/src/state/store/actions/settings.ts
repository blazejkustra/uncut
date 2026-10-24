import { type PluginInfo } from "@uncut/contracts";
import { set, state, isRemote } from "../core.ts";
import { chooseFolder } from "./remote.ts";
import { call, plainError } from "../server.ts";
import type { SettingsSection } from "../types.ts";
import { actions } from "../actions.ts";

export const settingsActions = {
  /** Settings (G8): Project when a project is open, else App. */
  openSettings(section?: SettingsSection) {
    set({
      settingsOpen: true,
      shortcutsOpen: false,
      settingsSection: section ?? (state.snapshot ? state.settingsSection : state.settingsSection === "project" ? "app" : state.settingsSection),
    });
  },
  closeSettings: () => set({ settingsOpen: false }),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  openSetup() {
    set({ setupOpen: true, setupFocus: undefined, settingsOpen: false });
    void actions.checkSetup();
    void actions.listKeys();
  },
  async checkSetup() {
    set({ setupChecking: true, setupError: undefined });
    void actions.listPlugins();
    const result = await call((c) => c["setup.check"]({}));
    if (result.ok) set({ setupChecking: false, setupChecks: result.value });
    else set({ setupChecking: false, setupError: `Couldn't check ${isRemote() ? state.environment.name : "this Mac"}. ${plainError(result.error)}` });
  },
  async loadContributions() {
    const result = await call((c) => c["plugins.contributions"]({}));
    if (result.ok) set({ contributions: result.value });
  },
  /** Settings › Plugins › Browse (D103): the catalog of plugins that ship with Uncut, off until enabled. */
  async loadCatalog() {
    const result = await call((c) => c["plugins.catalog"]({}));
    if (result.ok) set({ pluginCatalog: result.value });
  },
  /** Enables a catalog plugin (a copy into Uncut's plugins folder), then opens its approval dialog. */
  async enablePlugin(id: string) {
    set({ pluginInstalling: true, pluginInstallError: undefined, pluginInstallNote: undefined, pluginError: undefined });
    const result = await call((c) => c["plugins.enable"]({ id }));
    if (result.ok) {
      set({
        pluginInstalling: false,
        plugins: result.value.plugins,
        pluginInstallNote: result.value.note,
        pluginDialog: result.value.plugins.some((p) => p.id === result.value.id && p.status === "needs-approval") ? result.value.id : undefined,
      });
    } else set({ pluginInstalling: false, pluginError: plainError(result.error) });
    void actions.loadCatalog();
  },
  /** Disables a catalog plugin: its copy and approval go (plugins.uninstall). */
  async disablePlugin(id: string) {
    set({ pluginError: undefined });
    const result = await call((c) => c["plugins.disable"]({ id }));
    if (result.ok) set({ plugins: result.value, pluginDialog: undefined });
    else set({ pluginError: plainError(result.error) });
    void actions.loadCatalog();
  },
  async listPlugins() {
    const result = await call((c) => c["plugins.list"]({}));
    if (result.ok) set({ plugins: result.value });
  },
  /** Allows a plugin to run (D97); its capabilities were shown next to the button. */
  async approvePlugin(plugin: Pick<PluginInfo, "id" | "dir" | "capabilities" | "skillsHash">) {
    set({ pluginError: undefined });
    // D248: the skills it showed too, so a plugin whose skills changed meanwhile is refused.
    const result = await call((c) =>
      c["plugins.approve"]({
        id: plugin.id,
        dir: plugin.dir,
        capabilities: [...plugin.capabilities],
        ...(plugin.skillsHash ? { skills: plugin.skillsHash } : {}),
      }),
    );
    if (result.ok) set({ plugins: result.value, pluginDialog: undefined });
    else set({ pluginError: plainError(result.error) });
  },
  /** Installs a plugin from a folder or git URL (D102), then opens its approval dialog. */
  async installPlugin(input: { source: string; ref?: string | undefined; replaceBundled?: boolean }) {
    set({ pluginInstalling: true, pluginInstallError: undefined, pluginInstallNote: undefined, pluginError: undefined });
    const result = await call((c) =>
      c["plugins.install"]({ source: input.source, ...(input.ref ? { ref: input.ref } : {}), ...(input.replaceBundled ? { replaceBundled: true } : {}) }),
    );
    if (result.ok) {
      set({
        pluginInstalling: false,
        plugins: result.value.plugins,
        pluginInstallNote: result.value.note,
        pluginDialog: result.value.plugins.some((p) => p.id === result.value.id && p.status === "needs-approval") ? result.value.id : undefined,
      });
      return true;
    }
    const error = result.error as { reason?: unknown };
    set({
      pluginInstalling: false,
      pluginInstallError: {
        message: plainError(result.error),
        reason: typeof error.reason === "string" ? error.reason : "",
        source: input.source,
        ref: input.ref,
      },
    });
    return false;
  },
  /** Add plugin… › Choose folder: the folder dialog, then install. */
  async installPluginFolder() {
    const dir = await chooseFolder("plugin");
    return dir ? actions.installPlugin({ source: dir }) : false;
  },
  async uninstallPlugin(id: string) {
    set({ pluginError: undefined });
    const result = await call((c) => c["plugins.uninstall"]({ id }));
    if (result.ok) set({ plugins: result.value, pluginDialog: undefined });
    else set({ pluginError: plainError(result.error) });
  },
  openPluginDialog(id: string | undefined) {
    set({ pluginDialog: id, pluginError: undefined });
  },
  async revokePlugin(id: string) {
    set({ pluginError: undefined });
    const result = await call((c) => c["plugins.revoke"]({ id }));
    if (result.ok) set({ plugins: result.value });
    else set({ pluginError: plainError(result.error) });
  },
};
