import type { PluginInfo } from "@uncut/contracts";
import { Search, Plus, TriangleAlert, FolderOpen, GitBranch, Check, CircleAlert, ChevronDown } from "lucide-react";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useApp, actions } from "../state/store.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import { PluginIcon } from "./PluginIcon.tsx";
import "./rowMarks.css";
import "./plugins.css";

/**
 * The setup wizard's Plugins (D97, D102; Settings › Plugins has its own cards): every plugin found, its status, Allow (through the approval
 * dialog) and, for one Uncut installed, Remove; plus Add plugin… from a folder or a git URL.
 */
export function PluginRows() {
  const { plugins, pluginError, pluginInstallNote, connection, pluginDialog } = useApp();
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const offline = connection !== "connected";
  const dialog = pluginDialog ? plugins?.find((p) => p.id === pluginDialog && p.status !== "broken") : undefined;
  return (
    <div className="wiz-plugins plugin-list" data-testid="plugins">
      <div className="wiz-section-row plugin-head">
        <div className="wiz-section">Plugins</div>
        <div className="wiz-btns">
          {!browsing && (
            <button className="btn ghost" data-testid="plugin-browse" disabled={offline} onClick={() => setBrowsing(true)}>
              <Search />
              Browse…
            </button>
          )}
          {!adding && (
            <button className="btn ghost" data-testid="plugin-add" disabled={offline} onClick={() => setAdding(true)}>
              <Plus />
              Add plugin…
            </button>
          )}
        </div>
      </div>
      {browsing && <BrowsePlugins offline={offline} onClose={() => setBrowsing(false)} />}
      {adding && <AddPlugin offline={offline} onClose={() => setAdding(false)} />}
      {!plugins?.length && !adding && <div className="wiz-sub">No plugins yet. A plugin adds tools for the agent, like a capture source or a generator.</div>}
      {plugins?.map((p) => (
        <PluginRow key={`${p.source}:${p.dir}`} plugin={p} offline={offline} />
      ))}
      {pluginInstallNote && (
        <div className="wiz-note warn" data-testid="plugin-install-note">
          <TriangleAlert />
          {pluginInstallNote}
        </div>
      )}
      {pluginError && (
        <div className="wiz-note error" data-testid="plugin-error">
          <TriangleAlert />
          {pluginError}
        </div>
      )}
      {dialog && <PluginApproval plugin={dialog} offline={offline} />}
    </div>
  );
}

/**
 * Browse… (D103): Uncut's plugin catalog (plugins/catalog in the repo, shipped with the app, off
 * by default), searchable. Enable copies one in and opens the approval dialog; Disable removes it.
 */
function BrowsePlugins({ offline, onClose }: { offline: boolean; onClose: () => void }) {
  const { pluginCatalog, pluginInstalling, plugins } = useApp();
  const [query, setQuery] = useState("");
  useEffect(() => {
    void actions.loadCatalog();
  }, [plugins]);
  const q = query.trim().toLowerCase();
  const all = pluginCatalog?.plugins ?? [];
  const shown = all.filter((e) => !q || [e.id, e.name, e.description, e.kind, ...(e.contributes ? [...e.contributes.looks, ...e.contributes.components, ...e.contributes.rules, ...(e.contributes.shaders ?? [])] : [])].some((v) => v.toLowerCase().includes(q)));
  const busy = offline || !!pluginInstalling;
  return (
    <div className="wiz-check plugin-browse" data-testid="plugin-browse-panel">
      <div className="wiz-sub">Plugins that come with Uncut and are off until you enable them. Each one asks before it's allowed.</div>
      {all.length > 0 && <input className="field input" data-testid="plugin-catalog-search" placeholder="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} />}
      {pluginCatalog && !all.length && <div className="wiz-sub">No plugins in the catalog yet.</div>}
      {shown.map((e) => (
        <div className="plugin-browse-row" key={e.id} data-testid="plugin-catalog-entry" data-id={e.id} data-enabled={e.enabled ? "true" : "false"}>
          <PluginIcon icon={e.icon} id={e.id} />
          <div className="grow">
            <div className="wiz-name">{e.name}</div>
            {e.description && <div className="wiz-sub">{e.description}</div>}
            <div className="plugin-browse-tags">
              {[e.contributes ? addsLine(e.contributes) : "", e.tools.length ? `Gives the agent ${e.tools.join(", ")}` : "", e.runs ? "Runs as a program" : "Runs no program"].filter(Boolean).join(". ")}
            </div>
          </div>
          {e.enabled ? (
            <button className="btn ghost" data-testid="plugin-catalog-disable" disabled={busy} onClick={() => void actions.disablePlugin(e.id)}>
              Disable
            </button>
          ) : (
            <button className="btn" data-testid="plugin-catalog-enable" disabled={busy} onClick={() => void actions.enablePlugin(e.id)}>
              Enable…
            </button>
          )}
        </div>
      ))}
      {q && all.length > 0 && !shown.length && <div className="wiz-sub">No plugin matches that.</div>}
      {pluginCatalog?.problems.map((p) => (
        <div key={p} className="wiz-sub error">
          {p}
        </div>
      ))}
      <div className="wiz-btns">
        <button className="link-btn" data-testid="plugin-browse-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Add plugin…: choose a folder, or paste a git URL (with an optional branch or tag). */
export function AddPlugin({ offline, onClose }: { offline: boolean; onClose: () => void }) {
  const { pluginInstalling, pluginInstallError } = useApp();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const busy = offline || !!pluginInstalling;
  const done = (ok: boolean) => ok && onClose();
  const fromUrl = async () => url.trim() && done(await actions.installPlugin({ source: url.trim(), ref: ref.trim() || undefined }));
  return (
    <div className="wiz-check" data-testid="plugin-add-panel">
      <div className="wiz-row">
        <FolderOpen />
        <div className="grow">
          <div className="wiz-name">From a folder on this Mac</div>
          <div className="wiz-sub">A folder with an uncut.module.json. Uncut copies it into its plugins folder.</div>
        </div>
        <button className="btn" data-testid="plugin-add-folder" disabled={busy} onClick={() => void actions.installPluginFolder().then(done)}>
          Choose folder…
        </button>
      </div>
      <div className="wiz-row">
        <GitBranch />
        <div className="grow plugin-git">
          <input
            className="field input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="Git URL (https://, ssh:// or git@host:path)"
            data-testid="plugin-add-url"
            value={url}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void fromUrl()}
          />
          <input
            className="field input plugin-ref"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="Branch or tag (optional)"
            data-testid="plugin-add-ref"
            value={ref}
            disabled={busy}
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void fromUrl()}
          />
        </div>
        <button className="btn" data-testid="plugin-add-install" disabled={busy || !url.trim()} onClick={() => void fromUrl()}>
          {pluginInstalling ? "Installing…" : "Install"}
        </button>
      </div>
      <div className="wiz-fix">
        <span>Installing doesn't run it: you see what it asks for and allow it next.</span>
        {pluginInstallError && (
          <span className="error" data-testid="plugin-install-error">
            {pluginInstallError.message}
          </span>
        )}
        <span className="wiz-btns">
          {pluginInstallError?.reason === "replaces-bundled" && (
            <button
              className="btn"
              data-testid="plugin-add-replace"
              disabled={busy}
              onClick={() => void actions.installPlugin({ source: pluginInstallError.source, ref: pluginInstallError.ref, replaceBundled: true }).then(done)}
            >
              Install it anyway
            </button>
          )}
          <button className="link-btn" data-testid="plugin-add-cancel" onClick={onClose}>
            Cancel
          </button>
        </span>
      </div>
    </div>
  );
}

/** What a plugin adds (D103), in words: "Text looks: Soft card. Components: Corner sticker. Checks: …". */
export const addsLine = (c: NonNullable<PluginInfo["contributes"]>) =>
  [c.looks.length ? `Text looks: ${c.looks.join(", ")}` : "", c.components.length ? `Components: ${c.components.join(", ")}` : "", c.rules.length ? `Checks: ${c.rules.join(", ")}` : "", c.filters?.length ? `Filters: ${c.filters.join(", ")}` : "", c.shaders?.length ? `Shader effects: ${c.shaders.join(", ")}` : "", c.skills?.length ? `Skills: ${c.skills.join(", ")}` : ""].filter(Boolean).join(". ");

/** Where a plugin came from, in words (the approval dialog and the row's tooltip). */
const originLines = (p: PluginInfo): Array<[string, string]> => {
  if (p.source === "bundled") return [["Source", "Ships with Uncut"]];
  if (p.origin?.kind === "git") return [["Source", p.origin.source], ...(p.origin.ref ? [["Branch or tag", p.origin.ref] as [string, string]] : []), ["Commit", p.origin.commit ?? "unknown"]];
  if (p.origin?.kind === "catalog") return [["Source", "Uncut's plugin catalog"]];
  if (p.origin?.kind === "folder") return [["Source", `Copied from ${p.origin.source}`]];
  return [["Source", `The folder ${p.dir}`]];
};

/** Allowing a plugin (D97): where it came from, what it asks for, and that it runs with your rights. */
export function PluginApproval({ plugin: p, offline }: { plugin: PluginInfo; offline: boolean }) {
  const [rights, ...rest] = p.asks;
  // Above Settings (itself a modal), outside its scrolling list.
  return createPortal(
    <div className="modal-layer plugin-approval-layer" data-testid="plugin-dialog" onMouseDown={(e) => e.target === e.currentTarget && actions.openPluginDialog(undefined)}>
      <div className="modal plugin-approval" role="dialog" aria-label={`Allow ${p.name}?`}>
        <h2>Allow {p.name}?</h2>
        <div className="plugin-facts">
          {[...originLines(p), ["Id", p.id] as [string, string], ...(p.version ? [["Version", p.version] as [string, string]] : []), ["Tools for the agent", p.tools.length ? p.tools.join(", ") : "None"] as [string, string], ...(p.contributes ? [["Adds", addsLine(p.contributes)] as [string, string]] : [])].map(([k, v]) => (
            <div className="plugin-fact" key={k} data-testid={`plugin-dialog-${k.toLowerCase().replace(/\W+/g, "-")}`}>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </div>
          ))}
        </div>
        <div className="plugin-asks" data-testid="plugin-dialog-asks">
          {rest.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {p.capabilities.length === 0 && <p>It doesn't ask for any capabilities.</p>}
        </div>
        {rights && (
          <div className="wiz-note warn" data-testid="plugin-dialog-rights">
            <TriangleAlert />
            {rights}
          </div>
        )}
        <div className="wiz-btns">
          <button className="btn ghost" data-testid="plugin-dialog-cancel" onClick={() => actions.openPluginDialog(undefined)}>
            Not now
          </button>
          <button className="btn primary" data-testid="plugin-dialog-allow" disabled={offline} onClick={() => void actions.approvePlugin(p)}>
            Allow
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A plugin's one-line summary (#100, D272): a short sentence, not every tool and skill. Skills are
 * counted ("10 editing skills"); otherwise the description's first sentence, cut at a clause when
 * it runs long; otherwise what it adds, counted. The full lists are in the row's details.
 */
export const pluginSummary = (p: Pick<PluginInfo, "description" | "tools" | "contributes">): string => {
  const skills = p.contributes?.skills?.length ?? 0;
  if (skills && !p.tools.length) return `${skills} editing skill${skills === 1 ? "" : "s"}. Type / in the composer to use one`;
  const first = p.description?.trim().split(/(?<=[.!?])\s/)[0]?.replace(/[.!?]$/, "");
  if (first) {
    if (first.length <= 72) return first;
    const cut = first.lastIndexOf(", ", 72);
    return cut > 24 ? first.slice(0, cut) : first;
  }
  const c = p.contributes;
  const n = (k: number, one: string, many = `${one}s`) => (k ? `${k} ${k === 1 ? one : many}` : "");
  const parts = [n(p.tools.length, "agent tool"), n(c?.looks.length ?? 0, "text look"), n(c?.components.length ?? 0, "component"), n(c?.rules.length ?? 0, "check"), n(c?.filters?.length ?? 0, "filter"), n(c?.shaders?.length ?? 0, "shader effect"), n(skills, "skill")].filter(Boolean);
  return parts.length ? `Adds ${parts.join(", ")}` : "No agent tools";
};

/** "Launch promo (/launch-promo)" as its title and command. */
const skillParts = (s: string): [string, string] => {
  const m = /^(.*) \((\/[^)]+)\)$/.exec(s);
  return m ? [m[1]!, m[2]!] : [s, ""];
};

function PluginRow({ plugin: p, offline }: { plugin: PluginInfo; offline: boolean }) {
  const [open, setOpen] = useState(false);
  const from = p.source === "bundled" ? "Ships with Uncut" : p.origin?.kind === "git" ? `From ${p.origin.source}${p.origin.commit ? ` at ${p.origin.commit.slice(0, 7)}` : ""}` : p.origin?.kind === "catalog" ? "From Uncut's catalog" : p.origin ? `Copied from ${p.origin.source}` : `From ${p.dir}`;
  const broken = p.status === "broken";
  const summary = broken ? "Skipped" : pluginSummary(p);
  const skills = p.contributes?.skills ?? [];
  const adds = p.contributes ? addsLine({ ...p.contributes, skills: [] }) : "";
  return (
    <div className="wiz-check plugin-row" data-testid={broken ? `plugin-skipped-${p.id}` : `plugin-${p.id}`} data-status={p.status}>
      <div className="wiz-row">
        <PluginIcon icon={broken ? undefined : p.icon} id={p.id} />
        <div className="grow">
          <div className="wiz-name">
            {p.name}
            {p.version && <span className="plugin-version">{p.version}</span>}
          </div>
          <div className="wiz-sub plugin-summary" data-testid={`plugin-summary-${p.id}`} title={summary}>
            {summary}
          </div>
        </div>
        <div className="plugin-status">
          {p.status === "ready" ? (
            <span className="wiz-chip ok" data-testid={`plugin-chip-${p.id}`}>
              <Check />
              Allowed
            </span>
          ) : broken ? (
            <span className="wiz-chip error" data-testid={`plugin-chip-${p.id}`}>
              <CircleAlert />
              Not loaded
            </span>
          ) : (
            <button className="btn primary" data-testid={`plugin-allow-${p.id}`} disabled={offline} onClick={() => actions.openPluginDialog(p.id)}>
              Allow…
            </button>
          )}
        </div>
        {!broken && (
          <Tooltip label={open ? "Hide details" : "Show details"}>
            <button className={`icon-btn plugin-more${open ? " open" : ""}`} data-testid={`plugin-more-${p.id}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <ChevronDown />
            </button>
          </Tooltip>
        )}
      </div>
      {!broken && (
        <div className="plugin-details" data-testid={`plugin-details-${p.id}`} hidden={!open}>
          {p.description && p.description.trim() !== summary && <p>{p.description}</p>}
          {skills.length > 0 && (
            <ul className="plugin-skills">
              {skills.map((s) => {
                const [title, command] = skillParts(s);
                return (
                  <li key={s}>
                    <span>{title}</span>
                    {command && <code>{command}</code>}
                  </li>
                );
              })}
            </ul>
          )}
          {p.tools.length > 0 && (
            <div className="plugin-fact-line">
              <span className="k">Gives the agent</span> <code>{p.tools.join(", ")}</code>
            </div>
          )}
          {adds && <div className="plugin-fact-line">{adds}</div>}
          <div className="plugin-fact-line" title={p.dir}>
            {from}
          </div>
        </div>
      )}
      {(p.status === "needs-approval" || p.problem || p.warnings.length > 0) && (
        <div className="wiz-fix" data-testid={`plugin-detail-${p.id}`}>
          {p.problem && <span>{p.problem}</span>}
          {p.status === "needs-approval" && p.asks.map((line) => <span key={line}>{line}</span>)}
          {p.warnings.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      )}
      {((p.status === "ready" && p.source === "user") || p.removable) && (
        <div className="wiz-fix wiz-actions">
          {p.status === "ready" && p.source === "user" && (
            <button className="link-btn" data-testid={`plugin-revoke-${p.id}`} disabled={offline} onClick={() => void actions.revokePlugin(p.id)}>
              Stop allowing it
            </button>
          )}
          {p.removable && (
            <button className="link-btn" data-testid={`plugin-remove-${p.id}`} disabled={offline} onClick={() => void actions.uninstallPlugin(p.id)}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
