// A small structural diff for project.json states (D71): history.db stores most revisions as the
// patch from their parent's state, so a state comes back without replaying edit ops through the
// engine (whose rules may change between versions of Uncut). Objects diff key by key, arrays by
// their common head and tail: equal-length middles recurse element by element, anything else is one
// splice. A patch is applied in order; no op addresses an array another op of the patch splices.

export type PatchPath = ReadonlyArray<string | number>;
export type PatchOp =
  | { readonly p: PatchPath; readonly v: unknown }
  | { readonly p: PatchPath; readonly d: 1 }
  | { readonly p: PatchPath; readonly s: readonly [number, number, ReadonlyArray<unknown>] };
export type Patch = ReadonlyArray<PatchOp>;

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/** Deep equality of JSON values (key order doesn't matter). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!Object.hasOwn(b, k) || !sameJson(a[k], b[k])) return false;
    return true;
  }
  return false;
}

function walk(a: unknown, b: unknown, path: Array<string | number>, out: Array<PatchOp>) {
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    let head = 0;
    while (head < a.length && head < b.length && sameJson(a[head], b[head])) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && sameJson(a[a.length - 1 - tail], b[b.length - 1 - tail])) tail++;
    const removed = a.length - head - tail;
    const added = b.length - head - tail;
    if (removed === added) {
      for (let i = head; i < head + removed; i++) walk(a[i], b[i], [...path, i], out);
    } else out.push({ p: path, s: [head, removed, b.slice(head, head + added)] });
    return;
  }
  if (isObject(a) && isObject(b)) {
    for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) out.push({ p: [...path, k], d: 1 });
    for (const k of Object.keys(b)) {
      if (!Object.hasOwn(a, k)) out.push({ p: [...path, k], v: b[k] });
      else walk(a[k], b[k], [...path, k], out);
    }
    return;
  }
  if (!sameJson(a, b)) out.push({ p: path, v: b });
}

/** The patch that turns `a` into `b` (both JSON values; neither is changed). */
export function diff(a: unknown, b: unknown): Array<PatchOp> {
  const out: Array<PatchOp> = [];
  walk(a, b, [], out);
  return out;
}

// Keys are written as own data properties, so a "__proto__" key can never reach a prototype.
const put = (target: Record<string | number, unknown>, key: string | number, value: unknown) =>
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });

const step = (node: unknown, key: string | number): unknown => {
  if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) throw new Error(`patch path doesn't exist at "${key}"`);
  return (node as Record<string | number, unknown>)[key];
};

/**
 * Apply a patch to `root`, changing it in place (pass a value nobody else holds: parse it fresh
 * or clone it). Returns the new root (a patch can replace the whole value). Values in the patch are
 * used as they are, so a patch object must not be applied twice.
 */
export function applyPatch(root: unknown, patch: Patch): unknown {
  let doc = root;
  for (const op of patch) {
    if ("s" in op) {
      const list = op.p.reduce(step, doc);
      if (!Array.isArray(list)) throw new Error("patch splice on something that isn't a list");
      const [at, count, items] = op.s;
      list.splice(at, count);
      // In chunks: spreading a very long list into one call overflows the argument limit.
      for (let i = 0; i < items.length; i += 10_000) list.splice(at + i, 0, ...items.slice(i, i + 10_000));
      continue;
    }
    if (op.p.length === 0) {
      if ("v" in op) doc = op.v;
      else throw new Error("patch can't delete the whole document");
      continue;
    }
    const parent = op.p.slice(0, -1).reduce(step, doc) as Record<string | number, unknown>;
    if (parent === null || typeof parent !== "object") throw new Error("patch path doesn't lead to an object");
    const key = op.p[op.p.length - 1]!;
    if ("d" in op) {
      if (Array.isArray(parent)) throw new Error("patch delete inside a list");
      delete parent[key];
    } else put(parent, key, op.v);
  }
  return doc;
}
