import type { Metadata } from "next";
import SiteFooter from "../../components/SiteFooter.tsx";
import SiteHeader from "../../components/SiteHeader.tsx";
import { COMPARISONS, GUIDE, GUIDE_PATH, pathOf } from "../../lib/compare.ts";
import { alternates, SITE_URL } from "../../lib/site.ts";

const DESCRIPTION = "How Uncut compares with other video editors, dated and sourced, including where each rival is the better choice.";

export const metadata: Metadata = {
  title: "Compare",
  description: DESCRIPTION,
  alternates: alternates("/vs/"),
  openGraph: { type: "website", title: "Compare Uncut", description: DESCRIPTION, url: `${SITE_URL}/vs/`, images: [`${SITE_URL}/assets/img/og.jpg`] },
  twitter: { card: "summary_large_image" },
};

export default function CompareIndex() {
  return (
    <>
      <SiteHeader />
      <main className="wrap">
        <div className="blog">
          <h1>Compare Uncut</h1>
          <p className="sub">{DESCRIPTION}</p>
          <ul className="compare-list">
            {COMPARISONS.map((c) => (
              <li key={c.slug}>
                <a href={pathOf(c)}>{c.title}</a>
                <p>{c.description}</p>
              </li>
            ))}
            <li>
              <a href={GUIDE_PATH}>{GUIDE.title}</a>
              <p>{GUIDE.description}</p>
            </li>
          </ul>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
