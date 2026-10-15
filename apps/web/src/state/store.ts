// App state and the actions that change it. This module owns the server connection; the
// components only read state (useApp) and call actions.
//
// The open project comes from the server's project.subscribe stream, which is ordered and
// re-sent in full on every reconnect, so the screen always ends up showing what the server
// has. Call results are applied too (for snappiness) but never over a newer revision.

import { bridge } from "./bridge.ts";
import { connect } from "./connection.ts";
import { watchInput } from "./agentFollow.ts";
import { state, set, isRemote } from "./store/core.ts";
import { runCommand, onKeyDown } from "./store/keys.ts";
import { setServerConnection, refreshHello, refreshRecents, setConnection, call } from "./store/server.ts";
import { actions } from "./store/actions.ts";
import { onJobs, onExportJobs, onAnalysisJobs, applyFromServer } from "./store/sync.ts";
import { applyAgentUi } from "./store/agentUi.ts";
export { MAX_NAME_LENGTH } from "./store/types.ts";
export type { ConnectionState, Project, Notice, AppStateShape, PickerPurpose, RemotePickerRequest, GenerateDraft, SettingsSection } from "./store/types.ts";
export { pluginRules, pluginRuleList, pluginLooks, textPresets, subscribeApp, useApp, getState, projectOf, online, isRemote } from "./store/core.ts";
export { plainError } from "./store/server.ts";
export { brandFileUrl, agentImageUrl, thumbUrl, recentThumbUrl, mediaUrl, proxyUrl, proxyOf, musicUrl, sfxUrl, folderSoundUrl, libraryPreviewUrl, waveformUrl, graphicUrl } from "./store/urls.ts";
export { activeAnalyses, activeJobs } from "./store/sync.ts";
export { setLeaveGate, pendingSaves, revealItem, previewEdits, endPreview, speedPlan, shaderDefs } from "./store/edits.ts";
export { actions } from "./store/actions.ts";
export { isTextEntry } from "./store/keys.ts";

export type { MediaItem } from "./project.ts";
let unsubscribe: (() => void) | undefined;
let unsubscribeJobs: (() => void) | undefined;
let unsubscribeAgent: (() => void) | undefined;
let unsubscribeHistory: (() => void) | undefined;
let unsubscribeExports: (() => void) | undefined;
let unsubscribeAnalysis: (() => void) | undefined;
let unsubscribeProxies: (() => void) | undefined;
let unsubscribeTranscription: (() => void) | undefined;
let unsubscribeGenerate: (() => void) | undefined;

// While a remote isn't connected, ask the relay why (a refused token reads differently from a
// server that's down), so the banner can say so.
let statusTimer: ReturnType<typeof setInterval> | undefined;
function watchRemoteStatus() {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    if (state.connection === "connected") return void (state.environmentProblem && set({ environmentProblem: undefined }));
    void bridge.environmentStatus().then(({ problem }) => problem !== state.environmentProblem && set({ environmentProblem: problem }));
  }, 1500);
}

export async function start() {
  // Only Local's own server can exit under the window (the desktop doesn't report it for a remote).
  bridge.onServerExit((message) => !isRemote() && set({ connection: "server-exited", connectionMessage: message }));
  bridge.onMenuCommand(runCommand);
  window.addEventListener("keydown", onKeyDown);
  watchInput();
  const [appInfo, server] = await Promise.all([bridge.appInfo(), bridge.getServerConnection().then((c) => ({ ok: true as const, c }), (e: Error) => ({ ok: false as const, e }))]);
  set({ appInfo });
  if (!server.ok) {
    // The active remote couldn't even be set up (its token unreadable): say so, with the way back to Local.
    void bridge.environments().then(({ active, environments }) => {
      const env = environments.find((e) => e.id === active);
      if (env) set({ environment: env });
    });
    set({ connection: "failed", connectionMessage: server.e.message, ready: true });
    return;
  }
  if (server.c.environment) set({ environment: server.c.environment });
  if (isRemote()) {
    watchRemoteStatus();
    // A remote that doesn't answer mustn't keep the splash up: show the screen (it says it's reconnecting).
    setTimeout(() => !state.ready && set({ ready: true }), 4000);
  }
  let firstSnapshot: () => void = () => {};
  const gotFirstSnapshot = new Promise<void>((resolve) => (firstSnapshot = resolve));
  setServerConnection(server.c);
  const conn = connect(server.c, {
    // Every (re)connect resubscribes: the server re-sends the current project first.
    onConnect: () => {
      if (state.connection === "server-exited") return;
      set({ connection: "connected", environmentProblem: undefined, notice: state.notice?.transport ? undefined : state.notice });
      void actions.loadContributions();
      // A remote that restarted may be another version; a late first connect has no hello yet.
      if (isRemote() || !state.hello) void refreshHello();
      unsubscribeJobs?.();
      unsubscribeJobs = conn.subscribe((c) => c["media.jobs"]({}), onJobs);
      unsubscribeExports?.();
      unsubscribeExports = conn.subscribe((c) => c["export.jobs"]({}), onExportJobs);
      unsubscribeAnalysis?.();
      unsubscribeAnalysis = conn.subscribe((c) => c["analysis.jobs"]({}), onAnalysisJobs);
      unsubscribeProxies?.();
      unsubscribeProxies = conn.subscribe((c) => c["media.proxies"]({}), (proxies) => set({ proxies }));
      unsubscribeTranscription?.();
      unsubscribeTranscription = conn.subscribe((c) => c["transcription.state"]({}), (transcription) => set({ transcription }));
      unsubscribeGenerate?.();
      unsubscribeGenerate = conn.subscribe((c) => c["generate.jobs"]({}), (generateJobs) => set({ generateJobs }));
      unsubscribeAgent?.();
      unsubscribeAgent = conn.subscribe(
        (c) => c["agent.subscribe"]({}),
        (agent) => {
          const was = state.agent?.running ?? null;
          set({ agent });
          applyAgentUi(agent);
          // A turn ended: it may have written a kit's style guide (D186).
          if (was !== null && agent?.running == null) void actions.brandGet();
          // The turn ended: the queued message goes now (D140).
          const queued = state.agentQueued;
          if (queued && was !== null && agent?.running === null) {
            set({ agentQueued: undefined });
            void actions.agentSend(queued.prompt, queued.mentions, queued.images).then((ok) => {
              if (!ok && !state.agentDraft) set({ agentDraft: queued.prompt, agentMentions: queued.mentions, agentImages: queued.images ?? [] });
            });
          }
        },
      );
      unsubscribeHistory?.();
      unsubscribeHistory = conn.subscribe((c) => c["history.subscribe"]({}), (history) => set({ history }));
      unsubscribe?.();
      unsubscribe = conn.subscribe(
        (c) => c["project.subscribe"]({}),
        (snapshot) => {
          applyFromServer(snapshot);
          firstSnapshot();
        },
      );
      void refreshRecents();
      void actions.brandGet();
    },
    onDisconnect: () => {
      if (state.connection !== "server-exited") set({ connection: "reconnecting" });
    },
  });
  setConnection(conn);
  await refreshHello();
  await Promise.race([gotFirstSnapshot, new Promise((r) => setTimeout(r, 5000))]);
  // First launch (onboarding never finished or skipped): show it.
  const setup = await call((c) => c["setup.state"]({}));
  if (setup.ok && !setup.value.onboarded) actions.openSetup();
  set({ ready: true });
}
