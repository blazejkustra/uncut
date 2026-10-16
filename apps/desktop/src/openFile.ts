// D252: a .uncut project opened from Finder or the Dock opens in Uncut (the app's open-file event).
// On a cold launch macOS sends open-file before the window exists, and the renderer ignores menu
// commands until it reaches the server, so the project waits here until the renderer asks for it
// (PENDING_OPEN_CHANNEL, on its first connect). Once it has asked, a later open goes straight to it
// as an Open Recent command. D266: only on Local (openFileRouter.ts); a reload makes it ask again.
// Wired from app.ts at module top level (before ready, so the first open-file isn't missed).
import { app, ipcMain, type IpcMainInvokeEvent } from "electron";

import type { MenuCommand } from "./ipc.ts";
import { makeOpenFileRouter } from "./openFileRouter.ts";
import { PENDING_OPEN_CHANNEL, projectDirFromOpenedPath } from "./projectPath.ts";

export interface OpenFileOptions {
  /** Only the app window may take the pending project. */
  readonly isAppWindow: (event: IpcMainInvokeEvent) => boolean;
  /** Sends a menu command to the app window (app.ts's sendMenuCommand). */
  readonly send: (command: MenuCommand) => void;
  /** Brings the app window forward. */
  readonly show?: () => void;
  /** True on Local, false on a remote, undefined before the environments are loaded. */
  readonly isLocal: () => boolean | undefined;
  /** Tells the user a Finder open needs This Mac (a remote environment is active). */
  readonly notifyRemote: (dir: string) => void;
}

export function installOpenFile(options: OpenFileOptions) {
  const router = makeOpenFileRouter({
    isLocal: options.isLocal,
    open: (dir) => {
      options.send({ type: "open-recent", dir });
      options.show?.();
    },
    notifyRemote: options.notifyRemote,
  });
  app.on("open-file", (event, opened) => {
    const dir = projectDirFromOpenedPath(opened);
    // Not a project: macOS shows its "can't open" alert for us.
    if (!dir) return;
    event.preventDefault();
    router.opened(dir);
  });
  ipcMain.handle(PENDING_OPEN_CHANNEL, (event) => {
    if (!options.isAppWindow(event)) throw new Error("not allowed");
    return router.rendererAsks();
  });
  return { environmentsReady: router.environmentsReady, rendererReloaded: router.rendererReloaded };
}
