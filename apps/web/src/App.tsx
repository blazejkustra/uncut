import { Editor } from "./Editor.tsx";
import { useApp } from "./store.ts";
import { Welcome } from "./Welcome.tsx";

export function App() {
  const app = useApp();
  if (!app.ready) return <div className="splash" />;
  return app.snapshot ? <Editor snapshot={app.snapshot} /> : <Welcome />;
}
