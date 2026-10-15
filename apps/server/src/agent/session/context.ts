// What the agent service's factories share (agent.ts's layer): its services, state and the open project.
import type { AgentState } from "@uncut/contracts";
import type * as Semaphore from "effect/Semaphore";
import type * as SubscriptionRef from "effect/SubscriptionRef";

import type { AnalysisShape } from "../../analysis/analysis.ts";
import type { CaptureShape } from "../../capture/capture.ts";
import type { ServerConfigShape } from "../../app/config.ts";
import type { ExporterShape } from "../../export/exporter.ts";
import type { GeneratorShape } from "../../generate/generate.ts";
import type { KeysShape } from "../../generate/keys.ts";
import type { LibraryShape } from "../../library/library.ts";
import type { MediaLibraryShape } from "../../media/media.ts";
import type { MediaCoreShape } from "../../media/mediaCore.ts";
import type { MediaIndexShape } from "../../media/mediaIndex.ts";
import type { PluginsShape } from "../../plugins/plugins.ts";
import type { ProjectFormatShape } from "../../project/format.ts";
import type { ProjectsShape, ProjectView } from "../../project/projects.ts";
import type { AgentVars } from "./state.ts";
import type { ClaudeSession } from "./types.ts";

export interface AgentServices {
  readonly projects: ProjectsShape;
  readonly format: ProjectFormatShape;
  readonly exporter: ExporterShape;
  readonly media: MediaLibraryShape;
  readonly mediaCore: MediaCoreShape;
  readonly analysis: AnalysisShape;
  readonly config: ServerConfigShape;
  readonly plugins: PluginsShape;
  readonly generator: GeneratorShape;
  readonly keys: KeysShape;
  readonly capture: CaptureShape;
  readonly sounds: LibraryShape;
  readonly mediaIndex: MediaIndexShape;
  readonly bridgeUrl: string;
  readonly stateRef: SubscriptionRef.SubscriptionRef<AgentState | null>;
  readonly loadLock: Semaphore.Semaphore;
  readonly st: AgentVars;
  readonly sessions: Set<ClaudeSession>;
  readonly testRun: boolean;
  readonly approvalMs: () => number;
  readonly screenWaits: Map<string, { readonly turnId: string; readonly done: (answer: { path?: string | undefined; source?: string | undefined; problem?: string | undefined }) => void }>;
  readonly view: () => ProjectView | undefined;
}
