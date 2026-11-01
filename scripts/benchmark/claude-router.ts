#!/usr/bin/env node
// UNCUT_CLAUDE for the benchmark. The real Claude Code answers the critic, and the builder too in
// agent mode; in seeded mode the stand-in plays the scripted builder, so only the critic costs
// tokens. Every real run's result message is appended to $BENCH_USAGE_LOG with its process id.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("--system-prompt") + 1] ?? "";
const critic = argv.includes("--system-prompt") && prompt.startsWith("[uncut-critic]");
const real = critic || process.env.BENCH_BUILDER === "real";
const target = real ? process.env.BENCH_REAL_CLAUDE! : process.env.BENCH_FAKE_CLAUDE!;

const child = spawn(target, argv, { stdio: ["inherit", "pipe", "inherit"] });
const logResult = (line: string) => {
  if (!real || !line.includes('"type":"result"')) return;
  const message = JSON.parse(line) as Record<string, unknown>;
  const { total_cost_usd: cost, usage, duration_ms: ms, modelUsage } = message;
  appendFileSync(
    process.env.BENCH_USAGE_LOG!,
    `${JSON.stringify({ pid: child.pid, critic, cost, usage, ms, models: Object.keys((modelUsage as object) ?? {}) })}\n`,
  );
};
createInterface({ input: child.stdout! }).on("line", (line) => {
  process.stdout.write(`${line}\n`);
  logResult(line);
});
child.on("exit", (code) => process.exit(code ?? 1));
