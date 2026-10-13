import { Editor } from "./Editor.tsx";
import { Onboarding } from "../onboarding/Onboarding.tsx";
import { useApp } from "../state/store.ts";
import { Welcome } from "../onboarding/Welcome.tsx";
import { Environments } from "../onboarding/Environments.tsx";
import { RemoteBrowser } from "../panels/RemoteBrowser.tsx";
import { Settings } from "../settings/Settings.tsx";
import { ShortcutsSheet } from "../settings/Shortcuts.tsx";

export function App() {
  const app = useApp();
  if (!app.ready) return <div className="splash" />;
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
    </>
  );
}
