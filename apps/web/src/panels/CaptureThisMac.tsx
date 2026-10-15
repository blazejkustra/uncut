// The Capture tab's This Mac section (D114, first on the tab since D143): a screen or window (a
// browser window by its page title; the default part, D144), a voiceover from the microphone, a
// camera take. Each says whether macOS allows it (not asked yet, off with how to turn it on,
// or allowed), then its devices, a 3-2-1 countdown, a timer with Stop and Cancel. The recording
// itself is apps/web/src/capture/recorder.ts. D210: "Mac sound" records this Mac's sound (alone,
// or with the microphone; a chip on Screen and Microphone adds it). D211: "Multi" records the
// screen, the camera, the microphone and this Mac's sound together, each into its own file, with a
// live picture of how the camera sits over the screen.
import { useEffect, useState } from "react";

import { loadInputs, refreshAccess, refreshSystemAudio, getRecorder, useRecorder, type TakeMode } from "../capture/recorder.ts";
import { useApp } from "../state/store.ts";
import { MicPart, CameraPart, ScreenPart, SystemPart, MultiPart } from "./thisMac/parts.tsx";
export { LevelMeter } from "./thisMac/controls.tsx";

export function CaptureThisMac() {
  const app = useApp();
  const phase = useRecorder((s) => s.phase);
  const running = useRecorder((s) => s.mode);
  const message = useRecorder((s) => s.message);
  const recordedMs = useRecorder((s) => s.recordedMs);
  const offsets = useRecorder((s) => s.offsets);
  // Back on the tab mid-take: show the part that has its Stop.
  const [mode, setMode] = useState<TakeMode>(() => getRecorder().mode ?? "screen");
  const [mic, setMic] = useState("");
  const mics = useRecorder((s) => s.mics);
  useEffect(() => {
    void refreshAccess().then(loadInputs);
    void refreshSystemAudio();
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
    { id: "system", label: "Mac sound" },
    { id: "multi", label: "Multi" },
  ];
  return (
    <div className="lib-section capture-this-mac" data-testid="capture-this-mac" data-phase={phase} {...(recordedMs !== undefined ? { "data-recorded-ms": recordedMs } : {})} {...(offsets ? { "data-offsets": JSON.stringify(offsets) } : {})}>
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
      {mode === "system" && <SystemPart mic={mic} setMic={setMic} busy={busy} canRecord={canRecord} />}
      {mode === "multi" && <MultiPart mic={mic} setMic={setMic} busy={busy} canRecord={canRecord} />}
      {message && (
        <div className={`capture-message small ${message.kind}`} data-testid={`capture-take-${message.kind}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}
