// The 404 page (out/404.html), in the site's own styles: Next's default one carries inline styles
// the CSP doesn't allow.
import type { Metadata } from "next";
import SiteFooter from "../components/SiteFooter.tsx";
import SiteHeader from "../components/SiteHeader.tsx";

export const metadata: Metadata = { title: "Not found", robots: { index: false } };

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="wrap">
        <article className="doc">
          <h1>Page not found</h1>
          <p className="meta">404</p>
          <p>
            There's nothing at this address. <a href="/">Go to the home page</a> or <a href="/blog/">read the blog</a>.
          </p>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
