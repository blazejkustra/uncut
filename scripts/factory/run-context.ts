import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { factoryPaths, type FactoryConfig, type FactoryPaths } from "./config.ts";
import { Escalation, Halt } from "./errors.ts";
import { isStopped } from "./state.ts";

export interface StepRecord {
  readonly name: string;
  readonly startedAt: string;
  finishedAt?: string;
  outcome?: "ok" | "failed";
}

export interface RunContext {
  readonly cfg: FactoryConfig;
  readonly paths: FactoryPaths;
  readonly runId: string;
  readonly runDir: string;
  readonly deadline: number;
  readonly steps: Array<StepRecord>;
}

export function newRunContext(cfg: FactoryConfig, kind: string): RunContext {
  const paths = factoryPaths(cfg.home);
  const runId = `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = join(paths.runs, runId);
  mkdirSync(runDir, { recursive: true });
  return { cfg, paths, runId, runDir, deadline: Date.now() + cfg.wallClockMs, steps: [] };
}

export function remainingMs(ctx: RunContext) {
  return ctx.deadline - Date.now();
}

/** The kill switch and the wall clock are read here, so every step starts with both. */
export async function step<T>(ctx: RunContext, name: string, work: () => Promise<T>): Promise<T> {
  if (isStopped(ctx.paths)) throw new Halt("stopped");
  if (remainingMs(ctx) <= 0) throw new Escalation(name, "the run's wall clock limit was reached");
  const record: StepRecord = { name, startedAt: new Date().toISOString() };
  ctx.steps.push(record);
  try {
    const value = await work();
    record.outcome = "ok";
    return value;
  } catch (error) {
    record.outcome = "failed";
    throw error;
  } finally {
    record.finishedAt = new Date().toISOString();
  }
}

export function writeStepLog(ctx: RunContext, name: string, text: string) {
  writeFileSync(join(ctx.runDir, `${name.replace(/[^a-z0-9-]+/gi, "-")}.log`), text, { flag: "a" });
}
