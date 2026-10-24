import type { MetadataRoute } from "next";
import { getPublishedPosts } from "../lib/posts.ts";
import { SITE_URL } from "../lib/site.ts";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getPublishedPosts();
  const latest = posts[0] ? new Date(posts[0].updated ?? posts[0].date) : undefined;
  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/blog/`, ...(latest ? { lastModified: latest } : {}), changeFrequency: "weekly", priority: 0.8 },
    ...posts.map((p) => ({
      url: `${SITE_URL}/blog/${p.slug}/`,
      lastModified: new Date(p.updated ?? p.date),
      changeFrequency: "yearly" as const,
      priority: 0.6,
    })),
    { url: `${SITE_URL}/privacy/`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
