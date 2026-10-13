// Server side of plugin contributions (D103): a process plugin's own `check` answer turned into
// Checks, and a plugin component copied into the project's graphics/ folder (the item then
// draws from that copy in the graphics sandbox, D78, and keeps working when the plugin is gone).
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { componentGraphicHtml, componentGraphicName, MAX_GRAPHIC_BYTES, type Check, type CheckSeverity, type PluginComponent } from "@uncut/core";

import type { FoundPlugin, PluginResult } from "./plugins.ts";

/** How long a plugin's `check` may take before its findings are left out (and it's stopped, D97). */
export const CHECK_TIMEOUT_MS = 5000;
/** The most findings one plugin's check adds. */
const MAX_FINDINGS = 100;

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * A `check` tool's answer as Checks: {findings: [{rule, message, severity?, itemIds?, frame?,
 * hint?}]} (structuredContent, or JSON in the first text item; a bare array works too). Only
 * findings for the plugin's own "process" rules count; plugins suggest, they don't fix (no ops).
 */
export function parseFindings(plugin: Pick<FoundPlugin, "name" | "contributions">, result: PluginResult): { checks: Array<Check>; notes: Array<string> } {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (result.isError) return { checks: [], notes: [`${plugin.name}'s own checks are left out this time: ${text.slice(0, 200)}`] };
  let data: unknown = result.structured;
  if (data === undefined) {
    try {
      data = JSON.parse(text);
    } catch {
      return { checks: [], notes: [`${plugin.name}'s own checks answered something that isn't JSON findings, so they're left out.`] };
    }
  }
  const list = Array.isArray(data) ? data : (data as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) return { checks: [], notes: [`${plugin.name}'s own checks didn't return a findings list, so they're left out.`] };
  const rules = new Map(plugin.contributions.rules.filter((r) => r.rule.type === "process").map((r) => [r.id, r]));
  const checks: Array<Check> = [];
  list.slice(0, MAX_FINDINGS).forEach((raw, i) => {
    const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const rule = typeof f.rule === "string" ? rules.get(f.rule) : undefined;
    const message = str(f.message, 300);
    if (!rule || !message) return;
    const severity: CheckSeverity = f.severity === "info" || f.severity === "warn" ? f.severity : rule.severity;
    const itemIds = Array.isArray(f.itemIds) ? f.itemIds.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
    const frame = typeof f.frame === "number" && Number.isInteger(f.frame) && f.frame >= 0 ? f.frame : undefined;
    const hint = str(f.hint, 300) ?? rule.hint;
    checks.push({ id: rule.id, key: `${rule.id}:${str(f.key, 80) ?? i}`, severity, message, ...(itemIds.length ? { itemIds } : {}), ...(frame !== undefined ? { frame } : {}), ...(hint ? { hint } : {}) });
  });
  return { checks, notes: [] };
}

/**
 * Copies a plugin component into <project>/graphics/ as a graphic file (componentGraphicHtml) and
 * returns its src. The same content already there is reused; a different file with that name is
 * never overwritten (D78: earlier revisions keep their look), the copy gets -2, -3, …
 */
export async function copyComponent(projectDir: string, component: PluginComponent): Promise<{ src: string } | { problem: string }> {
  const html = componentGraphicHtml(component);
  if (Buffer.byteLength(html) > MAX_GRAPHIC_BYTES) return { problem: `${component.name} is over ${MAX_GRAPHIC_BYTES / 1024} KB, so it can't be added.` };
  const folder = join(projectDir, "graphics");
  await mkdir(folder, { recursive: true });
  const real = await realpath(folder);
  const project = await realpath(projectDir);
  if (!real.startsWith(`${project}${sep}`)) return { problem: "The project's graphics folder points outside the project, so nothing was added." };
  for (let n = 1; n <= 100; n++) {
    const name = componentGraphicName(component.id, n);
    const file = join(real, name);
    try {
      await writeFile(file, html, { flag: "wx" });
      return { src: `graphics/${name}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { problem: `Couldn't copy ${component.name} into the project: ${(error as Error).message}` };
      if ((await readFile(file, "utf8").catch(() => undefined)) === html) return { src: `graphics/${name}` };
    }
  }
  return { problem: `There are too many versions of ${component.name} in the project's graphics folder.` };
}
