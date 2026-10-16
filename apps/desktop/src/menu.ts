// The macOS menu. Main doesn't talk to the server, so the renderer reports what's on screen
// (AppState) and the menu is rebuilt from it; menu picks go back to the renderer as commands.
import path from "node:path";

import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";

import type { AppState, MenuCommand } from "./ipc.ts";

export const REPO_URL = "https://github.com/blazejkustra/uncut";

/**
 * Help › Licence and Third-Party Notices (D112): the copies shipped in Resources when packaged
 * (as .txt so they open in a text viewer), the repository's on GitHub in dev.
 */
const openLegal = (name: "LICENSE" | "THIRD_PARTY_NOTICES") => {
  if (!app.isPackaged) return void shell.openExternal(`${REPO_URL}/blob/main/${name}`);
  void shell.openPath(path.join(process.resourcesPath, `${name}.txt`)).then((error) => {
    if (error) void shell.openExternal(`${REPO_URL}/blob/main/${name}`);
  });
};

/**
 * Help › Send Feedback… (issue #13, D223): the bug report form on GitHub with the version and the
 * Mac filled in; the user writes the rest and sees everything before it is sent. Nothing else
 * (no logs, paths or project) goes in.
 */
export const feedbackUrl = (version: string, macos: string, arch: string) => {
  const query = new URLSearchParams({ template: "bug.yml", version, macos: `macOS ${macos}, ${arch === "arm64" ? "Apple silicon" : arch}` });
  return `${REPO_URL}/issues/new?${query}`;
};

export function setAppMenu(state: AppState, send: (command: MenuCommand) => void) {
  // The shortcut is shown but not registered: the renderer handles these keys itself (it
  // knows whether a text field has focus), so menu clicks and keys share one code path.
  const item = (label: string, accelerator: string | undefined, command: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => send(command),
  });

  // A checkbox item (View): enabled only with a project open.
  const check = (label: string, accelerator: string, checked: boolean, command: MenuCommand): MenuItemConstructorOptions => ({
    ...item(label, accelerator, command),
    type: "checkbox",
    checked: state.projectOpen && checked,
    enabled: state.projectOpen,
  });

  const recent: Array<MenuItemConstructorOptions> = state.recents.length
    ? state.recents.map((r) => ({ label: r.name, sublabel: r.dir, click: () => send({ type: "open-recent", dir: r.dir }) }))
    : [{ label: "No recent projects", enabled: false }];

  const template: Array<MenuItemConstructorOptions> = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        item("Settings…", "CmdOrCtrl+,", { type: "open-settings" }),
        item("Agents and Setup…", undefined, { type: "open-setup" }),
        // D245: behind the Labs flag; disabled (with where to turn it on) while it's off.
        state.environments
          ? item("Environments…", undefined, { type: "open-environments" })
          : { label: "Environments…", sublabel: "Turn it on in Settings › Labs", toolTip: "Environments is in Labs: turn it on in Settings › Labs", enabled: false },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        item("New Project…", "CmdOrCtrl+N", { type: "new-project" }),
        item("Open…", "CmdOrCtrl+O", { type: "open-project" }),
        { label: "Open Recent", submenu: recent },
        { type: "separator" },
        { ...item("Export…", "CmdOrCtrl+E", { type: "export" }), enabled: state.projectOpen },
        { type: "separator" },
        // ⌘W closes the project when one is open (back to Welcome), otherwise the window (and
        // with it the app). A ⌘W held or pressed twice is kept from reaching the second (D243, keys.ts).
        state.projectOpen ? item("Close Project", "CmdOrCtrl+W", { type: "close-project" }) : { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        // Not role "undo": the renderer decides between text undo (in a field) and project undo.
        // Cut/copy/paste keep their roles so ⌘C/⌘V work in text fields.
        item("Undo", "CmdOrCtrl+Z", { type: "undo" }),
        item("Redo", "Shift+CmdOrCtrl+Z", { type: "redo" }),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      // #76 (D256): hide or show the editor's parts, and focus mode; checked from what the renderer reports.
      label: "View",
      submenu: [
        check("Left Panel", "Shift+CmdOrCtrl+L", state.panels?.lib ?? true, { type: "toggle-panel", panel: "lib" }),
        check("Right Panel", "Shift+CmdOrCtrl+I", state.panels?.side ?? true, { type: "toggle-panel", panel: "side" }),
        check("Timeline", "Shift+CmdOrCtrl+T", state.panels?.bottom ?? true, { type: "toggle-panel", panel: "bottom" }),
        { type: "separator" },
        check("Focus Mode", "Shift+CmdOrCtrl+F", state.panels?.focus ?? false, { type: "focus-mode" }),
        { type: "separator" },
        { role: "togglefullscreen" },
        // In development also the usual reload and developer tools.
        ...(app.isPackaged ? [] : ([{ type: "separator" }, { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }] as Array<MenuItemConstructorOptions>)),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        item("Keyboard Shortcuts", undefined, { type: "shortcuts" }),
        { type: "separator" },
        { label: "Uncut on GitHub", click: () => void shell.openExternal(REPO_URL) },
        { label: "Send Feedback…", click: () => void shell.openExternal(feedbackUrl(app.getVersion(), process.getSystemVersion(), process.arch)) },
        { label: "Report an Issue…", click: () => void shell.openExternal(`${REPO_URL}/issues/new/choose`) },
        { type: "separator" },
        { label: "Licence", click: () => openLegal("LICENSE") },
        { label: "Third-Party Notices", click: () => openLegal("THIRD_PARTY_NOTICES") },
      ],
    },
  ];
  app.setAboutPanelOptions({
    applicationName: "Uncut",
    applicationVersion: app.getVersion(),
    copyright: "Copyright 2026 Błażej Kustra and Uncut contributors. MIT licence.",
    credits: "github.com/blazejkustra/uncut",
    website: REPO_URL,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
