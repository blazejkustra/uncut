// How the text Inspector edits (D129): every change goes to the selected text and, with several
// texts selected (⌘-click, marquee), to each of them, as one edit (planMany: one ⌘Z). preview()
// drafts it in the canvas while a control moves; commit() sends it once (dropping that draft).
import type { Item } from "@uncut/core/types";
import { useRef } from "react";

import { findItem, type Plan } from "../../timeline/edit.ts";
import { usePlayback, type PreviewDraft } from "../../preview/playback.ts";
import { type ProjectModel } from "../../state/project.ts";
import { planMany } from "../../preview/text.ts";
import { send, showDraft } from "../fields.tsx";

type Make = (project: ProjectModel, id: string) => Plan | { readonly problem: string };

export function useTextEdit(project: ProjectModel, item: Item) {
  const also = usePlayback((s) => s.also);
  // Others selected with it, of the same kind (text with text, captions with captions).
  const ids = [item.id, ...also.filter((id) => id !== item.id && findItem(project, id)?.item.type === item.type)];
  const draft = useRef<PreviewDraft | undefined>(undefined);
  return {
    ids,
    /** Draft a change in the preview (a slider moving, a colour streaming). */
    preview(make: Make) {
      draft.current = showDraft(project, planMany(project, ids, make)) ?? draft.current;
    },
    /** Send a change as one edit; any draft goes once it's applied. */
    commit(make: Make) {
      const d = draft.current;
      draft.current = undefined;
      send((p) => planMany(p, ids, make), d);
    },
  };
}
export type TextEdit = ReturnType<typeof useTextEdit>;
