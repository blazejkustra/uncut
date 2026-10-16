// Issue #32 (D208) on the packaged app, run invisibly, through the UI only, with Openverse stubbed
// on this machine (nothing reaches the internet):
// - Included: the designed pack by category (Swipes, Pops, Success, Glitch, Typing...), every row
//   with its waveform before it's played, found by synonyms ("keyboard" finds typing);
// - Online: "fahh" searches for its free sound-alikes ("frustrated yell") and says why (no pills:
//   one source select and a kind select, D249);
// - Folders: Add a folder (the dialog answered by UNCUT_TEST_DIALOG) lists its sound files,
//   searchable by spelling; Listen streams the file through the server; + copies it into media/
//   (the original untouched) on a track at the playhead; remove forgets the folder.
// Screenshots: test-output/issue32-included.png, issue32-online-fahh.png, issue32-folders.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { SFX_SOUNDS } from "../../packages/core/src/audio/library.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";
import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let sounds = "";
let app: LaunchedApp | undefined;
let page: Page;
let stub: Server;
let base = "";
let mp3: Buffer;
const searches: Array<URLSearchParams> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
async function savedAfter(after: number) {
  await page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r, { timeout: 15000 }, after);
  return revision();
}
async function waitUntil(check: () => boolean, ms = 10000) {
  for (let t = 0; !check(); t += 50) {
    if (t > ms) throw new Error("timed out");
    await sleep(50);
  }
}
const rows = (selector: string) => page.$$eval(selector, (els) => els.map((e) => (e as HTMLElement).dataset.id ?? ""));
async function typeSearch(text: string, enter = false) {
  await page.click("[data-testid=sfx-search]", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  if (text) await page.type("[data-testid=sfx-search]", text);
  if (enter) await page.keyboard.press("Enter");
}

const YELL = "a0000000-0000-0000-0000-0000000000f1";
const BIRDS = "a0000000-0000-0000-0000-0000000000f2";
const hit = (id: string, title: string, license: "cc0" | "by", ms: number, tags: Array<string>) => ({
  id,
  title,
  foreign_landing_url: `https://freesound.org/people/someone/sounds/${id.slice(-4)}`,
  url: `${base}/files/${id}.mp3`,
  creator: "someone",
  license,
  license_version: license === "by" ? "4.0" : "1.0",
  provider: "freesound",
  filetype: "mp3",
  duration: ms,
  tags: tags.map((name) => ({ name })),
  attribution: "",
});

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue32-app-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "libmp3lame", "-b:a", "96k", join(root, "tone.mp3")]);
  mp3 = readFileSync(join(root, "tone.mp3"));
  // The user's own sounds: a meme clip they have, a whoosh in a subfolder, and things that aren't sounds.
  sounds = join(root, "My Sounds");
  mkdirSync(join(sounds, "transitions"), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=520:duration=1.2", join(sounds, "FAHHH meme.wav")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=0.8:a=0.3", "-c:a", "libmp3lame", "-b:a", "96k", join(sounds, "transitions", "big_whoosh_02.mp3")]);
  writeFileSync(join(sounds, "readme.txt"), "not a sound");
  stub = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/v1/audio/") {
      searches.push(url.searchParams);
      const q = url.searchParams.get("q") ?? "";
      const results = /yell/.test(q) ? [hit(BIRDS, "Forest birds", "cc0", 60000, ["nature"]), hit(YELL, "vocals frustrated yell", "cc0", 3200, ["yell", "frustrated"])] : [];
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ result_count: results.length, page_count: 1, results }));
    }
    if (url.pathname.startsWith("/files/")) {
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length) });
      return res.end(mp3);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  const project: Project = {
    format: "uncut/0",
    name: "Sounds",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 300, props: { color: "#202840" } }] }],
  };
  dir = writeProject(root, "Sounds", project);
});
after(async () => {
  await app?.close();
  unlockApps();
  stub?.closeAllConnections();
  stub?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue #32: the designed pack with waveforms, meme names to free sound-alikes, the user's sound folders (D208)", { skip, timeout: 300000 }, async () => {
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, sounds]), UNCUT_CLAUDE: FAKE, UNCUT_OPENVERSE_BASE: base, UNCUT_FREESOUND_BASE: "http://127.0.0.1:9", UNCUT_OPENAI_BASE: "http://127.0.0.1:9", UNCUT_GOOGLE_BASE: "http://127.0.0.1:9", UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9" },
  });
  page = app.page;
  const external: Array<string> = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol) && !["127.0.0.1", "localhost"].includes(u.hostname)) external.push(r.url());
  });
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  let rev = await revision();

  // Included: the whole pack, each row with its waveform before it's played.
  await page.click("[data-testid=rail-sfx]");
  await waitFor("[data-testid=sfx-browser]");
  await page.select("[data-testid=library-source]", "pack");
  await waitFor("[data-testid=sfx-included]");
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=sfx-row]").length === n, {}, SFX_SOUNDS.length);
  assert.equal(await page.$$eval("[data-testid=sfx-row] [data-testid=library-wave]", (els) => els.length), SFX_SOUNDS.length, "every row shows its waveform");
  // D249: the categories are one select, not pills.
  const categories = await page.$$eval("[data-testid=library-mood] option", (els) => els.map((e) => e.textContent));
  for (const c of ["Swipes", "Pops", "Success", "Glitch", "Typing"]) assert.ok(categories.includes(c), `${c} in ${categories.join(", ")}`);
  await page.select("[data-testid=library-mood]", "typing");
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=sfx-row]").length === n, {}, SFX_SOUNDS.filter((s) => s.category === "typing").length);
  assert.deepEqual(await rows("[data-testid=sfx-row]"), SFX_SOUNDS.filter((s) => s.category === "typing").map((s) => s.id));
  await page.select("[data-testid=library-mood]", "");
  // Synonyms and meme names find the pack's sounds.
  await typeSearch("keyboard");
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("[data-testid=sfx-row]")].some((e) => e.dataset.id === "typing-mechanical"));
  await typeSearch("dramatic boom");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=sfx-row]")?.dataset.id === "dramatic-boom");
  await typeSearch("swoosh");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=sfx-row]").length >= 5);
  await page.click('[data-testid=sfx-row][data-id="swoosh-soft"] [data-testid=sfx-play]');
  await waitFor('[data-testid=sfx-row][data-id="swoosh-soft"] [data-testid=sfx-play][data-playing="true"]');
  await sleep(150);
  await page.screenshot({ path: out("issue32-included.png") });
  await page.click('[data-testid=sfx-row][data-id="swoosh-soft"] [data-testid=sfx-play]');

  // Online: "fahh" goes out as its sound-alike search, the note says why; ranked (the yell first).
  await page.select("[data-testid=library-source]", "openverse");
  await waitFor("[data-testid=sfx-browser][data-view=openverse]");
  await typeSearch("fahh", true);
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=library-row]").length === 2, { timeout: 15000 });
  assert.equal(searches.at(-1)!.get("q"), "frustrated yell");
  assert.deepEqual(await rows("[data-testid=library-row]"), [`openverse:${YELL}`, `openverse:${BIRDS}`]);
  const note = await page.$eval("[data-testid=library-alias]", (el) => el.textContent ?? "");
  assert.match(note, /"Fahh" is a clip from a video, so it isn't free to use: these are free sound-alikes\./);
  assert.match(note, /Searched for "frustrated yell"\./);
  await sleep(200);
  await page.screenshot({ path: out("issue32-online-fahh.png") });
  // No pills anywhere in the tab (D249).
  assert.equal(await page.$$eval("[data-testid=sfx-library] .music-chip", (els) => els.length), 0);

  // Folders: empty, then Add a folder lists its sound files (not the text file).
  await page.select("[data-testid=library-source]", "folders");
  await waitFor("[data-testid=folder-empty]");
  await typeSearch("");
  await page.click("[data-testid=folder-add]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=folder-row]").length === 2, { timeout: 15000 });
  assert.match(await page.$eval("[data-testid=sound-folder]", (el) => el.textContent ?? ""), /My Sounds\s*2/);
  await typeSearch("faaah");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=folder-row]").length === 1);
  assert.match(await page.$eval("[data-testid=folder-row] .music-title", (el) => el.textContent ?? ""), /^FAHHH meme$/);
  await typeSearch("swoosh");
  await page.waitForFunction(() => document.querySelector("[data-testid=folder-row] .music-title")?.textContent === "big whoosh 02");
  await typeSearch("");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=folder-row]").length === 2);
  // Listen: streamed from the folder through the server (its waveform appears), nothing copied.
  const fahhRow = await page.$$eval("[data-testid=folder-row]", (els) => (els.find((e) => /FAHHH/.test(e.textContent ?? "")) as HTMLElement).dataset.id!);
  const row = `[data-testid=folder-row][data-id="${fahhRow}"]`;
  await page.click(`${row} [data-testid=folder-play]`);
  await waitFor(`${row} [data-testid=library-wave]`);
  assert.ok(!existsSync(join(dir, "media")), "a preview copies nothing");
  await sleep(200);
  await page.screenshot({ path: out("issue32-folders.png") });
  await page.click(`${row} [data-testid=folder-play]`);
  // +: copied into media/ (the original untouched), on a new Sound effects track at the playhead.
  await page.click(`${row} [data-testid=folder-add-sound]`);
  rev = await savedAfter(rev);
  const p = onDisk();
  const media = p.media.find((m) => m.path === "media/fahhh-meme.wav")!;
  assert.ok(media, JSON.stringify(p.media));
  assert.equal((media.source as Record<string, unknown>).module, "library.folder");
  assert.ok(readFileSync(join(dir, media.path)).equals(readFileSync(join(sounds, "FAHHH meme.wav"))));
  assert.ok(existsSync(join(sounds, "FAHHH meme.wav")));
  const track = p.tracks.find((t) => t.kind === "audio")!;
  assert.equal(track.items[0]!.type === "audio" && track.items[0]!.media, media.id);
  await page.waitForFunction((sel) => /in the project/.test(document.querySelector(sel)?.textContent ?? ""), {}, `${row} .music-meta`);
  // Not in the credits: the user's own file has no licence to list.
  assert.equal(await page.$("[data-testid=copy-credits]"), null);
  // Remove forgets the folder; its files stay.
  await page.click("[data-testid=sound-folder-remove]");
  await waitFor("[data-testid=folder-empty]");
  assert.deepEqual(readdirSync(sounds).sort(), ["FAHHH meme.wav", "readme.txt", "transitions"]);

  assert.ok(!/[·•∙⋅*]/.test(await page.$eval("[data-testid=sfx-library]", (el) => (el as HTMLElement).innerText)), "no dots or stars between words");
  assert.deepEqual(external, [], "the renderer never left this machine");
  assert.deepEqual(app.errors, []);
});
