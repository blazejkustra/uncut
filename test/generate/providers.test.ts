// The keyed generators (D99) against a local stub HTTP server, never a real API: each provider's
// request (path, method, JSON body, auth header with the key), its file, its errors (the key never
// in a message even when the reply echoes it), cancel mid-request, Veo's polling and download. Then
// the pure parts: markup detection, sizes, file names, key cleaning, and the key store (ciphertext
// only, 0600, through a stand-in for the desktop's safeStorage; memory only without one).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allowBaseOverrides,
  followRedirects,
  gptImage,
  guardedFetch,
  inTestContext,
  isTestRun,
  keySafe,
  MAX_REDIRECTS,
  providerBase,
  sound,
  veo,
  type KeyedGenerator,
} from "../../apps/server/src/generate/providers.ts";
import { cleanKey, keyStore, type Crypter } from "../../apps/server/src/generate/keys.ts";
import { extractMarkup, markupKind, svgPixels } from "../../apps/server/src/generate/svg.ts";
import { fileBase } from "../../apps/server/src/generate/generate.ts";

const KEY = "sk-test-not-a-real-key-0123456789";
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082",
  "hex",
);

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
let stub: Server;
let port = 0;
let seen: Array<Seen> = [];
let handler: (req: Seen, res: ServerResponse) => void = (_r, res) => res.end();
let root = "";

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-providers-")));
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(s);
      // No kept-alive sockets: "cancel" closes every connection, and a pooled one would then reset the next request.
      res.setHeader("connection", "close");
      handler(s, res);
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  port = (stub.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  process.env.UNCUT_OPENAI_BASE = base;
  process.env.UNCUT_GOOGLE_BASE = base;
  process.env.UNCUT_ELEVENLABS_BASE = base;
  process.env.UNCUT_VEO_POLL_MS = "20";
  allowBaseOverrides(true);
});
after(() => {
  stub.closeAllConnections();
  stub.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

let n = 0;
const ctx = (signal = new AbortController().signal) => {
  const statuses: Array<string> = [];
  const flags = { sent: false };
  return { key: KEY, outBase: join(root, `out-${++n}`), signal, status: (t: string) => statuses.push(t), statuses, sent: () => (flags.sent = true), flags };
};
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const leftovers = () => readdirSync(root).filter((f) => f.startsWith("out-"));

test("GPT Image: POST /v1/images/generations with the key as a Bearer token, the PNG saved, usage priced", async () => {
  seen = [];
  handler = (_r, res) => json(res, 200, { data: [{ b64_json: PNG.toString("base64") }], usage: { input_tokens: 20, output_tokens: 1584 } });
  const c = ctx();
  const out = await gptImage.generate({ kind: "image", prompt: "a phone on a desk", size: "1536x1024" }, c);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.url, "/v1/images/generations");
  assert.equal(seen[0]!.headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen[0]!.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0]!.body), { model: "gpt-image-2", prompt: "a phone on a desk", size: "1536x1024", quality: "medium", n: 1 });
  assert.equal(out.path, `${c.outBase}.png`);
  assert.equal(c.flags.sent, true, "sent() is called before the request");
  assert.deepEqual(readFileSync(out.path), PNG);
  assert.equal(out.model, "gpt-image-2");
  assert.equal(out.cost, Number((1584 * 30e-6 + 20 * 5e-6).toFixed(3)));
  assert.equal(gptImage.check({ kind: "image", prompt: "x", size: "999x999" }), "size must be one of 1536x1024, 1024x1024, 1024x1536.");
  assert.match(gptImage.check({ kind: "video", prompt: "x" })!, /stills only/);
});

test("errors say what went wrong without the key, even when the reply echoes it", async () => {
  for (const [g, input] of [
    [gptImage, { kind: "image", prompt: "x" }],
    [sound, { kind: "audio", prompt: "x" }],
    [veo, { kind: "video", prompt: "x" }],
  ] as Array<[KeyedGenerator, any]>) {
    handler = (_r, res) => json(res, 401, { error: { message: `Incorrect API key provided: ${KEY}` } });
    await assert.rejects(g.generate(input, ctx()), (e: Error) => {
      assert.match(e.message, /didn't accept your key \(401\)/);
      assert.ok(!e.message.includes(KEY), e.message);
      assert.match(e.message, /\[key\]/);
      return true;
    });
    handler = (_r, res) => json(res, 429, { detail: { message: "quota exceeded" } });
    await assert.rejects(g.generate(input, ctx()), /too many requests or no credit left \(429\): quota exceeded/);
    handler = (_r, res) => json(res, 500, { error: "boom" });
    await assert.rejects(g.generate(input, ctx()), /refused the request \(500\): boom/);
  }
  // Nothing reachable: a sentence, not a stack.
  process.env.UNCUT_OPENAI_BASE = "http://127.0.0.1:1";
  try {
    await assert.rejects(gptImage.generate({ kind: "image", prompt: "x" }, ctx()), /^Error: Couldn't reach OpenAI/);
  } finally {
    process.env.UNCUT_OPENAI_BASE = `http://127.0.0.1:${port}`;
  }
  // A reply without a picture.
  handler = (_r, res) => json(res, 200, { data: [] });
  await assert.rejects(gptImage.generate({ kind: "image", prompt: "x" }, ctx()), /no picture in it/);
  assert.deepEqual(
    leftovers().filter((f) => !existsSync(join(root, f)) || statSync(join(root, f)).size === 0),
    [],
  );
});

test("Sound effects: POST /v1/sound-generation with xi-api-key, the length and model, the MP3 saved", async () => {
  seen = [];
  const mp3 = Buffer.alloc(4096, 7);
  handler = (_r, res) => {
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(mp3);
  };
  const c = ctx();
  const out = await sound.generate({ kind: "audio", prompt: "a soft whoosh", seconds: 2 }, c);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.url, "/v1/sound-generation?output_format=mp3_44100_128");
  assert.equal(seen[0]!.headers["xi-api-key"], KEY);
  assert.equal(seen[0]!.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(seen[0]!.body), { text: "a soft whoosh", duration_seconds: 2, model_id: "eleven_text_to_sound_v2" });
  assert.equal(out.path, `${c.outBase}.mp3`);
  assert.deepEqual(readFileSync(out.path), mp3);
  assert.equal(out.cost, 0.02);
  assert.match(sound.check({ kind: "audio", prompt: "x", seconds: 31 })!, /0\.5 to 30/);
  // A JSON body with 200 isn't a sound.
  handler = (_r, res) => json(res, 200, { ok: true });
  await assert.rejects(sound.generate({ kind: "audio", prompt: "x" }, ctx()), /text instead of a sound/);
});

test("Veo: predictLongRunning with x-goog-api-key, polls the operation until done, downloads the video with the key", async () => {
  seen = [];
  let polls = 0;
  const mp4 = Buffer.alloc(10_000, 3);
  handler = (r, res) => {
    if (r.url === "/v1beta/models/veo-3.1-generate-preview:predictLongRunning")
      return json(res, 200, { name: "models/veo-3.1-generate-preview/operations/op123" });
    if (r.url === "/v1beta/models/veo-3.1-generate-preview/operations/op123") {
      polls++;
      return json(
        res,
        200,
        polls < 3
          ? { name: "x", done: false }
          : {
              name: "x",
              done: true,
              response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `http://127.0.0.1:${port}/download/v.mp4?alt=media` } }] } },
            },
      );
    }
    if (r.url === "/download/v.mp4?alt=media") {
      res.writeHead(200, { "content-type": "video/mp4" });
      return res.end(mp4);
    }
    json(res, 404, { error: { message: "no route" } });
  };
  const c = ctx();
  const out = await veo.generate({ kind: "video", prompt: "a drone shot over a lake", size: "9:16", seconds: 6 }, c);
  assert.equal(seen[0]!.method, "POST");
  assert.deepEqual(JSON.parse(seen[0]!.body), {
    instances: [{ prompt: "a drone shot over a lake" }],
    parameters: { aspectRatio: "9:16", durationSeconds: 6, resolution: "720p" },
  });
  for (const s of seen) assert.equal(s.headers["x-goog-api-key"], KEY, s.url);
  assert.equal(polls, 3);
  assert.equal(seen.at(-1)!.url, "/download/v.mp4?alt=media");
  assert.deepEqual(readFileSync(out.path), mp4);
  assert.equal(out.path, `${c.outBase}.mp4`);
  assert.equal(out.cost, 2.4);
  assert.equal(veo.estimate({ kind: "video", prompt: "x" }), 1.6);
  assert.ok(c.statuses.some((t) => /Veo is making the video/.test(t)));
  // The operation's own error.
  handler = (r, res) =>
    r.url.endsWith(":predictLongRunning")
      ? json(res, 200, { name: "models/m/operations/bad", done: true, error: { message: `blocked ${KEY}` } })
      : json(res, 404, {});
  await assert.rejects(veo.generate({ kind: "video", prompt: "x" }, ctx()), (e: Error) => /Veo couldn't make it: blocked \[key\]/.test(e.message));
  // A link to another host gets no key.
  seen = [];
  const other = createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: "" });
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(mp4);
  });
  await new Promise<void>((r) => other.listen(0, "localhost", r));
  const otherPort = (other.address() as { port: number }).port;
  handler = (r, res) =>
    r.url.endsWith(":predictLongRunning")
      ? json(res, 200, {
          name: "models/m/operations/ok",
          done: true,
          response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `https://localhost:${otherPort}/v.mp4` } }] } },
        })
      : json(res, 404, {});
  // https to a plain-http stub fails to connect: the point is no key went anywhere but the API.
  await assert.rejects(veo.generate({ kind: "video", prompt: "x" }, ctx()));
  other.close();
  assert.ok(seen.every((s) => s.headers["x-goog-api-key"] === undefined || s.url.startsWith("/v1beta")));
});

test("cancel: an abort mid-request rejects and leaves no file; mid-poll too", async () => {
  handler = () => {}; // never answers
  const a = new AbortController();
  const c = ctx(a.signal);
  setTimeout(() => a.abort(), 150);
  await assert.rejects(gptImage.generate({ kind: "image", prompt: "x" }, c));
  assert.equal(existsSync(`${c.outBase}.png`), false);
  // A sound whose body never ends.
  handler = (_r, res) => {
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.write(Buffer.alloc(1000, 1));
  };
  const b = new AbortController();
  const c2 = ctx(b.signal);
  setTimeout(() => b.abort(), 200);
  await assert.rejects(sound.generate({ kind: "audio", prompt: "x" }, c2));
  assert.equal(existsSync(`${c2.outBase}.mp3`), false);
  // Veo while it polls.
  handler = (r, res) => (r.url.endsWith(":predictLongRunning") ? json(res, 200, { name: "models/m/operations/slow" }) : json(res, 200, { done: false }));
  const v = new AbortController();
  setTimeout(() => v.abort(), 120);
  await assert.rejects(veo.generate({ kind: "video", prompt: "x" }, ctx(v.signal)));
  stub.closeAllConnections();
});

test("review fixes: base URLs only in test runs, keys never over plain http, redirects followed by hand without the key", async () => {
  // Overrides count only in a test run (the packaged app under UNCUT_CDP, or the server without the keys pipe).
  assert.equal(isTestRun({}, 4), false);
  assert.equal(isTestRun({ UNCUT_CDP: "9222" }, 4), true);
  assert.equal(isTestRun({}, undefined), true);
  // Outside a test run an override that's set fails closed (never the real host instead); unset, the real host.
  allowBaseOverrides(false);
  try {
    assert.throws(
      () => providerBase("UNCUT_OPENAI_BASE", "https://api.openai.com"),
      /UNCUT_OPENAI_BASE is set, but base-URL overrides only count in test runs/,
    );
    await assert.rejects(gptImage.generate({ kind: "image", prompt: "x" }, ctx()), /only count in test runs; nothing was sent/);
    assert.equal(providerBase("UNCUT_NOT_SET_BASE", "https://api.openai.com"), "https://api.openai.com");
  } finally {
    allowBaseOverrides(true);
  }
  // And in any test context nothing may leave this machine, whatever the URL.
  assert.equal(inTestContext(), true, "node --test sets NODE_TEST_CONTEXT");
  assert.equal(inTestContext({}), false);
  assert.equal(inTestContext({ UNCUT_TEST_BACKGROUND: "1" }), true);
  assert.equal(inTestContext({ UNCUT_CDP: "9222" }), true);
  for (const url of [
    "https://api.openai.com/v1/images/generations",
    "https://generativelanguage.googleapis.com/v1beta/x",
    "https://api.elevenlabs.io/v1/sound-generation",
    "http://192.0.2.1/x",
  ]) {
    await assert.rejects(guardedFetch(url, {}), /Refused in a test run: .* isn't this machine/, url);
  }
  assert.equal(providerBase("UNCUT_OPENAI_BASE", "https://api.openai.com"), `http://127.0.0.1:${port}`);
  // A key goes over https, or plain http only to a loopback stub.
  assert.equal(keySafe(new URL("https://api.openai.com/v1")), true);
  assert.equal(keySafe(new URL("http://127.0.0.1:9/v1")), true);
  assert.equal(keySafe(new URL("http://localhost:9/v1")), true);
  assert.equal(keySafe(new URL("http://api.example.com/v1")), false);
  process.env.UNCUT_ELEVENLABS_BASE = "http://192.0.2.1";
  try {
    const c = ctx();
    await assert.rejects(sound.generate({ kind: "audio", prompt: "x" }, c), /isn't https, so your key wasn't sent/);
    assert.equal(c.flags.sent, false, "nothing was sent, so nothing can be billed");
  } finally {
    process.env.UNCUT_ELEVENLABS_BASE = `http://127.0.0.1:${port}`;
  }
  // The API's own redirect to another origin ([::1] vs 127.0.0.1): followed by hand, no key there.
  const mp4 = Buffer.alloc(2000, 5);
  const other = createServer((req, res) => {
    seen.push({ method: req.method!, url: `other:${req.url}`, headers: req.headers, body: "" });
    if (req.url === "/back") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/files/final.mp4` });
      return res.end();
    }
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(mp4);
  });
  await new Promise<void>((r) => other.listen(0, "::1", r));
  const otherPort = (other.address() as { port: number }).port;
  try {
    seen = [];
    handler = (r, res) => {
      if (r.url === "/files/start.mp4") {
        res.writeHead(307, { location: `http://[::1]:${otherPort}/v.mp4` });
        return res.end();
      }
      json(res, 404, {});
    };
    const res = await followRedirects(
      "Google",
      new URL(`http://127.0.0.1:${port}/files/start.mp4`),
      `http://127.0.0.1:${port}`,
      { "x-goog-api-key": KEY },
      new AbortController().signal,
      KEY,
    );
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), mp4);
    assert.equal(seen[0]!.headers["x-goog-api-key"], KEY, "the API's own origin gets the key");
    assert.equal(seen[1]!.url, "other:/v.mp4");
    assert.equal(seen[1]!.headers["x-goog-api-key"], undefined, "another origin never does");
    // Back to the API's origin after another one: the key is sent again only there.
    seen = [];
    handler = (r, res) => {
      if (r.url === "/files/hop.mp4") {
        res.writeHead(302, { location: `http://[::1]:${otherPort}/back` });
        return res.end();
      }
      if (r.url === "/files/final.mp4") {
        res.writeHead(200, { "content-type": "video/mp4" });
        return res.end(mp4);
      }
      json(res, 404, {});
    };
    await followRedirects(
      "Google",
      new URL(`http://127.0.0.1:${port}/files/hop.mp4`),
      `http://127.0.0.1:${port}`,
      { "x-goog-api-key": KEY },
      new AbortController().signal,
      KEY,
    );
    assert.deepEqual(
      seen.map((x) => [x.url, x.headers["x-goog-api-key"] ?? null]),
      [
        ["/files/hop.mp4", KEY],
        ["other:/back", null],
        ["/files/final.mp4", KEY],
      ],
    );
    // More than MAX_REDIRECTS hops: refused.
    let hops = 0;
    handler = (_r, res) => {
      hops++;
      res.writeHead(302, { location: `/files/loop-${hops}.mp4` });
      res.end();
    };
    await assert.rejects(
      followRedirects("Google", new URL(`http://127.0.0.1:${port}/files/loop.mp4`), `http://127.0.0.1:${port}`, {}, new AbortController().signal, KEY),
      /redirected more than 5 times/,
    );
    assert.equal(hops, MAX_REDIRECTS + 1);
    // A redirect to plain http elsewhere: refused before any request.
    handler = (_r, res) => {
      res.writeHead(302, { location: "http://example.com/v.mp4" });
      res.end();
    };
    await assert.rejects(
      followRedirects("Google", new URL(`http://127.0.0.1:${port}/x`), `http://127.0.0.1:${port}`, {}, new AbortController().signal, KEY),
      /isn't https/,
    );
  } finally {
    other.closeAllConnections();
    other.close();
  }
});

test("markup, sizes and file names", () => {
  assert.equal(markupKind('<svg viewBox="0 0 10 10"></svg>'), "svg");
  assert.equal(markupKind('<?xml version="1.0"?>\n<svg></svg>'), "svg");
  assert.equal(markupKind("<!doctype html><html><body></body></html>"), "html");
  assert.equal(markupKind("<div>hi</div>"), "html");
  assert.equal(markupKind("Sure! Here you go"), undefined);
  assert.equal(extractMarkup('Here:\n```svg\n<svg viewBox="0 0 1 1"><rect/></svg>\n```\nEnjoy'), '<svg viewBox="0 0 1 1"><rect/></svg>');
  assert.equal(extractMarkup("Text <svg><g/></svg> after"), "<svg><g/></svg>");
  assert.equal(extractMarkup("<!doctype html><html><script>render=1</script></html>"), "<!doctype html><html><script>render=1</script></html>");
  assert.equal(extractMarkup("I can't draw that."), undefined);
  assert.deepEqual(svgPixels(undefined, { width: 1080, height: 1350 }), { width: 1080, height: 1350 });
  assert.deepEqual(svgPixels("canvas", { width: 1080, height: 1350 }), { width: 1080, height: 1350 });
  assert.deepEqual(svgPixels("1920x1080", { width: 1, height: 1 }), { width: 1920, height: 1080 });
  assert.equal(svgPixels("9000x10", { width: 1, height: 1 }), undefined);
  assert.equal(svgPixels("big", { width: 1, height: 1 }), undefined);
  const at = new Date(2026, 9, 13, 10, 15, 0);
  assert.equal(fileBase({ prompt: "A neon city skyline at night, rain!" }, at), "a-neon-city-skyline-at 20261013-101500");
  assert.equal(fileBase({ prompt: "x", name: "Logo intro.png" }, at), "Logo intro");
  assert.equal(fileBase({ prompt: "!!!" }, at), "generated 20261013-101500");
  // Names that are only dots (or start with them) never become "." or "..": the prompt is used instead.
  for (const name of ["..", ".", "...", " .. ", "../x", ".hidden"]) {
    const stem = fileBase({ prompt: "sun", name }, at);
    assert.ok(!stem.startsWith(".") && stem !== "" && !stem.includes("/"), `${name} → ${stem}`);
  }
  assert.equal(fileBase({ prompt: "sun", name: ".." }, at), "sun 20261013-101500");
  assert.equal(fileBase({ prompt: "sun", name: ".hidden" }, at), "hidden");
  assert.equal(cleanKey("  sk-abc \n"), "sk-abc");
  assert.deepEqual(cleanKey("   "), { problem: "Paste the key first." });
  assert.deepEqual(cleanKey("two words"), { problem: "That doesn't look like an API key (one line, no spaces)." });
});

test("the key store: ciphertext only in keys.json (0600) through safeStorage's stand-in; memory without it", async () => {
  const calls: Array<string> = [];
  const crypter: Crypter = {
    encrypt: async (text) => (calls.push("encrypt"), Buffer.from(`enc:${[...text].reverse().join("")}`).toString("base64")),
    decrypt: async (data) => (calls.push("decrypt"), [...Buffer.from(data, "base64").toString().slice(4)].reverse().join("")),
  };
  const file = join(root, "data", "keys.json");
  const store = keyStore({ file, crypter });
  assert.deepEqual(
    (await store.list()).map((k) => [k.provider, k.set, k.storage]),
    [
      ["openai", false, "keychain"],
      ["google", false, "keychain"],
      ["elevenlabs", false, "keychain"],
      ["freesound", false, "keychain"],
    ],
  );
  await store.set("openai", KEY);
  await store.set("elevenlabs", "el-key-123");
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(KEY) && !text.includes("el-key-123"), text);
  assert.deepEqual(Object.keys(JSON.parse(text).keys), ["openai", "elevenlabs"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await store.has("openai"), true);
  assert.equal(await store.has("google"), false);
  // Listing never decrypts (no Keychain prompt just to show Settings).
  calls.length = 0;
  await store.list();
  assert.deepEqual(calls, []);
  assert.equal(await store.get("openai"), KEY);
  assert.deepEqual(calls, ["decrypt"]);
  await store.remove("openai");
  assert.equal(await store.has("openai"), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).keys), ["elevenlabs"]);
  assert.deepEqual(readdirSync(join(root, "data")), ["keys.json"], "no temp files left");
  // A refusing Keychain is an error, and nothing is written.
  const refusing = keyStore({
    file: join(root, "data2", "keys.json"),
    crypter: { encrypt: async () => Promise.reject(new Error("denied")), decrypt: async () => "" },
  });
  await assert.rejects(refusing.set("google", "g-key"), /denied/);
  assert.equal(existsSync(join(root, "data2", "keys.json")), false);
  // Without the desktop: memory only, nothing on disk.
  const mem = keyStore({ file: join(root, "data3", "keys.json"), crypter: undefined });
  await mem.set("google", "g-key");
  assert.equal(await mem.get("google"), "g-key");
  assert.equal((await mem.list()).find((k) => k.provider === "google")!.storage, "memory");
  assert.equal(existsSync(join(root, "data3")), false);
});
