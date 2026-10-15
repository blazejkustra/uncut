// The analysis cache (D66): content fingerprints and the per-analyzer cache files under .cache/analysis.
import { createHash } from "node:crypto";
import { open, readFile, rm, rmdir, mkdir } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import type { Analyzer } from "@uncut/contracts";
import { type BeatsResult, BEATS_VERSION, isBeatsResult } from "../beats.ts";
import { writeAtomic } from "../../project/atomicWrite.ts";
import { type TranscriptResult, TRANSCRIPT_VERSION, isTranscriptResult } from "../transcription.ts";
import { type VideoResult, VIDEO_VERSION, isVideoResult } from "../videoAnalysis.ts";
import { type LoudnessResult, isResult } from "../loudness/loudness.ts";

export const ANALYSIS_FORMAT = "uncut.analysis/0";
/** Bumped when the loudness analyzer's output changes, so older cache files are redone. */
export const LOUDNESS_VERSION = 2;
/** Bytes per fingerprint sample. */
export const SAMPLE_BYTES = 1 << 20;

export const analysisDir = (projectDir: string) => join(projectDir, ".cache", "analysis");
export const cacheFile = (projectDir: string, fingerprint: string, analyzer: Analyzer) => join(analysisDir(projectDir), fingerprint, `${analyzer}.json`);
export type AnalysisResult = LoudnessResult | VideoResult | TranscriptResult | BeatsResult;

// ---- fingerprint ----

/**
 * The file's identity for the cache: its size and three 1 MB samples (start, middle, end), hashed
 * (SHA-256, 32 hex digits). Not the path or the modification time, so a renamed, moved or copied
 * file keeps its results. A change that keeps the size and touches none of the samples goes
 * unnoticed (camera files don't get edited in place).
 */
export async function fingerprint(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`${path} isn't a file.`);
    const size = info.size;
    const hash = createHash("sha256").update(`uncut-fingerprint/1\0${size}\0`);
    const length = Math.min(SAMPLE_BYTES, size);
    const buffer = Buffer.alloc(length);
    for (const at of [0, Math.max(0, Math.floor(size / 2) - Math.floor(SAMPLE_BYTES / 2)), Math.max(0, size - SAMPLE_BYTES)]) {
      const { bytesRead } = await file.read(buffer, 0, length, at);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex").slice(0, 32);
  } finally {
    await file.close();
  }
}

// ---- the cache ----

interface CacheFile {
  readonly format: string;
  readonly analyzer: Analyzer;
  readonly version: number;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly result: AnalysisResult;
}

const VERSIONS: Readonly<Record<Analyzer, number>> = { loudness: LOUDNESS_VERSION, video: VIDEO_VERSION, transcript: TRANSCRIPT_VERSION, beats: BEATS_VERSION };
const versionOf = (analyzer: Analyzer) => VERSIONS[analyzer];
const SHAPES: Readonly<Record<Analyzer, (result: unknown) => boolean>> = { loudness: isResult, video: isVideoResult, transcript: isTranscriptResult, beats: isBeatsResult };
const shapeOk = (analyzer: Analyzer, result: unknown) => SHAPES[analyzer](result);

/** A cached result for this content and analyzer (and the analyzer's current version), if any. */
export async function readCached(projectDir: string, fp: string, analyzer: Analyzer): Promise<AnalysisResult | undefined> {
  try {
    const file = JSON.parse(await readFile(cacheFile(projectDir, fp, analyzer), "utf8")) as CacheFile;
    if (file.format !== ANALYSIS_FORMAT || file.analyzer !== analyzer || file.version !== versionOf(analyzer) || file.fingerprint !== fp) return undefined;
    return shapeOk(analyzer, file.result) ? file.result : undefined;
  } catch {
    return undefined;
  }
}

/** A cached result for a media file, without a job (undefined: none, or the file can't be read). */
export async function cachedFor(target: AnalysisTarget, analyzer: Analyzer): Promise<AnalysisResult | undefined> {
  try {
    return await readCached(target.dir, await fingerprint(target.path), analyzer);
  } catch {
    return undefined;
  }
}

/** Removes a cache file and its folder when that's empty (a cancel that came after the write). */
export async function removeCached(projectDir: string, fp: string, analyzer: Analyzer) {
  await rm(cacheFile(projectDir, fp, analyzer), { force: true }).catch(() => {});
  await rmdir(join(analysisDir(projectDir), fp)).catch(() => {});
}

/** Written aside and renamed; the folder is made only now, and removed again if the write fails. */
export async function writeCached(projectDir: string, fp: string, analyzer: Analyzer, result: AnalysisResult) {
  const path = cacheFile(projectDir, fp, analyzer);
  const folder = join(analysisDir(projectDir), fp);
  await mkdir(folder, { recursive: true });
  const file: CacheFile = { format: ANALYSIS_FORMAT, analyzer, version: versionOf(analyzer), fingerprint: fp, createdAt: new Date().toISOString(), result };
  try {
    await writeAtomic(path, `${JSON.stringify(file)}\n`);
  } catch (error) {
    await rmdir(folder).catch(() => {});
    throw error;
  }
}

// ---- the queue ----

/** A media item to analyse, resolved against its project. */
export interface AnalysisTarget {
  readonly dir: string;
  readonly mediaId: string;
  readonly path: string;
  readonly kind: "video" | "audio" | "image";
  readonly hasAudio?: boolean | undefined;
  /** The media's length in seconds (for progress), when known. */
  readonly seconds?: number | undefined;
}

/** A media entry of a project as an analysis target (relative paths resolve against the project). */
export const targetOf = (dir: string, media: { readonly id: string; readonly kind: string; readonly path: string; readonly probe?: { readonly frames?: number; readonly hasAudio?: boolean } }, fps: number): AnalysisTarget => ({
  dir,
  mediaId: media.id,
  path: isAbsolute(media.path) ? media.path : resolve(dir, media.path),
  kind: media.kind === "image" ? "image" : media.kind === "audio" ? "audio" : "video",
  hasAudio: media.probe?.hasAudio,
  seconds: media.probe?.frames ? media.probe.frames / fps : undefined,
});
