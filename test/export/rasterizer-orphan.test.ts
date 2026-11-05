// The export rasteriser (apps/desktop/src/render.ts) ends when its server goes. A server gone before
// the rasteriser said it was ready left it writing to a closed pipe: the EPIPE was an uncaught
// exception, Electron's error dialog held its main thread, and the process stayed (SIGTERM too),
// reparented to launchd. Here the server's ends of its pipes close at once, as when it dies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { rasterizerCommand } from "../../apps/server/src/export/rasterizer.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const skip = existsSync(DESKTOP) ? false : "desktop not built (run pnpm build)";

const exitWithin = (child: ReturnType<typeof spawn>, ms: number) =>
  new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      done(true);
    });
  });

test("the rasteriser exits when its server is gone before it is ready", { skip, timeout: 60000 }, async () => {
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const profile = mkdtempSync(join(tmpdir(), "uncut-render-orphan-"));
  const child = spawn(command.bin, [...command.args, `--uncut-profile=${profile}`], { env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    child.stdin!.destroy();
    child.stdout!.destroy();
    child.stderr!.destroy();
    assert.ok(await exitWithin(child, 30000), "the rasteriser still runs 30 s after its server's pipes closed");
  } finally {
    child.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  }
});
