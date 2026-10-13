#!/usr/bin/env node
// A process plugin for tests (D97): a minimal stdio MCP server, one JSON-RPC message per line.
// On start it appends { pid, argv, cwd, env (variable names only) } to $FAKE_PLUGIN_LOG.
// Tools, by the end of their name (so a test's manifest can call them anything): *_echo {text}
// (text and a 1x1 PNG), *_env (the same facts as the log line), *_crash (exits with code 3
// without answering), *_sleep {ms} (answers after ms), and misbehaviour for the host's tests:
// *_orphan (starts `sleep 300`, answers with its pid, then exits with code 3), *_junk (prints
// null, [], 5, {"id":null}, a ping and an unknown request to the host before answering, and logs
// the host's replies), *_flood (prints 17 MB with no newline), *_images (a GIF, an SVG and a 6 MB
// PNG). Every notifications/cancelled is logged too ({ cancelled: requestId }).
// It exits when its stdin closes, as an MCP stdio server should.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const facts = () => ({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort() });
const log = (entry: unknown) => process.env.FAKE_PLUGIN_LOG && appendFileSync(process.env.FAKE_PLUGIN_LOG, `${JSON.stringify(entry)}\n`);
log(facts());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const send = (msg: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

interface Message {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg: Message;
  try {
    msg = JSON.parse(line) as Message;
  } catch {
    return;
  }
  const { id, method, params } = msg;
  // The host's answers to our own requests (*_junk).
  if (method === undefined && typeof id === "string") return log({ reply: id, result: msg.result, error: msg.error });
  if (method === "notifications/cancelled") return log({ cancelled: (params as { requestId?: unknown } | undefined)?.requestId });
  if (method === "initialize") return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-plugin", version: "0.1.0" } } });
  if (method === "tools/list") return send({ id, result: { tools: [] } });
  if (method !== "tools/call") {
    if (id !== undefined) send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
    return;
  }
  const args = params?.arguments ?? {};
  const name = params?.name ?? "";
  switch (name.slice(name.lastIndexOf("_") + 1)) {
    case "echo":
      return send({ id, result: { content: [{ type: "text", text: `${name}: ${String(args.text ?? "")}` }, { type: "image", data: PNG, mimeType: "image/png" }] } });
    case "env":
      return send({ id, result: text(facts()) });
    case "crash":
      process.exit(3);
    case "sleep":
      await new Promise((r) => setTimeout(r, Number(args.ms ?? 0)));
      return send({ id, result: text(`slept ${Number(args.ms ?? 0)} ms`) });
    case "orphan": {
      const child = spawn("sleep", ["300"], { stdio: "ignore" });
      send({ id, result: text({ child: child.pid }) });
      setTimeout(() => process.exit(3), 100);
      return;
    }
    case "junk":
      for (const line of ["null", "[]", "5", '"text"', '{"id":null}', '{"jsonrpc":"2.0","id":99999,"result":{}}']) process.stdout.write(`${line}\n`);
      send({ id: "p1", method: "ping" });
      send({ id: "s1", method: "sampling/createMessage", params: {} });
      send({ method: "notifications/message", params: { level: "info", data: "hello" } });
      await new Promise((r) => setTimeout(r, 200));
      return send({ id, result: text("still here") });
    case "flood":
      process.stdout.write("x".repeat(17 * 1024 * 1024));
      return;
    case "images":
      return send({
        id,
        result: {
          content: [
            { type: "image", data: "R0lGODlhAQABAAAAACw=", mimeType: "image/gif" },
            { type: "image", data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" },
            { type: "image", data: "A".repeat(8 * 1024 * 1024), mimeType: "image/png" },
          ],
        },
      });
    default:
      return send({ id, result: { isError: true, content: [{ type: "text", text: `no tool ${name}` }] } });
  }
});
process.stdin.on("end", () => process.exit(0));
