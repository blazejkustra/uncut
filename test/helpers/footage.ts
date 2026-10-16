// Real camera files for the few tests that want one (read only: never copied, changed or written
// next to). Point UNCUT_FOOTAGE_DIR at the folder that holds them, or put them (or a symlink to that
// folder) at fixtures/footage, which is gitignored. Without them those tests skip.
import { join, resolve } from "node:path";

export const FOOTAGE_DIR = resolve(process.env.UNCUT_FOOTAGE_DIR ?? "fixtures/footage");
/** A DJI 4K 59.94 fps HEVC Main 10 clip, about 5.6 minutes (3.6 GB). */
export const DJI_CLIP = join(FOOTAGE_DIR, "DJI_20261010132228_0005_D.MP4");
/** A DJI still (4096×3072 JPEG). */
export const DJI_STILL = join(FOOTAGE_DIR, "DJI_20261010131759_0002_D.JPG");
/** A 51 s 1080p30 H.264 clip with AAC sound. */
export const FIRST_FLIGHT = join(FOOTAGE_DIR, "first-flight.mp4");
/** Why a test that needs the footage can't run here, for its skip message. */
export const footageMissing = (file: string) => `needs ${file.slice(FOOTAGE_DIR.length + 1)} in ${FOOTAGE_DIR} (set UNCUT_FOOTAGE_DIR to your footage folder)`;
