// pnpm dev: build the pieces Electron needs, start the Vite dev server, open the app.
// Closing the window stops everything.
import { spawn, spawnSync } from "node:child_process";

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("cargo", ["build", "--release", "--manifest-path", "native/media/Cargo.toml"]);
run("node", ["apps/server/scripts/build.mjs"]);
run("node", ["apps/desktop/scripts/build.mjs"]);

const url = "http://127.0.0.1:5733/";
const vite = spawn("pnpm", ["--filter", "@uncut/web", "exec", "vite"], { stdio: "inherit" });
for (let i = 0; ; i++) {
  if (await fetch(url).then((r) => r.ok, () => false)) break;
  if (i > 100 || vite.exitCode !== null) {
    console.error("Vite dev server didn't come up");
    vite.kill();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}

const electron = spawn("node_modules/.bin/electron", ["apps/desktop"], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
const stop = () => {
  vite.kill();
  electron.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
electron.on("exit", (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
