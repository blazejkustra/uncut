// Release build of uncut-media without the builder's paths baked in: panics and debug info
// would otherwise carry /Users/<name>/… (the repo and ~/.cargo). Used by pnpm build and dev.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const remaps = [`--remap-path-prefix=${here}=uncut-media/`, `--remap-path-prefix=${homedir()}=~`].join(" ");
const r = spawnSync("cargo", ["build", "--release", "--manifest-path", `${here}Cargo.toml`], {
  stdio: "inherit",
  env: { ...process.env, RUSTFLAGS: [process.env.RUSTFLAGS, remaps].filter(Boolean).join(" ") },
});
process.exit(r.status ?? 1);
