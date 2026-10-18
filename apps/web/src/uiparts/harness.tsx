// The UI parts harness (scripts/ui-parts.ts): the real editor (App, with its real CSS) mounted on
// the fixture's state instead of a server, so the generator can lift each part's DOM as the app
// draws it. Loaded only by the generator (uiparts.html), never by the app. A scene sets the store
// to one moment (the storyboard waiting, the turn done, the export dialog, the export running);
// window.__uiparts.scene(name) resolves once React has drawn it.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../editor/App.tsx";
import { layout, rememberSideTab } from "../editor/layout.ts";
import { set } from "../state/store/core.ts";
import { setServerConnection } from "../state/store/server.ts";
import { playback } from "../preview/playback.ts";
import { closeMenu } from "../timeline/ContextMenu.tsx";
import { FIXTURE_AGENT_CHIP, FIXTURE_AGENT_DONE, FIXTURE_AGENT_PLAN, FIXTURE_CHIP, FIXTURE_DIR, FIXTURE_EXPORT_JOB, FIXTURE_FX_CLIP, FIXTURE_MENU_CLIP, FIXTURE_PROMPT, FIXTURE_SETUP, FIXTURE_SNAPSHOT, FIXTURE_SNAPSHOT_FX } from "./fixture.ts";
import "../styles.css";

// Waveforms come from the server's peaks: a fixed, beat-like envelope here (120 BPM, a kick every
// 0.5 s), so audio clips draw as they do in the app. Every other request has nothing to answer.
const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/media/waveform/")) {
    const rate = 100;
    const seconds = /m-music/.test(url) ? 28 : 3;
    const bytes = new Uint8Array(rate * seconds);
    for (let i = 0; i < bytes.length; i++) {
      const t = i / rate;
      const kick = Math.exp(-((t % 0.5) * 9));
      const wobble = 0.5 + 0.5 * Math.sin(i * 1.7) * Math.sin(i * 0.31);
      bytes[i] = Math.round(255 * Math.min(1, 0.25 + 0.55 * kick + 0.2 * wobble));
    }
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return Promise.resolve(new Response(JSON.stringify({ rate, seconds, peaks: btoa(bin) }), { status: 200, headers: { "content-type": "application/json" } }));
  }
  if (url.startsWith("http://127.0.0.1:9/")) return Promise.resolve(new Response("", { status: 404 }));
  return realFetch(input, init);
};

setServerConnection({ url: "ws://127.0.0.1:9/ws", token: "fixture" });
rememberSideTab(FIXTURE_DIR, "agent");
// The side panel a little wider than its default, as people use it for the agent (the parts read better).
layout.set("side", 440, false);

const base = {
  ready: true,
  connection: "connected" as const,
  appInfo: { homeDir: "/Users/you", defaultParentDir: "/Users/you/Movies" },
  snapshot: FIXTURE_SNAPSHOT,
  setupChecks: FIXTURE_SETUP,
  setupChecking: false,
  exportFolder: "/Users/you/Movies",
  agentMentions: [],
};

const SCENES = {
  // A new chat: the prompt typed in the composer, Send ready.
  compose: { ...base, agent: { dir: FIXTURE_DIR, provider: "Claude Code", running: null, turns: [] }, agentDraft: FIXTURE_PROMPT, exportOpen: false, exportJobs: [], exportJobId: undefined },
  // The storyboard waits for Approve.
  plan: { ...base, agent: FIXTURE_AGENT_PLAN, agentDraft: "", exportOpen: false, exportJobs: [], exportJobId: undefined },
  // The turn is done: the review card, the reply, the edits; the composer empty.
  done: { ...base, agent: FIXTURE_AGENT_DONE, agentDraft: "", exportOpen: false, exportJobs: [], exportJobId: undefined },
  // The export dialog, before Export.
  export: { ...base, agent: FIXTURE_AGENT_DONE, agentDraft: "", exportOpen: true, exportJobs: [], exportJobId: undefined },
  // The export running.
  exporting: { ...base, agent: FIXTURE_AGENT_DONE, agentDraft: "", exportOpen: true, exportJobs: [FIXTURE_EXPORT_JOB], exportJobId: FIXTURE_EXPORT_JOB.id },
  // A clip selected with a look and an effect on it: the Inspector's effect rows and the Effects tab.
  effects: { ...base, snapshot: FIXTURE_SNAPSHOT_FX, agent: FIXTURE_AGENT_DONE, agentDraft: "", exportOpen: false, exportJobs: [], exportJobId: undefined },
  // A Main clip's right-click menu open, "Add to chat" under the pointer; the composer holding that
  // clip's chip and a sent prompt with one (only the menu is lifted from here; the chips give their CSS).
  menu: { ...base, agent: FIXTURE_AGENT_CHIP, agentDraft: `@${FIXTURE_CHIP.label} `, agentMentions: [FIXTURE_CHIP], exportOpen: false, exportJobs: [], exportJobId: undefined },
};
export type SceneName = keyof typeof SCENES;

const frames = (n: number) => new Promise<void>((done) => {
  const step = (left: number) => (left <= 0 ? done() : requestAnimationFrame(() => step(left - 1)));
  step(n);
});

declare global {
  interface Window {
    __uiparts: { scene(name: SceneName): Promise<void> };
  }
}

window.__uiparts = {
  async scene(name) {
    // The menu lives outside the store: open only in its scene.
    closeMenu();
    set(SCENES[name]);
    // The effects scene shows the Inspector on a selected clip and the Effects tab; the others the agent.
    const fx = name === "effects";
    playback.selectMany(fx ? [FIXTURE_FX_CLIP] : []);
    rememberSideTab(FIXTURE_DIR, fx ? "inspector" : "agent");
    await frames(2);
    (document.querySelector(`[data-rail="${fx ? "effects" : "media"}"]`) as HTMLElement | null)?.click();
    // Effects, layout effects and the waveforms' fetches: a few frames and a short wait.
    await frames(4);
    await new Promise((r) => setTimeout(r, 300));
    await frames(2);
    if (name === "menu") {
      // Right-click on the clip, as the timeline gets it (its own handler builds the real menu), then
      // the pointer's row: the first entry, Add to chat, highlighted as under the pointer.
      const clip = document.querySelector<HTMLElement>(`[data-testid=timeline-item][data-item="${FIXTURE_MENU_CLIP}"]`)!;
      const r = clip.getBoundingClientRect();
      clip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }));
      await frames(2);
      document.querySelector(".ctx-menu")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await frames(2);
    }
  },
};

set(SCENES.plan);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
document.body.dataset.ready = "1";
