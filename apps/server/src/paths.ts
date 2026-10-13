// Paths relative to the server's own file. This module stays at the root of src/ so the URL it
// resolves against sits at the same depth as the bundle (apps/server/dist/server.mjs): a path
// like "../../../assets" means the same place whether the server runs from source or bundled.
import { fileURLToPath } from "node:url";

/** `rel` resolved against src/ (from source) or dist/ (bundled), as a file path. */
export const besideServer = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
