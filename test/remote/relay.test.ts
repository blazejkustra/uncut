// Phase 9 (D106): the desktop's loopback relay to a remote server, the environments list and the
// SSH helper's commands. The relay swaps its own token for the remote's (in a header, never in a
// URL), strips Origin and cookies, answers preflights, refuses web origins, and says why the
// remote can't be reached. Plain Node: no Electron, no network beyond 127.0.0.1.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { makeEnvironmentStore, normalizeServerUrl, parsePairing } from "../../apps/desktop/src/environments.ts";
import { pingServer, startRelay } from "../../apps/desktop/src/relay.ts";
import { notEncrypted } from "../../apps/web/src/state/remoteUrl.ts";
import { sshCommands, validSshTarget } from "../../apps/web/src/state/ssh.ts";
import { BUNDLE, MEDIA, connect, killAll, openSocket, startServer } from "../helpers/server.ts";

const skipServer = existsSync(BUNDLE) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";
const root = mkdtempSync(join(tmpdir(), "uncut-relay-"));
after(() => {
  killAll();
  rmSync(root, { recursive: true, force: true });
});

/** A stand-in upstream that records what reached it. */
async function recorder() {
  const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(req.url?.startsWith("/denied") ? 401 : 200, { "content-type": "text/plain", "set-cookie": "a=b" }).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { seen, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("the relay: its token becomes the remote's Bearer header; Origin, cookies and Referer never travel; others' requests go on as they are", async () => {
  const up = await recorder();
  const relay = await startRelay({ target: `http://127.0.0.1:${up.port}`, token: "REMOTE-SECRET-TOKEN" });
  const a = await fetch(`${relay.httpBase}/media/file/m1?token=${relay.token}&v=3`, { headers: { origin: "file://", cookie: "c=d", referer: "file:///x" } });
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("set-cookie"), null, "no cookie comes back either");
  const first = up.seen[0]!;
  assert.equal(first.url, "/media/file/m1?v=3", "the relay token is out of the URL");
  assert.equal(first.headers.authorization, "Bearer REMOTE-SECRET-TOKEN");
  assert.equal(first.headers.origin, undefined);
  assert.equal(first.headers.cookie, undefined);
  assert.equal(first.headers.referer, undefined);
  assert.equal(first.headers.host, `127.0.0.1:${up.port}`);
  // Without the relay's token (a graphic's own secret, or anything else on this Mac): unchanged, no header.
  await fetch(`${relay.httpBase}/media/graphic/g.html?token=graphic-secret`);
  assert.equal(up.seen[1]!.url, "/media/graphic/g.html?token=graphic-secret");
  assert.equal(up.seen[1]!.headers.authorization, undefined);
  const count = up.seen.length;
  assert.equal((await fetch(`${relay.httpBase}/api/ping?token=wrong`)).status, 401, "a wrong relay token is refused here");
  assert.equal((await fetch(`${relay.httpBase}/api/ping`)).status, 401);
  assert.equal(up.seen.length, count, "the remote never sees them");
  // A web page's origin is refused here; a preflight is answered here.
  assert.equal((await fetch(`${relay.httpBase}/api/ping?token=${relay.token}`, { headers: { origin: "https://evil.example" } })).status, 403);
  const pre = await fetch(`${relay.httpBase}/api/upload`, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  // A POST body goes through (the renderer's upload).
  await fetch(`${relay.httpBase}/api/upload?name=a.mp4&token=${relay.token}`, {
    method: "POST",
    body: "bytes",
    headers: { "content-type": "application/octet-stream" },
  });
  assert.equal(up.seen.at(-1)!.body, "bytes");
  assert.equal(up.seen.at(-1)!.url, "/api/upload?name=a.mp4");
  // A refused token, then the remote gone: the relay says why.
  await fetch(`${relay.httpBase}/denied?token=${relay.token}`);
  assert.match(relay.problem() ?? "", /refused the token/);
  await up.close();
  assert.equal((await fetch(`${relay.httpBase}/api/ping?token=${relay.token}`)).status, 502);
  assert.match(relay.problem() ?? "", /Nothing is listening at 127\.0\.0\.1:\d+/);
  await relay.close();
});

test("the relay carries the WebSocket RPC to a real headless server, and pingServer tests a connection", { skip: skipServer, timeout: 30000 }, async (t) => {
  const s = await startServer({ args: ["--port", "0", "--data-dir", join(root, "srv")], env: { UNCUT_DATA_DIR: "" }, captureStderr: true });
  s.ready.token = readFileSync(join(root, "srv", "server-token"), "utf8").trim();
  const base = `http://127.0.0.1:${s.ready.port}`;
  const relay = await startRelay({ target: base, token: s.ready.token });
  t.after(() => relay.close());
  const client = await connect(relay.port, relay.token);
  const hello = await client.ok("server.hello", {});
  assert.equal(typeof hello.version, "string");
  assert.equal(relay.problem(), undefined);
  client.close();
  // Without the relay's token the relay refuses; the relay's token means nothing to the remote.
  await assert.rejects(openSocket(`ws://127.0.0.1:${relay.port}/ws`));
  await assert.rejects(openSocket(`ws://127.0.0.1:${relay.port}/ws?token=${s.ready.token}`), "the remote's own token isn't the relay's");
  await assert.rejects(openSocket(`ws://127.0.0.1:${s.ready.port}/ws?token=${relay.token}`));
  const ok = await pingServer(base, s.ready.token);
  assert.equal(ok.ok, true);
  const bad = await pingServer(base, "not-the-token");
  assert.deepEqual(bad, { ok: false, message: "The server refused the token. Check it in Settings, Environments." });
  await relay.close();
  await s.stop();
  const gone = await pingServer(base, s.ready.token);
  assert.equal(gone.ok, false);
  assert.match((gone as { message: string }).message, /Nothing is listening/);
});

test("server addresses and the pairing line", () => {
  assert.deepEqual(normalizeServerUrl("studio.local:8790"), { url: "http://studio.local:8790" });
  assert.deepEqual(normalizeServerUrl(" ws://10.0.0.5:8790/ws "), { url: "http://10.0.0.5:8790" });
  assert.deepEqual(normalizeServerUrl("https://uncut.example.ts.net/"), { url: "https://uncut.example.ts.net" });
  assert.ok("problem" in normalizeServerUrl("ftp://x"));
  assert.ok("problem" in normalizeServerUrl("http://me:pw@x:1"));
  assert.ok("problem" in normalizeServerUrl(""));
  assert.deepEqual(parsePairing("uncut://pair?url=http%3A%2F%2F127.0.0.1%3A8790&token=abc_DEF-123"), { url: "http://127.0.0.1:8790", token: "abc_DEF-123" });
  assert.equal(parsePairing("http://x"), undefined);
});

test("the environments list: tokens stored encrypted, the file 0600, Local always there, removing the active one goes back to Local", () => {
  const dir = join(root, "envs");
  mkdirSync(dir, { recursive: true });
  const crypt = { encrypt: (t: string) => `enc:${Buffer.from(t).toString("hex")}`, decrypt: (d: string) => Buffer.from(d.slice(4), "hex").toString() };
  const store = makeEnvironmentStore(dir, crypt);
  assert.deepEqual(store.list(), { active: "local", environments: [{ id: "local", name: "This Mac", kind: "local" }] });
  const token = "t0ken_with-enough-length";
  const added = store.add({ name: "  Studio   Mac ", url: "studio.local:8790", token });
  assert.ok("id" in added);
  const raw = readFileSync(join(dir, "environments.json"), "utf8");
  assert.ok(!raw.includes(token), "the token isn't in the file as text");
  assert.equal(statSync(join(dir, "environments.json")).mode & 0o777, 0o600);
  assert.deepEqual(store.secret(added.id), { url: "http://studio.local:8790", token });
  assert.equal(store.list().environments[1]!.name, "Studio Mac");
  // The pairing line fills both.
  const paired = store.add({ name: "", url: "uncut://pair?url=http%3A%2F%2F127.0.0.1%3A9000&token=paired_token_1234567", token: "" });
  assert.ok("id" in paired);
  assert.equal(store.list().environments[2]!.name, "127.0.0.1");
  assert.ok("problem" in store.add({ name: "x", url: "x:1", token: "short" }));
  assert.ok(store.setActive(added.id));
  assert.equal(store.active().id, added.id);
  assert.ok(store.rename(added.id, "Studio"));
  assert.ok(!store.setActive("env-nope"));
  assert.ok(store.remove(added.id));
  assert.equal(store.active().id, "local");
  assert.equal(store.secret("local"), undefined);
});

test("Connect over SSH: the commands, quoted, never run", () => {
  assert.ok(validSshTarget("me@studio.local"));
  assert.ok(!validSshTarget("me@studio; rm -rf ~"));
  assert.ok(!validSshTarget("-oProxyCommand=x"));
  const c = sshCommands({ target: "me@studio.local", remotePort: 8790, localPort: 9790 });
  assert.equal(c.tunnel, "ssh -N -L 9790:127.0.0.1:8790 me@studio.local");
  assert.equal(c.url, "http://127.0.0.1:9790");
  assert.match(
    c.start,
    /^ssh me@studio\.local 'ELECTRON_RUN_AS_NODE=1 .*Uncut\.app\/Contents\/MacOS\/Uncut.*server\.mjs.* --port 8790 --data-dir "\$HOME\/Library\/Application Support\/Uncut Server"'$/,
  );
});

test("Not encrypted: plain http beyond loopback and Tailscale", () => {
  for (const u of ["http://192.168.1.20:8790", "studio.local:8790", "uncut://pair?url=http%3A%2F%2F10.0.0.5%3A8790&token=abc"]) assert.ok(notEncrypted(u), u);
  for (const u of [
    "http://127.0.0.1:8790",
    "localhost:8790",
    "https://studio.example.com",
    "http://100.101.102.103:8790",
    "http://studio.tail1234.ts.net:8790",
    "uncut://pair?url=http%3A%2F%2F127.0.0.1%3A8790&token=abc",
    "",
  ])
    assert.ok(!notEncrypted(u), u);
});
