// Templates in the Skills tab (issue #111): Uncut's built-ins read-only (Use in chat, Duplicate) and
// the user's own (edit, delete), saved as Markdown files in the app's data folder. Use in chat fills
// the template from the open project and puts the brief in the composer, like the / menu does.
import type { TemplateInfo } from "@uncut/contracts";
import { TEMPLATE_SYNTAX, templateId } from "@uncut/core/templates";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";

import { actions } from "../../state/store.ts";
import { EditorFrame } from "../brand/parts.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";

export interface TemplateDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/** A row in the Templates section. */
export function TemplateRow({ t, onOpen }: { t: TemplateInfo; onOpen: (t: TemplateInfo) => void }) {
  return (
    <button className="brand-row" data-testid={`template-${t.id}`} onClick={() => onOpen(t)}>
      <span className="brand-row-top">
        <span className="brand-row-name ellipsis">{t.name}</span>
        {!t.builtin && <span className="brand-tag">Yours</span>}
      </span>
      {t.description && <span className="brand-desc">{t.description}</span>}
    </button>
  );
}

/** One of the user's templates, new or existing. */
export function TemplateEditor({
  id,
  draft,
  templates,
  online,
  onDraft,
  onClose,
}: {
  id: string | undefined;
  draft: TemplateDraft;
  templates: ReadonlyArray<TemplateInfo>;
  online: boolean;
  onDraft: (d: TemplateDraft) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TemplateDraft>) => onDraft({ ...draft, ...patch });
  const save = async () => {
    if (!draft.name.trim()) return;
    setBusy(true);
    const tid =
      id ??
      templateId(
        draft.name,
        templates.map((t) => t.id),
      );
    const ok = await actions.templatesSave({ id: tid, name: draft.name.trim(), description: draft.description.trim(), body: draft.body });
    setBusy(false);
    if (ok) onClose();
  };
  const remove = async () => {
    if (!id) return;
    setBusy(true);
    const ok = await actions.templatesDelete(id);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <EditorFrame
      title={draft.name.trim() || "New template"}
      testId="template-editor"
      onClose={onClose}
      onSave={() => void save()}
      onDelete={id ? () => void remove() : undefined}
      saveDisabled={!online || busy || !draft.name.trim()}
    >
      <div className="lib-section">
        <span className="lib-label">Name</span>
        <input
          className="field input"
          data-testid="template-name"
          autoFocus={!id}
          maxLength={80}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <span className="lib-label">Description</span>
        <input
          className="field input"
          data-testid="template-description"
          maxLength={300}
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
        />
        <span className="lib-label">Brief</span>
        <div className="template-syntax" data-testid="template-syntax">
          {TEMPLATE_SYNTAX}
        </div>
        <textarea
          className="gen-prompt brand-text brand-mono"
          data-testid="template-body"
          spellCheck={false}
          value={draft.body}
          onChange={(e) => set({ body: e.target.value })}
        />
      </div>
    </EditorFrame>
  );
}

/** A template to read: Use in chat, Duplicate (a built-in is read-only), Edit for the user's own. */
export function TemplateView({
  t,
  online,
  hasProject,
  onDuplicate,
  onEdit,
  onClose,
}: {
  t: TemplateInfo | undefined;
  online: boolean;
  hasProject: boolean;
  onDuplicate: (t: TemplateInfo) => void;
  onEdit: (t: TemplateInfo) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="brand-editor"
      data-testid="template-view"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="brand-editor-head">
        <Tooltip label="Back">
          <button className="icon-btn" data-testid="brand-back" onClick={onClose}>
            <ChevronLeft />
          </button>
        </Tooltip>
        <span className="ellipsis">{t?.name ?? "Template"}</span>
        <span className="brand-tag">{t?.builtin ? "Template" : "Yours"}</span>
      </div>
      <div className="brand-body">
        <div className="lib-section">
          {t?.description && <div className="brand-desc">{t.description}</div>}
          <div className="muted small">
            {t?.builtin ? "Uncut's own, read-only; duplicate it to change it. " : "Yours, saved as a Markdown file in Uncut's data folder. "}
            Use in chat fills it from this project (media, brand kit, song, canvas, length) and puts the brief in the chat for you to edit before sending.
          </div>
          <pre className="brand-skill-read selectable" data-testid="template-view-body">
            {t?.body ?? ""}
          </pre>
        </div>
      </div>
      <div className="brand-foot">
        <button className="btn ghost" data-testid="template-duplicate" disabled={!online || !t} onClick={() => t && onDuplicate(t)}>
          Duplicate
        </button>
        {t && !t.builtin && (
          <button className="btn ghost" data-testid="template-edit" disabled={!online} onClick={() => onEdit(t)}>
            Edit
          </button>
        )}
        <span className="brand-foot-gap" />
        <button className="btn ghost" data-testid="brand-cancel" onClick={onClose}>
          Close
        </button>
        <button
          className="btn primary"
          data-testid="template-use"
          disabled={!t || !hasProject || !online}
          title={hasProject ? undefined : "Open a project to use the agent"}
          onClick={() => t && void actions.useTemplate(t.id)}
        >
          Use in chat
        </button>
      </div>
    </div>
  );
}
