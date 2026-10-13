import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { resolve } from "node:path";

import { isLoopbackHost } from "./auth.ts";
import { dataDirOf, readConfig, readLaunchOptions, type LaunchOptions } from "./config.ts";
import { loadOrCreateToken } from "./pairing.ts";
import { makeServerLayer, openSockets } from "./server.ts";
import { fallbackPathDirs, mergePath, resolveShellEnvironment } from "./shellEnv.ts";

let launch: LaunchOptions;
try {
  launch = readLaunchOptions(process.argv.slice(2));
} catch (error) {
  console.error(`[uncut] ${(error as Error).message}`);
  process.exit(2);
}
const envToken = process.env.UNCUT_TOKEN || undefined;
// Headless (`uncut-server --host/--port/--data-dir`, D106): flags win over the environment.
const headless = launch.host !== undefined || launch.port !== undefined || launch.dataDir !== undefined;
if (launch.dataDir !== undefined) process.env.UNCUT_DATA_DIR = resolve(launch.dataDir);
if (launch.port !== undefined) process.env.UNCUT_PORT = String(launch.port);
// From an installed Uncut.app (ELECTRON_RUN_AS_NODE), the export's rasteriser is the app binary itself.
if (headless && process.versions.electron && !process.env.UNCUT_RENDER_BIN) {
  process.env.UNCUT_RENDER_BIN = process.execPath;
  process.env.UNCUT_RENDER_ENTRY = "";
}
// Child processes (the media core, agent CLIs) must not inherit the token, nor run as Node
// because the desktop started us with ELECTRON_RUN_AS_NODE, nor see an API key (D41).
delete process.env.UNCUT_TOKEN;
delete process.env.ELECTRON_RUN_AS_NODE;
const apiKeyInEnv = Boolean(process.env.ANTHROPIC_API_KEY);
delete process.env.ANTHROPIC_API_KEY;

// A Finder-launched app has launchd's bare PATH. Asking the login shell for the real one takes
// a second or more with a heavy rc file, so don't wait for it: start with the usual install
// folders added, and swap in the shell's PATH when it arrives. Detection (setup.check) waits
// for it; nothing else spawns a tool by name before then. Tests can turn this off.
const shellReady =
  process.env.UNCUT_SHELL_ENV === "off"
    ? Promise.resolve(undefined)
    : (() => {
        const original = { ...process.env };
        process.env.PATH = mergePath(process.env.PATH, fallbackPathDirs(process.env.HOME || undefined).join(":"));
        // resolveShellEnvironment doesn't reject; the catch is a second line of defence so a
        // rejected promise can never be cached or go unhandled.
        return resolveShellEnvironment(original)
          .then((shell) => {
            process.env.PATH = shell.path;
            return shell;
          })
          .catch(() => undefined);
      })();

// The token: the desktop's (bootstrap fd), UNCUT_TOKEN, or a headless server's stored one (made once).
let token = launch.bootstrapToken ?? envToken;
let tokenFile: string | undefined;
if (!token && headless) {
  try {
    const stored = loadOrCreateToken(dataDirOf(process.env));
    token = stored.token;
    tokenFile = stored.file;
  } catch (error) {
    console.error(`[uncut] can't keep a pairing token: ${(error as Error).message}`);
    process.exit(1);
  }
}
const host = launch.host ?? "127.0.0.1";
// Never listen beyond this machine with a throwaway or weak token.
if (!isLoopbackHost(host) && (!token || token.length < 24)) {
  console.error(`[uncut] refusing to listen on ${host} without a pairing token (at least 24 characters): use --data-dir, or set UNCUT_TOKEN`);
  process.exit(1);
}
const config = readConfig(process.env, token, { apiKeyInEnv, shellReady }, launch.keysFd, headless ? { host, tokenFile } : undefined);

// Last line of defence: log instead of dying on a stray rejection.
process.on("unhandledRejection", (reason) => console.error("[uncut] unhandled rejection:", reason));

const fiber = Effect.runFork(Layer.launch(makeServerLayer(config)));
let stopping = false;

// Shutdown must be quick and certain: the desktop app is quitting, or it has died. Open
// WebSockets would otherwise hold the graceful close open, so drop them first, and exit
// after 1 s whatever is still pending.
const stop = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 1000).unref();
  openSockets.destroyAll();
  Effect.runFork(Fiber.interrupt(fiber));
};

fiber.addObserver((exit) => {
  if (Exit.isFailure(exit) && !stopping) {
    console.error(Cause.pretty(exit.cause));
    process.exit(1);
  }
  process.exit(0);
});

process.once("SIGTERM", stop);
process.once("SIGINT", stop);
// The desktop shell holds our stdin open and never writes to it. EOF means it is gone,
// even if it crashed or was SIGKILLed and never got to stop us.
if (launch.exitWithStdin) {
  process.stdin.on("data", () => {});
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
}
