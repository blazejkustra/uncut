// D311 playback engine (play/engine.ts): one file opened with mediabunny, its video track's packets
// and the decoder configuration that decodes them here. Anything it can't take (no video track, a
// codec WebCodecs refuses here such as ProRes, HDR, a container mediabunny can't read) is "broken"
// and its clips play on the <video> path. mediabunny rather than mp4box.js: it reads by byte ranges
// on demand (the token-gated media route, no whole-file download), finds a time's key packet itself,
// gives WebCodecs configs, and reads WebM and Matroska too; its timestamps are the scrub cache's
// (test/media/play-demux.test.ts).
import { ALL_FORMATS, EncodedPacketSink, Input, UrlSource } from "mediabunny";
import { namedColour } from "../scrub/colour.ts";
import { cachedSize } from "../scrub/frames.ts";

/** Bytes of the file mediabunny keeps read (shared by every lane of the file). */
const READ_CACHE = 48 * 1024 * 1024;

export class PlaySource {
  state: "loading" | "ready" | "broken" = "loading";
  reason = "";
  config: VideoDecoderConfig | undefined;
  sink: EncodedPacketSink | undefined;
  /** Clockwise degrees the frames are turned to be upright. */
  rotation = 0;
  /** One frame's length (s), for frames that don't say. */
  frameS = 1 / 30;
  /** The upright picture's size. */
  display = { w: 0, h: 0 };
  readonly url: string;
  private input: Input | undefined;
  private readonly changed: () => void;

  constructor(url: string, changed: () => void) {
    this.url = url;
    this.changed = changed;
    void this.open().catch((error: unknown) => this.fail(String((error as Error)?.message ?? error)));
  }

  private async open() {
    if (typeof VideoDecoder === "undefined") return this.fail("no WebCodecs");
    this.input = new Input({ source: new UrlSource(this.url, { maxCacheSize: READ_CACHE }), formats: ALL_FORMATS });
    const track = await this.input.getPrimaryVideoTrack();
    if (!track) return this.fail("no video track");
    if (await track.hasHighDynamicRange()) return this.fail("HDR");
    const base = await track.getDecoderConfig();
    if (!base) return this.fail(`${(await track.getCodec()) ?? "an unknown codec"} isn't decodable here`);
    const height = await track.getCodedHeight();
    const config: VideoDecoderConfig = { ...base, colorSpace: namedColour(base.colorSpace ?? (await track.getColorSpace()), height), optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => undefined);
    if (!support?.supported) return this.fail(`${config.codec} isn't decodable here`);
    const sink = new EncodedPacketSink(track);
    const first = await sink.getFirstPacket();
    if (!first) return this.fail("no frames");
    if (this.state === "broken") return;
    if (first.duration > 0) this.frameS = first.duration;
    this.rotation = await track.getRotation();
    this.display = { w: await track.getDisplayWidth(), h: await track.getDisplayHeight() };
    this.config = config;
    this.sink = sink;
    this.state = "ready";
    this.changed();
  }

  /** Bytes of one frame kept with its long side at most `side`. */
  frameBytes(side: number) {
    const kept = cachedSize(this.display.w, this.display.h, side);
    return kept.w * kept.h * 4;
  }

  fail(reason: string) {
    if (this.state === "broken") return;
    this.state = "broken";
    this.reason = reason;
    this.dispose();
    this.changed();
  }

  dispose() {
    this.sink = undefined;
    this.input?.dispose();
    this.input = undefined;
  }
}
