import { gateEnv } from "./env.ts";
import { Escalation } from "./errors.ts";
import { runChild } from "./process.ts";
import { remainingMs, step, writeStepLog, type RunContext } from "./run-context.ts";
import { tail } from "./text.ts";
import type { Command } from "./config.ts";

const FAILURE_TAIL_CHARS = 8000;

export interface GateFailure {
  readonly name: string;
  readonly output: string;
}

function runPnpm(ctx: RunContext, command: Command, cwd: string) {
  const { cfg, paths } = ctx;
  return runChild(cfg.pnpmBin, command.args, { cwd, env: gateEnv(cfg.env, paths), timeoutMs: remainingMs(ctx) });
}

export async function runGates(ctx: RunContext, worktree: string, round: number): Promise<GateFailure | undefined> {
  for (const gate of ctx.cfg.gates) {
    const failure = await step(ctx, `gate ${gate.name} round ${round}`, async () => {
      const child = await runPnpm(ctx, gate, worktree);
      writeStepLog(ctx, `gate-${gate.name}`, `${child.stdout}\n${child.stderr}\n`);
      return child.code === 0 ? undefined : { name: gate.name, output: tail(`${child.stdout}\n${child.stderr}`, FAILURE_TAIL_CHARS) };
    });
    if (failure !== undefined) return failure;
  }
  return undefined;
}

export async function runSetup(ctx: RunContext, worktree: string) {
  for (const command of ctx.cfg.setup) {
    await step(ctx, `setup ${command.name}`, async () => {
      const child = await runPnpm(ctx, command, worktree);
      writeStepLog(ctx, `setup-${command.name}`, `${child.stdout}\n${child.stderr}\n`);
      if (child.code !== 0) throw new Escalation("setup", `${command.name} failed`);
    });
  }
}
