// User LUTs: a .cube file read into the project. Every table is resampled to LUT_SIZE³ and stored in
// project.json, so a project keeps its LUTs without the file. The preview and the export read it as
// a look, through the same colour table (colour.ts). The table takes sRGB-encoded pixels, like every
// look: a LUT for log footage needs log footage.
import type { ProjectLut } from "../../timeline/types.ts";
import { clamp01, LUT_SIZE } from "./defs.ts";
import { type ColourLut, lutAt, lutHash } from "./colour.ts";

const MAX_CUBE_SIZE = 129;
const MAX_CURVE_SIZE = 65536;
export const MAX_PROJECT_LUTS = 32;

type Triple = readonly [number, number, number];

interface CubeFile {
  readonly title?: string;
  readonly dimensions: 1 | 3;
  readonly size: number;
  readonly min: Triple;
  readonly max: Triple;
  readonly data: Float32Array;
}

const triple = (parts: ReadonlyArray<string>): Triple | undefined => {
  const values = parts.slice(0, 3).map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? (values as unknown as Triple) : undefined;
};

function readCube(text: string): CubeFile | { readonly problem: string } {
  let title: string | undefined;
  let dimensions: 1 | 3 | undefined;
  let size = 0;
  let min: Triple = [0, 0, 0];
  let max: Triple = [1, 1, 1];
  const rows: Array<number> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [word, ...rest] = line.split(/\s+/);
    if (word === "TITLE") title = /"(.*)"/.exec(line)?.[1] ?? rest.join(" ");
    else if (word === "LUT_3D_SIZE" || word === "LUT_1D_SIZE") {
      dimensions = word === "LUT_3D_SIZE" ? 3 : 1;
      size = Number(rest[0]);
    } else if (word === "DOMAIN_MIN") min = triple(rest) ?? min;
    else if (word === "DOMAIN_MAX") max = triple(rest) ?? max;
    else if (word === "LUT_3D_INPUT_RANGE" || word === "LUT_1D_INPUT_RANGE") {
      const [low, high] = rest.map(Number);
      if (Number.isFinite(low) && Number.isFinite(high)) {
        min = [low!, low!, low!];
        max = [high!, high!, high!];
      }
    } else {
      const row = triple([word!, ...rest]);
      if (!row) return { problem: `That .cube file has a line it can't read: ${line.slice(0, 40)}` };
      rows.push(...row);
    }
  }
  if (!dimensions) return { problem: "That .cube file doesn't say its size (LUT_3D_SIZE or LUT_1D_SIZE)." };
  const largest = dimensions === 3 ? MAX_CUBE_SIZE : MAX_CURVE_SIZE;
  if (!Number.isInteger(size) || size < 2 || size > largest) return { problem: `That .cube file's size has to be 2 to ${largest}.` };
  const expected = (dimensions === 3 ? size ** 3 : size) * 3;
  if (rows.length !== expected) return { problem: `That .cube file has ${rows.length / 3} rows and its size needs ${expected / 3}.` };
  if (min.some((low, i) => low >= max[i]!)) return { problem: "That .cube file's domain is empty." };
  return { dimensions, size, min, max, data: Float32Array.from(rows), ...(title ? { title } : {}) };
}

const curveAt = (cube: CubeFile, channel: number, v: number) => {
  const x = clamp01(v) * (cube.size - 1);
  const i = Math.min(cube.size - 2, Math.floor(x));
  const f = x - i;
  return cube.data[i * 3 + channel]! * (1 - f) + cube.data[(i + 1) * 3 + channel]! * f;
};

/** The file's table at LUT_SIZE³, red changing fastest; its input domain is mapped onto 0-1. */
function resample(cube: CubeFile): Float32Array {
  const table = { key: "", size: cube.size, data: cube.data };
  const scaled = (v: number, i: number) => (v - cube.min[i]!) / (cube.max[i]! - cube.min[i]!);
  const out = new Float32Array(LUT_SIZE ** 3 * 3);
  const last = LUT_SIZE - 1;
  let k = 0;
  for (let b = 0; b <= last; b++)
    for (let g = 0; g <= last; g++)
      for (let r = 0; r <= last; r++) {
        const input: Triple = [scaled(r / last, 0), scaled(g / last, 1), scaled(b / last, 2)];
        const c = cube.dimensions === 3 ? lutAt(table, input[0], input[1], input[2]) : input.map((v, i) => curveAt(cube, i, v));
        for (let i = 0; i < 3; i++) out[k++] = clamp01(c[i]!);
      }
  return out;
}

const encode = (data: Float32Array) => {
  const words = Uint16Array.from(data, (v) => Math.round(v * 65535));
  const bytes = new Uint8Array(words.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const decoded = new WeakMap<ProjectLut, ColourLut>();

/** A project LUT's table (kept while the entry lives: a preview asks every frame). */
export function lutTable(lut: ProjectLut): ColourLut {
  const known = decoded.get(lut);
  if (known) return known;
  const bytes = Uint8Array.from(atob(lut.data), (c) => c.charCodeAt(0));
  const words = new Uint16Array(bytes.buffer);
  const table = { key: lut.id, size: lut.size, data: Float32Array.from(words, (v) => v / 65535) };
  decoded.set(lut, table);
  return table;
}

/** A .cube file as a project LUT, or why it can't be one. Its id comes from its table, so the same LUT imported twice is one. */
export function parseCube(text: string, fileName: string): ProjectLut | { readonly problem: string } {
  const cube = readCube(text);
  if ("problem" in cube) return cube;
  const data = encode(resample(cube));
  return { id: `lut-${lutHash(data)}`, name: (cube.title?.trim() || fileName.replace(/\.cube$/i, "")).slice(0, 60), size: LUT_SIZE, data };
}
