// C12: several agents in one project. A row of chips (colour, name, focus, status) above the
// thread once there are two; the + makes another with a name and a focus preset.
import { type AgentFocus, type AgentInfo } from "@uncut/contracts";
import { Check, LoaderCircle, Plus, X } from "lucide-react";
import { useRef, useState } from "react";

import { actions, useApp } from "../../state/store.ts";
import { FOCUS_PRESETS, agentUnread, agentsOf, focusLabel, selectedAgentId } from "../../state/agents.ts";
import { Popover } from "../../inspector/controls.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";
import "./tabs.css";

const STATUS_WORDS = { idle: "", working: "Working", waiting: "Waiting for you" } as const;

function chipTitle(a: AgentInfo, unread: boolean) {
  const status = STATUS_WORDS[a.status];
  return [`${a.name}, ${focusLabel(a.focus).toLowerCase()}`, status, unread ? "New since you looked" : ""].filter(Boolean).join(". ");
}

function AgentChip({ agent: a, selected, unread, online }: { agent: AgentInfo; selected: boolean; unread: boolean; online: boolean }) {
  const showFocus = a.focus !== "general" && focusLabel(a.focus).toLowerCase() !== a.name.trim().toLowerCase();
  return (
    <div className={`agent-tab${selected ? " on" : ""}`} role="presentation">
      <button
        className="agent-tab-main"
        role="tab"
        aria-selected={selected}
        data-testid={`agent-tab-${a.id}`}
        data-status={a.status}
        data-unread={unread}
        title={chipTitle(a, unread)}
        onClick={() => actions.agentSelect(a.id)}
      >
        {a.status === "working" ? (
          <LoaderCircle className="agent-tab-spin spin" style={{ color: a.colour }} />
        ) : (
          <span className={`agent-tab-dot ${a.status}`} style={{ background: a.colour }} />
        )}
        <span className="agent-tab-name">{a.name}</span>
        {showFocus && <span className="agent-tab-focus">{focusLabel(a.focus).toLowerCase()}</span>}
        {unread && <span className="agent-tab-unread" data-testid={`agent-tab-unread-${a.id}`} />}
      </button>
      <Tooltip label={a.running !== null ? "Wait for it to finish to close it" : "Close this agent (its turns stay in History)"}>
        <button
          className="agent-tab-close"
          data-testid={`agent-archive-${a.id}`}
          aria-label={`Close ${a.name}`}
          disabled={!online || a.running !== null}
          onClick={() => void actions.agentArchive(a.id)}
        >
          <X />
        </button>
      </Tooltip>
    </div>
  );
}

function AddAgentForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [focus, setFocus] = useState<AgentFocus>("general");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const create = async () => {
    setBusy(true);
    setProblem(undefined);
    const result = await actions.agentCreate(name, focus);
    setBusy(false);
    if (result.ok) onDone();
    else setProblem(result.message);
  };
  return (
    <div className="agent-add-form" data-testid="agent-add-form">
      <input
        className="field input"
        data-testid="agent-add-name"
        placeholder={focusLabel(focus)}
        spellCheck={false}
        autoFocus
        maxLength={40}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !busy && void create()}
      />
      <div className="agent-add-focus" role="radiogroup" aria-label="Focus">
        {FOCUS_PRESETS.map((p) => (
          <button
            key={p.focus}
            role="radio"
            aria-checked={p.focus === focus}
            className={`agent-add-preset${p.focus === focus ? " on" : ""}`}
            data-testid={`agent-add-focus-${p.focus}`}
            onClick={() => setFocus(p.focus)}
          >
            <span className="agent-add-check">{p.focus === focus && <Check />}</span>
            <span className="agent-add-label">{p.label}</span>
            <span className="agent-add-detail">{p.detail}</span>
          </button>
        ))}
      </div>
      {problem && (
        <div className="agent-add-error small" data-testid="agent-add-error">
          {problem}
        </div>
      )}
      <button className="btn primary" data-testid="agent-add-create" disabled={busy} onClick={() => void create()}>
        {busy ? "Adding…" : "Add agent"}
      </button>
    </div>
  );
}

/** The + that adds an agent; `floating` sits in the panel's corner when there's no strip to hold it. */
export function AddAgent({ online, floating }: { online: boolean; floating?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Tooltip label="Add an agent: another conversation that works on the same project">
        <button
          ref={anchor}
          className={`icon-btn agent-add${floating ? " floating" : ""}`}
          data-testid="agent-add"
          aria-label="Add an agent"
          disabled={!online}
          onClick={() => setOpen(!open)}
        >
          <Plus />
        </button>
      </Tooltip>
      {open && (
        <Popover anchor={anchor.current} onClose={close} testId="agent-add-menu" width={260} align="start">
          <AddAgentForm onDone={close} />
        </Popover>
      )}
    </>
  );
}

/** The tab row, once the project has two agents or more. */
export function AgentTabs({ online }: { online: boolean }) {
  const app = useApp();
  const agents = agentsOf(app.agent);
  if (agents.length < 2) return null;
  const selected = selectedAgentId(app);
  return (
    <div className="agent-tabs" role="tablist" data-testid="agent-tabs">
      <div className="agent-tabs-list">
        {agents.map((a) => (
          <AgentChip key={a.id} agent={a} selected={a.id === selected} unread={agentUnread(app, a.id)} online={online} />
        ))}
      </div>
      <AddAgent online={online} />
    </div>
  );
}
