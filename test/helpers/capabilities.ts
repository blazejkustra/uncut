// What this Mac can do that some tests need (#89, D254). GitHub's macOS runners are Apple
// Virtualization VMs: their paravirtual GPU draws a little differently from a real Apple GPU (so the
// "preview = export" pixel checks miss their SSIM bars), frames come late (playback smoothness),
// the audio output is a virtual device, and the screen is small. A test or a check that needs one
// of these asks here and skips with the reason when it's missing, instead of failing.
// Each value is undefined when the capability is there, else the reason it isn't.
// Overrides: UNCUT_TEST_GPU=1 / UNCUT_TEST_AUDIO=1 to run those checks anyway, =0 to skip them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import type { Page } from "puppeteer-core";

const out = (cmd: string, args: ReadonlyArray<string>) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000 });
  return r.status === 0 ? r.stdout : "";
};

/** A guest VM (macOS sets kern.hv_vmm_present in a virtual machine). */
const virtualMachine = process.platform === "darwin" && out("sysctl", ["-n", "kern.hv_vmm_present"]).trim() === "1";

const override = (name: string, reason: () => string | undefined) => {
  const value = process.env[name];
  if (value === "1") return undefined;
  if (value === "0") return `${name}=0`;
  return reason();
};

/** Why the GPU can't be trusted for pixel parity with the export or for real-time playback (frame pacing, decode speed), if it can't. */
export const NO_REAL_GPU = override("UNCUT_TEST_GPU", () =>
  virtualMachine
    ? "needs a real GPU and media engine: this Mac is a virtual machine (kern.hv_vmm_present), whose paravirtual GPU draws slightly differently, decodes video in software and drops frames"
    : undefined,
);

/** The default output device's name (system_profiler), or "" when it can't be read. */
const defaultOutput = () => {
  try {
    const items = JSON.parse(out("system_profiler", ["SPAudioDataType", "-json"]) || "{}").SPAudioDataType?.[0]?._items ?? [];
    const device = items.find((d: Record<string, unknown>) => d.coreaudio_default_audio_output_device === "spaudio_yes");
    return String(device?._name ?? "");
  } catch {
    return "";
  }
};

/** Why sound can't be played and timed like on a real Mac, if it can't. */
export const NO_REAL_AUDIO = override("UNCUT_TEST_AUDIO", () => {
  if (process.platform !== "darwin") return undefined;
  const name = defaultOutput();
  if (/virtual|null/i.test(name)) return `needs a real audio output: the default output is "${name}"`;
  if (virtualMachine) return "needs a real audio output: this Mac is a virtual machine (kern.hv_vmm_present)";
  return undefined;
});

/** Why the screen is too small for a window of `width`×`height` (CSS px, the screen's work area), if it is. */
export async function smallScreen(page: Page, width: number, height: number) {
  const [w, h] = await page.evaluate(() => [screen.availWidth, screen.availHeight]);
  return w < width || h < height ? `needs a screen with room for ${width}×${height}: this one has ${w}×${h}` : undefined;
}

/** Says (printed, and listed in test-output/skipped-checks.txt for the CI summary) that `what` wasn't checked, and why. */
export function notChecked(missing: string, what: string) {
  const line = `not checked (${missing}): ${what}`;
  console.log(`# ${line}`);
  try {
    mkdirSync("test-output", { recursive: true });
    appendFileSync("test-output/skipped-checks.txt", `${process.argv[1] ?? "?"}: ${line}\n`);
  } catch {}
}

/** `assert.ok(ok, message)`, unless the capability is `missing`: then the check is skipped, and said so (notChecked). */
export function check(missing: string | undefined, ok: unknown, message: string) {
  if (!missing) return assert.ok(ok, message);
  notChecked(missing, `${message}${ok ? " (would pass)" : ""}`);
}
