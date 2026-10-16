// No install id (issue #103, D283; D223 had a hardware-derived id, D278 a random one): usage data is
// anonymous, so nothing per-install is made or sent. Old id files are deleted on every start.
import { rm } from "node:fs/promises";
import { join } from "node:path";

/** D278's random install id. */
export const ID_FILE = "install-id";
/** D223's id, an HMAC of the Mac's IOPlatformUUID. */
export const OLD_ID_FILE = "telemetry-id";

/** Deletes any id file an older Uncut left in the data folder. Never rejects. */
export async function removeOldIds(dataDir: string): Promise<void> {
  await Promise.all([ID_FILE, OLD_ID_FILE].map((f) => rm(join(dataDir, f), { force: true }).catch(() => {})));
}
