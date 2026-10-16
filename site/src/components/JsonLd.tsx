// Structured data, rendered into the page for crawlers. A data block (type application/ld+json)
// isn't run, so the CSP doesn't need its hash. Every claim in it has to match the visible page.
export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
