// The Capture tab's This Mac section (D114, first on the tab since D143), one recorder since D238
// (issue #65): toggle any mix of Screen, Microphone, Camera and Mac sound; one Record (at the top since
// D267, starting straight away). Each
// source on says whether macOS allows it (not asked yet, off with how to turn it on, or allowed)
// and shows its device; the screen or window is picked in a modal (SourcePicker). A live picture
// shows the screen with the camera's bubble over it (D211's layouts), or the camera alone.
//
// One source records as before (D114/D210): a voiceover on a Voiceover track at the playhead, this
// Mac's sound on a Mac sound track, a screen or camera take into Media (and on the timeline when
// asked). More than one source is D211's take: each source its own file and track, started
// together and start-aligned at the playhead, in one edit. The recording itself is
// apps/web/src/capture/recorder.ts.
import { Mic, Monitor, Speaker, Video } from "lucide-react";
import React, { useEffect, useState } from "react";
import { type MultiLayoutName, MULTI_LAYOUTS } from "@uncut/core/place";

import {
  loadInputs,
  refreshAccess,
  refreshSystemAudio,
  loadSources,
  openPreview,
  closePreview,
  startTake,
  clock,
  useRecorder,
  type PartKind,
  type Resolution,
  type TakeOptions,
} from "../capture/recorder.ts";
import { usePlayback } from "../preview/playback.ts";
import { useApp } from "../state/store.ts";
import { Composite } from "./capture/Composite.tsx";
import { SourcePicker } from "./capture/SourcePicker.tsx";
import { useSystemSound, useMonitor, Access, MicSelect, LevelMeter, Option, RecordBar, Picker } from "./thisMac/controls.tsx";
import "./capture/capture.css";
export { LevelMeter } from "./thisMac/controls.tsx";

/** The order sources show and record in. */
const SOURCES: ReadonlyArray<{ kind: PartKind; label: string; icon: typeof Monitor }> = [
  { kind: "screen", label: "Screen", icon: Monitor },
  { kind: "voiceover", label: "Microphone", icon: Mic },
  { kind: "camera", label: "Camera", icon: Video },
  { kind: "system", label: "Mac sound", icon: Speaker },
];
const PART_ORDER: ReadonlyArray<PartKind> = ["screen", "camera", "voiceover", "system"];
const LAYOUT_NAMES: Record<MultiLayoutName, string> = { tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right", side: "Side by side" };

/** What the recorder remembers on this Mac (and across leaving the tab). */
interface Settings {
  readonly on: Readonly<Record<PartKind, boolean>>;
  readonly source: string;
  readonly camera: string;
  readonly mic: string;
  readonly resolution: Resolution;
  readonly layout: MultiLayoutName;
  readonly play: boolean;
  readonly mute: boolean;
  readonly place: boolean;
}
const KEY = "uncut.capture.recorder";
const DEFAULTS: Settings = {
  on: { screen: true, voiceover: false, camera: false, system: false },
  source: "",
  camera: "",
  mic: "",
  resolution: "1080p",
  layout: "br",
  play: true,
  mute: true,
  place: false,
};
let remembered: Settings | undefined;
function loadSettings(): Settings {
  if (remembered) return remembered;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    remembered = { ...DEFAULTS, ...raw, on: { ...DEFAULTS.on, ...raw.on } };
  } catch {
    remembered = DEFAULTS;
  }
  return remembered;
}

const ok = (a: string | undefined) => a === "granted" || a === "unknown";

export function CaptureThisMac() {
  const app = useApp();
  const phase = useRecorder((s) => s.phase);
  const message = useRecorder((s) => s.message);
  const recordedMs = useRecorder((s) => s.recordedMs);
  const offsets = useRecorder((s) => s.offsets);
  const access = useRecorder((s) => s.access);
  const sources = useRecorder((s) => s.sources);
  const cameras = useRecorder((s) => s.cameras);
  const mics = useRecorder((s) => s.mics);
  const support = useRecorder((s) => s.systemAudio);
  const fps = usePlayback((s) => s.fps);
  const frame = usePlayback((s) => s.frame);
  const system = useSystemSound();
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [picking, setPicking] = useState(false);
  const set = (patch: Partial<Settings>) =>
    setSettingsState((s) => {
      const next = { ...s, ...patch };
      remembered = next;
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  useEffect(() => {
    void refreshAccess().then(loadInputs);
    void refreshSystemAudio();
  }, []);
  const busy = phase !== "idle";
  // Mid-take (back on the tab, or the agent's take) the toggles show what's recording.
  const runningParts = useRecorder((s) => s.parts);
  const runningMode = useRecorder((s) => s.mode);
  const running: Record<PartKind, boolean> | undefined =
    busy && runningMode
      ? (() => {
          const kinds: ReadonlyArray<PartKind> = runningParts ?? [runningMode === "multi" ? "screen" : runningMode];
          return {
            screen: kinds.includes("screen"),
            voiceover: kinds.includes("voiceover"),
            camera: kinds.includes("camera"),
            system: kinds.includes("system"),
          };
        })()
      : undefined;
  const on = running ?? settings.on;
  const can: Record<PartKind, boolean> = { screen: ok(access?.screen), voiceover: ok(access?.microphone), camera: ok(access?.camera), system: system.can };
  const parts = PART_ORDER.filter((k) => on[k]);
  const mic = settings.mic && mics.some((m) => m.id === settings.mic) ? settings.mic : (mics[0]?.id ?? "");
  const camera = settings.camera && cameras.some((c) => c.id === settings.camera) ? settings.camera : (cameras[0]?.id ?? "");
  // The remembered screen or window if it's still there, else the first screen.
  const source = sources?.find((s) => s.id === settings.source) ?? sources?.find((s) => s.kind === "screen");
  const screenOn = on.screen && can.screen;
  const cameraOn = on.camera && can.camera;
  const micOn = on.voiceover && can.voiceover;
  useMonitor(micOn, mic);
  useEffect(() => {
    if (screenOn && !sources) void loadSources();
  }, [screenOn, sources]);
  useEffect(() => {
    if (!cameraOn) return;
    void openPreview(camera || undefined, settings.resolution);
    return () => closePreview();
  }, [cameraOn, camera, settings.resolution]);

  const ready: Record<PartKind, boolean> = { screen: can.screen && !!source, voiceover: can.voiceover, camera: can.camera, system: can.system };
  const allReady = parts.length > 0 && parts.every((k) => ready[k]);
  const canRecord = app.connection === "connected" && !!app.snapshot && !busy && allReady;
  const video = on.screen || on.camera;
  const single = parts.length === 1 ? parts[0] : undefined;
  const at = clock(frame / Math.max(1, fps));
  const canvas = (app.snapshot?.project as { canvas?: { width: number; height: number } } | undefined)?.canvas ?? { width: 1920, height: 1080 };

  const record = () => {
    const common = { mic: mic || undefined, camera: camera || undefined, resolution: settings.resolution, source };
    let options: TakeOptions;
    if (single === "screen") options = { mode: "screen", source, place: settings.place };
    else if (single === "camera") options = { mode: "camera", camera: common.camera, resolution: settings.resolution, withMic: false, place: settings.place };
    else if (single === "voiceover") options = { mode: "voiceover", mic: common.mic, playTimeline: settings.play, muteTimeline: settings.mute };
    else if (single === "system") options = { mode: "system", playTimeline: settings.play, muteTimeline: settings.mute };
    else if (!video)
      options = { mode: on.voiceover ? "voiceover" : "system", parts, mic: common.mic, playTimeline: settings.play, muteTimeline: settings.mute };
    else options = { mode: "multi", parts, ...common, layout: settings.layout };
    void startTake(options);
  };
  const label =
    single === "screen"
      ? "Record screen"
      : single === "voiceover"
        ? "Record voiceover"
        : single === "camera"
          ? "Record camera"
          : single === "system"
            ? "Record sound"
            : parts.length
              ? `Record ${parts.length} sources`
              : "Record";
  const where = !parts.length
    ? "Turn on what to record."
    : single === "voiceover"
      ? `Goes on a Voiceover track at the playhead (${at}).`
      : single === "system"
        ? `Goes on a Mac sound track at the playhead (${at}).`
        : single
          ? settings.place
            ? `Goes into Media and on the timeline at the playhead (${at}).`
            : "Goes into Media."
          : `Each source is its own file and track, starting together at the playhead (${at})${on.screen && on.camera ? "; the camera stays movable" : ""}.`;

  return (
    <div
      className="lib-section capture-this-mac"
      data-testid="capture-this-mac"
      data-phase={phase}
      data-parts={parts.join(",")}
      {...(recordedMs !== undefined ? { "data-recorded-ms": recordedMs } : {})}
      {...(offsets ? { "data-offsets": JSON.stringify(offsets) } : {})}
    >
      <div className="lib-label">This Mac</div>
      {/* D267: Record first, then what it records. */}
      <RecordBar label={label} meter={micOn} disabled={!canRecord} onRecord={record} />
      <div className="small muted" data-testid="capture-where">
        {where}
      </div>
      {message && (
        <div className={`capture-message small ${message.kind}`} data-testid={`capture-take-${message.kind}`}>
          {message.text}
        </div>
      )}
      <div className="capture-toggles" role="group" aria-label="What to record" data-testid="capture-toggles">
        {SOURCES.map(({ kind, label: name, icon: Icon }) => (
          <button
            key={kind}
            className={`capture-toggle${on[kind] ? " on" : ""}`}
            data-testid={`capture-src-${kind}`}
            data-on={on[kind] ? "yes" : "no"}
            aria-pressed={on[kind]}
            disabled={busy}
            title={on[kind] ? `Don't record ${name.toLowerCase()}` : `Record ${name.toLowerCase()} too`}
            onClick={() => set({ on: { ...settings.on, [kind]: !settings.on[kind] } })}
          >
            <Icon />
            <span>{name}</span>
            <span className="capture-toggle-dot" />
          </button>
        ))}
      </div>
      {!app.snapshot && <div className="small muted">Open a project to record: takes go into its media folder.</div>}
      {(screenOn || cameraOn) && <Composite source={source} camera={cameraOn} screen={screenOn} layout={settings.layout} canvas={canvas} />}
      {on.screen && (
        <SourceCard kind="screen">
          <Access kind="screen">
            <button
              className="capture-chosen"
              data-testid="capture-pick-source"
              data-id={source?.id ?? ""}
              disabled={busy}
              title="Choose a screen or window"
              onClick={() => setPicking(true)}
            >
              <Monitor />
              <span className="capture-chosen-name">{source ? source.name : "Choose a screen or window"}</span>
              <span className="capture-chosen-change">{source ? "Change" : "Choose"}</span>
            </button>
          </Access>
        </SourceCard>
      )}
      {on.camera && (
        <SourceCard kind="camera">
          <Access kind="camera">
            <div className="picker-row">
              <Picker icon={Video} value={camera} onChange={(v) => set({ camera: v })} testId="capture-camera-device" title="Camera" disabled={busy}>
                {cameras.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Picker>
              <div className="seg capture-resolution" data-testid="capture-camera-resolution">
                {(["720p", "1080p"] as const).map((r) => (
                  <button key={r} className={settings.resolution === r ? "active" : ""} data-value={r} disabled={busy} onClick={() => set({ resolution: r })}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            {screenOn && (
              <div className="seg capture-layouts" data-testid="capture-layout" title="Where the camera sits over the screen">
                {MULTI_LAYOUTS.map((l) => (
                  <button
                    key={l}
                    className={settings.layout === l ? "active" : ""}
                    data-value={l}
                    title={LAYOUT_NAMES[l]}
                    disabled={busy}
                    onClick={() => set({ layout: l })}
                  >
                    <span className={`layout-glyph ${l}`} />
                  </button>
                ))}
              </div>
            )}
          </Access>
        </SourceCard>
      )}
      {on.voiceover && (
        <SourceCard kind="voiceover">
          <Access kind="microphone">
            <MicSelect value={mic} onChange={(v) => set({ mic: v })} testId="capture-mic-device" disabled={busy} />
            <LevelMeter />
          </Access>
        </SourceCard>
      )}
      {on.system && (
        <SourceCard kind="system">
          {!support ? (
            <div className="small muted">Checking this Mac…</div>
          ) : !support.supported ? (
            <div className="small" data-testid="capture-system-unsupported">
              Recording this Mac's sound needs macOS 13 or later{support.macos ? `; this Mac has macOS ${support.macos}` : ""}. The microphone, camera and
              screen still work.
            </div>
          ) : (
            <Access kind="screen" sound>
              <div className="small muted">What this Mac plays (apps, videos, calls), as its own track.</div>
            </Access>
          )}
        </SourceCard>
      )}
      {parts.length > 0 && (!video || single) && (
        <div className="opt-row" data-testid="capture-options-this-mac">
          {!video && (
            <>
              <Option
                testId="capture-play-timeline"
                checked={settings.play}
                disabled={busy}
                onChange={(v) => set({ play: v })}
                title="Play the timeline from the playhead while recording"
              >
                Play timeline
              </Option>
              <Option
                testId="capture-mute-timeline"
                checked={settings.mute}
                disabled={busy || !settings.play}
                onChange={(v) => set({ mute: v })}
                title="Mute it, so the microphone only hears you"
              >
                Muted
              </Option>
            </>
          )}
          {single && video && (
            <Option
              testId="capture-place"
              checked={settings.place}
              disabled={busy}
              onChange={(v) => set({ place: v })}
              title="Also put it on the timeline at the playhead"
            >
              On the timeline
            </Option>
          )}
        </div>
      )}
      {picking && <SourcePicker picked={source?.id ?? ""} onPick={(id) => set({ source: id })} onClose={() => setPicking(false)} />}
    </div>
  );
}

/** One source's settings under the toggles. */
function SourceCard({ kind, children }: { kind: PartKind; children: React.ReactNode }) {
  const { label, icon: Icon } = SOURCES.find((s) => s.kind === kind)!;
  return (
    <div className="capture-card" data-testid={`capture-card-${kind}`}>
      <div className="capture-card-head">
        <Icon />
        {label}
      </div>
      <div className="capture-card-body">{children}</div>
    </div>
  );
}
