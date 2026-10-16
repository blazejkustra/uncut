// A post's body, rendered on the server (no client JS). Plain elements styled by .prose in
// globals.css; outside links open in a new tab.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children }) => {
    const external = typeof href === "string" && /^https?:/.test(href);
    return <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>{children}</a>;
  },
  // The alt text doubles as the caption: one description, written once.
  img: ({ src, alt }) => (
    <figure>
      <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} loading="lazy" />
      {alt ? <figcaption>{alt}</figcaption> : null}
    </figure>
  ),
  // A lone image in a paragraph would put a <figure> inside a <p>; unwrap it.
  p: ({ node, children }) => (node?.children.length === 1 && node.children[0]?.type === "element" && node.children[0].tagName === "img" ? <>{children}</> : <p>{children}</p>),
};

export default function Markdown({ content }: { content: string }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
    </div>
  );
}
