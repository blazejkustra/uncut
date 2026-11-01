"use client";
import { useState } from "react";
import { trackProInterest } from "../analytics.ts";

const NOTES = {
  idle: "Not built yet. No charge: a click only tells us what to build.",
  noted: "Nothing was charged. This helps us decide what to build.",
  unsent: "Analytics are off, so this click wasn't recorded. Use the email link below to tell us.",
};

export function InterestButton({ feature, name }: { feature: string; name: string }) {
  const [state, setState] = useState<keyof typeof NOTES>("idle");
  const noted = state === "noted";

  function register() {
    if (noted) return;
    setState(trackProInterest(feature) ? "noted" : "unsent");
  }

  return (
    <div className="pro-action">
      <button type="button" className="btn pro-btn" aria-disabled={noted} aria-label={noted ? undefined : `I'd pay for ${name}`} onClick={register}>
        {noted ? "Noted, thanks" : "I'd pay for this"}
      </button>
      <p className="pro-note" role="status">
        {NOTES[state]}
      </p>
    </div>
  );
}

export function EmailLink({ href }: { href: string }) {
  return (
    <a className="btn primary" href={href} onClick={() => trackProInterest("email")}>
      Email me when Pro exists
    </a>
  );
}
