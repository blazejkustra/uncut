// Blog posts: Markdown files in site/content/blog/<slug>.md with front matter (as on cookinbuddy.com),
// read at build time. Front matter: title, date (YYYY-MM-DD), description, and optionally image and
// imageAlt (the lead image), ogImage (a 1200×750 JPEG for link previews) and updated.
// Drafts live in site/content/drafts/<slug>.md (gitignored, never committed). The production build
// leaves them out; a build with UNCUT_DRAFTS=1 (the preview branch) lists them under /blog/ with a
// Draft marker and noindex, and still keeps them out of the feed and the sitemap.
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
  /** From content/drafts: shown only in a UNCUT_DRAFTS=1 build, never in the feed or sitemap. */
  draft: boolean;
};

const CONTENT = path.join(process.cwd(), "content");

/** Whether this build renders drafts (UNCUT_DRAFTS=1, set for the preview branch only). */
export const SHOW_DRAFTS = process.env.UNCUT_DRAFTS === "1";

function readingTime(content: string): string {
  const words = content.trim().split(/\s+/).length;
  return `${Math.max(1, Math.round(words / 220))} min read`;
}

function str(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === "string" ? v : undefined;
}

function readDir(dir: string, draft: boolean): Array<Post> {
  if (!fs.existsSync(dir)) return [];
  const where = draft ? "content/drafts" : "content/blog";
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const slug = file.replace(/\.md$/, "");
      const { data, content } = matter(fs.readFileSync(path.join(dir, file), "utf8"));
      const title = str(data.title),
        date = str(data.date);
      if (!title || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${where}/${file}: needs a title and a YYYY-MM-DD date`);
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
        draft,
      };
    });
}

/** The posts under root/blog, plus root/drafts when drafts is true; newest first. */
export function readPosts(root: string, drafts: boolean): Array<Post> {
  const posts = readDir(path.join(root, "blog"), false);
  if (drafts) {
    for (const d of readDir(path.join(root, "drafts"), true)) {
      if (posts.some((p) => p.slug === d.slug)) throw new Error(`content/drafts/${d.slug}.md: a published post already has this slug`);
      posts.push(d);
    }
  }
  return posts.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Every post this build renders: the published ones, plus drafts in a UNCUT_DRAFTS=1 build. */
export function getAllPosts(): Array<Post> {
  return readPosts(CONTENT, SHOW_DRAFTS);
}

/** Published posts only: what the feed and the sitemap list, whatever the build. */
export function getPublishedPosts(): Array<Post> {
  return readPosts(CONTENT, false);
}

export function getPost(slug: string): Post | undefined {
  return getAllPosts().find((p) => p.slug === slug);
}

/** "October 16, 2026", in UTC so the build machine's time zone can't shift the day. */
export function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
