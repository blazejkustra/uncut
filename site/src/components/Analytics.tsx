"use client";
// Starts Google Analytics with Consent Mode and the EU banner (analytics.ts, D284) after hydration,
// so the banner it appends to <body> never races React. Renders nothing.
import { useEffect } from "react";
import { start } from "../analytics.ts";

export default function Analytics() {
  useEffect(() => {
    start();
  }, []);
  return null;
}
