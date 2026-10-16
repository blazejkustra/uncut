// The preview's loudness (D246): As mixed (the levels as they are), or At target, where the preview
// plays the gain the export's loudness step would give the mix for the project's target (the
// server runs the export's own measuring passes: export.loudness). The gain goes on the master
// before the limiter, where the export puts it (audio.ts). Measured again ~1.5 s after the mix
// changes while At target is on; until then the last gain plays. The choice is this viewer's
// (localStorage), not the project's.
import { useEffect, useSyncExternalStore } from "react";
import { projectTargetLufs } from "@uncut/core/effects";

import type { ProjectModel } from "../state/project.ts";
import { call } from "../state/store/server.ts";
import { useApp } from "../state/store.ts";

export interface LoudnessPreview {
  readonly atTarget: boolean;
  readonly measuring: boolean;
  /** The export's gain for the target (dB), for the mix measured last. */
  readonly gainDb?: number;
  /** That mix's integrated loudness (LUFS) and the target it was measured for. */
  readonly lufs?: number;
  readonly targetLufs?: number;
  readonly problem?: string;
}

const STORE_KEY = "uncut.previewAtTarget";
// D273: At target unless this viewer chose As mixed ("0" stored).
const readChoice = () => {
  try {
    return localStorage.getItem(STORE_KEY) !== "0";
  } catch {
    return true;
  }
};
let state: LoudnessPreview = { atTarget: readChoice(), measuring: false };
const listeners = new Set<() => void>();
const emit = (next: LoudnessPreview) => {
  state = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useLoudnessPreview = () => useSyncExternalStore(subscribe, () => state);
export const getLoudnessPreview = () => state;

/** Switch the preview between As mixed and At target. */
export function setPreviewAtTarget(atTarget: boolean) {
  try {
    localStorage.setItem(STORE_KEY, atTarget ? "1" : "0");
  } catch {
    // A private window: the choice lasts this session.
  }
  emit({ ...state, atTarget });
}

/** The linear gain the preview's master adds now (1 when As mixed or not measured yet). */
export function previewLoudnessGain(): number {
  return state.atTarget && state.gainDb !== undefined ? 10 ** (state.gainDb / 20) : 1;
}

/** What the export's loudness depends on: the master and every track that can sound (text edits don't re-measure). */
const mixKey = (project: ProjectModel) => JSON.stringify([project.master ?? null, project.tracks.filter((t) => t.kind !== "text").map((t) => [t.id, t.mixer ?? null, t.items])]);
const DEBOUNCE_MS = 1500;

/** Keeps the At target gain measured for the open project (mounted with the ducking loader). */
export function useLoudnessMeasuring(project: ProjectModel, envelopesKey: string) {
  const { connection } = useApp();
  const online = connection === "connected";
  const atTarget = useLoudnessPreview().atTarget;
  const target = projectTargetLufs(project);
  const key = `${target}|${envelopesKey}|${mixKey(project)}`;
  useEffect(() => {
    if (!online || !atTarget) return;
    let gone = false;
    const timer = setTimeout(() => {
      emit({ ...state, measuring: true, problem: undefined });
      void call((c) => c["export.loudness"]({ targetLufs: target }), 300000).then((r) => {
        if (gone) return;
        if (!r.ok) return emit({ ...state, measuring: false, problem: (r.error as { message?: string }).message ?? "Couldn't measure the loudness" });
        if (r.value.cancelled) return;
        const { gainDb, lufs } = r.value;
        emit({ atTarget: state.atTarget, measuring: false, targetLufs: target, ...(gainDb !== undefined ? { gainDb } : {}), ...(lufs !== undefined ? { lufs } : {}) });
      });
    }, DEBOUNCE_MS);
    return () => {
      gone = true;
      clearTimeout(timer);
      if (state.measuring) emit({ ...state, measuring: false });
    };
  }, [online, atTarget, key]);
}
