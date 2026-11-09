import type { Diagnostic, IrModule, Span } from "@abfc/ir";
import { EVENT_META_MAX, isClamped } from "../lower/eventmeta.js";

/** The part of the backend capabilities the feature gates look at (structural, so the compiler does not depend on the backend package). */
export interface GateCapabilities {
  containerTypes: { map: boolean; set: boolean };
  createKinds: string[];
  /** bp_apply feature `event_meta`; absent counts as false. */
  eventMeta?: boolean;
  /** bp_apply feature `function_graphs`; absent counts as false. */
  functionGraphs?: boolean;
  /** bp_apply feature `interfaces`; absent counts as false. */
  interfaces?: boolean;
  /** bp_apply feature `components`; absent counts as false. */
  components?: boolean;
}

/**
 * Feature gates: ABFC2044 for every Map or Set type (variable, struct field, local or pin type) the backend or abfc's native policy
 * does not allow, and for every asset created as a kind the backend cannot create. Runs before the stage is touched.
 */
export function featureGates(ir: IrModule, caps: GateCapabilities): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const need = (kind: "map" | "set", type: string, asset: string, span: Span): void => {
    if (caps.containerTypes[kind]) return;
    const key = `${asset}\n${kind}\n${type}\n${span.file}:${span.line}:${span.col}`;
    if (seen.has(key)) return;
    seen.add(key);
    const shown = kind === "map" ? "Map<...>" : "Set<...>";
    out.push({
      severity: "error",
      code: "ABFC2044",
      asset,
      span,
      message: `${shown} (${type}) needs a backend with ${kind} support (backend_info containerTypes.${kind} and abfc's native ${kind} policy); update the backend or remove the ${kind}.`,
    });
  };
  const check = (type: string, asset: string, span: Span): void => {
    if (type.startsWith("map:")) need("map", type, asset, span);
    else if (type.startsWith("set:")) need("set", type, asset, span);
  };
  for (const a of ir.assets) {
    for (const v of a.variables) check(v.type, a.path, v.origin);
    for (const v of a.structFields ?? []) check(v.type, a.path, v.origin);
    for (const u of a.units) {
      if (u.kind === "event") {
        const entry = u.nodes.find((n) => n.sem?.k === "event");
        const meta = entry?.sem?.k === "event" ? entry.sem.meta : undefined;
        if (meta !== undefined) {
          for (const field of ["tooltip", "category", "keywords"] as const) {
            const value = meta[field];
            if (value !== undefined && isClamped(value)) {
              out.push({
                severity: "warning",
                code: "ABFC2072",
                asset: a.path,
                span: u.origin,
                message: `the doc comment of @event ${u.name} is longer than ${EVENT_META_MAX} characters; its Blueprint ${field} is cut to ${EVENT_META_MAX}.`,
              });
            }
          }
        }
      }
      if (u.kind === "function" && caps.functionGraphs !== true) {
        out.push({
          severity: "error",
          code: "ABFC2044",
          asset: a.path,
          span: u.origin,
          message: `function ${u.name} needs a backend with bp_apply feature function_graphs; update abf-mod-editor-mcp`,
          fix: "update abf-mod-editor-mcp (see docs/backend.md)",
        });
      }
      if (u.kind === "event" && caps.eventMeta !== true) {
        const entry = u.nodes.find((n) => n.sem?.k === "event");
        if (entry?.sem?.k === "event" && entry.sem.meta !== undefined) {
          out.push({
            severity: "warning",
            code: "ABFC2071",
            asset: a.path,
            span: u.origin,
            message: `the doc comment of @event ${u.name} is not written as its Blueprint tooltip: the backend has no bp_apply feature event_meta (update the backend).`,
          });
        }
      }
      for (const v of u.locals) check(v.type, a.path, v.origin);
      for (const p of [...u.signature.inputs, ...u.signature.outputs]) {
        const origin = u.nodes[0]?.origin;
        if (origin) check(p.type, a.path, origin);
      }
      for (const n of u.nodes) for (const t of Object.values(n.pinTypes ?? {})) check(t, a.path, n.origin);
    }
    if ((a.interfaces?.length ?? 0) > 0 && caps.interfaces !== true) {
      const span = a.units[0]?.origin ?? a.variables[0]?.origin;
      out.push({
        severity: "error",
        code: "ABFC2044",
        asset: a.path,
        ...(span ? { span } : {}),
        message: `${a.path} implements ${a.interfaces!.join(", ")}: that needs a backend with bp_apply feature interfaces; update abf-mod-editor-mcp`,
        fix: "update abf-mod-editor-mcp (see docs/backend.md)",
      });
    }
    if ((a.components?.length ?? 0) > 0 && caps.components !== true) {
      out.push({
        severity: "error",
        code: "ABFC2044",
        asset: a.path,
        span: a.components![0]!.origin,
        message: `${a.path} has components (${a.components!.map((c) => c.name).join(", ")}): that needs a backend with bp_apply feature components; update abf-mod-editor-mcp`,
        fix: "update abf-mod-editor-mcp (see docs/backend.md)",
      });
    }
    if (a.create !== undefined && !caps.createKinds.includes(a.create.kind)) {
      const span = a.variables[0]?.origin ?? a.units[0]?.nodes[0]?.origin ?? a.structFields?.[0]?.origin;
      out.push({
        severity: "error",
        code: "ABFC2044",
        asset: a.path,
        ...(span ? { span } : {}),
        message: `${a.path} needs a backend that can create a ${a.create.kind} (backend_info bpApply createKinds and abfc's native policy).`,
      });
    }
  }
  return out;
}
