// The top bar on every page: the wordmark on the left; Blog, the GitHub star button and Download on
// the right.
import { AppleMark, CutU } from "./Icons.tsx";
import StarButton from "./StarButton.tsx";
import { DOWNLOAD_URL } from "../lib/site.ts";

export default function SiteHeader() {
  return (
    <header className="top">
      <div className="wrap">
        <a className="wordmark" href="/" aria-label="Uncut home">
          <CutU />
          <span>Uncut</span>
        </a>
        <nav aria-label="Main">
          <a className="nav-link" href="/blog/">Blog</a>
          <StarButton />
          <a className="btn-nav" href={DOWNLOAD_URL}>
            <AppleMark />
            Download
          </a>
        </nav>
      </div>
    </header>
  );
}
