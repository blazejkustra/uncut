import { type AgentAccess, type AgentEffort, AGENT_MODELS, AGENT_EFFORTS, AGENT_ACCESS } from "@uncut/contracts";
import { Eye, ShieldCheck, Sparkles, ChevronDown, Gauge, Check, Search, Star } from "lucide-react";
import { useState, useRef, useEffect, useMemo } from "react";
import { useAgentPrefs, setAgentPrefs, toggleFavourite } from "../../state/agentPrefs.ts";
import { ClaudeMark, OpenAIMark } from "./providerMarks.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";

export const ACCESS_INFO: Record<AgentAccess, { name: string; short: string; detail: string; icon: typeof Eye }> = {
  look: { name: "Look only", short: "Look only", detail: "Reads and looks, changes nothing", icon: Eye },
  ask: { name: "Ask first", short: "Ask first", detail: "Commands, file writes, removals and large edits wait for your Allow", icon: ShieldCheck },
  auto: { name: "Auto", short: "Auto", detail: "Claude Code approves routine work itself; risky steps still ask. Every turn can be undone", icon: Sparkles },
};
const EFFORT_NAME: Record<AgentEffort, string> = { low: "Low", medium: "Medium", high: "High", max: "Max" };

type Menu = "provider" | "model" | "effort" | "access" | undefined;
type Provider = "claude" | "codex";

/**
 * Issue #50 (supersedes D209's no-logo rule, maintainer's call): each provider shows its real mark,
 * embedded like t3code does (providerMarks.tsx), next to its product's name; the provider menu
 * still says Uncut isn't made by or affiliated with either lab.
 */
const PROVIDERS: Record<Provider, { readonly name: string; readonly lab: string; readonly Mark: typeof ClaudeMark }> = {
  claude: { name: "Claude", lab: "Anthropic", Mark: ClaudeMark },
  codex: { name: "Codex", lab: "OpenAI", Mark: OpenAIMark },
};

export function ProviderMark({ provider, size = "sm" }: { provider: Provider; size?: "sm" | "md" }) {
  const { Mark } = PROVIDERS[provider];
  return (
    <span className={`provider-mark ${size}`} data-testid="provider-mark" data-provider={provider} aria-hidden>
      <Mark className="provider-logo" focusable="false" />
    </span>
  );
}

const ProviderWordmark = ({ provider }: { provider: Provider }) => (
  <span className="provider-wordmark" data-testid="provider-wordmark" data-provider={provider}>
    {PROVIDERS[provider].name}
  </span>
);

/** ⌘1–⌘4 pick the models in AGENT_MODELS order (like t3code's picker). */
const MODEL_KEYS = AGENT_MODELS.slice(0, 4).map((m, i) => ({ id: m.id, key: String(i + 1) }));

/**
 * The composer's bottom row (D184): provider (Claude Code; Codex to come), model (searchable, with
 * favourites), effort and access. Each opens a small menu above the box; Esc or a click elsewhere
 * closes it. Remembered per project; a new model or effort applies from the next message.
 */
export function ComposerChoices({ dir, provider }: { dir: string; provider: string }) {
  const { prefs, favourites } = useAgentPrefs(dir);
  const [open, setOpen] = useState<Menu>(undefined);
  const [search, setSearch] = useState("");
  const row = useRef<HTMLDivElement>(null);
  // ⌘1–⌘4: a model, while the model menu is open or the composer has the focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      const hit = MODEL_KEYS.find((k) => k.key === e.key);
      if (!hit) return;
      const inComposer = row.current?.closest(".composer")?.contains(document.activeElement);
      if (open !== "model" && !inComposer) return;
      e.preventDefault();
      e.stopPropagation();
      setAgentPrefs(dir, { model: hit.id });
      setOpen(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, dir]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!row.current?.contains(e.target as Node)) setOpen(undefined);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(undefined);
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  const toggle = (menu: Menu) => {
    setSearch("");
    setOpen(open === menu ? undefined : menu);
  };
  const pick = (patch: Parameters<typeof setAgentPrefs>[1]) => {
    setAgentPrefs(dir, patch);
    setOpen(undefined);
  };
  const model = AGENT_MODELS.find((m) => m.id === prefs.model);
  const access = ACCESS_INFO[prefs.access];
  const AccessIcon = access.icon;
  const models = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = [{ id: "", name: "Default", detail: "Claude Code's choice", provider: "claude" as const, isNew: false }, ...AGENT_MODELS].filter((m) => !q || m.name.toLowerCase().includes(q) || m.detail.toLowerCase().includes(q));
    // Favourites first, in the list's order.
    return [...all.filter((m) => favourites.includes(m.id)), ...all.filter((m) => !favourites.includes(m.id))];
  }, [search, favourites]);
  return (
    <div className="composer-choices" ref={row}>
      <Tooltip label={`Claude, through ${provider} with your subscription`}>
        <button className={`choice provider ${open === "provider" ? "open" : ""}`} data-testid="agent-provider" data-provider="claude" onClick={() => toggle("provider")}>
          <ProviderMark provider="claude" />
        </button>
      </Tooltip>
      <button className={`choice model ${open === "model" ? "open" : ""}`} data-testid="agent-model" data-model={prefs.model ?? ""} title={`Model: ${model?.name ?? "Default (Claude Code's choice)"}`} onClick={() => toggle("model")}>
        <ProviderWordmark provider="claude" />
        <span className="choice-label">{model?.name ?? "Default"}</span>
        <ChevronDown className="choice-caret" />
      </button>
      <button className={`choice ${open === "effort" ? "open" : ""}`} data-testid="agent-effort" data-effort={prefs.effort ?? ""} title={`Effort: ${prefs.effort ? EFFORT_NAME[prefs.effort] : "Auto"}`} onClick={() => toggle("effort")}>
        <Gauge />
        <span className="choice-label">{prefs.effort ? EFFORT_NAME[prefs.effort] : "Auto"}</span>
      </button>
      <button className={`choice ${open === "access" ? "open" : ""}`} data-testid="agent-access" data-access={prefs.access} title={`${access.name}: ${access.detail}`} onClick={() => toggle("access")}>
        <AccessIcon />
        <span className="choice-label">{access.short}</span>
      </button>
      {open === "provider" && (
        <div className="choice-menu" role="listbox" data-testid="agent-provider-menu">
          <div className="choice-head">Agents</div>
          <button className="choice-option active" role="option" aria-selected data-testid="agent-provider-claude" onClick={() => setOpen(undefined)}>
            <ProviderMark provider="claude" size="md" />
            <span className="grow">
              <ProviderWordmark provider="claude" />
              <span className="choice-detail">Through {provider}, with your subscription</span>
            </span>
            <Check />
          </button>
          <button className="choice-option" role="option" aria-selected={false} disabled data-testid="agent-provider-codex">
            <ProviderMark provider="codex" size="md" />
            <span className="grow">
              <ProviderWordmark provider="codex" />
              <span className="choice-detail">Coming later</span>
            </span>
          </button>
          <div className="choice-foot">Not made by or affiliated with Anthropic or OpenAI.</div>
        </div>
      )}
      {open === "model" && (
        <div className="choice-menu model-menu" role="listbox" data-testid="agent-model-menu">
          <div className="model-rail" data-testid="agent-model-rail">
            <Tooltip label="Claude">
              <button className="model-rail-btn active" data-testid="agent-model-rail-claude">
                <ProviderMark provider="claude" size="md" />
              </button>
            </Tooltip>
            <Tooltip label="Codex: coming later">
              <button className="model-rail-btn" disabled data-testid="agent-model-rail-codex">
                <ProviderMark provider="codex" size="md" />
              </button>
            </Tooltip>
          </div>
          <div className="model-list">
          <label className="choice-search">
            <Search />
            <input
              autoFocus
              value={search}
              placeholder="Search models"
              data-testid="agent-model-search"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && models[0]) pick({ model: models[0].id || undefined });
              }}
            />
          </label>
          {models.map((m) => {
            const on = (prefs.model ?? "") === m.id;
            const fav = favourites.includes(m.id);
            return (
              <div key={m.id || "default"} className={`choice-option ${on ? "active" : ""}`} role="option" aria-selected={on} data-testid="agent-model-option" data-model={m.id} onClick={() => pick({ model: m.id || undefined })}>
                <ProviderMark provider={m.provider} />
                <span className="grow">
                  <span className="model-name">
                    {m.name}
                    {m.isNew && (
                      <span className="new-badge" data-testid="agent-model-new">
                        NEW
                      </span>
                    )}
                  </span>
                  <span className="choice-detail">{m.detail}</span>
                </span>
                {on && <Check />}
                {MODEL_KEYS.find((k) => k.id === m.id) && (
                  <kbd className="model-key" data-testid="agent-model-key">
                    ⌘{MODEL_KEYS.find((k) => k.id === m.id)!.key}
                  </kbd>
                )}
                {m.id && (
                  <Tooltip label={fav ? "Remove from favourites" : "Add to favourites"}>
                    <button
                      className={`icon-btn choice-star ${fav ? "on" : ""}`}
                     
                      data-testid="agent-model-star"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavourite(m.id);
                      }}
                    >
                      <Star />
                    </button>
                  </Tooltip>
                )}
              </div>
            );
          })}
          {!models.length && <div className="choice-empty">No model matches</div>}
          </div>
        </div>
      )}
      {open === "effort" && (
        <div className="choice-menu" role="listbox" data-testid="agent-effort-menu">
          {([undefined, ...AGENT_EFFORTS] as const).map((e) => {
            const on = prefs.effort === e;
            return (
              <button key={e ?? "auto"} className={`choice-option ${on ? "active" : ""}`} role="option" aria-selected={on} data-testid="agent-effort-option" data-effort={e ?? ""} onClick={() => pick({ effort: e })}>
                <span className="grow">
                  {e ? EFFORT_NAME[e] : "Auto"}
                  <span className="choice-detail">{e === "low" ? "Quick answers" : e === "medium" ? "Balanced" : e === "high" ? "Thinks longer" : e === "max" ? "Thinks the longest" : "Claude Code's default"}</span>
                </span>
                {on && <Check />}
              </button>
            );
          })}
        </div>
      )}
      {open === "access" && (
        <div className="choice-menu" role="listbox" data-testid="agent-access-menu">
          {AGENT_ACCESS.map((a) => {
            const info = ACCESS_INFO[a];
            const Icon = info.icon;
            const on = prefs.access === a;
            return (
              <button key={a} className={`choice-option ${on ? "active" : ""}`} role="option" aria-selected={on} data-testid="agent-access-option" data-access={a} onClick={() => pick({ access: a })}>
                <Icon />
                <span className="grow">
                  {info.name}
                  <span className="choice-detail">{info.detail}</span>
                </span>
                {on && <Check />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
