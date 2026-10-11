import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { start } from "./store.ts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tests wait for this: the connection is up (or failed) and the first state is loaded.
void start().finally(() => (document.body.dataset.ready = "1"));
