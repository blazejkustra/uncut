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

export function setAppMenu(state: AppState, send: (command: MenuCommand) => void) {
  // The shortcut is shown but not registered: the renderer handles these keys itself (it
  // knows whether a text field has focus), so menu clicks and keys share one code path.
  const item = (label: string, accelerator: string | undefined, command: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => send(command),
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
        item("Settings…", "CmdOrCtrl+,", { type: "open-setup" }),
        item("Environments…", undefined, { type: "open-environments" }),
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
        // ⌘W closes the project when one is open, otherwise the window (and with it the app).
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
    ...(app.isPackaged ? [] : [{ role: "viewMenu" } as MenuItemConstructorOptions]),
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Uncut on GitHub", click: () => void shell.openExternal(REPO_URL) },
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
