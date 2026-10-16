// Issues #69 and #70 (D249, D250) on the packaged app, run invisibly, through the UI only, with
// Jamendo and ElevenLabs stubbed on this machine (nothing reaches the internet; the paid API is
// never called) and a made-up Music library (UNCUT_MUSIC_LIBRARY_DIR; the real ~/Music is never read):
// - Audio: no "In this project", no Included, no pills; one search field and a source select
//   (Your folders, Music library, Openverse, Jamendo, Epidemic Sound coming soon and disabled);
//   Your folders: Add a folder lists the folder as a plain row and its songs; Music library: asked
//   for, lists its DRM-free songs (Apple Music and protected left out, counted), + copies one into
//   media/; Jamendo: asks for a client ID (kept like the Generate tab's keys), then searches with
//   it, CC BY only, + downloads with credits that never hold the ID;
// - Sounds: Uncut's pack first, "fahh" finds the original sound-alike first; Generate a sound
//   effect asks for an ElevenLabs key, then makes one (the stub), lands in Media and goes on the
//   timeline at the playhead.
// Screenshots: test-output/issue69-audio-jamendo.png, issue69-music-library.png,
// issue69-folders.png, issue70-sounds-fahh.png, issue70-generate.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/timeline/types.ts";
import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const CLIENT = "test-client-0042";
const ELEVEN = "sk_test_eleven_0042";

let root = "";
let dir = "";
let folder = "";
let musicHome = "";
let app: LaunchedApp | undefined;
let page: Page;
let stub: Server;
let base = "";
let mp3: Buffer;
const jamendo: Array<URLSearchParams> = [];
const generated: Array<{ key: string | undefined; body: Record<string, unknown> }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
async function savedAfter(after: number) {
  await page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r, { timeout: 20000 }, after);
  return revision();
}
const rows = (selector: string) => page.$$eval(selector, (els) => els.map((e) => (e as HTMLElement).dataset.id ?? ""));
const text = (selector: string) => page.$eval(selector, (el) => (el as HTMLElement).innerText);

const track = (id: number, name: string, ccurl: string) => ({
  id: String(id),
  name,
  duration: 6,
  artist_id: "9",
  artist_name: "Indie Band",
  license_ccurl: ccurl,
  shareurl: `https://www.jamendo.com/track/${id}`,
  audio: `${base}/stream/${id}.mp3?from=app-${CLIENT}`,
  audiodownload: `${base}/download/${id}.mp3?from=app-${CLIENT}`,
  audiodownload_allowed: true,
  musicinfo: { tags: { genres: ["pop"], instruments: [], vartags: ["happy"] } },
});

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue69-70-app-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=6", "-c:a", "libmp3lame", "-b:a", "96k", join(root, "tone.mp3")]);
  mp3 = readFileSync(join(root, "tone.mp3"));
  // A folder of the user's own music.
  folder = join(root, "My Music");
  mkdirSync(folder, { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=262:duration=4", "-c:a", "libmp3lame", join(folder, "Morning Theme.mp3")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=392:duration=3", join(folder, "Outro Sting.wav")]);
  // A made-up Music library: its XML copy with a bought song, an imported one, an Apple Music one and a protected one.
  musicHome = join(root, "Music");
  const songs = join(root, "Songs");
  mkdirSync(join(musicHome, "Music"), { recursive: true });
  mkdirSync(songs, { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "aac", "-b:a", "96k", join(songs, "Yellow Sky.m4a")]);
  writeFileSync(join(songs, "Second Song.mp3"), mp3);
  const loc = (f: string) => pathToFileURL(join(songs, f)).href.replace("file:///", "file://localhost/");
  const entry = (i: number, fields: Record<string, string | number | boolean>) =>
    `<key>${i}</key><dict>${Object.entries(fields).map(([k, v]) => `<key>${k}</key>${typeof v === "boolean" ? `<${v}/>` : typeof v === "number" ? `<integer>${v}</integer>` : `<string>${v}</string>`}`).join("")}</dict>`;
  writeFileSync(
    join(musicHome, "Music", "Library.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Tracks</key><dict>${[
      entry(1, { Name: "Yellow Sky", Artist: "The Parachutes", Album: "Blue", Kind: "Purchased AAC audio file", "Track Type": "File", Location: loc("Yellow Sky.m4a") }),
      entry(2, { Name: "Second Song", Artist: "Home Band", Album: "Demos", Kind: "MPEG audio file", "Track Type": "File", Location: loc("Second Song.mp3") }),
      entry(3, { Name: "Chart Hit", Artist: "Big Star", Kind: "Apple Music AAC audio file", "Apple Music": true, "Track Type": "Remote" }),
      entry(4, { Name: "Old Purchase", Artist: "Someone", Kind: "Protected AAC audio file", Protected: true, "Track Type": "File", Location: loc("Old.m4p") }),
    ].join("")}</dict><key>Playlists</key><array></array></dict></plist>`,
  );
  stub = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/v3.0/tracks/") {
      jamendo.push(url.searchParams);
      const results = [track(11, "Happy Morning", "http://creativecommons.org/licenses/by/3.0/"), track(12, "Not For Videos", "http://creativecommons.org/licenses/by-nc-nd/3.0/")];
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ headers: { status: "success", code: 0, results_count: 2, results_fullcount: 2 }, results }));
    }
    if (/^\/(stream|download)\//.test(url.pathname)) {
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length) });
      return res.end(mp3);
    }
    if (url.pathname === "/v1/sound-generation" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        generated.push({ key: req.headers["xi-api-key"] as string | undefined, body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length) });
        res.end(mp3);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  const project: Project = {
    format: "uncut/0",
    name: "Sources",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [],
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 300, props: { color: "#202840" } }] },
      { id: "audio", kind: "audio", name: "Audio", items: [] },
    ],
  };
  dir = writeProject(root, "Sources", project);
});
after(async () => {
  await app?.close();
  unlockApps();
  stub?.closeAllConnections();
  stub?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issues #69 and #70: the Audio tab's sources, Jamendo and the Music library, the grown pack and Generate a sound effect (D249, D250)", { skip, timeout: 300000 }, async () => {
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir, folder]),
      UNCUT_CLAUDE: FAKE,
      // Keys go through the stand-in crypter, never the Keychain.
      UNCUT_TEST_KEYS: "standin",
      UNCUT_MUSIC_LIBRARY_DIR: musicHome,
      UNCUT_JAMENDO_BASE: base,
      UNCUT_ELEVENLABS_BASE: base,
      UNCUT_OPENVERSE_BASE: "http://127.0.0.1:9",
      UNCUT_FREESOUND_BASE: "http://127.0.0.1:9",
      UNCUT_OPENAI_BASE: "http://127.0.0.1:9",
      UNCUT_GOOGLE_BASE: "http://127.0.0.1:9",
    },
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

  // ---- #69 Audio: one field, one source select, no project list, no Included, no pills ----
  await page.click("[data-testid=rail-audio]");
  await waitFor("[data-testid=music-browser][data-view=openverse]");
  assert.equal(await page.$("[data-testid=audio-list]"), null, "no In this project");
  assert.equal(await page.$("[data-testid=audio-empty]"), null);
  assert.equal(await page.$("[data-testid=library-view-included]"), null, "no Included");
  assert.equal(await page.$$eval("[data-testid=audio-library] .music-chip", (els) => els.length), 0, "no pills");
  const options = await page.$$eval("[data-testid=library-source] option", (els) => els.map((e) => [(e as HTMLOptionElement).textContent, (e as HTMLOptionElement).disabled]));
  assert.deepEqual(options, [["Your folders", false], ["Music library", false], ["Openverse", false], ["Jamendo", false], ["Epidemic Sound (coming soon)", true]]);
  assert.match(await text("[data-testid=epidemic-soon]"), /Epidemic Sound\s+Coming soon/);
  assert.equal(await page.$eval("[data-testid=epidemic-soon]", (el) => (el as HTMLButtonElement).disabled), true);

  // Jamendo: a client ID first (stored like the Generate tab's keys), then a search with it.
  await page.select("[data-testid=library-source]", "jamendo");
  await waitFor("[data-testid=key-needed-jamendo]");
  assert.equal(jamendo.length, 0, "no request without a client ID");
  assert.equal(await page.$eval("[data-testid=lib-key-input-jamendo]", (el) => (el as HTMLInputElement).type), "password");
  await page.type("[data-testid=lib-key-input-jamendo]", CLIENT);
  await page.click("[data-testid=lib-key-save-jamendo]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=key-needed-jamendo]"), { timeout: 15000 });
  await waitFor("[data-testid=library-idle]");
  await page.type("[data-testid=music-search]", "happy");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=library-row]").length === 1, { timeout: 15000 });
  assert.equal(jamendo.at(-1)!.get("client_id"), CLIENT);
  assert.equal(jamendo.at(-1)!.get("search"), "happy");
  assert.deepEqual(await rows("[data-testid=library-row]"), ["jamendo:11"], "CC BY only: the NC-ND track isn't offered");
  assert.equal(await text("[data-testid=library-row] [data-testid=library-license]"), "CC BY");
  assert.match(await text("[data-testid=library-notice]"), /Music from Jamendo: only CC0 and CC BY tracks are shown/);
  await sleep(200);
  await page.screenshot({ path: out("issue69-audio-jamendo.png") });
  await page.click("[data-testid=ruler]");
  await page.keyboard.press("Home");
  await page.click('[data-testid=library-row][data-id="jamendo:11"] [data-testid=library-add]');
  rev = await savedAfter(rev);
  const song = onDisk().media.find((m) => m.path === "media/happy-morning-indie-band.mp3")!;
  assert.ok(song, JSON.stringify(onDisk().media));
  assert.equal((song.source as Record<string, unknown>).module, "library.jamendo");
  assert.equal((song.source as Record<string, unknown>).license, "by");
  assert.ok(!readFileSync(join(dir, "project.json"), "utf8").includes(CLIENT), "the client ID never in the project");

  // Music library: asked for, then its DRM-free songs; + copies one into media/.
  await page.select("[data-testid=library-source]", "music-app");
  await waitFor("[data-testid=music-app-connect]");
  await page.click("[data-testid=music-app-connect]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=folder-row]").length === 2, { timeout: 15000 });
  assert.equal(await page.$eval("[data-testid=music-app-summary]", (el) => (el as HTMLElement).dataset.skipped), "2");
  assert.match(await text("[data-testid=music-app-summary]"), /2 songs, 2 Apple Music or protected left out/);
  await page.click("[data-testid=music-search]", { clickCount: 3 });
  await page.type("[data-testid=music-search]", "parachutes");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=folder-row]").length === 1);
  assert.match(await text("[data-testid=folder-row]"), /Yellow Sky[\s\S]*The Parachutes, Blue, m4a/);
  await sleep(200);
  await page.screenshot({ path: out("issue69-music-library.png") });
  await page.click("[data-testid=folder-row] [data-testid=folder-add-sound]");
  rev = await savedAfter(rev);
  const yellow = onDisk().media.find((m) => m.path === "media/yellow-sky.m4a")!;
  assert.ok(yellow, JSON.stringify(onDisk().media));
  assert.equal((yellow.source as Record<string, unknown>).folder, "Music library");

  // Your folders: Add a folder; the folder is a plain row (name, count, ×), its songs below.
  await page.click("[data-testid=music-search]", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.select("[data-testid=library-source]", "folders");
  await waitFor("[data-testid=folder-empty]");
  await page.click("[data-testid=folder-add]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=folder-row]").length === 2, { timeout: 15000 });
  assert.deepEqual(await page.$$eval("[data-testid=sound-folder]", (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim())), ["My Music 2"]);
  assert.equal(await page.$$eval("[data-testid=sound-folder]", (els) => els.filter((e) => (e as HTMLElement).classList.contains("lib-folder")).length), 1, "a list row, not a pill");
  // The row lines up with the panel: its left edge sits on the add button's.
  const [rowLeft, addLeft] = await page.$$eval("[data-testid=sound-folder], [data-testid=folder-add]", (els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  assert.ok(Math.abs(rowLeft! - addLeft!) <= 1, `aligned: ${rowLeft} vs ${addLeft}`);
  await sleep(200);
  await page.screenshot({ path: out("issue69-folders.png") });

  // ---- #70 Sounds: the pack first; "fahh" finds the original sound-alike first ----
  await page.click("[data-testid=rail-sfx]");
  await waitFor("[data-testid=sfx-browser][data-view=pack]");
  await page.type("[data-testid=sfx-search]", "fahh");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=sfx-row]")?.dataset.id === "exaggerated-shout");
  assert.deepEqual((await rows("[data-testid=sfx-row]")).slice(0, 2), ["exaggerated-shout", "frustrated-yell"]);
  assert.match(await page.$eval('[data-testid=sfx-row][data-id="exaggerated-shout"]', (el) => (el as HTMLElement).title), /made by Uncut, CC0/);
  await page.click('[data-testid=sfx-row][data-id="exaggerated-shout"] [data-testid=sfx-play]');
  await waitFor('[data-testid=sfx-row][data-id="exaggerated-shout"] [data-testid=sfx-play][data-playing="true"]');
  await sleep(150);
  await page.screenshot({ path: out("issue70-sounds-fahh.png") });
  await page.click('[data-testid=sfx-row][data-id="exaggerated-shout"] [data-testid=sfx-play]');
  for (const [words, first] of [["vine boom", "dramatic-boom"], ["taco bell", "deep-bong"], ["record scratch", "record-scratch"], ["bonk", "bonk"], ["riser", ""]] as const) {
    await page.click("[data-testid=sfx-search]", { clickCount: 3 });
    await page.type("[data-testid=sfx-search]", words);
    if (first) await page.waitForFunction((id) => document.querySelector<HTMLElement>("[data-testid=sfx-row]")?.dataset.id === id, {}, first);
  }
  // Risers: the pack's and Uncut's own.
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=sfx-row]").length >= 6);

  // Generate a sound effect: an ElevenLabs key first, then a description and a length; the stub answers.
  await page.click("[data-testid=sfx-search]", { clickCount: 3 });
  await page.type("[data-testid=sfx-search]", "soft whoosh into a hit");
  await page.click("[data-testid=sfx-generate-toggle]");
  await waitFor("[data-testid=key-needed-elevenlabs]", 20000);
  assert.equal(generated.length, 0);
  await page.type("[data-testid=lib-key-input-elevenlabs]", ELEVEN);
  await page.click("[data-testid=lib-key-save-elevenlabs]");
  await waitFor("[data-testid=sfx-generate-prompt]", 20000);
  assert.equal(await page.$eval("[data-testid=sfx-generate-prompt]", (el) => (el as HTMLTextAreaElement).value), "soft whoosh into a hit", "the search words to start with");
  assert.match(await text("[data-testid=sfx-generate-cost]"), /about \$0\.02 for 2 s/);
  await page.select("[data-testid=sfx-generate-seconds]", "5");
  await page.click("[data-testid=sfx-generate-run]");
  await waitFor("[data-testid=sfx-generate-done]", 30000);
  assert.equal(generated.length, 1, "one request to the (stubbed) API");
  assert.equal(generated[0]!.key, ELEVEN);
  assert.equal(generated[0]!.body.text, "soft whoosh into a hit");
  assert.equal(generated[0]!.body.duration_seconds, 5);
  const madeId = await page.$eval("[data-testid=sfx-generate-done]", (el) => (el as HTMLElement).dataset.media!);
  const made = onDisk().media.find((m) => m.id === madeId)!;
  assert.ok(made && made.kind === "audio" && (made.source as Record<string, unknown>).module === "generate.sound", JSON.stringify(made));
  await sleep(200);
  await page.screenshot({ path: out("issue70-generate.png") });
  rev = await revision();
  await page.click("[data-testid=sfx-generate-add]");
  rev = await savedAfter(rev);
  assert.ok(onDisk().tracks.some((t) => t.items.some((i) => i.type === "audio" && i.media === madeId)), "on the timeline");

  assert.ok(!/[·•∙⋅*]/.test(await text("[data-testid=sfx-library]")), "no dots or stars between words");
  assert.deepEqual(external, [], "the renderer never left this machine");
  assert.deepEqual(app.errors, []);
});
