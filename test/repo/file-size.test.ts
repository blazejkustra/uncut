// No source file over MAX_LINES: a file that long wants splitting into modules. The files already
// over it are listed with their size when the check came in; each may shrink but not grow, and
// leaves the list once it's under the limit. Vendored libraries and data (assets/, JSON, the
// licence notices) aren't code and aren't counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MAX_LINES = 1000;
const CODE = /\.(ts|tsx|js|mjs|cjs|css|rs|swift)$/;
const SKIP = /^assets\//;

/** The files over the limit when the check came in, at their size then. */
const GRANDFATHERED: Readonly<Record<string, number>> = {
  "apps/web/src/uiparts/runtime.ts": 1963,
  "test/export/export.test.ts": 1919,
  "apps/web/src/styles.css": 1766,
  "apps/server/src/agent/criticMotion.ts": 1671,
  "test/agent/critic-motion.test.ts": 1364,
  "test/agent/agent-permission-rules.test.ts": 1296,
  "scripts/sfx-synth.ts": 1177,
  "apps/server/src/agent/tools/cards.ts": 1154,
  "test/agent/agent-production.test.ts": 1080,
  "test/core/text-cut.test.ts": 1013,
};

// Tracked files plus untracked, not ignored ones, so a new file is checked before it's committed.
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => CODE.test(f) && !SKIP.test(f) && existsSync(f));
const lines = (f: string) => readFileSync(f, "utf8").split("\n").length - 1;

test(`no source file is over ${MAX_LINES} lines`, () => {
  const over = files.filter((f) => !(f in GRANDFATHERED)).flatMap((f) => (lines(f) > MAX_LINES ? [`${f}: ${lines(f)} lines`] : []));
  assert.deepEqual(over, [], `split these into smaller modules (at most ${MAX_LINES} lines each)`);
});

test("the files already over the limit don't grow, and leave the list once they're under it", () => {
  const grown = Object.entries(GRANDFATHERED).flatMap(([f, max]) => {
    if (!existsSync(f)) return [`${f}: gone, remove it from GRANDFATHERED`];
    const n = lines(f);
    if (n <= MAX_LINES) return [`${f}: ${n} lines, under the limit now, remove it from GRANDFATHERED`];
    return n > max ? [`${f}: ${n} lines, was ${max}; split it rather than grow it`] : [];
  });
  assert.deepEqual(grown, []);
});
