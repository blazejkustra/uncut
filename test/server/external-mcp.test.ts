// Outside agents over MCP: the desktop's gateway (its checks and forwarding) in front of the real
// bundled server, driven by the official MCP client.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DEFAULT_MCP_PORT,
  EXTERNAL_MCP_PATH,
  newToken,
  pickWindow,
  PROJECT_OPEN_NAME,
  readEnabled,
  readToken,
  refusal,
  startGateway,
  TOKEN_FILE,
  writeEnabled,
  type Gateway,
} from "../../apps/desktop/src/mcpGateway.ts";
import { EXTERNAL_MCP_PATH as CONTRACT_PATH, PROJECT_OPEN_TOOL } from "../../packages/contracts/src/index.ts";
import { MCP_CLIENTS } from "../../apps/web/src/settings/mcpClients.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const skip = existsSync(BUNDLE) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";
const T = { skip, timeout: 60000 };
const TOKEN = "t".repeat(43);

let root: string;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-mcp-")));
});
after(() => {
  killAll();
  rmSync(root, { recursive: true, force: true });
});

/** The relay the desktop's route does, to one server. */
const forwardTo = (port: number, token: string) => async (message: Record<string, unknown>) => {
  const response = await fetch(`http://127.0.0.1:${port}${EXTERNAL_MCP_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  return response.status === 202 ? undefined : response.json();
};

async function stack(env: NodeJS.ProcessEnv = {}) {
  const data = mkdtempSync(join(root, "data-"));
  const server = await startServer({ env: { UNCUT_DATA_DIR: data, UNCUT_APPROVAL_MS: "8000", UNCUT_EXTERNAL_IDLE_MS: "300", ...env } });
  const app = await connect(server.ready.port, server.ready.token);
  const gateway = await startGateway({ port: 0, token: () => TOKEN, forward: forwardTo(server.ready.port, server.ready.token) });
  const clients: Array<Client> = [];
  const mcp = async (token = TOKEN) => {
    const client = new Client({ name: "uncut-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  };
  const end = async () => {
    await Promise.all(clients.map((c) => c.close()));
    await gateway.stop();
    app.close();
    await server.stop();
  };
  return { app, gateway, mcp, end };
}

/** The first agent state `matches` accepts. */
async function agentState(app: Awaited<ReturnType<typeof connect>>, matches: (state: any) => boolean) {
  const states = app.subscribe("agent.subscribe");
  await states.until((value) => value !== null && matches(value));
  return states.values.find((value) => value !== null && matches(value));
}

const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

/** Raw request, so Host and Origin are exactly what's tested (fetch won't set them). */
const raw = (gateway: Gateway, headers: Record<string, string>, method = "POST", path = "/mcp") =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: gateway.port, path, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  });

test("the desktop's copies of contracts' values stay equal", () => {
  assert.equal(EXTERNAL_MCP_PATH, CONTRACT_PATH);
  assert.equal(PROJECT_OPEN_NAME, PROJECT_OPEN_TOOL.name);
});

test("the gateway refuses what isn't this Mac's client with the token", T, async () => {
  let forwarded = 0;
  const gateway = await startGateway({
    port: 0,
    token: () => TOKEN,
    forward: async () => {
      forwarded++;
      return { jsonrpc: "2.0", id: 1, result: {} };
    },
  });
  try {
    const host = `127.0.0.1:${gateway.port}`;
    const auth = `Bearer ${TOKEN}`;
    assert.equal(await raw(gateway, { host }), 401, "no token");
    assert.equal(await raw(gateway, { host, authorization: "Bearer wrong" }), 401, "wrong token");
    assert.equal(await raw(gateway, { host }, "POST", `/mcp?token=${TOKEN}`), 401, "a token in the query");
    assert.equal(await raw(gateway, { host: `evil.example:${gateway.port}`, authorization: auth }), 403, "a rebound host, with the token");
    assert.equal(await raw(gateway, { host, authorization: auth, origin: "https://evil.example" }), 403, "a web page's origin, with the token");
    assert.equal(await raw(gateway, { host, authorization: auth, origin: "null" }), 403, "a sandboxed page's origin");
    assert.equal(await raw(gateway, { host, authorization: auth }, "GET"), 405);
    assert.equal(await raw(gateway, { host, authorization: auth }, "POST", "/other"), 404);
    assert.equal(forwarded, 0);
    assert.equal(await raw(gateway, { host, authorization: auth }), 200);
    assert.equal(await raw(gateway, { host: `localhost:${gateway.port}`, authorization: auth }), 200);
    assert.equal(forwarded, 2);
  } finally {
    await gateway.stop();
  }
});

test("an empty token never matches, so a missing token file can't open the door", () => {
  const req = { headers: { host: "127.0.0.1:1", authorization: "Bearer " }, method: "POST", url: "/mcp" };
  assert.equal(refusal(req, 1, "")?.status, 401);
});

test("a wrong token fails the official client's connect", T, async () => {
  const s = await stack();
  try {
    await assert.rejects(() => s.mcp("wrong"));
  } finally {
    await s.end();
  }
});

test("a turned off gateway leaves nothing listening", T, async () => {
  const gateway = await startGateway({ port: 0, token: () => TOKEN, forward: async () => undefined });
  const port = gateway.port;
  await gateway.stop();
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" }));
});

test("with no project open, tools list and a call says what to do", T, async () => {
  const s = await stack();
  try {
    const mcp = await s.mcp();
    const { tools } = await mcp.listTools();
    for (const name of ["project_read", "timeline_edit", "project_open"])
      assert.ok(
        tools.some((t) => t.name === name),
        name,
      );
    const result = await mcp.callTool({ name: "project_read", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No project is open in Uncut\. Call project_open/);
    assert.ok(mcp.getInstructions()?.includes("project_read"));
  } finally {
    await s.end();
  }
});

test("a real round trip: read, edit, seen in the editor, a turn of its own agent, undone like one", T, async () => {
  const s = await stack();
  try {
    await s.app.ok("project.create", { parentDir: root, name: "Round trip" });
    const mcp = await s.mcp();
    const read = JSON.parse(textOf(await mcp.callTool({ name: "project_read", arguments: {} })));
    const edit = await mcp.callTool({
      name: "timeline_edit",
      arguments: {
        baseRevision: read.revision,
        summary: "Add a title",
        ops: [
          {
            op: "insert_item",
            track: "text",
            item: {
              id: "hello",
              type: "text",
              start: 0,
              duration: 60,
              text: "Hello",
              transform: { x: 100, y: 100 },
              style: { preset: "text.title", size: 120 },
            },
          },
        ],
      },
    });
    assert.notEqual(edit.isError, true, textOf(edit));
    const state = await agentState(s.app, (x) => x.agents.some((a: any) => a.name === "Outside agent" && a.status === "idle") && x.turns.length > 0);
    const turn = state.turns.find((t: any) => t.edits.length);
    assert.equal(turn.status, "done");
    assert.deepEqual(
      turn.items.map((i: any) => [i.tool, i.status]),
      [
        ["project_read", "done"],
        ["timeline_edit", "done"],
      ],
    );
    const undone = await s.app.ok("agent.undoTurn", { turnId: turn.id });
    assert.equal(JSON.stringify(undone.project).includes("Hello"), false);
  } finally {
    await s.end();
  }
});

test("a big change waits for Allow on a card, and No means no", T, async () => {
  const s = await stack();
  try {
    await s.app.ok("project.create", { parentDir: root, name: "Gated" });
    const mcp = await s.mcp();
    const read = JSON.parse(textOf(await mcp.callTool({ name: "project_read", arguments: {} })));
    const pending = mcp.callTool({
      name: "timeline_edit",
      arguments: { baseRevision: read.revision, summary: "Remove the main track", ops: [{ op: "delete_track", track: "main" }] },
    });
    const state = await agentState(s.app, (x) => x.agents.some((a: any) => a.approval));
    const card = state.agents.find((a: any) => a.approval).approval;
    await s.app.ok("agent.approve", { id: card.id, allow: false });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /said no/);
  } finally {
    await s.end();
  }
});

test("Stop ends the outside turn and the agent hears it once", T, async () => {
  const s = await stack({ UNCUT_EXTERNAL_IDLE_MS: "20000" });
  try {
    await s.app.ok("project.create", { parentDir: root, name: "Stopped" });
    const mcp = await s.mcp();
    await mcp.callTool({ name: "project_read", arguments: {} });
    const state = await agentState(s.app, (x) => x.agents.some((a: any) => a.running));
    await s.app.ok("agent.cancel", { agentId: state.agents.find((a: any) => a.running).id });
    await agentState(s.app, (x) => x.turns.some((t: any) => t.status === "cancelled"));
    const stopped = await mcp.callTool({ name: "project_read", arguments: {} });
    assert.equal(stopped.isError, true);
    assert.match(textOf(stopped), /pressed Stop/);
    assert.notEqual((await mcp.callTool({ name: "project_read", arguments: {} })).isError, true);
  } finally {
    await s.end();
  }
});

test("project_open makes a project from a footage folder and imports nothing it can't", T, async () => {
  const s = await stack({ HOME: root });
  try {
    const folder = join(root, "Trip");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "notes.txt"), "not media");
    const mcp = await s.mcp();
    const missing = await mcp.callTool({ name: "project_open", arguments: { path: join(root, "nope") } });
    assert.equal(missing.isError, true);
    const opened = await mcp.callTool({ name: "project_open", arguments: { path: folder } });
    assert.notEqual(opened.isError, true, textOf(opened));
    assert.match(textOf(opened), /Project opened at .*Trip\.uncut/);
    assert.ok(statSync(join(root, "Trip.uncut", "project.json")).isFile());
    const again = await mcp.callTool({ name: "project_open", arguments: { path: folder } });
    assert.match(textOf(again), /has a project open already/);
  } finally {
    await s.end();
  }
});

test("the token is a private file, kept until renewed; the switch is off by default", () => {
  const dir = mkdtempSync(join(root, "state-"));
  assert.equal(readEnabled(dir), false);
  const token = readToken(dir);
  assert.equal(token.length, 43);
  assert.equal(statSync(join(dir, TOKEN_FILE)).mode & 0o777, 0o600);
  assert.equal(readToken(dir), token);
  assert.notEqual(newToken(dir), token);
  writeEnabled(dir, true);
  assert.equal(readEnabled(dir), true);
});

test("pickWindow prefers the focused window with a project", () => {
  const w = (id: number, projectDir?: string) => ({ id, projectDir });
  assert.equal(pickWindow([w(1), w(2, "/a"), w(3, "/b")], 3)?.id, 3);
  assert.equal(pickWindow([w(1), w(2, "/a")], 1)?.id, 2);
  assert.equal(pickWindow([w(1), w(2)], 2)?.id, 2);
  assert.equal(pickWindow([], undefined), undefined);
});

test("each client's setup carries the url and token; the port matches the plugin's", () => {
  const url = `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`;
  for (const client of MCP_CLIENTS.filter((c) => c.snippet)) {
    const snippet = client.snippet!(url, TOKEN);
    assert.ok(snippet.includes(url) && snippet.includes(TOKEN), client.id);
  }
  assert.match(MCP_CLIENTS[0]!.snippet!(url, TOKEN), /^claude mcp add --transport http --scope user uncut /);
});
