// D208 on the server, offline (a stub on 127.0.0.1 stands in for Openverse and Freesound): a meme
// name searches for its free sound-alikes and says why; nothing found tries one variant; Freesound
// gets the alias's tag; hits come back ranked. The user's sound folders: added, indexed (hidden
// files, links and other types skipped), kept across restarts, a sound resolved only inside its
// folder, added into the project's media/ with its own type (copied, the original untouched),
// removed; a moved folder shows as missing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allowBaseOverrides } from "../../apps/server/src/generate/providers.ts";
import { soundFolders } from "../../apps/server/src/library/folders.ts";
import { soundLibrary } from "../../apps/server/src/library/library.ts";
import { freesoundUrl } from "../../apps/server/src/library/sources.ts";

let stub: Server;
let base = "";
let root = "";
let queries: Array<URLSearchParams> = [];
let answer: (q: URLSearchParams) => Array<Record<string, unknown>> = () => [];

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-d208-")));
  stub = createServer((req, res: ServerResponse) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/v1/audio/" || url.pathname === "/apiv2/search/text/") {
      queries.push(url.searchParams);
      const results = answer(url.searchParams);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ result_count: results.length, page_count: 1, count: results.length, results }));
    }
    res.writeHead(404).end();
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

let n = 0;
const ov = (title: string, license: "cc0" | "by", ms: number, tags: Array<string> = []) => ({
  id: `a0000000-0000-0000-0000-${String(++n).padStart(12, "0")}`,
  title,
  foreign_landing_url: `https://freesound.org/people/x/sounds/${n}`,
  url: `${base}/files/${n}.mp3`,
  creator: "someone",
  license,
  license_version: license === "cc0" ? "1.0" : "4.0",
  provider: "freesound",
  filetype: "mp3",
  duration: ms,
  tags: tags.map((name) => ({ name })),
  attribution: "",
});
const library = (dataDir = join(root, "data")) =>
  soundLibrary({ sfxDir: "assets/sfx", dataDir, freesoundKey: async () => "k", probeSeconds: async () => 1.25 });

test("a meme name searches for its free sound-alikes, says it's a clip, and ranks the answers", async () => {
  queries = [];
  answer = () => [
    ov("Forest birds", "cc0", 60000),
    ov("frustrated yell take 2", "by", 3000, ["yell"]),
    ov("vocals frustrated yell", "cc0", 3200, ["yell", "frustrated"]),
  ];
  const lib = library();
  const r = await lib.search({ kind: "sfx", query: "Faaahh" });
  assert.equal(queries.length, 1);
  assert.equal(queries[0]!.get("q"), "frustrated yell", "the alias's search went out, not the clip's name");
  assert.equal(r.searched, "frustrated yell");
  assert.equal(r.alias, "Fahh");
  assert.match(r.note!, /isn't free to use: these are free sound-alikes/);
  assert.deepEqual(
    r.hits.map((h) => h.title),
    ["vocals frustrated yell", "frustrated yell take 2", "Forest birds"],
    "match, then CC0, unrelated last",
  );
  // A plain search: sent as typed, no note.
  const plain = await lib.search({ kind: "sfx", query: "whoosh" });
  assert.equal(queries.at(-1)!.get("q"), "whoosh");
  assert.equal(plain.searched, undefined);
  assert.equal(plain.note, undefined);
});

test("nothing found: one variant is tried (held letters written twice), and said", async () => {
  queries = [];
  answer = (q) => (q.get("q") === "whoosh" ? [ov("Whoosh", "cc0", 900, ["whoosh"])] : []);
  const r = await library().search({ kind: "sfx", query: "whoooooosh" });
  assert.deepEqual(
    queries.map((q) => q.get("q")),
    ["whoooooosh", "whoosh"],
  );
  assert.equal(r.searched, "whoosh");
  assert.equal(r.hits.length, 1);
  // Found nothing either way: only the two requests, an empty answer.
  queries = [];
  answer = () => [];
  const none = await library().search({ kind: "sfx", query: "zzzzqx" });
  assert.equal(queries.length, 2);
  assert.equal(none.hits.length, 0);
  // Already plain: one request.
  queries = [];
  await library().search({ kind: "sfx", query: "qwerty sound" });
  assert.equal(queries.length, 1);
});

test("Freesound gets the alias's tag as a filter (with the key, never in the URL)", async () => {
  queries = [];
  answer = () => [];
  await library().search({ kind: "sfx", query: "dramatic boom", source: "freesound" });
  const filter = queries[0]!.get("filter")!;
  assert.match(filter, /tag:boom/);
  assert.match(filter, /license:"Creative Commons 0"/);
  assert.equal(queries[0]!.get("query"), "bass boom");
  assert.doesNotMatch(freesoundUrl({ kind: "sfx", query: "x" }, "bad tag;drop"), /tag:/, "only a plain tag goes in");
});

test("sound folders: added, indexed, kept, resolved only inside, added to a project with its own type, removed", async () => {
  const data = join(root, "folders-data");
  const sounds = join(root, "My Sounds");
  mkdirSync(join(sounds, "memes"), { recursive: true });
  mkdirSync(join(sounds, ".hidden"), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=0.6", join(sounds, "memes", "FAHHH meme.wav")]);
  writeFileSync(join(sounds, "big_whoosh.mp3"), "not really an mp3");
  writeFileSync(join(sounds, "notes.txt"), "text");
  writeFileSync(join(sounds, ".DS_Store"), "x");
  writeFileSync(join(sounds, ".hidden", "secret.wav"), "x");
  writeFileSync(join(sounds, "empty.wav"), "");
  const outside = join(root, "outside.wav");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(sounds, "link.wav"));

  const folders = soundFolders({ dataDir: data });
  assert.deepEqual(await folders.list(), []);
  await assert.rejects(folders.add("relative/path"), /full path/);
  await assert.rejects(folders.add(join(root, "nope")), /Can't open/);
  await assert.rejects(folders.add("/"), /not the whole disk/);
  const listed = await folders.add(sounds);
  assert.equal(listed.length, 1);
  const f = listed[0]!;
  assert.equal(f.name, "My Sounds");
  assert.deepEqual(f.sounds.map((s) => s.rel).sort(), ["big_whoosh.mp3", "memes/FAHHH meme.wav"], "audio files only: no hidden, link, empty or text file");
  assert.equal(f.sounds.find((s) => s.ext === "mp3")!.name, "big whoosh");
  assert.equal((await folders.add(sounds)).length, 1, "the same folder once");
  // Kept across a restart; ids stable.
  const again = soundFolders({ dataDir: data });
  const relisted = await again.list();
  assert.deepEqual(
    relisted.map((x) => x.sounds.map((s) => s.id).sort()),
    [f.sounds.map((s) => s.id).sort()],
  );
  // Resolved by id only, and only while inside the folder.
  const meme = f.sounds.find((s) => s.ext === "wav")!;
  assert.equal((await again.resolve(meme.id))!.path, join(sounds, "memes", "FAHHH meme.wav"));
  assert.equal(await again.resolve("../../etc/passwd"), undefined);
  assert.equal(await again.resolve("ffffffffffffffff"), undefined);
  const whoosh = f.sounds.find((s) => s.ext === "mp3")!;
  rmSync(join(sounds, "big_whoosh.mp3"));
  symlinkSync(outside, join(sounds, "big_whoosh.mp3"));
  assert.equal(await again.resolve(whoosh.id), undefined, "a file swapped for a link out of the folder isn't served");

  // Through the library: folder:<id> copies the file into media/ (its type kept), the original stays.
  const lib = library(data);
  const project = join(root, "Project.uncut");
  mkdirSync(project);
  const added = await lib.add(`folder:${meme.id}`, project);
  assert.equal(added.path, "media/fahhh-meme.wav");
  assert.equal(added.seconds, 1.25);
  assert.equal(added.source.module, "library.folder");
  assert.ok(!("license" in added.source), "no licence made up for the user's own file");
  assert.ok(readFileSync(join(project, added.path)).equals(readFileSync(join(sounds, "memes", "FAHHH meme.wav"))));
  assert.ok(existsSync(join(sounds, "memes", "FAHHH meme.wav")));
  assert.equal((await lib.add(`folder:${meme.id}`, project)).path, added.path, "an identical copy is reused");
  await assert.rejects(lib.add("folder:ffffffffffffffff", project), /isn't in your folders/);

  // Moved away: missing, nothing listed; removed: gone from the list, files untouched.
  renameSync(sounds, `${sounds} moved`);
  const moved = await lib.folders.list(true);
  assert.equal(moved[0]!.missing, true);
  assert.equal(moved[0]!.sounds.length, 0);
  assert.deepEqual(await lib.folders.remove(f.id), []);
  assert.ok(existsSync(join(`${sounds} moved`, "memes", "FAHHH meme.wav")));
  assert.deepEqual(JSON.parse(readFileSync(join(data, "sound-folders.json"), "utf8")), { folders: [] });
});
