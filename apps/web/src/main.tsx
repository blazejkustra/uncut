import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./editor/App.tsx";
import { loadFonts } from "./preview/fonts.ts";
import { start } from "./state/store.ts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tests wait for this: the connection is up (or failed), the first state is loaded and the
// bundled fonts are ready (D77).
void Promise.all([start(), loadFonts()]).finally(() => (document.body.dataset.ready = "1"));
