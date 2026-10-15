// The anonymous machine id (issue #13, D223): an HMAC-SHA256 of the hardware id with an
// Uncut-only key, so it is stable across reinstalls but can't be matched with any other app's.
// Kept in <dataDir>/telemetry-id (0600). Without a hardware id it is the HMAC of a random UUID.
// Only made when telemetry is on and the build has a token.
import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ID_FILE = "telemetry-id";
const KEY = "uncut-telemetry-v1";
const PROBE_TIMEOUT_MS = 2000;

export const distinctIdOf = (raw: string) => createHmac("sha256", KEY).update(raw).digest("hex");

/** The Mac's IOPlatformUUID (or Linux's machine-id); undefined when there is none. */
export function hardwareId(): Promise<string | undefined> {
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      try {
        const child = execFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
          resolve(error ? undefined : /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1]);
        });
        child.unref();
      } catch {
        resolve(undefined);
      }
    });
  }
  if (process.platform === "linux") {
    return readFile("/etc/machine-id", "utf8").then(
      (t) => t.trim() || undefined,
      () => undefined,
    );
  }
  return Promise.resolve(undefined);
}

/** The stored id, or a new one (written atomically, 0600). Never rejects. */
export async function loadOrCreateId(dataDir: string, probe: () => Promise<string | undefined> = hardwareId): Promise<string> {
  const file = join(dataDir, ID_FILE);
  try {
    const stored = (await readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{64}$/.test(stored)) return stored;
  } catch {}
  const raw = await probe().catch(() => undefined);
  const id = distinctIdOf(raw ?? randomUUID());
  try {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${id}\n`, { mode: 0o600 });
    await rename(temp, file);
  } catch {}
  return id;
}
