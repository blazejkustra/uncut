// The footer on every page. The privacy page links Home where the others link Privacy.
import CookieSettings from "./CookieSettings.tsx";
import { REPO_URL } from "../lib/site.ts";

export default function SiteFooter({ home = false }: { home?: boolean }) {
  return (
    <footer>
      <div className="wrap">
        <p>Uncut is MIT licensed. Not affiliated with Anthropic or OpenAI.</p>
        <nav aria-label="Footer">
          {home ? <a href="/">Home</a> : <a href="/privacy/">Privacy</a>}
          <a href={REPO_URL}>GitHub</a>
          <a href={`${REPO_URL}/blob/main/LICENSE`}>Licence</a>
          <a href={`${REPO_URL}/blob/main/THIRD_PARTY_NOTICES`}>Third-party notices</a>
          <CookieSettings />
        </nav>
      </div>
    </footer>
  );
}
