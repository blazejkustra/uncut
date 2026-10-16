// A1, A2 and the credits (D134, D135) on the packaged app, run invisibly, through the UI only, with
// Openverse stubbed on this machine (UNCUT_OPENVERSE_BASE; nothing reaches the internet):
// - the Audio tab opens on Openverse without a request; a mood searches (CC0 + CC BY,
//   commercial, no Wikimedia), rows show creator, length and licence; Listen streams the preview
//   through the server (a waveform appears, nothing is saved); + downloads the CC BY song into
//   media/ with its credits on the media item, at the playhead on the free audio track with fades,
//   in one edit; Copy credits copies the attribution;
// - the sources (Epidemic Sound coming soon, disabled); the Sound effects tab: a kind select, a meme
//   name that searches for sound-alikes, and the bundled pack, whose + copies the sound in whole on a track of
//   its own; a 429 from Openverse shows the limit state, an earlier search still comes from the
//   cache; the Freesound row in Settings › Keys with its one-line terms note.
// Screenshots: test-output/audio-online.png, audio-limit.png, sfx-online.png, sfx-included.png, keys-freesound.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
let app: LaunchedApp | undefined;
let page: Page;
let stub: Server;
let base = "";
let limited = false;
let mp3: Buffer;
const searches: Array<URLSearchParams> = [];
const files: Array<string> = [];
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
const waitSearches = (n: number) => waitUntil(() => searches.length >= n);
const rows = (selector: string) => page.$$eval(selector, (els) => els.map((e) => (e as HTMLElement).dataset.id ?? ""));

const SONG = "a0000000-0000-0000-0000-00000000000a";
const LOOP = "a0000000-0000-0000-0000-00000000000b";
const BOOM = "a0000000-0000-0000-0000-00000000000c";
const hit = (id: string, title: string, creator: string, license: "cc0" | "by", ms: number, provider = "freesound") => ({
  id,
  title,
  foreign_landing_url: provider === "jamendo" ? `https://www.jamendo.com/track/${id.slice(-4)}` : `https://freesound.org/people/${creator}/sounds/${id.slice(-4)}`,
  url: `${base}/files/${id}.mp3`,
  creator,
  creator_url: `https://example.org/${creator}`,
  license,
  license_version: license === "by" ? "3.0" : "1.0",
  license_url: license === "by" ? "https://creativecommons.org/licenses/by/3.0/" : "https://creativecommons.org/publicdomain/zero/1.0/",
  provider,
  filetype: "mp3",
  duration: ms,
  tags: [{ name: "music" }],
  attribution: "",
});

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-audio-library-app-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=6", "-af", "volume='if(lt(mod(t,1),0.5),1,0.3)':eval=frame", "-c:a", "libmp3lame", "-b:a", "96k", join(root, "tone.mp3")]);
  mp3 = readFileSync(join(root, "tone.mp3"));
  stub = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/v1/audio/") {
      searches.push(url.searchParams);
      if (limited) return res.writeHead(429, { "retry-after": "30", "content-type": "application/json" }).end("{}");
      const q = url.searchParams.get("q") ?? "";
      const results = /boom/.test(q) ? [hit(BOOM, "Bass Boom", "LordHannes", "cc0", 2400)] : [hit(SONG, "Lofi Morning", "Some Artist", "by", 6000, "jamendo"), hit(LOOP, "Lofi Vinyl Loop", "holizna", "cc0", 6000)];
      res.writeHead(200, { "content-type": "application/json", "x-ratelimit-available-anon_burst": "19", "x-ratelimit-available-anon_sustained": "199" });
      return res.end(JSON.stringify({ result_count: results.length, page_count: 1, results }));
    }
    if (url.pathname.startsWith("/files/")) {
      files.push(url.pathname);
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
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 300, props: { color: "#202840" } }] },
      { id: "audio", kind: "audio", name: "Audio", items: [] },
    ],
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

test("the sound library: online music and sound effects, previews, adds with credits, the limit, the bundled packs (A1, A2, D134, D135)", { skip, timeout: 300000 }, async () => {
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, UNCUT_OPENVERSE_BASE: base, UNCUT_FREESOUND_BASE: "http://127.0.0.1:9", UNCUT_OPENAI_BASE: "http://127.0.0.1:9", UNCUT_GOOGLE_BASE: "http://127.0.0.1:9", UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9" },
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

  // The Audio tab (D249): Openverse first, one search field, a source and a mood select, the Openverse notice; nothing fetched yet.
  await page.click("[data-testid=rail-audio]");
  await waitFor("[data-testid=music-browser][data-view=openverse]");
  await waitFor("[data-testid=library-mood]");
  assert.match(await page.$eval("[data-testid=library-notice]", (el) => el.textContent ?? ""), /^Made with Openverse, not endorsed by Openverse$/);
  assert.equal(searches.length, 0, "no request until a search");
  assert.equal(await page.$$eval("[data-testid=audio-library] .music-chip", (els) => els.length), 0, "no pills");

  // A mood searches; two rows with creator, length and licence.
  await page.select("[data-testid=library-mood]", "lofi");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=library-row]").length === 2, { timeout: 15000 });
  assert.equal(searches.length, 1);
  const q = searches[0]!;
  assert.equal(q.get("q"), "lofi");
  assert.equal(q.get("license"), "cc0,by");
  assert.equal(q.get("license_type"), "commercial,modification");
  assert.equal(q.get("excluded_source"), "wikimedia_audio");
  // Ranked (D208): both match "lofi"; the CC0 loop comes before the CC BY song.
  assert.deepEqual(await rows("[data-testid=library-row]"), [`openverse:${LOOP}`, `openverse:${SONG}`]);
  const songRow = `[data-testid=library-row][data-id="openverse:${SONG}"]`;
  assert.equal(await page.$eval(`${songRow} .music-meta`, (el) => el.textContent), "Some Artist, 6.0 s, jamendo");
  assert.equal(await page.$eval(`${songRow} [data-testid=library-license]`, (el) => el.textContent), "CC BY");
  assert.equal(await page.$eval(`[data-testid=library-row][data-id="openverse:${LOOP}"] [data-testid=library-license]`, (el) => el.textContent), "CC0");

  // Listen: streamed through the server's preview route; a waveform; nothing saved in the project.
  await page.click(`${songRow} [data-testid=library-play]`);
  await waitFor(`${songRow} [data-testid=library-play][data-playing="true"]`);
  await waitFor(`${songRow} [data-testid=library-wave]`);
  await sleep(600);
  assert.equal(await page.$eval(`${songRow} [data-testid=library-play]`, (el) => (el as HTMLElement).dataset.playing), "true", "still playing (it loaded through the preview route)");
  assert.ok(files.includes(`/files/${SONG}.mp3`));
  assert.ok(!existsSync(join(dir, "media")), "a preview is never saved");
  await page.screenshot({ path: out("audio-online.png") });
  await page.click(`${songRow} [data-testid=library-play]`);

  // + at 2 s: downloaded into media/ with its credits, on the free Audio track, cut at the video's end, with fades; one edit.
  await page.click("[data-testid=ruler]");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === 60);
  await page.click(`${songRow} [data-testid=library-add]`);
  rev = await savedAfter(rev);
  const p1 = onDisk();
  const song = p1.media.find((m) => m.path === "media/lofi-morning-some-artist.mp3")!;
  assert.ok(song, JSON.stringify(p1.media));
  assert.ok(readFileSync(join(dir, song.path)).equals(mp3), "the same bytes");
  assert.equal(song.kind, "audio");
  assert.equal(song.name, "Lofi Morning");
  assert.equal(song.probe?.frames, 180);
  const s = song.source as Record<string, unknown>;
  assert.equal(s.module, "library.openverse");
  assert.equal(s.libraryId, `openverse:${SONG}`);
  assert.equal(s.creator, "Some Artist");
  assert.equal(s.license, "by");
  assert.equal(s.licenseVersion, "3.0");
  assert.equal(s.landingUrl, "https://www.jamendo.com/track/000a");
  assert.equal(s.provider, "jamendo");
  assert.match(String(s.sha256), /^[0-9a-f]{64}$/);
  assert.match(String(s.attribution), /^"Lofi Morning" by Some Artist is licensed under CC BY 3\.0/);
  assert.deepEqual(p1.tracks.find((t) => t.id === "audio")!.items, [{ id: "audio-1", type: "audio", media: song.id, in: 0, duration: 180, start: 60, fadeIn: 30, fadeOut: 45 }]);
  await waitFor(`${songRow} .music-meta`);
  await page.waitForFunction((sel) => /in the project/.test(document.querySelector(sel)?.textContent ?? ""), {}, `${songRow} .music-meta`);

  // Copy credits: the CC BY line, as the clipboard gets it (under the test harness the app logs it instead).
  await waitFor("[data-testid=copy-credits][data-attribution='1']");
  await page.click("[data-testid=copy-credits]");
  await waitFor("[data-testid=copy-credits].done");
  await waitUntil(() => app!.output().includes("[test] copied Music and sound"));
  const copied = app.output().slice(app.output().lastIndexOf("[test] copied ") + "[test] copied ".length);
  assert.ok(copied.startsWith('Music and sound\n"Lofi Morning" by Some Artist (https://www.jamendo.com/track/000a), licensed under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/)\n\nFound with Openverse (openverse.org)\n'), copied);

  // The sources (D249, D274): Folders, the Music library, Openverse; Epidemic Sound shown, disabled, coming soon.
  const sources = await page.$$eval("[data-testid=library-source] option", (els) => els.map((e) => [(e as HTMLOptionElement).value, (e as HTMLOptionElement).disabled]));
  assert.deepEqual(sources, [["folders", false], ["music-app", false], ["openverse", false], ["epidemic", true]]);
  assert.equal(await page.$eval("[data-testid=epidemic-soon]", (el) => (el as HTMLButtonElement).disabled), true);

  // Sound effects: the pack first (D250); Openverse searches a meme name's sound-alike.
  await page.click("[data-testid=rail-sfx]");
  await waitFor("[data-testid=sfx-browser][data-view=pack]");
  const kinds = await page.$$eval("[data-testid=library-mood] option", (els) => els.map((e) => e.textContent));
  assert.deepEqual(kinds, ["Any kind", "Whoosh", "Transitions", "Swipes", "UI clicks", "Pops", "Impacts", "Risers", "Notifications", "Success", "Glitch", "Typing", "Laughs and applause", "Memes"]);
  await page.select("[data-testid=library-source]", "openverse");
  await waitFor("[data-testid=sfx-browser][data-view=openverse]");
  await page.type("[data-testid=sfx-search]", "dramatic boom");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=library-row]").length === 1, { timeout: 15000 });
  assert.equal(searches.at(-1)!.get("q"), "bass boom", "a meme name searches for a sound-alike that exists (D208)");
  await page.click("[data-testid=sfx-search]", { clickCount: 3 });
  await page.type("[data-testid=sfx-search]", "Bruh");
  await page.keyboard.press("Enter");
  await waitUntil(() => searches.at(-1)!.get("q") === "bruh");
  await page.click("[data-testid=sfx-search]", { clickCount: 3 });
  await page.type("[data-testid=sfx-search]", "dramatic boom");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=library-row]").length === 1, { timeout: 15000 });
  await sleep(300);
  await page.screenshot({ path: out("sfx-online.png") });

  await page.select("[data-testid=library-source]", "pack");
  await waitFor("[data-testid=sfx-included]");
  await page.click("[data-testid=sfx-search]", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=sfx-row]").length === n, {}, SFX_SOUNDS.length);
  await page.select("[data-testid=library-mood]", "meme");
  const memes = await rows("[data-testid=sfx-row]");
  assert.deepEqual(memes, SFX_SOUNDS.filter((x) => x.category === "meme").map((x) => x.id));
  await page.click('[data-testid=sfx-row][data-id="bruh"] [data-testid=sfx-play]');
  await waitFor('[data-testid=sfx-row][data-id="bruh"] [data-testid=library-wave]');
  await page.click('[data-testid=sfx-row][data-id="bruh"] [data-testid=sfx-add]');
  rev = await savedAfter(rev);
  const p2 = onDisk();
  const bruh = p2.media.find((m) => m.path === "media/bruh.m4a")!;
  assert.ok(readFileSync(join(dir, "media/bruh.m4a")).equals(readFileSync(resolve("assets/sfx/bruh.m4a"))));
  assert.equal((bruh.source as Record<string, unknown>).module, "library.bundled");
  // The Audio track is busy at 2 s: the sound goes on a Sound effects track of its own, whole, without fades.
  const sfxTrack = p2.tracks.find((t) => t.name === "Sound effects")!;
  const length = Math.floor(SFX_SOUNDS.find((x) => x.id === "bruh")!.seconds * 30);
  assert.deepEqual(sfxTrack.items, [{ id: "sound-1", type: "audio", media: bruh.id, in: 0, duration: length, start: 60 }]);
  await waitFor('[data-testid=sfx-row][data-id="bruh"]');
  await sleep(300);
  await page.screenshot({ path: out("sfx-included.png") });
  // The credits now list the CC0 sound too (still one that needs attribution).
  await waitFor("[data-testid=copy-credits][data-attribution='1']");
  assert.ok(!/[·•∙⋅*]/.test(await page.$eval("[data-testid=sfx-library]", (el) => (el as HTMLElement).innerText)), "no dots or stars between words");

  await page.select("[data-testid=library-mood]", "");
  await page.select("[data-testid=library-source]", "openverse");
  await waitFor("[data-testid=sfx-browser][data-view=openverse]");
  // The limit (last: it holds every search for 30 s): a 429 shows when searching works again; an earlier search still comes from the cache.
  limited = true;
  await page.click("[data-testid=sfx-search]", { clickCount: 3 });
  await page.type("[data-testid=sfx-search]", "ambient piano");
  await page.keyboard.press("Enter");
  await waitFor("[data-testid=library-limit]");
  assert.match(await page.$eval("[data-testid=library-limit]", (el) => el.textContent ?? ""), /^Openverse's search limit is reached\. Try again in (2\d|30) s\.$/);
  await page.screenshot({ path: out("audio-limit.png") });
  const before = searches.length;
  await page.click("[data-testid=sfx-search]", { clickCount: 3 });
  await page.type("[data-testid=sfx-search]", "dramatic boom");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=library-row]").length === 1, { timeout: 15000 });
  assert.equal(searches.length, before, "answered from the cache");
  limited = false;

  // Settings › Keys: the Freesound row with its one-line terms note (no key is stored).
  await page.click("[data-testid=rail-generate]");
  await waitFor("[data-testid=generator][data-id='generate.gpt-image']");
  await page.click("[data-testid=generator][data-id='generate.gpt-image']");
  await waitFor("[data-testid=generate-open-keys]");
  await page.click("[data-testid=generate-open-keys]");
  await waitFor("[data-testid=onboarding] [data-testid=key-freesound][data-set=false]");
  assert.equal(await page.$eval("[data-testid=key-note-freesound]", (el) => el.textContent), "Freesound's API is free for non-commercial use only");
  await (await page.$("[data-testid=key-freesound]"))!.screenshot({ path: out("keys-freesound.png") });
  await page.keyboard.press("Escape");

  assert.deepEqual(external, [], "the renderer never left this machine");
  assert.deepEqual(readdirSync(join(dir, "media")).sort(), ["bruh.m4a", "lofi-morning-some-artist.mp3"]);
  assert.deepEqual(app.errors, []);
});
