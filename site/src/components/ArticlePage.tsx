import type { Metadata } from "next";
import DownloadButtons from "./DownloadButtons.tsx";
import JsonLd from "./JsonLd.tsx";
import Markdown from "./Markdown.tsx";
import SiteFooter from "./SiteFooter.tsx";
import SiteHeader from "./SiteHeader.tsx";
import type { Article } from "../lib/compare.ts";
import { formatDate } from "../lib/posts.ts";
import { alternates, SITE_NAME, SITE_URL } from "../lib/site.ts";

export function articleMetadata(article: Article, path: string): Metadata {
  const url = `${SITE_URL}${path}`;
  return {
    title: article.title,
    description: article.description,
    alternates: alternates(path),
    openGraph: {
      type: "article",
      title: article.title,
      description: article.description,
      url,
      siteName: SITE_NAME,
      modifiedTime: article.checked,
      images: [`${SITE_URL}/assets/img/og.jpg`],
    },
    twitter: { card: "summary_large_image" },
  };
}

export default function ArticlePage({ article, path, back }: { article: Article; path: string; back?: { href: string; label: string } }) {
  const url = `${SITE_URL}${path}`;
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Article",
          headline: article.title,
          description: article.description,
          dateModified: article.checked,
          url,
          author: { "@type": "Person", name: "Błażej Kustra" },
          publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
          mainEntityOfPage: { "@type": "WebPage", "@id": url },
        }}
      />
      <SiteHeader />
      <main id="main" className="wrap">
        <article className="post">
          {back ? (
            <p className="back">
              <a href={back.href}>{back.label}</a>
            </p>
          ) : null}
          <p className="meta">
            Facts checked <time dateTime={article.checked}>{formatDate(article.checked)}</time>
          </p>
          <h1>{article.title}</h1>
          <p className="lead">{article.description}</p>
          <Markdown content={article.body} />
        </article>
        <aside className="post-cta">
          <h2>Try Uncut</h2>
          <p className="sub">
            Free and open source, for Apple silicon Macs. Install Claude Code or Codex and sign in, then open Uncut and tell it what to make.
          </p>
          <DownloadButtons />
        </aside>
      </main>
      <SiteFooter />
    </>
  );
}
