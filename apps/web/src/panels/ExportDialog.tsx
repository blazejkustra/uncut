// The export dialog (D34): three quality cards, the file and where it goes, loudness in plain
// words, "Opens in Finder when it's done". The export itself is a server job (D55): this shows its
// progress with a Cancel, and closing the dialog doesn't stop it (the top bar keeps the percentage).
// Without ffmpeg there's nothing to export with, so the dialog shows how to install it instead.
// Subtitles (D105), when the project has captions or a Subtitles track: burn them in (default, as
// before), a .srt / .vtt next to the video, a soft subtitle track, or just the file.
import type { ExportJob, ExportLoudness, ExportQuality, ExportSubtitles } from "@uncut/contracts";
import { mixNote, SILENCE_DB } from "@uncut/core/audio";
import { dbWords } from "@uncut/core/edit-log";
import { CODEC_NAMES, exportFrameRates, exportShortSides, outputSize, presetBitrateMbps, type ExportCodec } from "@uncut/core/export";
import { choiceOfTarget, LOUDNESS_PRESETS, masterLimiter, projectTargetLufs, targetWords } from "@uncut/core/effects";
import { SUBTITLE_LANGUAGES, subtitleCues, type SubtitleFormat } from "@uncut/core/subtitles";
import { Check, ChevronDown, ChevronRight, Copy, Download, FolderOpen, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { shortPath } from "../state/format.ts";
import { CheckRow } from "../onboarding/Onboarding.tsx";
import { actions, useApp, type Project } from "../state/store.ts";
import { frameTimecode } from "../state/format.ts";
import { layoutOf } from "../state/project.ts";
import { usePlayback } from "../preview/playback.ts";
import { findItem } from "../timeline/edit.ts";
import { NumberField } from "../inspector/fields.tsx";
import { effectiveRange, type RangeKind } from "./exportRange.ts";

const QUALITIES: ReadonlyArray<{ readonly id: ExportQuality; readonly label: string; readonly hint: string }> = [
  { id: "draft", label: "Draft", hint: "Fast, for a quick look" },
  { id: "standard", label: "Standard", hint: "For sharing anywhere" },
  { id: "high", label: "High", hint: "Full size, the best copy" },
];

type LoudnessCard = { readonly id: ExportLoudness; readonly label: string; readonly sub: string; readonly hint: string };
const lufsText = (lufs: number) => `${lufs < 0 ? "−" : ""}${Math.abs(lufs)} LUFS`;
/** The loudness cards (D87): the presets, the project's own target when it isn't one, and As mixed. */
function loudnessCards(target: number): ReadonlyArray<LoudnessCard> {
  const hints: Readonly<Record<string, string>> = {
    normal: "Evens out the volume so it plays as loud as other videos on YouTube, Instagram and TikTok.",
    quiet: "A little quieter, as podcasts and Apple Music expect.",
    broadcast: "The TV level (EBU R128): quieter, with more room for peaks.",
  };
  return [
    ...LOUDNESS_PRESETS.map((p) => ({ id: p.id, label: p.name, sub: lufsText(p.lufs), hint: hints[p.id]! })),
    ...(choiceOfTarget(target) === "target" ? [{ id: "target" as const, label: "Project", sub: lufsText(target), hint: `The project's own loudness target (${targetWords(target)}), set in the Mixer.` }] : []),
    { id: "off", label: "As mixed", sub: "No change", hint: "Keeps your levels exactly as they sound in the editor." },
  ];
}

const RANGE_KINDS: ReadonlyArray<readonly [RangeKind, string]> = [
  ["all", "Whole timeline"],
  ["marks", "In to Out"],
  ["selection", "Selected clips"],
  ["custom", "Custom"],
];

const ACTIVE = new Set(["queued", "preparing", "rendering"]);
export const exportRunning = (job: ExportJob | undefined) => job !== undefined && ACTIVE.has(job.phase);

/** A file name the Finder accepts, ending in .mp4. */
const fileName = (name: string) => {
  const clean = name.replace(/[/:]/g, "-").trim() || "Untitled";
  return /\.mp4$/i.test(clean) ? clean : `${clean}.mp4`;
};
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
/** F29 (D173): the folder a file is in, by its name ("Movies"); "/" for the root. */
export const folderName = (path: string) => baseName(dirName(path)) || "/";
const fpsText = (fps: number) => `${Number(fps.toFixed(3))} fps`;

const eta = (s: number | undefined) => (s === undefined ? "" : s < 60 ? `About ${Math.max(1, Math.round(s))} s left` : `About ${Math.round(s / 60)} min left`);

export function ExportDialog({ project, dir }: { project: Project; dir: string }) {
  const { appInfo, exportJobs, exportJobId, exportFolder, setupChecks, setupChecking, environment, downloads } = useApp();
  // On a remote environment the video is made and kept on the server; Download brings it here (D109).
  const remote = environment.kind === "remote";
  const [quality, setQuality] = useState<ExportQuality>("standard");
  // F4 (D171): the Advanced row (collapsed): codec, bitrate, size, frame rate; undefined = the preset's.
  const [advanced, setAdvanced] = useState(false);
  const [codec, setCodec] = useState<ExportCodec>("h264");
  const [bitrate, setBitrate] = useState<number | undefined>();
  const [shortSide, setShortSide] = useState<number | undefined>();
  const [outFps, setOutFps] = useState<number | undefined>();
  const [copied, setCopied] = useState(false);
  // The default comes from the project's loudness target (D87: master.loudness.targetLufs, −14 when unset).
  const target = projectTargetLufs(project);
  const [loudness, setLoudness] = useState<ExportLoudness>(() => choiceOfTarget(target));
  const LOUDNESS = loudnessCards(target);
  const [name, setName] = useState(fileName(project.name));
  const [folder, setFolder] = useState(exportFolder ?? appInfo.defaultParentDir);
  const [error, setError] = useState<{ reason?: string | undefined; message: string; subtitles?: boolean } | undefined>();
  const [busy, setBusy] = useState(false);
  // Subtitles (D105): what the project's captions and Subtitles tracks would export as.
  const cueCount = useMemo(() => subtitleCues(project as Parameters<typeof subtitleCues>[0]).length, [project]);
  const [burn, setBurn] = useState(true);
  const [subFile, setSubFile] = useState(false);
  const [subTrack, setSubTrack] = useState(false);
  const [subFormat, setSubFormat] = useState<SubtitleFormat>("srt");
  const [language, setLanguage] = useState("en");
  const [savedSubs, setSavedSubs] = useState<string | undefined>();
  // A path the native save panel returned: it already asked before replacing a file there.
  const [confirmed, setConfirmed] = useState<string | undefined>();
  // A finished job stays on screen until "Export again" or the dialog closes.
  const [dismissed, setDismissed] = useState<string | undefined>();
  const job = exportJobs.find((j) => j.id === exportJobId && j.projectDir === dir && j.id !== dismissed && j.phase !== "cancelled");
  const cancelled = exportJobs.find((j) => j.id === exportJobId && j.phase === "cancelled");
  const ffmpeg = setupChecks?.find((c) => c.id === "ffmpeg");
  const noFfmpeg = ffmpeg !== undefined && ffmpeg.status !== "ready" && !job;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      actions.closeExport();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // G7 (D127): the part to export.
  const fps = project.canvas.fps;
  const end = layoutOf(project).end;
  const markIn = usePlayback((x) => x.markIn);
  const markOut = usePlayback((x) => x.markOut);
  const selectedId = usePlayback((x) => x.selected);
  const also = usePlayback((x) => x.also);
  const marks = markIn !== undefined || markOut !== undefined ? { from: markIn ?? 0, to: markOut ?? end } : undefined;
  const picked = (selectedId === undefined ? [] : [selectedId, ...also]).map((id) => findItem(project, id)).filter((p) => p !== undefined && p.item.type !== "captions");
  const selection = picked.length ? { from: Math.min(...picked.map((p) => p!.start)), to: Math.max(...picked.map((p) => p!.start + p!.item.duration)) } : undefined;
  const [rangeKind, setRangeKind] = useState<RangeKind>("all");
  const [custom, setCustom] = useState<{ from: number; to: number }>(() => marks ?? { from: 0, to: end });
  // Marks or a selection that went away (an undo, the agent) fall back to the whole timeline, visibly.
  const effective = effectiveRange(rangeKind, { marks, selection, custom });
  const range = effective.range;
  const rangeOk = !range || range.to > range.from;

  const output = `${folder.replace(/\/$/, "")}/${fileName(name)}`;
  const start = async (overwrite = false) => {
    setBusy(true);
    setError(undefined);
    const subtitles: ExportSubtitles | undefined = cueCount && (subFile || subTrack) ? { ...(subFile ? { file: subFormat } : {}), ...(subTrack ? { track: true, language } : {}) } : undefined;
    const video = { ...(codec !== "h264" ? { codec } : {}), ...(bitrate !== undefined ? { bitrateMbps: bitrate } : {}), ...(shortSide !== undefined ? { shortSide } : {}), ...(outFps !== undefined ? { fps: outFps } : {}) };
    const refused = await actions.startExport({ output, quality, loudness, ...(Object.keys(video).length ? { video } : {}), ...(loudness === "target" ? { targetLufs: target } : {}), overwrite: overwrite || output === confirmed, ...(subtitles ? { subtitles } : {}), ...(cueCount && !burn ? { burnCaptions: false } : {}), ...(range ? { range: { from: Math.round(range.from), to: Math.round(range.to) } } : {}) });
    setBusy(false);
    if (refused) {
      setError(refused);
      if (refused.reason === "no-ffmpeg") void actions.checkSetup();
    }
  };
  /** Subtitles only (D105): the file, named like the video, in the chosen folder; no video. */
  const subtitlesOnly = async (overwrite = false) => {
    setBusy(true);
    setError(undefined);
    setSavedSubs(undefined);
    const path = output.replace(/\.mp4$/i, `.${subFormat}`);
    const result = await actions.exportSubtitles({ output: path, overwrite });
    setBusy(false);
    if ("message" in result) setError({ ...result, subtitles: true });
    else setSavedSubs(`Saved ${baseName(result.path)} (${result.cues} cue${result.cues === 1 ? "" : "s"}).`);
  };
  const change = async () => {
    const chosen = await actions.chooseExportPath(output);
    if (!chosen) return;
    setFolder(dirName(chosen));
    setName(fileName(baseName(chosen)));
    setConfirmed(`${dirName(chosen).replace(/\/$/, "")}/${fileName(baseName(chosen))}`);
    setError(undefined);
  };

  let body;
  if (noFfmpeg) {
    body = (
      <div data-testid="export-no-ffmpeg">
        <p className="wiz-lead">Uncut exports with ffmpeg, and it isn't installed on this Mac yet. Install it, then check again.</p>
        <div className="wiz-list">
          <CheckRow check={ffmpeg} />
        </div>
        <div className="wiz-foot">
          <button className="btn ghost" onClick={actions.closeExport}>
            Close
          </button>
          <button className="btn primary" data-testid="export-recheck" disabled={setupChecking} onClick={() => void actions.checkSetup()}>
            {setupChecking ? "Checking…" : "Check again"}
          </button>
        </div>
      </div>
    );
  } else if (job) {
    const pct = Math.round(job.progress * 100);
    const status =
      job.phase === "queued"
        ? "Waiting for another export to finish…"
        : job.phase === "preparing"
          ? "Getting ready: drawing the text and measuring the sound…"
          : job.phase === "rendering"
            ? `Rendering… ${pct}%`
            : job.phase === "done"
              ? remote
                ? `Saved on ${environment.name} in ${job.elapsedSeconds ?? 0} s.`
                : `Saved in ${job.elapsedSeconds ?? 0} s, and shown in Finder.`
              : "The export didn't finish.";
    body = (
      <div data-testid="export-job" data-phase={job.phase} data-progress={job.progress} data-output={job.output}>
        <p className="wiz-lead" data-testid="export-job-where" title={job.output}>
          <b className="mono">{baseName(job.output)}</b> in{" "}
          <b data-testid="export-job-folder" title={dirName(job.output)}>
            {folderName(job.output)}
          </b>
          , {job.width}×{job.height}, {fpsText(job.fps)}, {CODEC_NAMES[job.codec ?? (job.quality === "high" ? "hevc" : "h264")]}, {job.seconds.toFixed(1)} s
        </p>
        {(job.subtitlesFile || job.subtitleTrack || job.burnCaptions === false) && (
          <p className="wiz-meta" data-testid="export-job-subtitles">
            {[job.subtitlesFile ? `Subtitles in ${baseName(job.subtitlesFile)}` : "", job.subtitleTrack ? `a soft subtitle track (${SUBTITLE_LANGUAGES.find((l) => l.tag === job.subtitleTrack)?.name ?? job.subtitleTrack})` : "", job.burnCaptions === false ? "captions not drawn into the picture" : ""]
              .filter(Boolean)
              .join(", ")
              .replace(/^a/, "A")}
            .
          </p>
        )}
        <div className="export-status" data-testid="export-status">
          {status}
          {job.phase === "rendering" && <span className="muted">{eta(job.etaSeconds)}</span>}
        </div>
        <div className="export-bar" data-testid="export-progress">
          <div style={{ width: `${job.phase === "done" ? 100 : job.phase === "rendering" ? pct : 0}%` }} className={job.phase === "preparing" || job.phase === "queued" ? "indeterminate" : ""} />
        </div>
        {job.warnings && job.warnings.length > 0 && job.phase !== "failed" && (
          <div className="export-warnings muted small" data-testid="export-warnings">
            {job.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
        {job.phase === "failed" && (
          <div className="inline-error" role="alert" data-testid="export-error">
            {job.error ?? "Something went wrong."}
          </div>
        )}
        <div className="wiz-foot">
          {ACTIVE.has(job.phase) ? (
            <>
              <button className="btn ghost" onClick={actions.closeExport} title="The export keeps going">
                Hide
              </button>
              <button className="btn" data-testid="export-cancel" onClick={() => void actions.cancelExport(job.id)}>
                Cancel export
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" data-testid="export-again" onClick={() => setDismissed(job.id)}>
                {job.phase === "done" ? "Export again" : "Try again"}
              </button>
              {job.phase === "done" && (
                <button className="btn ghost" data-testid="export-copy-path" title={job.output} onClick={() => void Promise.resolve(actions.copy(job.output)).then(() => setCopied(true))}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy path"}
                </button>
              )}
              {job.phase === "done" && !remote && (
                <button className="btn" data-testid="export-reveal" onClick={() => void actions.showInFolder(job.output)}>
                  <FolderOpen />
                  Show in Finder
                </button>
              )}
              {job.phase === "done" && remote && <DownloadButton job={job} state={downloads[job.id]} />}
              <button className="btn primary" data-testid="export-done" onClick={actions.closeExport}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    );
  } else {
    const look = LOUDNESS.find((l) => l.id === loudness) ?? LOUDNESS[0]!;
    const limiter = masterLimiter(project);
    const note = mixNote(project);
    const masterDb = project.master?.gainDb ?? 0;
    body = (
      <form
        data-testid="export-form"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="wiz-cards">
          {QUALITIES.map((q) => {
            const size = outputSize(project.canvas, q.id, shortSide);
            const mbps = q.id === quality && bitrate !== undefined ? bitrate : presetBitrateMbps(q.id, codec, size, outFps ?? fps);
            return (
              <button type="button" key={q.id} className={`wiz-card ${q.id === quality ? "active" : ""}`} data-testid={`quality-${q.id}`} data-active={q.id === quality} data-codec={codec} onClick={() => setQuality(q.id)}>
                {q.label}
                <span>
                  {size.width}×{size.height}, {fpsText(outFps ?? fps)}
                </span>
                <span data-testid={`quality-codec-${q.id}`}>
                  {CODEC_NAMES[codec]}, {mbps} Mb/s
                </span>
                <span>{q.hint}</span>
              </button>
            );
          })}
        </div>
        <button type="button" className="export-advanced-toggle" data-testid="export-advanced" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          {advanced ? <ChevronDown /> : <ChevronRight />}
          Advanced
          {!advanced && (codec !== "h264" || bitrate !== undefined || shortSide !== undefined || outFps !== undefined) && <span className="muted">{[codec !== "h264" ? CODEC_NAMES[codec] : "", bitrate !== undefined ? `${bitrate} Mb/s` : "", shortSide !== undefined ? `${shortSide}p` : "", outFps !== undefined ? fpsText(outFps) : ""].filter(Boolean).join(", ")}</span>}
        </button>
        {advanced && (
          <div className="export-advanced" data-testid="export-advanced-body">
            <div className="export-adv-row">
              <span className="muted">Codec</span>
              <div className="seg" data-testid="export-codec" role="radiogroup" aria-label="Codec">
                {(["h264", "hevc"] as const).map((c) => (
                  <button type="button" key={c} role="radio" aria-checked={codec === c} className={codec === c ? "active" : ""} data-testid={`export-codec-${c}`} onClick={() => setCodec(c)}>
                    {c === "h264" ? "H.264" : "HEVC (smaller, Apple devices)"}
                  </button>
                ))}
              </div>
            </div>
            <div className="export-adv-row">
              <span className="muted">Size</span>
              <select data-testid="export-size" value={shortSide ?? ""} onChange={(e) => setShortSide(e.target.value === "" ? undefined : Number(e.target.value))}>
                <option value="">{(({ width, height }) => `${width}×${height}`)(outputSize(project.canvas, quality))} ({QUALITIES.find((q) => q.id === quality)!.label})</option>
                {exportShortSides(project.canvas).map((side) => {
                  const s = outputSize(project.canvas, quality, side);
                  return (
                    <option key={side} value={side}>
                      {s.width}×{s.height}
                    </option>
                  );
                })}
              </select>
              <span className="muted">Frame rate</span>
              <select data-testid="export-fps" value={outFps ?? ""} onChange={(e) => setOutFps(e.target.value === "" ? undefined : Number(e.target.value))}>
                {exportFrameRates(fps).map((r, i) => (
                  <option key={r} value={i === 0 ? "" : r}>
                    {fpsText(r)}
                    {i === 0 ? " (project)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="export-adv-row">
              <span className="muted">Bitrate</span>
              <NumberField label="Mb/s" testId="export-bitrate" value={bitrate} placeholder={`${presetBitrateMbps(quality, codec, outputSize(project.canvas, quality, shortSide), outFps ?? fps)}`} step={1} min={0.1} max={500} onCommit={(v) => setBitrate(v)} />
            </div>
          </div>
        )}
        <div className="wiz-list form-fields export-fields">
          <label className="wiz-field">
            <span>File</span>
            <input data-testid="export-name" value={name} spellCheck={false} onChange={(e) => (setName(e.target.value), setError(undefined), setConfirmed(undefined))} onBlur={() => setName(fileName(name))} />
          </label>
          <div className="wiz-field">
            <span>Folder</span>
            <b className="ellipsis" data-testid="export-folder" title={folder}>
              {shortPath(folder, appInfo.homeDir)}
            </b>
            <button type="button" className="btn ghost" data-testid="export-change" onClick={() => void change()}>
              Change…
            </button>
          </div>
        </div>
        <div className="group-label export-label">Range</div>
        <div className="seg export-range" data-testid="export-range" role="radiogroup" aria-label="Range">
          {RANGE_KINDS.map(([id, label]) => (
            <button
              type="button"
              key={id}
              role="radio"
              aria-checked={effective.kind === id}
              className={effective.kind === id ? "active" : ""}
              data-testid={`export-range-${id}`}
              disabled={(id === "marks" && !marks) || (id === "selection" && !selection)}
              onClick={() => (setRangeKind(id), id === "custom" && setCustom(range ?? custom))}
            >
              {label}
            </button>
          ))}
        </div>
        {rangeKind === "custom" && (
          <div className="field-row export-custom">
            <NumberField label="From s" testId="export-range-from" value={Number((custom.from / fps).toFixed(2))} step={0.1} min={0} onCommit={(v) => setCustom({ ...custom, from: Math.max(0, Math.round((v ?? 0) * fps)) })} />
            <NumberField label="To s" testId="export-range-to" value={Number((custom.to / fps).toFixed(2))} step={0.1} min={0} onCommit={(v) => setCustom({ ...custom, to: Math.min(end, Math.round((v ?? 0) * fps)) })} />
          </div>
        )}
        <p className="wiz-meta" data-testid="export-range-text" data-from={range?.from ?? 0} data-to={range?.to ?? end}>
          {effective.fellBack && <span data-testid="export-range-fallback">{effective.fellBack === "marks" ? "The In and Out marks are gone: whole timeline. " : "Nothing is selected now: whole timeline. "}</span>}
          {rangeOk ? `${frameTimecode(range?.from ?? 0, fps)} to ${frameTimecode(range?.to ?? end, fps)}, ${(((range?.to ?? end) - (range?.from ?? 0)) / fps).toFixed(1)} s` : "The end has to come after the start."}
        </p>
        <div className="group-label export-label">Loudness</div>
        <div className="wiz-cards">
          {LOUDNESS.map((l) => (
            <button type="button" key={l.id} className={`wiz-card ${l.id === loudness ? "active" : ""}`} data-testid={`loudness-${l.id}`} data-active={l.id === loudness} onClick={() => setLoudness(l.id)}>
              {l.label}
              <span>{l.sub}</span>
            </button>
          ))}
        </div>
        <p className="wiz-meta" data-testid="loudness-hint">
          {look.hint}
          {limiter ? ` Peaks stay under ${limiter.ceilingDb < 0 ? "−" : ""}${Math.abs(limiter.ceilingDb)} dBTP (the master limiter).` : " The master limiter is off: loud peaks can clip."}
        </p>
        {note && (
          // D83: the export mixes what the preview plays, so a solo left on exports only those tracks.
          <p className="wiz-meta solo-note" data-testid="export-solo-note">
            {note}
          </p>
        )}
        {masterDb > SILENCE_DB && masterDb !== 0 && loudness !== "off" && (
          <p className="wiz-meta" data-testid="export-master-note">
            The master volume ({dbWords(masterDb)}) is heard in the editor and in As mixed; {look.label} evens the loudness out after it.
          </p>
        )}
        {cueCount > 0 && (
          <>
            <div className="group-label export-label">Captions and subtitles</div>
            <div className="export-subs" data-testid="export-subtitles">
              <label className="export-sub-row">
                <input type="checkbox" data-testid="export-burn" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
                <span>Burn in captions</span>
                <span className="muted">Drawn into the picture, as in the preview</span>
              </label>
              <label className="export-sub-row">
                <input type="checkbox" data-testid="export-sub-file" checked={subFile} onChange={(e) => setSubFile(e.target.checked)} />
                <span>Subtitles file (.srt / .vtt) next to the video</span>
              </label>
              <label className="export-sub-row">
                <input type="checkbox" data-testid="export-sub-track" checked={subTrack} onChange={(e) => setSubTrack(e.target.checked)} />
                <span>Soft subtitle track in the video</span>
                <select data-testid="export-sub-language" value={language} disabled={!subTrack} onChange={(e) => setLanguage(e.target.value)} title="The track's language">
                  {SUBTITLE_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="export-sub-row">
                <span className="muted">File format</span>
                <div className="seg" data-testid="export-sub-format">
                  {(["srt", "vtt"] as const).map((f) => (
                    <button type="button" key={f} className={f === subFormat ? "active" : ""} data-testid={`export-sub-format-${f}`} data-active={f === subFormat} onClick={() => setSubFormat(f)}>
                      {f === "srt" ? "SRT" : "WebVTT"}
                    </button>
                  ))}
                </div>
                <span className="muted" data-testid="export-sub-count">
                  {cueCount} cue{cueCount === 1 ? "" : "s"}, in the edit's time
                </span>
              </div>
            </div>
            {!burn && !subFile && !subTrack && (
              <p className="wiz-meta" data-testid="export-no-captions-note">
                The video will have no captions: pick a subtitles file or a soft track to keep them.
              </p>
            )}
            {savedSubs && (
              <p className="wiz-meta" data-testid="export-subtitles-saved">
                {savedSubs}
              </p>
            )}
          </>
        )}
        {cancelled && !error && <p className="wiz-meta">The last export was cancelled; nothing was saved.</p>}
        {error && (
          <div className="inline-error" role="alert" data-testid="export-refused" data-reason={error.reason}>
            {error.message}
            {error.reason === "exists" && (
              <button type="button" className="btn export-replace" data-testid="export-replace" disabled={busy} onClick={() => void (error.subtitles ? subtitlesOnly(true) : start(true))}>
                Replace it
              </button>
            )}
          </div>
        )}
        <div className="wiz-foot">
          <p className="export-note">Opens in Finder when it's done.</p>
          <button type="button" className="btn ghost" onClick={actions.closeExport}>
            Cancel
          </button>
          {cueCount > 0 && (
            <button type="button" className="btn" data-testid="export-subtitles-only" disabled={busy || !name.trim()} onClick={() => void subtitlesOnly()} title={`Just the subtitles as a .${subFormat} file, no video`}>
              Subtitles only
            </button>
          )}
          <button type="submit" className="btn primary" data-testid="export-start" disabled={busy || !name.trim() || !rangeOk}>
            Export
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="modal-layer" data-testid="export-modal" onMouseDown={(e) => e.target === e.currentTarget && actions.closeExport()}>
      <div className="modal wiz">
        <div className="wiz-panel">
          <div className="export-head">
            <h1>Export video</h1>
            <button className="icon-btn" title="Close (Esc)" data-testid="export-close" onClick={actions.closeExport}>
              <X />
            </button>
          </div>
          {body}
        </div>
      </div>
    </div>
  );
}

/** D109: a remote export's Download, then where it went (with Finder, since that's on this Mac). */
function DownloadButton({ job, state }: { job: ExportJob; state: { readonly state: "running" } | { readonly path: string } | { readonly error: string } | undefined }) {
  if (state && "path" in state) {
    return (
      <>
        <span className="muted small ellipsis" data-testid="export-downloaded" title={state.path}>
          Downloaded to {baseName(state.path)}
        </span>
        <button className="btn" data-testid="export-reveal-download" onClick={() => void actions.revealLocal(state.path)}>
          <FolderOpen />
          Show in Finder
        </button>
      </>
    );
  }
  return (
    <>
      {state && "error" in state && (
        <span className="inline-error small" data-testid="export-download-error">
          {state.error}
        </span>
      )}
      <button className="btn" data-testid="export-download" disabled={state !== undefined && "state" in state} onClick={() => void actions.downloadExport(job)}>
        <Download />
        {state && "state" in state ? "Downloading…" : "Download…"}
      </button>
    </>
  );
}
