import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { SERVER_CONNECTION_CHANNEL, SERVER_EXIT_CHANNEL } from "./ipc.ts";

// The renderer's only way to learn where the server is. Resolves once the server is up,
// rejects with the reason if it failed to start.
contextBridge.exposeInMainWorld("uncut", {
  getServerConnection: () => ipcRenderer.invoke(SERVER_CONNECTION_CHANNEL),
  onServerExit: (listener: (reason: string) => void) => {
    const handler = (_event: IpcRendererEvent, reason: string) => listener(reason);
    ipcRenderer.on(SERVER_EXIT_CHANNEL, handler);
    return () => void ipcRenderer.off(SERVER_EXIT_CHANNEL, handler);
  },
});
