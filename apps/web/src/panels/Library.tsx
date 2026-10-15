// The library panel on the left: the media in the project (import, drop, add to the timeline)
// the Text tab's presets and the Elements tab's components and backgrounds. Which one shows is
// the rail's choice.

import { type Project } from "../state/store.ts";
import { CaptureLibrary } from "./Capture.tsx";
import { AudioLibrary, SfxLibrary } from "./Audio.tsx";
import { TransitionsLibrary } from "./Transitions.tsx";
import { EffectsLibrary } from "./Effects.tsx";
import { GenerateLibrary } from "./Generate.tsx";
import { TranscriptPanel } from "./Transcript.tsx";
import { BrandLibrary } from "./Brand.tsx";
import { TextLibrary } from "./library/TextLibrary.tsx";
import { ElementsLibrary } from "./library/ElementsLibrary.tsx";
import { MediaLibrary } from "./library/MediaLibrary.tsx";
export { mediaMeta, Empty } from "./library/MediaTile.tsx";

export type LibraryTab = "media" | "transcript" | "text" | "elements" | "audio" | "sfx" | "transitions" | "effects" | "capture" | "generate" | "brand";

export function Library({ project, dir, tab, onTab }: { project: Project; dir: string; tab: LibraryTab; onTab?: (tab: LibraryTab) => void }) {
  return tab === "brand" ? (
    <BrandLibrary />
  ) : tab === "transcript" ? (
    <TranscriptPanel project={project} dir={dir} />
  ) : tab === "text" ? (
    <TextLibrary project={project} />
  ) : tab === "elements" ? (
    <ElementsLibrary project={project} />
  ) : tab === "audio" ? (
    <AudioLibrary project={project} />
  ) : tab === "sfx" ? (
    <SfxLibrary project={project} />
  ) : tab === "transitions" ? (
    <TransitionsLibrary project={project} />
  ) : tab === "effects" ? (
    <EffectsLibrary project={project} />
  ) : tab === "capture" ? (
    <CaptureLibrary />
  ) : tab === "generate" ? (
    <GenerateLibrary project={project} />
  ) : (
    <MediaLibrary project={project} onEdit={() => onTab?.("generate")} />
  );
}
