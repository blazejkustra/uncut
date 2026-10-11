import { Editor } from "./Editor.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { useApp } from "./store.ts";
import { Welcome } from "./Welcome.tsx";

export function App() {
  const app = useApp();
  if (!app.ready) return <div className="splash" />;
  return (
    <>
      {/* Over the editor the wizard is a modal; without a project it replaces the welcome card. */}
      {app.snapshot ? <Editor snapshot={app.snapshot} /> : !app.setupOpen && <Welcome />}
      {app.setupOpen && <Onboarding standalone={!app.snapshot} />}
    </>
  );
}
