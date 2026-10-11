// Talks to spikes/editor/mcp-server.mjs over stdio the way an agent CLI would.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export function mcpClient(bridge) {
  const proc = spawn(process.execPath, [resolve("spikes/editor/mcp-server.mjs")], { env: { ...process.env, UNCUT_BRIDGE: `http://127.0.0.1:${bridge.port}`, UNCUT_TOKEN: bridge.token } });
  const waiting = new Map();
  let id = 0;
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const call = async (name, args) => (await request("tools/call", { name, arguments: args })).result;
  return { request, call, close: () => proc.kill() };
}
