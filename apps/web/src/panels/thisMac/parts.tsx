import { Video, RefreshCw, Monitor, Speaker } from "lucide-react";
import React, { useState, useRef, useEffect } from "react";
import { type MultiLayoutName, multiLayoutBoxes, MULTI_LAYOUTS } from "@uncut/core/place";
import { useRecorder, clock, startTake, type PartKind, type Resolution, openPreview, closePreview, loadSources } from "../../capture/recorder.ts";
import type { CaptureSource } from "../../state/bridge.ts";
import { usePlayback } from "../../preview/playback.ts";
import { useApp } from "../../state/store.ts";
import { useSystemSound, useMonitor, Access, MicSelect, LevelMeter, Option, RecordBar, Picker, SourceTile } from "./controls.tsx";

export function MicPart({ mic, setMic, busy, canRecord }: { mic: string; setMic: (id: string) => void; busy: boolean; canRecord: boolean }) {
  const access = useRecorder((s) => s.access?.microphone);
  const fps = usePlayback((s) => s.fps);
  const frame = usePlayback((s) => s.frame);
  const [play, setPlay] = useState(true);
  const [mute, setMute] = useState(true);
  const [withSound, setWithSound] = useState(false);
  const system = useSystemSound();
  const sound = withSound && system.can;
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
          <Option testId="capture-mic-with-system" checked={sound} disabled={busy || !system.can} onChange={setWithSound} title={system.title}>
            Mac sound
          </Option>
        </div>
        <div className="small muted">
          Goes on a Voiceover track at the playhead ({clock(frame / Math.max(1, fps))}){sound ? ", this Mac's sound on its own track" : ""}.
        </div>
        <RecordBar mode="voiceover" meter={false} disabled={!canRecord} onRecord={() => void startTake({ mode: "voiceover", mic: mic || undefined, playTimeline: play, muteTimeline: mute, ...(sound ? { parts: ["voiceover", "system"] as Array<PartKind> } : {}) })} />
      </Access>
    </div>
  );
}

export function CameraPart({ mic, setMic, busy, canRecord }: { mic: string; setMic: (id: string) => void; busy: boolean; canRecord: boolean }) {
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

export function ScreenPart({ mic, setMic, busy, canRecord }: { mic: string; setMic: (id: string) => void; busy: boolean; canRecord: boolean }) {
  const access = useRecorder((s) => s.access);
  const sources = useRecorder((s) => s.sources);
  const loading = useRecorder((s) => s.loadingSources);
  const sourcesError = useRecorder((s) => s.sourcesError);
  const [picked, setPicked] = useState("");
  const [withMic, setWithMic] = useState(false);
  const [withSystem, setWithSystem] = useState(false);
  const [place, setPlace] = useState(false);
  const allowed = access?.screen === "granted" || access?.screen === "unknown";
  const micAllowed = access?.microphone === "granted" || access?.microphone === "unknown";
  const sound = withMic && micAllowed;
  const system = useSystemSound();
  const systemOn = withSystem && system.can;
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
          <Option testId="capture-screen-with-system" checked={systemOn} disabled={busy || !system.can} onChange={setWithSystem} title={system.title}>
            Mac sound
          </Option>
          <Option testId="capture-screen-place" checked={place || systemOn} disabled={busy || systemOn} onChange={setPlace} title={systemOn ? "With this Mac's sound the take goes on the timeline, each source on its own track" : "Also put it on the timeline at the playhead"}>
            On the timeline
          </Option>
        </div>
        <RecordBar
          mode="screen"
          label="Record screen"
          meter={sound}
          disabled={!canRecord || !source}
          onRecord={() => void startTake({ mode: "screen", source, withMic: sound, mic: mic || undefined, place, ...(systemOn ? { parts: ["screen", ...(sound ? (["voiceover"] as const) : []), "system"] as Array<PartKind> } : {}) })}
        />
      </Access>
    </div>
  );
}

/** D210: this Mac's sound: alone, or with the microphone (each its own track). */
export function SystemPart({ mic, setMic, busy, canRecord }: { mic: string; setMic: (id: string) => void; busy: boolean; canRecord: boolean }) {
  const access = useRecorder((s) => s.access);
  const support = useRecorder((s) => s.systemAudio);
  const fps = usePlayback((s) => s.fps);
  const frame = usePlayback((s) => s.frame);
  const [withMic, setWithMic] = useState(false);
  const micAllowed = access?.microphone === "granted" || access?.microphone === "unknown";
  const sound = withMic && micAllowed;
  const allowed = access?.screen === "granted" || access?.screen === "unknown";
  useMonitor(allowed && sound && support?.supported === true, mic);
  if (!support) return <div className="small muted">Checking this Mac…</div>;
  if (!support.supported) {
    return (
      <div className="capture-part" data-testid="capture-system">
        <div className="capture-access" data-testid="capture-system-unsupported">
          <div className="small">
            Recording this Mac's sound needs macOS 13 or later{support.macos ? `; this Mac has macOS ${support.macos}` : ""}. The microphone, camera and screen still work.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="capture-part" data-testid="capture-system">
      <Access kind="screen" sound>
        <div className="small muted">What this Mac plays (apps, videos, calls), without the microphone unless you add it.</div>
        {sound && <MicSelect value={mic} onChange={setMic} testId="capture-system-mic" disabled={busy} />}
        <div className="opt-row">
          <Option testId="capture-system-with-mic" checked={sound} disabled={busy || !micAllowed} onChange={setWithMic} title={micAllowed ? "Record the microphone too, as its own track" : "Allow the microphone under Microphone first"}>
            Microphone
          </Option>
        </div>
        <div className="small muted">
          Goes on a Mac sound track at the playhead ({clock(frame / Math.max(1, fps))}){sound ? ", the microphone on a Voiceover track" : ""}.
        </div>
        <RecordBar mode="system" label="Record sound" meter={sound} disabled={!canRecord} onRecord={() => void startTake({ mode: "system", mic: mic || undefined, ...(sound ? { parts: ["system", "voiceover"] as Array<PartKind> } : {}) })} />
      </Access>
    </div>
  );
}

const LAYOUT_NAMES: Record<MultiLayoutName, string> = { tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right", side: "Side by side" };
const pctOf = (n: number, of: number) => `${(n / of) * 100}%`;

/** D211: how the take will look: the screen (live while recording, else its picture) with the camera in the layout's box. */
function Composite({ source, camera, screen, layout, canvas }: { source: CaptureSource | undefined; camera: boolean; screen: boolean; layout: MultiLayoutName; canvas: { width: number; height: number } }) {
  const preview = useRecorder((s) => s.preview);
  const live = useRecorder((s) => s.screenLive);
  const cam = useRef<HTMLVideoElement>(null);
  const scr = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (cam.current && cam.current.srcObject !== (preview ?? null)) cam.current.srcObject = preview ?? null;
  }, [preview, camera]);
  useEffect(() => {
    if (scr.current && scr.current.srcObject !== (live ?? null)) scr.current.srcObject = live ?? null;
  }, [live, screen]);
  const boxes = multiLayoutBoxes(layout, canvas.width, canvas.height);
  const at = (b: { x: number; y: number; w: number; h: number; radius?: number }) => ({ left: pctOf(b.x, canvas.width), top: pctOf(b.y, canvas.height), width: pctOf(b.w, canvas.width), height: pctOf(b.h, canvas.height), borderRadius: b.radius ? "50%" : undefined });
  const screenBox = screen && camera && boxes.screen ? at(boxes.screen) : { left: 0, top: 0, width: "100%", height: "100%" };
  return (
    <div className="capture-composite" data-testid="capture-composite" data-layout={layout} data-live={live ? "yes" : "no"} style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}>
      {screen && (
        <div className="composite-screen" data-testid="capture-composite-screen" style={screenBox}>
          {live ? <video ref={scr} autoPlay muted playsInline /> : source?.thumbnail ? <img src={source.thumbnail} alt="" /> : <Monitor className="composite-placeholder" />}
        </div>
      )}
      {camera && (
        <div className={`composite-camera ${screen ? "" : "full"}`} data-testid="capture-composite-camera" style={screen ? at(boxes.camera) : { left: 0, top: 0, width: "100%", height: "100%" }}>
          <video ref={cam} autoPlay muted playsInline />
        </div>
      )}
      {!screen && !camera && (
        <div className="composite-empty small muted">
          <Speaker />
          Sound only
        </div>
      )}
    </div>
  );
}

/** D211: screen, camera, microphone and this Mac's sound at once, each into its own file. */
export function MultiPart({ mic, setMic, busy, canRecord }: { mic: string; setMic: (id: string) => void; busy: boolean; canRecord: boolean }) {
  const app = useApp();
  const access = useRecorder((s) => s.access);
  const sources = useRecorder((s) => s.sources);
  const cameras = useRecorder((s) => s.cameras);
  const previewError = useRecorder((s) => s.previewError);
  const [on, setOn] = useState<Record<PartKind, boolean>>({ screen: true, camera: true, voiceover: true, system: false });
  const [picked, setPicked] = useState("");
  const [camera, setCamera] = useState("");
  const [layout, setLayout] = useState<MultiLayoutName>("br");
  const ok = (a: string | undefined) => a === "granted" || a === "unknown";
  const system = useSystemSound();
  const can: Record<PartKind, boolean> = { screen: ok(access?.screen), camera: ok(access?.camera), voiceover: ok(access?.microphone), system: system.can };
  const parts = (["screen", "camera", "voiceover", "system"] as const).filter((k) => on[k] && can[k]);
  const canvas = (app.snapshot?.project as { canvas?: { width: number; height: number } } | undefined)?.canvas ?? { width: 1920, height: 1080 };
  useMonitor(parts.includes("voiceover"), mic);
  useEffect(() => {
    if (can.screen && on.screen && !sources) void loadSources();
  }, [can.screen, on.screen, sources]);
  const cameraOn = parts.includes("camera");
  useEffect(() => {
    if (!cameraOn) return;
    void openPreview(camera || undefined, "1080p");
    return () => closePreview();
  }, [cameraOn, camera]);
  useEffect(() => {
    if (!camera && cameras[0]) setCamera(cameras[0].id);
  }, [cameras, camera]);
  const source = sources?.find((s) => s.id === picked);
  const missing = parts.includes("screen") && !source;
  const titles: Record<PartKind, string> = {
    screen: can.screen ? "Record a screen or window" : "Allow screen recording under Screen first",
    camera: can.camera ? "Record the camera, over the screen" : "Allow the camera under Camera first",
    voiceover: can.voiceover ? "Record the microphone" : "Allow the microphone under Microphone first",
    system: system.title,
  };
  const labels: Record<PartKind, string> = { screen: "Screen", camera: "Camera", voiceover: "Microphone", system: "Mac sound" };
  return (
    <div className="capture-part" data-testid="capture-multi">
      <div className="opt-row" data-testid="capture-multi-sources">
        {(["screen", "camera", "voiceover", "system"] as const).map((k) => (
          <Option key={k} testId={`capture-multi-${k}`} checked={on[k] && can[k]} disabled={busy || !can[k]} onChange={(v) => setOn((o) => ({ ...o, [k]: v }))} title={titles[k]}>
            {labels[k]}
          </Option>
        ))}
      </div>
      <Composite source={source} camera={cameraOn} screen={parts.includes("screen")} layout={layout} canvas={canvas} />
      {previewError && cameraOn && <div className="inline-error small">{previewError}</div>}
      {parts.includes("screen") && parts.includes("camera") && (
        <div className="seg capture-layouts" data-testid="capture-multi-layout">
          {MULTI_LAYOUTS.map((l) => (
            <button key={l} className={layout === l ? "active" : ""} data-value={l} title={LAYOUT_NAMES[l]} disabled={busy} onClick={() => setLayout(l)}>
              <span className={`layout-glyph ${l}`} />
            </button>
          ))}
        </div>
      )}
      {parts.includes("screen") && (
        <>
          <div className="capture-sources-head small muted">Pick a screen or window</div>
          <div className="capture-sources" data-testid="capture-sources" data-kind="multi">
            {(sources ?? []).map((s) => (
              <SourceTile key={s.id} source={s} active={picked === s.id} disabled={busy} onPick={() => setPicked(s.id)} />
            ))}
          </div>
        </>
      )}
      {cameraOn && (
        <Picker icon={Video} value={camera} onChange={setCamera} testId="capture-multi-camera" title="Camera" disabled={busy}>
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Picker>
      )}
      {parts.includes("voiceover") && <MicSelect value={mic} onChange={setMic} testId="capture-multi-mic" disabled={busy} />}
      <div className="small muted">Each source is its own file and its own track, starting together at the playhead; the camera stays movable.</div>
      <RecordBar
        mode="multi"
        label="Record all"
        meter={parts.includes("voiceover")}
        disabled={!canRecord || !parts.length || missing}
        onRecord={() => void startTake({ mode: "multi", parts, source, camera: camera || undefined, resolution: "1080p", mic: mic || undefined, layout })}
      />
    </div>
  );
}
