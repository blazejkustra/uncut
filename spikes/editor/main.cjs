// Uncut editor (phase 2 spike). The main process plays the server's role: it owns the
// project, applies every edit through the reference engine, saves project.json and
// makes thumbnails. The renderer only draws and sends ops.
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { exportProject } = require("./export.cjs");
const { createAgent } = require("./agent.cjs");

const run = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const spec = (p) => pathToFileURL(path.join(root, "spec", p)).href;

if (process.env.UNCUT_CDP) app.commandLine.appendSwitch("remote-debugging-port", process.env.UNCUT_CDP);

let engine; // { applyEdit, createSession, validate, EditError, EditConflict }
let state = null; // { dir, initial, session, past: [session], future: [session], agentSeen }
let win;
let agent;

async function loadEngine() {
  const [ops, val, log, timeline] = await Promise.all([import(spec("lib/apply-ops.mjs")), import(spec("lib/validate.mjs")), import(spec("lib/edit-log.mjs")), import("./timeline.mjs")]);
  const modules = await val.loadModules(path.join(root, "spec/modules/builtin"), path.join(root, "spec/examples/plugins"));
  engine = { ...ops, ...log, timeline, modules, validate: (p) => val.validateProject(p, modules), duration: val.projectDuration };
}

const mediaPath = (dir, m) => (path.isAbsolute(m.path) ? m.path : path.join(dir, m.path));

function snapshot() {
  const { dir, session } = state;
  const media = Object.fromEntries(session.project.media.map((m) => [m.id, pathToFileURL(mediaPath(dir, m)).href]));
  return { dir, project: session.project, revision: session.revision, media, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

async function save() {
  await fs.writeFile(path.join(state.dir, "project.json"), JSON.stringify(state.session.project, null, 2) + "\n");
}

async function openProject(dir) {
  const project = JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8"));
  const errors = engine.validate(project);
  if (errors.length) throw new Error(`project.json is invalid: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  state = { dir, initial: project, session: engine.createSession(project), past: [], future: [], agentSeen: 0 };
  agent?.resetConversation();
  return snapshot();
}

function errorReply(e) {
  return { error: e.message, details: (e.details ?? []).map((d) => (typeof d === "string" ? d : `${d.path}: ${d.message}`)) };
}

async function edit({ ops, summary, actor = "user" }) {
  try {
    const next = engine.applyEdit(state.session, { actor, ops, summary }, engine.validate);
    state.past.push(state.session);
    state.future = [];
    state.session = next;
    await save();
    return snapshot();
  } catch (e) {
    if (e instanceof engine.EditError) return errorReply(e);
    throw e;
  }
}

async function step(from, to) {
  if (!from.length) return snapshot();
  to.push(state.session);
  state.session = from.pop();
  await save();
  return snapshot();
}

/** One sprite per media: a frame every second, 20 columns, 90 px tall. Cached in .cache/thumbs. */
async function thumbs(mediaId) {
  const m = state.session.project.media.find((x) => x.id === mediaId);
  if (!m || m.kind !== "video") return null;
  const out = path.join(state.dir, ".cache", "thumbs", `${mediaId}.jpg`);
  const seconds = Math.ceil(m.probe.frames / state.session.project.canvas.fps);
  const cols = 20;
  const meta = { url: pathToFileURL(out).href, cols, rows: Math.ceil(seconds / cols), every: 1, w: 160, h: 90 };
  try {
    await fs.access(out);
    return meta;
  } catch {}
  await fs.mkdir(path.dirname(out), { recursive: true });
  await run("ffmpeg", ["-v", "error", "-y", "-hwaccel", "videotoolbox", "-skip_frame", "nokey", "-i", mediaPath(state.dir, m), "-map", "0:v:0", "-vf", `fps=1,scale=160:90:force_original_aspect_ratio=increase,crop=160:90,tile=${cols}x${meta.rows}`, "-frames:v", "1", "-q:v", "4", out], { maxBuffer: 1 << 26 });
  return meta;
}

/** Agent edits: same engine, attributed to the agent and its turn, pushed live to the window. */
function applyAgentEdit({ ops, baseRevision, summary, turnId }) {
  try {
    const next = engine.applyEdit(state.session, { actor: "agent", ops, baseRevision, summary, turnId }, engine.validate);
    state.past.push(state.session);
    state.future = [];
    state.session = next;
    state.agentSeen = next.revision;
    save();
    win?.webContents.send("project:changed", snapshot());
    return { revision: next.revision };
  } catch (e) {
    if (e instanceof engine.EditError) return errorReply(e);
    throw e;
  }
}

let turnCount = 0;
async function agentSend({ text, frame, selected }) {
  const turnId = `turn-${++turnCount}-${Date.now().toString(36)}`;
  const note = engine.manualEditsNote(state.session, state.agentSeen);
  const context = [`Playhead: frame ${frame}.`, selected ? `Selected: ${selected}.` : "", note].filter(Boolean).join("\n");
  state.agentSeen = state.session.revision;
  const emit = (ev) => win?.webContents.send("agent:event", { turnId, ...ev });
  emit({ type: "start", text, note: note || null });
  const result = await agent.send({ prompt: `${text}\n\n<editor-context>\n${context}\n</editor-context>`, turnId, onEvent: emit });
  state.agentSeen = state.session.revision;
  return { turnId, ...result };
}

async function agentUndoTurn(turnId) {
  state.past.push(state.session);
  state.future = [];
  state.session = engine.undoTurn(state.initial, state.session, turnId);
  state.agentSeen = state.session.revision;
  await save();
  return snapshot();
}

ipcMain.handle("project:open", (_e, dir) => openProject(dir));
ipcMain.handle("agent:send", (_e, req) => agentSend(req));
ipcMain.handle("agent:undo-turn", (_e, turnId) => agentUndoTurn(turnId));
ipcMain.handle("agent:stop", () => agent.stop());
ipcMain.handle("project:edit", (_e, req) => edit(req));
ipcMain.handle("project:undo", () => step(state.past, state.future));
ipcMain.handle("project:redo", () => step(state.future, state.past));
ipcMain.handle("media:thumbs", (_e, id) => thumbs(id));
ipcMain.handle("project:choose", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory"], message: "Open a .uncut project folder" });
  return r.canceled ? null : openProject(r.filePaths[0]);
});
ipcMain.handle("shell:reveal", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("project:export", async (e) => {
  const started = Date.now();
  try {
    const file = await exportProject({
      project: state.session.project,
      dir: state.dir,
      mediaPath: (m) => mediaPath(state.dir, m),
      onProgress: (f) => e.sender.send("export:progress", f),
    });
    return { file, seconds: (Date.now() - started) / 1000 };
  } catch (err) {
    return { error: err.message };
  }
});

app.whenReady().then(async () => {
  await loadEngine();
  agent = createAgent({
    session: () => state.session,
    dir: () => state.dir,
    mediaPath: (m) => mediaPath(state.dir, m),
    applyAgentEdit,
    modules: engine.modules,
    timeline: engine.timeline,
    uiShow: (args) => win?.webContents.send("ui:show", args),
  });
  await agent.start();
  if (process.env.UNCUT_BRIDGE_INFO) await fs.writeFile(process.env.UNCUT_BRIDGE_INFO, JSON.stringify({ port: agent.port, token: agent.token }));
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    backgroundColor: "#0a0a0a",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), backgroundThrottling: false },
  });
  const project = process.env.UNCUT_PROJECT ?? process.argv.find((a) => a.endsWith(".uncut")) ?? path.join(root, "fixtures/drone-demo.uncut");
  win.loadFile(path.join(__dirname, "index.html"), { query: { project: path.resolve(project) } });
});
app.on("window-all-closed", () => app.quit());
