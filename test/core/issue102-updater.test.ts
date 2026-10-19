// Issue #102 (D276): auto-update's rules. Which builds check (only a packaged, team-signed app;
// never dev, ad-hoc or a test run without its own local feed), the feed override (loopback only),
// the schedule (first check after a delay, every 4 h, deferred while busy and run when busy
// clears), install refused while busy, and what counts as busy in the renderer. Nothing here
// touches the network or electron.
import { test } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUNDLE_ID,
  CHECK_EVERY_MS,
  MAX_STEP_ASIDES,
  STEP_ASIDE_WINDOW_MS,
  pendingInstall,
  parseStepAsides,
  STEP_ASIDE_WAIT_S,
  shipItPid,
  stepAsideWatcher,
  FIRST_CHECK_MS,
  NO_STAGING_ID,
  UPDATE_OWNER,
  UPDATE_REPO,
  UpdateSchedule,
  canInstallNow,
  disabledLabel,
  bundleVersion,
  HELD_LABEL,
  installingMessage,
  updateBundlePath,
  updateMenuState,
  feedOverride,
  parseSignature,
  updatePolicy,
  updaterConfigYaml,
} from "../../apps/desktop/src/updater/policy.ts";
import { updateBusy, updateSubline } from "../../apps/web/src/state/updateBusy.ts";

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

// A reopened app must not break the install ShipIt is doing (Restart to update, then the app was
// opened again before ShipIt swapped the new bundle in: the old version re-staged the update and
// booted ShipIt out, "App Still Running Error", 0.0.1 → 0.0.2 never installed).
const SHIPIT_STATE = { bundleIdentifier: BUNDLE_ID, launchAfterInstallation: true, targetBundleURL: "file:///Applications/Uncut.app/", updateBundleURL: "file:///x/update.abc/Uncut.app/", useUpdateBundleName: true };

test("pendingInstall: a live ShipIt for this bundle makes the launching app step aside, a few times at most", () => {
  const base = { state: SHIPIT_STATE, bundlePath: "/Applications/Uncut.app", shipItPid: 73220, stepAsides: [] as { t: number; pid: number }[], now: 1_000_000_000 };
  assert.deepEqual(pendingInstall(base), { action: "step-aside", shipItPid: 73220 });
  const recent = Array.from({ length: MAX_STEP_ASIDES - 1 }, (_, i) => ({ t: base.now - 1000 * (i + 1), pid: 73220 }));
  assert.equal(pendingInstall({ ...base, stepAsides: recent }).action, "step-aside");
  const many = Array.from({ length: MAX_STEP_ASIDES }, (_, i) => ({ t: base.now - 1000 * (i + 1), pid: 1000 + i }));
  assert.deepEqual(pendingInstall({ ...base, stepAsides: many }), { action: "hold-updates", shipItPid: 73220 });
  const old = many.map((s) => ({ ...s, t: s.t - STEP_ASIDE_WINDOW_MS }));
  assert.equal(pendingInstall({ ...base, stepAsides: old }).action, "step-aside", "old step-asides don't count");
});

test("pendingInstall: a ShipIt already waited out once (stuck, or waiting on another running copy) never keeps the app closed again", () => {
  const base = { state: SHIPIT_STATE, bundlePath: "/Applications/Uncut.app", shipItPid: 73220, now: 1_000_000_000 };
  const waitedOut = base.now - (STEP_ASIDE_WAIT_S + 10) * 1000;
  assert.deepEqual(pendingInstall({ ...base, stepAsides: [{ t: waitedOut, pid: 73220 }] }), { action: "hold-updates", shipItPid: 73220 });
  assert.equal(pendingInstall({ ...base, stepAsides: [{ t: base.now - 5000, pid: 73220 }] }).action, "step-aside", "a second click while the watcher still waits steps aside again");
  assert.equal(pendingInstall({ ...base, stepAsides: [{ t: waitedOut, pid: 111 }] }).action, "step-aside", "a new ShipIt (launchd restarted it) gets its own wait");
  assert.deepEqual(parseStepAsides([5, { t: 6, pid: 7 }, { t: "x" }, null]), [{ t: 5, pid: 0 }, { t: 6, pid: 7 }]);
  assert.deepEqual(parseStepAsides({}), []);
});

test("pendingInstall: nothing to do without a ShipIt, without a request, or for another copy of the app", () => {
  const base = { state: SHIPIT_STATE, bundlePath: "/Applications/Uncut.app", shipItPid: 73220, stepAsides: [], now: 1 };
  assert.equal(pendingInstall({ ...base, shipItPid: undefined }).action, "none");
  assert.equal(pendingInstall({ ...base, state: undefined }).action, "none");
  assert.equal(pendingInstall({ ...base, state: { targetBundleURL: 7 } }).action, "none");
  assert.equal(pendingInstall({ ...base, bundlePath: "/Users/me/Desktop/Uncut.app" }).action, "none");
  const spaced = { ...SHIPIT_STATE, targetBundleURL: "file:///Users/me/My%20Apps/Uncut.app/" };
  assert.equal(pendingInstall({ ...base, state: spaced, bundlePath: "/Users/me/My Apps/Uncut.app" }).action, "step-aside");
});

test("shipItPid finds the ShipIt serving this bundle id in pgrep -fl", () => {
  const out = [
    "71342 /Applications/Uncut.app/Contents/MacOS/Uncut",
    "5000 /Applications/Other.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.other.app.ShipIt /x/ShipItState.plist",
    `73220 /Applications/Uncut.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt ${BUNDLE_ID}.ShipIt /Users/me/Library/Caches/${BUNDLE_ID}.ShipIt/ShipItState.plist`,
  ].join("\n");
  assert.equal(shipItPid(out), 73220);
  assert.equal(shipItPid(out.split("\n").slice(0, 2).join("\n")), undefined);
  assert.equal(shipItPid(""), undefined);
});

test("the step-aside watcher shows the installing dialog, waits for ShipIt to exit, then opens the bundle", { skip: process.platform === "win32" }, () => {
  const message = installingMessage("0.0.3");
  const w = stepAsideWatcher(4242, "/Applications/My Uncut.app", message);
  assert.equal(w.file, "/bin/sh");
  assert.deepEqual(w.args.slice(2), ["uncut-update-wait", "4242", "/Applications/My Uncut.app", message]);
  assert.match(w.args[1]!, /osascript' .*display dialog \(item 1 of argv\).*giving up after 90' -e 'end run' "\$3"/, "the message goes in as an argument, never spliced into the script");
  assert.match(w.args[1]!, /kill "\$d"/, "the dialog closes once ShipIt is done");
  assert.match(w.args[1]!, /^'\/usr\/bin\/osascript' /, "the real dialog by absolute path");
  // Run it with a fake osascript that logs its message, a fake ShipIt that exits only once the
  // dialog is up (the watcher kills the dialog right after ShipIt goes, so a fake that never waited
  // could be killed before it wrote anything), and `open` swapped for echo: the path stays intact.
  const dir = mkdtempSync(join(tmpdir(), "uncut-watcher-"));
  try {
    const log = join(dir, "dialog's.log");
    const fake = join(dir, "osa script");
    writeFileSync(fake, `#!/bin/sh\nfor a; do m="$a"; done\nprintf '%s|' "$m" > "$UNCUT_TEST_LOG"\n`);
    chmodSync(fake, 0o755);
    const watcher = stepAsideWatcher(0, "/Applications/My Uncut.app", "x", fake).args[1]!.replace("exec /usr/bin/open", "echo");
    const shipIt = 'n=0; while [ ! -s "$UNCUT_TEST_LOG" ] && [ "$n" -lt 400 ]; do sleep 0.05; n=$((n+1)); done';
    const r = spawnSync("/bin/sh", ["-c", `/bin/sh -c '${shipIt}' & /bin/sh -c "$0" x $! "$1" "$2"`, watcher, "/Applications/My Uncut.app", "Installing it's \"quoted\""], { encoding: "utf8", timeout: 30_000, env: { ...process.env, UNCUT_TEST_LOG: log } });
    assert.equal(readFileSync(log, "utf8") + r.stdout.trim(), "Installing it's \"quoted\"|/Applications/My Uncut.app");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the step-aside dialog names the version ShipIt installs (from the staged bundle) and says Uncut reopens by itself", () => {
  const state = { targetBundleURL: "file:///Applications/Uncut.app/", updateBundleURL: "file:///Users/me/Library/Caches/com.blazejkustra.uncut.ShipIt/update.Ab12/Uncut%20Beta.app/" };
  assert.equal(updateBundlePath(state), "/Users/me/Library/Caches/com.blazejkustra.uncut.ShipIt/update.Ab12/Uncut Beta.app");
  assert.equal(updateBundlePath({ targetBundleURL: "file:///Applications/Uncut.app/" }), undefined);
  assert.equal(updateBundlePath(undefined), undefined);
  const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Uncut</string><key>CFBundleShortVersionString</key>\n\t<string>0.0.3</string></dict></plist>`;
  assert.equal(bundleVersion(plist), "0.0.3");
  assert.equal(bundleVersion("<plist><dict></dict></plist>"), undefined);
  assert.match(installingMessage("0.0.3"), /^Installing Uncut 0\.0\.3…/);
  assert.match(installingMessage("0.0.3"), /reopens by itself/);
  assert.match(installingMessage(undefined), /^Installing the Uncut update…/);
});

test("Check for Updates… is off with the reason while this run holds its updater for a pending install", () => {
  const on = updatePolicy({}, { packaged: true, signature: DEVELOPER_ID });
  assert.deepEqual(updateMenuState(on, false), { enabled: true });
  assert.deepEqual(updateMenuState(on, true), { enabled: false, sublabel: HELD_LABEL });
  assert.match(HELD_LABEL, /quit Uncut/);
  const dev = updatePolicy({}, { packaged: false });
  assert.deepEqual(updateMenuState(dev, true), { enabled: false, sublabel: "Only in signed releases" }, "a build that never updates keeps its own reason");
});

test("Restart to update says Uncut reopens by itself once it's quitting to install", () => {
  assert.match(updateSubline({ refused: false, quitting: true }), /reopens by itself in a few seconds/);
  assert.equal(updateSubline({ refused: false, quitting: false }), "Restart to update now, or it installs when you quit.");
  assert.match(updateSubline({ refused: "busy", quitting: false }), /Something started meanwhile/);
  assert.match(updateSubline({ refused: "not-ready", quitting: false }), /Download it from GitHub/);
});
