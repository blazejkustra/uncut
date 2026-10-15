// Parses the video analyzer's ffmpeg stderr (blur, cuts, frozen stretches, progress).
/** Reads ffmpeg's stderr: blur per frame (with its time), scdet's cuts, freezedetect's stretches, progress. */
export class VideoLog {
  /** Frame index → its time (seconds) and blur. */
  readonly times: Array<number> = [];
  readonly blurs: Array<number> = [];
  readonly cuts: Array<{ time: number; score: number }> = [];
  readonly frozen: Array<{ start: number; end: number }> = [];
  private freezeStart: number | undefined;
  private frame = -1;
  duration: number | undefined;
  outTime = 0;
  /** The decoded picture's display size (rotation applied), from ffmpeg's dump of the input. */
  display: { width: number; height: number } | undefined;
  private input: "before" | "video" | "other" | "done" = "before";

  line(text: string) {
    // One "frame:" line per frame out of the graph. Its number restarts when the graph is rebuilt
    // (the resolution changes mid-file), so frames are counted here.
    let m = /\bframe:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*(-?[\d.]+(?:e[-+]?\d+)?)/.exec(text);
    if (m) {
      this.frame++;
      this.times[this.frame] = Number(m[1]);
      return;
    }
    if (this.input !== "done") {
      if (/^(Output #|Stream mapping:)/.test(text.trim())) this.input = "done";
      else if (/^\s*Stream #0:/.test(text)) {
        const v = !this.display && /: Video: /.test(text) && !/\(attached pic\)/.test(text) ? /, (\d{2,5})x(\d{2,5})\b/.exec(text) : null;
        if (v) {
          const dar = /DAR (\d+):(\d+)/.exec(text);
          const w = Number(v[1]);
          const h = Number(v[2]);
          this.display = dar ? { width: Math.round((h * Number(dar[1])) / Number(dar[2])), height: h } : { width: w, height: h };
          this.input = "video";
        } else this.input = "other";
      } else if (this.input === "video" && (m = /rotation of (-?[\d.]+) degrees/i.exec(text))) {
        const quarter = Math.round(Number(m[1]) / 90) % 2 !== 0;
        if (quarter && this.display) this.display = { width: this.display.height, height: this.display.width };
      }
    }
    m = /\blavfi\.blur=\s*(-?[\d.]+(?:e[-+]?\d+)?|nan|-?inf)/i.exec(text);
    if (m) {
      if (this.frame >= 0) this.blurs[this.frame] = Number(m[1]);
      return;
    }
    m = /^out_time_us=(\d+)/.exec(text);
    if (m) {
      this.outTime = Number(m[1]) / 1e6;
      return;
    }
    m = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*(-?[\d.]+)/.exec(text);
    if (m) {
      this.cuts.push({ time: Number(m[2]), score: Number(m[1]) });
      return;
    }
    m = /lavfi\.freezedetect\.freeze_start:\s*(-?[\d.]+)/.exec(text);
    if (m) {
      this.freezeStart = Math.max(0, Number(m[1]));
      return;
    }
    m = /lavfi\.freezedetect\.freeze_end:\s*(-?[\d.]+)/.exec(text);
    if (m) {
      this.frozen.push({ start: this.freezeStart ?? 0, end: Number(m[1]) });
      this.freezeStart = undefined;
      return;
    }
    m = /^\s*Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
    if (m && this.duration === undefined) this.duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  /** A freeze still open at the end runs to `end`. */
  closeFreeze(end: number) {
    if (this.freezeStart !== undefined && end > this.freezeStart) this.frozen.push({ start: this.freezeStart, end });
    this.freezeStart = undefined;
  }
}
