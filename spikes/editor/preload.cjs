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
  exportVideo: () => ipcRenderer.invoke("project:export"),
  agentSend: (req) => ipcRenderer.invoke("agent:send", req),
  agentUndoTurn: (turnId) => ipcRenderer.invoke("agent:undo-turn", turnId),
  agentStop: () => ipcRenderer.invoke("agent:stop"),
  onAgentEvent: (fn) => ipcRenderer.on("agent:event", (_e, ev) => fn(ev)),
  onProjectChanged: (fn) => ipcRenderer.on("project:changed", (_e, snap) => fn(snap)),
  onUiShow: (fn) => ipcRenderer.on("ui:show", (_e, args) => fn(args)),
  onExportProgress: (fn) => ipcRenderer.on("export:progress", (_e, f) => fn(f)),
});
