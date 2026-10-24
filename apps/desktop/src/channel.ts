// Release channels: stable (v0.0.4) and nightly (v0.0.5-nightly.20261024.12, .github/workflows/nightly.yml).
// The channel is read from the version alone, so one build input (apps/desktop/package.json's
// version, rewritten by scripts/nightly-version.ts on CI) decides it everywhere: the nightly is its
// own app (Uncut Nightly, its own bundle id, icon and ~/Library/Application Support folder), installs
// next to the stable one, and updates only from nightly releases. No electron import (unit-tested).

export type Channel = "stable" | "nightly";

const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

export const channelOf = (version: string): Channel => (NIGHTLY_VERSION.test(version) ? "nightly" : "stable");

/** The app's name (the .app, the menu, the Dock, Electron's userData folder). */
export const productNameFor = (channel: Channel) => (channel === "nightly" ? "Uncut Nightly" : "Uncut");

/** The bundle identifier (electron-builder.yml / electron-builder.nightly.yml appId). */
export const bundleIdFor = (channel: Channel) => (channel === "nightly" ? "com.blazejkustra.uncut.nightly" : "com.blazejkustra.uncut");

/** The auto-update feed file electron-updater fetches from the release (latest-mac.yml, nightly-mac.yml). */
export const feedFileFor = (channel: Channel) => (channel === "nightly" ? "nightly-mac.yml" : "latest-mac.yml");

/**
 * A nightly's version: the next patch after the stable version (so it sorts above the installed
 * release and below the next one), then the UTC date and the workflow's run number.
 */
export function nightlyVersion(stable: string, date: Date, run: number): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(stable);
  if (!m) throw new Error(`Not a version: ${stable}`);
  if (!Number.isInteger(run) || run < 1) throw new Error(`Not a run number: ${run}`);
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-nightly.${ymd}.${run}`;
}
