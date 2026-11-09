// P5 two-phase route for backends without native `pin_types`: apply, read the rolled-back graph text, patch the
// wildcard pins to their real types, then apply the whole graph as a raw block (design 7.3).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AbfcError } from "@abfc/env";
import { extractGraphBlock, patchWildcardPins } from "@abfc/ir";
import type { BpApplyAssetSpec } from "./adapter.js";
import type { Backend, BpApplyResult, CompileMessage } from "./types.js";

export interface WildcardPatchRef {
  /** Index of the graph in `spec.graphs`. */
  graphIndex: number;
  /** Node id as written in the spec. */
  specNode: string;
  pin: string;
  type: string;
}

export interface FallbackAsset {
  spec: BpApplyAssetSpec;
  patches: WildcardPatchRef[];
}

export interface FallbackOutcome {
  ok: boolean;
  /** The result whose run directory holds the final text (phase A when it succeeded, else phase B). */
  last: BpApplyResult;
  /** Per asset (spec order): `graph:<k>` -> spec node id -> real node name, from phase A. */
  nodeIds: Array<Record<string, Record<string, string>>>;
  errors: CompileMessage[];
}

export interface FallbackOptions {
  cacheDir: string;
  record(step: string, seconds: number): void;
}

function fail(code: string, message: string, fix?: string): AbfcError {
  return new AbfcError({ severity: "error", code, message, ...(fix === undefined ? {} : { fix }) });
}

/**
 * The errors of a failed apply. Messages about the backend's scratch Blueprint (`_McpTmp`) are not about the user's asset. The
 * real backend always sets `error` when an apply fails (a summary like "1 compile error(s)" next to the compile messages), so
 * the apply error only stands in when no real compile message is left (e.g. a spec error aborts before anything compiles).
 */
export function applyErrors(r: BpApplyResult, asset: string | null = null): CompileMessage[] {
  const real = r.compile.errors.filter((e) => !(e.asset ?? "").includes("/_McpTmp/"));
  if (real.length > 0) return real;
  return r.error ? [{ asset, message: r.error }] : [];
}

export async function applyTwoPhase(
  backend: Backend,
  mod: string,
  assets: FallbackAsset[],
  classMeta: Record<string, string>,
  o: FallbackOptions,
): Promise<FallbackOutcome> {
  const a = await backend.applySpecs(mod, assets.map((x) => x.spec), { label: "main-a", cacheDir: o.cacheDir });
  o.record("apply.phaseA", a.seconds);
  const nodeIds = assets.map((x, i) => (a.assets?.find((r) => r.asset === x.spec.asset) ?? a.assets?.[i])?.node_ids ?? {});
  if (a.ok) return { ok: true, last: a, nodeIds, errors: [] };

  const errors = applyErrors(a);
  const undetermined = errors.filter((e) => /undetermined/i.test(e.message));
  const other = errors.filter((e) => !/undetermined/i.test(e.message));
  if (other.length > 0 || undetermined.length === 0) return { ok: false, last: a, nodeIds, errors: other.length > 0 ? other : errors };

  const rawSpecs: BpApplyAssetSpec[] = assets.map((x, i) => {
    if (x.patches.length === 0) return x.spec;
    const finalFile = join(a.run, `final_${i}.t3d`);
    if (!existsSync(finalFile)) {
      throw fail("ABFC4003", `the two-phase fallback needs ${finalFile}, which the backend did not write.`, "update the backend checkout (see docs/backend.md).");
    }
    const text = readFileSync(finalFile, "utf8");
    let patched = 0;
    const raw = (x.spec.graphs ?? []).map((g, k) => {
      const ids = nodeIds[i]?.[`graph:${k}`] ?? {};
      const patches = x.patches.filter((p) => p.graphIndex === k).map((p) => {
        const real = ids[p.specNode];
        if (real === undefined) throw fail("ABFC4004", `no real node name for ${p.specNode} in ${x.spec.asset} graph ${g.graph}.`);
        return { node: real, pin: p.pin, type: p.type };
      });
      const block = extractGraphBlock(text, g.graph);
      const res = patchWildcardPins(block, patches, classMeta);
      patched += res.patched;
      return { kind: "graph" as const, graph: g.graph, text: res.text };
    });
    if (patched !== x.patches.length) {
      throw fail("ABFC4004", `patched ${patched} of ${x.patches.length} wildcard pins in ${x.spec.asset}.`, "the editor export format may have changed, so the two-phase wildcard-pin route could not match every pin; resolve the pin types in the backend (native node kinds) or update the patcher.");
    }
    const spec: BpApplyAssetSpec = { asset: x.spec.asset, raw };
    if (x.spec.create) spec.create = x.spec.create;
    if (x.spec.interfaces) spec.interfaces = x.spec.interfaces;
    if (x.spec.components) spec.components = x.spec.components;
    if (x.spec.variables) spec.variables = x.spec.variables;
    if (x.spec.remove_functions) spec.remove_functions = x.spec.remove_functions;
    if (x.spec.functions) spec.functions = x.spec.functions;
    return spec;
  });

  const b = await backend.applySpecs(mod, rawSpecs, { label: "main-b", cacheDir: o.cacheDir });
  o.record("apply.phaseB", b.seconds);
  return { ok: b.ok, last: b, nodeIds, errors: b.ok ? [] : applyErrors(b) };
}
