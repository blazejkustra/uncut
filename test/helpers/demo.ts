// Tests build their own copy of the demo project from the original footage, so the
// user's fixtures/drone-demo.uncut (which they edit in the app) never affects results.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DJI_CLIP } from "./footage.ts";

const MAKE_DEMO = resolve("scripts/make-demo.ts");
// The DJI clip of test/helpers/footage.ts (UNCUT_FOOTAGE_DIR), or any clip named by UNCUT_FOOTAGE.
export const FOOTAGE = resolve(process.env.UNCUT_FOOTAGE ?? DJI_CLIP);

const hasTool = (tool: string) => !spawnSync(tool, ["-version"], { stdio: "ignore" }).error;
export const skipDemo = !existsSync(FOOTAGE)
  ? `needs the demo footage at ${FOOTAGE} (set UNCUT_FOOTAGE_DIR to your footage folder, or UNCUT_FOOTAGE to a clip)`
  : !hasTool("ffprobe")
    ? "needs ffprobe on PATH to build the demo project"
    : false;

/** Path to a demo project.json generated from the footage; rebuilt when make-demo.ts or the footage changes. */
export function demoProject() {
  const { size, mtimeMs } = statSync(FOOTAGE);
  const key = createHash("sha256").update(readFileSync(MAKE_DEMO)).update(`\0${FOOTAGE}\0${size}\0${mtimeMs}`).digest("hex").slice(0, 16);
  const dir = resolve(`test-output/demo-${key}.uncut`);
  const project = join(dir, "project.json");
  if (existsSync(project)) return project;
  // Build in a private temp dir and rename it into place, so a test file running in
  // parallel never sees a half-written project. If another process got there first, use theirs.
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(resolve("test-output"), { recursive: true });
  execFileSync(process.execPath, [MAKE_DEMO, FOOTAGE, tmp], { stdio: ["ignore", "ignore", "inherit"] });
  try {
    renameSync(tmp, dir);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(project)) throw error;
  }
  return project;
}
