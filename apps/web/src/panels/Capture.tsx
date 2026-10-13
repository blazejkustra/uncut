// The Capture tab (D98): Argent's devices with Record and Stop and a running timer; a stopped take
// lands in the Library as one edit (⌘Z removes it). Devices Argent can't record yet say why;
// without Argent the tab shows the command that installs it and "Check again". Screen and
// Microphone come later.
import type { CaptureDevice } from "@uncut/contracts";
import { Check, CircleDot, Copy, Mic, Monitor, RefreshCw, Smartphone, Square, TabletSmartphone } from "lucide-react";
import React, { useEffect, useState } from "react";

import { actions, useApp } from "../state/store.ts";

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A second-by-second clock while anything records. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function CaptureLibrary() {
  const app = useApp();
  const online = app.connection === "connected";
  const capture = app.capture;
  useEffect(() => {
    if (online) void actions.checkCapture();
  }, [online]);
  const recording = new Map((capture?.recording ?? []).map((r) => [r.device, Date.parse(r.startedAt)]));
  const now = useNow(recording.size > 0);
  const busy = new Set(app.captureBusy ?? []);
  const devices = [...(capture?.devices ?? [])].sort((a, b) => Number(b.recordable) - Number(a.recordable));
  return (
    <aside className="library" data-testid="capture-library">
      <div className="lib-head">
        Capture
        <button className="icon-btn" data-testid="capture-refresh" disabled={!online || app.captureChecking} title="Look for devices again" onClick={() => void actions.checkCapture()}>
          <RefreshCw className={app.captureChecking ? "spin" : ""} />
        </button>
      </div>
      <div className="lib-section" data-testid="capture-argent">
        <div className="lib-label">Apps with Argent{capture?.version ? ` ${capture.version}` : ""}</div>
        {!capture ? (
          <div className="muted small">{app.captureError ?? "Looking for devices…"}</div>
        ) : !capture.installed || capture.problem ? (
          <div className="capture-missing" data-testid="capture-missing">
            <div className="small muted">{capture.installed ? capture.problem : "Argent records iOS simulators and Android emulators. It isn't installed yet; install it with:"}</div>
            <div className="wiz-cmd">
              <code>{capture.install}</code>
              <button className="link-btn" data-testid="capture-copy-install" onClick={() => void actions.copy(capture.install)} title="Copy the command">
                <Copy />
                Copy
              </button>
            </div>
            <button className="btn" data-testid="capture-check-again" disabled={!online || app.captureChecking} onClick={() => void actions.checkCapture()}>
              <RefreshCw className={app.captureChecking ? "spin" : ""} />
              Check again
            </button>
          </div>
        ) : devices.length === 0 ? (
          <div className="muted small" data-testid="capture-no-devices">
            No simulators or emulators are running. Boot one, then refresh.
          </div>
        ) : (
          <div className="capture-devices" data-testid="capture-devices">
            {devices.map((d) => (
              <DeviceRow key={d.id} device={d} startedAt={recording.get(d.id)} now={now} busy={busy.has(d.id)} online={online} anyOpen={!!app.snapshot} />
            ))}
          </div>
        )}
        {app.captureError && capture && (
          <div className="inline-error small" data-testid="capture-error">
            {app.captureError}
          </div>
        )}
        {app.captureSaved && (
          <div className="capture-saved small" data-testid="capture-saved">
            <Check />
            <span>
              {app.captureSaved.name} ({app.captureSaved.seconds.toFixed(1)} s) is in Media.
            </span>
            <button className="link-btn" onClick={() => actions.openPanel("media")}>
              Show
            </button>
          </div>
        )}
      </div>
      <div className="lib-section">
        <div className="lib-label">This Mac</div>
        <div className="capture-row later" data-testid="capture-screen">
          <Monitor />
          <span className="capture-name">Screen</span>
          <span className="capture-note">Coming later</span>
        </div>
        <div className="capture-row later" data-testid="capture-mic">
          <Mic />
          <span className="capture-name">Microphone</span>
          <span className="capture-note">Coming later</span>
        </div>
      </div>
    </aside>
  );
}

function DeviceRow({ device, startedAt, now, busy, online, anyOpen }: { device: CaptureDevice; startedAt: number | undefined; now: number; busy: boolean; online: boolean; anyOpen: boolean }) {
  const Icon = device.platform === "ios" ? Smartphone : device.platform === "android" ? TabletSmartphone : Monitor;
  const recording = startedAt !== undefined;
  return (
    <div className={`capture-row${device.recordable ? "" : " later"}${recording ? " recording" : ""}`} data-testid="capture-device" data-id={device.id} data-recordable={device.recordable} title={device.recordable ? device.id : `${device.id}: ${device.reason ?? "not recordable yet"}`}>
      <Icon />
      <span className="capture-name">
        {device.name}
        <span className="capture-sub">{device.recordable ? (device.platform === "ios" ? "iOS simulator" : device.platform === "android" ? "Android" : device.platform) : device.reason ?? ""}</span>
      </span>
      {!device.recordable ? (
        <span className="capture-note" data-testid="capture-not-recordable">
          Not recordable yet
        </span>
      ) : recording ? (
        <>
          <span className="capture-timer" data-testid="capture-timer">
            <CircleDot />
            {clock(now - startedAt)}
          </span>
          <button className="btn small-btn" data-testid="capture-stop" disabled={!online || busy} title="Stop and add the take to Media" onClick={() => void actions.stopCapture(device.id)}>
            <Square />
            Stop
          </button>
        </>
      ) : (
        <button className="btn small-btn" data-testid="capture-record" disabled={!online || busy || !anyOpen} title="Record this device's screen" onClick={() => void actions.startCapture(device.id)}>
          <CircleDot />
          Record
        </button>
      )}
    </div>
  );
}
