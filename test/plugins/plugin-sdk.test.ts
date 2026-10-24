// The plugin SDK (D102): the uncut.module/1 stdio contract as packages/plugin-sdk serves it, over
// in-memory streams: initialize (serverInfo from the manifest, the apiVersion), ping, tools/list
// (the manifest's agentTools), tools/call with the _meta folders and progress, a ToolError and a
// thrown error, an unknown tool and method, cancel (the signal aborts, no answer), the host's
// replies, junk lines. The host side (a real PluginHost running a plugin written with the SDK) is
// test/plugins/plugins.test.ts: the fake plugin is written with it. Discovery refuses a newer
// apiVersion with a sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { API_VERSION, serve, text, ToolError, type PluginManifest } from "@uncut/plugin-sdk";
import { checkManifest, discoverPlugins } from "../../apps/server/src/plugins/plugins.ts";

const manifest: PluginManifest = {
  manifest: "uncut.module/0",
  apiVersion: API_VERSION,
  id: "sdk.test",
  kind: "capture-source",
  name: "SDK test",
  version: "1.2.3",
  runtime: { type: "process", command: "node", args: ["server.ts"] },
  capabilities: ["media:write"],
  capture: { targets: ["desktop-screen"] },
  agentTools: [{ name: "sdk_echo", description: "Echo.", inputSchema: { type: "object" } }],
};

function harness(extra: Partial<Parameters<typeof serve>[0]> = {}) {
  const input = new PassThrough();
  const lines: Array<any> = [];
  let buffer = "";
  const output = {
    write(chunk: string) {
      buffer += chunk;
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    },
  };
  const server = serve({ manifest, tools: {}, input, output, exitOnClose: false, ...extra });
  const send = (msg: object) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const answer = async (id: number | string, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = lines.find((l) => l.id === id && ("result" in l || "error" in l));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    return undefined;
  };
  return { server, send, answer, lines, raw: (line: string) => input.write(line) };
}

test("the SDK serves the uncut.module/1 contract: initialize, ping, tools/list, calls with context and progress, errors, cancel", async () => {
  let cancelledSignal: AbortSignal | undefined;
  const notifications: Array<string> = [];
  const replies: Array<unknown> = [];
  const h = harness({
    tools: {
      sdk_echo: (args, ctx) => {
        ctx.progress(50, 100, "half");
        return text(`echo ${String(args.text)}`, {
          dirs: [ctx.projectDir ?? null, ctx.captureDir ?? null, ctx.flowsDir ?? null],
          uncut: { media: { path: "/x.mp4", source: { device: "d" } } },
        });
      },
      sdk_refuse: () => {
        throw new ToolError("Pass device.");
      },
      sdk_throw: () => {
        throw new Error("boom");
      },
      sdk_wait: (_args, ctx) =>
        new Promise((resolve) => {
          cancelledSignal = ctx.signal;
          ctx.signal.addEventListener("abort", () => resolve(text("too late")));
        }),
    },
    onError: (error) => text(`Failed: ${(error as Error).message}.`, undefined, true),
    onNotification: (method) => notifications.push(method),
    onReply: (msg) => replies.push(msg),
  });
  h.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "uncut", version: "0" } } });
  const init = await h.answer(1);
  assert.deepEqual(init.result.serverInfo, { name: "sdk.test", version: "1.2.3" });
  assert.equal(init.result._meta["uncut/apiVersion"], "uncut.module/1");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  h.send({ method: "notifications/initialized" });
  h.send({ id: 2, method: "ping" });
  assert.deepEqual((await h.answer(2)).result, {});
  h.send({ id: 3, method: "tools/list" });
  assert.deepEqual(
    (await h.answer(3)).result.tools.map((t: any) => t.name),
    ["sdk_echo"],
  );

  // Junk is ignored; the reader keeps going.
  for (const junk of ["null", "[]", "5", "not json", '{"id":null}', '{"jsonrpc":"2.0","id":99,"result":{}}']) h.raw(`${junk}\n`);
  h.send({
    id: 4,
    method: "tools/call",
    params: { name: "sdk_echo", arguments: { text: "hi" }, _meta: { progressToken: 4, "uncut/projectDir": "/p", "uncut/captureDir": "/p/media/captures" } },
  });
  const echo = await h.answer(4);
  assert.equal(echo.result.content[0].text, "echo hi");
  assert.deepEqual(echo.result.structuredContent.dirs, ["/p", "/p/media/captures", null]);
  assert.deepEqual(echo.result.structuredContent.uncut, { media: { path: "/x.mp4", source: { device: "d" } } });
  const progress = h.lines.find((l) => l.method === "notifications/progress");
  assert.deepEqual(progress.params, { progressToken: 4, progress: 50, total: 100, message: "half" });
  assert.ok(h.lines.indexOf(progress) < h.lines.indexOf(echo), "progress comes before the answer");

  // Without a progressToken, progress sends nothing.
  const before = h.lines.filter((l) => l.method === "notifications/progress").length;
  h.send({ id: 5, method: "tools/call", params: { name: "sdk_echo", arguments: { text: "x" } } });
  await h.answer(5);
  assert.equal(h.lines.filter((l) => l.method === "notifications/progress").length, before);

  h.send({ id: 6, method: "tools/call", params: { name: "sdk_refuse" } });
  assert.deepEqual((await h.answer(6)).result, { content: [{ type: "text", text: "Pass device." }], isError: true });
  h.send({ id: 7, method: "tools/call", params: { name: "sdk_throw" } });
  assert.deepEqual((await h.answer(7)).result, { content: [{ type: "text", text: "Failed: boom." }], isError: true });
  h.send({ id: 8, method: "tools/call", params: { name: "nope" } });
  assert.deepEqual((await h.answer(8)).result, { content: [{ type: "text", text: "No tool nope" }], isError: true });
  h.send({ id: 9, method: "resources/list" });
  assert.equal((await h.answer(9)).error.code, -32601);

  // Cancel: the signal aborts, and the call gets no answer.
  h.send({ id: 10, method: "tools/call", params: { name: "sdk_wait" } });
  while (!cancelledSignal) await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.server.running.has(10), true);
  h.send({ method: "notifications/cancelled", params: { requestId: 10, reason: "turn ended" } });
  assert.equal(await h.answer(10, 300), undefined);
  assert.equal(cancelledSignal.aborted, true);
  assert.equal(h.server.running.has(10), false);
  assert.ok(notifications.includes("notifications/cancelled") && notifications.includes("notifications/initialized"));

  // The host's answers to the plugin's own requests.
  h.server.send({ id: "p1", method: "ping" });
  h.send({ id: "p1", result: {} });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(replies.at(-1), { jsonrpc: "2.0", id: "p1", result: {} });
  h.server.close();
});

test("a manifest for a newer plugin format is refused with a sentence; missing apiVersion means uncut.module/1", async () => {
  const none = new Set<string>();
  const { apiVersion: _api, ...withoutApi } = manifest;
  assert.ok("manifest" in checkManifest(withoutApi, none));
  assert.ok("manifest" in checkManifest(manifest, none));
  const newer = checkManifest({ ...manifest, apiVersion: "uncut.module/2", somethingNew: true }, none);
  assert.ok("problem" in newer);
  assert.equal(
    newer.problem,
    "It's written for the plugin format uncut.module/2, which is newer than this Uncut understands (uncut.module/1). Update Uncut to use it.",
  );
  assert.equal(newer.id, "sdk.test");
  const bad = checkManifest({ ...manifest, apiVersion: "v1" }, none);
  assert.ok("problem" in bad && /module format/.test(bad.problem));

  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-sdk-")));
  try {
    mkdirSync(join(root, "future"));
    writeFileSync(join(root, "future/uncut.module.json"), JSON.stringify({ ...manifest, apiVersion: "uncut.module/7" }));
    const found = await discoverPlugins([{ source: "user", dir: root }], { moduleIds: none, toolNames: none });
    assert.equal(found.plugins.length, 0);
    assert.match(found.broken[0]!.problem, /uncut\.module\/7, which is newer than this Uncut understands/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
