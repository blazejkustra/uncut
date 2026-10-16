import type { BrandScope } from "@uncut/contracts";
import { ChevronLeft, Trash2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { SCOPE_CHOICE } from "./kit.ts";
import { Tooltip } from "../../ui/Tooltip.tsx";

export function Swatches({ hexes }: { hexes: ReadonlyArray<string> }) {
  return (
    <span className="brand-swatches">
      {hexes.slice(0, 12).map((hex, i) => (
        <span key={i} className="brand-swatch" style={{ background: hex }} title={hex} />
      ))}
    </span>
  );
}

export function ScopeChoice({ value, onChange, hasProject, testId }: { value: BrandScope; onChange: (scope: BrandScope) => void; hasProject: boolean; testId: string }) {
  return (
    // A segmented choice, not chips (D263).
    <div className="seg brand-scope" role="radiogroup" aria-label="Where it's kept">
      {(["global", "project"] as const).map((s) => (
        <button key={s} className={value === s ? "active" : ""} role="radio" aria-checked={value === s} data-testid={`${testId}-${s}`} disabled={s === "project" && !hasProject} onClick={() => onChange(s)}>
          {SCOPE_CHOICE[s]}
        </button>
      ))}
    </div>
  );
}

/** The editor's frame: back, the body, Save, Cancel and Delete; Esc drops the draft. */
export function EditorFrame({ title, testId, children, onClose, onSave, onDelete, saveDisabled, problem }: { title: string; testId: string; children: React.ReactNode; onClose: () => void; onSave: () => void; onDelete?: (() => void) | undefined; saveDisabled: boolean; problem?: string | undefined }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div
      className="brand-editor"
      data-testid={testId}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (confirm) setConfirm(false);
        else onClose();
      }}
    >
      <div className="brand-editor-head">
        <Tooltip label="Back">
          <button className="icon-btn" data-testid="brand-back" onClick={onClose}>
            <ChevronLeft />
          </button>
        </Tooltip>
        <span className="ellipsis">{title}</span>
      </div>
      <div className="brand-body">{children}</div>
      <div className="brand-foot">
        {problem && <div className="brand-problem small" data-testid="brand-problem">{problem}</div>}
        {onDelete && (
          <button className="btn ghost" data-testid="brand-delete" onClick={() => setConfirm(true)}>
            <Trash2 />
            Delete
          </button>
        )}
        <span className="brand-foot-gap" />
        <button className="btn ghost" data-testid="brand-cancel" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" data-testid="brand-save" disabled={saveDisabled} onClick={onSave}>
          Save
        </button>
      </div>
      {confirm && onDelete && (
        <div className="modal-layer" data-testid="brand-delete-modal">
          <div className="modal confirm-modal">
            <div className="confirm-title">Delete {title}?</div>
            <div className="confirm-text">It goes from every project that uses it.</div>
            <div className="confirm-actions">
              <button className="btn ghost" data-testid="brand-delete-cancel" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                data-testid="brand-delete-confirm"
                onClick={() => {
                  setConfirm(false);
                  onDelete();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
