// Uncut's MCP server for agent CLIs (D40): stdio, JSON-RPC, one message per line. It holds no
// state and knows nothing about projects: tools/list and tools/call go to the running Uncut
// server's agent bridge (agentBridge.ts) with the turn's token. Bundled to dist/mcp.mjs and
// started by claude from the --mcp-config the agent service writes, on the server's runtime.
import { createInterface } from "node:readline";

const BRIDGE = process.env.UNCUT_BRIDGE ?? "";
const TOKEN = process.env.UNCUT_AGENT_TOKEN ?? "";
// Nothing below needs them; don't hand them to anything else.
delete process.env.UNCUT_AGENT_TOKEN;

const headers = { "content-type": "application/json", "x-uncut-agent-token": TOKEN };
const send = (msg: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

const bridge = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${BRIDGE}${path}`, { ...init, headers }).catch((error: Error & { cause?: { code?: string } }) => {
    // Uncut is gone (quit or crashed): there's nothing left to serve, so don't linger.
    if (error.cause?.code === "ECONNREFUSED") process.exit(1);
    throw error;
  });
  if (response.status === 401) throw new Error("Uncut refused the call: this agent turn has ended.");
  if (!response.ok) throw new Error(`Uncut answered ${response.status}`);
  return (await response.json()) as unknown;
};

interface Message {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: { protocolVersion?: string; name?: string; arguments?: unknown };
}

async function handle({ id, method, params }: Message) {
  if (method === "initialize") {
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "uncut", version: "0.0.1" } } });
  }
  if (method === "tools/list") return send({ id, result: { tools: await bridge("/agent/tools") } });
  if (method === "tools/call") {
    const result = await bridge("/agent/call", { method: "POST", body: JSON.stringify({ name: params?.name, args: params?.arguments ?? {} }) });
    return send({ id, result });
  }
  if (method === "ping") return send({ id, result: {} });
  // Notifications (no id), such as notifications/initialized, need no answer.
  if (id !== undefined) send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: Message;
  try {
    msg = JSON.parse(line) as Message;
  } catch {
    return;
  }
  handle(msg).catch((error: Error) => {
    if (msg.id === undefined) return;
    // A failed tool call is a tool error the model can read, not a protocol failure.
    if (msg.method === "tools/call") send({ id: msg.id, result: { isError: true, content: [{ type: "text", text: error.message }] } });
    else send({ id: msg.id, error: { code: -32000, message: error.message } });
  });
});
// claude closes stdin when the turn ends.
process.stdin.on("end", () => process.exit(0));
