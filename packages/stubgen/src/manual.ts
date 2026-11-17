// Stubs for the mod's own hand-made assets: one `<Asset>_Manual` interface per asset plus the generated class.
import { displayNameOf, parseExport, userPins } from "@abfc/ir";
import { describeFunction, loadDescriptions } from "./describe.js";
import { FileBuilder, jsdoc } from "./imports.js";
import { buildSignature } from "./signature.js";
import { UOBJECT_PATH, ident, memberKey, moduleSpecifier, stubFile, tsIdent } from "./names.js";
import { isUnsupported, normalizeGrammar, refsOfGrammar, tsOfGrammar, unsupportedLabel } from "./typemap.js";
import type { TypeRef } from "./typemap.js";

export const STUBGEN_VERSION = "0.7.0";

export interface ManualPin {
  name: string;
  type: string;
}

export interface ManualAsset {
  /** `/Mod/a/X` */
  asset: string;
  /** `/Mod/a/X.X_C` */
  classPath: string;
  /** Meta class path of the generated class. */
  meta: string;
  parent: string | null;
  /** `replicated` is set when the variable has CPF_Net (0x20) in its `PropertyFlags`. */
  variables: Array<ManualPin & { replicated?: true }>;
  /** Designer widgets of a Widget Blueprint with `bIsVariable=True`: name and widget class path. Emitted as `readonly` members. */
  widgets: Array<{ name: string; cls: string }>;
  /**
   * Components the asset adds itself (its construction script; `structure.components` rows that are not inherited or
   * native): name and component class path. Emitted as `readonly` members; components of the parent come from its stub.
   */
  components?: Array<{ name: string; cls: string }>;
  functions: Array<{ name: string; inputs: ManualPin[]; outputs: ManualPin[] }>;
  /** `net` is set for replicated custom events (FUNC_Net 0x40 in the head line `FunctionFlags=`). */
  events: Array<{ name: string; params: ManualPin[]; net?: { kind: "server" | "client" | "multicast"; reliable: boolean } }>;
  /** What abfc owns in this asset: unit ids (`event:UpdateTarget`) and variable names. */
  owned: { units: string[]; variables: string[] };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function pins(v: unknown): ManualPin[] {
  if (!Array.isArray(v)) return [];
  const out: ManualPin[] = [];
  for (const p of v) {
    if (isObj(p) && typeof p.name === "string") out.push({ name: p.name, type: typeof p.type === "string" ? p.type : "unsupported:unknown" });
  }
  return out;
}

/**
 * Map and set types of an export keep their former stub form (`unsupported:<key>:Map` / `unsupported:<element>:Set`), so
 * the generated stubs of hand-made assets do not change with the container support of the grammar.
 */
function legacyStubType(t: string): string {
  const m = /^(map|set):([^:]+)/.exec(t);
  return m?.[1] !== undefined && m[2] !== undefined ? `unsupported:${m[2]}:${m[1] === "map" ? "Map" : "Set"}` : t;
}

/** CPF_Net (0x20) in a raw `PropertyFlags` value; flags can exceed 2^53, so they are parsed as BigInt. */
function isReplicated(raw: string | null): boolean {
  return raw !== null && /^\d+$/.test(raw) && (BigInt(raw) & 0x20n) !== 0n;
}

/** The RPC kind of custom-event `FunctionFlags`: FUNC_Net (0x40) with NetServer, NetClient or NetMulticast; reliable = FUNC_NetReliable (0x80). */
function netOfFlags(flags: bigint): { kind: "server" | "client" | "multicast"; reliable: boolean } | null {
  if ((flags & 0x40n) === 0n) return null;
  const kind = (flags & 0x200000n) !== 0n ? "server" : (flags & 0x1000000n) !== 0n ? "client" : (flags & 0x4000n) !== 0n ? "multicast" : null;
  return kind === null ? null : { kind, reliable: (flags & 0x80n) !== 0n };
}

/**
 * `exportText` is the `<run>/export.t3d` of `bp_read`, `structure` its JSON result (`blueprint.class`, `functions`).
 * Variables, parent class and custom events come from the export, functions from the structure.
 */
export function manualFromExport(
  asset: string,
  exportText: string,
  structure: unknown,
  owned: { units: string[]; variables: string[] },
): ManualAsset {
  const ex = parseExport(exportText);
  const st = isObj(structure) ? structure : {};
  const bp = isObj(st.blueprint) ? st.blueprint : {};
  const meta =
    bp.class === "WidgetBlueprint" ? "/Script/UMG.WidgetBlueprintGeneratedClass" : "/Script/Engine.BlueprintGeneratedClass";
  const short = asset.slice(asset.lastIndexOf("/") + 1);
  const events: ManualAsset["events"] = [];
  for (const n of ex.nodes.values()) {
    if (n.graph !== "EventGraph" || !n.cls.endsWith("K2Node_CustomEvent")) continue;
    let name: string | null = null;
    let flags: bigint | null = null;
    for (const h of n.head) {
      const m = /^CustomFunctionName="([^"]*)"/.exec(h);
      if (m?.[1] !== undefined) name = m[1];
      const f = /^FunctionFlags=(\d+)/.exec(h);
      if (f?.[1] !== undefined) flags = BigInt(f[1]);
    }
    if (name !== null) {
      const ev: ManualAsset["events"][number] = {
        name,
        params: userPins(n).outs.map((p) => ({ name: p.name, type: legacyStubType(p.type) })),
      };
      const net = flags === null ? null : netOfFlags(flags);
      if (net) ev.net = net;
      events.push(ev);
    }
  }
  const components: Array<{ name: string; cls: string }> = [];
  if (Array.isArray(st.components)) {
    for (const c of st.components) {
      if (!isObj(c) || typeof c.name !== "string" || typeof c.class !== "string") continue;
      if (c.name === "None" || c.inherited === true || c.native === true) continue;
      if (ex.variables.some((v) => v.name === c.name) || components.some((o) => o.name === c.name)) continue;
      components.push({ name: c.name, cls: c.class });
    }
  }
  const functions: ManualAsset["functions"] = [];
  if (Array.isArray(st.functions)) {
    for (const f of st.functions) {
      if (isObj(f) && typeof f.name === "string") functions.push({ name: f.name, inputs: pins(f.inputs), outputs: pins(f.outputs) });
    }
  }
  return {
    asset,
    classPath: `${asset}.${short}_C`,
    meta,
    parent: ex.parentClass,
    variables: ex.variables.map((v) => {
      const out: ManualAsset["variables"][number] = { name: v.name, type: legacyStubType(v.type) };
      if (isReplicated(v.propertyFlags)) out.replicated = true;
      return out;
    }),
    widgets: ex.widgets.filter((w) => w.isVariable && !ex.variables.some((v) => v.name === w.name)).map((w) => ({ name: w.name, cls: w.cls })),
    ...(components.length > 0 ? { components } : {}),
    functions,
    events,
    owned,
  };
}

/** Every type path the asset's stub mentions, for the opaque closure. */
export function manualReferences(m: ManualAsset): TypeRef[] {
  const refs: TypeRef[] = [{ path: m.parent ?? UOBJECT_PATH, kind: "class" }];
  const add = (t: string): void => void refs.push(...refsOfGrammar(normalizeGrammar(t)));
  for (const v of m.variables) add(v.type);
  for (const w of m.widgets) refs.push({ path: w.cls, kind: "class" });
  for (const c of m.components ?? []) refs.push({ path: c.cls, kind: "class" });
  for (const f of m.functions) for (const p of [...f.inputs, ...f.outputs]) add(p.type);
  for (const e of m.events) for (const p of e.params) add(p.type);
  return refs;
}

/** A designer widget as a non-null `readonly` member: `@bpWidget` marks it, abfc never owns it. */
export function widgetMember(classPath: string, name: string, typeCls: string, fb: FileBuilder, declaredCls: string = typeCls): string {
  const tags = [`@bpPath ${classPath}:${name}`, `@bpType object:${declaredCls}`, "@bpWidget", "@bpHandMade"];
  return jsdoc(tags, "  ") + `  readonly ${memberKey(name)}: ${fb.ref(typeCls, "class")};\n`;
}

/** A component the asset adds itself, as a non-null `readonly` member: `@bpComponent` marks it, abfc never owns it. */
export function componentMember(classPath: string, name: string, cls: string, fb: FileBuilder): string {
  const tags = [`@bpPath ${classPath}:${name}`, `@bpType object:${cls}`, "@bpComponent", "@bpHandMade"];
  return jsdoc(tags, "  ") + `  readonly ${memberKey(name)}: ${fb.ref(cls, "class")};\n`;
}

/** The stub file of one hand-made asset: `{ file: "Mod/<mod>/<a/X>.d.ts", text }`. */
export function emitManual(m: ManualAsset, header?: string): { file: string; text: string } {
  const spec = moduleSpecifier(m.classPath);
  const fb = new FileBuilder(spec, [m.classPath]);
  const short = m.asset.slice(m.asset.lastIndexOf("/") + 1);
  const manualName = `${ident(short)}_Manual`;
  const className = tsIdent(m.classPath);
  const ownedUnits = new Set(m.owned.units);
  const ownedVars = new Set(m.owned.variables);

  const table = loadDescriptions();
  const handMade = (kind: "function" | "event", name: string): string =>
    table.functions[`${m.classPath}:${name}`] !== undefined
      ? describeFunction(table, m.classPath, name)
      : `Hand-made ${kind} of ${short} (${displayNameOf(name)}).`;

  const body: string[] = [];
  for (const v of m.variables) {
    if (ownedVars.has(v.name)) continue;
    const g = normalizeGrammar(v.type);
    const tags = [`@bpPath ${m.classPath}:${v.name}`, `@bpType ${g}`];
    if (isUnsupported(g)) tags.push(`@bpUnsupported ${unsupportedLabel(g)}`);
    if (v.replicated) tags.push("@bpReplicated");
    tags.push("@bpHandMade");
    body.push(jsdoc(tags, "  ") + `  ${memberKey(v.name)}: ${tsOfGrammar(g, fb)};\n`);
  }
  for (const w of m.widgets) body.push(widgetMember(m.classPath, w.name, w.cls, fb));
  for (const c of m.components ?? []) body.push(componentMember(m.classPath, c.name, c.cls, fb));
  for (const f of m.functions) {
    if (ownedUnits.has(`function:${f.name}`)) continue;
    const sig = buildSignature(
      f.inputs.map((p) => ({ pin: p.name, grammar: normalizeGrammar(p.type) })),
      f.outputs.map((p) => ({ pin: p.name, grammar: normalizeGrammar(p.type) })),
      [],
      fb,
    );
    body.push(jsdoc([handMade("function", f.name), `@bpPath ${m.classPath}:${f.name}`, ...sig.tags, "@bpHandMade"], "  ") + `  ${memberKey(f.name)}(${sig.params}): ${sig.ret};\n`);
  }
  for (const e of m.events) {
    if (ownedUnits.has(`event:${e.name}`)) continue;
    const sig = buildSignature(e.params.map((p) => ({ pin: p.name, grammar: normalizeGrammar(p.type) })), [], [], fb);
    const net = e.net ? [`@bpRpc ${e.net.kind}`, ...(e.net.reliable ? ["@bpReliable"] : [])] : [];
    body.push(jsdoc([handMade("event", e.name), `@bpPath ${m.classPath}:${e.name}`, ...sig.tags, ...net, "@bpHandMade"], "  ") + `  ${memberKey(e.name)}(${sig.params}): void;\n`);
  }

  const parentName = fb.ref(m.parent ?? UOBJECT_PATH, "class");
  const out: string[] = [];
  out.push(header ?? `// generated by abfc generate ${STUBGEN_VERSION}; do not edit, never commit`);
  out.push(...fb.renderImports());
  out.push("");
  out.push(`export interface ${manualName} {\n${body.join("")}}\n`);
  out.push(jsdoc([`@bpPath ${m.classPath}`, `@bpMeta ${m.meta}`], "") + `export declare class ${className} extends ${parentName} {}\n`);
  out.push(`export interface ${className} extends ${manualName} {}\n`);
  return { file: stubFile(spec), text: out.join("\n") };
}
