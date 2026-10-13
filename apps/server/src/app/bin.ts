import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { readConfig, readLaunchOptions } from "./config.ts";
import { makeServerLayer, openSockets } from "./server.ts";
import { fallbackPathDirs, mergePath, resolveShellEnvironment } from "./shellEnv.ts";

const launch = readLaunchOptions(process.argv.slice(2));
const envToken = process.env.UNCUT_TOKEN || undefined;
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

const config = readConfig(process.env, launch.bootstrapToken ?? envToken, { apiKeyInEnv, shellReady }, launch.keysFd);

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
