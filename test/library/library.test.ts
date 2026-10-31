// The sound library (D134) against a local stub of Openverse and Freesound, never the real APIs:
// the request each search sends (CC0 + CC BY only, commercial, no Wikimedia pronunciations, the
// filters), what comes back (other licences and non-https files dropped), the cache, the request
// limits (Uncut's own count, Openverse's headers, a 429), previews streamed through with a Range
// and nothing written, adds downloaded into media/ with credits and a SHA-256, the bundled
// sound effects copied, Freesound's key only in its header, and a real host refused in tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { allowBaseOverrides } from "../../apps/server/src/generate/providers.ts";
import { extensionOf, fileStem, getFollowing, isAudioType, Limiter, soundLibrary, OPENVERSE_PER_MINUTE } from "../../apps/server/src/library/library.ts";
import { getOnce, isPublicAddress, retryOnReset, urlProblem } from "../../apps/server/src/library/net.ts";
import { freesoundHit, freesoundLicense, freesoundUrl, openverseHit, openverseUrl } from "../../apps/server/src/library/sources.ts";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}
let stub: Server;
let base = "";
let seen: Array<Seen> = [];
let handler: (req: Seen, res: ServerResponse) => void = (_r, res) => res.end();
let root = "";
let mp3: Buffer;
const KEY = "fs-test-key-0123456789abcdef";

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-library-")));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.5",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    join(root, "tone.mp3"),
  ]);
  mp3 = readFileSync(join(root, "tone.mp3"));
  stub = createServer((req, res) => {
    const s = { method: req.method!, url: req.url!, headers: req.headers };
    seen.push(s);
    handler(s, res);
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  process.env.UNCUT_OPENVERSE_BASE = base;
  process.env.UNCUT_FREESOUND_BASE = base;
  allowBaseOverrides(true);
});
after(() => {
  stub.closeAllConnections();
  stub.close();
  delete process.env.UNCUT_OPENVERSE_BASE;
  delete process.env.UNCUT_FREESOUND_BASE;
  if (root) rmSync(root, { recursive: true, force: true });
});

const ovResult = (over: Record<string, unknown> = {}) => ({
  id: "eab8a6e2-0ac8-4615-9e0d-ebde30523783",
  title: "Deep Whoosh #1",
  foreign_landing_url: "https://freesound.org/people/Kinoton/sounds/351256",
  url: `${base}/files/whoosh.mp3`,
  creator: "Kinoton",
  creator_url: "https://freesound.org/people/Kinoton",
  license: "cc0",
  license_version: "1.0",
  license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
  provider: "freesound",
  filetype: "mp3",
  duration: 3155,
  tags: [{ name: "whoosh" }, { name: "swoosh" }],
  attribution: '"Deep Whoosh #1" by Kinoton is marked with CC0 1.0. To view the terms, visit https://creativecommons.org/publicdomain/zero/1.0/.',
  ...over,
});
const OV_PAGE = () => ({
  result_count: 240,
  page_count: 12,
  results: [
    ovResult(),
    ovResult({
      id: "b0000000-0000-0000-0000-000000000001",
      title: "Boom",
      license: "by",
      license_version: "4.0",
      license_url: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "",
    }),
    ovResult({ id: "c0000000-0000-0000-0000-000000000002", license: "by-nc" }),
    ovResult({ id: "d0000000-0000-0000-0000-000000000003", license: "sampling+" }),
    ovResult({ id: "e0000000-0000-0000-0000-000000000004", url: "http://cdn.example.com/x.mp3" }),
  ],
});

/** Answers searches with OV_PAGE (and the headers given) and serves the tone at /files/*, with ranges. */
function openverseStub(headers: Record<string, string> = {}) {
  handler = (req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === "/v1/audio/") {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      return res.end(JSON.stringify(OV_PAGE()));
    }
    if (url.pathname.startsWith("/v1/audio/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ovResult({ id: url.pathname.split("/")[3] })));
    }
    if (url.pathname.startsWith("/files/")) return serveTone(req, res);
    res.writeHead(404).end();
  };
}
function serveTone(req: Seen, res: ServerResponse) {
  const range = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ""));
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : mp3.length - 1;
    res.writeHead(206, { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${mp3.length}`, "content-length": String(end - start + 1) });
    return res.end(mp3.subarray(start, end + 1));
  }
  res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length) });
  res.end(mp3);
}

const probe = async (path: string) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }).trim());
const library = (over: Partial<Parameters<typeof soundLibrary>[0]> = {}) =>
  soundLibrary({ sfxDir: resolve("assets/sfx"), freesoundKey: async () => undefined, probeSeconds: probe, ...over });
const project = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("a search that times out gets one longer try; two timeouts say the source couldn't be reached", async () => {
  openverseStub();
  const realFetch = globalThis.fetch;
  let calls = 0;
  let hanging = 1;
  const hangUntilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    return hanging-- > 0 ? hangUntilAborted(init!.signal!) : realFetch(input, init);
  }) as typeof fetch;
  try {
    const found = await library({ apiMs: 50 }).search({ kind: "sfx", query: "retry once" });
    assert.equal(calls, 2);
    assert.ok(found.hits.length > 0);
    calls = 0;
    hanging = 2;
    await assert.rejects(library({ apiMs: 50 }).search({ kind: "sfx", query: "retry twice" }), /Couldn't reach Openverse/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("search URLs: CC0 and CC BY only, commercial, no Wikimedia, the filters mapped (D134)", () => {
  const ov = new URL(openverseUrl({ kind: "sfx", query: " whoosh " }));
  assert.equal(ov.origin + ov.pathname, `${base}/v1/audio/`);
  assert.equal(ov.searchParams.get("q"), "whoosh");
  assert.equal(ov.searchParams.get("license"), "cc0,by");
  assert.equal(ov.searchParams.get("license_type"), "commercial,modification");
  assert.equal(ov.searchParams.get("excluded_source"), "wikimedia_audio");
  assert.equal(ov.searchParams.get("mature"), "false");
  assert.equal(ov.searchParams.get("category"), null);
  const music = new URL(openverseUrl({ kind: "music", query: "lofi", songs: true, license: "cc0", length: "long", page: 3 }));
  assert.equal(music.searchParams.get("category"), "music");
  assert.equal(music.searchParams.get("license"), "cc0");
  assert.equal(music.searchParams.get("length"), "medium,long");
  assert.equal(music.searchParams.get("page"), "3");
  assert.equal(new URL(openverseUrl({ kind: "sfx", query: "x", length: "short" })).searchParams.get("length"), "shortest");
  const fs = new URL(freesoundUrl({ kind: "sfx", query: "bruh", length: "short" }));
  assert.equal(fs.pathname, "/apiv2/search/text/");
  assert.equal(fs.searchParams.get("filter"), '(license:"Creative Commons 0" OR license:"Attribution") duration:[0 TO 30]');
  assert.equal(fs.searchParams.get("token"), null, "the key never goes in the URL");
});

test("parsing: other licences, non-https files and junk are dropped; credits fields kept", () => {
  assert.equal(openverseHit(ovResult({ license: "by-nc" })), undefined);
  assert.equal(openverseHit(ovResult({ license: "sampling+" })), undefined);
  assert.equal(openverseHit(ovResult({ url: "http://cdn.example.com/a.mp3" })), undefined);
  assert.equal(openverseHit(ovResult({ url: "file:///etc/passwd" })), undefined);
  assert.equal(openverseHit(ovResult({ id: "../../x" })), undefined);
  const { hit, fileUrl } = openverseHit(ovResult())!;
  assert.equal(fileUrl, `${base}/files/whoosh.mp3`);
  assert.deepEqual(
    { ...hit, attribution: undefined },
    {
      source: "openverse",
      id: "eab8a6e2-0ac8-4615-9e0d-ebde30523783",
      title: "Deep Whoosh #1",
      creator: "Kinoton",
      creatorUrl: "https://freesound.org/people/Kinoton",
      landingUrl: "https://freesound.org/people/Kinoton/sounds/351256",
      provider: "freesound",
      license: "cc0",
      licenseVersion: "1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: undefined,
      seconds: 3.16,
      tags: ["whoosh", "swoosh"],
      filetype: "mp3",
    },
  );
  // No attribution from the source: made in Openverse's words.
  assert.equal(
    openverseHit(ovResult({ license: "by", license_version: "4.0", license_url: "https://creativecommons.org/licenses/by/4.0/", attribution: "" }))!.hit
      .attribution,
    '"Deep Whoosh #1" by Kinoton is licensed under CC BY 4.0. To view the terms, visit https://creativecommons.org/licenses/by/4.0/',
  );
  assert.deepEqual(freesoundLicense("http://creativecommons.org/publicdomain/zero/1.0/"), { license: "cc0", version: "1.0" });
  assert.deepEqual(freesoundLicense("https://creativecommons.org/licenses/by/3.0/"), { license: "by", version: "3.0" });
  assert.equal(freesoundLicense("https://creativecommons.org/licenses/by-nc/4.0/"), undefined);
  assert.equal(freesoundLicense("http://creativecommons.org/licenses/sampling+/1.0/"), undefined);
  const fs = freesoundHit({
    id: 534387,
    name: "Bruh Sound Effect #1",
    username: "Autellaem",
    license: "http://creativecommons.org/publicdomain/zero/1.0/",
    duration: 0.72,
    previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/534/534387_11868930-hq.mp3" },
    tags: ["bruh"],
    url: "https://freesound.org/people/Autellaem/sounds/534387/",
  })!;
  assert.equal(fs.hit.id, "534387");
  assert.equal(fs.fileUrl, "https://cdn.freesound.org/previews/534/534387_11868930-hq.mp3");
  assert.equal(fs.hit.license, "cc0");
  assert.equal(fileStem({ title: "Deep Whoosh #1.wav", creator: "Kinoton" }), "deep-whoosh-1-kinoton");
  assert.equal(fileStem({ title: "", creator: "" }), "sound");
  assert.equal(extensionOf({ filetype: "ogg" }, "https://x/y.mp3"), "ogg");
  assert.equal(extensionOf({}, "https://x/y.flac"), "flac");
  assert.equal(extensionOf({}, "https://x/y"), "mp3");
});

test("search: results parsed, then the same search answered from the cache (no request)", async () => {
  openverseStub({ "x-ratelimit-available-anon_burst": "19", "x-ratelimit-available-anon_sustained": "180" });
  seen = [];
  const lib = library();
  const r = await lib.search({ kind: "sfx", query: "whoosh" });
  assert.equal(seen.length, 1);
  assert.equal(r.source, "openverse");
  assert.equal(r.cached, false);
  assert.deepEqual(
    r.hits.map((h) => h.id),
    ["eab8a6e2-0ac8-4615-9e0d-ebde30523783", "b0000000-0000-0000-0000-000000000001"],
  );
  assert.deepEqual(r.left, { minute: 19, day: 180 });
  assert.equal(r.total, 240);
  assert.equal(r.pages, 12);
  const again = await lib.search({ kind: "sfx", query: "  Whoosh " });
  assert.equal(seen.length, 1, "cached");
  assert.equal(again.cached, true);
  await lib.search({ kind: "sfx", query: "whoosh", page: 2 });
  assert.equal(seen.length, 2, "another page is another request");
  await assert.rejects(lib.search({ kind: "sfx", query: "   " }), /Type what to search for/);
  await assert.rejects(lib.search({ kind: "sfx", query: "x".repeat(201) }), /at most 200/);
  assert.equal(seen.length, 2);
});

test("limits: Uncut stops at 20 a minute, honours Openverse's headers and a 429's Retry-After", async () => {
  openverseStub();
  let now = Date.parse("2026-10-14T10:00:00Z");
  const lib = library({ now: () => now });
  seen = [];
  for (let i = 0; i < OPENVERSE_PER_MINUTE; i++) assert.equal((await lib.search({ kind: "sfx", query: `q${i}` })).limit, undefined);
  const stopped = await lib.search({ kind: "sfx", query: "one more" });
  assert.equal(seen.length, OPENVERSE_PER_MINUTE, "the 21st never went out");
  assert.equal(stopped.limit?.scope, "minute");
  assert.equal(stopped.limit?.until, "2026-10-14T10:01:00.000Z");
  assert.equal((await lib.state()).limit?.scope, "minute");
  // A cached search still answers while limited (with the limit noted).
  const cached = await lib.search({ kind: "sfx", query: "q3" });
  assert.equal(cached.cached, true);
  assert.equal(cached.hits.length, 2);
  now += 61_000;
  assert.equal((await lib.search({ kind: "sfx", query: "later" })).limit, undefined);

  // Openverse says nothing is left today: the next search waits for tomorrow (UTC).
  openverseStub({ "x-ratelimit-available-anon_burst": "5", "x-ratelimit-available-anon_sustained": "0" });
  await lib.search({ kind: "sfx", query: "last" });
  const day = await lib.search({ kind: "sfx", query: "after" });
  assert.equal(day.limit?.scope, "day");
  assert.equal(day.limit?.until, "2026-10-15T00:00:00.000Z");

  // A 429 with Retry-After: limited for that long, without another request meanwhile.
  const lib2 = library({ now: () => now });
  handler = (_req, res) => {
    res.writeHead(429, { "retry-after": "42", "content-type": "application/json" });
    res.end("{}");
  };
  seen = [];
  const refused = await lib2.search({ kind: "music", query: "lofi" });
  assert.equal(refused.limit?.scope, "minute");
  assert.equal(Date.parse(refused.limit!.until) - now, 42_000);
  await lib2.search({ kind: "music", query: "ambient" });
  assert.equal(seen.length, 1);
  const limiter = new Limiter(2, 3, () => now);
  assert.equal(limiter.take(), undefined);
  assert.equal(limiter.take(), undefined);
  assert.equal(limiter.take()?.scope, "minute");
  now += 60_001;
  assert.equal(limiter.take(), undefined);
  assert.equal(limiter.take()?.scope, "day");
});

test("preview: a recent hit's file streamed through (Range passed on), nothing written; others refused", async () => {
  openverseStub();
  const lib = library();
  await lib.search({ kind: "sfx", query: "whoosh" });
  const before = readdirSync(root).sort();
  const res = (await lib.preview("openverse:eab8a6e2-0ac8-4615-9e0d-ebde30523783", undefined, new AbortController().signal))!;
  assert.equal(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(mp3));
  seen = [];
  const part = (await lib.preview("openverse:eab8a6e2-0ac8-4615-9e0d-ebde30523783", "bytes=10-19", new AbortController().signal))!;
  assert.equal(part.status, 206);
  assert.equal(seen[0]!.headers.range, "bytes=10-19");
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(mp3.subarray(10, 20)));
  assert.equal(
    await lib.preview("openverse:00000000-0000-0000-0000-000000000000", undefined, new AbortController().signal),
    undefined,
    "not from a search: not fetched",
  );
  assert.deepEqual(readdirSync(root).sort(), before, "nothing saved");
});

test("add: downloaded into media/ with credits and a SHA-256, probed; the same sound reuses its file", async () => {
  openverseStub();
  const lib = library({ now: () => Date.parse("2026-10-14T12:00:00Z") });
  await lib.search({ kind: "sfx", query: "whoosh" });
  const dir = project("add");
  const added = await lib.add("openverse:b0000000-0000-0000-0000-000000000001", dir);
  assert.equal(added.path, "media/boom-kinoton.mp3");
  const bytes = readFileSync(join(dir, added.path));
  assert.ok(bytes.equals(mp3));
  assert.ok(added.seconds > 1.4 && added.seconds < 1.7, String(added.seconds));
  assert.deepEqual(added.source, {
    module: "library.openverse",
    libraryId: "openverse:b0000000-0000-0000-0000-000000000001",
    title: "Boom",
    creator: "Kinoton",
    creatorUrl: "https://freesound.org/people/Kinoton",
    landingUrl: "https://freesound.org/people/Kinoton/sounds/351256",
    provider: "freesound",
    fileUrl: `${base}/files/whoosh.mp3`,
    license: "by",
    licenseVersion: "4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: '"Boom" by Kinoton is licensed under CC BY 4.0. To view the terms, visit https://creativecommons.org/licenses/by/4.0/',
    sha256: createHash("sha256").update(mp3).digest("hex"),
    downloaded: "2026-10-14T12:00:00.000Z",
  });
  assert.deepEqual(readdirSync(join(dir, "media")), ["boom-kinoton.mp3"], "no .part left");
  assert.equal((await lib.add("openverse:b0000000-0000-0000-0000-000000000001", dir)).path, "media/boom-kinoton.mp3", "an identical file is reused");
  // Not from a recent search: looked up by id (one request), then downloaded.
  const fresh = library();
  seen = [];
  const looked = await fresh.add("openverse:f0000000-0000-0000-0000-000000000005", dir);
  assert.equal(seen[0]!.url, "/v1/audio/f0000000-0000-0000-0000-000000000005/");
  assert.equal(looked.path, "media/deep-whoosh-1-kinoton.mp3");
  await assert.rejects(fresh.add("nope:1", dir), /isn't a library id/);
  // A bundled sound effect: copied, CC0 credits.
  const sfx = await lib.add("sfx:impact-boom", dir);
  assert.equal(sfx.path, "media/impact-boom.m4a");
  assert.ok(readFileSync(join(dir, sfx.path)).equals(readFileSync(resolve("assets/sfx/impact-boom.m4a"))));
  assert.equal(sfx.source.module, "library.bundled");
  assert.equal(sfx.source.license, "cc0");
  assert.equal(sfx.source.landingUrl, "https://freesound.org/people/XHALE303/sounds/535592/");
  await assert.rejects(lib.add("sfx:nope", dir), /no bundled sound/);
});

test("Freesound: needs the user's key, sends it only as the Authorization header, never in a message", async () => {
  seen = [];
  await assert.rejects(library().search({ kind: "sfx", query: "bruh", source: "freesound" }), /Add your Freesound key in Settings/);
  assert.equal(seen.length, 0);
  handler = (req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === "/apiv2/search/text/") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          count: 1,
          results: [
            {
              id: 534387,
              name: "Bruh Sound Effect #1",
              username: "Autellaem",
              license: "http://creativecommons.org/publicdomain/zero/1.0/",
              duration: 0.72,
              previews: { "preview-hq-mp3": `${base}/files/bruh.mp3` },
              tags: ["bruh"],
              url: "https://freesound.org/people/Autellaem/sounds/534387/",
            },
            {
              id: 2,
              name: "NC",
              username: "x",
              license: "https://creativecommons.org/licenses/by-nc/4.0/",
              previews: { "preview-hq-mp3": `${base}/files/nc.mp3` },
              url: "https://freesound.org/people/x/sounds/2/",
            },
          ],
        }),
      );
    }
    if (url.pathname.startsWith("/files/")) return serveTone(req, res);
    res.writeHead(404).end();
  };
  const lib = library({ freesoundKey: async () => KEY });
  assert.deepEqual((await lib.state()).sources, ["openverse", "freesound"]);
  const r = await lib.search({ kind: "sfx", query: "bruh", source: "freesound" });
  assert.deepEqual(
    r.hits.map((h) => h.id),
    ["534387"],
  );
  assert.equal(seen[0]!.headers.authorization, `Token ${KEY}`);
  assert.ok(!seen[0]!.url.includes(KEY));
  seen = [];
  const added = await lib.add("freesound:534387", project("fs"));
  assert.equal(added.source.module, "library.freesound");
  assert.equal(seen[0]!.headers.authorization, undefined, "the file request carries no key");
  handler = (_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: `Invalid token ${KEY}` }));
  };
  await assert.rejects(
    lib.search({ kind: "sfx", query: "boom", source: "freesound" }),
    (e: Error) => /didn't accept your key/.test(e.message) && !e.message.includes(KEY),
  );
});

test("tests never reach the real APIs: without the stub base the request is refused", async () => {
  const saved = process.env.UNCUT_OPENVERSE_BASE;
  delete process.env.UNCUT_OPENVERSE_BASE;
  try {
    await assert.rejects(library().search({ kind: "sfx", query: "whoosh" }), /Refused in a test run: api\.openverse\.org/);
  } finally {
    process.env.UNCUT_OPENVERSE_BASE = saved;
  }
  assert.ok(!existsSync(join(root, "media")));
});

test("review: replies can't point Uncut at this Mac or its network (https only, public addresses, every hop)", async () => {
  for (const bad of [
    "http://example.com/a.mp3",
    "https://127.0.0.1/a.mp3",
    "https://10.0.0.8/a",
    "https://192.168.1.2/a",
    "https://172.20.0.1/a",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/a",
    "https://[fc00::1]/a",
    "https://[fe80::1]/a",
    "https://[::ffff:127.0.0.1]/a",
    "https://100.64.0.1/a",
    "https://0.0.0.0/a",
  ])
    assert.ok(urlProblem(new URL(bad), false), bad);
  assert.equal(urlProblem(new URL("https://cdn.freesound.org/previews/1/1-hq.mp3"), false), undefined);
  assert.equal(urlProblem(new URL("https://93.184.216.34/a"), false), undefined);
  // In a test context only the loopback stubs.
  assert.match(urlProblem(new URL("https://cdn.freesound.org/x"), true)!, /Refused in a test run/);
  assert.equal(urlProblem(new URL(`${base}/x`), true), undefined);
  for (const ip of ["8.8.8.8", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd12::1", "::ffff:10.0.0.1", "not-an-ip"]) assert.equal(isPublicAddress(ip), false, ip);
  // D219: IPv4-compatible (::/96), mapped in hex, 6to4, site-local and local-use NAT64 addresses.
  for (const ip of ["::", "::7f00:1", "::a00:1", "::ffff:7f00:1", "2002:7f00:1::1", "2002:a9fe:a9fe::1", "fec0::1", "64:ff9b:1::a00:1"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["2a00:1450:4001::200e", "::ffff:5db8:d822"]) assert.equal(isPublicAddress(ip), true, ip);
  // Outside tests a name that resolves to this Mac is refused at connect time (the checked lookup).
  const port = new URL(base).port;
  await assert.rejects(
    getOnce(new URL(`https://localhost:${port}/files/x.mp3`), {}, new AbortController().signal, false),
    (e: NodeJS.ErrnoException) => e.code === "EPRIVATE",
  );
  // A redirect hop to a private address is refused too.
  openverseStub();
  const inner = handler;
  handler = (req, res) => (req.url.startsWith("/hop") ? res.writeHead(302, { location: "https://169.254.169.254/latest" }).end() : inner(req, res));
  await assert.rejects(getFollowing(`${base}/hop`, {}, new AbortController().signal), /Refused in a test run/);
});

test("review: only sound comes in: a page or JSON is refused, a file that doesn't probe is refused, previews pass audio only", async () => {
  assert.equal(isAudioType("audio/mpeg", true), true);
  assert.equal(isAudioType("application/ogg", true), true);
  assert.equal(isAudioType("application/octet-stream", true), false);
  assert.equal(isAudioType("application/octet-stream", false), true);
  for (const t of ["text/html; charset=utf-8", "application/json", "text/plain"]) assert.equal(isAudioType(t, false), false, t);
  let kind = "html";
  handler = (req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === "/v1/audio/") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(OV_PAGE()));
    if (kind === "html") return res.writeHead(200, { "content-type": "text/html" }).end("<html>login</html>");
    return res.writeHead(200, { "content-type": "audio/mpeg" }).end(Buffer.from("this is not an mp3 at all, just bytes"));
  };
  const lib = library();
  await lib.search({ kind: "sfx", query: "page" });
  const dir = project("types");
  await assert.rejects(lib.add("openverse:eab8a6e2-0ac8-4615-9e0d-ebde30523783", dir), /sent text\/html, not a sound/);
  assert.equal((await lib.preview("openverse:eab8a6e2-0ac8-4615-9e0d-ebde30523783", undefined, new AbortController().signal))!.status, 415);
  kind = "junk";
  await assert.rejects(lib.add("openverse:eab8a6e2-0ac8-4615-9e0d-ebde30523783", dir), /isn't a sound Uncut can read/);
  assert.deepEqual(readdirSync(join(dir, "media")), [], "nothing kept");
});

test("review: a trickling or silent server times out and frees the project's lock; the caller's abort stops a download", async () => {
  let mode = "trickle";
  handler = (req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === "/v1/audio/") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(OV_PAGE()));
    if (mode === "silent") return; // never answers
    if (mode === "ok") return serveTone(req, res);
    res.writeHead(200, { "content-type": "audio/mpeg" });
    const timer = setInterval(() => res.write(Buffer.from([0])), 50);
    res.on("close", () => clearInterval(timer));
  };
  const lib = library({ totalMs: 400 });
  await lib.search({ kind: "sfx", query: "slow" });
  const dir = project("slow");
  const started = Date.now();
  await assert.rejects(lib.add("openverse:eab8a6e2-0ac8-4615-9e0d-ebde30523783", dir), /took too long/);
  assert.ok(Date.now() - started < 3000);
  // The lock is free: the next add in the same project goes through.
  mode = "ok";
  assert.equal((await lib.add("openverse:b0000000-0000-0000-0000-000000000001", dir)).path, "media/boom-kinoton.mp3");
  // The agent turn's abort.
  mode = "trickle";
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  const t0 = Date.now();
  await assert.rejects(library().add("openverse:eab8a6e2-0ac8-4615-9e0d-ebde30523783", dir, stop.signal));
  assert.ok(Date.now() - t0 < 3000, "stopped at once (the id lookup too)");
  // No headers at all: getOnce gives up after its headers time.
  mode = "silent";
  await assert.rejects(getOnce(new URL(`${base}/files/silent.mp3`), {}, new AbortController().signal, true, 200), /no answer in 0\.2 s/);
  assert.deepEqual(readdirSync(join(dir, "media")), ["boom-kinoton.mp3"]);
});

test("review: a dropped kept-alive socket is retried once for a GET", async () => {
  let calls = 0;
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.equal(await retryOnReset(async () => (++calls === 1 ? Promise.reject(reset) : "ok")), "ok");
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    retryOnReset(async () => (++calls, Promise.reject(reset))),
    /hang up/,
  );
  assert.equal(calls, 2, "once more, not for ever");
  await assert.rejects(
    retryOnReset(async () => Promise.reject(new Error("other"))),
    /other/,
  );
});
