// The install id (issue #103, D278; was D223's hardware-derived id): a random UUID made the first
// time the user has said yes to usage data, kept in <dataDir>/install-id (0600). It is not derived
// from the machine, so it can't be matched with anything else, and deleting the file (or the app's
// data) gives a new one. The old hardware-derived id file (telemetry-id) is deleted when found.
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ID_FILE = "install-id";
/** D223's id, an HMAC of the Mac's IOPlatformUUID: never read, removed. */
export const OLD_ID_FILE = "telemetry-id";
export const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The stored id, or a new random one (written atomically, 0600). Never rejects. */
export async function loadOrCreateId(dataDir: string): Promise<string> {
  await rm(join(dataDir, OLD_ID_FILE), { force: true }).catch(() => {});
  const file = join(dataDir, ID_FILE);
  try {
    const stored = (await readFile(file, "utf8")).trim();
    if (INSTALL_ID.test(stored)) return stored;
  } catch {}
  const id = randomUUID();
  try {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${id}\n`, { mode: 0o600 });
    await rename(temp, file);
  } catch {}
  return id;
}
