import { AppleMark } from "./Icons.tsx";
import { DOWNLOAD_URL, REPO_URL } from "../lib/site.ts";

/** "Download for macOS" and "View on GitHub", as in the hero and the closing call. */
export default function DownloadButtons({ github = true }: { github?: boolean }) {
  return (
    <div className="actions">
      <a className="btn primary" href={DOWNLOAD_URL}>
        <AppleMark />
        Download for macOS
      </a>
      {github ? <a className="btn" href={REPO_URL}>View on GitHub</a> : null}
    </div>
  );
}
