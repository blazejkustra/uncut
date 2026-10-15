// Issue #13: the importable Grafana dashboard parses, uses the ${DS_LOKI} input everywhere, and
// every LogQL query has balanced brackets and quotes and targets service_name="uncut".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dash = JSON.parse(readFileSync(new URL("../../infra/grafana/uncut-dashboard.json", import.meta.url), "utf8"));
type Target = { refId: string; expr: string; datasource: { type: string; uid: string } };
type Panel = { id: number; type: string; title: string; gridPos: { x: number; y: number; w: number; h: number }; datasource: { type: string; uid: string }; targets: Array<Target> };
const panels: Array<Panel> = dash.panels;
const exprs = panels.flatMap((p) => p.targets.map((t) => ({ title: p.title, expr: t.expr })));

/** Brackets must nest and close outside string literals; quotes ("…" and `…`) must close. */
function balanced(expr: string): boolean {
  const stack: Array<string> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "`") {
      const close = c;
      i++;
      while (i < expr.length && expr[i] !== close) i += close === '"' && expr[i] === "\\" ? 2 : 1;
      if (i >= expr.length) return false;
    } else if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c in pairs && stack.pop() !== pairs[c]) return false;
  }
  return stack.length === 0;
}

test("the balance check itself catches broken queries", () => {
  assert.ok(balanced('sum by (a) (count_over_time({service_name="uncut"} | x=~".+:fail" [1d]))'));
  assert.ok(balanced('{a="(]"}'));
  for (const bad of ['sum(count_over_time({a="b"} [1d])', '{a="b}', "sum(]", "{a=`b}"]) assert.equal(balanced(bad), false, bad);
});

test("the dashboard is importable with a Loki data source input", () => {
  assert.equal(dash.title, "Uncut telemetry");
  assert.equal(dash.uid, "uncut-telemetry");
  assert.deepEqual(dash.__inputs.map((i: { name: string; type: string; pluginId: string }) => [i.name, i.type, i.pluginId]), [["DS_LOKI", "datasource", "loki"]]);
  assert.ok(dash.__requires.some((r: { id: string }) => r.id === "loki"));
  for (const p of panels) {
    assert.deepEqual(p.datasource, { type: "loki", uid: "${DS_LOKI}" }, p.title);
    for (const t of p.targets) assert.deepEqual(t.datasource, { type: "loki", uid: "${DS_LOKI}" }, p.title);
  }
});

test("panel ids are unique and every panel has a position inside the 24-column grid", () => {
  assert.equal(new Set(panels.map((p) => p.id)).size, panels.length);
  for (const p of panels) {
    assert.ok(p.gridPos.w > 0 && p.gridPos.h > 0 && p.gridPos.x + p.gridPos.w <= 24, p.title);
    assert.ok(p.targets.length > 0, p.title);
    assert.equal(new Set(p.targets.map((t) => t.refId)).size, p.targets.length, p.title);
  }
});

test("every LogQL query is balanced and selects service_name=\"uncut\"", () => {
  for (const { title, expr } of exprs) {
    assert.ok(balanced(expr), `${title}: ${expr}`);
    assert.ok(expr.includes('{service_name="uncut"}'), title);
  }
});

test("the basic panels are there", () => {
  const titles = panels.map((p) => p.title);
  for (const t of ["Events per day by event_name", "Daily active machines (approx. distinct distinct_id)", "Sessions per day", "App versions (machines)", "OS (machines)", "Top events", "Failures by code", "Export duration p50 / p95", "Agent turns per day", "Crashes by crash_fingerprint", "Recent events"]) {
    assert.ok(titles.includes(t), t);
  }
  const find = (title: string) => exprs.filter((e) => e.title === title).map((e) => e.expr);
  assert.match(find("Daily active machines (approx. distinct distinct_id)")[0], /^count\(count by \(distinct_id\) \(count_over_time\(.+\[1d\]\)\)\)$/);
  assert.match(find("Failures by code")[0], /event_name=~"\.\+:fail"/);
  assert.deepEqual(find("Export duration p50 / p95").map((e) => /quantile_over_time\((0\.\d+),.*unwrap duration_ms/.exec(e)?.[1]), ["0.5", "0.95"]);
  assert.equal(panels.find((p) => p.title === "Recent events")?.type, "logs");
});
