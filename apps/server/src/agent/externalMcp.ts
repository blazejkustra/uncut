// Outside agents' MCP (JSON-RPC) on the server: the desktop's loopback gateway (apps/desktop/src/mcpGateway.ts)
// checks the outside agent's token, Host and Origin, picks the window, and forwards each message
// here under the server's own token. Unlike agentBridge.ts, no agent CLI of ours is behind it.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { EXTERNAL_MCP_PATH, PROJECT_OPEN_TOOL } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../app/config.ts";
import { Projects } from "../project/projects.ts";
import { Agent, type AgentShape, type McpResult } from "./agent.ts";
import { DOC_TOPICS } from "./agentTools.ts";

const textOf = (text: string, isError = false): McpResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

export const EXTERNAL_INSTRUCTIONS = `Uncut is a video editor open on this Mac; the user watches your edits appear live in its timeline.
Start with project_read, and pass its revision as baseRevision to timeline_edit. Positions and lengths are integer frames at the project's fps. Group related ops into one timeline_edit with a short summary.
With no project open, call project_open with a footage folder or a .uncut project.
Big changes (removing items, tracks or media, cutting by transcript, edits of many ops) wait for the user's Allow on a card in Uncut, so a call can take a while. A refusal is final for that call.
docs_read {topic} gives each area's reference (${DOC_TOPICS.join(", ")}). Read a topic before you first work in that area. After an edit that changes how things look, render_frames a few frames.`;

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

const parentForNew = () => {
  const movies = join(homedir(), "Movies");
  return existsSync(movies) ? movies : homedir();
};

/** `name`, or `name 2`, `name 3`... when that project is already there. */
const freeProjectName = (parent: string, name: string) => {
  let n = 1;
  let candidate = name;
  while (existsSync(join(parent, `${candidate}.uncut`))) candidate = `${name} ${++n}`;
  return candidate;
};

const isFolder = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A footage folder into a new project in this server, its media imported in an outside turn. */
const openFootage = (agent: AgentShape, projects: typeof Projects.Service, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const raw = typeof args.path === "string" ? args.path.trim() : "";
    const folder = expandHome(raw);
    if (!isAbsolute(folder)) return textOf("Pass path: the absolute path of a footage folder or a .uncut project.", true);
    if (!isFolder(folder)) return textOf(`${folder} isn't a folder on this Mac.`, true);
    if (yield* projects.view) return textOf("This Uncut window has a project open already.", true);
    const parent = parentForNew();
    const wanted = typeof args.name === "string" && args.name.trim() ? args.name.trim() : basename(resolve(folder));
    const created = yield* projects.create({ parentDir: parent, name: freeProjectName(parent, wanted) }).pipe(
      Effect.map((snapshot) => ({ dir: snapshot.dir })),
      Effect.catch((error) => Effect.succeed({ problem: (error as { message?: string }).message ?? "Uncut couldn't create the project." })),
    );
    if ("problem" in created) return textOf(created.problem, true);
    const imported = yield* agent.externalCall("media_import", { path: folder });
    return { ...imported, content: [{ type: "text" as const, text: `Project opened at ${created.dir}.` }, ...imported.content] };
  });

export const handleMessage = (agent: AgentShape, projects: typeof Projects.Service, version: string, msg: Record<string, any>) =>
  Effect.gen(function* () {
    const { id, method, params } = msg;
    if (id === undefined) return undefined;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      return reply({
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "uncut", version },
        instructions: EXTERNAL_INSTRUCTIONS,
      });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: [...(yield* agent.externalTools), PROJECT_OPEN_TOOL] });
    if (method === "tools/call") {
      const name = String(params?.name ?? "");
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      return reply(name === PROJECT_OPEN_TOOL.name ? yield* openFootage(agent, projects, args) : yield* agent.externalCall(name, args));
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${String(method)}` } };
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const agent = yield* Agent;
    const projects = yield* Projects;
    const { version } = yield* ServerConfig;
    return HttpRouter.add(
      "POST",
      EXTERNAL_MCP_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
        if (!body || typeof body !== "object" || Array.isArray(body)) return HttpServerResponse.text("Bad request", { status: 400 });
        const answer = yield* handleMessage(agent, projects, version, body as Record<string, any>);
        return answer ? HttpServerResponse.text(JSON.stringify(answer), { contentType: "application/json" }) : HttpServerResponse.empty({ status: 202 });
      }),
    );
  }),
);
