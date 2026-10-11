import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { readConfig, readLaunchOptions } from "./config.ts";
import { makeServerLayer, openSockets } from "./server.ts";

const launch = readLaunchOptions(process.argv.slice(2));
const config = readConfig(process.env, launch.bootstrapToken);
// Child processes (the media core, later agent CLIs) must not inherit the token, nor run
// as Node because the desktop started us with ELECTRON_RUN_AS_NODE.
delete process.env.UNCUT_TOKEN;
delete process.env.ELECTRON_RUN_AS_NODE;

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
