// Export with the same timeline maths as the preview: a frame f is the moment f / fps,
// a transition is centred on its cut, and text is rasterised by Chromium from the same
// HTML the preview draws (render.js). ffmpeg composites it all from the original files.
const { BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const sec = (frames, fps) => +(frames / fps).toFixed(6);

/** Main-track segments with their transition handles, in seconds. */
function segments(project, mediaPath) {
  const fps = project.canvas.fps;
  const items = project.tracks.find((t) => t.role === "main").items;
  return items.map((item, i) => {
    const halfIn = item.transitionIn ? item.transitionIn.duration / 2 : 0;
    const halfOut = items[i + 1]?.transitionIn ? items[i + 1].transitionIn.duration / 2 : 0;
    const media = project.media.find((m) => m.id === item.media);
    return {
      item,
      file: mediaPath(media),
      hasAudio: !!media.probe?.hasAudio,
      from: sec(item.in - halfIn, fps),
      len: sec(item.duration + halfIn + halfOut, fps),
      fade: item.transitionIn ? sec(item.transitionIn.duration, fps) : 0,
    };
  });
}

/** Start frame of every free item and the project length, as the preview computes them. */
function timing(project) {
  let total = 0;
  for (const t of project.tracks) {
    let at = 0;
    for (const it of t.items) {
      const start = t.role === "main" ? at : it.start;
      at += it.duration;
      total = Math.max(total, start + it.duration);
    }
  }
  return total;
}

/** Rasterise each text item at full canvas size on a transparent page. */
async function renderTexts(project, outDir) {
  const { width: W, height: H } = project.canvas;
  const texts = project.tracks
    .filter((t) => t.kind === "text" && !t.hidden)
    .reverse() // bottom track first, so later overlays land on top
    .flatMap((t) => t.items.filter((i) => i.type === "text"));
  if (!texts.length) return [];
  const win = new BrowserWindow({ width: W, height: H, show: false, frame: false, transparent: true, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } });
  try {
    await win.loadFile(path.join(__dirname, "render-text.html"));
    win.webContents.setZoomFactor(1);
    const out = [];
    for (const item of texts) {
      await win.webContents.executeJavaScript(`window.show(${JSON.stringify(item)}, ${JSON.stringify(project.canvas)})`);
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
      const file = path.join(outDir, `text-${item.id}.png`);
      const png = img.getSize().width === W ? img : img.resize({ width: W, height: H, quality: "best" });
      await fs.writeFile(file, png.toPNG());
      out.push({ item, file });
    }
    return out;
  } finally {
    win.destroy();
  }
}

/** Build the ffmpeg command for the project. Exported for tests. */
function buildCommand(project, { mediaPath, texts, output }) {
  const { width: W, height: H, fps } = project.canvas;
  if (project.tracks.some((t) => t.kind === "video" && t.role !== "main" && !t.hidden && t.items.length)) {
    throw new Error("Export doesn't support overlay video tracks yet.");
  }
  const segs = segments(project, mediaPath);
  const total = sec(timing(project), fps);
  const args = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"];
  const graph = [];
  segs.forEach((s, k) => {
    args.push("-hwaccel", "videotoolbox", "-ss", String(s.from), "-t", String(s.len), "-i", s.file);
    graph.push(`[${k}:v]fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p,trim=duration=${s.len},setpts=PTS-STARTPTS,settb=AVTB[v${k}]`);
  });
  const withAudio = segs.some((s) => s.hasAudio);
  if (withAudio) {
    segs.forEach((s, k) => {
      graph.push(s.hasAudio
        ? `[${k}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${s.len},asetpts=PTS-STARTPTS[a${k}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${s.len}[a${k}]`);
    });
  }
  // Chain the shots: a crossfade where the project has a transition, a plain cut otherwise.
  // Every link is put on one timebase (settb=AVTB) because xfade refuses mixed inputs.
  let v = "v0";
  let a = "a0";
  let length = segs[0].len;
  for (let k = 1; k < segs.length; k++) {
    const s = segs[k];
    if (s.fade) {
      graph.push(`[${v}][v${k}]xfade=transition=fade:duration=${s.fade}:offset=${+(length - s.fade).toFixed(6)},settb=AVTB[x${k}]`);
      if (withAudio) graph.push(`[${a}][a${k}]acrossfade=d=${s.fade}[y${k}]`);
      length += s.len - s.fade;
    } else {
      graph.push(`[${v}][v${k}]concat=n=2:v=1:a=0,settb=AVTB[x${k}]`);
      if (withAudio) graph.push(`[${a}][a${k}]concat=n=2:v=0:a=1[y${k}]`);
      length += s.len;
    }
    v = `x${k}`;
    a = `y${k}`;
  }
  // Text: each PNG is shown from its start for its duration, fading in like the preview.
  texts.forEach(({ item, file }, j) => {
    const n = segs.length + j;
    const fadeIn = item.animation?.in?.module === "move.fade" ? sec(item.animation.in.duration, fps) : 0;
    args.push("-loop", "1", "-framerate", String(fps), "-t", String(sec(item.duration, fps)), "-i", file);
    graph.push(`[${n}:v]format=rgba${fadeIn ? `,fade=in:st=0:d=${fadeIn}:alpha=1` : ""},setpts=PTS-STARTPTS+${sec(item.start, fps)}/TB[t${j}]`);
    graph.push(`[${v}][t${j}]overlay=eof_action=pass:format=auto[o${j}]`);
    v = `o${j}`;
  });
  graph.push(`[${v}]format=yuv420p[vout]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[vout]");
  if (withAudio) args.push("-map", `[${a}]`, "-c:a", "aac", "-b:a", "192k");
  const bitrate = Math.round((W * H * fps * 0.09) / 1e6);
  args.push("-c:v", "h264_videotoolbox", "-profile:v", "high", "-b:v", `${bitrate}M`, "-tag:v", "avc1", "-r", String(fps), "-t", String(total), "-movflags", "+faststart", output);
  return { args, total };
}

/** Run an export. onProgress gets a 0..1 fraction. Resolves with the output path. */
async function exportProject({ project, dir, mediaPath, onProgress = () => {} }) {
  const outDir = path.join(dir, "exports");
  const work = path.join(dir, ".cache", "export");
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(work, { recursive: true });
  const safe = project.name.replace(/[^\w\- ]+/g, "").trim() || "export";
  const output = path.join(outDir, `${safe}.mp4`);
  const texts = await renderTexts(project, work);
  const { args, total } = buildCommand(project, { mediaPath, texts, output });
  await fs.writeFile(path.join(work, "ffmpeg-args.json"), JSON.stringify(args, null, 2));
  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stdout.on("data", (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m) onProgress(Math.min(1, Number(m.at(-1).split("=")[1]) / 1e6 / total));
    });
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.split("\n").filter(Boolean).slice(-3).join(" ")}`))));
  });
  onProgress(1);
  return output;
}

/**
 * One frame of the edit as a JPEG, built the way export builds it: the clips visible at f
 * stacked with their transition opacity, then the text PNGs Chromium rendered.
 */
async function renderFrame({ project, f, mediaPath, texts, width = 1280, out }) {
  const { layout, visualsAt } = await import("./timeline.mjs");
  const { starts } = layout(project);
  const W = Math.round(width / 2) * 2;
  const H = Math.round((width * project.canvas.height) / project.canvas.width / 2) * 2;
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1`];
  // Every layer contributes its first frame, pinned to t=0: after a seek a clip's first
  // frame can carry a timestamp just past zero and overlay would composite black instead.
  const graph = ["[0:v]trim=end_frame=1,setpts=0[base]"];
  let base = "base";
  let n = 1;
  for (const v of visualsAt(project, starts, f)) {
    let file;
    if (v.item.type === "clip") {
      const media = project.media.find((m) => m.id === v.item.media);
      args.push("-hwaccel", "videotoolbox", "-ss", String(v.source + 0.0001), "-i", mediaPath(media));
    } else if (v.item.type === "text" && (file = texts.get(v.item.id))) {
      args.push("-i", file);
    } else continue;
    graph.push(`[${n}:v]trim=end_frame=1,setpts=0,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba,colorchannelmixer=aa=${v.opacity.toFixed(3)}[l${n}]`);
    graph.push(`[${base}][l${n}]overlay=format=auto[b${n}]`);
    base = `b${n}`;
    n++;
  }
  graph.push(`[${base}]format=yuvj420p[out]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[out]", "-frames:v", "1", "-update", "1", "-q:v", "3", out);
  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`frame ${f}: ${err.trim().split("\n").at(-1)}`))));
  });
  return out;
}

module.exports = { exportProject, buildCommand, segments, renderTexts, renderFrame };
