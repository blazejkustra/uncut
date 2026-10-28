// D252: a .uncut project opened from Finder or the Dock (the app's open-file event) opens in Uncut.
// On a cold launch macOS sends open-file before any window exists: the project waits until the app
// is ready, then goes where windowRouter.ts says. A window's page ignores menu commands until it
// reaches its server, so a project handed to a window that hasn't asked yet waits for it to ask
// (PENDING_OPEN_CHANNEL, on its first connect). Wired from app.ts at module top level (before
// ready, so the first open-file isn't missed).
import { app, ipcMain, type IpcMainInvokeEvent } from "electron";

import { PENDING_OPEN_CHANNEL, projectDirFromOpenedPath } from "./projectPath.ts";

export interface OpenFileOptions {
  /** Opens the project in the right window (once the app is ready). */
  readonly route: (dir: string) => void;
  /** The asking window's waiting project, or null; throws for anything but an app window. */
  readonly take: (event: IpcMainInvokeEvent) => string | null;
}

export function installOpenFile(options: OpenFileOptions) {
  const early: Array<string> = [];
  let ready = false;
  app.on("open-file", (event, opened) => {
    const dir = projectDirFromOpenedPath(opened);
    // Not a project: macOS shows its "can't open" alert for us.
    if (!dir) return;
    event.preventDefault();
    if (ready) options.route(dir);
    else early.push(dir);
  });
  ipcMain.handle(PENDING_OPEN_CHANNEL, (event) => options.take(event));
  return {
    /** The first window is there: what Finder sent before goes where it belongs. */
    ready() {
      ready = true;
      for (const dir of early.splice(0)) options.route(dir);
    },
  };
}
