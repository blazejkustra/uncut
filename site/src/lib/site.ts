// One place for the canonical origin and the links every page shares: metadata, the sitemap, the
// feed and the structured data all have to agree on them.
export const SITE_URL = "https://uncut.video";
export const SITE_NAME = "Uncut";
export const REPO_URL = "https://github.com/blazejkustra/uncut";
/** Every release also carries this stable name, so the buttons start the download directly. */
export const DOWNLOAD_URL = "https://github.com/blazejkustra/uncut/releases/latest/download/Uncut-arm64.dmg";

/** A page's alternates: its canonical path and the blog feed (autodiscovery). Next replaces, not
 *  merges, `alternates` per page, so every page sets both through this. */
export function alternates(canonical: string) {
  return { canonical, types: { "application/rss+xml": [{ url: "/blog/rss.xml", title: "Uncut blog" }] } };
}
