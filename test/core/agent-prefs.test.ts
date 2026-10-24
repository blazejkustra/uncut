// D214: the composer's access per project: Auto for a project never set, a stored "edit" (Edit
// freely, before Auto) becomes Auto, Ask first and Look only stay.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  window: { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} },
  Event: class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  },
});

const { agentPrefs, DEFAULT_AGENT_PREFS, setAgentPrefs } = await import("../../apps/web/src/state/agentPrefs.ts");
const { AGENT_ACCESS } = await import("../../packages/contracts/src/index.ts");

test("D214 access: Auto by default, stored Edit freely migrates to Auto, the others stay", () => {
  assert.deepEqual([...AGENT_ACCESS], ["look", "ask", "auto"]);
  assert.equal(DEFAULT_AGENT_PREFS.access, "auto");
  assert.equal(agentPrefs("/p/New.uncut").access, "auto", "a new project starts in Auto");
  store.set("uncut.agent.prefs", JSON.stringify([["/p/Old.uncut", { access: "edit", effort: "high" }], ["/p/Ask.uncut", { access: "ask" }], ["/p/Look.uncut", { access: "look" }], ["/p/Odd.uncut", { access: "free" }]]));
  assert.deepEqual(agentPrefs("/p/Old.uncut"), { provider: "claude", effort: "high", access: "auto" }, "Edit freely became Auto, the rest kept");
  assert.equal(agentPrefs("/p/Ask.uncut").access, "ask");
  assert.equal(agentPrefs("/p/Look.uncut").access, "look");
  assert.equal(agentPrefs("/p/Odd.uncut").access, "auto");
  setAgentPrefs("/p/Old.uncut", { model: undefined });
  const saved = JSON.parse(store.get("uncut.agent.prefs")!) as Array<[string, { access: string }]>;
  assert.equal(saved.find(([d]) => d === "/p/Old.uncut")![1].access, "auto", "written back as Auto");
  setAgentPrefs("/p/Old.uncut", { access: "ask" });
  assert.equal(agentPrefs("/p/Old.uncut").access, "ask", "Ask first stays available");
});

test("issue #106: the provider per project: Claude Code unless Codex was picked; a model of the other provider is its default", () => {
  assert.equal(DEFAULT_AGENT_PREFS.provider, "claude");
  store.set("uncut.agent.prefs", JSON.stringify([["/p/Codex.uncut", { provider: "codex", model: "gpt-6.1-sol", access: "ask" }], ["/p/Mixed.uncut", { provider: "codex", model: "claude-opus-5-5" }], ["/p/Odd.uncut", { provider: "gemini", model: "claude-opus-5-5" }]]));
  assert.deepEqual(agentPrefs("/p/Codex.uncut"), { provider: "codex", model: "gpt-6.1-sol", access: "ask" });
  assert.deepEqual(agentPrefs("/p/Mixed.uncut"), { provider: "codex", access: "auto" }, "a Claude model isn't Codex's");
  assert.deepEqual(agentPrefs("/p/Odd.uncut"), { provider: "claude", model: "claude-opus-5-5", access: "auto" }, "an unknown provider is Claude Code");
  setAgentPrefs("/p/Codex.uncut", { provider: "claude" });
  assert.deepEqual(agentPrefs("/p/Codex.uncut"), { provider: "claude", access: "ask" }, "switching back drops the Codex model");
});
