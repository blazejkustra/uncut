// Issue #103 (D278): THIRD_PARTY_NOTICES comes from what the bundles actually contain, with each
// package's full licence text (and NOTICE), the t3code patterns, and the brand-mark trademark line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isConcerning, npmPackages, packageDirOf, render } from "../../scripts/notices.ts";

test("the npm list is what the bundles hold, devDependencies that get bundled included", async () => {
  assert.match(packageDirOf("../../node_modules/.pnpm/ws@8.22.0/node_modules/ws/lib/x.js")!, /node_modules\/ws$/);
  assert.match(packageDirOf("node_modules/.pnpm/@opentelemetry+api@1.9.1/node_modules/@opentelemetry/api/build/a.js")!, /node_modules\/@opentelemetry\/api$/);
  assert.equal(packageDirOf("apps/server/src/app/bin.ts"), undefined);
  const names = (await npmPackages()).map((p) => p.name);
  for (const n of ["effect", "react", "react-dom", "ws", "@opentelemetry/sdk-logs"]) assert.ok(names.includes(n), n);
  // Bundled into the desktop's main once the updater exists (#102).
  if (readFileSync("apps/desktop/package.json", "utf8").includes("electron-updater")) for (const n of ["electron-updater", "builder-util-runtime", "js-yaml", "lazy-val"]) assert.ok(names.includes(n), n);
  // Build tools are not in the app.
  for (const n of ["esbuild", "vite", "electron-builder", "typescript"]) assert.ok(!names.includes(n), n);
  for (const p of await npmPackages()) assert.ok(!isConcerning(p.license), `${p.name}: ${p.license}`);
});

test("the notices carry full licence texts, t3code and the trademark line, and are up to date", async () => {
  const text = await render();
  assert.equal(readFileSync("THIRD_PARTY_NOTICES", "utf8"), text, "run node scripts/notices.ts");
  assert.match(text, /Licence of: .*react@/);
  assert.match(text, /Apache License\s+Version 2\.0/);
  assert.match(text, /t3code \(MIT\)[\s\S]*agentLimits\.ts[\s\S]*ws\.ts[\s\S]*shellEnv\.ts[\s\S]*server\.ts[\s\S]*Copyright \(c\) 2026 T3 Tools Inc\./);
  assert.match(text, /trademarks of their respective owners/);
  const version = /simple-icons@(\d+\.\d+\.\d+)/.exec(readFileSync("packages/core/src/visual/brandIcons.ts", "utf8"))![1]!;
  for (const m of text.matchAll(/Simple Icons,? (?:simple-icons@)?(\d+\.\d+\.\d+)/g)) assert.equal(m[1], version, "one Simple Icons version, brandIcons.ts's");
  assert.doesNotMatch(text, /bass-boom|Music library/);
});
