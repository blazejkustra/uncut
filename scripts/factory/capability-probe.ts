// Proof from this Mac and from inside the packaged app that the gated checks can really run, which
// a test that merely reports no skips can't give.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { skippedCheck, type Check } from "./report.ts";

export interface Capabilities {
  readonly noRealGpu?: string;
  readonly noRealAudio?: string;
  readonly adapter?: { readonly vendor: string; readonly architecture: string; readonly fallback: boolean };
  readonly frameMs: number | null;
}

const MAX_FRAME_MS = 100;
const PROBE_TIMEOUT_MS = 120000;
const PROBE = fileURLToPath(new URL("../../test/factory/capability-probe.ts", import.meta.url));

export function capabilityProblems({ noRealGpu, noRealAudio, adapter, frameMs }: Capabilities) {
  const problems = [noRealGpu, noRealAudio].filter((reason): reason is string => Boolean(reason));
  if (!adapter) problems.push("no WebGPU adapter in the packaged app");
  else if (adapter.fallback) problems.push(`the WebGPU adapter (${adapter.vendor}) is a software fallback`);
  if (frameMs === null || frameMs >= MAX_FRAME_MS) problems.push(`animation frames every ${frameMs} ms: the display isn't drawing`);
  return problems;
}

export function probeCapabilities(binary: string): Check {
  const started = Date.now();
  const id = "capabilities";
  const title = "A real GPU, audio output and live display, seen from the packaged app";
  const r = spawnSync(process.execPath, [PROBE, binary], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  if (r.status !== 0) return skippedCheck(id, title, `the probe failed: ${(r.stderr || String(r.error)).slice(-600)}`);
  const capabilities = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Capabilities;
  const problems = capabilityProblems(capabilities);
  const base = { id, title, required: true, values: { ...capabilities }, durationMs: Date.now() - started };
  return problems.length ? { ...base, status: "skipped", reason: problems.join("; ") } : { ...base, status: "pass" };
}
