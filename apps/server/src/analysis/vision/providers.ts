// Which installed analyzer answers a vision output here (D325): the first allowed analyzer plugin
// (bundled ones first) that declares the output and runs on this system.
import type { VisionOutput } from "@uncut/contracts";

export type Platform = "macos-arm64" | "macos-x64" | "windows-x64" | "linux-x64";

export const platformOf = (platform: NodeJS.Platform = process.platform, arch: string = process.arch): Platform | undefined => {
  if (platform === "darwin") return arch === "arm64" ? "macos-arm64" : arch === "x64" ? "macos-x64" : undefined;
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return undefined;
};

/** An analyzer plugin as the plugin host lists it. */
export interface VisionCandidate {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Allowed by the user (bundled plugins are); undefined means allowed. */
  readonly allowed?: boolean;
  readonly manifest: Record<string, unknown>;
}

export const NO_PROVIDER: Readonly<Record<VisionOutput, string>> = {
  matte: "Background removal needs a vision module for this system.",
  faces: "Face detection needs a vision module for this system.",
  track: "Motion tracking needs a vision module for this system.",
};

const outputsOf = (manifest: Record<string, unknown>) => {
  const outputs = (manifest.analyzer as { outputs?: unknown } | undefined)?.outputs;
  return Array.isArray(outputs) ? outputs : [];
};

const platformsOf = (manifest: Record<string, unknown>) => {
  const platforms = (manifest.requires as { platforms?: unknown } | undefined)?.platforms;
  return Array.isArray(platforms) ? platforms : undefined;
};

const runsOn = (candidate: VisionCandidate, platform: Platform | undefined) => {
  const platforms = platformsOf(candidate.manifest);
  return !platforms || (platform !== undefined && platforms.includes(platform));
};

export function pickProvider(
  candidates: ReadonlyArray<VisionCandidate>,
  output: VisionOutput,
  platform: Platform | undefined,
): { readonly provider: VisionCandidate } | { readonly refused: string } {
  const declaring = candidates.filter((c) => outputsOf(c.manifest).includes(output));
  const here = declaring.filter((c) => runsOn(c, platform));
  const provider = here.find((c) => c.allowed !== false);
  if (provider) return { provider };
  if (here.length) return { refused: `${NO_PROVIDER[output]} ${here[0]!.name} is installed but not allowed: allow it in Settings, Plugins.` };
  if (!declaring.length) return { refused: NO_PROVIDER[output] };
  const names = declaring.map((c) => `${c.name} runs on ${platformsOf(c.manifest)!.join(", ")}`).join("; ");
  return { refused: `${NO_PROVIDER[output]} ${names}, and this is ${platform ?? `${process.platform}-${process.arch}`}.` };
}
