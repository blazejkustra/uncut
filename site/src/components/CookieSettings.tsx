"use client";
// The footer's "Cookie settings" link (D284): only for visitors asked for consent (EU, UK, CH or
// unknown), shown after hydration once the region cookie and the stored choice are read. It reopens
// the banner with focus on Accept.
import { useEffect, useState } from "react";
import { openSettings, settingsWanted } from "../analytics.ts";

export default function CookieSettings() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(settingsWanted());
  }, []);
  if (!show) return null;
  return (
    <a
      href="#cookie-settings"
      data-cookie-settings=""
      onClick={(e) => {
        e.preventDefault();
        openSettings();
      }}
    >
      Cookie settings
    </a>
  );
}
