// Spike B: the agent loop. Claude Code runs on the user's own login with no built-in
// tools and one MCP server (mcp-server.mjs). That server forwards every call over a local,
// token-protected HTTP bridge to the editor, so agent edits go through the same engine,
// validation and undo history as the user's, and appear live in the window.
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const { renderTexts, renderFrame } = require("./export.cjs");

const run = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const TOOL_NAMES = ["project_read", "timeline_edit", "render_frames", "contact_sheet", "modules_list", "ui_show"];

const SYSTEM = `You are the editing agent inside Uncut, a desktop video editor. The user sees the timeline and a live preview; every edit you make appears there immediately.
- Positions and lengths are integer frames at the project's canvas fps. Main-track items have no start: they play back to back. "in" is where an item starts inside its media, in project frames.
- Always project_read before editing and pass its revision as baseRevision. Group related ops into one timeline_edit with a short summary the user will read.
- Look before and after you edit: contact_sheet to scan footage, render_frames to check the result. Don't claim something looks good without looking.
- A transition sits centred on a cut and needs media beyond both clips (half its length on each side). If an edit is refused, read the error and fix the ops.
- If the message lists edits the user made by hand, they are intentional: build on them, don't undo them.
- Keep replies short: what you changed and why, in plain words.`;

async function loadTools() {
  const spec = JSON.parse(await fs.readFile(path.join(root, "spec/agent/tools.json"), "utf8"));
  const ops = JSON.parse(await fs.readFile(path.join(root, "spec/schema/edit-ops.schema.json"), "utf8"));
  return spec.tools
    .filter((t) => TOOL_NAMES.includes(t.name))
    .map((t) => {
      const schema = structuredClone(t.inputSchema);
      if (schema.properties?.ops) schema.properties.ops = { type: "array", minItems: 1, items: { $ref: "#/$defs/op" } };
      schema.$defs = { ...spec.$defs, ...ops.$defs };
      return { name: t.name, description: t.description, inputSchema: schema };
    });
}

/**
 * The agent runs on the user's Claude subscription login (D8). An ANTHROPIC_API_KEY in the
 * environment would silently switch it to pay-per-token billing, so it's removed, along with
 * variables a parent Claude Code session leaves behind.
 */
function agentEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  }
  return env;
}

/** ctx: { session(), dir(), mediaPath(m), applyAgentEdit(req), modules, uiShow(args), duration(project) } */
function createAgent(ctx) {
  const token = crypto.randomBytes(16).toString("hex");
  let port = 0;
  let tools = [];
  let sessionId = null;
  let proc = null;
  let turn = null; // { id, onEvent }

  const summary = (project, range) => {
    const { layout } = ctx.timeline;
    const { starts, duration } = layout(project);
    const inRange = (it) => !range || (starts.get(it.id) < range.end && starts.get(it.id) + it.duration > range.start);
    return {
      revision: ctx.session().revision,
      name: project.name,
      canvas: project.canvas,
      duration,
      seconds: +(duration / project.canvas.fps).toFixed(2),
      media: project.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, frames: m.probe?.frames, fps: m.probe?.fps, size: m.probe?.width ? `${m.probe.width}x${m.probe.height}` : undefined, hasAudio: m.probe?.hasAudio })),
      tracks: project.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        role: t.role,
        name: t.name,
        items: t.items.filter(inRange).map((it) => ({ id: it.id, type: it.type, start: starts.get(it.id), duration: it.duration, ...(it.media ? { media: it.media, in: it.in } : {}), ...(it.text ? { text: it.text } : {}), ...(it.transitionIn ? { transitionIn: it.transitionIn } : {}) })),
      })),
    };
  };

  const frameDir = () => path.join(ctx.dir(), ".cache", "agent");

  async function frames(project, list, width) {
    await fs.mkdir(frameDir(), { recursive: true });
    const texts = new Map((await renderTexts(project, frameDir())).map((t) => [t.item.id, t.file]));
    const files = [];
    for (const f of list) {
      files.push(await renderFrame({ project, f, mediaPath: ctx.mediaPath, texts, width, out: path.join(frameDir(), `r${ctx.session().revision}-f${f}-${width}.jpg`) }));
    }
    return files;
  }

  const image = async (file) => ({ type: "image", data: (await fs.readFile(file)).toString("base64"), mimeType: "image/jpeg" });
  const text = (value) => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) });

  const handlers = {
    async project_read({ detail = "summary", range } = {}) {
      const p = ctx.session().project;
      return [text(detail === "full" ? { revision: ctx.session().revision, project: p } : summary(p, range))];
    },
    async timeline_edit({ baseRevision, ops, summary: line }) {
      const r = ctx.applyAgentEdit({ ops, baseRevision, summary: line, turnId: turn?.id });
      if (r.error) return { isError: true, content: [text({ refused: r.error, details: r.details, revision: ctx.session().revision })] };
      const p = ctx.session().project;
      return [text({ ok: true, revision: r.revision, duration: ctx.timeline.layout(p).duration })];
    },
    async render_frames({ frames: list, scale = 0.33 }) {
      const p = ctx.session().project;
      const width = Math.max(320, Math.round(p.canvas.width * scale));
      const files = await frames(p, list, Math.min(width, 1920));
      return [text(list.map((f, i) => `frame ${f}: ${files[i]}`).join("\n")), ...(await Promise.all(files.map(image)))];
    },
    async contact_sheet({ media, range, at = "every", every, columns = 6 }) {
      const p = ctx.session().project;
      const out = path.join(frameDir(), `sheet-${Date.now()}.jpg`);
      await fs.mkdir(frameDir(), { recursive: true });
      let picks;
      if (media) {
        const m = p.media.find((x) => x.id === media);
        if (!m) return { isError: true, content: [text(`No media "${media}"`)] };
        const r = range ?? { start: 0, end: m.probe.frames };
        const step = every ?? Math.max(1, Math.ceil((r.end - r.start) / 24));
        picks = [];
        for (let f = r.start; f < r.end && picks.length < 48; f += step) picks.push(f);
        // One fast seek per sample (a long file is never decoded end to end), then tile them.
        const tmp = path.join(frameDir(), `sheet-${Date.now()}`);
        await fs.mkdir(tmp, { recursive: true });
        for (let i = 0; i < picks.length; i += 4) {
          await Promise.all(picks.slice(i, i + 4).map((f, j) => run("ffmpeg", ["-v", "error", "-y", "-hwaccel", "videotoolbox", "-ss", String(f / p.canvas.fps), "-i", ctx.mediaPath(m), "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", path.join(tmp, `${String(i + j).padStart(3, "0")}.jpg`)])));
        }
        await run("ffmpeg", ["-v", "error", "-y", "-framerate", "1", "-i", path.join(tmp, "%03d.jpg"), "-vf", `tile=${columns}x${Math.ceil(picks.length / columns)}`, "-frames:v", "1", "-q:v", "4", out]);
        return [text(`${m.name}: ${picks.length} frames, left to right, top to bottom, at project frames ${picks.join(", ")}`), await image(out)];
      }
      const { starts, duration } = ctx.timeline.layout(p);
      const r = range ?? { start: 0, end: duration };
      if (at === "shots") picks = p.tracks.find((t) => t.role === "main").items.map((it) => starts.get(it.id) + Math.floor(it.duration / 2)).filter((f) => f >= r.start && f < r.end);
      else {
        const step = every ?? Math.max(1, Math.ceil((r.end - r.start) / 18));
        picks = [];
        for (let f = r.start; f < r.end && picks.length < 24; f += step) picks.push(f);
      }
      const files = await frames(p, picks, 320);
      const list = files.map((f) => ["-i", f]).flat();
      const n = files.length;
      const cols = Math.min(columns, n);
      const grid = `${files.map((_, i) => `[${i}:v]`).join("")}xstack=inputs=${n}:layout=${files.map((_, i) => `${(i % cols) ? Array.from({ length: i % cols }, () => "w0").join("+") : "0"}_${Math.floor(i / cols) ? Array.from({ length: Math.floor(i / cols) }, () => "h0").join("+") : "0"}`).join("|")}:fill=black`;
      if (n === 1) await fs.copyFile(files[0], out);
      else await run("ffmpeg", ["-v", "error", "-y", ...list, "-filter_complex", grid, "-q:v", "4", out]);
      return [text(`The edit: ${n} frames at ${picks.join(", ")}`), await image(out)];
    },
    async modules_list({ kind } = {}) {
      const list = [...ctx.modules.values()].filter((m) => !kind || m.kind === kind).map((m) => ({ id: m.id, kind: m.kind, name: m.name, description: m.description }));
      return [text(list)];
    },
    async ui_show(args) {
      ctx.uiShow(args);
      return [text("Shown.")];
    },
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers["x-uncut-token"] !== token) return res.writeHead(403).end();
    if (req.method === "GET" && req.url === "/tools") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(tools));
    let body = "";
    for await (const chunk of req) body += chunk;
    const { name, args } = JSON.parse(body || "{}");
    const started = Date.now();
    try {
      if (!handlers[name]) throw new Error(`Unknown tool ${name}`);
      const r = await handlers[name](args ?? {});
      const result = Array.isArray(r) ? { content: r } : r;
      turn?.onEvent({ type: "tool_done", name, ms: Date.now() - started, isError: !!result.isError });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (e) {
      turn?.onEvent({ type: "tool_done", name, ms: Date.now() - started, isError: true });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ isError: true, content: [text(e.message)] }));
    }
  });

  async function start() {
    tools = await loadTools();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  }

  /** Run one turn. Resolves when Claude finishes. Events stream to onEvent. */
  async function send({ prompt, turnId, onEvent }) {
    if (proc) throw new Error("The agent is still working on the last message.");
    turn = { id: turnId, onEvent };
    const cfg = path.join(ctx.dir(), ".cache", "agent", "mcp.json");
    await fs.mkdir(path.dirname(cfg), { recursive: true });
    await fs.writeFile(cfg, JSON.stringify({ mcpServers: { uncut: { command: process.env.UNCUT_NODE ?? "node", args: [path.join(__dirname, "mcp-server.mjs")], env: { UNCUT_BRIDGE: `http://127.0.0.1:${port}`, UNCUT_TOKEN: token } } } }));
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--mcp-config", cfg, "--allowedTools", "mcp__uncut", "--permission-mode", "dontAsk", "--append-system-prompt", SYSTEM];
    if (process.env.UNCUT_AGENT_MODEL) args.push("--model", process.env.UNCUT_AGENT_MODEL);
    if (sessionId) args.push("--resume", sessionId);
    args.push(prompt);
    return new Promise((resolve) => {
      proc = spawn(process.env.UNCUT_CLAUDE ?? "claude", args, { cwd: ctx.dir(), env: agentEnv() });
      let buf = "";
      let final = null;
      let stderr = "";
      proc.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "system" && msg.subtype === "init") {
            sessionId = msg.session_id;
            const connected = msg.mcp_servers?.find((s) => s.name === "uncut")?.status;
            onEvent({ type: "init", model: msg.model, mcp: connected, tools: (msg.tools ?? []).length });
          } else if (msg.type === "assistant") {
            for (const c of msg.message?.content ?? []) {
              if (c.type === "text" && c.text.trim()) onEvent({ type: "text", text: c.text });
              if (c.type === "tool_use") onEvent({ type: "tool", name: c.name.replace(/^mcp__uncut__/, ""), input: c.input });
            }
          } else if (msg.type === "result") {
            final = msg;
          }
        }
      });
      proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      proc.on("close", (code) => {
        proc = null;
        const ev = final
          ? { type: "done", ok: !final.is_error, result: final.result, seconds: final.duration_ms / 1000, turns: final.num_turns, cost: final.total_cost_usd }
          : { type: "done", ok: false, result: `Claude exited (${code}). ${stderr.trim().split("\n").slice(-2).join(" ")}` };
        onEvent(ev);
        turn = null;
        resolve(ev);
      });
    });
  }

  function stop() {
    proc?.kill("SIGINT");
  }

  return { start, send, stop, get port() { return port; }, get token() { return token; }, handlers, resetConversation: () => (sessionId = null) };
}

module.exports = { createAgent, loadTools };
