// Connect over SSH (D106-D111) for real, against a Linux container standing in for the other machine.
// No second computer needed: Docker runs Debian with Node 24, sshd, ffmpeg, Uncut's media core built
// for linux, the bundled server and Electron (the export's rasteriser) on a virtual display. Then,
// as D111 tells a user to: real `ssh` starts the headless server there (bound to its loopback), a
// real `ssh -N -L` tunnel brings it here, and everything below goes through the tunnel, through the
// desktop's relay (apps/desktop/src/relay.ts) exactly as the app does.
// Never the real claude (the scripted one, test/helpers/fake-claude.ts), never your ~/.ssh keys or
// ssh config (a throwaway ed25519 key in a temp folder, -F /dev/null, its own known_hosts), nothing
// published beyond 127.0.0.1. Not part of `pnpm test` (test/remote/docker.test.ts runs it with
// UNCUT_DOCKER_IT=1).
//
// Run from the repo root (Docker running):
//   node scripts/remote-docker-check.ts           build the image (cached after the first time), run it, check, clean up
//   ... --app      also launch the packaged app (dist/mac-arm64/Uncut.app, in the background), add the
//                  environment with a pairing line through the tunnel, switch, open the remote browser:
//                  test-output/remote-docker-browser.png, remote-docker-editor.png
//   ... --clean    also remove the image afterwards
//   ... --keep     leave the container and temp folder (prints how to reach them; remove with docker rm -f)
// Cleanup only ever removes what this run started: its container (by its unique name), the tunnel and
// ssh processes it spawned, its temp folder, and the image only with --clean.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { pingServer, startRelay, type Relay } from "../apps/desktop/src/relay.ts";
import { connect } from "../test/helpers/server.ts";

export const IMAGE = "uncut-remote-check";
const LABEL = "uncut.remote-docker-check";
const REMOTE_PORT = 8790;
const SERVER = "/opt/uncut/apps/server/dist/server.mjs";
// For pgrep/pkill -f: matches the server's command line but not the shell running pgrep itself.
const SERVER_PATTERN = "/opt/uncut/apps/server/dist/[s]erver.mjs";
const FAKE_CLAUDE = "/opt/uncut/test/helpers/fake-claude.ts";
const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");

export interface CheckOptions {
  readonly app?: boolean;
  readonly clean?: boolean;
  readonly keep?: boolean;
  readonly log?: (line: string) => void;
}
export type Outcome = "PASS" | "FAIL" | "GAP";
export interface CheckResult {
  readonly checks: ReadonlyArray<{ readonly outcome: Outcome; readonly what: string }>;
  readonly ok: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Newest mtime under `dir` (files only), 0 when it doesn't exist. */
const newest = (dir: string): number => {
  if (!existsSync(dir)) return 0;
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || e.parentPath.includes("node_modules")) continue;
    max = Math.max(max, statSync(join(e.parentPath, e.name)).mtimeMs);
  }
  return max;
};

/** The server bundle, rebuilt when any of its sources is newer than it. */
function ensureServerBuilt(log: (l: string) => void) {
  const bundle = resolve("apps/server/dist/server.mjs");
  const built = existsSync(bundle) && existsSync(resolve("apps/server/dist/mcp.mjs")) ? statSync(bundle).mtimeMs : 0;
  const sources = Math.max(...["apps/server/src", "packages/core/src", "packages/contracts/src", "packages/plugin-sdk/src"].map((d) => newest(resolve(d))));
  if (built < sources) {
    log("server bundle is stale: pnpm --filter @uncut/server build");
    execFileSync("pnpm", ["--filter", "@uncut/server", "build"], { stdio: "inherit" });
  }
  if (!existsSync(resolve("apps/desktop/dist/main.cjs"))) {
    log("the rasteriser's entry isn't built: pnpm --filter @uncut/desktop build");
    execFileSync("pnpm", ["--filter", "@uncut/desktop", "build"], { stdio: "inherit" });
  }
}

/** The build context: what the image needs, at the repo-relative paths config.ts expects in development. */
function stageContext(ctx: string) {
  const opt = join(ctx, "opt", "uncut");
  const copy = (rel: string, to = rel) => cpSync(resolve(rel), join(opt, to), { recursive: true, filter: (src) => !src.includes("node_modules") && !src.endsWith(".map") && !src.endsWith(".DS_Store") });
  copy("apps/server/dist/server.mjs");
  copy("apps/server/dist/mcp.mjs");
  copy("apps/desktop/dist/main.cjs");
  copy("spec/modules/builtin");
  copy("assets/music");
  copy("plugins");
  copy("packages/plugin-sdk/package.json");
  copy("packages/plugin-sdk/src");
  copy("test/helpers/fake-claude.ts");
  chmodSync(join(opt, "test/helpers/fake-claude.ts"), 0o755);
  // fake-claude.ts and the plugins are ES modules run by Node itself.
  writeFileSync(join(opt, "package.json"), JSON.stringify({ name: "uncut-remote", private: true, type: "module" }));
  for (const f of ["Cargo.toml", "Cargo.lock", "src"]) cpSync(resolve("native/media", f), join(ctx, "native/media", f), { recursive: true });
  for (const f of ["Dockerfile", "entrypoint.sh", "electron-render.sh"]) cpSync(resolve("scripts/remote-docker", f), join(ctx, "scripts/remote-docker", f));
}

export async function remoteDockerCheck(options: CheckOptions = {}): Promise<CheckResult> {
  const log = options.log ?? ((l: string) => console.log(l));
  const checks: Array<{ outcome: Outcome; what: string }> = [];
  const check = (ok: boolean, what: string) => {
    checks.push({ outcome: ok ? "PASS" : "FAIL", what });
    log(`  ${ok ? "PASS" : "FAIL"} ${what}`);
    return ok;
  };
  const gap = (what: string) => {
    checks.push({ outcome: "GAP", what });
    log(`  GAP  ${what}`);
  };

  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-remote-docker-")));
  const id = randomBytes(4).toString("hex");
  const container = `${IMAGE}-${id}`;
  const spawned: Array<ChildProcess> = [];
  let relay: Relay | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let containerStarted = false;
  let failed = false;

  const cleanupSync = () => {
    for (const p of spawned) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    if (options.keep) return;
    if (containerStarted) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    if (options.clean) spawnSync("docker", ["rmi", IMAGE], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  };
  const onSignal = () => {
    cleanupSync();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    ensureServerBuilt(log);
    // A throwaway login key and known_hosts: never ~/.ssh, never the user's ssh config.
    const key = join(root, "id_ed25519");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "uncut-remote-docker-check", "-f", key]);
    const knownHosts = join(root, "known_hosts");
    writeFileSync(knownHosts, "");

    const ctx = join(root, "context");
    stageContext(ctx);
    log(`building ${IMAGE} (cached after the first run) ...`);
    const build = spawnSync("docker", ["build", "-q", "-t", IMAGE, "--label", `${LABEL}=1`, "-f", join(ctx, "scripts/remote-docker/Dockerfile"), ctx], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (build.status !== 0) throw new Error(`docker build failed:\n${build.stderr.slice(-4000)}`);

    execFileSync("docker", ["run", "-d", "--name", container, "--label", `${LABEL}=${id}`, "-p", "127.0.0.1::22", "-e", `AUTHORIZED_KEY=${readFileSync(`${key}.pub`, "utf8").trim()}`, IMAGE], { stdio: "ignore" });
    containerStarted = true;
    const published = execFileSync("docker", ["port", container, "22/tcp"], { encoding: "utf8" }).trim().split("\n")[0]!;
    const sshPort = Number(published.split(":").at(-1));
    check(published.startsWith("127.0.0.1:") && sshPort > 0, `sshd published on ${published} only`);

    const sshArgs = ["-F", "/dev/null", "-i", key, "-o", "IdentitiesOnly=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=5", "-p", String(sshPort)];
    const target = "uncut@127.0.0.1";
    const ssh = (command: string, input?: string) => execFileSync("ssh", [...sshArgs, target, command], { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    for (let i = 0; ; i++) {
      try {
        ssh("true");
        break;
      } catch (error) {
        if (i > 60) throw new Error(`ssh into the container never worked: ${(error as Error).message}`);
        await sleep(500);
      }
    }
    check(true, `ssh uncut@127.0.0.1 -p ${sshPort} with the throwaway key`);
    const remoteSha = (path: string) => ssh(`sha256sum ${shellQuote(path)}`).split(" ")[0];

    // D111's first command, with Linux paths instead of Uncut.app. The environment that the scripted
    // claude needs, and keyed providers pointed at a closed port, go on the command line.
    const startServer = async (render: boolean) => {
      const env = [
        `UNCUT_CLAUDE=${FAKE_CLAUDE}`,
        'FAKE_PLAN="$HOME/plan.json"',
        'FAKE_PROMPT_LOG="$HOME/prompts.jsonl"',
        'FAKE_RESULT_LOG="$HOME/results.jsonl"',
        "UNCUT_GOOGLE_BASE=http://127.0.0.1:9",
        "UNCUT_OPENAI_BASE=http://127.0.0.1:9",
        "UNCUT_ELEVENLABS_BASE=http://127.0.0.1:9",
        ...(render ? ["UNCUT_RENDER_BIN=/usr/local/bin/uncut-electron-render", "UNCUT_RENDER_ENTRY=/opt/uncut/apps/desktop/dist/main.cjs"] : []),
      ];
      const command = `${env.join(" ")} node ${SERVER} --port ${REMOTE_PORT} --data-dir "$HOME/.uncut-server"`;
      const proc = spawn("ssh", [...sshArgs, target, command], { stdio: ["ignore", "pipe", "pipe"] });
      spawned.push(proc);
      let stderr = "";
      proc.stderr!.on("data", (d) => (stderr += d));
      const ready = await new Promise<Record<string, unknown>>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`no ready line within 60 s; stderr:\n${stderr}`)), 60000);
        createInterface({ input: proc.stdout! }).once("line", (l) => (clearTimeout(timer), res(JSON.parse(l))));
        proc.once("exit", (code) => (clearTimeout(timer), rej(new Error(`ssh exited (${code}) before the ready line; stderr:\n${stderr}`))));
      });
      for (let i = 0; i < 50 && !/uncut:\/\/pair\?\S+\n/.test(stderr); i++) await sleep(100);
      return { proc, ready, stderr: () => stderr, command };
    };

    log("starting the headless server over ssh (no rasteriser configured, as a plain Linux install would) ...");
    let server = await startServer(false);
    log(`    ${server.command}`);
    check(server.ready.port === REMOTE_PORT && server.ready.token === undefined, `ready line on stdout without the token: ${JSON.stringify(server.ready)}`);
    const pairing = /uncut:\/\/pair\?\S+/.exec(server.stderr())?.[0];
    check(!!pairing, "the pairing text on stderr");
    const token = ssh('cat "$HOME/.uncut-server/server-token"').trim();
    check(/^[A-Za-z0-9_-]{32,}$/.test(token) && server.stderr().includes(token), "the token read over ssh from the data dir matches the printed one");
    const mode = ssh('stat -c %a "$HOME/.uncut-server/server-token" "$HOME/.uncut-server"').trim().split("\n");
    check(mode[0] === "600" && mode[1] === "700", `token file 0600, data dir 0700 (${mode.join(", ")})`);
    if (pairing) {
      const url = new URL(pairing.replace("uncut://", "http://")).searchParams.get("url");
      gap(`the printed pairing line says ${url}: the remote's own loopback port, which pairs only when the tunnel's local port is the same (here ${REMOTE_PORT} there, a different one here); the Add form needs the tunnel's address`);
    }

    // D111's second command: the tunnel, on a free local port different from the remote one.
    const localPort = await freeLocalPort(REMOTE_PORT);
    const tunnel = spawn("ssh", [...sshArgs, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `${localPort}:127.0.0.1:${REMOTE_PORT}`, target], { stdio: ["ignore", "ignore", "pipe"] });
    spawned.push(tunnel);
    const base = `http://127.0.0.1:${localPort}`;
    // Ready when the remote answers 401 to a request without a token (not counted against this address, D110).
    for (let i = 0; ; i++) {
      const status = await fetch(`${base}/api/ping`).then((r) => r.status, () => 0);
      if (status === 401) break;
      if (i > 100 || tunnel.exitCode !== null) throw new Error(`the tunnel to ${base} never answered (last status ${status})`);
      await sleep(100);
    }
    check(true, `tunnel ssh -N -L ${localPort}:127.0.0.1:${REMOTE_PORT} answers at ${base}`);

    // Through the tunnel only from here on.
    check((await fetch(`${base}/api/ping`, { headers: { authorization: "Bearer not-the-right-token-at-all" } })).status === 401, "a wrong token is refused (401)");
    const wrong = await pingServer(base, "not-the-right-token-either");
    check(!wrong.ok && /refused the token/.test(wrong.message), `Test connection with a wrong token: "${wrong.ok ? "ok" : wrong.message}"`);
    const ping = await pingServer(base, token);
    const hostname = ssh("hostname").trim();
    check(ping.ok && ping.hostname === hostname, `Test connection: ${JSON.stringify(ping)}`);

    relay = await startRelay({ target: base, token });
    client = await connect(relay.port, relay.token);
    const hello = await client.ok("server.hello", {});
    check(hello.home === "/home/uncut" && hello.hostname === hostname, `server.hello through the relay: home ${hello.home}, host ${hello.hostname}, node ${hello.node}, media core ${hello.mediaCore?.version}`);
    check(hello.defaultParentDir === "/home/uncut", `New project's default folder there: ${hello.defaultParentDir}`);
    const listing = await client.ok("files.list", {});
    check(listing.dir === "/home/uncut" && Array.isArray(listing.entries), `files.list of the remote home: ${listing.entries.map((e: { name: string }) => e.name).join(", ") || "(empty)"}`);

    const jobs = client.subscribe("media.jobs");
    const exports = client.subscribe("export.jobs");
    const agent = client.subscribe("agent.subscribe");
    const snap = await client.ok("project.create", { parentDir: hello.home, name: "Remote cut" });
    const dir = snap.dir as string;
    check(dir === "/home/uncut/Remote cut.uncut" && ssh(`test -f ${shellQuote(`${dir}/project.json`)} && echo yes`).trim() === "yes", `project created in the remote home: ${dir}`);
    const again = await client.ok("files.list", { dir: hello.home });
    check(again.entries.some((e: { name: string; project?: boolean }) => e.name === "Remote cut.uncut" && e.project), "files.list marks it as a project");

    // A clip made here, uploaded through the relay and the tunnel.
    const clip = join(root, "drone take.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:d=2", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
    const bytes = readFileSync(clip);
    const uploadRes = await fetch(`${relay.httpBase}/api/upload?name=${encodeURIComponent("drone take.mp4")}&token=${relay.token}`, { method: "POST", body: bytes, headers: { "content-type": "application/octet-stream" } });
    const up = (await uploadRes.json()) as { path?: string };
    const uploaded = `${dir}/media/uploads/drone take.mp4`;
    check(uploadRes.status === 200 && up.path === uploaded, `upload: ${uploadRes.status} ${up.path}`);
    check(remoteSha(uploaded) === sha256(bytes), "the uploaded file has the same sha256 there (ssh sha256sum)");
    const { jobId: importJob } = await client.ok("media.import", { paths: [uploaded] });
    await jobs.until((list) => list.some((j: { id: string; phase: string }) => j.id === importJob && ["done", "failed"].includes(j.phase)), 60000);
    const importPhase = jobs.values.at(-1)?.find((j: { id: string }) => j.id === importJob);
    const media = (await client.ok("project.get", {})).project.media[0];
    check(importPhase?.phase === "done" && media?.path === "media/uploads/drone take.mp4" && media?.probe?.frames > 0, `imported on the server (ffprobe there): ${media?.path}, ${media?.probe?.width}x${media?.probe?.height}, ${media?.probe?.frames} frames`);
    await client.ok("project.edit", { ops: [{ op: "insert_item", track: "main", item: { id: "c1", type: "clip", media: media.id, in: 0, duration: Math.min(60, media.probe.frames) } }], summary: "clip" });
    const onTimeline = (await client.ok("project.get", {})).project.tracks.some((t: { items: Array<{ id: string }> }) => t.items.some((i) => i.id === "c1"));
    check(onTimeline, "the clip is on the timeline");

    // One scripted agent turn, run by the server there (its claude, its MCP bridge).
    ssh('cat > "$HOME/plan.json"', JSON.stringify([[
      { tool: "project_read", args: {} },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "A title", ops: [{ op: "insert_text", look: "text.big-title", text: "Made in a container", start: 0, duration: 45, id: "title" }] } },
      { text: "Added a title over the start." },
    ]]));
    ssh(': > "$HOME/results.jsonl"; : > "$HOME/prompts.jsonl"');
    await agent.until((s) => s?.dir === dir, 20000);
    const { turnId } = await client.ok("agent.send", { prompt: "Put a title over the start" });
    await agent.until((s) => s?.turns?.some((t: { id: string; status: string }) => t.id === turnId && t.status !== "running"), 120000);
    const turn = agent.values.at(-1).turns.find((t: { id: string }) => t.id === turnId);
    const results = ssh('cat "$HOME/results.jsonl"').trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { tool: string; result: { isError?: boolean } });
    const hasTitle = (await client.ok("project.get", {})).project.tracks.some((t: { items: Array<{ id: string }> }) => t.items.some((i) => i.id === "title"));
    check(turn.status === "done" && results.length >= 2 && results.every((r) => !r.result.isError) && hasTitle, `agent turn ${turn.status}${turn.error ? ` (${turn.error})` : ""}: ${results.map((r) => r.tool).join(", ")}; the title is in the project`);

    // Export without a rasteriser: what a Linux server does out of the box.
    const output = "/home/uncut/Remote cut.mp4";
    const runExport = async () => {
      const started = await client!.ok("export.start", { output, quality: "draft", loudness: "off" });
      await exports.until((list) => list.some((j: { id: string; phase: string }) => j.id === started.jobId && ["done", "failed", "cancelled"].includes(j.phase)), 300000);
      return { jobId: started.jobId as string, job: exports.values.at(-1).find((j: { id: string }) => j.id === started.jobId) as { phase: string; error?: string } };
    };
    const first = await runExport();
    if (first.job.phase === "failed") gap(`export on a Linux server without UNCUT_RENDER_BIN fails before any frame: "${first.job.error}" (every export starts the Electron rasteriser, even with no text, for the background)`);
    else check(true, "export without a rasteriser configured (unexpected: it worked)");

    // Closing the ssh session that started the server: does the server go with it?
    client.close();
    client = undefined;
    server.proc.kill("SIGTERM");
    await new Promise((r) => (server.proc.exitCode !== null ? r(undefined) : server.proc.once("exit", r)));
    await sleep(1500);
    const survivors = ssh(`pgrep -f ${shellQuote(SERVER_PATTERN)} || true`).trim();
    if (survivors) gap(`closing the ssh session that started the server leaves it running there (pid ${survivors.replace(/\n/g, ", ")}): no pty, so no SIGHUP; stopped with pkill`);
    else check(true, "closing the ssh session stopped the server there");
    ssh(`pkill -f ${shellQuote(SERVER_PATTERN)} || true`);
    for (let i = 0; i < 50 && ssh(`pgrep -f ${shellQuote(SERVER_PATTERN)} || true`).trim(); i++) await sleep(100);

    // Start it again with Electron as the rasteriser (on the container's Xvfb display).
    log("restarting the server over ssh with UNCUT_RENDER_BIN=Electron on Xvfb ...");
    server = await startServer(true);
    check(ssh('cat "$HOME/.uncut-server/server-token"').trim() === token && server.stderr().includes(token), "after a restart the server keeps its token (same pairing)");
    for (let i = 0; i < 50; i++) {
      if ((await fetch(`${base}/api/ping`).then((r) => r.status, () => 0)) === 401) break;
      await sleep(100);
    }
    client = await connect(relay.port, relay.token);
    const exports2 = client.subscribe("export.jobs");
    const reopened = await client.ok("project.open", { dir });
    check(reopened.project.tracks.some((t: { items: Array<{ id: string }> }) => t.items.some((i) => i.id === "title")), "project.open over the same tunnel and relay after the restart");
    const started = await client.ok("export.start", { output, quality: "draft", loudness: "off" });
    await exports2.until((list) => list.some((j: { id: string; phase: string }) => j.id === started.jobId && ["done", "failed", "cancelled"].includes(j.phase)), 300000);
    const job = exports2.values.at(-1).find((j: { id: string }) => j.id === started.jobId) as { phase: string; error?: string };
    check(job.phase === "done", `export on the server with Electron as the rasteriser: ${job.phase}${job.error ? ` (${job.error})` : ""}`);
    if (job.phase === "done") {
      const res = await fetch(`${relay.httpBase}/api/export/${started.jobId}?token=${relay.token}`);
      const downloaded = Buffer.from(await res.arrayBuffer());
      const local = join(root, "Remote cut.mp4");
      writeFileSync(local, downloaded);
      const there = remoteSha(output);
      check(res.status === 200 && sha256(downloaded) === there, `download via /api/export: ${downloaded.length} bytes, sha256 ${sha256(downloaded).slice(0, 16)}… = ssh sha256sum ${there?.slice(0, 16)}…`);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", local], { encoding: "utf8" }));
      const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
      check(!!video && Number(probe.format.duration) > 1.5, `the download plays: ${video?.width}x${video?.height}, ${Number(probe.format.duration).toFixed(2)} s`);
      // The title was drawn: a frame inside it (0.8 s, after its entrance) differs from the same frame of the clip alone.
      const frame = (file: string) => execFileSync("ffmpeg", ["-v", "error", "-ss", "0.8", "-i", file, "-vf", `scale=${video.width}:${video.height}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 64 * 1024 * 1024 });
      const a = frame(local);
      const b = frame(clip);
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 40) diff++;
      check(diff > a.length * 0.005, `the title is in the exported picture (${((diff / a.length) * 100).toFixed(1)}% of the frame at 0.8 s differs from the clip)`);
    }

    if (options.app) {
      // The server is single-session: close the project so the app starts on its Welcome. A fresh
      // server's data dir has no settings, so the app would show that server's setup first (as it should).
      await client.ok("project.close", {});
      ssh(`printf '%s' '{"onboarded":true}' > "$HOME/.uncut-server/settings.json"`);
      client.close();
      client = undefined;
      await appCheck({ base, token, pairing, check, gap, log, root, hostname });
    }
  } catch (error) {
    failed = true;
    checks.push({ outcome: "FAIL", what: (error as Error).message });
    log(`  FAIL ${(error as Error).message}`);
    if (containerStarted) {
      const logs = spawnSync("docker", ["logs", "--tail", "40", container], { encoding: "utf8" });
      log(`--- docker logs ${container} ---\n${logs.stdout}${logs.stderr}`);
    }
  } finally {
    client?.close();
    await relay?.close();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    cleanupSync();
    if (options.keep) log(`kept: container ${container}, temp folder ${root} (docker rm -f ${container}; rm -rf it when done)`);
  }
  return { checks, ok: !failed && checks.every((c) => c.outcome !== "FAIL") };
}

/** A free port on this Mac's loopback, other than `avoid`. */
async function freeLocalPort(avoid: number): Promise<number> {
  const { createServer } = await import("node:net");
  for (;;) {
    const port = await new Promise<number>((res, rej) => {
      const s = createServer();
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => res(p));
      });
    });
    if (port !== avoid) return port;
  }
}

/** What --app uses of test/helpers/app.ts (puppeteer's Page, structurally). */
interface AppPage {
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  waitForFunction(expression: string, options: { timeout: number }): Promise<unknown>;
  $eval<T>(selector: string, fn: (el: never) => T): Promise<T>;
  screenshot(options: { path: string }): Promise<unknown>;
}
interface AppHelpers {
  launchApp(options: { command: string; env: Record<string, string> }): Promise<{ page: AppPage; errors: Array<string>; output: () => string; close: () => Promise<void> }>;
  lockApps(): Promise<void>;
  unlockApps(): void;
  waitForWelcome(page: AppPage): Promise<unknown>;
}

/** --app: the packaged app (background window) pairs with the container through the tunnel. */
async function appCheck(c: {
  base: string;
  token: string;
  pairing: string | undefined;
  check: (ok: boolean, what: string) => boolean;
  gap: (what: string) => void;
  log: (l: string) => void;
  root: string;
  hostname: string;
}) {
  if (!existsSync(APP)) {
    c.check(false, `--app: ${APP} isn't built (pnpm dist)`);
    return;
  }
  // Loaded only here: the helper pulls in puppeteer.
  // (A computed specifier: test/helpers/app.ts needs the DOM lib, which scripts aren't checked with.)
  const helpers = (await import(["..", "test", "helpers", "app.ts"].join("/"))) as AppHelpers;
  const { launchApp, lockApps, unlockApps, waitForWelcome } = helpers;
  mkdirSync("test-output", { recursive: true });
  const data = join(c.root, "local-data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "settings.json"), JSON.stringify({ onboarded: true }));
  mkdirSync(join(c.root, "no-plugins"), { recursive: true });
  // The pairing line the user would paste, with the tunnel's address (see the GAP above).
  const line = `uncut://pair?url=${encodeURIComponent(c.base)}&token=${encodeURIComponent(c.token)}`;
  await lockApps();
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    app = await launchApp({
      command: APP,
      env: {
        UNCUT_DATA_DIR: data,
        UNCUT_PLUGINS_DIR: join(c.root, "no-plugins"),
        UNCUT_SHELL_ENV: "off",
        UNCUT_TEST_KEYS: "standin",
        UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts"),
        UNCUT_GOOGLE_BASE: "http://127.0.0.1:9",
        UNCUT_OPENAI_BASE: "http://127.0.0.1:9",
        UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9",
      },
    });
    const page = app.page;
    const waitFor = (selector: string, timeout = 30000) => page.waitForSelector(selector, { timeout });
    await waitForWelcome(page);
    await page.click("[data-testid=env-chip]");
    await waitFor("[data-testid=environments]");
    await page.click("[data-testid=env-add]");
    await waitFor("[data-testid=env-add-form]");
    await page.type("[data-testid=env-add-name]", "Docker");
    await page.type("[data-testid=env-add-url]", line);
    await page.click("[data-testid=env-add-test]");
    await waitFor("[data-testid=env-add-result]");
    const tested = await page.$eval("[data-testid=env-add-result]", (el: { dataset: { ok?: string }; textContent: string }) => ({ ok: el.dataset.ok, text: el.textContent.trim() }));
    c.check(tested.ok === "true", `app: Test connection through the tunnel: ${tested.text}`);
    await page.click("[data-testid=env-add-save]");
    await waitFor("[data-testid=env-row][data-kind=remote]");
    await page.click("[data-testid=env-row][data-kind=remote] [data-testid=env-switch]");
    await page.waitForFunction('document.querySelector("[data-testid=env-chip]")?.dataset.kind === "remote" && document.querySelector("[data-testid=env-chip]")?.dataset.state === "connected"', { timeout: 30000 });
    await waitFor("[data-testid=welcome]");
    const lead = await page.$eval("[data-testid=welcome-lead]", (el: { textContent: string }) => el.textContent.trim());
    c.check(/Docker/.test(lead), `app: switched to the container ("${lead}")`);
    await page.click("[data-testid=open-project]");
    await waitFor("[data-testid=remote-browser][data-purpose=project]");
    await waitFor("[data-testid=remote-entry][data-name='Remote cut.uncut'][data-project=true]");
    const dirShown = await page.$eval("[data-testid=remote-browser-dir]", (el: { textContent: string }) => el.textContent.trim());
    await page.click("[data-testid=remote-entry][data-name='Remote cut.uncut']");
    await page.screenshot({ path: "test-output/remote-docker-browser.png" });
    c.check(/home\/uncut|~/.test(dirShown), `app: the remote browser lists the container's home (${dirShown}): test-output/remote-docker-browser.png`);
    await page.click("[data-testid=remote-browser-choose]");
    await waitFor("[data-testid=editor]");
    await page.waitForFunction('[...document.querySelectorAll("video")].some((v) => v.src.startsWith("http://127.0.0.1:") && v.readyState >= 2)', { timeout: 30000 }).catch(() => undefined);
    await sleep(1000);
    await page.screenshot({ path: "test-output/remote-docker-editor.png" });
    const project = await page.$eval("[data-testid=project-dir]", (el: { title: string }) => el.title);
    c.check(project === "/home/uncut/Remote cut.uncut", `app: the container's project open in the editor (${project}): test-output/remote-docker-editor.png`);
    const errors = app.errors.filter((e) => !/Failed to load resource/.test(e));
    c.check(errors.length === 0, `app: no renderer errors${errors.length ? `: ${errors.join(" | ").slice(0, 400)}` : ""}`);
  } catch (error) {
    await app?.page.screenshot({ path: "test-output/remote-docker-failure.png" }).catch(() => undefined);
    c.check(false, `app: ${(error as Error).message.split("\n")[0]} (test-output/remote-docker-failure.png)\n${app?.output().slice(-2000) ?? ""}`);
  } finally {
    await app?.close();
    unlockApps();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !["--app", "--clean", "--keep"].includes(a));
  if (unknown.length) {
    console.error(`Unknown option ${unknown.join(" ")}. Use --app, --clean, --keep.`);
    process.exit(2);
  }
  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  if (docker.status !== 0) {
    console.error("Docker isn't running (docker info failed). Start Docker Desktop and run this again.");
    process.exit(2);
  }
  const started = Date.now();
  const result = await remoteDockerCheck({ app: args.includes("--app"), clean: args.includes("--clean"), keep: args.includes("--keep") });
  const count = (o: Outcome) => result.checks.filter((c) => c.outcome === o).length;
  console.log(`\n${result.ok ? "PASS" : "FAIL"}: ${count("PASS")} passed, ${count("FAIL")} failed, ${count("GAP")} gaps (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  process.exit(result.ok ? 0 : 1);
}
