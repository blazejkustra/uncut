// Connect over SSH against a real Linux container (scripts/remote-docker-check.ts): real ssh, a real
// tunnel, the relay, upload, import, an agent turn (the scripted claude), export and download.
// Opt-in: needs Docker running and builds an image the first time. UNCUT_DOCKER_IT=1 pnpm test:file test/remote/docker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const skip = process.env.UNCUT_DOCKER_IT === "1" ? false : "set UNCUT_DOCKER_IT=1 (needs Docker)";

test("Connect over SSH to a Linux container: pair, browse, upload, edit, agent turn, export and download", { skip, timeout: 30 * 60 * 1000 }, async () => {
  const { remoteDockerCheck } = await import("../../scripts/remote-docker-check.ts");
  const result = await remoteDockerCheck({ log: (l) => console.log(`# ${l}`) });
  assert.ok(
    result.ok,
    result.checks
      .filter((c) => c.outcome === "FAIL")
      .map((c) => c.what)
      .join("\n"),
  );
});
