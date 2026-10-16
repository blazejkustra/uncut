// Blog posts: Markdown files in site/content/blog/<slug>.md with front matter (as on cookinbuddy.com),
// read at build time. Front matter: title, date (YYYY-MM-DD), description, and optionally image and
// imageAlt (the lead image), ogImage (a 1200×750 JPEG for link previews) and updated.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export type Post = {
  slug: string;
  title: string;
  /** ISO date, also what the feed, the sitemap and the structured data say. */
  date: string;
  updated?: string;
  description: string;
  image?: string;
  imageAlt?: string;
  ogImage?: string;
  readingTime: string;
  content: string;
};

const DIR = path.join(process.cwd(), "content/blog");

function readingTime(content: string): string {
  const words = content.trim().split(/\s+/).length;
  return `${Math.max(1, Math.round(words / 220))} min read`;
}

function str(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === "string" ? v : undefined;
}

export function getAllPosts(): Array<Post> {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const slug = file.replace(/\.md$/, "");
      const { data, content } = matter(fs.readFileSync(path.join(DIR, file), "utf8"));
      const title = str(data.title), date = str(data.date);
      if (!title || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`content/blog/${file}: needs a title and a YYYY-MM-DD date`);
      return {
        slug,
        title,
        date,
        updated: str(data.updated),
        description: str(data.description) ?? "",
        image: str(data.image),
        imageAlt: str(data.imageAlt),
        ogImage: str(data.ogImage),
        readingTime: readingTime(content),
        content,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getPost(slug: string): Post | undefined {
  return getAllPosts().find((p) => p.slug === slug);
}

/** "October 16, 2026", in UTC so the build machine's time zone can't shift the day. */
export function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
