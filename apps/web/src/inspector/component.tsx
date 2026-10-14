// The element (component) Inspector (D76; rebuilt as a property panel in D130): every param of the
// component's manifest as a typed control (component/param.tsx), in sections by x-group (Content,
// Style, Layout, Motion, then any other), lists of rows in their own section, and a device frame's
// device and footage. Built from the manifest, so a plugin's or a new component needs no UI code.
import { componentInfo } from "@uncut/core/components";
import type { Item } from "@uncut/core/types";

import type { ProjectModel } from "../state/project.ts";
import { Section } from "./controls.tsx";
import { DeviceParam, ScreenFootage } from "./component/device.tsx";
import { ListParam } from "./component/list.tsx";
import { Param } from "./component/param.tsx";
import { GROUPS, groupOf, type Schema } from "./component/schema.ts";

export function ComponentEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const info = componentInfo(item.component);
  if (!info) return null;
  const params = Object.entries(info.params.properties ?? {}) as Array<[string, Schema]>;
  const device = info.id === "component.device-frame";
  const lists = params.filter(([, s]) => s.type === "array" && s.items?.properties);
  const plain = params.filter(([name, s]) => !(s.type === "array" && s.items?.properties) && !(device && name === "device"));
  const groups = [...new Set([...GROUPS.filter((g) => plain.some(([, s]) => groupOf(s) === g)), ...plain.map(([, s]) => groupOf(s))])];
  return (
    <div className="pstack" data-testid="component-editor" data-component={info.id}>
      {device && (
        <Section title="Device" testId="param-sec-device">
          <DeviceParam item={item} disabled={locked} />
        </Section>
      )}
      {groups.map((g) => (
        <Section key={g} title={g} testId={`param-sec-${g.toLowerCase()}`}>
          {plain
            .filter(([, s]) => groupOf(s) === g)
            .map(([name, schema]) => (
              <Param key={name} project={project} item={item} info={info} name={name} schema={schema} disabled={locked} />
            ))}
        </Section>
      ))}
      {lists.map(([name, schema]) => (
        <ListParam key={name} project={project} item={item} info={info} name={name} schema={schema} disabled={locked} />
      ))}
      {device && <ScreenFootage project={project} item={item} disabled={locked} />}
    </div>
  );
}
