"use client";
// The nav's GitHub button: "Star" until the repo has 10 stars, then the count in the same fixed width
// (hero.ts fetchStars, cached for the session). Rendered on the server with the label; the count, if
// any, arrives after hydration.
import { useEffect, useState } from "react";
import { fetchStars, formatStars } from "../hero.ts";
import { GithubMark, StarMark } from "./Icons.tsx";
import { REPO_URL } from "../lib/site.ts";

export default function StarButton() {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void fetchStars().then((n) => { if (live) setStars(n); });
    return () => { live = false; };
  }, []);
  const has = stars !== null;
  return (
    <a className={has ? "nav-stars has-stars" : "nav-stars"} href={REPO_URL} aria-label={has ? `Star Uncut on GitHub, ${stars.toLocaleString("en-US")} stars` : "Star Uncut on GitHub"}>
      <GithubMark />
      <span className="label">Star</span>
      <span className="count" data-stars hidden={!has}>
        <StarMark />
        <span className="n">{has ? formatStars(stars) : ""}</span>
      </span>
    </a>
  );
}
