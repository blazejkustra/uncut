// Settings › App › Outside agents, and the routing behind the gateway (mcpGateway.ts): each message
// goes to the server of the window pickWindow chooses; project_open picks or makes a window itself.
import { realpathSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ServerConnection } from "@uncut/contracts";

import type { McpState } from "../ipc.ts";
import { LOCAL_ID } from "../environments.ts";
import {
  DEFAULT_MCP_PORT,
  EXTERNAL_MCP_PATH,
  MCP_ROUTE,
  newToken,
  pickWindow,
  PROJECT_OPEN_NAME,
  readEnabled,
  readToken,
  startGateway,
  UNCUT_PROJECT,
  writeEnabled,
  type Gateway,
} from "../mcpGateway.ts";
import { currentWindow, windows, type AppWindow } from "./state.ts";
import { dataDir, showWindow } from "./windows.ts";

const START_WAIT_MS = 15_000;
const POLL_MS = 200;
const STARTING = "Uncut is still starting. Try again in a few seconds.";
const NO_WINDOW = "No Uncut window is open. Open one from the Dock, then try again.";

const gatewayPort = () => (process.env.UNCUT_MCP_PORT ? Number(process.env.UNCUT_MCP_PORT) : DEFAULT_MCP_PORT);

let gateway: Gateway | undefined;
let problem: string | undefined;
let openWindow: () => AppWindow;
let openProject: (dir: string) => void;

const rpcError = (id: unknown, message: string) => ({ jsonrpc: "2.0", id, error: { code: -32000, message } });
const toolFailure = (id: unknown, text: string) => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } });
const toolAnswer = (id: unknown, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });

const localWindows = () => windows.filter((w) => w.envId === LOCAL_ID && w.server && !w.window.isDestroyed());

const withTimeout = <A>(work: Promise<A>) =>
  Promise.race([work, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), START_WAIT_MS).unref())]);

/** Node's http, not fetch: a call may wait on a card or an export for longer than fetch does. */
const post = (connection: ServerConnection, body: string) =>
  new Promise<unknown>((resolve, reject) => {
    const req = request(
      `${connection.url.replace(/^ws/, "http").replace(/\/[^/]*$/, "")}${EXTERNAL_MCP_PATH}`,
      { method: "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" } },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode === 202) return resolve(undefined);
          if (response.statusCode !== 200) return reject(new Error(`Uncut answered ${response.statusCode}`));
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });

const forwardTo = async (entry: AppWindow | undefined, message: Record<string, unknown>) => {
  if (!entry?.server) return rpcError(message.id, NO_WINDOW);
  const connection = await withTimeout(entry.server.connection);
  return connection ? post(connection, JSON.stringify(message)) : rpcError(message.id, STARTING);
};

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

const realPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const untilOpen = async (dir: string) => {
  for (const started = Date.now(); Date.now() - started < START_WAIT_MS; await new Promise((r) => setTimeout(r, POLL_MS))) {
    if (windows.some((w) => w.projectDir === dir)) return true;
  }
  return false;
};

const openUncutProject = async (id: unknown, path: string) => {
  const dir = realPath(path);
  openProject(dir);
  return (await untilOpen(dir))
    ? toolAnswer(id, `Project opened at ${dir}.`)
    : toolFailure(id, `Uncut couldn't open ${dir} in time. Check that it's an Uncut project.`);
};

const emptyWindow = () => localWindows().find((w) => w.projectDir === undefined && !w.opening && !w.pendingOpen) ?? openWindow();

const openFootage = async (message: Record<string, unknown>) => {
  const entry = emptyWindow();
  const answer = await forwardTo(entry, message);
  showWindow(entry);
  return answer;
};

const isProjectOpen = (message: Record<string, any>) => message.method === "tools/call" && message.params?.name === PROJECT_OPEN_NAME;

const asRouted = (entry: AppWindow) => ({ id: entry.window.id, projectDir: entry.projectDir, entry });

const route = async (message: Record<string, any>) => {
  if (!isProjectOpen(message)) return forwardTo(pickWindow(localWindows().map(asRouted), currentWindow()?.window.id)?.entry, message);
  const path = typeof message.params.arguments?.path === "string" ? expandHome(message.params.arguments.path.trim()) : "";
  return UNCUT_PROJECT.test(path) ? openUncutProject(message.id, path) : openFootage(message);
};

const start = async () => {
  problem = undefined;
  const dir = dataDir();
  const token = readToken(dir);
  try {
    gateway = await startGateway({ port: gatewayPort(), token: () => token, forward: route });
    if (process.env.UNCUT_CDP) console.log(`[test] mcp gateway on ${gateway.port}`);
  } catch (error) {
    problem =
      (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `Port ${gatewayPort()} is taken by another program, so outside agents can't connect. Quit it, then turn this off and on again.`
        : (error as Error).message;
  }
};

const stop = async () => {
  await gateway?.stop();
  gateway = undefined;
};

export const mcpState = (): McpState => {
  const enabled = readEnabled(dataDir());
  const port = gateway?.port ?? gatewayPort();
  return {
    enabled,
    listening: gateway !== undefined,
    url: `http://127.0.0.1:${port}${MCP_ROUTE}`,
    token: enabled ? readToken(dataDir()) : "",
    ...(problem ? { problem } : {}),
  };
};

export async function setMcpEnabled(enabled: boolean) {
  writeEnabled(dataDir(), enabled);
  await stop();
  if (enabled) await start();
  else problem = undefined;
  return mcpState();
}

/** Every client set up with the old token stops working. */
export async function renewMcpToken() {
  newToken(dataDir());
  await stop();
  await start();
  return mcpState();
}

export async function installMcp(deps: { readonly openWindow: typeof openWindow; readonly openProject: typeof openProject }) {
  openWindow = deps.openWindow;
  openProject = deps.openProject;
  if (readEnabled(dataDir())) await start();
}
