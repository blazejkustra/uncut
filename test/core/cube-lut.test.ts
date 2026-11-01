// User LUTs: .cube parsing, resampling to the colour table, and that a LUT is a look like any other.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Ajv2020 } from "ajv/dist/2020.js";

import projectSchema from "../../spec/schema/project.schema.json" with { type: "json" };
import { withoutLutTables } from "../../apps/server/src/agent/tools/summary.ts";
import { LUT_SIZE } from "../../packages/core/src/visual/fx/defs.ts";
import { colourFn, colourLut, cubeText, lutAt } from "../../packages/core/src/visual/fx/colour.ts";
import { lutTable, parseCube } from "../../packages/core/src/visual/fx/cube.ts";
import { clipFx } from "../../packages/core/src/visual/fx/clipFx.ts";
import { planSetLook } from "../../packages/core/src/visual/fx/plans.ts";
import type { Project, ProjectLut } from "../../packages/core/src/timeline/types.ts";

/** A .cube of `fn`, red changing fastest. */
const cube = (size: number, fn: (r: number, g: number, b: number) => readonly [number, number, number], head = "") => {
  const lines = [head, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++)
        lines.push(
          fn(r / (size - 1), g / (size - 1), b / (size - 1))
            .map((v) => v.toFixed(6))
            .join(" "),
        );
  return lines.join("\n");
};
const swap = (r: number, g: number, b: number) => [b, g, r] as const;
const parsed = (text: string, name = "Teal.cube") => {
  const lut = parseCube(text, name);
  assert.ok(!("problem" in lut), "problem" in lut ? lut.problem : "");
  return lut as ProjectLut;
};
const near = (actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 1 / 4096) => {
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(actual[i]! - expected[i]!) <= tolerance, `${actual[i]} vs ${expected[i]} at ${i}`);
};

test("a 3D .cube of any size reads back the same colours at the table's size", () => {
  for (const size of [17, 33, 65]) {
    const table = lutTable(parsed(cube(size, swap)));
    assert.equal(table.size, LUT_SIZE);
    near(lutAt(table, 0.2, 0.5, 0.9), [0.9, 0.5, 0.2]);
    near(lutAt(table, 1, 0, 0), [0, 0, 1]);
  }
});

test("the name is the title, else the file's; comments and CRLF are fine; the same table gets the same id", () => {
  const titled = parsed(`# made by hand\r\n${cube(2, swap, 'TITLE "Teal & orange"').replace(/\n/g, "\r\n")}`);
  assert.equal(titled.name, "Teal & orange");
  assert.equal(parsed(cube(2, swap)).name, "Teal");
  assert.equal(titled.id, parsed(cube(2, swap)).id);
  assert.notEqual(parsed(cube(2, (r, g, b) => [r, g, b])).id, titled.id);
  assert.match(titled.id, /^lut-[0-9a-f]+$/);
});

test("a 1D .cube is a curve per channel, and DOMAIN_MAX scales the input", () => {
  const lines = ["LUT_1D_SIZE 2", "0 0 0", "0.5 1 0.25"].join("\n");
  near(lutAt(lutTable(parsed(lines)), 0.5, 0.5, 1), [0.25, 0.5, 0.25]);
  const domain = lutTable(parsed(cube(2, (r, g, b) => [r, g, b], "DOMAIN_MAX 2 2 2")));
  near(lutAt(domain, 0.5, 1, 0), [0.25, 0.5, 0]);
});

test("a broken .cube says why", () => {
  const problem = (text: string, re: RegExp) => {
    const out = parseCube(text, "x.cube");
    assert.ok("problem" in out && re.test(out.problem), JSON.stringify(out));
  };
  problem("0 0 0", /doesn't say its size/);
  problem("LUT_3D_SIZE 2\n0 0 0", /1 rows/);
  problem("LUT_3D_SIZE 1\n0 0 0", /size has to be/);
  problem("LUT_3D_SIZE 2\nnot numbers here", /can't read/);
  problem("LUT_3D_SIZE 500\n", /size has to be/);
  problem(cube(2, swap, "DOMAIN_MIN 1 1 1"), /domain is empty/);
});

test("a project's LUT is a look: picked by id, mixed by intensity, under Adjust, and its table is what ffmpeg gets", () => {
  const lut = parsed(cube(33, swap));
  const item = { type: "clip" as const, effects: [{ module: "effect.look", params: { look: lut.id, intensity: 1 } }] };
  assert.equal(clipFx(item), undefined, "no such look without the project's LUTs");
  const spec = clipFx(item, [lut])!.colour!;
  near(colourFn(spec)(0.1, 0.2, 0.7), [0.7, 0.2, 0.1]);
  const half = clipFx({ ...item, effects: [{ module: "effect.look", params: { look: lut.id, intensity: 0.5 } }] }, [lut])!.colour!;
  near(colourFn(half)(0.2, 0.5, 0.6), [0.4, 0.5, 0.4]);

  const table = colourLut(spec);
  assert.equal(colourLut(clipFx(item, [lut])!.colour!).key, table.key, "the preview and the export share one table");
  assert.match(cubeText(table), /LUT_3D_SIZE 33/);
  assert.ok(table.data.length === 33 ** 3 * 3);
});

test("planSetLook takes a project's LUT by id, with its name, and an intensity change keeps it", () => {
  const lut = parsed(cube(2, swap));
  const project = {
    luts: [lut],
    media: [{ id: "m", kind: "video", name: "A.mp4", path: "/a.mp4" }],
    tracks: [{ id: "main", kind: "video", role: "main", items: [{ id: "c", type: "clip", media: "m", in: 0, duration: 30 }] }],
  } as unknown as Project;
  const plan = planSetLook(project, "c", lut.id);
  assert.ok(!("problem" in plan));
  const op = plan.ops[0] as unknown as { set: { effects: ReadonlyArray<{ params: Record<string, unknown> }> } };
  assert.deepEqual(op.set.effects[0]!.params, { look: lut.id, intensity: 1, label: "Teal" });
  assert.ok("problem" in planSetLook({ ...project, luts: [] }, "c", lut.id));
});

test("a .cube saved with a UTF-8 BOM reads like any other", () => {
  const plain = parsed(cube(2, swap));
  assert.equal(parsed(`\uFEFF${cube(2, swap)}`).data, plain.data);
});

test("the schema takes a table of exactly LUT_SIZE³ and refuses any other length", () => {
  const validLut = new Ajv2020({ strict: false }).compile({ ...projectSchema.properties.luts.items, $defs: projectSchema.$defs });
  const lut = parsed(cube(2, swap));
  assert.ok(validLut(lut), JSON.stringify(validLut.errors));
  assert.ok(!validLut({ ...lut, data: lut.data.slice(4) }));
  assert.ok(!validLut({ ...lut, size: 2 }));
  assert.ok(!validLut({ ...lut, data: `*${lut.data.slice(1)}` }));
});

test("project_read's full project names a LUT and leaves its table out", () => {
  const lut = parsed(cube(2, swap));
  const project = { tracks: [], luts: [lut] } as unknown as Project;
  assert.deepEqual(withoutLutTables(project).luts, [{ id: lut.id, name: lut.name, size: lut.size }]);
  const noLuts = { tracks: [] } as unknown as Project;
  assert.equal(withoutLutTables(noLuts), noLuts);
});
