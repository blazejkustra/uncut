// The rasteriser's graphic-scan request (D316): what a graphic's page shows at each t.

export interface ScanRequest {
  readonly id: number;
  readonly kind: "graphic-scan";
  readonly width: number;
  readonly height: number;
  readonly doc: string;
  readonly info: Readonly<Record<string, unknown>>;
  readonly ts: ReadonlyArray<number>;
  readonly name?: string;
}

const MAX_SCAN_TIMES = 2000;
const size = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 8192;

export const isScanRequest = (v: unknown): v is ScanRequest => {
  const r = v as Partial<ScanRequest> | null;
  if (typeof r !== "object" || r === null || r.kind !== "graphic-scan" || !Number.isInteger(r.id)) return false;
  if (!size(r.width) || !size(r.height) || typeof r.doc !== "string" || typeof r.info !== "object" || r.info === null) return false;
  if (!Array.isArray(r.ts) || r.ts.length < 1 || r.ts.length > MAX_SCAN_TIMES || !r.ts.every((t) => typeof t === "number" && Number.isFinite(t))) return false;
  return r.name === undefined || typeof r.name === "string";
};
