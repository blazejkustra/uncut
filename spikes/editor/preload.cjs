// The renderer's only door to the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uncut", {
  open: (dir) => ipcRenderer.invoke("project:open", dir),
  choose: () => ipcRenderer.invoke("project:choose"),
  edit: (req) => ipcRenderer.invoke("project:edit", req),
  undo: () => ipcRenderer.invoke("project:undo"),
  redo: () => ipcRenderer.invoke("project:redo"),
  thumbs: (mediaId) => ipcRenderer.invoke("media:thumbs", mediaId),
  reveal: (p) => ipcRenderer.invoke("shell:reveal", p),
});
