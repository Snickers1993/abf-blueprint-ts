// Source map (design 8.5): IR node -> TS span and IR node -> real node name; maps Unreal compile messages back to TS.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { t3dNodeKey, t3dNodeName } from "@abfc/ir";
import type { Diagnostic, Span } from "@abfc/ir";
import { assetFileStem, stringifySorted } from "./manifest.js";

export interface SourceMapFile {
  asset: string;
  units: Record<string, { span: Span; nodes: Record<string, { span: Span; real: string | null }> }>;
}

/** The part of the backend's `CompileMessage` the mapper needs. */
export interface CompileMessageLike {
  asset: string | null;
  message: string;
  node?: string;
  graph?: string;
}

export function sourceMapPath(dir: string, asset: string): string {
  return join(dir, ".abfc", "sourcemap", `${assetFileStem(asset)}.json`);
}

/** Writes the source map and returns its file path. */
export function writeSourceMap(dir: string, sm: SourceMapFile): string {
  const file = sourceMapPath(dir, sm.asset);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifySorted(sm), "utf8");
  return file;
}

/** Removes the source map file of an asset (no-op when there is none). */
export function deleteSourceMap(dir: string, asset: string): void {
  const file = sourceMapPath(dir, asset);
  if (existsSync(file)) rmSync(file);
}

export function readSourceMap(dir: string, asset: string): SourceMapFile | null {
  const file = sourceMapPath(dir, asset);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as SourceMapFile;
}

/** The graph a unit's nodes live in: a function unit in the graph of its name, events and overrides in the EventGraph. */
function unitGraphOf(unitId: string): string {
  return unitId.startsWith("function:") ? unitId.slice("function:".length) : "EventGraph";
}

/**
 * Compile messages -> diagnostics. `nodeIds` maps a real node name to `<unit id>/<IR node id>` for the owned nodes of the
 * asset (names recorded in the source map's `real` fields are used as well). Real names are unique per graph only, so the lookup
 * key is `t3dNodeKey(graph, real)` and a message is matched with its `graph`; without one the EventGraph node of that name, else
 * the only owned node of that name, is taken.
 *
 * Messages without a usable node are located by their text: `[spec:<id>]` (an apply error about a planned node; `specIds` maps the
 * spec node id to `<unit id>/<IR node id>`) and `Could not find a function named "X"` (`ownCalls` lists the TS spans of the calls to
 * owned function X). Both give ABFC6001 at the call. When such a located error exists, the unlocated fallback errors of messages
 * that belong to no asset (the backend's raw apply error) are dropped, so one failure gives one located error.
 */
export function mapCompileMessages(
  asset: string,
  messages: CompileMessageLike[],
  sm: SourceMapFile,
  nodeIds: Record<string, string>,
  specIds: Record<string, string> = {},
  ownCalls: Record<string, Span[]> = {},
): Diagnostic[] {
  // keyed like the stage snapshot: a function unit's nodes live in its own graph (Unreal names nodes uniquely per graph only)
  const byKey = new Map<string, { unit: string; node: string }>();
  for (const [unitId, u] of Object.entries(sm.units)) {
    for (const [irId, n] of Object.entries(u.nodes)) if (n.real !== null) byKey.set(t3dNodeKey(unitGraphOf(unitId), n.real), { unit: unitId, node: irId });
  }
  for (const [real, key] of Object.entries(nodeIds)) {
    const slash = key.indexOf("/");
    if (slash > 0) byKey.set(t3dNodeKey(unitGraphOf(key.slice(0, slash)), real), { unit: key.slice(0, slash), node: key.slice(slash + 1) });
  }
  const uniqueByName = (name: string): { unit: string; node: string } | undefined => {
    const hits = [...byKey].filter(([k]) => t3dNodeName(k) === name);
    return hits.length === 1 ? hits[0]![1] : undefined;
  };
  const unitIds = Object.keys(sm.units);
  const out: Diagnostic[] = [];
  const fallbackOfUnowned = new Set<Diagnostic>();
  let located = false;
  for (const m of messages) {
    if (m.asset !== null && m.asset !== asset) continue;
    if (m.node !== undefined) {
      const hit = m.graph !== undefined ? byKey.get(t3dNodeKey(m.graph, m.node)) : (byKey.get(m.node) ?? uniqueByName(m.node));
      const span = hit ? sm.units[hit.unit]?.nodes[hit.node]?.span : undefined;
      if (hit && span) {
        out.push({ severity: "error", code: "ABFC6001", message: `[Unreal] ${m.message}`, span, asset });
      } else {
        out.push({ severity: "error", code: "ABFC6002", message: `[Unreal] ${m.message} (${m.node}, hand-made)`, asset });
      }
      continue;
    }
    const specMatch = SPEC_PREFIX.exec(m.message);
    if (specMatch) {
      const key = specIds[specMatch[1]!];
      const slash = key === undefined ? -1 : key.indexOf("/");
      const span = key !== undefined && slash > 0 ? sm.units[key.slice(0, slash)]?.nodes[key.slice(slash + 1)]?.span : undefined;
      if (span) {
        out.push({ severity: "error", code: "ABFC6001", message: `[Unreal] ${m.message.replace(SPEC_PREFIX_ALL, "")}`, span, asset });
        located = true;
        continue;
      }
    }
    const fn = NO_FUNCTION.exec(m.message)?.[1];
    const calls = fn === undefined ? [] : (ownCalls[fn] ?? []);
    if (calls.length > 0) {
      for (const span of calls) out.push({ severity: "error", code: "ABFC6001", message: `[Unreal] ${m.message.replace(SPEC_PREFIX_ALL, "")}`, span, asset });
      located = true;
      continue;
    }
    const text = m.message.replace(SPEC_PREFIX_ALL, "");
    let d: Diagnostic;
    if (unitIds.length === 1) {
      d = { severity: "error", code: "ABFC6002", message: `[Unreal] ${text} (node not identified)`, span: sm.units[unitIds[0]!]!.span, asset };
    } else {
      d = { severity: "error", code: "ABFC6002", message: `[Unreal] ${text}`, asset };
    }
    out.push(d);
    if (m.asset === null) fallbackOfUnowned.add(d);
  }
  return located && fallbackOfUnowned.size > 0 ? out.filter((d) => !fallbackOfUnowned.has(d)) : out;
}

/**
 * Puts the compile errors that caused a failure before their echo. Unreal compiles the applied Blueprints together: one function that
 * fails to compile (an int linked to a float pin) leaves it missing, and every call to an own function in every class then reports
 * `Could not find a function named "X"`. When other errors exist, those come first and the echoes are folded into one error per
 * missing function (at its first call, with the number of calls); otherwise the list is unchanged.
 */
export function orderCompileDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  const missingFn = (d: Diagnostic): string | undefined => (d.severity === "error" ? NO_FUNCTION.exec(d.message)?.[1] : undefined);
  const primary = ds.filter((d) => missingFn(d) === undefined);
  if (!primary.some((d) => d.severity === "error") || primary.length === ds.length) return ds;
  const byFn = new Map<string, Diagnostic[]>();
  for (const d of ds) {
    const fn = missingFn(d);
    if (fn !== undefined) byFn.set(fn, [...(byFn.get(fn) ?? []), d]);
  }
  const folded = [...byFn].map(([fn, list]) => {
    const first = list[0]!;
    const assets = new Set(list.map((d) => d.asset ?? ""));
    const where = list.length === 1 ? "1 call" : `${list.length} calls${assets.size > 1 ? ` in ${assets.size} assets` : ""}`;
    return {
      ...first,
      message: `[Unreal] Could not find a function named "${fn}" (${where}; most likely an echo of the errors above: a function that fails to compile is missing for every caller)`,
    };
  });
  return [...primary, ...folded];
}

const SPEC_PREFIX = /\[spec:([A-Za-z0-9_]+)\]/;
const SPEC_PREFIX_ALL = /\[spec:[A-Za-z0-9_]+\]\s*/g;
const NO_FUNCTION = /Could not find a function named "([^"]+)"/;
