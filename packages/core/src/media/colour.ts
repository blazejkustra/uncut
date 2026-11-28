import type { MediaColour } from "../timeline/types.ts";

export type HdrKind = "HLG" | "PQ";

const HDR_TRANSFERS: Readonly<Record<string, HdrKind>> = { "arib-std-b67": "HLG", smpte2084: "PQ" };

/** HLG or PQ footage (iPhone, DJI and most phones record HLG); undefined for SDR or unknown colour. */
export const hdrKind = (colour: MediaColour | undefined): HdrKind | undefined => (colour?.transfer ? HDR_TRANSFERS[colour.transfer] : undefined);

/** "HDR (HLG)" for HDR footage, else undefined. */
export const hdrLabel = (colour: MediaColour | undefined): string | undefined => {
  const kind = hdrKind(colour);
  return kind ? `HDR (${kind})` : undefined;
};
