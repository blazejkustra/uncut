import { defaultConfig } from "./config.ts";
import { runOnce } from "./orchestrator.ts";
import { killLiveChildren } from "./process.ts";

function exitAfterKillingChildren(code: number) {
  killLiveChildren();
  process.exit(code);
}

process.once("SIGINT", () => exitAfterKillingChildren(130));
process.once("SIGTERM", () => exitAfterKillingChildren(143));

const result = await runOnce(defaultConfig());
console.log(JSON.stringify(result));
if (result.outcome === "refused") process.exitCode = 1;
