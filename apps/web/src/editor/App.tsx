import { useEffect, useState } from "react";

import { bridge } from "../state/bridge.ts";
import { Editor } from "./Editor.tsx";
import { Onboarding } from "../onboarding/Onboarding.tsx";
import { useApp } from "../state/store.ts";
import { Welcome } from "../onboarding/Welcome.tsx";
import { Environments } from "../onboarding/Environments.tsx";
import { RemoteBrowser } from "../panels/RemoteBrowser.tsx";
import { Settings } from "../settings/Settings.tsx";
import { ShortcutsSheet } from "../settings/Shortcuts.tsx";
import { LeaveDialog } from "../state/leave.tsx";

type WindowMode = "welcome" | "editor";

/**
 * D209: the window is compact for the welcome card and full for the editor. The screen for a mode
 * shows once the window has that size (the shell resizes it; this waits for the page to follow),
 * so nothing lays out at the other mode's size.
 */
function useWindowMode(want: WindowMode): WindowMode | undefined {
  const [mode, setMode] = useState<WindowMode>("welcome");
  useEffect(() => {
    document.body.dataset.window = mode;
  }, [mode]);
  useEffect(() => {
    if (want === mode) return;
    if (!bridge.windowMode) return setMode(want);
    let gone = false;
    void bridge
      .windowMode(want)
      .then(async ({ width, height }) => {
        for (let i = 0; i < 60 && !(innerWidth === width && innerHeight === height); i++) await new Promise((r) => setTimeout(r, 16));
      })
      .catch(() => {})
      .finally(() => !gone && setMode(want));
    return () => {
      gone = true;
    };
  }, [want, mode]);
  return want === mode ? mode : undefined;
}

export function App() {
  const app = useApp();
  const mode = useWindowMode(app.snapshot ? "editor" : "welcome");
  if (!app.ready || !mode) return <div className="splash" />;
  return (
    <>
      {/* Over the editor the wizard is a modal; without a project it replaces the welcome card. */}
      {app.snapshot ? <Editor snapshot={app.snapshot} /> : !app.setupOpen && <Welcome />}
      {app.setupOpen && <Onboarding standalone={!app.snapshot} />}
      {app.settingsOpen && !app.setupOpen && <Settings />}
      {app.shortcutsOpen && <ShortcutsSheet />}
      {/* Phase 9: Environments (over everything, also while the server is away), and the remote file browser. */}
      {app.environmentsOpen && <Environments />}
      {app.remotePicker && <RemoteBrowser key={app.remotePicker.seq} request={app.remotePicker} />}
      {/* U12: leaving with work in progress asks here, over everything. */}
      <LeaveDialog />
    </>
  );
}
