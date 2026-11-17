// Reads the `@bp*` JSDoc tags of generated stubs (design 5.1) and maps TypeScript types to bp_apply type grammar.
import ts from "typescript";
import { FUNCTION_RETURN_PIN, type BpType } from "../hir.js";
import { assetPathOf } from "./assetpaths.js";
import { udsMemberName } from "./structnames.js";

/** Tag name without the `@` -> comments, e.g. `bpPath` -> ["/Script/Engine.Actor"]. */
export type Tags = Map<string, string[]>;

export function bpTags(decl: ts.Node): Tags {
  const m: Tags = new Map();
  for (const t of ts.getJSDocTags(decl)) {
    const name = t.tagName.text;
    const text = (ts.getTextOfJSDocComment(t.comment) ?? "").trim();
    const list = m.get(name);
    if (list) list.push(text);
    else m.set(name, [text]);
  }
  return m;
}

/** Tags of every declaration of a symbol (merged declarations contribute together). */
export function bpTagsOfSymbol(sym: ts.Symbol): Tags {
  const m: Tags = new Map();
  for (const d of sym.declarations ?? []) {
    for (const [k, v] of bpTags(d)) {
      const list = m.get(k);
      if (list) list.push(...v);
      else m.set(k, [...v]);
    }
  }
  return m;
}

export function resolveAlias(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol {
  return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

export function bpPathOf(sym: ts.Symbol): string | undefined {
  return bpTagsOfSymbol(sym).get("bpPath")?.[0];
}

export function bpTypeOfMember(sym: ts.Symbol): string | undefined {
  return bpTagsOfSymbol(sym).get("bpType")?.[0];
}

/** `Owner:Name` -> both halves. */
export function splitMemberPath(path: string): { owner: string; name: string } | undefined {
  const i = path.lastIndexOf(":");
  return i < 0 ? undefined : { owner: path.slice(0, i), name: path.slice(i + 1) };
}

export interface FunctionInfo {
  owner: string;
  name: string;
  pure: boolean;
  static: boolean;
  /** Latent action (`@bpLatent`): finishes in a later frame, so it cannot run inside a Blueprint function. */
  latent: boolean;
  execOutputs: string[] | null;
  params: Array<{ tsName: string; pin: string; type: BpType; /** `@bpDefault`: the engine has a C++ default for this pin, so the argument may be omitted. */ default?: string }>;
  outs: Array<{ pin: string; type: BpType }>;
  /** TS name -> real pin name for renamed pins (`@bpPin`). */
  pinOfTs: Map<string, string>;
}

function firstWord(s: string): { head: string; rest: string } {
  const i = s.search(/\s/);
  return i < 0 ? { head: s, rest: "" } : { head: s.slice(0, i), rest: s.slice(i + 1).trim() };
}

/** Function metadata from `@bpPath <class>:<fn>`, `@bpPure`, `@bpExecOutputs`, `@bpParam`, `@bpOut`, `@bpPin`; undefined without `@bpPath`. */
export function functionInfo(sym: ts.Symbol): FunctionInfo | undefined {
  const tags = bpTagsOfSymbol(sym);
  const mp = splitMemberPath(tags.get("bpPath")?.[0] ?? "");
  if (!mp) return undefined;
  const decl = (sym.declarations ?? []).find(
    (d): d is ts.MethodDeclaration | ts.MethodSignature | ts.FunctionDeclaration =>
      ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isFunctionDeclaration(d),
  );
  const tsNames = decl ? decl.parameters.map((p) => p.name.getText()) : [];
  const defaults = new Map<string, string>();
  for (const t of tags.get("bpDefault") ?? []) {
    const { head, rest } = firstWord(t);
    try {
      const v = JSON.parse(rest) as unknown;
      if (typeof v === "string") defaults.set(head, v);
    } catch {
      // malformed tag: ignore
    }
  }
  const params = (tags.get("bpParam") ?? []).map((t, i) => {
    const { head, rest } = firstWord(t);
    const d = defaults.get(head);
    return { tsName: tsNames[i] ?? head, pin: head, type: rest, ...(d === undefined ? {} : { default: d }) };
  });
  const outs = (tags.get("bpOut") ?? []).map((t) => {
    const { head, rest } = firstWord(t);
    return { pin: head, type: rest };
  });
  const pinOfTs = new Map<string, string>();
  for (const t of tags.get("bpPin") ?? []) {
    const { head, rest } = firstWord(t);
    try {
      pinOfTs.set(head, JSON.parse(rest) as string);
    } catch {
      // malformed tag: ignore
    }
  }
  const exec = tags.get("bpExecOutputs")?.[0];
  const isStatic =
    decl !== undefined &&
    (ts.isFunctionDeclaration(decl) ? ts.isModuleBlock(decl.parent) : (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Static) !== 0);
  return {
    owner: mp.owner,
    name: mp.name,
    pure: tags.has("bpPure"),
    static: isStatic,
    latent: tags.has("bpLatent"),
    execOutputs: exec === undefined ? null : exec.split(",").map((s) => s.trim()).filter((s) => s !== ""),
    params,
    outs,
    pinOfTs,
  };
}

export const BLUEPRINT_META = "/Script/Engine.BlueprintGeneratedClass";
export const WIDGET_META = "/Script/UMG.WidgetBlueprintGeneratedClass";

/** `<path>.<AssetName>_C` for a package path. */
export function classPathOf(path: string): string {
  return `${path}.${path.slice(path.lastIndexOf("/") + 1)}_C`;
}

/**
 * Path and kind of a class declaration carrying `@blueprint({ path, kind? })`, read syntactically (decorator call whose callee
 * identifier is `blueprint`). The frontend's class pass still validates the real decorator.
 */
export function tsBlueprintOfDecl(decl: ts.ClassDeclaration): { path: string; widget: boolean } | undefined {
  for (const d of ts.getDecorators(decl) ?? []) {
    const e = d.expression;
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== "blueprint") continue;
    const path = assetPathOf(decl, "blueprint")?.path;
    if (path === undefined || path === "") continue;
    let widget = false;
    const opts = e.arguments[0];
    if (opts && ts.isObjectLiteralExpression(opts)) {
      for (const p of opts.properties) {
        if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) || p.name.text !== "kind") continue;
        const init = p.initializer;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) widget = init.text === "widget";
      }
    }
    return { path, widget };
  }
  return undefined;
}

/** `tsBlueprintOfDecl` of the first class declaration of a symbol that has one. */
export function tsBlueprintOf(sym: ts.Symbol): { path: string; widget: boolean } | undefined {
  for (const d of sym.declarations ?? []) {
    if (!ts.isClassDeclaration(d)) continue;
    const r = tsBlueprintOfDecl(d);
    if (r) return r;
  }
  return undefined;
}

/**
 * Path of a class declaration carrying `@struct({ path })`, read syntactically (decorator call whose callee identifier is `struct`).
 * `objectPath` is `<path>.<AssetName>`. undefined without the decorator or without a literal path (the frontend's class pass reports that).
 */
export function tsStructOfDecl(decl: ts.ClassDeclaration): { path: string; objectPath: string } | undefined {
  for (const d of ts.getDecorators(decl) ?? []) {
    const e = d.expression;
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== "struct") continue;
    const path = assetPathOf(decl, "struct")?.path;
    if (path === undefined || path === "" || path.endsWith("/")) continue;
    return { path, objectPath: `${path}.${path.slice(path.lastIndexOf("/") + 1)}` };
  }
  return undefined;
}

/** `tsStructOfDecl` of the first class declaration of a symbol that has one. */
export function tsStructOf(sym: ts.Symbol): { path: string; objectPath: string } | undefined {
  for (const d of sym.declarations ?? []) {
    if (!ts.isClassDeclaration(d)) continue;
    const r = tsStructOfDecl(d);
    if (r) return r;
  }
  return undefined;
}

/**
 * The Blueprint member name (`<Field>_<index>_<GUID>`) of a field of a TS `@struct` class, or undefined when the symbol is not
 * a field of one. The index is the field's declaration index among the property declarations of the class.
 */
export function tsStructMemberName(sym: ts.Symbol): string | undefined {
  for (const d of sym.declarations ?? []) {
    if (!ts.isPropertyDeclaration(d) || !ts.isIdentifier(d.name) || !ts.isClassDeclaration(d.parent)) continue;
    const s = tsStructOfDecl(d.parent);
    if (!s) continue;
    const index = d.parent.members.filter((m) => ts.isPropertyDeclaration(m)).indexOf(d);
    return udsMemberName(s.objectPath, d.name.text, index);
  }
  return undefined;
}

/** FunctionInfo of an `@event` method or an undecorated method (a Blueprint function) of a TS `@blueprint` class: what the stub's `_C` method would have given. */
export function ownEventInfo(checker: ts.TypeChecker, sym: ts.Symbol): FunctionInfo | undefined {
  const m = (sym.declarations ?? []).find((d): d is ts.MethodDeclaration => ts.isMethodDeclaration(d));
  if (!m || !ts.isIdentifier(m.name) || !ts.isClassDeclaration(m.parent)) return undefined;
  const isEvent = (ts.getDecorators(m) ?? []).some((d) => {
    const callee = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    return ts.isIdentifier(callee) && callee.text === "event";
  });
  const tb = tsBlueprintOfDecl(m.parent);
  if (!tb) return undefined;
  let outs: FunctionInfo["outs"] = [];
  if (!isEvent) {
    // an undecorated method with a body is a Blueprint function; any other decorator (or none with static/no body) is not callable this way
    if ((ts.getDecorators(m) ?? []).length > 0 || m.body === undefined) return undefined;
    if ((ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) !== 0) return undefined;
    const sig = checker.getSignatureFromDeclaration(m);
    if (!sig) return undefined;
    const rt = checker.getReturnTypeOfSignature(sig);
    if (!(rt.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never))) {
      const type = bpTypeOf(checker, rt);
      if (type === undefined) return undefined;
      outs = [{ pin: FUNCTION_RETURN_PIN, type }];
    }
  }
  const params: FunctionInfo["params"] = [];
  for (const p of m.parameters) {
    const type = bpTypeOf(checker, checker.getTypeAtLocation(p));
    if (type === undefined) return undefined;
    const name = p.name.getText();
    params.push({ tsName: name, pin: name, type });
  }
  return { owner: classPathOf(tb.path), name: m.name.text, pure: false, static: false, latent: false, execOutputs: null, params, outs, pinOfTs: new Map() };
}

export interface ClassInfo {
  path: string;
  meta: string;
  castPin: string | null;
  kind: "class" | "struct" | "enum";
  /** The class is a TS `@blueprint` class (no stub). */
  fromTs?: true;
}

const DEFAULT_META = "/Script/CoreUObject.Class";

/** Class metadata from `@bpPath`, `@bpMeta`, `@bpCastPin`, `@bpKind` (or a TS `@blueprint` class); undefined without either. */
export function classInfo(sym: ts.Symbol): ClassInfo | undefined {
  const tags = bpTagsOfSymbol(sym);
  const path = tags.get("bpPath")?.[0];
  if (path === undefined || path === "") {
    const tb = tsBlueprintOf(sym);
    if (tb) return { path: classPathOf(tb.path), meta: tb.widget ? WIDGET_META : BLUEPRINT_META, castPin: null, kind: "class", fromTs: true };
    const ts_ = tsStructOf(sym);
    if (ts_) return { path: ts_.objectPath, meta: DEFAULT_META, castPin: null, kind: "struct", fromTs: true };
    return undefined;
  }
  const k = tags.get("bpKind")?.[0];
  return {
    path,
    meta: tags.get("bpMeta")?.[0] ?? DEFAULT_META,
    castPin: tags.get("bpCastPin")?.[0] ?? null,
    kind: k === "struct" ? "struct" : k === "enum" ? "enum" : "class",
  };
}

function literalOfProperty(checker: ts.TypeChecker, type: ts.Type, prop: string): string | undefined {
  const sym = checker.getPropertyOfType(type, prop);
  if (!sym) return undefined;
  const t = checker.getTypeOfSymbol(sym);
  const members = t.isUnion() ? t.types : [t];
  const lits = members.filter((m): m is ts.StringLiteralType => m.isStringLiteral()).map((m) => m.value);
  // `float` is branded "float" | "double" (a float pin takes a double); it is still a float
  if (prop === "__bpNumber" && lits.includes("float")) return "float";
  return lits[0];
}

/** Union members without null/undefined (a boolean union stays one member). */
function withoutNullish(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  return checker.getNonNullableType(type);
}

/** `TSubclassOf<T>` / `TSoftClassPtr<T>` / `TSoftObjectPtr<T>` (alone, or in a union with the class constructor) -> `class:` / `softclass:` / `softobject:`. */
function classRefType(checker: ts.TypeChecker, t: ts.Type): BpType | undefined {
  for (const m of t.isUnion() ? t.types : [t]) {
    for (const [prop, kind] of [["__bpClassOf", "class"], ["__bpSoftClassOf", "softclass"], ["__bpSoftObjectOf", "softobject"]] as const) {
      const p = checker.getPropertyOfType(m, prop);
      if (!p) continue;
      const inner = checker.getNonNullableType(checker.getTypeOfSymbol(p)).getSymbol();
      const ci = inner ? classInfo(inner) : undefined;
      if (ci && ci.kind !== "struct" && ci.kind !== "enum") return `${kind}:${ci.path}`;
    }
  }
  return undefined;
}

/**
 * Blueprint type of a TypeScript type: flavors (`__bpNumber`, `__bpString`, `__bpEnum`), booleans, Blueprint classes and structs
 * (`@bpPath`), arrays. undefined when the type has no Blueprint meaning (plain `number`, unions of classes, ...).
 */
export function bpTypeOf(checker: ts.TypeChecker, type: ts.Type): BpType | undefined {
  const t = withoutNullish(checker, type);
  if (t.flags & ts.TypeFlags.BooleanLike) return "bool";
  if (checker.isArrayType(t)) {
    const arg = checker.getTypeArguments(t as ts.TypeReference)[0];
    const inner = arg ? bpTypeOf(checker, arg) : undefined;
    return inner === undefined || /^(map|set):/.test(inner) ? undefined : `array:${inner}`;
  }
  const csym = t.getSymbol();
  if ((csym?.name === "Map" || csym?.name === "Set") && t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
    const args = checker.getTypeArguments(t as ts.TypeReference);
    const want = csym.name === "Map" ? 2 : 1;
    if (args.length !== want) return undefined;
    const inner = args.map((a) => bpTypeOf(checker, a));
    if (inner.some((x) => x === undefined || /^(array|map|set):/.test(x))) return undefined;
    return want === 2 ? `map:${inner[0]}:${inner[1]}` : `set:${inner[0]}`;
  }
  const num = literalOfProperty(checker, t, "__bpNumber");
  if (num !== undefined) return num;
  const str = literalOfProperty(checker, t, "__bpString");
  if (str !== undefined) return str;
  const en = literalOfProperty(checker, t, "__bpEnum");
  if (en !== undefined) return `enum:${en}`;
  if (t.flags & ts.TypeFlags.StringLike) return "string";
  const ref = classRefType(checker, t);
  if (ref !== undefined) return ref;
  const sym = t.getSymbol();
  if (sym) {
    const ci = classInfo(sym);
    if (ci) return ci.kind === "struct" ? `struct:${ci.path}` : ci.kind === "enum" ? `enum:${ci.path}` : `object:${ci.path}`;
  }
  return undefined;
}
