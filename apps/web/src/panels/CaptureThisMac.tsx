// The Capture tab's This Mac section (D114, first on the tab since D143): a screen or window (a
// browser window by its page title; the default part, D144), a voiceover from the microphone, a
// camera take. Each says whether macOS allows it (not asked yet, off with how to turn it on,
// or allowed), then its devices, a 3-2-1 countdown, a timer with Stop and Cancel. The recording
// itself is apps/web/src/capture/recorder.ts.
import { AppWindow, CircleDot, Monitor, Mic, RefreshCw, Settings2, Square, Video, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { askAccess, cancelTake, clock, closeMonitor, closePreview, loadInputs, loadSources, openMonitor, openPreview, openPrivacySettings, refreshAccess, startTake, stopTake, getRecorder, useRecorder, type Resolution, type TakeMode } from "../capture/recorder.ts";
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

/** Record, then 3-2-1, then the timer with Stop and Cancel, then saving. */
function TakeControls({ mode, disabled, onRecord, label = "Record" }: { mode: TakeMode; disabled: boolean; onRecord: () => void; label?: string }) {
  const phase = useRecorder((s) => s.phase);
  const count = useRecorder((s) => s.count);
  const startedAt = useRecorder((s) => s.startedAt);
  const runningMode = useRecorder((s) => s.mode);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [phase]);
  const mine = runningMode === mode;
  if (phase === "idle" || !mine) {
    return (
      <button className="btn primary capture-record" data-testid="capture-take-record" disabled={disabled || phase !== "idle"} onClick={onRecord}>
        <CircleDot />
        {label}
      </button>
    );
  }
  if (phase === "saving") return <div className="small muted" data-testid="capture-take-saving">Saving the take…</div>;
  return (
    <div className="capture-take-row">
      {phase === "countdown" ? (
        <span className="capture-countdown" data-testid="capture-countdown">
          {count ?? ""}
        </span>
      ) : (
        <span className="capture-timer" data-testid="capture-take-timer">
          <CircleDot />
          {clock((now - (startedAt ?? now)) / 1000)}
        </span>
      )}
      {phase === "recording" && (
        <button className="btn small-btn" data-testid="capture-take-stop" title="Stop and keep the take" onClick={() => void stopTake()}>
          <Square />
          Stop
        </button>
      )}
      <button className="btn ghost small-btn" data-testid="capture-take-cancel" title="Stop and keep nothing" onClick={() => cancelTake()}>
        <X />
        Cancel
      </button>
    </div>
  );
}

function MicSelect({ value, onChange, testId, none }: { value: string; onChange: (id: string) => void; testId: string; none?: boolean }) {
  const mics = useRecorder((s) => s.mics);
  return (
    <select className="field input" data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} title="Microphone">
      {none && <option value="">No sound</option>}
      {mics.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

function MicPart({ mic, setMic, busy, canRecord }: { mic: string; setMic: (id: string) => void; busy: boolean; canRecord: boolean }) {
  const access = useRecorder((s) => s.access?.microphone);
  const level = useRecorder((s) => s.level);
  const fps = usePlayback((s) => s.fps);
  const frame = usePlayback((s) => s.frame);
  const [play, setPlay] = useState(true);
  const [mute, setMute] = useState(true);
  const allowed = access === "granted" || access === "unknown";
  useEffect(() => {
    if (!allowed) return;
    void openMonitor(mic || undefined);
    return () => closeMonitor();
  }, [allowed, mic]);
  return (
    <div className="capture-part" data-testid="capture-mic">
      <Access kind="microphone">
        <MicSelect value={mic} onChange={setMic} testId="capture-mic-device" />
        <div className="capture-level" data-testid="capture-mic-level" data-level={level.toFixed(2)} title="The microphone's level">
          <div style={{ width: `${Math.round(level * 100)}%` }} className={level > 0.95 ? "hot" : ""} />
        </div>
        <label className="check-row">
          <input type="checkbox" data-testid="capture-play-timeline" checked={play} disabled={busy} onChange={(e) => setPlay(e.target.checked)} />
          Play the timeline while recording
        </label>
        <label className="check-row">
          <input type="checkbox" data-testid="capture-mute-timeline" checked={mute} disabled={busy || !play} onChange={(e) => setMute(e.target.checked)} />
          Mute it, so the microphone only hears you
        </label>
        <div className="small muted">Goes on a Voiceover track at the playhead ({clock(frame / Math.max(1, fps))}).</div>
        <TakeControls mode="voiceover" disabled={!canRecord} onRecord={() => void startTake({ mode: "voiceover", mic: mic || undefined, playTimeline: play, muteTimeline: mute })} />
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
        <select className="field input" data-testid="capture-camera-device" value={camera} disabled={busy} onChange={(e) => setCamera(e.target.value)} title="Camera">
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <div className="seg capture-resolution" data-testid="capture-camera-resolution">
          {(["720p", "1080p"] as const).map((r) => (
            <button key={r} className={resolution === r ? "active" : ""} data-value={r} disabled={busy} onClick={() => setResolution(r)}>
              {r}
            </button>
          ))}
        </div>
        <label className="check-row">
          <input type="checkbox" data-testid="capture-camera-with-mic" checked={withMic && micAllowed} disabled={busy || !micAllowed} onChange={(e) => setWithMic(e.target.checked)} />
          Record sound too{micAllowed ? "" : " (allow the microphone first)"}
        </label>
        {withMic && micAllowed && <MicSelect value={mic} onChange={setMic} testId="capture-camera-mic" />}
        <label className="check-row">
          <input type="checkbox" data-testid="capture-place" checked={place} disabled={busy} onChange={(e) => setPlace(e.target.checked)} />
          Also put it on the timeline at the playhead
        </label>
        <TakeControls mode="camera" disabled={!canRecord} onRecord={() => void startTake({ mode: "camera", camera: camera || undefined, resolution, withMic: withMic && micAllowed, mic: mic || undefined, place })} />
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
                  <button key={s.id} className={`capture-source${picked === s.id ? " active" : ""}`} data-testid="capture-source" data-id={s.id} disabled={busy} title={s.name} onClick={() => setPicked(s.id)}>
                    {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="capture-source-icon">{s.kind === "screen" ? <Monitor /> : <AppWindow />}</span>}
                    <span className="capture-source-name">{s.name}</span>
                  </button>
                ))}
              </div>
            </React.Fragment>
          );
        })}
        {sources && sources.length === 0 && !loading && <div className="small muted">No screens or windows to record.</div>}
        <label className="check-row">
          <input type="checkbox" data-testid="capture-screen-with-mic" checked={withMic && micAllowed} disabled={busy || !micAllowed} onChange={(e) => setWithMic(e.target.checked)} />
          Record the microphone too{micAllowed ? "" : " (allow it under Microphone first)"}
        </label>
        {withMic && micAllowed && <MicSelect value={mic} onChange={setMic} testId="capture-screen-mic" />}
        <label className="check-row">
          <input type="checkbox" data-testid="capture-screen-place" checked={place} disabled={busy} onChange={(e) => setPlace(e.target.checked)} />
          Also put it on the timeline at the playhead
        </label>
        <TakeControls mode="screen" label="Record screen" disabled={!canRecord || !source} onRecord={() => void startTake({ mode: "screen", source, withMic: withMic && micAllowed, mic: mic || undefined, place })} />
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
