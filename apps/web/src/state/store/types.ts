import type { ServerHello, ProjectSnapshot, RecentProject, SetupCheck, PluginInfo, PluginContributions, CatalogEntry, CaptureState, GeneratorInfo, GenerateJob, KeyInfo, ImportJob, MediaImportResult, AgentState, HistoryState, AgentMention, AgentImage, AgentUiPanel, ExportJob, AnalysisJob, ProxyState, TranscriptionState, BrandState, GenerateKind } from "@uncut/contracts";
import type { AppInfo, EnvironmentInfo } from "../bridge.ts";
import type { Check } from "@uncut/core/checks";
import type { ProjectModel } from "../project.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "server-exited" | "failed";
export type Project = ProjectModel;

/** A message in the editor's banner. `transport` ones go away when the connection comes back. */
export interface Notice {
  readonly text: string;
  readonly transport?: boolean;
}

export interface AppStateShape {
  readonly ready: boolean;
  readonly connection: ConnectionState;
  readonly connectionMessage?: string;
  readonly hello?: ServerHello;
  readonly appInfo: AppInfo;
  readonly snapshot: ProjectSnapshot | null;
  readonly recents: ReadonlyArray<RecentProject>;
  readonly newProjectOpen: boolean;
  // A readable error for the welcome screen (a failed open there).
  readonly welcomeError?: string;
  // project.json changed on disk: changes are refused until a reload succeeds.
  readonly changedOnDisk: boolean;
  // Why the last reload failed (folder gone, file unreadable), shown in the same banner.
  readonly reloadProblem?: string;
  readonly notice?: Notice;
  // Onboarding: open on first launch, or from Settings… / the welcome card.
  readonly setupOpen: boolean;
  // Settings (G8): the project's and the app's settings, and the keyboard shortcuts sheet (G3).
  readonly settingsOpen: boolean;
  readonly settingsSection: SettingsSection;
  readonly shortcutsOpen: boolean;
  readonly setupChecks?: ReadonlyArray<SetupCheck>;
  readonly setupChecking: boolean;
  // The last setup.check failed as a whole (server unreachable): shown with Check again.
  readonly setupError?: string;
  // Plugin folders found (D97), with whether each is allowed; read with the setup check.
  readonly plugins?: ReadonlyArray<PluginInfo>;
  // Why allowing (or revoking) a plugin failed.
  readonly pluginError?: string;
  // Settings › Plugins, Add plugin… (D102): installing, why it failed (reason "replaces-bundled"
  // can be retried on purpose), and the plugin whose approval dialog is open.
  readonly pluginInstalling?: boolean;
  readonly pluginInstallError?: { readonly message: string; readonly reason: string; readonly source: string; readonly ref?: string | undefined };
  readonly pluginInstallNote?: string;
  readonly pluginDialog?: string;
  /** The allowed plugins' looks, components and check rules (D103), for the grids and Checks. */
  readonly contributions?: PluginContributions;
  /** Process plugins' own findings on the open project (D103), the last answer. */
  readonly pluginFindings?: { readonly checks: ReadonlyArray<Check>; readonly notes: ReadonlyArray<string> };
  /** Settings › Plugins › Browse (D103): Uncut's plugin catalog, each with whether it's enabled. */
  readonly pluginCatalog?: { readonly plugins: ReadonlyArray<CatalogEntry>; readonly problems: ReadonlyArray<string> };
  /** The Capture tab's Argent section (D98): what the plugin last said, and while it's asked. */
  readonly capture?: CaptureState;
  readonly captureChecking?: boolean;
  readonly captureError?: string;
  /** Devices whose Record or Stop is on its way to the server. */
  readonly captureBusy?: ReadonlyArray<string>;
  /** D143: devices booting for "Boot and record" (their id before the boot). */
  readonly captureBooting?: ReadonlyArray<string>;
  /** The last take the Capture tab added (its media id and name). */
  readonly captureSaved?: { readonly mediaId: string; readonly name: string; readonly seconds: number };
  /** The Generate tab (D99): the generators and whether each has its key, the server's generation jobs, a prompt to edit. */
  readonly generators?: ReadonlyArray<GeneratorInfo>;
  readonly generateJobs: ReadonlyArray<GenerateJob>;
  readonly generateError?: string;
  readonly generateDraft?: GenerateDraft & { readonly seq: number };
  /** Settings › Keys: which providers have a key (never the key). */
  readonly keys?: ReadonlyArray<KeyInfo>;
  readonly keysError?: string;
  /** The library sound being added (D134), for its row's spinner. */
  readonly libraryAdding?: string | undefined;
  /** Settings opened at a section (the Generate tab's "Settings › Keys" link). */
  readonly setupFocus?: "keys" | "plugins";
  // Import jobs on the server (running and recent); the library shows the open project's.
  readonly jobs: ReadonlyArray<ImportJob>;
  readonly importReport?: { readonly failed: MediaImportResult["failed"]; readonly skipped: MediaImportResult["skipped"] };
  // Media ids that have a poster on the server; others show an icon (no request, no 404).
  readonly thumbIds: ReadonlySet<string>;
  // The open project's agent (turns, the running one) from agent.subscribe.
  readonly agent: AgentState | null;
  // The open project's history (D71) from history.subscribe, for the History tab.
  readonly history: HistoryState | null;
  // Why the last agent action failed (not installed, busy…), shown in the Agent tab.
  readonly agentError?: string;
  // The composer (D140): what's typed and what its @labels point at. In the store, so Add to chat
  // (D141) from the timeline, the canvas or the Inspector lands in it with the Agent tab closed.
  readonly agentDraft: string;
  readonly agentMentions: ReadonlyArray<AgentMention>;
  // A message written while a turn runs: sent when that turn ends.
  readonly agentQueued?: { readonly prompt: string; readonly mentions: ReadonlyArray<AgentMention>; readonly images?: ReadonlyArray<AgentImage> };
  // Images attached in the composer (D184), sent with the next message.
  readonly agentImages: ReadonlyArray<AgentImage>;
  // Bumped to put the caret in the composer (after Add to chat).
  readonly agentFocus: number;
  // D202, D235: an agent ui_show (it never moves the playhead): the pill's stretch, in frames.
  readonly agentChange?: { readonly from: number; readonly to: number; readonly select?: string | undefined; readonly seq: number };
  // A panel the agent's ui_show asked for (D65); the rail and the side tabs follow it once per seq.
  readonly panelRequest?: { readonly panel: AgentUiPanel; readonly seq: number };
  /** "Show in Media" (T7): the tile to scroll to and flash. */
  readonly mediaFocus?: { readonly id: string; readonly seq: number };
  // The export dialog (D34) and the server's export jobs; the one this window started last.
  readonly exportOpen: boolean;
  readonly exportJobs: ReadonlyArray<ExportJob>;
  readonly exportJobId?: string;
  // The folder the last export went to (this session), offered for the next one.
  readonly exportFolder?: string;
  // Analysis jobs on the server (D66); the Library shows the open project's running ones per tile.
  readonly analysisJobs: ReadonlyArray<AnalysisJob>;
  /** D212: the open project's preview proxies (media that needs none has no entry). */
  readonly proxies: ReadonlyArray<ProxyState>;
  // Why the last Analyze click was refused, shown in the Library.
  readonly analysisError?: string;
  // The speech models for transcripts and their downloads (D68), for the Setup row.
  readonly transcription?: TranscriptionState;
  // Why the last model action was refused.
  readonly transcriptionError?: string;
  // ---- environments (Phase 9, D106) ----
  /** Where this window's server runs: Local, or a remote uncut-server (through the desktop's relay). */
  readonly environment: EnvironmentInfo;
  /** Every environment, for the Environments dialog (loaded when it opens). */
  readonly environments?: ReadonlyArray<EnvironmentInfo>;
  readonly environmentsOpen: boolean;
  /** Why the relay can't reach the remote right now (a refused token, nothing listening). */
  readonly environmentProblem?: string;
  /** The remote file browser (D107), open in place of a native dialog. */
  readonly remotePicker?: RemotePickerRequest;
  /** Files going up to a remote project's media/uploads/ (D108). */
  readonly uploading?: { readonly total: number; readonly done: number; readonly name: string };
  /** Remote exports being downloaded, or where they went (D109), by job id. */
  readonly downloads: Readonly<Record<string, { readonly state: "running" } | { readonly path: string } | { readonly error: string }>>;
  /** D186: the brand kits and skills the open project sees, and its choice (the Brand tab). */
  readonly brand?: BrandState;
  /** Why the last brand action failed, shown in the Brand tab. */
  readonly brandError?: string;
}

/** What a remote environment's file browser is for (D107): each native dialog it stands in for. */
export type PickerPurpose = "project" | "parent" | "plugin" | "media" | "save";
export interface RemotePickerRequest {
  readonly purpose: PickerPurpose;
  /** The folder to start in. */
  readonly start?: string | undefined;
  /** "save": the file name to suggest. */
  readonly fileName?: string | undefined;
  readonly seq: number;
}

export const MAX_NAME_LENGTH = 100;

/** What the Generate tab's form holds. */
export interface GenerateDraft {
  readonly generator: string;
  readonly prompt: string;
  readonly kind?: GenerateKind | undefined;
  readonly size?: string | undefined;
  readonly seconds?: number | undefined;
}
/**
 * A field where keys type text (text-like inputs, textareas, contenteditable). A focused checkbox,
 * colour picker or slider is not one: ⌘Z there undoes the project, not typing.
 */
export type SettingsSection = "project" | "app" | "plugins" | "labs" | "shortcuts";
