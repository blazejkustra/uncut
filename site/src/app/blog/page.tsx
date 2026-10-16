// The blog index: every post, newest first.
import type { Metadata } from "next";
import JsonLd from "../../components/JsonLd.tsx";
import SiteFooter from "../../components/SiteFooter.tsx";
import SiteHeader from "../../components/SiteHeader.tsx";
import { formatDate, getAllPosts } from "../../lib/posts.ts";
import { alternates, SITE_NAME, SITE_URL } from "../../lib/site.ts";

const DESCRIPTION = "Releases and notes from building Uncut, the video editor for the Mac with an agent built in.";

export const metadata: Metadata = {
  title: "Blog",
  description: DESCRIPTION,
  alternates: alternates("/blog/"),
  openGraph: { type: "website", title: "Uncut blog", description: DESCRIPTION, url: `${SITE_URL}/blog/`, images: [`${SITE_URL}/assets/img/og.jpg`] },
  twitter: { card: "summary_large_image" },
};

export default function BlogIndex() {
  const posts = getAllPosts();
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Blog",
          name: `${SITE_NAME} blog`,
          url: `${SITE_URL}/blog/`,
          description: DESCRIPTION,
          blogPost: posts.map((p) => ({ "@type": "BlogPosting", headline: p.title, description: p.description, datePublished: p.date, dateModified: p.updated ?? p.date, url: `${SITE_URL}/blog/${p.slug}/` })),
        }}
      />
      <SiteHeader />
      <main className="wrap">
        <div className="blog">
          <h1>Blog</h1>
          <p className="sub">{DESCRIPTION}</p>
          <ul className="posts">
            {posts.map((p) => (
              <li key={p.slug}>
                <a className="post-card" href={`/blog/${p.slug}/`}>
                  <p className="meta"><time dateTime={p.date}>{formatDate(p.date)}</time></p>
                  <h2>{p.title}</h2>
                  <p className="desc">{p.description}</p>
                </a>
              </li>
            ))}
          </ul>
          <p className="feed"><a href="/blog/rss.xml">RSS feed</a></p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
