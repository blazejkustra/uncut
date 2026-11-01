// The little XML an FCPXML file needs: elements, attributes and text. A DOCTYPE is skipped, so its
// entities are never expanded.

export interface XmlNode {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: Array<XmlNode>;
  text: string;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const unescapeXml = (text: string) =>
  text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number(dec));
    return ENTITIES[name!] ?? whole;
  });

export const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const attributesOf = (source: string) => Object.fromEntries([...source.matchAll(ATTRIBUTE)].map((m) => [m[1]!, unescapeXml(m[2] ?? m[3] ?? "")]));

const unclosedComment = (source: string) => {
  const last = source.lastIndexOf("<!--");
  return last !== -1 && !source.includes("-->", last);
};

/** The document's root element, or undefined when it isn't well formed. */
export function parseXml(source: string): XmlNode | undefined {
  if (unclosedComment(source)) return undefined;
  const root: XmlNode = { name: "", attributes: {}, children: [], text: "" };
  const open = [root];
  for (const [, closing, name, attributes, selfClosed, text] of source.matchAll(TOKEN)) {
    const parent = open.at(-1)!;
    if (closing) {
      if (parent.name !== closing) return undefined;
      open.pop();
    } else if (name) {
      const node: XmlNode = { name, attributes: attributesOf(attributes ?? ""), children: [], text: "" };
      parent.children.push(node);
      if (!selfClosed) open.push(node);
    } else if (text) parent.text += unescapeXml(text);
  }
  return open.length === 1 ? root.children[0] : undefined;
}
