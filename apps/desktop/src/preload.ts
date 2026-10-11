import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  APP_INFO_CHANNEL,
  APP_STATE_CHANNEL,
  CHOOSE_FOLDER_CHANNEL,
  MENU_COMMAND_CHANNEL,
  SERVER_CONNECTION_CHANNEL,
  SERVER_EXIT_CHANNEL,
  SHOW_IN_FOLDER_CHANNEL,
  type AppState,
  type FolderPurpose,
  type MenuCommand,
} from "./ipc.ts";

const subscribe = <A>(channel: string, listener: (value: A) => void) => {
  const handler = (_event: IpcRendererEvent, value: A) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.off(channel, handler);
};

// Everything the renderer may ask of the desktop shell. The server's address and token
// resolve once it is up, or reject with the reason it failed to start.
contextBridge.exposeInMainWorld("uncut", {
  getServerConnection: () => ipcRenderer.invoke(SERVER_CONNECTION_CHANNEL),
  onServerExit: (listener: (reason: string) => void) => subscribe(SERVER_EXIT_CHANNEL, listener),
  appInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  chooseFolder: (purpose: FolderPurpose) => ipcRenderer.invoke(CHOOSE_FOLDER_CHANNEL, purpose),
  showInFolder: (path: string) => ipcRenderer.invoke(SHOW_IN_FOLDER_CHANNEL, path),
  setAppState: (state: AppState) => ipcRenderer.send(APP_STATE_CHANNEL, state),
  onMenuCommand: (listener: (command: MenuCommand) => void) => subscribe(MENU_COMMAND_CHANNEL, listener),
});
