// One post: its front matter as the header and og: metadata, the Markdown body, then the download.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DownloadButtons from "../../../components/DownloadButtons.tsx";
import JsonLd from "../../../components/JsonLd.tsx";
import Markdown from "../../../components/Markdown.tsx";
import SiteFooter from "../../../components/SiteFooter.tsx";
import SiteHeader from "../../../components/SiteHeader.tsx";
import { formatDate, getAllPosts, getPost } from "../../../lib/posts.ts";
import { SITE_NAME, SITE_URL } from "../../../lib/site.ts";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = getPost((await params).slug);
  if (!post) return {};
  const url = `${SITE_URL}/blog/${post.slug}/`;
  const image = `${SITE_URL}${post.ogImage ?? "/assets/img/og.jpg"}`;
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: `/blog/${post.slug}/` },
    openGraph: { type: "article", title: post.title, description: post.description, url, siteName: SITE_NAME, publishedTime: post.date, modifiedTime: post.updated ?? post.date, images: [{ url: image, width: 1200, height: 750, alt: post.imageAlt ?? post.title }] },
    twitter: { card: "summary_large_image", title: post.title, description: post.description, images: [image] },
  };
}

export default async function PostPage({ params }: Props) {
  const post = getPost((await params).slug);
  if (!post) notFound();
  const url = `${SITE_URL}/blog/${post.slug}/`;
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: post.title,
          description: post.description,
          datePublished: post.date,
          dateModified: post.updated ?? post.date,
          url,
          ...(post.image ? { image: `${SITE_URL}${post.image}` } : {}),
          author: { "@type": "Person", name: "Błażej Kustra" },
          publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
          mainEntityOfPage: { "@type": "WebPage", "@id": url },
        }}
      />
      <SiteHeader />
      <main className="wrap">
        <article className="post">
          <p className="back"><a href="/blog/">All posts</a></p>
          <p className="meta"><time dateTime={post.date}>{formatDate(post.date)}</time>, {post.readingTime}</p>
          <h1>{post.title}</h1>
          <p className="lead">{post.description}</p>
          {post.image ? <img className="lead-img" src={post.image} width={2400} height={1500} fetchPriority="high" alt={post.imageAlt ?? ""} /> : null}
          <Markdown content={post.content} />
        </article>
        <aside className="post-cta">
          <h2>Try Uncut</h2>
          <p className="sub">Free and open source, for Apple silicon Macs. Install Claude Code and sign in, then open Uncut and tell it what to make.</p>
          <DownloadButtons />
        </aside>
      </main>
      <SiteFooter />
    </>
  );
}
