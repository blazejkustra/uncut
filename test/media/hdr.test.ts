// HDR footage (HLG, PQ) is tone-mapped to SDR BT.709 wherever Uncut makes pictures from it.
// - The probe's colour (ffprobe fields), stored on the media and labelled for the agent.
// - Which filter each source gets: the tone map for HDR only, untagged SD/HD as before, nothing for tagged SDR.
// - With the real ffmpeg on a tiny generated HLG clip: the file's colour, the cache key bump, and a
//   tone-mapped frame that comes out tagged BT.709 and differs from the untouched one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hdrKind, hdrLabel } from "../../packages/core/src/media/colour.ts";
import { colourOf, fromFfprobe, probeOf } from "../../apps/server/src/media/mediaLibrary/helpers.ts";
import { fileColour, pictureKey, toneMapFilter, toneMapFor, toneMapSupported } from "../../apps/server/src/media/hdr.ts";
import { posterKey } from "../../apps/server/src/media/media.ts";
import { needsProxy, proxyArgs } from "../../apps/server/src/media/proxies.ts";
import { filmstripArgs } from "../../apps/server/src/media/filmstrips.ts";
import { colourFilterOf, colourFilters } from "../../apps/server/src/export/exporter/ffmpeg.ts";
import { untaggedFilter, type ExportPlan } from "../../apps/server/src/export/exportPlan.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const ffmpegPath = hasFfmpeg ? execFileSync("/bin/sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() : "";
const ffprobePath = hasFfmpeg ? execFileSync("/bin/sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).trim() : "";
const skipFf = hasFfmpeg ? false : "needs ffmpeg";
const FFMPEG_LIMIT = { timeout: 60000, killSignal: "SIGKILL" } as const;

const HLG_STREAM = {
  codec_type: "video",
  color_transfer: "arib-std-b67",
  color_primaries: "bt2020",
  color_space: "bt2020nc",
  pix_fmt: "yuv420p10le",
  bits_per_raw_sample: "10",
};

test("colourOf reads ffprobe's colour fields; unknown tags are left out, the bit depth falls back to the pixel format", () => {
  assert.deepEqual(colourOf(HLG_STREAM), { transfer: "arib-std-b67", primaries: "bt2020", matrix: "bt2020nc", bitDepth: 10 });
  assert.deepEqual(colourOf({ color_transfer: "smpte2084", pix_fmt: "p010le" }), { transfer: "smpte2084", bitDepth: 10 });
  assert.deepEqual(colourOf({ color_transfer: "unknown", color_space: "unknown", pix_fmt: "yuv420p" }), { bitDepth: 8 });
  assert.equal(colourOf({}), undefined);
  assert.equal(colourOf(undefined), undefined);
});

test("HLG and PQ count as HDR and are labelled for the agent; SDR and unknown colour aren't", () => {
  assert.equal(hdrKind({ transfer: "arib-std-b67" }), "HLG");
  assert.equal(hdrKind({ transfer: "smpte2084" }), "PQ");
  assert.equal(hdrLabel({ transfer: "arib-std-b67" }), "HDR (HLG)");
  assert.equal(hdrLabel({ transfer: "smpte2084" }), "HDR (PQ)");
  assert.equal(hdrLabel({ transfer: "bt709" }), undefined);
  assert.equal(hdrLabel({ transfer: "bt2020-10" }), undefined);
  assert.equal(hdrLabel(undefined), undefined);
});

test("the ffprobe import path and probeOf keep a video's colour on the media", () => {
  const info = fromFfprobe(
    JSON.stringify({
      streams: [{ ...HLG_STREAM, width: 1080, height: 1920, codec_name: "hevc", r_frame_rate: "30/1" }],
      format: { format_name: "mov,mp4", duration: "2" },
    }),
  );
  assert.equal(info?.colour?.transfer, "arib-std-b67");
  assert.deepEqual(probeOf(info!, 30).colour, { transfer: "arib-std-b67", primaries: "bt2020", matrix: "bt2020nc", bitDepth: 10 });
  const sdr = fromFfprobe(
    JSON.stringify({ streams: [{ codec_type: "video", width: 64, height: 64, codec_name: "h264" }], format: { format_name: "mov", duration: "1" } }),
  );
  assert.equal(probeOf(sdr!, 30).colour, undefined);
});

test("the tone map: HLG and PQ to BT.709 with the perceptual intent, nothing for SDR", () => {
  const hlg = toneMapFilter({ transfer: "arib-std-b67" });
  assert.match(
    hlg,
    /^scale=in_transfer=arib-std-b67:in_primaries=bt2020:out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709:out_range=tv:intent=perceptual$/,
  );
  assert.match(toneMapFilter({ transfer: "smpte2084" }), /in_transfer=smpte2084/);
  assert.equal(toneMapFilter({ transfer: "bt709" }), "");
  assert.equal(toneMapFilter(undefined), "");
});

test("the export's colour filter per source: HDR tone-mapped, untagged as before, tagged SDR untouched", () => {
  assert.equal(
    colourFilterOf({ color_space: "bt2020nc", color_transfer: "arib-std-b67", height: 1920 }, true),
    `${toneMapFilter({ transfer: "arib-std-b67" })},`,
  );
  assert.equal(
    colourFilterOf({ color_space: "bt2020nc", color_transfer: "arib-std-b67", height: 1920 }, false),
    undefined,
    "an ffmpeg that can't tone-map leaves HDR as it was",
  );
  assert.equal(colourFilterOf({ color_space: "bt709", color_transfer: "bt709", height: 1080 }, true), undefined);
  assert.equal(colourFilterOf({ height: 360 }, true), untaggedFilter(360));
  assert.equal(colourFilterOf({ color_space: "unknown", height: 1080 }, true), untaggedFilter(1080));
});

test("HDR always gets a proxy, tone-mapped after the scale; SDR proxies and filmstrips keep their filters", () => {
  assert.equal(needsProxy({ codec: "h264", width: 640, height: 360, bitrate: 1e6, hdr: true }), true);
  assert.equal(needsProxy({ codec: "h264", width: 640, height: 360, bitrate: 1e6, hdr: false }), false);
  const vf = (args: Array<string>) => args[args.indexOf("-vf") + 1];
  const scale = "scale=w=1280:h=1280:force_original_aspect_ratio=decrease:force_divisible_by=2";
  assert.equal(vf(proxyArgs("in.mov", "out.mp4", "software")), `${scale},format=yuv420p`);
  const toneMap = toneMapFilter({ transfer: "arib-std-b67" });
  assert.equal(vf(proxyArgs("in.mov", "out.mp4", "software", toneMap)), `${scale},${toneMap},format=yuv420p`);
  assert.doesNotMatch(vf(filmstripArgs("in.mov", "out.jpg", 10)), /transfer/);
  assert.match(
    vf(filmstripArgs("in.mov", "out.jpg", 10, { toneMap })),
    new RegExp(`scale=-2:\\d+:flags=bilinear,${toneMap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},tile=`),
  );
});

let dir = "";
let hlg = "";
let sdr = "";
before(() => {
  if (!hasFfmpeg) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-hdr-"));
  hlg = join(dir, "hlg.mov");
  sdr = join(dir, "sdr.mov");
  const clip = (out: string, format: string, trc: string, primaries: string, matrix: string) =>
    execFileSync(
      "ffmpeg",
      [
        ...["-v", "error", "-y", "-threads", "2", "-f", "lavfi", "-i", "smptebars=size=64x64:rate=10", "-t", "0.5"],
        ...["-vf", `format=${format},setparams=color_trc=${trc}:color_primaries=${primaries}:colorspace=${matrix}:range=tv`, "-c:v", "ffv1", out],
      ],
      FFMPEG_LIMIT,
    );
  clip(hlg, "yuv420p10le", "arib-std-b67", "bt2020", "bt2020nc");
  clip(sdr, "yuv420p", "bt709", "bt709", "bt709");
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

test("a generated HLG clip: its colour, a new cache key (SDR keeps its own), and the tone map", { skip: skipFf }, async () => {
  assert.deepEqual(await fileColour(ffprobePath, hlg), { transfer: "arib-std-b67", primaries: "bt2020", matrix: "bt2020nc", bitDepth: 10 });
  assert.equal((await fileColour(ffprobePath, sdr))?.transfer, "bt709");
  assert.notEqual(await pictureKey(ffprobePath, hlg), await posterKey(hlg));
  assert.match((await pictureKey(ffprobePath, hlg)) ?? "", /^[0-9a-f]{12}$/);
  assert.equal(await pictureKey(ffprobePath, sdr), await posterKey(sdr));
  if (!(await toneMapSupported(ffmpegPath))) return;
  assert.equal(await toneMapFor(ffmpegPath, hlg), toneMapFilter({ transfer: "arib-std-b67" }));
  assert.equal(await toneMapFor(ffmpegPath, sdr), "");
});

test("the tone-mapped frame comes out tagged BT.709 and isn't the untouched picture", { skip: skipFf }, async (t) => {
  if (!(await toneMapSupported(ffmpegPath))) return t.skip("this ffmpeg's scale has no colour management");
  const frame = (vf: string) =>
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-threads", "2", "-filter_threads", "2", "-i", hlg, "-frames:v", "1", "-vf", `${vf}format=rgb24`, "-f", "rawvideo", "-"],
      {
        ...FFMPEG_LIMIT,
        maxBuffer: 1 << 20,
      },
    );
  const toneMap = await toneMapFor(ffmpegPath, hlg);
  assert.ok(toneMap);
  const untouched = frame("scale=out_color_matrix=bt709,");
  const mapped = frame(`${toneMap},`);
  assert.equal(mapped.length, 64 * 64 * 3);
  const diff = mapped.reduce((sum, v, i) => sum + Math.abs(v - untouched[i]!), 0) / mapped.length;
  assert.ok(diff > 3, `the tone map changes the picture (mean difference ${diff.toFixed(2)})`);
  const out = join(dir, "mapped.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-threads", "2", "-i", hlg, "-vf", `${toneMap},format=yuv420p`, "-c:v", "mpeg4", out], FFMPEG_LIMIT);
  const tags = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer,color_primaries,color_space", "-of", "csv=p=0", out],
    { encoding: "utf8" },
  ).trim();
  assert.equal(tags, "bt709,bt709,bt709");
});

test("the export's colour filters tone-map only when the ffmpeg that runs them can (a system ffmpeg for libx264)", { skip: skipFf }, async (t) => {
  if (!(await toneMapSupported(ffmpegPath))) return t.skip("this ffmpeg's scale has no colour management");
  const older = join(dir, "ffmpeg-7");
  writeFileSync(older, "#!/bin/sh\necho 'scale AVOptions:'\n");
  chmodSync(older, 0o755);
  const plan = { visuals: [{ kind: "video", file: hlg }] } as unknown as ExportPlan;
  const signal = new AbortController().signal;
  assert.equal((await colourFilters(ffmpegPath, plan, signal)).get(hlg), `${toneMapFilter({ transfer: "arib-std-b67" })},`);
  assert.equal((await colourFilters(ffmpegPath, plan, signal, older)).get(hlg), undefined);
});
