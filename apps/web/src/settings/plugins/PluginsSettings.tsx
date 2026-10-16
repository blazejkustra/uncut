// Settings › Plugins (D258, issue #90): the marketplace (Uncut's catalog as cards, searchable, with
// what's installed above what's available) and Make a plugin (the creation guide). Installing,
// enabling, disabling and removing go through the same actions and approval dialog as the setup's
// plugin step (D97, D102, D103, D248): Install copies a catalog plugin in and opens the dialog;
// Enable… opens it for a copy that isn't allowed; Disable stops allowing it; Remove deletes the copy.
import type { CatalogEntry, PluginInfo } from "@uncut/contracts";
import { Check, CircleAlert, Plus, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PluginIcon } from "../../onboarding/PluginIcon.tsx";
import { AddPlugin, PluginApproval } from "../../onboarding/plugins.tsx";
import "../../onboarding/rowMarks.css";
import { actions, useApp } from "../../state/store.ts";
import { MakePlugin } from "./MakePlugin.tsx";
import "./plugins.css";

type View = "market" | "guide";

export function PluginsSettings() {
  const [view, setView] = useState<View>("market");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<string | undefined>();
  useEffect(() => {
    void actions.listPlugins();
    void actions.loadCatalog();
  }, []);
  return (
    <div data-testid="plugins-settings" className="pm">
      <div className="pm-tabs" role="tablist">
        <button role="tab" aria-selected={view === "market"} className={view === "market" ? "active" : ""} data-testid="plugins-tab-market" onClick={() => setView("market")}>
          Marketplace
        </button>
        <button role="tab" aria-selected={view === "guide"} className={view === "guide" ? "active" : ""} data-testid="plugins-tab-guide" onClick={() => setView("guide")}>
          Make a plugin
        </button>
      </div>
      {view === "market" ? (
        <Marketplace query={query} setQuery={setQuery} highlight={highlight} />
      ) : (
        <MakePlugin
          onShowExample={(id, name) => {
            setQuery(name);
            setHighlight(id);
            setView("market");
          }}
        />
      )}
    </div>
  );
}

/** What a plugin adds, as short tags for its card. */
function kindsOf(c: PluginInfo["contributes"] | CatalogEntry["contributes"], tools: number, runs: boolean | undefined): Array<string> {
  return [
    c?.looks.length ? "Text looks" : "",
    c?.components.length ? "Components" : "",
    c?.rules.length ? "Checks" : "",
    c?.filters?.length ? "Filters" : "",
    c?.shaders?.length ? "Shader effects" : "",
    c?.skills?.length ? "Skills" : "",
    tools ? "Agent tools" : "",
    runs ? "Runs a program" : "",
  ].filter(Boolean);
}

const matches = (q: string, values: ReadonlyArray<string | undefined>) => !q || values.some((v) => v?.toLowerCase().includes(q));
const contributionNames = (c: PluginInfo["contributes"] | CatalogEntry["contributes"]) => (c ? [...c.looks, ...c.components, ...c.rules, ...(c.filters ?? []), ...(c.shaders ?? []), ...(c.skills ?? [])] : []);

function Marketplace({ query, setQuery, highlight }: { query: string; setQuery: (q: string) => void; highlight: string | undefined }) {
  const { plugins, pluginCatalog, pluginError, pluginInstallNote, pluginInstalling, pluginDialog, connection } = useApp();
  const [adding, setAdding] = useState(false);
  const offline = connection !== "connected";
  const busy = offline || !!pluginInstalling;
  const q = query.trim().toLowerCase();
  const catalog = pluginCatalog?.plugins ?? [];
  const byId = useMemo(() => new Map(catalog.map((e) => [e.id, e])), [catalog]);
  const installed = (plugins ?? []).filter((p) => matches(q, [p.id, p.name, p.description, p.author, ...kindsOf(p.contributes, p.tools.length, p.runs), ...contributionNames(p.contributes), ...p.tools]));
  // Available: catalog plugins no copy of which is in use (a same-id plugin from elsewhere counts as installed).
  const available = catalog.filter((e) => !e.enabled && !(plugins ?? []).some((p) => p.id === e.id && p.status !== "broken")).filter((e) => matches(q, [e.id, e.name, e.description, e.author, ...kindsOf(e.contributes, e.tools.length, e.runs), ...contributionNames(e.contributes), ...e.tools]));
  const dialog = pluginDialog ? plugins?.find((p) => p.id === pluginDialog && p.status !== "broken") : undefined;
  useEffect(() => {
    if (!highlight) return;
    document.querySelector(`[data-testid="market-card"][data-id="${CSS.escape(highlight)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight, pluginCatalog, plugins]);
  return (
    <div className="pm-market" data-testid="plugins-market">
      <div className="pm-toolbar">
        <div className="field pm-search">
          <Search />
          <input data-testid="market-search" placeholder="Search plugins: name, author, what they add" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        </div>
        {!adding && (
          <button className="btn ghost" data-testid="market-add" disabled={offline} onClick={() => setAdding(true)}>
            <Plus />
            Add from a folder or git…
          </button>
        )}
      </div>
      {adding && <AddPlugin offline={offline} onClose={() => setAdding(false)} />}
      {pluginInstallNote && (
        <div className="wiz-note warn" data-testid="market-install-note">
          <TriangleAlert />
          {pluginInstallNote}
        </div>
      )}
      {pluginError && (
        <div className="wiz-note error" data-testid="market-error">
          <TriangleAlert />
          {pluginError}
        </div>
      )}
      <div className="pm-section" data-testid="market-installed">
        <div className="pm-section-head">
          Installed <span className="pm-count">{installed.length}</span>
        </div>
        {plugins && !installed.length && <div className="pm-empty">{q ? "No installed plugin matches that." : "No plugins installed."}</div>}
        <div className="pm-grid">
          {installed.map((p) => (
            <InstalledCard key={`${p.source}:${p.dir}`} plugin={p} entry={byId.get(p.id)} busy={busy} highlight={highlight === p.id} />
          ))}
        </div>
      </div>
      <div className="pm-section" data-testid="market-available">
        <div className="pm-section-head">
          Available <span className="pm-count">{available.length}</span>
        </div>
        <div className="pm-lead">Plugins from Uncut's catalog. Installing one runs nothing: you see what it adds and asks for, then allow it.</div>
        {pluginCatalog && !available.length && <div className="pm-empty">{q ? "No plugin in the catalog matches that." : "Every plugin in the catalog is installed."}</div>}
        <div className="pm-grid">
          {available.map((e) => (
            <AvailableCard key={e.id} entry={e} busy={busy} highlight={highlight === e.id} />
          ))}
        </div>
        {pluginCatalog?.problems.map((p) => (
          <div key={p} className="pm-empty error">
            {p}
          </div>
        ))}
      </div>
      {dialog && <PluginApproval plugin={dialog} offline={offline} />}
    </div>
  );
}

function CardBody({ id, icon, name, author, version, description, kinds, asks, capabilities }: { id: string; icon: string | undefined; name: string; author: string | undefined; version: string | undefined; description: string | undefined; kinds: ReadonlyArray<string>; asks: ReadonlyArray<string>; capabilities: ReadonlyArray<string> }) {
  return (
    <>
      <div className="pm-card-head">
        <span className="pm-icon">
          <PluginIcon icon={icon} id={id} />
        </span>
        <div className="pm-title">
          <div className="pm-name">{name}</div>
          <div className="pm-by">
            {author ? `By ${author}` : "Author not given"}
            {version ? `, version ${version}` : ""}
          </div>
        </div>
      </div>
      {description && <p className="pm-desc">{description}</p>}
      {kinds.length > 0 && (
        <div className="pm-kinds" data-testid="market-kinds">
          {kinds.map((k) => (
            <span key={k} className="pm-kind">
              {k}
            </span>
          ))}
        </div>
      )}
      <div className="pm-perms" data-testid="market-perms" title={capabilities.length ? `Capabilities: ${capabilities.join(", ")}` : "No capabilities"}>
        <ShieldCheck />
        <div>
          {asks.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>
    </>
  );
}

function AvailableCard({ entry: e, busy, highlight }: { entry: CatalogEntry; busy: boolean; highlight: boolean }) {
  return (
    <div className={`pm-card${highlight ? " highlight" : ""}`} data-testid="market-card" data-id={e.id} data-state="available">
      <CardBody id={e.id} icon={e.icon} name={e.name} author={e.author} version={e.version} description={e.description} kinds={kindsOf(e.contributes, e.tools.length, e.runs)} asks={e.asks ?? []} capabilities={e.capabilities} />
      <div className="pm-actions">
        <button className="btn primary" data-testid={`market-install-${e.id}`} disabled={busy} onClick={() => void actions.enablePlugin(e.id)}>
          Install…
        </button>
      </div>
    </div>
  );
}

function InstalledCard({ plugin: p, entry, busy, highlight }: { plugin: PluginInfo; entry: CatalogEntry | undefined; busy: boolean; highlight: boolean }) {
  const state = p.source === "bundled" ? "bundled" : p.status === "ready" ? "enabled" : p.status === "broken" ? "broken" : "disabled";
  const from = p.source === "bundled" ? "Ships with Uncut" : p.origin?.kind === "catalog" ? "From Uncut's catalog" : p.origin?.kind === "git" ? `From ${p.origin.source}` : p.origin ? `Copied from ${p.origin.source}` : `From ${p.dir}`;
  return (
    <div className={`pm-card${highlight ? " highlight" : ""}`} data-testid="market-card" data-id={p.id} data-state={state}>
      <CardBody id={p.id} icon={p.status === "broken" ? undefined : p.icon} name={p.name} author={p.author ?? entry?.author} version={p.version} description={p.problem ?? p.description} kinds={kindsOf(p.contributes, p.tools.length, p.runs)} asks={p.asks} capabilities={p.capabilities} />
      {p.warnings.length > 0 && (
        <div className="pm-warn" title={p.warnings.join("\n")}>
          {p.warnings[0]}
        </div>
      )}
      <div className="pm-from" title={p.dir}>
        {from}
      </div>
      <div className="pm-actions">
        {state === "bundled" ? (
          <span className="wiz-chip ok" data-testid={`market-chip-${p.id}`}>
            <Check />
            Built in
          </span>
        ) : state === "broken" ? (
          <span className="wiz-chip error" data-testid={`market-chip-${p.id}`}>
            <CircleAlert />
            Not loaded
          </span>
        ) : state === "enabled" ? (
          <>
            <span className="wiz-chip ok" data-testid={`market-chip-${p.id}`}>
              <Check />
              Enabled
            </span>
            <button className="btn" data-testid={`market-disable-${p.id}`} disabled={busy} onClick={() => void actions.revokePlugin(p.id)}>
              Disable
            </button>
          </>
        ) : (
          <button className="btn primary" data-testid={`market-enable-${p.id}`} disabled={busy} onClick={() => actions.openPluginDialog(p.id)}>
            Enable…
          </button>
        )}
        {p.removable && (
          <button className="btn ghost" data-testid={`market-remove-${p.id}`} disabled={busy} onClick={() => void actions.uninstallPlugin(p.id).then(() => actions.loadCatalog())}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
