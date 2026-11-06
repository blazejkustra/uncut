// Run by scripts/factory/verify.ts with the packaged app's binary: prints what this Mac and the app
// can do as one JSON line. In test/ for the DOM types the page code and capabilities.ts need.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchApp } from "../helpers/app.ts";
import { displayFrameMs, NO_REAL_AUDIO, NO_REAL_GPU } from "../helpers/capabilities.ts";

interface GpuLike {
  requestAdapter: () => Promise<{ info: { vendor: string; architecture: string; isFallbackAdapter?: boolean } } | null>;
}

const readAdapter = async () => {
  const adapter = await (navigator as unknown as { gpu?: GpuLike }).gpu?.requestAdapter();
  if (!adapter) return undefined;
  return { vendor: adapter.info.vendor, architecture: adapter.info.architecture, fallback: adapter.info.isFallbackAdapter === true };
};

async function probe(binary: string) {
  const data = mkdtempSync(join(tmpdir(), "uncut-probe-"));
  const app = await launchApp({ command: binary, env: { UNCUT_DATA_DIR: data } });
  try {
    const adapter = await app.page.evaluate(readAdapter);
    const frameMs = await displayFrameMs(app.page);
    return { noRealGpu: NO_REAL_GPU, noRealAudio: NO_REAL_AUDIO, adapter, frameMs };
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
}

console.log(JSON.stringify(await probe(process.argv[2]!)));
process.exit(0);
