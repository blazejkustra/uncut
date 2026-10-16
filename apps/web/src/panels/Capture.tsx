// The Capture tab (D98, D143): This Mac first (one recorder for any mix of screen, microphone,
// camera and Mac sound: CaptureThisMac, D114, D238), then Argent's simulators and emulators: one
// searchable device picker (D238) with Record beside it, Stop and a running timer; a stopped
// take lands in the Library (Media) as one edit (⌘Z removes it). A shut-down simulator or an AVD
// that isn't running has "Boot and record" (Argent boots it on that click only). Options for the
// next take: a saved flow to replay (the take ends with it), an app to open first, the orientation,
// a maximum length, touches drawn in, still parts cut. Devices Argent can't record say why; without
// Argent the section shows the command that installs it and "Check again".
import type {
  CaptureDevice,
  CaptureOptions,
  CaptureOrientation,
} from "@uncut/contracts";
import {
  Check,
  CircleDot,
  Copy,
  LoaderCircle,
  Power,
  RefreshCw,
  Square,
} from "lucide-react";
import React, { useEffect, useState } from "react";

import { actions, useApp } from "../state/store.ts";
import { DevicePicker, deviceIcon, deviceSub } from "./capture/DevicePicker.tsx";
import { CaptureThisMac } from "./CaptureThisMac.tsx";
import { Option } from "./thisMac/controls.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";

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

/** The Argent options, remembered on this Mac. */
interface ArgentOptions {
  readonly flow: string;
  readonly bundleId: string;
  readonly orientation: "" | CaptureOrientation;
  readonly maxSeconds: number;
  readonly showTouches: boolean;
  readonly trimStatic: boolean;
  /** D238: the device chosen in the picker. */
  readonly device: string;
}
const OPTIONS_KEY = "uncut.capture.argent";
const DEFAULT_OPTIONS: ArgentOptions = {
  flow: "",
  bundleId: "",
  orientation: "",
  maxSeconds: 600,
  showTouches: false,
  trimStatic: false,
  device: "",
};
const MAX_LENGTHS: ReadonlyArray<[number, string]> = [
  [30, "30 s"],
  [60, "1 min"],
  [120, "2 min"],
  [300, "5 min"],
  [600, "10 min"],
];
const ORIENTATIONS: ReadonlyArray<["" | CaptureOrientation, string]> = [
  ["", "As it is"],
  ["Portrait", "Portrait"],
  ["LandscapeLeft", "Landscape left"],
  ["LandscapeRight", "Landscape right"],
  ["PortraitUpsideDown", "Upside down"],
];

function loadOptions(): ArgentOptions {
  try {
    const raw = JSON.parse(
      localStorage.getItem(OPTIONS_KEY) ?? "{}",
    ) as Partial<ArgentOptions>;
    return { ...DEFAULT_OPTIONS, ...raw };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

/** What capture.start / capture.record get from the options. */
const takeOptions = (o: ArgentOptions): CaptureOptions => ({
  showTouches: o.showTouches,
  ...(o.flow ? {} : { trimStatic: o.trimStatic, maxSeconds: o.maxSeconds }),
  ...(o.orientation ? { orientation: o.orientation } : {}),
  ...(o.bundleId.trim() ? { bundleId: o.bundleId.trim() } : {}),
});

export function CaptureLibrary() {
  const app = useApp();
  const online = app.connection === "connected";
  const capture = app.capture;
  useEffect(() => {
    if (online) void actions.checkCapture();
  }, [online]);
  const [options, setOptionsState] = useState<ArgentOptions>(loadOptions);
  const setOptions = (patch: Partial<ArgentOptions>) =>
    setOptionsState((o) => {
      const next = { ...o, ...patch };
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  const flows = capture?.flows ?? [];
  // A remembered flow the open project doesn't have isn't offered.
  const flow = options.flow && flows.includes(options.flow) ? options.flow : "";
  const effective = { ...options, flow };
  const recording = new Map(
    (capture?.recording ?? []).map((r) => [r.device, r]),
  );
  const now = useNow(recording.size > 0);
  const busy = new Set(app.captureBusy ?? []);
  const booting = new Set(app.captureBooting ?? []);
  const rank = (d: CaptureDevice) => (d.recordable ? 0 : d.bootable ? 1 : 2);
  const devices = [...(capture?.devices ?? [])].sort(
    (a, b) => rank(a) - rank(b),
  );
  // D238: the remembered device if it's still there, else the first that records (the list's order).
  const selected =
    devices.find((d) => d.id === options.device) ?? devices[0];
  const ready = !!capture && capture.installed && !capture.problem;
  return (
    <aside className="library" data-testid="capture-library">
      <div className="lib-head">Capture</div>
      <CaptureThisMac />
      <div className="lib-section" data-testid="capture-argent">
        <div className="lib-label capture-label-row">
          <span>
            Simulators and emulators
            {capture?.version ? ` (Argent ${capture.version})` : ""}
          </span>
          <Tooltip label="Look for devices again">
            <button
              className="icon-btn"
              data-testid="capture-refresh"
              disabled={!online || app.captureChecking}
             
              onClick={() => void actions.checkCapture()}
            >
              <RefreshCw className={app.captureChecking ? "spin" : ""} />
            </button>
          </Tooltip>
        </div>
        {!capture ? (
          <div className="muted small">
            {app.captureError ?? "Looking for devices…"}
          </div>
        ) : !ready ? (
          <div className="capture-missing" data-testid="capture-missing">
            <div className="small muted">
              {capture.installed
                ? capture.problem
                : "Argent records iOS simulators and Android emulators. It isn't installed yet; install it with:"}
            </div>
            <div className="wiz-cmd">
              <code>{capture.install}</code>
              <button
                className="link-btn"
                data-testid="capture-copy-install"
                onClick={() => void actions.copy(capture.install)}
                title="Copy the command"
              >
                <Copy />
                Copy
              </button>
            </div>
            <button
              className="btn"
              data-testid="capture-check-again"
              disabled={!online || app.captureChecking}
              onClick={() => void actions.checkCapture()}
            >
              <RefreshCw className={app.captureChecking ? "spin" : ""} />
              Check again
            </button>
          </div>
        ) : devices.length === 0 ? (
          <div className="muted small" data-testid="capture-no-devices">
            No simulators or emulators found.
          </div>
        ) : (
          <>
            <div className="capture-devices" data-testid="capture-devices">
              {[selected, ...devices.filter((d) => d.id !== selected?.id && recording.has(d.id))].map(
                (d) =>
                  d && (
                    <DeviceRow
                      key={d.id}
                      device={d}
                      picker={
                        d.id === selected?.id ? (
                          <DevicePicker
                            devices={devices}
                            value={selected}
                            recording={new Set(recording.keys())}
                            onChange={(id) => setOptions({ device: id })}
                          />
                        ) : undefined
                      }
                      running={recording.get(d.id)}
                      now={now}
                      busy={busy.has(d.id)}
                      booting={booting.has(d.id)}
                      online={online}
                      anyOpen={!!app.snapshot}
                      options={effective}
                    />
                  ),
              )}
            </div>
            <ArgentOptionsForm
              options={effective}
              flows={flows}
              setOptions={setOptions}
            />
          </>
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
              {app.captureSaved.name} ({app.captureSaved.seconds.toFixed(1)} s)
              is in Media.
            </span>
            <button
              className="link-btn"
              onClick={() => actions.openPanel("media")}
            >
              Show
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function ArgentOptionsForm({
  options,
  flows,
  setOptions,
}: {
  options: ArgentOptions;
  flows: ReadonlyArray<string>;
  setOptions: (patch: Partial<ArgentOptions>) => void;
}) {
  const timed = !options.flow;
  return (
    <div className="capture-options" data-testid="capture-options">
      <div className="capture-options-grid">
        <label className="capture-opt">
          <span>Flow</span>
          <select
            data-testid="capture-opt-flow"
            value={options.flow}
            onChange={(e) => setOptions({ flow: e.target.value })}
          >
            <option value="">None, until Stop</option>
            {flows.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="capture-opt">
          <span>Max length</span>
          <select
            data-testid="capture-opt-max"
            value={options.maxSeconds}
            disabled={!timed}
            title={
              timed
                ? "The take stops by itself after this long"
                : "A flow's take lasts as long as the flow"
            }
            onChange={(e) => setOptions({ maxSeconds: Number(e.target.value) })}
          >
            {MAX_LENGTHS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="capture-opt">
          <span>Orientation</span>
          <select
            data-testid="capture-opt-orientation"
            value={options.orientation}
            onChange={(e) =>
              setOptions({
                orientation: e.target.value as ArgentOptions["orientation"],
              })
            }
          >
            {ORIENTATIONS.map(([v, label]) => (
              <option key={v || "keep"} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="capture-opt">
          <span>Open app</span>
          <input
            data-testid="capture-opt-app"
            placeholder="com.example.app"
            spellCheck={false}
            value={options.bundleId}
            maxLength={200}
            onChange={(e) => setOptions({ bundleId: e.target.value })}
          />
        </label>
      </div>
      <div className="opt-row">
        <Option
          testId="capture-opt-touches"
          checked={options.showTouches}
          onChange={(v) => setOptions({ showTouches: v })}
          title="Draw touches into the take"
        >
          Show touches
        </Option>
        <Option
          testId="capture-opt-trim"
          checked={options.trimStatic && timed}
          disabled={!timed}
          onChange={(v) => setOptions({ trimStatic: v })}
          title={timed ? "Cut the parts where nothing moves" : "A flow's take keeps every frame"}
        >
          Cut still parts
        </Option>
      </div>
    </div>
  );
}

function DeviceRow({
  device,
  picker,
  running,
  now,
  busy,
  booting,
  online,
  anyOpen,
  options,
}: {
  device: CaptureDevice;
  /** D238: the chosen device's row is the picker; a device recording besides it is a plain row. */
  picker: React.ReactNode;
  running: { startedAt: string; flow?: string | undefined } | undefined;
  now: number;
  busy: boolean;
  booting: boolean;
  online: boolean;
  anyOpen: boolean;
  options: ArgentOptions;
}) {
  const Icon = deviceIcon(device);
  const recording = running !== undefined;
  const record = () =>
    options.flow
      ? actions.recordFlow(device.id, options.flow, takeOptions(options))
      : actions.startCapture(device.id, takeOptions(options));
  return (
    <div
      className={`capture-row${device.recordable || device.bootable ? "" : " later"}${recording ? " recording" : ""}${picker ? " chosen" : ""}`}
      data-testid="capture-device"
      data-id={device.id}
      data-recordable={device.recordable}
      data-bootable={device.bootable === true}
      title={
        picker
          ? undefined
          : device.recordable
            ? device.id
            : `${device.id}: ${device.reason ?? "not recordable yet"}`
      }
    >
      {picker ?? (
        <>
          <Icon />
          <span className="capture-name">
            {device.name}
            <span className="capture-sub">
              {recording && running.flow ? `Playing ${running.flow}` : deviceSub(device)}
            </span>
          </span>
        </>
      )}
      {picker && recording && running.flow && (
        <span className="capture-note">Playing {running.flow}</span>
      )}
      {recording ? (
        <>
          <span className="capture-timer" data-testid="capture-timer">
            <CircleDot />
            {clock(now - Date.parse(running.startedAt))}
          </span>
          {!running.flow && (
            <button
              className="btn small-btn"
              data-testid="capture-stop"
              disabled={!online || busy}
              title="Stop and add the take to Media"
              onClick={() => void actions.stopCapture(device.id)}
            >
              <Square />
              Stop
            </button>
          )}
        </>
      ) : booting ? (
        <span className="capture-note" data-testid="capture-booting">
          <LoaderCircle className="spin" />
          Booting…
        </span>
      ) : device.recordable ? (
        <button
          className="btn small-btn"
          data-testid="capture-record"
          disabled={!online || busy || !anyOpen}
          title={
            options.flow
              ? `Replay ${options.flow} while recording`
              : "Record this device's screen"
          }
          onClick={() => void record()}
        >
          <CircleDot />
          Record
        </button>
      ) : device.bootable ? (
        <button
          className="btn small-btn"
          data-testid="capture-boot-record"
          disabled={!online || busy || !anyOpen}
          title="Boot it with Argent, then record"
          onClick={() =>
            void actions.bootAndRecord(
              device.id,
              takeOptions(options),
              options.flow || undefined,
            )
          }
        >
          <Power />
          Boot and record
        </button>
      ) : (
        <span className="capture-note" data-testid="capture-not-recordable">
          Can't record
        </span>
      )}
    </div>
  );
}
