import type { KeyProvider } from "@uncut/contracts";
import { useState } from "react";
import { actions, useApp } from "../../state/store.ts";

/**
 * A missing key or client ID, pasted right here (D99: it goes to the server once, is kept in the
 * Keychain and never comes back), as the Generate tab does. Used for Freesound and ElevenLabs (D250).
 */
export function KeyRow({ provider, text, placeholder, link }: { provider: KeyProvider; text: string; placeholder: string; link?: { readonly href: string; readonly label: string } | undefined }) {
  const app = useApp();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!key.trim()) return;
    setSaving(true);
    const ok = await actions.setKey(provider, key.trim());
    setSaving(false);
    if (ok) setKey("");
  };
  return (
    <div className="lib-key small" data-testid={`key-needed-${provider}`}>
      <span>
        {text}
        {link && (
          <>
            {" "}
            <a href={link.href} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          </>
        )}
      </span>
      <div className="lib-key-row">
        <input
          className="field input"
          type="password"
          data-testid={`lib-key-input-${provider}`}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <button className="btn" data-testid={`lib-key-save-${provider}`} disabled={!key.trim() || saving || app.connection !== "connected"} onClick={() => void save()}>
          Save
        </button>
      </div>
      {app.keysError && <div className="inline-error small">{app.keysError}</div>}
      <button className="link-btn" onClick={() => actions.openKeys()}>
        Settings › Keys
      </button>
    </div>
  );
}
