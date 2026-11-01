// The packaged Linux server for real: builds infra/server/Dockerfile, boots the image and the tarball
// in containers published on 127.0.0.1 only, and pairs the way the desktop does (the printed line,
// Test connection, the relay). The image then runs an import, a titled export and a restart.
// Run from the repo root, Docker running:
//   node scripts/server-image-check.ts        CI runs this
//   ... --app                                 also pairs the packaged app (pnpm dist) through Settings › Labs and Environments
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parsePairing } from "../apps/desktop/src/environments.ts";
import { pingServer, startRelay } from "../apps/desktop/src/relay.ts";
import { connect } from "../test/helpers/server.ts";

const IMAGE = "uncut-server";
const NODE_IMAGE = "node:24-bookworm-slim";
const SERVER_PORT = 8790;
const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");

interface AppPage {
  click(selector: string): Promise<unknown>;
  type(selector: string, text: string): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForFunction(body: string, options?: { timeout?: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void>; press(key: string): Promise<void> };
}
interface AppHelpers {
  launchApp(options: { command: string; env: Record<string, string> }): Promise<{ page: AppPage; errors: Array<string>; close: () => Promise<void> }>;
  lockApps(): Promise<void>;
  unlockApps(): void;
  waitForWelcome(page: AppPage): Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: ReadonlyArray<string>) =>
  execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const dockerLogs = (container: string) => spawnSync("docker", ["logs", container], { encoding: "utf8" }).stderr;
const removeContainer = (container: string) => spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function check(ok: boolean, what: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) throw new Error(what);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

/** The newest pairing line in the container's logs, as the desktop reads it. */
async function waitForPairing(container: string, count = 1) {
  for (let i = 0; i < 300; i++) {
    const lines = dockerLogs(container).match(/uncut:\/\/pair\?\S+/g) ?? [];
    if (lines.length >= count) return { line: lines.at(-1)!, pairing: parsePairing(lines.at(-1)!)! };
    await sleep(200);
  }
  throw new Error(`${container} printed no pairing line:\n${dockerLogs(container).slice(-2000)}`);
}

function makeClip(container: string) {
  const clip = "/tmp/clip.mp4";
  const video = ["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"];
  docker("exec", container, "ffmpeg", "-v", "error", "-y", ...video, clip);
  return execFileSync("docker", ["exec", container, "cat", clip], { maxBuffer: 64 * 1024 * 1024 });
}

async function exportProject(client: Awaited<ReturnType<typeof connect>>, output: string) {
  const jobs = client.subscribe("export.jobs");
  const { jobId } = await client.ok("export.start", { output, quality: "draft", loudness: "off" });
  const finished = (j: { id: string; phase: string }) => j.id === jobId && ["done", "failed", "cancelled"].includes(j.phase);
  await jobs.until((list) => list.some(finished), 300000);
  return { jobId: jobId as string, job: jobs.values.at(-1).find((j: { id: string }) => j.id === jobId) as { phase: string; error?: string } };
}

async function editAndExport(container: string, url: string, token: string) {
  const relay = await startRelay({ target: url, token });
  const client = await connect(relay.port, relay.token);
  try {
    const hello = await client.ok("server.hello", {});
    check(hello.home === "/data" && !!hello.mediaCore?.version, `server.hello through the relay: home ${hello.home}, media core ${hello.mediaCore?.version}`);
    const snap = await client.ok("project.create", { parentDir: hello.home, name: "Packaged" });
    const dir = snap.dir as string;

    const bytes = makeClip(container);
    const upload = await fetch(`${relay.httpBase}/api/upload?name=clip.mp4&token=${relay.token}`, { method: "POST", body: bytes });
    const { path } = (await upload.json()) as { path: string };
    const jobs = client.subscribe("media.jobs");
    const { jobId } = await client.ok("media.import", { paths: [path] });
    await jobs.until((list) => list.some((j: { id: string; phase: string }) => j.id === jobId && ["done", "failed"].includes(j.phase)), 60000);
    const media = (await client.ok("project.get", {})).project.media[0];
    check(media?.probe?.frames > 0, `upload and import: ${media?.probe?.width}x${media?.probe?.height}, ${media?.probe?.frames} frames`);

    const clip = { op: "insert_item", track: "main", item: { id: "c1", type: "clip", media: media.id, in: 0, duration: 60 } };
    const title = { op: "insert_item", track: "text", item: { id: "title", type: "text", start: 0, duration: 45, text: "Packaged" } };
    await client.ok("project.edit", { ops: [clip, title], summary: "clip and title" });

    const output = `${hello.home}/Packaged.mp4`;
    const { jobId: exportId, job } = await exportProject(client, output);
    check(job.phase === "done", `titled export through Electron on Xvfb: ${job.phase}${job.error ? ` (${job.error})` : ""}`);
    const download = Buffer.from(await (await fetch(`${relay.httpBase}/api/export/${exportId}?token=${relay.token}`)).arrayBuffer());
    const there = docker("exec", container, "sha256sum", output).split(" ")[0];
    check(sha256(download) === there, `download matches the file there: ${download.length} bytes`);
    await client.ok("project.close", {});
    return dir;
  } finally {
    client.close();
    await relay.close();
  }
}

/** Through the real window: Settings › Labs on, the printed line pasted, Test, Save, Switch, the project opened. */
async function appCheck(line: string, projectDir: string, root: string) {
  const { launchApp, lockApps, unlockApps, waitForWelcome } = (await import(["..", "test", "helpers", "app.ts"].join("/"))) as AppHelpers;
  const data = join(root, "local-data");
  mkdirSync(data, { recursive: true });
  execFileSync("sh", ["-c", 'printf %s \'{"onboarded":true}\' > "$1"', "sh", join(data, "settings.json")]);
  mkdirSync("test-output", { recursive: true });
  await lockApps();
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: data, UNCUT_SHELL_ENV: "off", UNCUT_TEST_KEYS: "standin" } });
  try {
    const { page } = app;
    const waitFor = (selector: string) => page.waitForSelector(selector, { timeout: 30000 });
    await waitForWelcome(page);
    await page.keyboard.down("Meta");
    await page.keyboard.press("Comma");
    await page.keyboard.up("Meta");
    await waitFor("[data-testid=settings-nav-labs]");
    await page.click("[data-testid=settings-nav-labs]");
    await page.click("[data-testid=lab-environments-toggle]");
    await page.keyboard.press("Escape");
    await page.waitForFunction('!document.querySelector("[data-testid=labs-settings]")');
    await page.click("[data-testid=env-chip]");
    await waitFor("[data-testid=environments]");
    await page.click("[data-testid=env-add]");
    await page.type("[data-testid=env-add-name]", "Container");
    await page.type("[data-testid=env-add-url]", line);
    await page.click("[data-testid=env-add-test]");
    await waitFor("[data-testid=env-add-result]");
    const result = 'document.querySelector("[data-testid=env-add-result]")';
    const tested = await page.evaluate(`${result}.textContent.trim()`);
    check((await page.evaluate(`${result}.dataset.ok`)) === "true", `app: Test connection: ${tested}`);
    await page.click("[data-testid=env-add-save]");
    await waitFor("[data-testid=env-row][data-kind=remote]");
    await page.click("[data-testid=env-row][data-kind=remote] [data-testid=env-switch]");
    await page.waitForFunction(
      'document.querySelector("[data-testid=env-chip]")?.dataset.kind === "remote" && document.querySelector("[data-testid=env-chip]")?.dataset.state === "connected"',
      {
        timeout: 30000,
      },
    );
    await waitFor("[data-testid=wizard-skip]");
    await page.screenshot({ path: "test-output/server-image-setup.png" });
    await page.click("[data-testid=wizard-skip]");
    await waitFor("[data-testid=welcome]");
    check(true, "app: switched to the container and past its first-run setup");
    await page.click("[data-testid=open-project]");
    await waitFor("[data-testid=remote-browser][data-purpose=project]");
    const entry = `[data-testid=remote-entry][data-name='${projectDir.split("/").at(-1)}']`;
    await waitFor(entry);
    await page.click(entry);
    await page.click("[data-testid=remote-browser-choose]");
    await waitFor("[data-testid=editor]");
    await sleep(1500);
    await page.screenshot({ path: "test-output/server-image-app.png" });
    const opened = await page.evaluate('document.querySelector("[data-testid=project-dir]").title');
    check(opened === projectDir, `app: the container's project is open in the editor: ${opened}`);
    const errors = app.errors.filter((e) => !/Failed to load resource/.test(e));
    check(errors.length === 0, `app: no renderer errors ${errors.join(" | ").slice(0, 400)}`);
  } finally {
    await app.close();
    unlockApps();
  }
}

async function checkImage(id: string, root: string, withApp: boolean) {
  const container = `uncut-server-check-${id}`;
  const volume = `${container}-data`;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  try {
    docker("run", "-d", "--name", container, "-p", `127.0.0.1:${port}:${SERVER_PORT}`, "-v", `${volume}:/data`, "-e", `UNCUT_PUBLIC_URL=${url}`, IMAGE);
    const { pairing } = await waitForPairing(container);
    check(pairing.url === url, `the image prints a pairing line for its published port: ${pairing.url}`);
    check(docker("exec", container, "id", "-u").trim() === "1000", "it runs as the uncut user");
    const mode = docker("exec", container, "stat", "-c", "%a", "/data/.uncut-server/server-token").trim();
    check(mode === "600", `token file mode ${mode}`);
    const wrong = await pingServer(url, "not-the-right-token-at-all");
    check(!wrong.ok && /refused the token/.test(wrong.message), `a wrong token: ${wrong.ok ? "accepted" : wrong.message}`);
    const ping = await pingServer(url, pairing.token);
    check(ping.ok, `Test connection: ${JSON.stringify(ping)}`);

    const projectDir = await editAndExport(container, url, pairing.token);

    docker("restart", "-t", "5", container);
    const again = await waitForPairing(container, 2);
    check(again.pairing.token === pairing.token, "after a restart the pairing still holds");
    for (let i = 0; i < 50 && !(await pingServer(url, pairing.token)).ok; i++) await sleep(200);
    check((await pingServer(url, pairing.token)).ok, "and the restarted server answers");

    if (withApp) await appCheck(again.line, projectDir, root);
  } catch (error) {
    console.log(`--- docker logs ${container} ---\n${dockerLogs(container).slice(-3000)}`);
    throw error;
  } finally {
    removeContainer(container);
    spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
  }
}

async function checkTarball(id: string, root: string) {
  const out = join(root, "tarball");
  docker("build", "-q", "-f", "infra/server/Dockerfile", "--target", "tarball", "-o", out, ".");
  const [tarball] = readdirSync(out);
  check(/^uncut-server-linux-(amd64|arm64)\.tar\.gz$/.test(tarball ?? ""), `tarball: ${tarball}`);

  const container = `uncut-server-tarball-${id}`;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const start = `tar xzf /in/${tarball} -C /opt && exec /opt/${tarball!.replace(".tar.gz", "")}/uncut-server --host 0.0.0.0`;
  try {
    docker(
      "run",
      "-d",
      "--name",
      container,
      "-p",
      `127.0.0.1:${port}:${SERVER_PORT}`,
      "-v",
      `${out}:/in:ro`,
      "-e",
      `UNCUT_PUBLIC_URL=${url}`,
      NODE_IMAGE,
      "sh",
      "-c",
      start,
    );
    const { pairing } = await waitForPairing(container);
    const ping = await pingServer(url, pairing.token);
    check(ping.ok, `the tarball boots on plain Node and pairs: ${JSON.stringify(ping)}`);
  } catch (error) {
    console.log(`--- docker logs ${container} ---\n${dockerLogs(container).slice(-3000)}`);
    throw error;
  } finally {
    removeContainer(container);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--app")) {
    console.error("Use: node scripts/server-image-check.ts [--app]");
    process.exit(2);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-server-check-")));
  const id = randomBytes(3).toString("hex");
  try {
    console.log("building the image ...");
    docker("build", "-q", "-f", "infra/server/Dockerfile", "-t", IMAGE, ".");
    await checkTarball(id, root);
    await checkImage(id, root, args.includes("--app"));
    console.log("\nPASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
