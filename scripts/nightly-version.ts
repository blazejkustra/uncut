// The nightly's version (.github/workflows/nightly.yml): the next patch after apps/desktop/package.json's
// version, the UTC date and the run number (0.0.4 → 0.0.5-nightly.20261024.12), written into
// apps/desktop/package.json of the CI checkout (never committed), which makes `pnpm dist:signed`
// build Uncut Nightly (apps/desktop/src/channel.ts). Prints version= and tag= (the GITHUB_OUTPUT lines).
//   node scripts/nightly-version.ts --run 12 [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { nightlyVersion } from "../apps/desktop/src/channel.ts";

const { values } = parseArgs({ options: { run: { type: "string" }, write: { type: "boolean", default: false } } });
const run = Number(values.run);
const pkgPath = resolve(import.meta.dirname, "../apps/desktop/package.json");
const source = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(source) as { version: string };
const version = nightlyVersion(pkg.version, new Date(), run);
if (values.write) writeFileSync(pkgPath, source.replace(`"version": "${pkg.version}"`, `"version": "${version}"`));
console.log(`version=${version}\ntag=v${version}`);
