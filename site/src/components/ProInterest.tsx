"use client";
import { useState } from "react";
import { trackProInterest } from "../analytics.ts";

export function InterestButton({ feature, name }: { feature: string; name: string }) {
  const [noted, setNoted] = useState(false);

  function register() {
    if (noted) return;
    trackProInterest(feature);
    setNoted(true);
  }

  return (
    <div className="pro-action">
      <button type="button" className="btn pro-btn" aria-disabled={noted} aria-label={noted ? undefined : `I'd pay for ${name}`} onClick={register}>
        {noted ? "Noted, thanks" : "I'd pay for this"}
      </button>
      <p className="pro-note" role="status">
        {noted ? "Nothing was charged. This helps us decide what to build." : "Not built yet. No charge: a click only tells us what to build."}
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
