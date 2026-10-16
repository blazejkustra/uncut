// D238 (issue #65): Argent's simulators and emulators in a searchable dropdown, so twenty of them
// take one row: the chosen device with its Record (or Boot and record) beside it. The list groups
// what records now, what Argent can boot, and what it can't record yet (with why).
import type { CaptureDevice } from "@uncut/contracts";
import { ChevronDown, Monitor, Search, Smartphone, TabletSmartphone } from "lucide-react";
import { useRef, useState } from "react";

import { Popover } from "../../inspector/controls.tsx";

export const deviceIcon = (d: CaptureDevice) => (d.platform === "ios" ? Smartphone : d.platform === "android" ? TabletSmartphone : Monitor);
export const deviceKind = (d: CaptureDevice) => (d.platform === "ios" ? "iOS simulator" : d.platform === "android" ? "Android" : d.platform);
/** The line under a device's name. */
export const deviceSub = (d: CaptureDevice) => (d.recordable ? deviceKind(d) : d.bootable ? `${deviceKind(d)}, off` : (d.reason ?? "Not recordable yet"));

const GROUPS: ReadonlyArray<[string, (d: CaptureDevice) => boolean]> = [
  ["Ready", (d) => d.recordable],
  ["Off, boots when you record", (d) => !d.recordable && d.bootable === true],
  ["Can't record yet", (d) => !d.recordable && !d.bootable],
];

export function DevicePicker({ devices, value, onChange, disabled, recording }: { devices: ReadonlyArray<CaptureDevice>; value: CaptureDevice | undefined; onChange: (id: string) => void; disabled?: boolean; recording: ReadonlySet<string> }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const match = (d: CaptureDevice) => !q || `${d.name} ${d.id} ${deviceSub(d)}`.toLowerCase().includes(q);
  const Icon = value ? deviceIcon(value) : Smartphone;
  const close = () => (setOpen(false), setQuery(""));
  return (
    <>
      <button ref={anchor} className="device-picker" data-testid="capture-device-picker" data-id={value?.id ?? ""} disabled={disabled} title={value ? `${value.name} (${value.id})` : "Choose a device"} onClick={() => (open ? close() : setOpen(true))}>
        <Icon className="device-picker-icon" />
        <span className="device-picker-text">
          <span className="device-picker-name">{value?.name ?? "Choose a device"}</span>
          {value && <span className="device-picker-sub">{deviceSub(value)}</span>}
        </span>
        <span className="device-picker-count">{devices.length}</span>
        <ChevronDown className="device-picker-caret" />
      </button>
      {open && (
        <Popover anchor={anchor.current} onClose={close} testId="capture-device-menu" width={Math.max(240, anchor.current?.offsetWidth ?? 0)} align="start">
          <label className="capture-search">
            <Search />
            <input
              data-testid="capture-device-search"
              placeholder={`Find among ${devices.length} devices`}
              spellCheck={false}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const first = devices.find(match);
                if (first) (onChange(first.id), close());
              }}
            />
          </label>
          <div className="device-list" data-testid="capture-device-list" role="listbox">
            {GROUPS.map(([title, test]) => {
              const group = devices.filter((d) => test(d) && match(d));
              if (!group.length) return null;
              return (
                <div key={title} className="device-group">
                  <div className="device-group-title">{title}</div>
                  {group.map((d) => {
                    const DIcon = deviceIcon(d);
                    return (
                      <button
                        key={d.id}
                        role="option"
                        aria-selected={d.id === value?.id}
                        className={`device-option${d.id === value?.id ? " active" : ""}${d.recordable || d.bootable ? "" : " later"}`}
                        data-testid="capture-device-option"
                        data-id={d.id}
                        data-recordable={d.recordable}
                        data-bootable={d.bootable === true}
                        title={d.id}
                        onClick={() => (onChange(d.id), close())}
                      >
                        <DIcon />
                        <span className="device-option-text">
                          <span className="device-option-name">{d.name}</span>
                          <span className="device-option-sub">{deviceSub(d)}</span>
                        </span>
                        {recording.has(d.id) && <span className="device-option-rec" title="Recording" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {!devices.some(match) && <div className="small muted device-none">No device matches.</div>}
          </div>
        </Popover>
      )}
    </>
  );
}
