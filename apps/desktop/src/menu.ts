// The macOS menu. Main doesn't talk to the server, so the renderer reports what's on screen
// (AppState) and the menu is rebuilt from it; menu picks go back to the renderer as commands.
import { app, Menu, type MenuItemConstructorOptions } from "electron";

import type { AppState, MenuCommand } from "./ipc.ts";

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
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        item("New Project…", "CmdOrCtrl+N", { type: "new-project" }),
        item("Open…", "CmdOrCtrl+O", { type: "open-project" }),
        { label: "Open Recent", submenu: recent },
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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
