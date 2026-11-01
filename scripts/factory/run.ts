import { defaultConfig } from "./config.ts";
import { runOnce } from "./orchestrator.ts";
import { killChildrenOnSignals } from "./process.ts";

killChildrenOnSignals();
const result = await runOnce(defaultConfig());
console.log(JSON.stringify(result));
if (result.outcome === "refused") process.exitCode = 1;
