// Settings › Plugins › Make a plugin (D258): the plugin creation guide (guide.ts, the same text as
// CONTRIBUTING.md's Plugins section), with the worked example one click away in the marketplace.
import { Check, Copy, ExternalLink, Store } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { EXAMPLE, PLUGIN_GUIDE, type GuideBlock } from "./guide.ts";

/** Prose with `code` spans. */
function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? <code key={i}>{part.slice(1, -1)}</code> : <Fragment key={i}>{part}</Fragment>));
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pg-code">
      <pre>{code}</pre>
      <button
        className="icon-btn pg-copy"
        title={copied ? "Copied" : "Copy"}
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

function Block({ block }: { block: GuideBlock }) {
  if ("p" in block) return <p>{inline(block.p)}</p>;
  if ("list" in block)
    return (
      <ul>
        {block.list.map((x) => (
          <li key={x}>{inline(x)}</li>
        ))}
      </ul>
    );
  if ("code" in block) return <CodeBlock code={block.code} />;
  return (
    <dl className="pg-table">
      {block.table.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{inline(v)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function MakePlugin({ onShowExample }: { onShowExample: (id: string, name: string) => void }) {
  return (
    <div className="pg" data-testid="plugins-guide">
      <div className="pg-hero" data-testid="plugins-guide-example">
        <div className="pg-hero-text">
          <div className="pg-hero-title">Start from the {EXAMPLE.name}</div>
          <div className="pg-hero-sub">
            A complete plugin with a text look, a component, a skill and a shader effect, in <code>{EXAMPLE.folder}</code>. Install it to see each part in Uncut, then copy it with <code>pnpm plugin:new your.id --from {EXAMPLE.id}</code>.
          </div>
        </div>
        <div className="pg-hero-btns">
          <button className="btn" data-testid="plugins-guide-show-example" onClick={() => onShowExample(EXAMPLE.id, EXAMPLE.name)}>
            <Store />
            Show in the marketplace
          </button>
          <a className="btn ghost" href={EXAMPLE.url} target="_blank" rel="noreferrer" data-testid="plugins-guide-source">
            <ExternalLink />
            View its source
          </a>
        </div>
      </div>
      {/* The guide's contents as a plain list of links, not chips (D263). */}
      <nav className="pg-toc" aria-label="On this page">
        {PLUGIN_GUIDE.map((s) => (
          <button key={s.id} className="link-btn" onClick={() => document.getElementById(`plugin-guide-${s.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>
            {s.title}
          </button>
        ))}
      </nav>
      {PLUGIN_GUIDE.map((s) => (
        <section key={s.id} id={`plugin-guide-${s.id}`} className="pg-section" data-testid={`plugins-guide-${s.id}`}>
          <h3>{s.title}</h3>
          {s.blocks.map((b, i) => (
            <Block key={i} block={b} />
          ))}
        </section>
      ))}
    </div>
  );
}
