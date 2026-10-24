// Settings, Environments (Phase 9, D106): where the server runs. Local is this Mac; a remote is an
// uncut-server on another machine, added with its address and token (or the pairing line it
// prints), tested before it's saved. Switching reloads the window into the other environment, so
// one environment's projects never show in another. "Connect over SSH" only shows commands (D111).
import { Check, CircleAlert, Copy, Laptop, Pencil, Plus, RefreshCw, Server, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import type { EnvironmentInfo, EnvironmentTest } from "../state/bridge.ts";
import { NOT_ENCRYPTED, notEncrypted } from "../state/remoteUrl.ts";
import { sshCommands, validSshTarget } from "../state/ssh.ts";
import { actions, useApp } from "../state/store.ts";
import { environmentsUsable, LABS_HINT, useFlag } from "../settings/labs.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import "../settings/labs.css";

/** D245: Environments can be opened (the Labs flag is on, or a remote is active: the way back). */
export function useEnvironmentsUsable() {
  const { environment } = useApp();
  return environmentsUsable(useFlag("environments"), environment.kind);
}

/** The hint on a disabled Environments entry point (D245). */
export const ENVIRONMENTS_LABS_HINT = `Environments is a Labs feature, off by default. ${LABS_HINT}.`;

export function Environments() {
  const { environments, environment, connection, environmentProblem } = useApp();
  const [adding, setAdding] = useState(false);
  const [ssh, setSsh] = useState(false);
  const [prefill, setPrefill] = useState<string | undefined>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      actions.closeEnvironments();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const list = environments ?? [environment];
  // D245: with the Labs flag off (opened only to leave an active remote) nothing new is added.
  const flag = useFlag("environments");
  return (
    <div className="modal-layer" data-testid="environments">
      <div className="modal wiz">
        <div className="wiz-header row">
          <div className="wiz-brand">Environments</div>
          <Tooltip label="Close" keys={["Esc"]}>
            <button className="icon-btn" data-testid="environments-close" onClick={actions.closeEnvironments}>
              <X />
            </button>
          </Tooltip>
        </div>
        <div className="wiz-panel">
          <p className="wiz-lead">
            Where Uncut's server runs: this Mac, or another machine with uncut-server. Projects, footage, exports, the agent and plugins stay on that machine;
            this window edits them there.
          </p>
          <div className="wiz-list">
            {list.map((env) => (
              <EnvironmentRow
                key={env.id}
                env={env}
                active={env.id === environment.id}
                state={env.id === environment.id ? connection : undefined}
                problem={env.id === environment.id ? environmentProblem : undefined}
              />
            ))}
          </div>
          {adding ? (
            <AddEnvironment prefillUrl={prefill} onDone={() => (setAdding(false), setPrefill(undefined))} />
          ) : ssh ? (
            <SshHelper
              onClose={() => setSsh(false)}
              onUse={(url) => {
                setSsh(false);
                setPrefill(url);
                setAdding(true);
              }}
            />
          ) : (
            <div className="wiz-btns env-actions">
              {!flag && (
                <span className="muted small" data-testid="env-labs-note">
                  {ENVIRONMENTS_LABS_HINT}
                </span>
              )}
              <button className="btn" data-testid="env-add" disabled={!flag} title={flag ? undefined : ENVIRONMENTS_LABS_HINT} onClick={() => setAdding(true)}>
                <Plus />
                Add environment…
              </button>
              <button
                className="btn ghost"
                data-testid="env-ssh"
                disabled={!flag}
                title={flag ? undefined : ENVIRONMENTS_LABS_HINT}
                onClick={() => setSsh(true)}
              >
                <SquareTerminal />
                Connect over SSH…
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function stateText(state: string | undefined, problem: string | undefined) {
  if (state === "connected") return { text: "Connected", cls: "ok" };
  if (state === "failed" || state === "server-exited") return { text: "Not available", cls: "error" };
  if (problem) return { text: "Can't connect", cls: "error" };
  if (state === "reconnecting") return { text: "Reconnecting…", cls: "warn" };
  if (state === "connecting") return { text: "Connecting…", cls: "warn" };
  return undefined;
}

function EnvironmentRow({ env, active, state, problem }: { env: EnvironmentInfo; active: boolean; state: string | undefined; problem: string | undefined }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(env.name);
  const [test, setTest] = useState<EnvironmentTest | "testing" | undefined>();
  const chip = active ? stateText(state, problem) : undefined;
  return (
    <div className="wiz-check" data-testid="env-row" data-id={env.id} data-kind={env.kind} data-active={active ? "true" : "false"}>
      <div className="wiz-row">
        {env.kind === "local" ? <Laptop /> : <Server />}
        <div className="grow">
          {renaming ? (
            <form
              className="env-rename"
              onSubmit={(e) => {
                e.preventDefault();
                void actions.renameEnvironment(env.id, name).then(() => setRenaming(false));
              }}
            >
              <input className="field input" data-testid="env-rename-input" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
              <button className="btn" type="submit" data-testid="env-rename-save" disabled={!name.trim()}>
                Save
              </button>
            </form>
          ) : (
            <div className="wiz-name" data-testid="env-name">
              {env.name}
            </div>
          )}
          <div className="wiz-sub ellipsis">{env.kind === "local" ? "The server Uncut starts on this Mac" : env.url}</div>
          {env.url && notEncrypted(env.url) && (
            <div className="wiz-sub warn" data-testid="env-insecure">
              {NOT_ENCRYPTED}
            </div>
          )}
          {active && problem && state !== "connected" && (
            <div className="wiz-sub error" data-testid="env-problem">
              {problem}
            </div>
          )}
          {test && test !== "testing" && (
            <div className={`wiz-sub ${test.ok ? "ok" : "error"}`} data-testid="env-test-result">
              {test.ok ? `Reachable: ${test.hostname}, server v${test.version}` : test.message}
            </div>
          )}
        </div>
        {chip && (
          <span className={`wiz-chip ${chip.cls}`} data-testid="env-state">
            {chip.cls === "ok" ? <Check /> : <CircleAlert />}
            {chip.text}
          </span>
        )}
        {env.kind === "remote" && !renaming && (
          <>
            <Tooltip label="Test the connection">
              <button
                className="icon-btn"
                data-testid="env-test"
                disabled={test === "testing"}
                onClick={() => (setTest("testing"), void actions.testEnvironment({ id: env.id }).then(setTest))}
              >
                <RefreshCw className={test === "testing" ? "spin" : ""} />
              </button>
            </Tooltip>
            <Tooltip label="Rename">
              <button className="icon-btn" data-testid="env-rename" onClick={() => (setName(env.name), setRenaming(true))}>
                <Pencil />
              </button>
            </Tooltip>
            <button
              className="icon-btn"
              title="Remove from this Mac (the server and its projects stay as they are)"
              data-testid="env-remove"
              onClick={() => void actions.removeEnvironment(env.id)}
            >
              <Trash2 />
            </button>
          </>
        )}
        {!active && (
          <button className="btn" data-testid="env-switch" onClick={() => void actions.switchEnvironment(env.id)}>
            Switch
          </button>
        )}
      </div>
    </div>
  );
}

function AddEnvironment({ prefillUrl, onDone }: { prefillUrl: string | undefined; onDone: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState(prefillUrl ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | undefined>();
  // The pairing line (uncut://pair?url=…&token=…) carries both: the token field isn't needed then.
  const pairing = /^\s*uncut:\/\/pair\?/i.test(url);
  const input = () => ({ name: name.trim(), url: url.trim(), token: pairing ? "" : token.trim() });
  const test = async () => {
    setBusy(true);
    const r = await actions.testEnvironment(input());
    setBusy(false);
    setResult(r.ok ? { ok: true, text: `Reachable: ${r.hostname}, server v${r.version}` } : { ok: false, text: r.message });
    return r;
  };
  const save = async () => {
    const r = await test();
    if (!r.ok) return;
    setBusy(true);
    const problem = await actions.addEnvironment({ ...input(), name: name.trim() || r.hostname });
    setBusy(false);
    if (problem) return setResult({ ok: false, text: problem });
    onDone();
  };
  return (
    <form
      className="wiz-list env-add"
      data-testid="env-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="wiz-section">Add an environment</div>
      <div className="wiz-sub">Start uncut-server on the other machine; it prints its address and a token, or one line with both. Paste them here.</div>
      <label className="wiz-field">
        <span>Name</span>
        <input data-testid="env-add-name" placeholder="Studio Mac" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} spellCheck={false} />
      </label>
      <label className="wiz-field">
        <span>Address</span>
        <input
          data-testid="env-add-url"
          placeholder="http://studio.local:8790, or the uncut://pair line"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
          autoFocus
        />
      </label>
      {!pairing && (
        <label className="wiz-field">
          <span>Token</span>
          <input data-testid="env-add-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} />
        </label>
      )}
      {notEncrypted(url) && (
        <div className="wiz-note warn" data-testid="env-add-insecure">
          <CircleAlert />
          {NOT_ENCRYPTED}
        </div>
      )}
      {result && (
        <div className={`wiz-note ${result.ok ? "ok" : "error"}`} data-testid="env-add-result" data-ok={result.ok ? "true" : "false"}>
          {result.ok ? <Check /> : <CircleAlert />}
          {result.text}
        </div>
      )}
      <div className="wiz-btns env-actions">
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          data-testid="env-add-test"
          disabled={busy || !url.trim() || (!pairing && !token.trim())}
          onClick={() => void test()}
        >
          Test connection
        </button>
        <button type="submit" className="btn primary" data-testid="env-add-save" disabled={busy || !url.trim() || (!pairing && !token.trim())}>
          Add
        </button>
      </div>
    </form>
  );
}

function SshHelper({ onClose, onUse }: { onClose: () => void; onUse: (url: string) => void }) {
  const [target, setTarget] = useState("");
  const [remotePort, setRemotePort] = useState("8790");
  const [localPort, setLocalPort] = useState("8790");
  const rp = Number(remotePort);
  const lp = Number(localPort);
  const ok = validSshTarget(target.trim()) && Number.isInteger(rp) && rp > 0 && rp < 65536 && Number.isInteger(lp) && lp > 1023 && lp < 65536;
  const cmds = ok ? sshCommands({ target: target.trim(), remotePort: rp, localPort: lp }) : undefined;
  return (
    <div className="wiz-list env-add" data-testid="env-ssh-panel">
      <div className="wiz-section">Connect over SSH</div>
      <div className="wiz-sub">
        For a Mac you can ssh into that has Uncut installed. Its server listens only on that Mac; the tunnel brings it here. Uncut doesn't run these for you.
      </div>
      <label className="wiz-field">
        <span>Host</span>
        <input
          data-testid="ssh-target"
          placeholder="you@studio.local"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          spellCheck={false}
          autoFocus
        />
      </label>
      <div className="env-ports">
        <label className="wiz-field">
          <span>There</span>
          <input data-testid="ssh-remote-port" inputMode="numeric" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} />
        </label>
        <label className="wiz-field">
          <span>Here</span>
          <input data-testid="ssh-local-port" inputMode="numeric" value={localPort} onChange={(e) => setLocalPort(e.target.value)} />
        </label>
      </div>
      {target.trim() && !ok && <div className="wiz-sub error">Use a host like you@studio.local, and ports from 1024 to 65535.</div>}
      {cmds && (
        <>
          <div className="wiz-sub">1. Start the server there (leave it running; it prints the token):</div>
          <Command id="ssh-start" text={cmds.start} />
          <div className="wiz-sub">2. In another Terminal window, open the tunnel:</div>
          <Command id="ssh-tunnel" text={cmds.tunnel} />
          <div className="wiz-sub">3. Add {cmds.url} with that token.</div>
        </>
      )}
      <div className="wiz-btns env-actions">
        <button type="button" className="btn ghost" data-testid="ssh-close" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn primary" data-testid="ssh-use" disabled={!cmds} onClick={() => cmds && onUse(cmds.url)}>
          Add {cmds?.url ?? "the tunnel"}…
        </button>
      </div>
    </div>
  );
}

function Command({ id, text }: { id: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="wiz-cmd">
      <code data-testid={id} title={text}>
        {text}
      </code>
      <button className="icon-btn" title="Copy" onClick={() => void actions.copy(text).then(() => setCopied(true))}>
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

/** The environment's name and state, for the title bar and the welcome card; opens Environments. */
export function EnvironmentChip() {
  const { environment, connection, environmentProblem } = useApp();
  const state =
    connection === "connected" ? "connected" : connection === "failed" || connection === "server-exited" || environmentProblem ? "error" : "connecting";
  const usable = useEnvironmentsUsable();
  const chip = (
    <button
      className="env-chip"
      data-testid="env-chip"
      data-kind={environment.kind}
      data-state={state}
      disabled={!usable}
      title={
        usable
          ? (environmentProblem ?? (environment.kind === "remote" ? `On ${environment.url ?? environment.name}. Click for Environments.` : "Environments"))
          : undefined
      }
      onClick={() => void actions.openEnvironments()}
    >
      <span className="dot" />
      {environment.kind === "remote" ? <Server /> : <Laptop />}
      {environment.name}
    </button>
  );
  // A disabled button gets no hover, so the Labs hint sits on a wrapper (LabsTip).
  return usable ? chip : <LabsTip>{chip}</LabsTip>;
}

/** The Labs hint on a control that's disabled because Environments is off in Settings › Labs. */
export function LabsTip({ children }: { children: ReactElement }) {
  return (
    <Tooltip label={ENVIRONMENTS_LABS_HINT}>
      <span className="labs-tip" data-testid="labs-tip">
        {children}
      </span>
    </Tooltip>
  );
}
