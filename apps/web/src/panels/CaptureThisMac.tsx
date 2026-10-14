// The Capture tab's This Mac section (D114, first on the tab since D143): a screen or window (a
// browser window by its page title; the default part, D144), a voiceover from the microphone, a
// camera take. Each says whether macOS allows it (not asked yet, off with how to turn it on,
// or allowed), then its devices, a 3-2-1 countdown, a timer with Stop and Cancel. The recording
// itself is apps/web/src/capture/recorder.ts.
import { AppWindow, ChevronDown, CircleDot, Monitor, Mic, Pause, Play, RefreshCw, Settings2, Square, Video, X, type LucideIcon } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { askAccess, cancelTake, clock, closeMonitor, closePreview, levelDb, loadInputs, loadSources, openMonitor, openPreview, openPrivacySettings, pauseTake, refreshAccess, resumeTake, startTake, stopTake, getRecorder, takeSeconds, useRecorder, type Resolution, type TakeMode } from "../capture/recorder.ts";
import type { CaptureSource } from "../state/bridge.ts";
import type { MediaAccessKind } from "../state/bridge.ts";
import { usePlayback } from "../preview/playback.ts";
import { useApp } from "../state/store.ts";

const NAMES: Record<MediaAccessKind, string> = { microphone: "the microphone", camera: "the camera", screen: "screen recording" };
const PANES: Record<MediaAccessKind, string> = { microphone: "Microphone", camera: "Camera", screen: "Screen & System Audio Recording" };

/** Whether macOS lets Uncut use `kind`; children only once it does. */
function Access({ kind, children }: { kind: MediaAccessKind; children: React.ReactNode }) {
  const access = useRecorder((s) => s.access?.[kind]);
  if (access === undefined) return <div className="muted small">Checking permissions…</div>;
  if (access === "granted" || access === "unknown") return <>{children}</>;
  const denied = access === "denied" || access === "restricted";
  return (
    <div className="capture-access" data-testid="capture-access" data-kind={kind} data-state={access}>
      {denied ? (
        <>
          <div className="small">
            Uncut isn't allowed to use {NAMES[kind]}.{" "}
            {access === "restricted" ? "This Mac's settings or a profile turn it off for every app." : `Turn Uncut on in System Settings, Privacy & Security, ${PANES[kind]}, then check again.`}
            {kind === "screen" && access === "denied" ? " macOS may ask you to quit and reopen Uncut after that." : ""}
          </div>
          <div className="capture-actions">
            <button className="btn" data-testid={`capture-open-settings-${kind}`} onClick={() => openPrivacySettings(kind)}>
              <Settings2 />
              Open System Settings
            </button>
            <button className="btn ghost" data-testid={`capture-check-access-${kind}`} onClick={() => void refreshAccess()}>
              <RefreshCw />
              Check again
            </button>
          </div>
        </>
      ) : kind === "screen" ? (
        <>
          <div className="small muted">macOS asks once whether Uncut may record the screen, the first time it lists your screens and windows.</div>
          <button className="btn" data-testid="capture-allow-screen" onClick={() => void loadSources()}>
            <Monitor />
            Show screens and windows
          </button>
        </>
      ) : (
        <>
          <div className="small muted">{kind === "microphone" ? "Uncut needs the microphone to record a voiceover. macOS asks once." : "Uncut needs the camera to record a take. macOS asks once."}</div>
          <button className="btn" data-testid={`capture-allow-${kind}`} onClick={() => void askAccess(kind)}>
            {kind === "microphone" ? <Mic /> : <Video />}
            Allow {NAMES[kind]}
          </button>
        </>
      )}
    </div>
  );
}

/** The meter's scale marks, dBFS. */
const SCALE = [-60, -40, -20, -12, -6, 0];
const pct = (db: number) => `${((db + 60) / 60) * 100}%`;

/**
 * D209: the microphone's level, green to amber to red, with a peak mark that holds for a moment
 * and a dB scale under it.
 */
export function LevelMeter({ testId = "capture-mic-level", compact = false }: { testId?: string; compact?: boolean }) {
  const level = useRecorder((s) => s.level);
  const peak = useRecorder((s) => s.peak);
  const db = levelDb(peak);
  return (
    <div className={`level-meter ${compact ? "compact" : ""}`} title="The microphone's level">
      <div className="level-bar" data-testid={testId} data-level={level.toFixed(2)} data-peak={peak.toFixed(2)}>
        <div className="level-fill" style={{ clipPath: `inset(0 ${100 - level * 100}% 0 0)` }} />
        {peak > 0 && <div className={`level-peak ${peak > 0.95 ? "hot" : ""}`} data-testid="capture-level-peak" style={{ left: `calc(${peak * 100}% - 1px)` }} />}
        <span className="level-db" data-testid="capture-level-db">{Number.isFinite(db) ? `${Math.round(db)} dB` : "-∞ dB"}</span>
      </div>
      {!compact && (
        <div className="level-scale" data-testid="capture-level-scale">
          {SCALE.map((d) => (
            <span key={d} style={{ left: pct(d) }}>
              {d}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The running take's seconds, ticking. */
function useTakeSeconds() {
  const phase = useRecorder((s) => s.phase);
  const startedAt = useRecorder((s) => s.startedAt);
  const pausedMs = useRecorder((s) => s.pausedMs);
  const pausedAt = useRecorder((s) => s.pausedAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [phase]);
  return takeSeconds({ startedAt, pausedMs, pausedAt }, now);
}

/**
 * D209: the recording bar: a big record button; then the 3-2-1; then the timer, the level meter
 * (when the take has sound), Pause, Stop and Cancel; then saving.
 */
function RecordBar({ mode, disabled, onRecord, label = "Record", meter }: { mode: TakeMode; disabled: boolean; onRecord: () => void; label?: string; meter: boolean }) {
  const phase = useRecorder((s) => s.phase);
  const count = useRecorder((s) => s.count);
  const paused = useRecorder((s) => s.paused);
  const runningMode = useRecorder((s) => s.mode);
  const seconds = useTakeSeconds();
  const mine = runningMode === mode;
  if (phase === "idle" || !mine) {
    return (
      <div className="record-bar idle" data-testid="capture-record-bar" data-state="idle">
        <button className="record-button" data-testid="capture-take-record" disabled={disabled || phase !== "idle"} onClick={onRecord}>
          <span className="record-dot" />
          <span className="record-label">{label}</span>
        </button>
        {meter && <LevelMeter testId="capture-bar-level" compact />}
      </div>
    );
  }
  if (phase === "saving") {
    return (
      <div className="record-bar" data-testid="capture-record-bar" data-state="saving">
        <span className="small muted" data-testid="capture-take-saving">
          Saving the take…
        </span>
      </div>
    );
  }
  return (
    <div className={`record-bar live ${paused ? "paused" : ""}`} data-testid="capture-record-bar" data-state={phase === "countdown" ? "countdown" : paused ? "paused" : "recording"}>
      <div className="record-bar-row">
        {phase === "countdown" ? (
          <span className="capture-countdown" data-testid="capture-countdown">
            {count ?? ""}
          </span>
        ) : (
          <span className={`capture-timer ${paused ? "paused" : ""}`} data-testid="capture-take-timer">
            <CircleDot />
            {clock(seconds)}
          </span>
        )}
        <div className="grow" />
        {phase === "recording" && (
          <button className="icon-btn record-ctl" data-testid={paused ? "capture-take-resume" : "capture-take-pause"} title={paused ? "Resume recording" : "Pause recording"} onClick={() => (paused ? resumeTake() : pauseTake())}>
            {paused ? <Play /> : <Pause />}
          </button>
        )}
        {phase === "recording" && (
          <button className="record-ctl stop" data-testid="capture-take-stop" title="Stop and keep the take" onClick={() => void stopTake()}>
            <Square />
            Stop
          </button>
        )}
        <button className="icon-btn record-ctl" data-testid="capture-take-cancel" title="Stop and keep nothing" onClick={() => cancelTake()}>
          <X />
        </button>
      </div>
      {meter && <LevelMeter testId="capture-bar-level" />}
    </div>
  );
}

/** D209: a device picker in the app's style (a native list underneath, so the keyboard and VoiceOver work). */
function Picker({ icon: Icon, value, onChange, testId, title, disabled, children }: { icon: LucideIcon; value: string; onChange: (v: string) => void; testId: string; title: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <label className={`picker ${disabled ? "disabled" : ""}`} title={title}>
      <Icon className="picker-icon" />
      <select data-testid={testId} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
      <ChevronDown className="picker-caret" />
    </label>
  );
}

/** D209: an option as a compact toggle chip (a real checkbox over it). */
function Option({ testId, checked, disabled, onChange, children, title }: { testId: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; children: React.ReactNode; title?: string }) {
  return (
    <label className={`opt-chip ${checked ? "on" : ""} ${disabled ? "disabled" : ""}`} title={title}>
      <input type="checkbox" data-testid={testId} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

function MicSelect({ value, onChange, testId, disabled }: { value: string; onChange: (id: string) => void; testId: string; disabled?: boolean }) {
  const mics = useRecorder((s) => s.mics);
  return (
    <Picker icon={Mic} value={value} onChange={onChange} testId={testId} title="Microphone" disabled={disabled}>
      {mics.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </Picker>
  );
}

/** Meters the microphone while `on` (a take with sound shows the meter). */
function useMonitor(on: boolean, mic: string) {
  useEffect(() => {
    if (!on) return;
    void openMonitor(mic || undefined);
    return () => closeMonitor();
  }, [on, mic]);
}

/** A screen or window tile: its picture, else its app icon, else a placeholder (also when the picture fails). */
function SourceTile({ source, active, disabled, onPick }: { source: CaptureSource; active: boolean; disabled: boolean; onPick: () => void }) {
  const [broken, setBroken] = useState<ReadonlyArray<string>>([]);
  const picture = [source.thumbnail, source.icon ?? ""].find((u) => u && !broken.includes(u));
  return (
    <button className={`capture-source${active ? " active" : ""}`} data-testid="capture-source" data-id={source.id} data-picture={picture ? (picture === source.thumbnail ? "thumbnail" : "icon") : "none"} disabled={disabled} title={source.name} onClick={onPick}>
      {picture ? (
        <span className={`capture-source-pic ${picture === source.thumbnail ? "" : "icon"}`}>
          <img src={picture} alt="" data-testid="capture-source-img" onError={() => setBroken((b) => [...b, picture])} />
        </span>
      ) : (
        <span className="capture-source-icon" data-testid="capture-source-placeholder">
          {source.kind === "screen" ? <Monitor /> : <AppWindow />}
        </span>
      )}
      <span className="capture-source-name">{source.name}</span>
    </button>
  );
}

function MicPart({ mic, setMic, busy, canRecord }: { mic: string; setMic: (id: string) => void; busy: boolean; canRecord: boolean }) {
  const access = useRecorder((s) => s.access?.microphone);
  const fps = usePlayback((s) => s.fps);
  const frame = usePlayback((s) => s.frame);
  const [play, setPlay] = useState(true);
  const [mute, setMute] = useState(true);
  const allowed = access === "granted" || access === "unknown";
  useMonitor(allowed, mic);
  return (
    <div className="capture-part" data-testid="capture-mic">
      <Access kind="microphone">
        <MicSelect value={mic} onChange={setMic} testId="capture-mic-device" disabled={busy} />
        <LevelMeter />
        <div className="opt-row">
          <Option testId="capture-play-timeline" checked={play} disabled={busy} onChange={setPlay} title="Play the timeline from the playhead while recording">
            Play timeline
          </Option>
          <Option testId="capture-mute-timeline" checked={mute} disabled={busy || !play} onChange={setMute} title="Mute it, so the microphone only hears you">
            Muted
          </Option>
        </div>
        <div className="small muted">Goes on a Voiceover track at the playhead ({clock(frame / Math.max(1, fps))}).</div>
        <RecordBar mode="voiceover" meter={false} disabled={!canRecord} onRecord={() => void startTake({ mode: "voiceover", mic: mic || undefined, playTimeline: play, muteTimeline: mute })} />
      </Access>
    </div>
  );
}

function CameraPart({ mic, setMic, busy, canRecord }: { mic: string; setMic: (id: string) => void; busy: boolean; canRecord: boolean }) {
  const access = useRecorder((s) => s.access);
  const cameras = useRecorder((s) => s.cameras);
  const preview = useRecorder((s) => s.preview);
  const previewError = useRecorder((s) => s.previewError);
  const [camera, setCamera] = useState("");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [withMic, setWithMic] = useState(true);
  const [place, setPlace] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const allowed = access?.camera === "granted" || access?.camera === "unknown";
  const micAllowed = access?.microphone === "granted" || access?.microphone === "unknown";
  const sound = withMic && micAllowed;
  useMonitor(allowed && sound, mic);
  useEffect(() => {
    if (!allowed) return;
    void openPreview(camera || undefined, resolution);
    return () => closePreview();
  }, [allowed, camera, resolution]);
  useEffect(() => {
    if (video.current && video.current.srcObject !== (preview ?? null)) video.current.srcObject = preview ?? null;
  }, [preview]);
  useEffect(() => {
    if (!camera && cameras[0]) setCamera(cameras[0].id);
  }, [cameras, camera]);
  return (
    <div className="capture-part" data-testid="capture-camera">
      <Access kind="camera">
        <div className="capture-preview">
          <video ref={video} data-testid="capture-camera-preview" autoPlay muted playsInline />
          {previewError && <div className="inline-error small">{previewError}</div>}
        </div>
        <div className="picker-row">
          <Picker icon={Video} value={camera} onChange={setCamera} testId="capture-camera-device" title="Camera" disabled={busy}>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Picker>
          <div className="seg capture-resolution" data-testid="capture-camera-resolution">
            {(["720p", "1080p"] as const).map((r) => (
              <button key={r} className={resolution === r ? "active" : ""} data-value={r} disabled={busy} onClick={() => setResolution(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>
        {sound && <MicSelect value={mic} onChange={setMic} testId="capture-camera-mic" disabled={busy} />}
        <div className="opt-row">
          <Option testId="capture-camera-with-mic" checked={sound} disabled={busy || !micAllowed} onChange={setWithMic} title={micAllowed ? "Record sound from a microphone too" : "Allow the microphone first"}>
            Sound
          </Option>
          <Option testId="capture-place" checked={place} disabled={busy} onChange={setPlace} title="Also put it on the timeline at the playhead">
            On the timeline
          </Option>
        </div>
        <RecordBar mode="camera" meter={sound} disabled={!canRecord} onRecord={() => void startTake({ mode: "camera", camera: camera || undefined, resolution, withMic: sound, mic: mic || undefined, place })} />
      </Access>
    </div>
  );
}

function ScreenPart({ mic, setMic, busy, canRecord }: { mic: string; setMic: (id: string) => void; busy: boolean; canRecord: boolean }) {
  const access = useRecorder((s) => s.access);
  const sources = useRecorder((s) => s.sources);
  const loading = useRecorder((s) => s.loadingSources);
  const sourcesError = useRecorder((s) => s.sourcesError);
  const [picked, setPicked] = useState("");
  const [withMic, setWithMic] = useState(false);
  const [place, setPlace] = useState(false);
  const allowed = access?.screen === "granted" || access?.screen === "unknown";
  const micAllowed = access?.microphone === "granted" || access?.microphone === "unknown";
  const sound = withMic && micAllowed;
  useMonitor(allowed && sound, mic);
  useEffect(() => {
    if (allowed) void loadSources();
  }, [allowed]);
  const source = sources?.find((s) => s.id === picked);
  return (
    <div className="capture-part" data-testid="capture-screen">
      <Access kind="screen">
        <div className="capture-sources-head small muted">
          Pick a screen or window
          <button className="icon-btn" data-testid="capture-sources-refresh" disabled={loading || busy} title="List screens and windows again" onClick={() => void loadSources()}>
            <RefreshCw className={loading ? "spin" : ""} />
          </button>
        </div>
        {sourcesError && <div className="inline-error small">{sourcesError}</div>}
        {(["screen", "window"] as const).map((kind) => {
          const group = (sources ?? []).filter((s) => s.kind === kind);
          if (!group.length) return null;
          return (
            <React.Fragment key={kind}>
              <div className="capture-sources-group small muted">{kind === "screen" ? "Screens" : "Windows"}</div>
              <div className="capture-sources" data-testid="capture-sources" data-kind={kind}>
                {group.map((s) => (
                  <SourceTile key={s.id} source={s} active={picked === s.id} disabled={busy} onPick={() => setPicked(s.id)} />
                ))}
              </div>
            </React.Fragment>
          );
        })}
        {sources && sources.length === 0 && !loading && <div className="small muted">No screens or windows to record.</div>}
        {sound && <MicSelect value={mic} onChange={setMic} testId="capture-screen-mic" disabled={busy} />}
        <div className="opt-row">
          <Option testId="capture-screen-with-mic" checked={sound} disabled={busy || !micAllowed} onChange={setWithMic} title={micAllowed ? "Record the microphone too" : "Allow the microphone under Microphone first"}>
            Microphone
          </Option>
          <Option testId="capture-screen-place" checked={place} disabled={busy} onChange={setPlace} title="Also put it on the timeline at the playhead">
            On the timeline
          </Option>
        </div>
        <RecordBar mode="screen" label="Record screen" meter={sound} disabled={!canRecord || !source} onRecord={() => void startTake({ mode: "screen", source, withMic: sound, mic: mic || undefined, place })} />
      </Access>
    </div>
  );
}

export function CaptureThisMac() {
  const app = useApp();
  const phase = useRecorder((s) => s.phase);
  const running = useRecorder((s) => s.mode);
  const message = useRecorder((s) => s.message);
  const recordedMs = useRecorder((s) => s.recordedMs);
  // Back on the tab mid-take: show the part that has its Stop.
  const [mode, setMode] = useState<TakeMode>(() => getRecorder().mode ?? "screen");
  const [mic, setMic] = useState("");
  const mics = useRecorder((s) => s.mics);
  useEffect(() => {
    void refreshAccess().then(loadInputs);
  }, []);
  useEffect(() => {
    if (!mic && mics[0]) setMic(mics[0].id);
  }, [mics, mic]);
  const busy = phase !== "idle";
  const canRecord = app.connection === "connected" && !!app.snapshot && !busy;
  const tabs: Array<{ id: TakeMode; label: string }> = [
    { id: "screen", label: "Screen" },
    { id: "voiceover", label: "Microphone" },
    { id: "camera", label: "Camera" },
  ];
  return (
    <div className="lib-section capture-this-mac" data-testid="capture-this-mac" data-phase={phase} {...(recordedMs !== undefined ? { "data-recorded-ms": recordedMs } : {})}>
      <div className="lib-label">This Mac</div>
      <div className="seg capture-modes">
        {tabs.map((t) => (
          <button key={t.id} className={mode === t.id ? "active" : ""} data-testid={`capture-mode-${t.id}`} disabled={busy && running !== t.id} onClick={() => setMode(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {!app.snapshot && <div className="small muted">Open a project to record: takes go into its media folder.</div>}
      {mode === "voiceover" && <MicPart mic={mic} setMic={setMic} busy={busy} canRecord={canRecord} />}
      {mode === "camera" && <CameraPart mic={mic} setMic={setMic} busy={busy} canRecord={canRecord} />}
      {mode === "screen" && <ScreenPart mic={mic} setMic={setMic} busy={busy} canRecord={canRecord} />}
      {message && (
        <div className={`capture-message small ${message.kind}`} data-testid={`capture-take-${message.kind}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}
