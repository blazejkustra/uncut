// D260 (issue #81): decision ids (D76, D83–D88) mean nothing to the model, so they're taken out of
// every description it reads. Kept apart from agentTools.ts so the docs can use it too.

/** Decision ids out of a model-facing text, whether a parenthesis of their own or a tag inside one. */
export function withoutDecisionIds(text: string): string {
  return text
    .replace(/^D\d{2,3}(?:[–-]D\d{2,3})?: (.)/, (_, c: string) => c.toUpperCase())
    .replace(/ ?\((?:D\d{2,3}(?:[–-]D\d{2,3})?(?:, ?)?)+\)/g, "")
    .replace(/[,;] ?D\d{2,3}(?:[–-]D\d{2,3})?(?=[)\]:;,])/g, "")
    .replace(/\(D\d{2,3}(?:[–-]D\d{2,3})?[:;,] ?/g, "(")
    .replace(/ D\d{2,3}(?:[–-]D\d{2,3})?\.(?=\s|$)/g, "");
}

/** A schema with every "description" string passed through withoutDecisionIds. */
export function scrubDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "description" && typeof v === "string" ? withoutDecisionIds(v) : scrubDescriptions(v)]));
}
