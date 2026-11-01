// The Linux package's layout (scripts/server-package.ts): the server started from it finds its media
// core, modules, plugins and rasteriser entry beside it, with no environment pointing at the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packageServer } from "../../scripts/server-package.ts";
import { BUNDLE, MEDIA, connect, startServer } from "../helpers/server.ts";

const TOKEN = "a-token-long-enough-for-this-test-0123456789";
const skip =
  existsSync(BUNDLE) && existsSync(MEDIA) && existsSync("apps/desktop/dist/main.cjs") ? false : "server, media core or desktop not built (run pnpm build)";

test("the packaged tree runs on its own", { skip, timeout: 30000 }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-package-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, "uncut-server");
  packageServer(out, MEDIA);
  assert.equal(statSync(join(out, "uncut-server")).mode & 0o111, 0o111);
  for (const f of [
    "server/mcp.mjs",
    "render/main.cjs",
    "render/shader-runner.js",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
    "plugin-sdk/index.ts",
    "fonts/OFL.txt",
    "sfx/library.json",
  ]) {
    assert.ok(existsSync(join(out, f)), f);
  }
  const server = await startServer({
    entry: join(out, "server/server.mjs"),
    args: ["--data-dir", join(root, "data"), "--port", "0"],
    env: { UNCUT_MEDIA_BIN: "", UNCUT_MODULES_DIR: "", UNCUT_TOKEN: TOKEN },
    captureStderr: true,
  });
  t.after(() => server.stop());
  const client = await connect(server.ready.port, TOKEN);
  t.after(() => client.close());
  const hello = await client.ok("server.hello", {});
  assert.ok(hello.mediaCore?.version, "the media core beside the server answers");
  const project = await client.ok("project.create", { parentDir: root, name: "Packaged" });
  assert.ok(project.dir, "modules/builtin loads: a project is created");
});
