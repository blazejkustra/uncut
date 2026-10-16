// D281: a plugin's own icon (its manifest's icon.svg, checked by the server and sent as a data: URL)
// drawn as a CSS mask filled with the text colour, so it's monochrome like the tools' marks and can't
// run or load anything; the generic icon when it has none.
import { Blocks } from "lucide-react";

export function PluginIcon({ icon, id }: { icon: string | undefined; id: string }) {
  if (!icon?.startsWith("data:image/svg+xml;base64,")) return <Blocks />;
  const url = `url("${icon}")`;
  return <span className="plugin-mark" data-testid={`plugin-mark-${id}`} aria-hidden style={{ maskImage: url, WebkitMaskImage: url }} />;
}
