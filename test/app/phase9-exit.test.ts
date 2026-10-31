// Phase 9 exit check (D106-D111): remote processing on the packaged app (background window, muted),
// with a second server process on 127.0.0.1 standing in for the other machine: its own data dir,
// HOME and projects, the scripted claude (helpers/fake-claude.ts). Never the real claude, ssh or network.
// - Local first: a project on this Mac, so there is something that must stay untouched.
// - Settings, Environments: a wrong token is refused by Test connection; the pairing line the
//   remote printed adds it; Switch reloads the window into it (its own Recents, none yet).
// - New project there through the remote file browser (the server's folders), close it, open it
//   again with Open… (the browser again); a drop of a local file uploads it into the project's
//   media/uploads/ and imports it; it goes on the timeline; one agent turn on the remote adds a title.
// - Export on the server (its folder picked in the browser), then Download to a path on this Mac:
//   the same bytes.
// - The remote restarts: the window says it's reconnecting, then shows the remote's Recents again.
// - Back to This Mac: its Recents and project as they were, the remote project in neither.
// - Nothing left the machine (helpers/offline.ts).
// Output: test-output/phase9-exit-editor.png, phase9-exit-environments.png, phase9-exit-browser.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { freePort, launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { isLocalUrl, watchSockets } from "../helpers/offline.ts";
import { startServer } from "../helpers/server.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : !FFMPEG || !FFPROBE ? "needs ffmpeg and ffprobe" : false;

type Remote = Awaited<ReturnType<typeof startServer>>;
let root = "";
let shimDir = "";
let clip = "";
let remotePort = 0;
let remote: Remote | undefined;
let app: LaunchedApp | undefined;
let page: Page;
const rendererRequests: Array<string> = [];
const remoteSockets: Array<string> = [];
let sockets: { stop: () => void } | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = (selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
const text = (selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const until = async (check: () => boolean, what: string, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
let t0 = Date.now();
const step = (what: string) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);
const remoteHome = () => join(root, "remote-home");
const plan = () => join(root, "plan.json");
const resultLog = () => join(root, "results.jsonl");
const results = (): Array<{ tool: string; result: { isError?: boolean; content: Array<{ text?: string }> } }> =>
  existsSync(resultLog())
    ? readFileSync(resultLog(), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-phase9-exit-")));
  for (const d of ["local-data", "local-projects", "downloads", "remote-data", "remote-home/projects", "remote-home/Movies", "files", "bin", "no-plugins"])
    mkdirSync(join(root, d), { recursive: true });
  shimDir = join(root, "bin");
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  writeFileSync(join(root, "local-data", "settings.json"), JSON.stringify({ onboarded: true }));
  writeFileSync(join(root, "remote-data", "settings.json"), JSON.stringify({ onboarded: true }));
  for (const f of [resultLog(), join(root, "prompts.jsonl"), join(root, "tools.jsonl")]) writeFileSync(f, "");
  clip = join(root, "files", "drone take.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    clip,
  ]);
  remotePort = await freePort();
});
after(async () => {
  sockets?.stop();
  await app?.close();
  await remote?.stop();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The "other machine": a headless server with its own data dir and HOME, the scripted claude, no network. */
async function startRemote() {
  remote = await startServer({
    args: ["--port", String(remotePort), "--data-dir", join(root, "remote-data")],
    captureStderr: true,
    env: {
      UNCUT_DATA_DIR: "",
      HOME: remoteHome(),
      UNCUT_PLUGINS_DIR: join(root, "no-plugins"),
      PATH: `${shimDir}:/usr/bin:/bin`,
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
      FAKE_TOOLS_LOG: join(root, "tools.jsonl"),
      UNCUT_GOOGLE_BASE: "http://127.0.0.1:9",
      UNCUT_OPENAI_BASE: "http://127.0.0.1:9",
      UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9",
    },
  });
  // The headless server's token is on stderr and in its data dir, never on stdout (D106).
  remote.ready.token = readFileSync(join(root, "remote-data", "server-token"), "utf8").trim();
  return remote;
}

async function launch(dialogs: Array<string>) {
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "local-data"),
      UNCUT_PLUGINS_DIR: join(root, "no-plugins"),
      UNCUT_SHELL_ENV: "off",
      UNCUT_TEST_KEYS: "standin",
      PATH: `${shimDir}:/usr/bin:/bin`,
      UNCUT_CLAUDE: FAKE,
      UNCUT_GOOGLE_BASE: "http://127.0.0.1:9",
      UNCUT_OPENAI_BASE: "http://127.0.0.1:9",
      UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9",
      UNCUT_TEST_DIALOG: JSON.stringify(dialogs),
    },
  });
  page = app.page;
  page.on("request", (r) => rendererRequests.push(r.url()));
  sockets = watchSockets(app.proc.pid!, remoteSockets);
}

/** Inside the remote file browser: into `name` (a folder), by a click. */
async function enter(name: string) {
  const before = await text("[data-testid=remote-browser-dir]");
  await page.click(`[data-testid=remote-entry][data-name='${name}']`);
  await page.waitForFunction((b: string) => document.querySelector("[data-testid=remote-browser-dir]")?.textContent?.trim() !== b, {}, before);
}

/** Environments is behind a Labs flag, off by default (D245): on, through Settings › Labs. */
async function turnOnEnvironments() {
  await page.keyboard.down("Meta");
  await page.keyboard.press("Comma");
  await page.keyboard.up("Meta");
  await waitFor("[data-testid=settings-nav-labs]");
  await page.click("[data-testid=settings-nav-labs]");
  await page.click("[data-testid=lab-environments-toggle]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=lab-environments-toggle]")?.checked === true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=labs-settings]"));
}

async function openEnvironments() {
  await page.click("[data-testid=env-chip]");
  await waitFor("[data-testid=environments]");
}

test(
  "phase 9 exit: a second server as a remote environment; pair, browse, upload, edit, agent turn, export and download there; reconnect; Local untouched; nothing leaves the machine",
  { skip, timeout: 600000 },
  async () => {
    const started = Date.now();
    try {
      await exitCheck();
    } catch (error) {
      await page?.screenshot({ path: "test-output/phase9-exit-failure.png" }).catch(() => {});
      throw Object.assign(error as Error, {
        message: `${(error as Error).message}\n--- app output ---\n${app?.output().slice(-4000)}\n--- remote stderr ---\n${remote?.stderr().slice(-3000)}`,
      });
    }
    console.log(`phase 9 exit check took ${((Date.now() - started) / 1000).toFixed(1)} s`);
  },
);

async function exitCheck() {
  t0 = Date.now();
  await startRemote();
  await until(() => /uncut:\/\/pair\?\S+\n/.test(remote!.stderr()), "the pairing line", 5000);
  const pairing = /uncut:\/\/pair\?\S+/.exec(remote!.stderr())?.[0];
  assert.ok(pairing, `the remote printed its pairing line:\n${remote!.stderr()}`);
  step("remote server up");

  // 1. A local project, to leave alone.
  const download = join(root, "downloads", "Remote cut.mp4");
  await launch([join(root, "local-projects"), download]);
  await waitForWelcome(page);
  await turnOnEnvironments();
  assert.equal(await page.$eval("[data-testid=env-chip]", (el) => (el as HTMLElement).dataset.kind), "local");
  await page.click("[data-testid=new-project]");
  await waitFor("[data-testid=new-project-form]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((d: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === d, {}, join(root, "local-projects"));
  await page.click("[data-testid=project-name]", { count: 3 });
  await page.keyboard.type("Home");
  await page.click("[data-testid=create]");
  await waitFor("[data-testid=editor]");
  // A new project opens on the Agent tab (U14); the project's settings are in the Inspector.
  await page.click("[data-testid=tab-inspector]");
  await waitFor("[data-testid=show-in-finder]");
  await page.click("[data-testid=close-project]");
  await waitForWelcome(page);
  const localDir = join(root, "local-projects", "Home.uncut");
  const localProject = readFileSync(join(localDir, "project.json"), "utf8");
  const localRecents = readFileSync(join(root, "local-data", "recents.json"), "utf8");
  step("local project made");

  // 2. Pair: a wrong token is refused; the pairing line adds it; switch.
  await openEnvironments();
  await page.click("[data-testid=env-add]");
  await waitFor("[data-testid=env-add-form]");
  await page.type("[data-testid=env-add-url]", `http://127.0.0.1:${remotePort}`);
  await page.type("[data-testid=env-add-token]", "not-the-right-token-at-all");
  await page.click("[data-testid=env-add-test]");
  await waitFor("[data-testid=env-add-result][data-ok=false]");
  assert.match(await text("[data-testid=env-add-result]"), /refused the token/);
  await page.click("[data-testid=env-add-url]", { count: 3 });
  await page.keyboard.press("Backspace");
  await page.type("[data-testid=env-add-name]", "Studio");
  await page.type("[data-testid=env-add-url]", pairing!);
  assert.equal(await page.$("[data-testid=env-add-token]"), null, "the pairing line carries the token");
  await page.click("[data-testid=env-add-save]");
  await waitFor("[data-testid=env-row][data-kind=remote]");
  assert.equal(await text("[data-testid=env-row][data-kind=remote] [data-testid=env-name]"), "Studio");
  const stored = readFileSync(join(root, "local-data", "environments.json"), "utf8");
  assert.ok(!stored.includes(remote!.ready.token), "the token isn't stored as text");
  await page.screenshot({ path: "test-output/phase9-exit-environments.png" });
  await page.click("[data-testid=env-row][data-kind=remote] [data-testid=env-switch]");
  // The window reloads into the remote: its own (empty) Recents.
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>("[data-testid=env-chip]")?.dataset.kind === "remote" &&
      document.querySelector<HTMLElement>("[data-testid=env-chip]")?.dataset.state === "connected",
    { timeout: 30000 },
  );
  await waitFor("[data-testid=no-recents]");
  assert.match(await text("[data-testid=welcome-lead]"), /Studio/);
  step("paired and switched");

  // 3. A project on the remote, through its file browser; closed, then opened with Open….
  await page.click("[data-testid=new-project]");
  await waitFor("[data-testid=new-project-form]");
  const remoteDefault = join(remoteHome(), "Movies");
  await page
    .waitForFunction((dir) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")?.title === dir, { timeout: 10000 }, remoteDefault)
    .catch(() => {});
  assert.equal(await page.$eval("[data-testid=parent-dir]", (el) => (el as HTMLElement).title), remoteDefault, "the remote's own default folder");
  await page.click("[data-testid=choose-folder]");
  await waitFor("[data-testid=remote-browser][data-purpose=parent]");
  await waitFor("[data-testid=remote-entry][data-name=projects]");
  await enter("projects");
  await page.click("[data-testid=remote-browser-choose]");
  await page.waitForFunction((d: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === d, {}, join(remoteHome(), "projects"));
  await page.click("[data-testid=project-name]", { count: 3 });
  await page.keyboard.type("Remote cut");
  await page.click("[data-testid=create]");
  await waitFor("[data-testid=editor]");
  // A new project opens on the Agent tab (U14); the project's settings are in the Inspector.
  await page.click("[data-testid=tab-inspector]");
  const dir = join(remoteHome(), "projects", "Remote cut.uncut");
  assert.equal(await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title), dir);
  assert.equal(await page.$("[data-testid=show-in-finder]"), null, "no Finder for the server's folder");
  await waitFor("[data-testid=project-host]");
  await page.click("[data-testid=close-project]");
  await waitFor("[data-testid=recent]");
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=remote-browser][data-purpose=project]");
  await waitFor("[data-testid=remote-entry][data-name=projects]");
  await enter("projects");
  await waitFor("[data-testid=remote-entry][data-name='Remote cut.uncut'][data-project=true]");
  await page.click("[data-testid=remote-entry][data-name='Remote cut.uncut']");
  await page.screenshot({ path: "test-output/phase9-exit-browser.png" });
  await page.click("[data-testid=remote-browser-choose]");
  await waitFor("[data-testid=editor]");
  step("created and opened on the remote");

  // 4. A drop from this Mac: uploaded into media/uploads/, imported, onto the timeline.
  const bytes = readFileSync(clip).toString("base64");
  await page.evaluate((b64: string) => {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([raw], "drone take.mp4", { type: "video/mp4" }));
    const target = document.querySelector("[data-testid=library]")!;
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
  await waitFor("[data-testid=media-tile]", 60000);
  const uploaded = join(dir, "media", "uploads", "drone take.mp4");
  assert.deepEqual(readFileSync(uploaded), readFileSync(clip), "the same bytes on the server");
  const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  await until(() => onDisk().media.some((m: { path: string }) => m.path === "media/uploads/drone take.mp4"), "the media in project.json");
  await page.hover("[data-testid=media-tile]");
  await page.click("[data-testid=add-to-timeline]");
  await until(() => onDisk().tracks.some((t: { items: Array<unknown> }) => t.items.length > 0), "the clip on the timeline");
  step("uploaded, imported, on the timeline");

  // 5. One agent turn, run by the remote (its claude, its MCP bridge).
  writeFileSync(
    plan(),
    JSON.stringify([
      [
        { tool: "project_read", args: {} },
        {
          tool: "timeline_edit",
          args: {
            baseRevision: "$rev",
            summary: "A title",
            ops: [{ op: "insert_text", look: "text.big-title", text: "Made on the studio Mac", start: 0, duration: 45, id: "title" }],
          },
        },
        { text: "Added a title over the start." },
      ],
    ]),
  );
  await page.click("[data-testid=tab-agent]");
  await waitFor("[data-testid=agent-panel]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 20000 });
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("Put a title over the start");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => ["done", "failed", "cancelled"].includes(document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status ?? ""),
    { timeout: 120000 },
  );
  assert.equal(await page.$eval("[data-testid=agent-turn]", (el) => (el as HTMLElement).dataset.status), "done", await text("[data-testid=agent-turn]"));
  for (const r of results()) assert.ok(!r.result.isError, `${r.tool}: ${JSON.stringify(r.result)}`);
  assert.ok(
    onDisk()
      .tracks.flatMap((t: { items: Array<{ id: string }> }) => t.items)
      .some((i: { id: string }) => i.id === "title"),
    "the agent's title is in the remote project",
  );
  const prompts = readFileSync(join(root, "prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(prompts.length, 1, "one claude run, by the remote");
  step("agent turn on the remote");

  // 6. Export on the server (folder from its browser), then Download here.
  await page.click("[data-testid=to-start]");
  for (let i = 0; i < 20; i++) await page.click("[data-testid=step-forward]");
  // The preview's footage comes through the relay from the remote (never a file:// path here).
  await page.waitForFunction(() => [...document.querySelectorAll("video")].some((v) => v.src.startsWith("http://127.0.0.1:") && v.readyState >= 2), {
    timeout: 20000,
  });
  await sleep(800);
  await page.screenshot({ path: "test-output/phase9-exit-editor.png" });
  await page.click("[data-testid=export-button]");
  await waitFor("[data-testid=export-form]");
  await page.click("[data-testid=export-change]");
  await waitFor("[data-testid=remote-browser][data-purpose=save]");
  await page.waitForFunction(() => document.querySelector("[data-testid=remote-browser-dir]")?.textContent?.includes("Movies"));
  await page.click("[data-testid=remote-browser-name]", { count: 3 });
  await page.keyboard.type("Remote cut.mp4");
  await page.click("[data-testid=remote-browser-choose]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Remote cut.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")?.dataset.phase ?? ""), {
    timeout: 300000,
  });
  const status = await text("[data-testid=export-status]");
  assert.match(status, /Saved on Studio/, status);
  const output = join(remoteHome(), "Movies", "Remote cut.mp4");
  assert.equal(await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.output), output);
  assert.equal(await page.$("[data-testid=export-reveal]"), null, "no Finder for the server's file");
  await page.click("[data-testid=export-download]");
  await waitFor("[data-testid=export-downloaded]", 60000);
  assert.deepEqual(readFileSync(download), readFileSync(output), "the download is the export, byte for byte");
  await page.keyboard.press("Escape");
  step("exported on the remote and downloaded");

  // 7. The remote restarts: reconnecting, then its Recents again (a restarted server has no project open).
  await remote!.stop();
  await waitFor("[data-testid=connection-banner]", 20000);
  await page.waitForFunction(() => /Studio/.test(document.querySelector("[data-testid=connection-banner]")?.textContent ?? ""));
  await startRemote();
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=env-chip]")?.dataset.state === "connected", { timeout: 30000 });
  await waitFor("[data-testid=recent]", 20000);
  assert.equal(await text("[data-testid=recent] .wiz-name"), "Remote cut");
  await page.click("[data-testid=recent]");
  await waitFor("[data-testid=editor]");
  step("reconnected after the remote restarted");

  // 8. Back to This Mac: its project and Recents as they were.
  await page.click("[data-testid=close-project]");
  await waitForWelcome(page);
  await openEnvironments();
  await page.click("[data-testid=env-row][data-kind=local] [data-testid=env-switch]");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=env-chip]")?.dataset.kind === "local", { timeout: 30000 });
  await waitFor("[data-testid=recent]");
  const names = await page.$$eval("[data-testid=recent] .wiz-name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ["Home"]);
  assert.equal(readFileSync(join(localDir, "project.json"), "utf8"), localProject, "the local project is untouched");
  assert.equal(readFileSync(join(root, "local-data", "recents.json"), "utf8"), localRecents, "the local Recents are untouched");
  assert.ok(!readFileSync(join(root, "remote-data", "recents.json"), "utf8").includes("Home.uncut"), "the remote's Recents never list the local project");
  // While the remote was down, Chromium logged the refused socket and loads; nothing else.
  assert.deepEqual(
    app!.errors.filter((e) => !/WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws|Failed to load resource/.test(e)),
    [],
  );
  sockets?.stop();
  await app!.close();
  app = undefined;
  step("back on This Mac, untouched");

  assert.deepEqual(
    rendererRequests.filter((u) => !isLocalUrl(u)),
    [],
    "the renderer only talked to this machine",
  );
  assert.deepEqual(remoteSockets, [], "no process of the app had a connection off this machine");
}
