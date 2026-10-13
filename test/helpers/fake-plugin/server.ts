#!/usr/bin/env node
// A process plugin for tests (D97), written with @uncut/plugin-sdk (D102).
// On start it appends { pid, argv, cwd, env (variable names only) } to $FAKE_PLUGIN_LOG.
// Tools, by the end of their name (so a test's manifest can call them anything): *_echo {text}
// (text and a 1x1 PNG), *_env (the same facts as the log line), *_crash (exits with code 3
// without answering), *_sleep {ms} (answers after ms), and misbehaviour for the host's tests:
// *_orphan (starts `sleep 300`, answers with its pid, then exits with code 3), *_junk (prints
// null, [], 5, {"id":null}, a ping and an unknown request to the host before answering, and logs
// the host's replies), *_flood (prints 17 MB with no newline), *_images (a GIF, an SVG and a 6 MB
// PNG), *_check (D103, see below). Every notifications/cancelled is logged too ({ cancelled: requestId }).
// It exits when its stdin closes, as an MCP stdio server should.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

import { serve, text, type ToolResult } from "@uncut/plugin-sdk";

const facts = () => ({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort() });
const log = (entry: unknown) => process.env.FAKE_PLUGIN_LOG && appendFileSync(process.env.FAKE_PLUGIN_LOG, `${JSON.stringify(entry)}\n`);
log(facts());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const json = (value: unknown) => text(typeof value === "string" ? value : JSON.stringify(value));
const never = () => new Promise<ToolResult>(() => {});

const server = serve({
  manifest: new URL("./uncut.module.json", import.meta.url),
  tools: {},
  // Tools by the end of their name, so a test's manifest can call them anything.
  fallback: async (args, { name }) => {
    switch (name.slice(name.lastIndexOf("_") + 1)) {
      case "echo":
        return { content: [{ type: "text", text: `${name}: ${String(args.text ?? "")}` }, { type: "image", data: PNG, mimeType: "image/png" }] };
      case "env":
        return json(facts());
      case "check": {
        // A process plugin's own check (D103): one finding for its rule, one for a rule it doesn't
        // own and one without a message (both dropped by Uncut); a project named "Slow…" never answers.
        const project = (args.project ?? {}) as { name?: string; tracks?: Array<unknown> };
        if (String(project.name).startsWith("Slow")) return never();
        return { content: [{ type: "text", text: "findings" }], structuredContent: { findings: [{ rule: "proc.checks.house", message: `${project.tracks?.length ?? 0} tracks, checked by the house rule.`, frame: 0, hint: "Keep it." }, { rule: "taste.extra.end-card", message: "Not this plugin's rule." }, { rule: "proc.checks.house" }] } };
      }
      case "crash":
        process.exit(3);
      case "sleep":
        await new Promise((r) => setTimeout(r, Number(args.ms ?? 0)));
        return json(`slept ${Number(args.ms ?? 0)} ms`);
      case "orphan": {
        const child = spawn("sleep", ["300"], { stdio: "ignore" });
        setTimeout(() => process.exit(3), 100);
        return json({ child: child.pid });
      }
      case "junk":
        for (const line of ["null", "[]", "5", '"text"', '{"id":null}', '{"jsonrpc":"2.0","id":99999,"result":{}}']) process.stdout.write(`${line}\n`);
        server.send({ id: "p1", method: "ping" });
        server.send({ id: "s1", method: "sampling/createMessage", params: {} });
        server.notify("notifications/message", { level: "info", data: "hello" });
        await new Promise((r) => setTimeout(r, 200));
        return json("still here");
      case "flood":
        process.stdout.write("x".repeat(17 * 1024 * 1024));
        return never();
      case "images":
        return {
          content: [
            { type: "image", data: "R0lGODlhAQABAAAAACw=", mimeType: "image/gif" },
            { type: "image", data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" },
            { type: "image", data: "A".repeat(8 * 1024 * 1024), mimeType: "image/png" },
          ],
        };
      default:
        return { isError: true, content: [{ type: "text", text: `no tool ${name}` }] };
    }
  },
  // The host's answers to our own requests (*_junk).
  onReply: (msg) => log({ reply: msg.id, result: "result" in msg ? msg.result : undefined, error: "error" in msg ? msg.error : undefined }),
  onNotification: (method, params) => {
    if (method === "notifications/cancelled") log({ cancelled: (params as { requestId?: unknown } | undefined)?.requestId });
  },
});
