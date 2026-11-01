import { defaultConfig, factoryPaths, type FactoryConfig } from "./config.ts";
import type { LedgerEntry } from "./orchestrator.ts";
import { isStopped, lockHolder, pausedUntil, readJsonl } from "./state.ts";

const RECENT_RUNS = 10;

function describeRun(entry: LedgerEntry) {
  const issue = entry.issue === undefined ? "no issue" : `#${entry.issue}`;
  const where = entry.stage === undefined ? "" : ` at ${entry.stage}`;
  return `${entry.finishedAt} ${entry.outcome} ${issue}${where} ${entry.prUrl ?? entry.detail ?? ""}`.trimEnd();
}

export function statusText(cfg: FactoryConfig) {
  const paths = factoryPaths(cfg.home);
  const holder = lockHolder(paths.lock);
  const until = pausedUntil(paths);
  const runs = readJsonl<LedgerEntry>(paths.ledger);
  return [
    `Kill switch: ${isStopped(paths) ? `on (${paths.stop})` : "off"}`,
    `Usage pause: ${until === undefined ? "none" : `until ${until.toISOString()}`}`,
    `Running: ${holder === undefined ? "no" : `yes, pid ${holder}`}`,
    `Runs recorded: ${runs.length}`,
    ...runs.slice(-RECENT_RUNS).map(describeRun),
  ].join("\n");
}

if (import.meta.main) console.log(statusText(defaultConfig()));
