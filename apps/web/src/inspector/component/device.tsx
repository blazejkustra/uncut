// A device frame's own controls (D76): its device (which reshapes the frame and moves its footage)
// and the footage on its screen. Split out of panels/ComponentEditor.tsx.
import { DEVICES, type Device } from "@uncut/core/components";
import type { Item } from "@uncut/core/types";
import { Smartphone } from "lucide-react";

import type { ProjectModel } from "../../state/project.ts";
import { planAlignScreen, planDevice, planScreenFootage, screenClipOf } from "../../preview/components.ts";
import { send } from "../fields.tsx";
import { Prop, Section, Segmented } from "../controls.tsx";

export function DeviceParam({ item, disabled }: { item: Item; disabled: boolean }) {
  const value = (item.props?.device as Device | undefined) ?? "phone";
  return (
    <Prop label="Device">
      <Segmented testId="param-device" options={DEVICES.map((d) => [d, d === "phone" ? "Phone" : d === "android" ? "Android" : "Browser"] as const)} value={value} disabled={disabled} onChange={(d) => send((p) => planDevice(p, item.id, d))} />
    </Prop>
  );
}

/** A device frame's footage (D76): a clip under it on its screen. Pick one, change it, take it out, or fit it back to the screen. */
export function ScreenFootage({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const clip = screenClipOf(project, item.id);
  const footage = project.media.filter((m) => m.kind === "video" || m.kind === "image");
  return (
    <Section title="Screen" testId="param-sec-screen">
      <select
        className="field input"
        data-testid="device-footage"
        value={clip?.item.media ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const id = e.target.value || null;
          send((p) => planScreenFootage(p, item.id, id));
        }}
      >
        <option value="">Empty (shows what's under it)</option>
        {footage.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {clip && (
        <button className="btn" data-testid="device-align" disabled={disabled} onClick={() => send((p) => planAlignScreen(p, item.id))}>
          <Smartphone />
          Fit footage to the screen
        </button>
      )}
    </Section>
  );
}

