// Issue #102 (D276): auto-update's rules. Which builds check (only a packaged, team-signed app;
// never dev, ad-hoc or a test run without its own local feed), the feed override (loopback only),
// the schedule (first check after a delay, every 4 h, deferred while busy and run when busy
// clears), install refused while busy, and what counts as busy in the renderer. Nothing here
// touches the network or electron.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  NO_STAGING_ID,
  UPDATE_OWNER,
  UPDATE_REPO,
  UpdateSchedule,
  canInstallNow,
  disabledLabel,
  feedOverride,
  parseSignature,
  updatePolicy,
  updaterConfigYaml,
} from "../../apps/desktop/src/updater/policy.ts";
import { updateBusy } from "../../apps/web/src/state/updateBusy.ts";

const DEVELOPER_ID = parseSignature(
  ["Executable=/Applications/Uncut.app/Contents/MacOS/Uncut", "Identifier=com.blazejkustra.uncut", "CodeDirectory v=20500 size=600 flags=0x10000(runtime) hashes=8+7 location=embedded", "Authority=Developer ID Application: Example (ABCDE12345)", "Timestamp=16 Oct 2026 at 10:00:00", "TeamIdentifier=ABCDE12345"].join("\n"),
);
const AD_HOC = parseSignature(["Executable=/x/Uncut.app/Contents/MacOS/Uncut", "CodeDirectory v=20400 size=600 flags=0x2(adhoc) hashes=8+7 location=embedded", "Signature=adhoc", "TeamIdentifier=not set"].join("\n"));
const UNSIGNED = parseSignature("/x/Uncut.app: code object is not signed at all");

test("parseSignature reads codesign: Developer ID, ad-hoc, unsigned", () => {
  assert.deepEqual(DEVELOPER_ID, { signed: true, adHoc: false, teamId: "ABCDE12345" });
  assert.deepEqual(AD_HOC, { signed: true, adHoc: true, teamId: undefined });
  assert.equal(UNSIGNED.signed, false);
});

test("only a packaged, team-signed app checks GitHub Releases of blazejkustra/uncut", () => {
  const on = updatePolicy({}, { packaged: true, signature: DEVELOPER_ID });
  assert.deepEqual(on, { enabled: true, feed: { provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPO }, test: false });
  assert.equal(UPDATE_OWNER, "blazejkustra");
  assert.equal(UPDATE_REPO, "uncut");
  assert.equal(disabledLabel(on), undefined);
});

test("dev runs, ad-hoc and unsigned builds never check", () => {
  const dev = updatePolicy({}, { packaged: false, signature: DEVELOPER_ID });
  assert.equal(dev.enabled, false);
  assert.equal(!dev.enabled && dev.reason, "dev");
  for (const signature of [AD_HOC, UNSIGNED, undefined]) {
    const p = updatePolicy({}, { packaged: true, signature });
    assert.equal(!p.enabled && p.reason, "unsigned", JSON.stringify(signature));
    assert.equal(disabledLabel(p), "Only in signed releases");
  }
});

test("UNCUT_AUTO_UPDATE=0 turns it off, even in a release", () => {
  for (const v of ["0", "false", "no", "off", "OFF"]) {
    const p = updatePolicy({ UNCUT_AUTO_UPDATE: v }, { packaged: true, signature: DEVELOPER_ID });
    assert.equal(!p.enabled && p.reason, "off", v);
  }
  assert.equal(updatePolicy({ UNCUT_AUTO_UPDATE: "1" }, { packaged: true, signature: DEVELOPER_ID }).enabled, true);
});

test("a test run (UNCUT_CDP) never checks unless it gives its own local feed, never GitHub", () => {
  const plain = updatePolicy({ UNCUT_CDP: "9333" }, { packaged: true, signature: DEVELOPER_ID });
  assert.equal(!plain.enabled && plain.reason, "tests");
  // With a loopback feed, also on the ad-hoc test build (up to "downloaded").
  const fed = updatePolicy({ UNCUT_CDP: "9333", UNCUT_UPDATE_FEED: "http://127.0.0.1:4567/feed/" }, { packaged: true, signature: AD_HOC });
  assert.deepEqual(fed, { enabled: true, feed: { provider: "generic", url: "http://127.0.0.1:4567/feed/" }, test: true });
});

test("UNCUT_UPDATE_FEED is loopback-only in every build, and outside tests still needs the signature", () => {
  assert.deepEqual(feedOverride("http://localhost:8080/x"), { url: "http://localhost:8080/x" });
  assert.deepEqual(feedOverride("http://[::1]:8080/"), { url: "http://[::1]:8080/" });
  for (const bad of ["https://evil.example.com/feed", "http://10.0.0.2/", "file:///tmp/feed", "nonsense", "http://127.0.0.1.evil.com/"]) {
    assert.ok("problem" in feedOverride(bad), bad);
    const p = updatePolicy({ UNCUT_UPDATE_FEED: bad, UNCUT_CDP: "1" }, { packaged: true, signature: DEVELOPER_ID });
    assert.equal(!p.enabled && p.reason, "bad-feed", bad);
  }
  // A signed release pointed at a local feed (the user testing a real install) works; an ad-hoc one doesn't.
  assert.equal(updatePolicy({ UNCUT_UPDATE_FEED: "http://127.0.0.1:1/" }, { packaged: true, signature: DEVELOPER_ID }).enabled, true);
  assert.equal(updatePolicy({ UNCUT_UPDATE_FEED: "http://127.0.0.1:1/" }, { packaged: true, signature: AD_HOC }).enabled, false);
});

test("the updater config names the feed and a cache folder; checks carry one fixed id for everyone", () => {
  assert.equal(updaterConfigYaml({ provider: "github", owner: "blazejkustra", repo: "uncut" }), "provider: github\nowner: blazejkustra\nrepo: uncut\nupdaterCacheDirName: uncut-updater\n");
  assert.match(updaterConfigYaml({ provider: "generic", url: "http://127.0.0.1:9/f/" }), /^provider: generic\nurl: "http:\/\/127\.0\.0\.1:9\/f\/"\n/);
  assert.equal(NO_STAGING_ID, "00000000-0000-4000-8000-000000000000");
});

/** Fake timers: one pending timer at a time is all the schedule uses. */
function fakeTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  return {
    timers: {
      set: (fn: () => void, ms: number) => (pending.set(++id, { at: now + ms, fn }), id as unknown as ReturnType<typeof setTimeout>),
      clear: (t: ReturnType<typeof setTimeout>) => void pending.delete(t as unknown as number),
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    count: () => pending.size,
  };
}

test("the schedule: first check after the delay, then every 4 hours", () => {
  assert.equal(FIRST_CHECK_MS, 30_000);
  assert.equal(CHECK_EVERY_MS, 4 * 60 * 60 * 1000);
  const t = fakeTimers();
  const checks: Array<boolean> = [];
  const s = new UpdateSchedule((manual) => checks.push(manual), { timers: t.timers });
  s.start();
  t.advance(FIRST_CHECK_MS - 1);
  assert.deepEqual(checks, []);
  t.advance(1);
  assert.deepEqual(checks, [false]);
  t.advance(CHECK_EVERY_MS - 1);
  assert.deepEqual(checks, [false]);
  t.advance(1);
  assert.deepEqual(checks, [false, false]);
  assert.equal(t.count(), 1, "one timer at a time");
});

test("a check due while busy waits and runs as soon as busy clears; not dropped until the next 4 h", () => {
  const t = fakeTimers();
  const checks: Array<boolean> = [];
  const s = new UpdateSchedule((manual) => checks.push(manual), { timers: t.timers });
  s.start();
  s.setBusy(true);
  t.advance(FIRST_CHECK_MS + 60_000);
  assert.deepEqual(checks, []);
  assert.equal(s.isWaiting(), true);
  s.setBusy(true); // still busy: nothing
  assert.deepEqual(checks, []);
  s.setBusy(false);
  assert.deepEqual(checks, [false]);
  assert.equal(s.isWaiting(), false);
  // The next one is 4 h after that check, not after the original due time.
  t.advance(CHECK_EVERY_MS - 1);
  assert.deepEqual(checks, [false]);
  t.advance(1);
  assert.deepEqual(checks, [false, false]);
  // Busy clearing with nothing waiting doesn't check.
  s.setBusy(true);
  s.setBusy(false);
  assert.deepEqual(checks, [false, false]);
});

test("a manual check runs at once (busy or not) and restarts the 4 h clock; stop ends it", () => {
  const t = fakeTimers();
  const checks: Array<boolean> = [];
  const s = new UpdateSchedule((manual) => checks.push(manual), { timers: t.timers });
  s.start();
  s.setBusy(true);
  s.manual();
  assert.deepEqual(checks, [true]);
  t.advance(FIRST_CHECK_MS);
  assert.deepEqual(checks, [true], "the launch check was replaced by the manual one");
  s.stop();
  s.setBusy(false);
  t.advance(CHECK_EVERY_MS * 3);
  assert.deepEqual(checks, [true]);
});

test("install is refused while busy", () => {
  assert.equal(canInstallNow(true), false);
  assert.equal(canInstallNow(false), true);
});

test("busy: an export running, a recording (countdown, saving too), a device recording, an agent turn", () => {
  const idle = { exportPhases: ["done", "failed", "cancelled"], recorderPhase: "idle", capturing: 0, agentRunning: false };
  assert.equal(updateBusy(idle), false);
  for (const phase of ["queued", "preparing", "rendering"]) assert.equal(updateBusy({ ...idle, exportPhases: ["done", phase] }), true, phase);
  for (const phase of ["countdown", "recording", "saving"]) assert.equal(updateBusy({ ...idle, recorderPhase: phase }), true, phase);
  assert.equal(updateBusy({ ...idle, capturing: 1 }), true);
  assert.equal(updateBusy({ ...idle, agentRunning: true }), true);
});
