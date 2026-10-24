// Runs the Node server as a child process, like t3code's DesktopBackendManager: the Electron
// binary itself in Node mode (ELECTRON_RUN_AS_NODE), so the packaged app needs no separate
// Node install and the backend doesn't become a second GUI app instance.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Duplex, Writable } from "node:stream";
import * as readline from "node:readline";

import type { ServerConnection } from "@uncut/contracts";

const READY_TIMEOUT_MS = 15_000;
const KILL_AFTER_MS = 1_500;
/** The server's own log in the data dir: its stdout and stderr, when it started and how it ended. */
export const SERVER_LOG = "server.log";
// Past this the log moves to server.log.1 (the one before is dropped), so a long run can't grow it.
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Appends timestamped lines to <dataDir>/server.log. A Finder-launched app's stdout and stderr go
 * nowhere, so this is the only record of why the server stopped answering or died. Never throws.
 */
export function serverLog(dataDir: string, maxBytes = LOG_MAX_BYTES): (text: string) => void {
  const file = join(dataDir, SERVER_LOG);
  let size = -1;
  return (text) => {
    try {
      if (size < 0) {
        try {
          size = statSync(file).size;
        } catch {
          size = 0;
        }
      }
      if (size > maxBytes) {
        try {
          renameSync(file, `${file}.1`);
        } catch {}
        size = 0;
      }
      const at = new Date().toISOString();
      const lines = text
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `${at} ${line}\n`)
        .join("");
      appendFileSync(file, lines, { mode: 0o600 });
      size += Buffer.byteLength(lines);
    } catch {}
  };
}

export interface ServerProcess {
  readonly pid: number | undefined;
  readonly connection: Promise<ServerConnection>;
  readonly running: () => boolean;
  // Resolves once the process is gone: SIGTERM first, SIGKILL if it lingers.
  readonly stop: () => Promise<void>;
}

const parseReadyLine = (line: string): { port: number } | "not-json" | "bad" => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "not-json";
  }
  if (typeof value !== "object" || value === null || !("ready" in value)) return "not-json";
  const port = (value as { port?: unknown }).port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? { port } : "bad";
};

export function startServer(options: {
  serverEntry: string;
  mediaBin: string;
  modulesDir: string;
  // The bundled sound-effects pack (D134).
  sfxDir: string;
  // The libraries graphics load with uncut:lib/ markers (D193).
  graphicLibsDir: string;
  // The bundled fonts graphics load (D198).
  fontsDir: string;
  // Plugins shipped with the app (D97).
  bundledPluginsDir: string;
  // The plugin SDK plugins on the app's Node import (D102).
  pluginSdkDir: string;
  dataDir: string;
  // How the server starts the export rasteriser (this binary with --uncut-render): the entry to
  // run, or undefined when packaged (the binary always runs its bundled main).
  renderEntry: string | undefined;
  onExit: (reason: string) => void;
  // Encrypts and decrypts generator keys for the server (D99: Electron safeStorage, which the
  // server, a plain Node process, can't use). Called only when a key is stored or used.
  keys: { readonly encrypt: (text: string) => string; readonly decrypt: (data: string) => string };
}): ServerProcess {
  const token = randomBytes(24).toString("base64url");
  const log = serverLog(options.dataDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    UNCUT_PORT: "0",
    UNCUT_MEDIA_BIN: options.mediaBin,
    UNCUT_MODULES_DIR: options.modulesDir,
    UNCUT_SFX_DIR: options.sfxDir,
    UNCUT_GRAPHIC_LIBS_DIR: options.graphicLibsDir,
    UNCUT_FONTS_DIR: options.fontsDir,
    UNCUT_BUNDLED_PLUGINS_DIR: options.bundledPluginsDir,
    UNCUT_PLUGIN_SDK_DIR: options.pluginSdkDir,
    UNCUT_DATA_DIR: options.dataDir,
    UNCUT_RENDER_BIN: process.execPath,
    UNCUT_RENDER_ENTRY: options.renderEntry ?? "",
  };
  delete env.UNCUT_TOKEN;
  const child = spawn(process.execPath, [options.serverEntry, "--bootstrap-fd", "3", "--exit-with-stdin", "--keys-fd", "4"], {
    env,
    // stdin stays open and unused: the server exits when it closes, so it can't outlive us.
    // fd 3 carries the token, which would be visible to `ps eww` in the environment.
    // fd 4 is the keys pipe (D99): { id, op, text | data } in, { id, ok, data | text | error } out.
    // stderr is ours too: it goes on to our own stderr and into server.log.
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  log(`[desktop] server started (pid ${child.pid ?? "none"})`);
  // Always drained: a full pipe would block the server's writes. Our stderr may be a pipe whose
  // reader is gone (a closed terminal): EPIPE there mustn't crash main.
  if (!process.stderr.listenerCount("error")) process.stderr.on("error", () => {});
  child.stderr!.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    log(chunk.toString("utf8"));
  });
  const keysPipe = child.stdio[4] as Duplex;
  keysPipe.on("error", () => {});
  readline.createInterface({ input: keysPipe }).on("line", (line) => {
    let msg: { id?: unknown; op?: unknown; text?: unknown; data?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const answer = (reply: Record<string, unknown>) => keysPipe.write(`${JSON.stringify({ id: msg.id, ...reply })}\n`);
    try {
      if (msg.op === "encrypt" && typeof msg.text === "string") answer({ ok: true, data: options.keys.encrypt(msg.text) });
      else if (msg.op === "decrypt" && typeof msg.data === "string") answer({ ok: true, text: options.keys.decrypt(msg.data) });
      else answer({ ok: false, error: "unknown request" });
    } catch (error) {
      // Never the key: only why the Keychain refused.
      answer({ ok: false, error: (error as Error).message.slice(0, 200) });
    }
  });
  const bootstrap = child.stdio[3] as Writable;
  bootstrap.on("error", () => {}); // the child may die before reading it; "exit" reports that
  bootstrap.end(`${JSON.stringify({ token })}\n`);
  child.stdin!.on("error", () => {});

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let ready = false;
  let stopping = false;

  const connection = new Promise<ServerConnection>((resolve, reject) => {
    const fail = (message: string) => {
      log(`[desktop] ${message}`);
      clearTimeout(timer);
      reject(new Error(message));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(`server didn't start within ${READY_TIMEOUT_MS / 1000}s`), READY_TIMEOUT_MS);
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      const echo = () => {
        process.stdout.write(`[server] ${line}\n`);
        log(line);
      };
      if (ready) return echo();
      const parsed = parseReadyLine(line);
      if (parsed === "not-json") return echo();
      if (parsed === "bad") return fail(`server sent a ready line without a valid port: ${line}`);
      ready = true;
      clearTimeout(timer);
      log(`[desktop] server ready on port ${parsed.port}`);
      resolve({ url: `ws://127.0.0.1:${parsed.port}/ws`, token });
    });
    child.once("error", (error) => fail(`can't start server: ${error.message}`));
    child.once("exit", (code, signal) => {
      const how = signal ?? `code ${code}`;
      if (!ready) return fail(`server exited before it was ready (${how})`);
      // Logged once its output is all in, so a crash's stack comes before the verdict.
      const note = stopping ? `[desktop] server stopped (${how})` : `[desktop] server exited unexpectedly (${how})`;
      child.once("close", () => log(note));
      if (!stopping) options.onExit(`server exited unexpectedly (${how})`);
    });
  });
  // The renderer reports failures; don't crash main on an unobserved rejection.
  connection.catch((error: Error) => console.error(`[uncut] ${error.message}`));

  return {
    pid: child.pid,
    connection,
    running: () => child.exitCode === null && child.signalCode === null,
    stop: async () => {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      log("[desktop] stopping the server (SIGTERM)");
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        // A server that can't even take SIGTERM is stuck in synchronous work: worth knowing.
        log(`[desktop] server still running ${KILL_AFTER_MS} ms after SIGTERM (its event loop is blocked?); killing it`);
        console.error(`[uncut] server still running ${KILL_AFTER_MS} ms after SIGTERM; killing it`);
        child.kill("SIGKILL");
      }, KILL_AFTER_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}
