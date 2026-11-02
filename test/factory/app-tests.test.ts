import { test } from "node:test";
import assert from "node:assert/strict";

import { fileCheck, judged, parseTap, type FileRun } from "../../scripts/factory/app-tests.ts";
import { capabilityProblems } from "../../scripts/factory/capability-probe.ts";

const TAP = `TAP version 13
# Subtest: one
ok 1 - one
  ---
  duration_ms: 12
  ...
# Subtest: two
not ok 2 - two
  ---
  ...
# Subtest: three
ok 3 - three # SKIP needs a real GPU
# frame 30: SSIM 0.991
# not checked (needs a real GPU): preview vs export
1..3
# tests 3
# pass 1
# fail 1
# skipped 1
# duration_ms 12.5
`;

test("parseTap counts results, skip reasons and the file's own log lines", () => {
  const tap = parseTap(TAP);
  assert.equal(tap.passed, 1);
  assert.deepEqual(tap.failed, ["two"]);
  assert.deepEqual(tap.skipped, ["needs a real GPU"]);
  assert.deepEqual(tap.logs, ["frame 30: SSIM 0.991", "not checked (needs a real GPU): preview vs export"]);
});

const run = ({ tap, ...overrides }: Partial<Omit<FileRun, "tap">> & { readonly tap?: Partial<FileRun["tap"]> }): FileRun => ({
  file: "test/app/x.test.ts",
  exit: 0,
  timedOut: false,
  attempts: 1,
  durationMs: 1,
  ...overrides,
  tap: { passed: 2, failed: [], skipped: [], logs: [], ...tap },
});

test("a file that ran clean passes and shows what it measured", () => {
  const check = fileCheck(run({ tap: { logs: ["frame 30: SSIM 0.991", "unrelated"] } }));
  assert.equal(check.status, "pass");
  assert.deepEqual(check.values?.measured, ["frame 30: SSIM 0.991"]);
});

test("a failed test fails the file", () => {
  const check = fileCheck(run({ exit: 1, tap: { failed: ["two"] } }));
  assert.equal(check.status, "fail");
  assert.deepEqual(check.problems, ["two"]);
});

test("a crash with no failed test listed still fails", () => {
  assert.equal(fileCheck(run({ exit: 1 })).status, "fail");
});

test("a test skipped for a capability is a required skip, not a pass", () => {
  const check = fileCheck(run({ tap: { skipped: ["needs a real GPU"] } }));
  assert.equal(check.status, "skipped");
  assert.equal(check.required, true);
});

test("a check() inside a passing test that stood down is a required skip", () => {
  const check = fileCheck(run({ tap: { logs: ["not checked (needs a real GPU): frame 3: SSIM 0.9"] } }));
  assert.equal(check.status, "skipped");
  assert.equal(check.required, true);
});

test("a file that ran no test proves nothing", () => {
  assert.equal(fileCheck(run({ tap: { passed: 0 } })).status, "skipped");
});

test("a timeout is a skip, whatever passed before it", () => {
  assert.equal(fileCheck(run({ timedOut: true, exit: null })).status, "skipped");
});

test("a footage skip inside a file doesn't hold it back", () => {
  const check = fileCheck(run({ tap: { skipped: ["needs a.mp4 in /f (set UNCUT_FOOTAGE_DIR to your footage folder)"] } }));
  assert.equal(check.status, "pass");
  assert.equal(check.values?.skippedExpected, 1);
});

test("a pass on a second attempt is a pass that says it was a flake", () => {
  const check = fileCheck(run({ attempts: 2 }));
  assert.equal(check.status, "pass");
  assert.match(check.reason ?? "", /flake/);
});

const failed = fileCheck(run({ file: "test/app/issue55-app.test.ts", exit: 1, tap: { failed: ["two"] } }));

test("a timing file failing on a calm Mac is a failure", () => {
  assert.equal(judged(failed, 4, 12, undefined).status, "fail");
});

test("a timing file failing on a loaded Mac is a required skip, so never a pass", () => {
  const check = judged(failed, 30, 12, undefined);
  assert.equal(check.status, "skipped");
  assert.equal(check.required, true);
  assert.match(check.reason ?? "", /load 30/);
});

test("any other file fails whatever the load", () => {
  assert.equal(judged(fileCheck(run({ exit: 1, tap: { failed: ["two"] } })), 30, 12, undefined).status, "fail");
});

test("a quarantined failure is reported beside the verdict; a pass or a stood-down check stays what it was", () => {
  const check = judged(failed, 4, 12, "fails on main");
  assert.equal(check.status, "skipped");
  assert.equal(check.required, false);
  assert.match(check.reason ?? "", /quarantined: fails on main/);
  assert.equal(judged(fileCheck(run({})), 4, 12, "fails on main").status, "pass");
  assert.equal(judged(fileCheck(run({ tap: { skipped: ["needs a real GPU"] } })), 4, 12, "fails on main").required, true);
});

const real = { adapter: { vendor: "apple", architecture: "metal-3", fallback: false }, frameMs: 16.6 };

test("capabilityProblems accepts a real GPU on a drawing display", () => {
  assert.deepEqual(capabilityProblems(real), []);
});

test("capabilityProblems names a virtual GPU, a missing or fallback adapter and a sleeping display", () => {
  assert.equal(capabilityProblems({ ...real, noRealGpu: "a VM", noRealAudio: "virtual output" }).length, 2);
  assert.match(capabilityProblems({ frameMs: 16 })[0]!, /no WebGPU adapter/);
  assert.match(capabilityProblems({ ...real, adapter: { ...real.adapter, fallback: true } })[0]!, /software fallback/);
  assert.match(capabilityProblems({ ...real, frameMs: null })[0]!, /isn't drawing/);
});
