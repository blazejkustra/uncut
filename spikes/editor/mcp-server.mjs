// Uncut's MCP server for agent CLIs (stdio, JSON-RPC, one message per line). It holds no
// state: tools/list and tools/call are forwarded to the running editor over its local bridge.
import { createInterface } from "node:readline";

const BRIDGE = process.env.UNCUT_BRIDGE;
const TOKEN = process.env.UNCUT_TOKEN;
const headers = { "content-type": "application/json", "x-uncut-token": TOKEN };
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "uncut", version: "0.0.1" } } });
  }
  if (method === "tools/list") {
    const tools = await (await fetch(`${BRIDGE}/tools`, { headers })).json();
    return send({ id, result: { tools } });
  }
  if (method === "tools/call") {
    const r = await fetch(`${BRIDGE}/call`, { method: "POST", headers, body: JSON.stringify({ name: params.name, args: params.arguments }) });
    return send({ id, result: await r.json() });
  }
  if (method === "ping") return send({ id, result: {} });
  if (id !== undefined) send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => msg.id !== undefined && send({ id: msg.id, error: { code: -32000, message: e.message } }));
});
