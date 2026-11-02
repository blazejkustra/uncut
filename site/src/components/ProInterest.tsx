"use client";
import { type MouseEvent, useRef, useState } from "react";
import { trackProInterest } from "../analytics.ts";

export type ProFeature = { feature: string; title: string };

function mailtoFor(email: string, choice: ProFeature | undefined): string {
  const params = [`subject=${encodeURIComponent("Email me when Uncut Pro launches")}`];
  if (choice) params.push(`body=${encodeURIComponent(`The feature I would use most: ${choice.title}`)}`);
  return `mailto:${email}?${params.join("&")}`;
}

export function GetPro({ email, features }: { email: string; features: Array<ProFeature> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState<ProFeature>();

  function open() {
    trackProInterest("cta");
    dialog.current?.showModal();
  }

  function close() {
    dialog.current?.close();
  }

  function choose(feature: ProFeature) {
    if (feature === choice) return;
    setChoice(feature);
    trackProInterest(feature.feature);
  }

  function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialog.current) close();
  }

  return (
    <>
      <button ref={trigger} type="button" className="btn primary get-pro" aria-haspopup="dialog" onClick={open}>
        Get Pro
      </button>
      <dialog ref={dialog} className="pro-dialog" aria-labelledby="pro-dialog-title" onClose={() => trigger.current?.focus()} onClick={closeOnBackdrop}>
        <div className="pro-dialog-body">
          <h2 id="pro-dialog-title">Uncut Pro is coming soon</h2>
          <p>Pro is not available yet. We are building it now and can email you the day it launches.</p>
          <p className="pro-pick-label" id="pro-pick-label">
            Which feature would you use most?
          </p>
          <div className="pro-pick" role="group" aria-labelledby="pro-pick-label">
            {features.map((f) => (
              <button key={f.feature} type="button" className="pro-chip" aria-pressed={f === choice} onClick={() => choose(f)}>
                {f.title}
              </button>
            ))}
          </div>
          <div className="pro-dialog-actions">
            <a className="btn primary" href={mailtoFor(email, choice)} onClick={() => trackProInterest("email")}>
              Email me when it launches
            </a>
            <button type="button" className="btn" onClick={close}>
              Close
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
