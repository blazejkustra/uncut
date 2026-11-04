// D328: the Inspector's vision controls: how far a clip's matte or faces are ("Removing background
// 40%", or the module's own sentence when there's none here), face blur's "only these faces" picks,
// Auto reframe (one edit, made on the server) and Text behind subject (one edit).
import { CUTOUT, FACE_BLUR, clipFx, planEffect } from "@uncut/core/fx";
import { faceList, type FaceFrames } from "@uncut/core/vision";
import { planTextBehindSubject } from "@uncut/core/visionPlans";
import type { Item } from "@uncut/core/types";
import { useEffect, useState } from "react";

import { visionNote, visionStateOf } from "../preview/vision.ts";
import { type ProjectModel } from "../state/project.ts";
import { actions, useAppSelect, visionUrl } from "../state/store.ts";
import { send } from "./fields.tsx";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** A cutout's or face blur's state under its rows, while it's being made or when it can't be. */
export function VisionStatus({ project, item, module }: { project: ProjectModel; item: Item; module: string }) {
  useAppSelect((s) => s.proxies);
  const fx = clipFx(item, project.luts);
  if (!fx) return null;
  const output = module === CUTOUT ? "matte" : "faces";
  const note = visionNote(visionStateOf(project, item, output, fx), output);
  if (!note) return null;
  return (
    <div className="muted small" data-testid="insp-vision-status" data-output={output}>
      {note}
    </div>
  );
}

/** The faces a clip's face blur found, each a switch: none picked blurs every face. */
export function FacePicker({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  useAppSelect((s) => s.proxies);
  const fx = clipFx(item, project.luts);
  const state = fx ? visionStateOf(project, item, "faces", fx) : undefined;
  const url = state?.phase === "done" && state.key && item.media ? visionUrl(item.media, `${state.key}.json`) : undefined;
  const [faces, setFaces] = useState<FaceFrames | undefined>(undefined);
  useEffect(() => {
    setFaces(undefined);
    if (!url) return;
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<FaceFrames>) : undefined))
      .then((f) => live && setFaces(f))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  if (!faces || !fx?.faceBlur) return null;
  const found = faceList(faces);
  if (!found.length) return <div className="muted small" data-testid="insp-faces-none">No faces found in this clip.</div>;
  const picked = fx.faceBlur.faces ?? [];
  const toggle = (id: number) => {
    const next = picked.includes(id) ? picked.filter((f) => f !== id) : [...picked, id];
    send((p) => planEffect(p, item.id, FACE_BLUR, { faces: next }));
  };
  return (
    <div className="field-row wrap" data-testid="insp-faces">
      <span className="muted small">{picked.length ? "Only these faces:" : "Every face, or only:"}</span>
      {found.map((f, i) => (
        <button
          key={f.id}
          className={`small-btn${picked.includes(f.id) ? " active" : ""}`}
          data-testid="insp-face"
          data-face={f.id}
          disabled={locked}
          title={`Seen from ${clock(f.from)} to ${clock(f.to)}`}
          onClick={() => toggle(f.id)}
        >
          Face {i + 1}
        </button>
      ))}
    </div>
  );
}

/** Auto reframe: the clip follows its subject on the canvas's shape, one edit. */
export function ReframeButton({ item, locked }: { item: Item; locked: boolean }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const run = async () => {
    setBusy(true);
    setProblem(undefined);
    setProblem(await actions.reframe(item.id));
    setBusy(false);
  };
  return (
    <div className="group" data-testid="insp-reframe">
      <button className="small-btn" data-testid="insp-reframe-run" disabled={locked || busy} onClick={() => void run()} title="Fill the canvas and follow the subject's face">
        {busy ? "Reframing…" : "Auto reframe"}
      </button>
      {problem && (
        <div className="muted small" data-testid="insp-reframe-problem">
          {problem}
        </div>
      )}
    </div>
  );
}

/** Text behind subject: the clip under the texts copied above them with its background removed, one edit. */
export function BehindSubjectButton({ project, textIds, locked }: { project: ProjectModel; textIds: ReadonlyArray<string>; locked: boolean }) {
  const plan = planTextBehindSubject(project, textIds);
  return (
    <div className="group" data-testid="insp-behind-subject">
      <button
        className="small-btn"
        data-testid="insp-behind-subject-run"
        disabled={locked || "problem" in plan}
        title={"problem" in plan ? plan.problem : "Copies the clip under the text above it, with its background removed"}
        onClick={() => send((p) => planTextBehindSubject(p, textIds))}
      >
        Text behind subject
      </button>
    </div>
  );
}
