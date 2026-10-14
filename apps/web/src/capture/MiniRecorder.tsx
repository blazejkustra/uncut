// D209 (issue #17): the floating mini recorder, its own small always-on-top window while the screen
// is recorded (loaded as index.html?mini). It shows what the app window sends and sends its
// buttons back; it has no server connection of its own.
import { CircleDot, Pause, Play, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

import { bridge, type MiniRecorderAction, type MiniRecorderState } from "../state/bridge.ts";

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const isMiniWindow = () => new URLSearchParams(location.search).has("mini");

export function MiniRecorder() {
  const [state, setState] = useState<MiniRecorderState | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => bridge.onMiniRecorderState?.(setState), []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const send = (action: MiniRecorderAction) => bridge.miniRecorderAction?.(action);
  if (!state) return <div className="mini-recorder" data-testid="mini-recorder" data-phase="none" />;
  const seconds = state.phase === "recording" ? state.seconds + (now - state.at) / 1000 : state.seconds;
  return (
    <div className={`mini-recorder ${state.phase}`} data-testid="mini-recorder" data-phase={state.phase}>
      <div className="mini-drag" />
      <span className="mini-dot">
        <CircleDot />
      </span>
      <span className="mini-time" data-testid="mini-timer">
        {state.phase === "countdown" ? (state.count ?? "") : state.phase === "saving" ? "Saving" : clock(seconds)}
      </span>
      <span className="mini-name" title={state.name}>
        {state.name}
      </span>
      {(state.phase === "recording" || state.phase === "paused") && (
        <button className="mini-btn" data-testid={state.phase === "paused" ? "mini-resume" : "mini-pause"} title={state.phase === "paused" ? "Resume recording" : "Pause recording"} onClick={() => send(state.phase === "paused" ? "resume" : "pause")}>
          {state.phase === "paused" ? <Play /> : <Pause />}
        </button>
      )}
      {(state.phase === "recording" || state.phase === "paused") && (
        <button className="mini-btn stop" data-testid="mini-stop" title="Stop and keep the take" onClick={() => send("stop")}>
          <Square />
        </button>
      )}
      {state.phase !== "saving" && (
        <button className="mini-btn" data-testid="mini-cancel" title="Stop and keep nothing" onClick={() => send("cancel")}>
          <X />
        </button>
      )}
    </div>
  );
}
