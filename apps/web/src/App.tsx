import type { ServerHello } from "@uncut/contracts";
import { useEffect, useState } from "react";

import { getServerConnection, onServerExit } from "./bridge.ts";
import { fetchHello } from "./rpc.ts";

type Status =
  | { readonly state: "connecting" }
  | { readonly state: "connected"; readonly hello: ServerHello }
  | { readonly state: "error"; readonly message: string };

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);

export function App() {
  const [status, setStatus] = useState<Status>({ state: "connecting" });

  useEffect(() => onServerExit((message) => setStatus({ state: "error", message })), []);

  useEffect(() => {
    getServerConnection()
      .then(fetchHello)
      .then(
        (hello) => setStatus({ state: "connected", hello }),
        (error: unknown) => setStatus({ state: "error", message: describeError(error) }),
      )
      // Tests wait for this before reading the status line.
      .finally(() => (document.body.dataset.ready = "1"));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="name">Uncut</span>
      </header>
      <main className="main">
        <h1>Uncut</h1>
        <div className="status" data-state={status.state} data-testid="status">
          <span className="dot" />
          <span>{statusText(status)}</span>
        </div>
      </main>
    </div>
  );
}

function statusText(status: Status) {
  switch (status.state) {
    case "connecting":
      return "Connecting to server…";
    case "connected":
      return `Server connected · server v${status.hello.version} · media core v${status.hello.mediaCore.version}`;
    case "error":
      return `Server unavailable: ${status.message}`;
  }
}
