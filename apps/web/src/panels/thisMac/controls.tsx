import { Settings2, RefreshCw, Monitor, Mic, Video, CircleDot, Play, Pause, Square, X, type LucideIcon, ChevronDown, AppWindow } from "lucide-react";
import React, { useState, useEffect } from "react";
import {
  useRecorder,
  openPrivacySettings,
  refreshAccess,
  loadSources,
  askAccess,
  levelDb,
  takeSeconds,
  type TakeMode,
  clock,
  resumeTake,
  pauseTake,
  stopTake,
  cancelTake,
  openMonitor,
  closeMonitor,
} from "../../capture/recorder.ts";
import type { MediaAccessKind, CaptureSource } from "../../state/bridge.ts";
import { Tooltip } from "../../ui/Tooltip.tsx";

const NAMES: Record<MediaAccessKind, string> = { microphone: "the microphone", camera: "the camera", screen: "screen recording" };
const PANES: Record<MediaAccessKind, string> = { microphone: "Microphone", camera: "Camera", screen: "Screen & System Audio Recording" };

/** Whether macOS lets Uncut use `kind`; children only once it does. `sound`: the screen permission asked for this Mac's sound (D210). */
export function Access({ kind, children, sound = false }: { kind: MediaAccessKind; children: React.ReactNode; sound?: boolean }) {
  const access = useRecorder((s) => s.access?.[kind]);
  if (access === undefined) return <div className="muted small">Checking permissions…</div>;
  if (access === "granted" || access === "unknown") return <>{children}</>;
  const denied = access === "denied" || access === "restricted";
  return (
    <div className="capture-access" data-testid="capture-access" data-kind={kind} data-state={access}>
      {denied ? (
        <>
          <div className="small">
            {sound ? "Uncut isn't allowed to record this Mac's sound: macOS lets it with screen recording." : `Uncut isn't allowed to use ${NAMES[kind]}.`}{" "}
            {access === "restricted"
              ? "This Mac's settings or a profile turn it off for every app."
              : `Turn Uncut on in System Settings, Privacy & Security, ${PANES[kind]}, then check again.`}
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
          <div className="small muted">
            {sound
              ? "macOS asks once whether Uncut may record the screen and this Mac's sound."
              : "macOS asks once whether Uncut may record the screen, the first time it lists your screens and windows."}
          </div>
          <button className="btn" data-testid="capture-allow-screen" onClick={() => void loadSources()}>
            <Monitor />
            {sound ? "Allow screen and sound recording" : "Show screens and windows"}
          </button>
        </>
      ) : (
        <>
          <div className="small muted">
            {kind === "microphone"
              ? "Uncut needs the microphone to record a voiceover. macOS asks once."
              : "Uncut needs the camera to record a take. macOS asks once."}
          </div>
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
        {peak > 0 && (
          <div className={`level-peak ${peak > 0.95 ? "hot" : ""}`} data-testid="capture-level-peak" style={{ left: `calc(${peak * 100}% - 1px)` }} />
        )}
        <span className="level-db" data-testid="capture-level-db">
          {Number.isFinite(db) ? `${Math.round(db)} dB` : "-∞ dB"}
        </span>
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
 * D209: the recording bar: a big record button; then the timer, the level meter (when the take has
 * sound), Pause, Stop and Cancel; then saving. (D238: the meter before a take is the Microphone
 * card's.) D267: the button stands alone at the top of the tab (no box around it) and a take
 * starts as soon as its devices are open, no 3-2-1 (nor the agent's take, D273).
 */
export function RecordBar({
  mode,
  disabled,
  onRecord,
  label = "Record",
  meter,
}: {
  mode?: TakeMode;
  disabled: boolean;
  onRecord: () => void;
  label?: string;
  meter: boolean;
}) {
  const phase = useRecorder((s) => s.phase);
  const count = useRecorder((s) => s.count);
  const paused = useRecorder((s) => s.paused);
  const runningMode = useRecorder((s) => s.mode);
  const seconds = useTakeSeconds();
  // D238: without a mode the bar is the one recorder's, for any take.
  const mine = mode === undefined || runningMode === mode;
  if (phase === "idle" || !mine) {
    return (
      <button className="record-button" data-testid="capture-take-record" disabled={disabled || phase !== "idle"} onClick={onRecord}>
        <span className="record-dot" />
        <span className="record-label">{label}</span>
      </button>
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
    <div
      className={`record-bar live ${paused ? "paused" : ""}`}
      data-testid="capture-record-bar"
      data-state={phase === "countdown" ? "countdown" : paused ? "paused" : "recording"}
    >
      <div className="record-bar-row">
        {phase === "countdown" ? (
          count ? (
            <span className="capture-countdown" data-testid="capture-countdown">
              {count}
            </span>
          ) : (
            <span className="small muted" data-testid="capture-take-starting">
              Starting…
            </span>
          )
        ) : (
          <span className={`capture-timer ${paused ? "paused" : ""}`} data-testid="capture-take-timer">
            <CircleDot />
            {clock(seconds)}
          </span>
        )}
        <div className="grow" />
        {phase === "recording" && (
          <button
            className="icon-btn record-ctl"
            data-testid={paused ? "capture-take-resume" : "capture-take-pause"}
            title={paused ? "Resume recording" : "Pause recording"}
            onClick={() => (paused ? resumeTake() : pauseTake())}
          >
            {paused ? <Play /> : <Pause />}
          </button>
        )}
        {phase === "recording" && (
          <button className="record-ctl stop" data-testid="capture-take-stop" title="Stop and keep the take" onClick={() => void stopTake()}>
            <Square />
            Stop
          </button>
        )}
        <Tooltip label="Stop and keep nothing">
          <button className="icon-btn record-ctl" data-testid="capture-take-cancel" onClick={() => cancelTake()}>
            <X />
          </button>
        </Tooltip>
      </div>
      {meter && <LevelMeter testId="capture-bar-level" />}
    </div>
  );
}

/** D209: a device picker in the app's style (a native list underneath, so the keyboard and VoiceOver work). */
export function Picker({
  icon: Icon,
  value,
  onChange,
  testId,
  title,
  disabled,
  children,
}: {
  icon: LucideIcon;
  value: string;
  onChange: (v: string) => void;
  testId: string;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
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

/** D209: an option as a plain checkbox and its words (a checkbox, not a chip, D263). */
export function Option({
  testId,
  checked,
  disabled,
  onChange,
  children,
  title,
}: {
  testId: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <label className={`opt-check ${checked ? "on" : ""} ${disabled ? "disabled" : ""}`} title={title}>
      <input type="checkbox" data-testid={testId} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function MicSelect({ value, onChange, testId, disabled }: { value: string; onChange: (id: string) => void; testId: string; disabled?: boolean }) {
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
export function useMonitor(on: boolean, mic: string) {
  useEffect(() => {
    if (!on) return;
    void openMonitor(mic || undefined);
    return () => closeMonitor();
  }, [on, mic]);
}

/** A screen or window tile: its picture, else its app icon, else a placeholder (also when the picture fails). */
export function SourceTile({ source, active, disabled, onPick }: { source: CaptureSource; active: boolean; disabled: boolean; onPick: () => void }) {
  const [broken, setBroken] = useState<ReadonlyArray<string>>([]);
  const picture = [source.thumbnail, source.icon ?? ""].find((u) => u && !broken.includes(u));
  return (
    <button
      className={`capture-source${active ? " active" : ""}`}
      data-testid="capture-source"
      data-id={source.id}
      data-picture={picture ? (picture === source.thumbnail ? "thumbnail" : "icon") : "none"}
      disabled={disabled}
      title={source.name}
      onClick={onPick}
    >
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

/** D210: whether this Mac's sound can be added (macOS 13+, screen recording allowed), and the chip's title. */
export function useSystemSound(): { readonly can: boolean; readonly title: string } {
  const support = useRecorder((s) => s.systemAudio);
  const screen = useRecorder((s) => s.access?.screen);
  if (!support?.supported) return { can: false, title: `This Mac's sound needs macOS 13 or later${support?.macos ? ` (this Mac has ${support.macos})` : ""}` };
  if (screen !== "granted" && screen !== "unknown") return { can: false, title: "Allow screen recording first (under Mac sound)" };
  return { can: true, title: "Record this Mac's sound too, as its own track" };
}
