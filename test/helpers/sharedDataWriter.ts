// One "window's server" for test/server/shared-data.test.ts: touches recents and saves plugin
// approvals in a data dir another process writes to at the same time.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { layer as configLayer, type ServerConfigShape } from "../../apps/server/src/app/config.ts";
import { layer as settingsLayer, Settings } from "../../apps/server/src/app/settings.ts";
import { layer as recentsLayer, Recents } from "../../apps/server/src/project/recents.ts";

// effect and its Node platform are the server's dependencies, not the repo root's.
const fromServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const load = (id: string) => import(pathToFileURL(fromServer.resolve(id)).href);
const NodeServices = (await load(
  "@effect/platform-node/NodeServices",
)) as typeof import("../../apps/server/node_modules/@effect/platform-node/dist/NodeServices.js");
const Effect = (await load("effect/Effect")) as typeof import("../../apps/server/node_modules/effect/dist/Effect.js");
const Layer = (await load("effect/Layer")) as typeof import("../../apps/server/node_modules/effect/dist/Layer.js");

const [dataDir, label, countText] = process.argv.slice(2);
const count = Number(countText);
const base = Layer.merge(configLayer({ dataDir } as ServerConfigShape), NodeServices.layer);
const services = Layer.merge(recentsLayer, settingsLayer).pipe(Layer.provide(base));

const approval = (i: number) => ({
  dir: `/plugins/${label}-${i}`,
  version: "1.0.0",
  command: "node",
  args: [],
  capabilities: [],
  approvedAt: new Date().toISOString(),
});

const program = Effect.gen(function* () {
  const recents = yield* Recents;
  const settings = yield* Settings;
  for (let i = 0; i < count; i++) {
    yield* recents.touch(`/nowhere/${label}-${i}.uncut`, `${label}-${i}`);
    yield* settings.setPluginApproval(`${label}-${i}`, approval(i));
  }
});

await Effect.runPromise(program.pipe(Effect.provide(services)));
