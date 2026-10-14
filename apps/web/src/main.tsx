import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./editor/App.tsx";
import { loadFonts } from "./preview/fonts.ts";
import { installLeave } from "./state/leave.tsx";
import { start } from "./state/store.ts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// U13: nothing outside the panels scrolls. The CSS leaves the root nothing to scroll; this puts
// it back at once should a focus or scrollIntoView move it anyway.
document.addEventListener(
  "scroll",
  (e) => {
    // Only the root and the editor's grid: the welcome card and the wizard scroll themselves.
    const root = document.getElementById("root");
    for (const el of [document.documentElement, document.body, root, root?.querySelector(":scope > .app")]) {
      if (el && (e.target === el || e.target === document) && (el.scrollTop || el.scrollLeft)) el.scrollTop = el.scrollLeft = 0;
    }
  },
  true,
);

installLeave();

// Tests wait for this: the connection is up (or failed), the first state is loaded and the
// bundled fonts are ready (D77).
void Promise.all([start(), loadFonts()]).finally(() => (document.body.dataset.ready = "1"));
