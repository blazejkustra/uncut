// Outside agents on the packaged app: off by default, the Settings toggle, each client's setup, and
// an official MCP client editing the project open in the window. Screenshot: test-output/external-mcp.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { clickWhenReady, freePort, launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const T = { skip, timeout: 180000 };

let root: string;
let app: LaunchedApp | undefined;

before(async () => {
  if (skip) return;
  await lockApps();
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-mcp-app-")));
});
after(async () => {
  await app?.close();
  if (skip) return;
  rmSync(root, { recursive: true, force: true });
  unlockApps();
});

test("turned on in Settings, a real client edits the open project", T, async () => {
  const data = join(root, "data");
  const port = await freePort();
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: data, UNCUT_MCP_PORT: String(port), HOME: root } });
  const { page } = app;
  await waitForWelcome(page);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" }), "off by default");
  assert.equal(existsSync(join(data, "external-mcp-token")), false);

  mkdirSync(join(root, "Movies"));
  await page.keyboard.down("Meta");
  await page.keyboard.press(",");
  await page.keyboard.up("Meta");
  await clickWhenReady(page, "[data-testid=settings-nav-app]");
  await clickWhenReady(page, "[data-testid=settings-mcp]");
  await page.waitForSelector("[data-testid=mcp-snippet]");
  const command = await page.$eval("[data-testid=mcp-snippet]", (el) => el.textContent ?? "");
  assert.match(command, new RegExp(`^claude mcp add --transport http --scope user uncut http://127\\.0\\.0\\.1:${port}/mcp --header "Authorization: Bearer `));
  const token = readFileSync(join(data, "external-mcp-token"), "utf8").trim();
  assert.ok(command.includes(token));
  assert.equal(statSync(join(data, "external-mcp-token")).mode & 0o777, 0o600);
  await page.$eval("[data-testid=mcp-new-token]", (el) => el.scrollIntoView({ block: "center" }));
  mkdirSync("test-output", { recursive: true });
  await page.screenshot({ path: "test-output/external-mcp.png" });

  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);

  const client = new Client({ name: "uncut-app-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
  const empty = await client.callTool({ name: "project_read", arguments: {} });
  assert.match(textOf(empty), /No project is open/);

  mkdirSync(join(root, "Trip"));
  const opened = await client.callTool({ name: "project_open", arguments: { path: join(root, "Trip") } });
  assert.notEqual(opened.isError, true, textOf(opened));
  await page.waitForSelector("[data-testid=timeline]", { timeout: 20000 });

  const read = JSON.parse(textOf(await client.callTool({ name: "project_read", arguments: {} })));
  const edit = await client.callTool({
    name: "timeline_edit",
    arguments: {
      baseRevision: read.revision,
      summary: "Add a title",
      ops: [
        {
          op: "insert_item",
          track: "text",
          item: { id: "hello", type: "text", start: 0, duration: 60, text: "Hello", transform: { x: 100, y: 100 }, style: { preset: "text.title", size: 120 } },
        },
      ],
    },
  });
  assert.notEqual(edit.isError, true, textOf(edit));
  await client.close();
  assert.ok(
    JSON.parse(readFileSync(join(root, "Movies", "Trip.uncut", "project.json"), "utf8")).tracks.some((t: any) => t.items?.some((i: any) => i.id === "hello")),
  );
});
