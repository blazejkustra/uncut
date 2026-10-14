// The Inspector's text editor (phase 4 chunk 4, D16/D53/D80; rebuilt as a property panel in D129):
// the content, then the Style and Animation tabs. The pieces live in inspector/text/.
import type { Item } from "@uncut/core/types";
import { useState } from "react";

import { type ProjectModel } from "../state/project.ts";
import { Tabs } from "./fields.tsx";
import { TextContent } from "./text/content.tsx";
import { TextStyleTab } from "./text/style.tsx";
import { TextAnimationTab } from "./text/animation.tsx";

export { TextStyleTab };

/** The selected text item: content, then Style / Animation. */
export function TextEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const [tab, setTab] = useState<"style" | "animation">("style");
  return (
    <div data-testid="text-editor">
      <TextContent key={item.id} project={project} item={item} disabled={locked} />
      <div className="group tabs-group">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ["style", "Style"],
            ["animation", "Animation"],
          ]}
        />
      </div>
      {tab === "style" && <TextStyleTab project={project} item={item} disabled={locked} />}
      {tab === "animation" && <TextAnimationTab project={project} item={item} disabled={locked} />}
    </div>
  );
}
