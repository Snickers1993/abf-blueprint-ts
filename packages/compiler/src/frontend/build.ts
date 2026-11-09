// HIR builder: checks the TypeScript subset and resolves every name through the stub tags.
import ts from "typescript";
import { BpTypeError, DEFAULT_CLASS_MANAGER_TABLE, DIRECTOR_TAG_PREFIX, gameplayTagProblem, joinModPath, parseBpType, segmentProblem } from "@abfc/ir";
import type { Diagnostic, Profile, Span } from "@abfc/ir";
import type { BpType, HirClass, HirEvent, HirField, HirExpr, HirProgram, HirStmt, HirStruct, LocalId } from "../hir.js";
import { assetPathOf, bindPathContext, modImportHints, pathContextOf } from "./assetpaths.js";
import type { AssetPathInfo, CompilerProjectConfig } from "./assetpaths.js";
import { DiagSink, Fail, relFile, spanOf } from "./diag.js";
import type { LoadedProgram } from "./program.js";
import { BLUEPRINT_META, WIDGET_META, bpPathOf, bpTagsOfSymbol, bpTypeOf, bpTypeOfMember, classInfo, classPathOf, functionInfo, ownEventInfo, resolveAlias, splitMemberPath, tsStructMemberName } from "./tags.js";
import { udsMemberName } from "./structnames.js";
import { placeholdersOfType } from "./opaqueuse.js";
import type { FunctionInfo } from "./tags.js";

export { classPathOf } from "./tags.js";

const USER_WIDGET = "/Script/UMG.UserWidget";
const ACTOR_COMPONENT = "/Script/Engine.ActorComponent";
const NUMERIC = new Set(["int", "int64", "byte", "float", "double", "real"]);
const STRINGY = new Set(["name", "text", "string"]);
/** `@blueprint` options that set class defaults (applied by the class-defaults pass). */
const CLASS_OPTIONS = new Set(["replicates", "alwaysRelevant", "onlyRelevantToOwner", "netUpdateFrequency", "minNetUpdateFrequency", "tickInterval", "kind"]);
/** Boolean class options -> class default (T3D property name). */
const BOOL_DEFAULTS: Record<string, string> = {
  replicates: "bReplicates",
  alwaysRelevant: "bAlwaysRelevant",
  onlyRelevantToOwner: "bOnlyRelevantToOwner",
};
/** Number class options -> class default (T3D property name). */
const NUMBER_DEFAULTS: Record<string, string> = {
  netUpdateFrequency: "NetUpdateFrequency",
  minNetUpdateFrequency: "MinNetUpdateFrequency",
  tickInterval: "TickInterval",
};
/** Class options that only exist on an Actor (the parent chain must reach `/Script/*.Actor`). */
const ACTOR_ONLY_OPTIONS = new Set(["alwaysRelevant", "onlyRelevantToOwner", "netUpdateFrequency", "minNetUpdateFrequency", "tickInterval"]);
const ARRAY_OWN_ONLY = "an array can only be changed as a statement on an own array variable: this.<Array>.push(x), this.<Array>.splice(i, 1) or this.<Array>.length = 0";
const CONTAINERS = new Set(["Map", "Set", "WeakMap", "WeakSet", "ReadonlyMap", "ReadonlySet"]);
const CONTAINER_OWN_ONLY = "a Map or Set can only be used through an own field: this.<Field>.set(k, v), this.<Field>.has(k), this.<Field>.size, ...";
/** Statement methods of a native Map / Set and the operation they lower to. */
const MAP_MUTATORS = new Map<string, "add" | "remove" | "clear">([["set", "add"], ["delete", "remove"], ["clear", "clear"]]);
const SET_MUTATORS = new Map<string, "add" | "remove" | "clear">([["add", "add"], ["delete", "remove"], ["clear", "clear"]]);

/** Key (or set element) and value type of a `map:<K>:<V>` / `set:<T>` Blueprint type. */
function splitContainerType(type: string): { key: string; value: string } {
  if (type.startsWith("set:")) return { key: type.slice(4), value: "" };
  const rest = type.slice(4);
  const sep = rest.indexOf(":");
  return { key: rest.slice(0, sep), value: rest.slice(sep + 1) };
}

type EqKind = "object" | "name" | "string" | "int" | "real" | "bool" | "byte";

/** A TypeScript `enum` declaration cannot become a Blueprint enum (the asset kind is not created yet): say so and name the way out. */
const TS_ENUM_HINT = "a TypeScript enum has no Blueprint equivalent (abfc cannot create Blueprint enums yet); use an int or byte field, or an enum of the game or the engine";

export function kindOfBpType(t: string): EqKind | undefined {
  if (t === "bool") return "bool";
  if (t === "int" || t === "int64") return "int";
  if (t === "byte" || t.startsWith("enum:")) return "byte";
  if (t === "float" || t === "double" || t === "real") return "real";
  if (t === "name") return "name";
  if (t === "string") return "string";
  if (t.startsWith("object:") || t.startsWith("class:") || t.startsWith("interface:")) return "object";
  return undefined;
}

interface LocalInfo {
  id: LocalId;
  name: string;
  type: BpType;
  poison: boolean;
  /** Set for locals that hold a multi-output / exec-output call result. */
  fn?: FunctionInfo;
}

/** `{ module, name }` of an import specifier an identifier refers to (undefined for anything else). */
export function importOf(checker: ts.TypeChecker, id: ts.Identifier): { module: string; name: string } | undefined {
  const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
  if (decl && ts.isImportSpecifier(decl)) {
    const spec = decl.parent.parent.parent.moduleSpecifier;
    if (ts.isStringLiteral(spec)) return { module: spec.text, name: (decl.propertyName ?? decl.name).text };
  }
  return undefined;
}

/** Name of the `@abfc/runtime` function a decorator or call expression refers to. */
export function runtimeName(checker: ts.TypeChecker, expr: ts.Expression): string | undefined {
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  if (!ts.isIdentifier(callee)) return undefined;
  const imp = importOf(checker, callee);
  return imp && imp.module === "@abfc/runtime" ? imp.name : undefined;
}

/** Asset path of a class declaration carrying `@blueprint(...)`: the `path` option, else the path derived from the file location. */
export function blueprintPathOf(checker: ts.TypeChecker, decl: ts.ClassDeclaration): string | undefined {
  for (const d of ts.getDecorators(decl) ?? []) {
    if (runtimeName(checker, d.expression) !== "blueprint" || !ts.isCallExpression(d.expression)) continue;
    return assetPathOf(decl, "blueprint")?.path;
  }
  return undefined;
}

/** Reports the problems of an asset path; true when one of them is an error. */
function reportPathProblems(sink: DiagSink, info: AssetPathInfo, mapCode?: (code: string) => string): boolean {
  let failed = false;
  for (const p of info.problems) {
    sink.report(p.severity, mapCode ? mapCode(p.code) : p.code, p.message, p.node);
    if (p.fix !== undefined) sink.diagnostics[sink.diagnostics.length - 1]!.fix = p.fix;
    if (p.severity === "error") failed = true;
  }
  return failed;
}

function children(e: HirExpr): HirExpr[] {
  switch (e.k) {
    case "getOn": return [e.obj];
    case "field": return [e.obj];
    case "out": return [e.call];
    case "call": return [...(e.target ? [e.target] : []), ...e.args.map((a) => a.value)];
    case "cast": return [e.value];
    case "optional": return [e.value, e.then];
    case "isValid": return [e.value];
    case "eq": return [e.a, e.b];
    case "not": return [e.e];
    case "and": return [e.a, e.b];
    case "or": return [e.a, e.b];
    case "length": return [e.array];
    case "callOwn": return e.args.map((a) => a.value);
    case "createWidget": return [e.owner];
    case "spawn": return [...(e.owner ? [e.owner] : []), ...(e.transform ? [e.transform] : [])];
    case "arith": return [e.a, e.b];
    case "cmp": return [e.a, e.b];
    case "index": return [e.array, e.index];
    case "arrayFind": return [e.array, e.value];
    case "containerQuery": return [e.target, ...(e.key ? [e.key] : [])];
    case "formatText": return e.args.map((a) => a.value);
    case "makeStruct": return e.fields.map((a) => a.value);
    default: return [];
  }
}

/** Text of the last JSDoc comment in front of a declaration (decorators included), or undefined. */
function docOf(node: ts.Node): string | undefined {
  const sf = node.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const docs = ranges.map((r) => sf.text.slice(r.pos, r.end)).filter((t) => t.startsWith("/**"));
  const last = docs[docs.length - 1];
  if (last === undefined) return undefined;
  const body = last
    .slice(3, last.length - 2)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*? ?/, "").trimEnd());
  const text = body.join("\n").trim();
  return text === "" ? undefined : text;
}

/** Signature of an owned `@event`/`@override` method or undecorated method (a function), known before any body is built (calls can point forward). */
interface OwnSig {
  node: ts.MethodDeclaration;
  kind: "event" | "override" | "function";
  params: HirEvent["params"];
  /** Functions: the Blueprint type of the return value; absent = void. */
  returnType?: BpType;
  /** Functions: the access specifier. */
  access?: "public" | "protected" | "private";
  /** The TypeScript parameter symbols, in order (for binding the body). */
  paramSyms: Array<ts.Symbol | undefined>;
  overrideOf?: string;
}

/** Array methods that change the array; they are statements on an own array variable only. */
const ARRAY_MUTATORS = new Set(["push", "splice"]);

/** A property with neither a type annotation nor `!` (`Score = 1;`) is not an own-field attempt: it keeps the generic ABFC2099. */
function isLegacyProperty(m: ts.PropertyDeclaration): boolean {
  return m.type === undefined && m.exclamationToken === undefined;
}

function stripParens(x: ts.Expression): ts.Expression {
  let y = x;
  while (ts.isParenthesizedExpression(y)) y = y.expression;
  return y;
}

function some(e: HirExpr, pred: (x: HirExpr) => boolean): boolean {
  return pred(e) || children(e).some((c) => some(c, pred));
}

function directExprs(s: HirStmt): HirExpr[] {
  switch (s.k) {
    case "expr": return [s.e];
    case "setSelf": return [s.value];
    case "setOn": return [s.obj, s.value];
    case "bind": return s.target === null ? [s.source] : [s.source, s.target];
    case "const": return [s.init];
    case "return": return s.value ? [s.value] : [];
    case "if": return [s.cond];
    case "forOf": return [s.array];
    case "setSelfCond": return [s.cond, s.a, s.b];
    case "forCount": return [s.init, s.cond];
    case "arrayOp": return [...(s.value ? [s.value] : []), ...(s.index ? [s.index] : [])];
    case "containerOp": return [...(s.key ? [s.key] : []), ...(s.value ? [s.value] : [])];
    default: return [];
  }
}

function consumesCast(next: HirStmt, id: LocalId): boolean {
  const isLocal = (x: HirExpr): boolean => x.k === "local" && x.id === id;
  if (next.k === "if" && some(next.cond, isLocal)) return true;
  return directExprs(next).some((e) => some(e, (x) => x.k === "optional" && isLocal(x.value)));
}

function consumesExec(next: HirStmt, id: LocalId): boolean {
  return next.k === "if" && some(next.cond, (x) => x.k === "execIs" && x.local === id);
}

class HirBuilder {
  readonly sink: DiagSink;
  readonly classMeta: Record<string, string> = {};
  readonly classes: HirClass[] = [];
  readonly structs: HirStruct[] = [];
  private readonly checker: ts.TypeChecker;
  private readonly mod: string;

  private cls!: HirClass;
  private body!: ts.Node;
  private locals = new Map<ts.Symbol, LocalInfo>();
  private params = new Map<ts.Symbol, { name: string; type: BpType }>();
  private nextLocal = 0;
  /** Owned `@event`/`@override` methods of the class being built, by name. */
  private ownSigs = new Map<string, OwnSig>();
  /** Kind, name and return type of the unit whose body is being built (functions: no await, no latent calls, returns carry a value). */
  private unitKind: HirEvent["kind"] = "event";
  private unitName = "";
  private unitReturn: BpType | undefined;
  /** Calls between the owned units of the class being built: caller -> callees (for the recursion check). */
  private ownCalls = new Map<string, Set<string>>();
  /** Name node of every owned function of the class being built. */
  private fnNames = new Map<string, ts.Identifier>();
  /** Own fields (`Name!: T;`) by the symbol of their declaration. */
  private ownFields = new Map<ts.Symbol, HirField>();
  private holes = new Map<ts.Node, HirExpr>();
  private handled = new Set<ts.Node>();
  private readonly callInfo = new WeakMap<object, FunctionInfo>();

  constructor(loaded: LoadedProgram, mod: string) {
    this.checker = loaded.checker;
    this.mod = mod;
    this.sink = new DiagSink(loaded.projectDir);
  }

  private sp(node: ts.Node): Span {
    return spanOf(node, this.sink.root);
  }

  // ---- classes ----

  classDecl(node: ts.ClassDeclaration): void {
    const bp = (ts.getDecorators(node) ?? []).find((d) => runtimeName(this.checker, d.expression) === "blueprint");
    const st = (ts.getDecorators(node) ?? []).find((d) => runtimeName(this.checker, d.expression) === "struct");
    if (st) {
      if (bp) this.sink.error("ABFC2046", `${node.name?.text ?? "(anonymous)"} cannot be both a @blueprint and a @struct`, node.name ?? node);
      else {
        this.directorOf(node, true, undefined);
        this.structDecl(node, st);
      }
      return;
    }
    if (!bp) return;
    const name = node.name?.text ?? "(anonymous)";
    let parentOption: string | undefined;
    let classManagerRow: string | undefined;
    let classManagerRowNode: ts.Node | undefined;
    let widget = false;
    const defaultOpts: Array<{ key: string; prop: string; value: string; node: ts.Node }> = [];
    const opts = ts.isCallExpression(bp.expression) ? bp.expression.arguments[0] : undefined;
    if (opts && ts.isObjectLiteralExpression(opts)) {
      for (const p of opts.properties) {
        const key = ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
        const lit = ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) ? p.initializer.text : undefined;
        if (key === "path") {
          // the asset path is resolved by assetPathOf below
        } else if (key === "parent") parentOption = lit;
        else if (key === "classManagerRow") {
          classManagerRow = lit;
          classManagerRowNode = p;
        }
        else if (key === "tickEnabled") {
          this.sink.error(
            "ABFC2063",
            `@blueprint option "tickEnabled" is not supported yet: writing the saved PrimaryActorTick.bStartWithTickEnabled has not been verified in the editor`,
            p,
          );
        } else if (key !== undefined && CLASS_OPTIONS.has(key)) {
          // class defaults: validated here, applied by the class-defaults pass (design 6.2 pass 5)
          const init = (p as ts.PropertyAssignment).initializer;
          const prop = BOOL_DEFAULTS[key] ?? NUMBER_DEFAULTS[key];
          if (prop === undefined) {
            // "kind": no class default
            if (lit === "widget") widget = true;
            else this.sink.error("ABFC2061", `@blueprint option "kind" must be "widget"`, (p as ts.PropertyAssignment).initializer);
            continue;
          }
          const isBool = BOOL_DEFAULTS[key] !== undefined;
          if (isBool && (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword)) {
            defaultOpts.push({ key, prop, value: init.kind === ts.SyntaxKind.TrueKeyword ? "True" : "False", node: p });
          } else if (!isBool && ts.isNumericLiteral(init)) {
            defaultOpts.push({ key, prop, value: Number(init.text).toFixed(6), node: p });
          } else {
            this.sink.error("ABFC2061", `@blueprint option "${key}" must be ${isBool ? "true or false" : "a non-negative number"} written as a literal`, init);
          }
        } else this.sink.warning("ABFC2099", `@blueprint option "${key ?? "?"}" is not supported`, p);
      }
    }
    const pathInfo = assetPathOf(node, "blueprint");
    if (pathInfo === undefined) {
      this.sink.error("ABFC2001", `@blueprint path of ${name} must be a string literal under "/${this.mod}/"`, opts ?? bp);
      return;
    }
    if (reportPathProblems(this.sink, pathInfo)) return;
    const path = pathInfo.path;
    if (path === undefined) {
      this.sink.error("ABFC2001", `@blueprint path of ${name} must be a string literal under "/${this.mod}/"`, opts ?? bp);
      return;
    }

    const ext = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    let parent: string | undefined = parentOption;
    if (ext === undefined) {
      this.sink.error("ABFC2099", `${name} must extend a Blueprint or engine class`, node.name ?? node);
      return;
    }
    const extSym = this.checker.getSymbolAtLocation(ext);
    const extInfo0 = extSym ? classInfo(resolveAlias(this.checker, extSym)) : undefined;
    const extInfo = extInfo0?.fromTs ? undefined : extInfo0;
    if (extInfo === undefined) {
      this.sink.error("ABFC2060", `parent class of ${name} has no Blueprint metadata (@bpPath)`, ext);
      return;
    }
    this.classMeta[extInfo.path] = extInfo.meta;
    parent ??= extInfo.path;

    const defaults: Record<string, string> = {};
    const parentType0 = this.checker.getDeclaredTypeOfSymbol(resolveAlias(this.checker, extSym!));
    const parentIsActor = this.derivesFromActor(parentType0);
    const parentIsWidget = this.derivesFrom(parentType0, USER_WIDGET);
    if (widget && !parentIsWidget) {
      this.sink.error("ABFC2064", `${name} has kind "widget" but does not extend UserWidget`, node.name ?? node);
    } else if (!widget && parentIsWidget) {
      this.sink.error("ABFC2065", `${name} extends UserWidget: add kind: "widget" to @blueprint`, node.name ?? node);
    }
    const director = this.directorOf(node, widget || parentIsWidget, classManagerRowNode);
    if (director !== undefined && !this.derivesFromComponent(parentType0)) {
      const dec = (ts.getDecorators(node) ?? []).find((d) => runtimeName(this.checker, d.expression) === "director")!;
      this.sink.warning("ABFC2089", `${name} has @director but does not derive from ActorComponent: the game adds every director as a component of its AI director, so ${parentIsActor ? "an Actor" : "this"} class is never started. Extend ActorComponent.`, dec);
    }
    if (!(ts.getDecorators(node) ?? []).some((d) => runtimeName(this.checker, d.expression) === "director") && classManagerRow !== undefined && classManagerRowNode !== undefined && pathContextOf(node.getSourceFile())?.migrationHints === true) {
      this.sink.warning("ABFC2076", `classManagerRow is deprecated; use @director("${classManagerRow.slice(classManagerRow.lastIndexOf("/") + 1)}")`, classManagerRowNode);
      this.sink.diagnostics[this.sink.diagnostics.length - 1]!.fix = "replace classManagerRow with @director (quick fix)";
    }
    for (const o of defaultOpts) {
      if (ACTOR_ONLY_OPTIONS.has(o.key) && !parentIsActor) {
        this.sink.error("ABFC2062", `@blueprint option "${o.key}" only applies to an Actor, but ${name} does not derive from Actor`, o.node);
        continue;
      }
      defaults[o.prop] = o.value;
    }

    const cls: HirClass = {
      name,
      path,
      pathDerived: pathInfo.explicit === undefined,
      classPath: classPathOf(path),
      parent,
      family: parentIsActor ? "actor" : parentIsWidget || widget ? "widget" : this.derivesFrom(parentType0, ACTOR_COMPONENT) ? "component" : "object",
      span: this.sp(node.name ?? node),
      events: [],
      fields: [],
      manualUnits: this.manualUnits(node),
      hybrid: this.isHybrid(node),
      defaults,
      ...(classManagerRow !== undefined ? { classManagerRow } : {}),
      ...(director !== undefined ? { director } : {}),
      ...(widget ? { kind: "widget" as const } : {}),
    };
    this.classMeta[cls.classPath] = widget ? WIDGET_META : BLUEPRINT_META;

    // Signatures first: a call or delegate reference may point to an event declared further down.
    this.cls = cls;
    this.ownSigs = new Map();
    this.ownCalls = new Map();
    this.fnNames = new Map();
    const parentType = this.checker.getDeclaredTypeOfSymbol(resolveAlias(this.checker, extSym!));
    const methodKind = (m: ts.MethodDeclaration): "event" | "override" | undefined => {
      const names = (ts.getDecorators(m) ?? []).map((d) => runtimeName(this.checker, d.expression));
      return names.includes("event") ? "event" : names.includes("override") ? "override" : undefined;
    };
    // Own fields first: an event body may use a field declared further down.
    for (const m of node.members) {
      if (!ts.isPropertyDeclaration(m) || isLegacyProperty(m) || (ts.isIdentifier(m.name) && this.isDesignerWidget(node, m.name.text))) continue;
      const field = this.ownField(node, m);
      if (field === undefined) continue;
      cls.fields.push(field);
      const fsym = this.checker.getSymbolAtLocation(m.name);
      if (fsym) this.ownFields.set(fsym, field);
    }
    for (const m of node.members) {
      if (!ts.isMethodDeclaration(m) || !ts.isIdentifier(m.name) || !m.body) continue;
      const kind = methodKind(m);
      if (kind === undefined) {
        if ((ts.getDecorators(m) ?? []).length > 0 || !this.functionAllowed(m, parentType)) continue;
        const fsig = this.signature(m, "function", parentType);
        if (fsig) {
          this.ownSigs.set(m.name.text, fsig);
          this.fnNames.set(m.name.text, m.name);
        }
        continue;
      }
      if (kind === "event" && this.shadowsParentEvent(m, parentType)) continue; // ABFC2078 reported, not lowered
      if (kind === "override" && m.name.text === "UserConstructionScript") {
        this.sink.error(
          "ABFC2083",
          "UserConstructionScript cannot be overridden: Unreal refuses a Construction Script event node (ABFC6001). Put the logic in an @override of ReceiveBeginPlay or in a custom @event.",
          m.name,
        );
        continue;
      }
      const sig = this.signature(m, kind, parentType);
      if (sig) this.ownSigs.set(m.name.text, sig);
    }

    for (const m of node.members) {
      if (ts.isSemicolonClassElement(m)) continue;
      if (ts.isMethodDeclaration(m)) {
        if (methodKind(m) !== undefined) {
          const sig = ts.isIdentifier(m.name) ? this.ownSigs.get(m.name.text) : undefined;
          if (!ts.isIdentifier(m.name) || !m.body) {
            this.sink.error("ABFC2099", "an @event or @override method needs an identifier name and a body", m.name);
          } else if (sig && sig.node === m) {
            cls.events.push(this.event(m, cls, sig));
          }
        } else if ((ts.getDecorators(m) ?? []).length > 0) {
          this.sink.error("ABFC2099", `method ${m.name.getText()} has an unsupported decorator (only @event and @override are supported on a method)`, m.name);
        } else if (ts.isPrivateIdentifier(m.name)) {
          this.sink.error("ABFC2099", "private names (#x) are not supported; use the private keyword", m.name);
        } else if (!ts.isIdentifier(m.name)) {
          this.sink.error("ABFC2099", "a method needs an identifier name", m.name);
        } else if (!m.body) {
          this.sink.error("ABFC2099", `method ${m.name.text} needs a body`, m.name);
        } else {
          const sig = this.ownSigs.get(m.name.text);
          if (sig && sig.node === m) cls.events.push(this.event(m, cls, sig));
          // else: the signature pass reported why the function is not supported
        }
        continue;
      }
      if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        this.sink.error("ABFC2099", "getters and setters are not supported; write a method (getX(): T)", m.name);
        continue;
      }
      if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && this.isDesignerWidget(node, m.name.text)) {
        this.sink.error("ABFC2066", `"${m.name.text}" is a designer widget of ${path}; rename the variable`, m.name);
        continue;
      }
      if (ts.isPropertyDeclaration(m) && !isLegacyProperty(m)) continue; // own field: checked and recorded above
      this.sink.error("ABFC2099", `class member of kind ${ts.SyntaxKind[m.kind]} is not supported`, m);
    }
    this.checkRecursion();
    this.classes.push(cls);
  }

  /**
   * ABFC2085: a call cycle among the owned units of the class that contains a function. A function has no local variables in bp_apply (its
   * temporaries are member variables), so a recursive call would overwrite them. Strongly connected components (Tarjan) of the call graph:
   * one error per component that has a cycle and contains a function (also when the cycle runs through events), at the first function of
   * the component in sorted order.
   */
  private checkRecursion(): void {
    const succ = (u: string): string[] => [...(this.ownCalls.get(u) ?? [])].sort();
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let counter = 0;
    const visit = (u: string): void => {
      index.set(u, counter);
      low.set(u, counter);
      counter++;
      stack.push(u);
      onStack.add(u);
      for (const v of succ(u)) {
        if (!index.has(v)) {
          visit(v);
          low.set(u, Math.min(low.get(u)!, low.get(v)!));
        } else if (onStack.has(v)) low.set(u, Math.min(low.get(u)!, index.get(v)!));
      }
      if (low.get(u) === index.get(u)) {
        const comp: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
          if (w === u) break;
        }
        sccs.push(comp);
      }
    };
    for (const u of [...this.ownCalls.keys()].sort()) if (!index.has(u)) visit(u);

    const found: { fn: string; path: string[] }[] = [];
    for (const comp of sccs) {
      const members = new Set(comp);
      const fn = [...comp].sort().find((n) => this.fnNames.has(n));
      if (fn === undefined) continue;
      if (comp.length === 1 && !succ(fn).includes(fn)) continue;
      // shortest way from fn back to fn inside the component (sorted, so deterministic)
      const prev = new Map<string, string>();
      const queue = [fn];
      let closing: string | undefined;
      for (let i = 0; i < queue.length && closing === undefined; i++) {
        for (const v of succ(queue[i]!)) {
          if (!members.has(v)) continue;
          if (v === fn) {
            closing = queue[i];
            break;
          }
          if (!prev.has(v)) {
            prev.set(v, queue[i]!);
            queue.push(v);
          }
        }
      }
      const path: string[] = [];
      for (let n = closing; n !== undefined && n !== fn; n = prev.get(n)) path.unshift(n);
      found.push({ fn, path: [fn, ...path, fn] });
    }
    found.sort((x, y) => (x.fn < y.fn ? -1 : x.fn > y.fn ? 1 : 0));
    for (const { fn, path } of found) {
      this.sink.error(
        "ABFC2085",
        `${fn} calls itself (${path.join(" -> ")}). Recursion is not supported: a function's temporaries are member variables, so a recursive call would overwrite them. Rewrite it as a loop.`,
        this.fnNames.get(fn),
      );
    }
  }

  /**
   * Checks that decide whether an undecorated method can become a function at all (static, generic, async, name of a parent member);
   * reports and returns false when not.
   */
  private functionAllowed(m: ts.MethodDeclaration, parentType: ts.Type): boolean {
    const name = (m.name as ts.Identifier).text;
    const mods = ts.getModifiers(m) ?? [];
    if (mods.some((k) => k.kind === ts.SyntaxKind.StaticKeyword)) {
      this.sink.error("ABFC2099", `static method ${name}: static methods are not supported: a Blueprint function belongs to an instance`, m.name);
      return false;
    }
    if (m.typeParameters !== undefined && m.typeParameters.length > 0) {
      this.sink.error("ABFC2099", `method ${name}: generic methods are not supported`, m.name);
      return false;
    }
    if (mods.some((k) => k.kind === ts.SyntaxKind.AsyncKeyword)) {
      this.sink.error("ABFC2086", `${name} is async: a Blueprint function finishes in one frame, so it cannot await; make it an @event`, m.name);
      return false;
    }
    const prop = this.checker.getPropertyOfType(parentType, name);
    const reserved = name === "UserConstructionScript" || name.startsWith("ExecuteUbergraph");
    if (prop !== undefined || reserved || mods.some((k) => k.kind === ts.SyntaxKind.OverrideKeyword)) {
      const owner = prop !== undefined ? functionInfo(prop)?.owner : undefined;
      this.sink.error(
        "ABFC2087",
        `method ${name} has the name of ${owner ?? "a member of the parent class"}; a Blueprint function cannot reuse it. Rename the method, or use @override to implement a parent event.`,
        m.name,
      );
      return false;
    }
    return true;
  }

  /**
   * The `@director("Row")` of a class: undefined when there is none or it has an error (reported here). `notAllowed` is true for a
   * widget class or a `@struct` (ABFC2074).
   */
  private directorOf(node: ts.ClassDeclaration, notAllowed: boolean, classManagerRowNode: ts.Node | undefined): { row: string; asset: string; tag?: string } | undefined {
    const decs = (ts.getDecorators(node) ?? []).filter((d) => runtimeName(this.checker, d.expression) === "director");
    if (decs.length === 0) return undefined;
    const dec = decs[0]!;
    if (decs.length > 1) {
      this.sink.error("ABFC2061", "one @director per class", decs[1]!);
      return undefined;
    }
    if (notAllowed) {
      this.sink.error("ABFC2074", "@director only applies to a non-widget @blueprint class", dec);
      return undefined;
    }
    const args = ts.isCallExpression(dec.expression) ? dec.expression.arguments : undefined;
    const arg = args !== undefined && args.length >= 1 && args.length <= 2 ? args[0]! : undefined;
    if (arg === undefined || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      this.sink.error("ABFC2061", "@director takes the row name as a string literal", arg ?? dec);
      return undefined;
    }
    const row = arg.text;
    const why = segmentProblem(row);
    if (why !== null) {
      this.sink.error("ABFC2073", `row name "${row}" ${why}`, arg);
      return undefined;
    }
    if (classManagerRowNode !== undefined) {
      this.sink.error("ABFC2061", "use @director or classManagerRow, not both", classManagerRowNode);
      return undefined;
    }
    const tagArg = args![1];
    let tag: string | undefined;
    if (tagArg !== undefined && !(ts.isIdentifier(tagArg) && tagArg.text === "undefined")) {
      tag = this.gameplayTagOf(tagArg);
      if (tag === undefined) return undefined;
    }
    if (tag === undefined) {
      const suggested = DIRECTOR_TAG_PREFIX + row;
      this.sink.warning(
        "ABFC2079",
        `@director("${row}") has no gameplay tag: a new class-manager row then has no tag and the director never starts (an existing row keeps its tag). Add "${suggested}".`,
        dec,
        { tag: suggested },
      );
    } else if (!tag.startsWith(DIRECTOR_TAG_PREFIX)) {
      this.sink.warning("ABFC2081", `gameplay tag ${tag} is not under ${DIRECTOR_TAG_PREFIX}; the game may never start a director with another tag`, tagArg);
    }
    const table = pathContextOf(node.getSourceFile())?.classManagerTable ?? DEFAULT_CLASS_MANAGER_TABLE;
    return { row, asset: joinModPath(this.mod, `${table}/${row}`), ...(tag !== undefined ? { tag } : {}) };
  }

  /**
   * The gameplay tag named by the second `@director` argument: a string literal, or an expression whose type has a string-literal
   * `__gameplayTag` property (a `GameplayTag<"x.y">` constant of the generated `.abfc/tags.d.ts`). Anything else, or a malformed
   * tag, is ABFC2080 and undefined.
   */
  private gameplayTagOf(arg: ts.Expression): string | undefined {
    let tag: string | undefined;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      tag = arg.text;
    } else {
      const prop = this.checker.getPropertyOfType(this.checker.getTypeAtLocation(arg), "__gameplayTag");
      const type = prop === undefined ? undefined : this.checker.getTypeOfSymbolAtLocation(prop, arg);
      if (type !== undefined && type.isStringLiteral()) tag = type.value;
    }
    if (tag === undefined) {
      this.sink.error("ABFC2080", "the @director gameplay tag must be a string literal or a GameplayTag constant such as ClassManager.EntityDirector.MyDirector (run abfc generate to generate the constants)", arg);
      return undefined;
    }
    const why = gameplayTagProblem(tag);
    if (why !== null) {
      this.sink.error("ABFC2080", `gameplay tag "${tag}" ${why}`, arg);
      return undefined;
    }
    return tag;
  }

  /**
   * A `@struct({ path })` class: a mod-defined struct (UserDefinedStruct). Fields are `Name!: Type;` only (no initializer, methods,
   * `extends` or container types); every violation is ABFC2046. The struct is recorded only when it has no error.
   */
  private structDecl(node: ts.ClassDeclaration, dec: ts.Decorator): void {
    const name = node.name?.text ?? "(anonymous)";
    const errors = (): number => this.sink.diagnostics.filter((d) => d.severity === "error").length;
    const before = errors();
    const bad = (why: string, at: ts.Node): void => this.sink.error("ABFC2046", why, at);
    const pathInfo = assetPathOf(node, "struct");
    // a path outside the mod stays ABFC2046 for structs (the code structs have always used)
    if (pathInfo === undefined || reportPathProblems(this.sink, pathInfo, (c) => (c === "ABFC2001" ? "ABFC2046" : c)) || pathInfo.path === undefined) {
      if (pathInfo === undefined || pathInfo.problems.every((p) => p.severity !== "error")) bad(`@struct path of ${name} must be a string literal under "/${this.mod}/"`, dec);
      return;
    }
    const s = { path: pathInfo.path, objectPath: `${pathInfo.path}.${pathInfo.path.slice(pathInfo.path.lastIndexOf("/") + 1)}` };
    if (node.heritageClauses !== undefined && node.heritageClauses.length > 0) bad(`@struct ${name} cannot extend or implement anything`, node.heritageClauses[0]!);
    const fields: HirStruct["fields"] = [];
    const FORM = "a struct field is declared as `Name!: Type;` (no initializer, not static/readonly/optional)";
    let index = 0;
    for (const m of node.members) {
      if (ts.isSemicolonClassElement(m)) continue;
      if (!ts.isPropertyDeclaration(m)) {
        bad(`@struct ${name}: only fields are allowed (\`Name!: Type;\`), not ${ts.isMethodDeclaration(m) ? "methods" : ts.SyntaxKind[m.kind]}`, m);
        continue;
      }
      const at = index++;
      const shown = m.name.getText();
      if (!ts.isIdentifier(m.name)) {
        bad(`field ${shown}: ${FORM}`, m.name);
        continue;
      }
      const mods = (ts.getModifiers(m) ?? []).filter((x) => x.kind !== ts.SyntaxKind.PublicKeyword);
      if (mods.length > 0 || m.questionToken !== undefined || m.exclamationToken === undefined || m.initializer !== undefined || (ts.getDecorators(m) ?? []).length > 0 || m.type === undefined) {
        bad(`field ${shown}: ${FORM}`, m.name);
        continue;
      }
      const tsType = this.checker.getTypeFromTypeNode(m.type);
      if (this.containerKind(tsType) !== undefined || this.checker.isArrayType(this.checker.getNonNullableType(tsType))) {
        bad(`field ${shown}: a struct field cannot be an array, Map or Set`, m.name);
        continue;
      }
      const type = bpTypeOf(this.checker, tsType);
      if (type === undefined) {
        bad(`field ${shown}: ${(tsType.flags & ts.TypeFlags.EnumLike) !== 0 ? TS_ENUM_HINT : "field type has no Blueprint equivalent"}`, m.name);
        continue;
      }
      try {
        parseBpType(type);
      } catch (e) {
        if (e instanceof BpTypeError) {
          bad(`field ${shown}: field type ${type} is not supported: ${e.message}`, m.name);
          continue;
        }
        throw e;
      }
      if (type === `struct:${s.objectPath}`) {
        bad(`field ${shown}: a struct cannot contain itself`, m.name);
        continue;
      }
      fields.push({ name: m.name.text, type, memberName: udsMemberName(s.objectPath, m.name.text, at), span: this.sp(m.name) });
    }
    if (fields.length === 0 && errors() === before) bad(`@struct ${name} needs at least one field`, node.name ?? node);
    if (errors() > before) return;
    this.structs.push({ name, path: s.path, pathDerived: pathInfo.explicit === undefined, objectPath: s.objectPath, fields, span: this.sp(node.name ?? node) });
  }

  /**
   * An own field: `Name!: Type;` or `Name: Type = <literal>;` with no modifiers other than `public`; a literal initializer becomes
   * the variable's default. Reports ABFC2047 and returns undefined for any other property declaration, an initializer that is not a
   * literal of the field type, a type without a Blueprint equivalent, or a name that collides with an inherited member.
   */
  private ownField(node: ts.ClassDeclaration, m: ts.PropertyDeclaration): HirField | undefined {
    const shown = m.name.getText();
    const bad = (why: string): undefined => {
      this.sink.error("ABFC2047", `field ${shown}: ${why}`, m.name);
      return undefined;
    };
    const FORM = "an own field is declared as `Name!: Type;` or `Name: Type = <literal>;` (not static/readonly/optional)";
    if (!ts.isIdentifier(m.name)) return bad(FORM);
    const mods = (ts.getModifiers(m) ?? []).filter((x) => x.kind !== ts.SyntaxKind.PublicKeyword);
    if (mods.length > 0 || m.questionToken !== undefined || (m.exclamationToken !== undefined) === (m.initializer !== undefined) || (ts.getDecorators(m) ?? []).length > 0 || m.type === undefined) {
      return bad(FORM);
    }
    const tsFieldType = this.checker.getTypeFromTypeNode(m.type);
    const type = bpTypeOf(this.checker, tsFieldType);
    if (type === undefined) {
      if (this.containerKind(tsFieldType) !== undefined) {
        this.sink.error("ABFC2043", `field ${shown}: unsupported Map/Set type; keys and set elements are int, int64, byte, name or string, and a map value is any single (non-container) type`, m.name);
        return undefined;
      }
      return bad((tsFieldType.flags & ts.TypeFlags.EnumLike) !== 0 ? TS_ENUM_HINT : "field type has no Blueprint equivalent");
    }
    try {
      parseBpType(type);
    } catch (e) {
      if (e instanceof BpTypeError) {
        if (/^(map|set):/.test(type)) {
          this.sink.error("ABFC2043", `field ${shown}: field type ${type} is not supported: ${e.message}`, m.name);
          return undefined;
        }
        return bad(`field type ${type} is not supported: ${e.message}`);
      }
      throw e;
    }
    const csym = node.name ? this.checker.getSymbolAtLocation(node.name) : undefined;
    const ctype = csym ? this.checker.getDeclaredTypeOfSymbol(csym) : undefined;
    if (ctype?.isClassOrInterface() && this.checker.getBaseTypes(ctype).some((b) => this.checker.getPropertyOfType(b, m.name.getText()) !== undefined)) {
      return bad("the name collides with a member of the parent class or a hand-made member of the asset; rename the field");
    }
    let def: string | undefined;
    if (m.initializer !== undefined) {
      def = this.fieldDefault(m.initializer, type, shown);
      if (def === undefined) return undefined;
    }
    return { name: m.name.text, type, ...(def !== undefined ? { default: def } : {}), span: this.sp(m.name) };
  }

  /** The Unreal default-value text of an own field's literal initializer, or undefined (after reporting ABFC2047/ABFC2015) when it is not a literal of the field type. */
  private fieldDefault(init: ts.Expression, type: BpType, shown: string): string | undefined {
    const e = stripParens(init);
    let num: number | undefined;
    if (ts.isNumericLiteral(e)) num = Number(e.text);
    else if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
      const operand = stripParens(e.operand);
      if (ts.isNumericLiteral(operand)) num = -Number(operand.text);
    }
    if (type === "float" || type === "double" || type === "real") {
      if (num !== undefined && Number.isFinite(num)) return String(num);
    } else if (type === "int" || type === "int64" || type === "byte") {
      if (num !== undefined && Number.isInteger(num)) {
        const [lo, hi] = type === "int" ? [-2147483648, 2147483647] : type === "byte" ? [0, 255] : [undefined, undefined];
        const inRange = lo === undefined || hi === undefined ? Number.isSafeInteger(num) : num >= lo && num <= hi;
        if (inRange) return String(num);
        this.sink.error("ABFC2047", `field ${shown}: ${init.getText()} is out of range for ${type}`, init);
        return undefined;
      }
    } else if (type === "bool") {
      if (e.kind === ts.SyntaxKind.TrueKeyword) return "true";
      if (e.kind === ts.SyntaxKind.FalseKeyword) return "false";
    } else if (type === "string" || type === "name") {
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    } else if (type.startsWith("enum:") && ts.isStringLiteral(e)) {
      const ctx = this.checker.getContextualType(e);
      if (ctx) {
        const members = ctx.isUnion() ? ctx.types : [ctx];
        const known = members.filter((x): x is ts.StringLiteralType => x.isStringLiteral()).map((x) => x.value);
        if (known.length > 0 && !known.includes(e.text)) {
          this.sink.error("ABFC2015", `"${e.text}" is not a value of ${type.slice("enum:".length)} (${known.join(", ")})`, e);
          return undefined;
        }
      }
      return e.text;
    }
    this.sink.error(
      "ABFC2047",
      `field ${shown}: the initializer must be a literal of the field type: a number (int, int64, byte, float, double), true or false (boolean), a string (string, name) or an enum value; struct, object, array, Map, Set and text fields have no default`,
      init,
    );
    return undefined;
  }

  /** True when the class or one of its base classes is an engine Actor (`@bpPath /Script/<Module>.Actor`). */
  private derivesFromActor(type: ts.Type): boolean {
    return this.derivesWhere(type, (p) => /^\/Script\/[^.]+\.Actor$/.test(p));
  }

  /** True when the class or one of its base classes is an engine ActorComponent (`@bpPath /Script/<Module>.ActorComponent`). */
  private derivesFromComponent(type: ts.Type): boolean {
    return this.derivesWhere(type, (p) => /^\/Script\/[^.]+\.ActorComponent$/.test(p));
  }

  /** True when the class or one of its base classes has `@bpPath <classPath>`. */
  private derivesFrom(type: ts.Type, classPath: string): boolean {
    return this.derivesWhere(type, (p) => p === classPath);
  }

  /** True when the `_Manual` stub merged into the class declares `name` as a designer widget (`@bpWidget`). */
  private isDesignerWidget(node: ts.ClassDeclaration, name: string): boolean {
    const sym = node.name ? this.checker.getSymbolAtLocation(node.name) : undefined;
    if (sym === undefined) return false;
    const type = this.checker.getDeclaredTypeOfSymbol(sym);
    if (!type.isClassOrInterface()) return false;
    return this.checker.getBaseTypes(type).some((b) => {
      const prop = this.checker.getPropertyOfType(b, name);
      return prop !== undefined && bpTagsOfSymbol(prop).has("bpWidget");
    });
  }

  private derivesWhere(type: ts.Type, pred: (classPath: string) => boolean): boolean {
    const seen = new Set<ts.Type>();
    const walk = (t: ts.Type): boolean => {
      if (seen.has(t)) return false;
      seen.add(t);
      const sym = t.getSymbol();
      const info = sym ? classInfo(sym) : undefined;
      if (info !== undefined && pred(info.path)) return true;
      return (t.isClassOrInterface() ? this.checker.getBaseTypes(t) : []).some(walk);
    };
    return walk(type);
  }

  /**
   * ABFC2078: an `@event` method named like a Blueprint member of the parent class (or carrying the TS `override` modifier) would create a
   * custom event with a native name, which Unreal refuses. Reported at the `@event` decorator with a fix to `@override`; true = reported.
   * Only the parent's declared type counts (not the class's own `_Manual` merge), so hand-made events are not affected.
   */
  private shadowsParentEvent(m: ts.MethodDeclaration, parentType: ts.Type): boolean {
    const name = (m.name as ts.Identifier).text;
    const prop = this.checker.getPropertyOfType(parentType, name);
    const hasOverride = (ts.getModifiers(m) ?? []).some((k) => k.kind === ts.SyntaxKind.OverrideKeyword);
    if (!((prop !== undefined && functionInfo(prop) !== undefined) || hasOverride)) return false;
    const dec = (ts.getDecorators(m) ?? []).find((x) => runtimeName(this.checker, x.expression) === "event");
    const owner = prop !== undefined ? functionInfo(prop)?.owner : undefined;
    this.sink.error(
      "ABFC2078",
      `@event ${name} would create a custom event named like the parent's ${name}${owner !== undefined ? ` (${owner})` : ""}; Unreal refuses that (ABFC6001). Use @override to implement the parent's event.`,
      dec ?? m.name,
      { fix: "useOverride" },
    );
    return true;
  }

  /** Parameters of an owned method; for `@override` they come from the parent stub (`@bpParam`), not from the annotations. */
  private signature(m: ts.MethodDeclaration, kind: "event" | "override" | "function", parentType: ts.Type): OwnSig | undefined {
    const name = (m.name as ts.Identifier).text;
    const params: HirEvent["params"] = [];
    const paramSyms: OwnSig["paramSyms"] = [];
    for (const p of m.parameters) {
      if (!ts.isIdentifier(p.name)) {
        this.sink.error("ABFC2099", "destructured parameters are not supported", p);
        continue;
      }
      if (kind === "function") {
        if (p.questionToken || p.initializer) {
          this.sink.error("ABFC2099", `parameter ${p.name.text}: optional parameters and default values are not supported in a function`, p);
        }
        if (p.dotDotDotToken) this.sink.error("ABFC2099", `parameter ${p.name.text}: rest parameters are not supported`, p);
      }
      const t = this.checker.getTypeAtLocation(p);
      let type = bpTypeOf(this.checker, t);
      if (this.containerKind(t) !== undefined) {
        this.sink.error("ABFC2043", `parameter ${p.name.text}: Map and Set parameters are not supported`, p);
        type = "unknown";
      } else if (type === undefined && kind !== "override") {
        if (t.flags & ts.TypeFlags.EnumLike) {
          this.sink.error("ABFC2099", `parameter ${p.name.text}: ${TS_ENUM_HINT}`, p);
          type = "unknown";
        } else if (t.flags & ts.TypeFlags.NumberLike) {
          this.sink.error("ABFC2014", `number kind of parameter ${p.name.text} is not inferable: use int, int64, byte, float or double`, p);
          type = "number";
        } else {
          this.sink.error("ABFC2099", `parameter ${p.name.text} has a type without a Blueprint equivalent`, p);
          type = "unknown";
        }
      }
      this.noteTypes(t);
      params.push({ name: p.name.text, type: type ?? "unknown" });
      paramSyms.push(this.checker.getSymbolAtLocation(p.name));
    }
    if (kind === "event") return { node: m, kind, params, paramSyms };
    if (kind === "function") {
      const decl = this.checker.getSignatureFromDeclaration(m);
      const rt = decl ? this.checker.getReturnTypeOfSignature(decl) : undefined;
      let returnType: BpType | undefined;
      if (rt !== undefined && !(rt.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never))) {
        returnType = bpTypeOf(this.checker, rt);
        if (this.containerKind(rt) !== undefined) {
          this.sink.error("ABFC2043", `the return type of ${name}: Map and Set are not supported`, m.type ?? m.name);
          returnType = "unknown";
        } else if (returnType === undefined) {
          if (rt.flags & ts.TypeFlags.NumberLike) {
            this.sink.error("ABFC2014", `the return type of ${name} is not inferable: use int, int64, byte, float or double`, m.type ?? m.name);
          } else {
            this.sink.error("ABFC2099", `the return type of ${name} has no Blueprint equivalent`, m.type ?? m.name);
          }
          returnType = "unknown";
        }
        this.noteTypes(rt);
      }
      const mods = ts.getModifiers(m) ?? [];
      const access = mods.some((k) => k.kind === ts.SyntaxKind.PrivateKeyword)
        ? "private"
        : mods.some((k) => k.kind === ts.SyntaxKind.ProtectedKeyword)
          ? "protected"
          : "public";
      return { node: m, kind, params, paramSyms, ...(returnType !== undefined ? { returnType } : {}), access };
    }

    const prop = this.checker.getPropertyOfType(parentType, name);
    const fi = prop ? functionInfo(prop) : undefined;
    if (!fi) {
      this.sink.error("ABFC2060", `@override ${name}: the parent class has no event or function ${name} with Blueprint metadata (@bpPath)`, m.name);
      return undefined;
    }
    if (fi.params.length !== params.length) {
      this.sink.error("ABFC2055", `@override ${name} takes ${params.length} parameter(s) but the parent declares ${fi.params.length}`, m.name);
      return undefined;
    }
    return { node: m, kind, params: fi.params.map((p) => ({ name: p.pin, type: p.type })), paramSyms, overrideOf: fi.owner };
  }

  private isHybrid(node: ts.ClassDeclaration): boolean {
    const sym = node.name ? this.checker.getSymbolAtLocation(node.name) : undefined;
    return (sym?.declarations ?? []).some((d) => ts.isInterfaceDeclaration(d));
  }

  private manualUnits(node: ts.ClassDeclaration): string[] {
    const sym = node.name ? this.checker.getSymbolAtLocation(node.name) : undefined;
    if (!sym) return [];
    const type = this.checker.getDeclaredTypeOfSymbol(sym);
    const out: string[] = [];
    for (const p of this.checker.getPropertiesOfType(type)) {
      const isMethod = (p.declarations ?? []).some((d) => ts.isMethodSignature(d) || ts.isMethodDeclaration(d));
      if (isMethod && bpTagsOfSymbol(p).has("bpHandMade")) out.push(p.name);
    }
    return out.sort();
  }

  private event(m: ts.MethodDeclaration, cls: HirClass, sig: OwnSig): HirEvent {
    const name = m.name as ts.Identifier;
    this.cls = cls;
    this.body = m.body!;
    this.locals = new Map();
    this.params = new Map();
    this.holes = new Map();
    this.handled = new Set();
    this.nextLocal = 0;
    sig.paramSyms.forEach((sym, i) => {
      const p = sig.params[i];
      if (sym && p) this.params.set(sym, { name: p.name, type: p.type });
    });
    this.unitKind = sig.kind;
    this.unitName = name.text;
    this.unitReturn = sig.returnType;
    const body = this.stmts(m.body!.statements);
    const doc = docOf(m);
    return {
      name: name.text,
      kind: sig.kind,
      ...(sig.overrideOf !== undefined ? { overrideOf: sig.overrideOf } : {}),
      ...(doc !== undefined ? { doc } : {}),
      params: sig.params,
      ...(sig.kind === "function" ? { ...(sig.returnType !== undefined ? { returnType: sig.returnType } : {}), access: sig.access ?? "public" } : {}),
      body,
      span: this.sp(name),
    };
  }

  // ---- statements ----

  private stmts(list: readonly ts.Statement[]): HirStmt[] {
    const items: Array<{ node: ts.Statement; hir: HirStmt | undefined }> = [];
    for (const node of list) {
      if (ts.isEmptyStatement(node)) continue;
      items.push({ node, hir: this.stmt(node) });
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || it.hir === undefined || it.hir.k !== "const") continue;
      const next = items[i + 1];
      const id = it.hir.local;
      const init = it.hir.init;
      if (init.k === "cast") {
        const ok = next === undefined ? false : next.hir === undefined || consumesCast(next.hir, id);
        if (!ok) this.sink.error("ABFC2050", `cast result "${it.hir.name}" must be consumed by the next statement (if (!${it.hir.name}), if (${it.hir.name}) or ${it.hir.name}?.)`, it.node);
      } else if (init.k === "call" && init.execOutputs !== null) {
        const ok = next === undefined ? false : next.hir === undefined || consumesExec(next.hir, id);
        if (!ok) this.sink.error("ABFC2052", `exec result "${it.hir.name}" must be branched by the next statement (if (${it.hir.name}.exec === "...") )`, it.node);
      }
    }
    return items.flatMap((i) => (i.hir ? [i.hir] : []));
  }

  private block(s: ts.Statement): HirStmt[] {
    return this.stmts(ts.isBlock(s) ? s.statements : [s]);
  }

  private stmt(node: ts.Statement): HirStmt | undefined {
    try {
      return this.stmtInner(node);
    } catch (e) {
      if (e instanceof Fail) return undefined;
      throw e;
    }
  }

  private stmtInner(node: ts.Statement): HirStmt {
    const f: DiagSink = this.sink;
    if (ts.isVariableStatement(node)) return this.constStmt(node);
    if (ts.isExpressionStatement(node)) return this.exprStmt(node);
    if (ts.isIfStatement(node)) {
      const cond = this.expr(node.expression, undefined, true);
      const then = this.block(node.thenStatement);
      const els = node.elseStatement ? this.block(node.elseStatement) : [];
      return { k: "if", cond, then, else: els, span: this.sp(node) };
    }
    if (ts.isReturnStatement(node) && this.jumps.callback) return this.callbackReturn(node);
    if (ts.isReturnStatement(node)) {
      if (!node.expression) return { k: "return", span: this.sp(node) };
      if (this.unitKind !== "function") {
        f.fail("ABFC2099", "an @event or @override cannot return a value; put the logic in an undecorated method (a Blueprint function) to return one", node);
      }
      if (this.unitReturn === undefined) f.fail("ABFC2099", "a void function cannot return a value", node);
      const value = this.expr(node.expression, this.unitReturn);
      return { k: "return", value, span: this.sp(node) };
    }
    if (ts.isForOfStatement(node)) return this.forOf(node);
    if (ts.isForStatement(node)) return this.forCount(node);
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) return this.jump(node);
    if (ts.isTryStatement(node) || ts.isThrowStatement(node)) f.fail("ABFC2020", "try/catch/throw are not supported", node);
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) f.fail("ABFC2020", "local functions and classes are not supported", node);
    return f.fail("ABFC2099", `statement of kind ${ts.SyntaxKind[node.kind]} is not supported`, node);
  }

  private constStmt(node: ts.VariableStatement): HirStmt {
    const f: DiagSink = this.sink;
    const list = node.declarationList;
    if (!(list.flags & ts.NodeFlags.Const)) f.fail("ABFC2099", "only const declarations are supported (let is only allowed as the counter of a counted for loop)", node);
    const d = list.declarations[0];
    if (list.declarations.length !== 1 || !d) f.fail("ABFC2099", "declare one const per statement", node);
    if (!ts.isIdentifier(d.name)) f.fail("ABFC2099", "destructuring is not supported", d.name);
    if (!d.initializer) f.fail("ABFC2099", "a const needs an initializer", d);
    const sym = this.checker.getSymbolAtLocation(d.name);
    const declType = this.checker.getTypeAtLocation(d.name);
    if (declType.flags & ts.TypeFlags.Any) f.fail("ABFC2020", "'any' is not supported", d.name);
    let init: HirExpr;
    try {
      init = this.expr(d.initializer, d.type ? bpTypeOf(this.checker, declType) : undefined);
    } catch (e) {
      if (e instanceof Fail && sym) this.locals.set(sym, { id: -1, name: d.name.text, type: "unknown", poison: true });
      throw e;
    }
    if (/^(map|set):/.test(init.type)) f.fail("ABFC2043", "a Map or Set cannot be stored in a const (use the own field directly)", d.initializer);
    const id = this.nextLocal++;
    const fn = init.type === "result" ? this.callInfo.get(init) : undefined;
    if (sym) this.locals.set(sym, { id, name: d.name.text, type: init.type, poison: false, ...(fn ? { fn } : {}) });
    const uses = sym ? this.countUses(sym, d.name) : 0;
    const nextOnly = sym !== undefined && uses > 0 && this.usesOnlyInNext(node, sym, d.name, uses);
    return { k: "const", local: id, name: d.name.text, init, uses, ...(nextOnly ? { nextOnly } : {}), span: this.sp(node) };
  }

  /** `await`: ABFC2086 inside a function (it finishes in one frame), otherwise unsupported. */
  private awaitFail(node: ts.Node): never {
    if (this.unitKind === "function") {
      return this.sink.fail(
        "ABFC2086",
        `await cannot be used inside the function ${this.unitName}: a Blueprint function finishes in one frame; move the latent call into an @event`,
        node,
      );
    }
    return this.sink.fail("ABFC2099", "await is not supported", node);
  }

  /** Whether all `uses` references to the const are inside the statement right after it (an if: its condition), which reads them once. */
  private usesOnlyInNext(stmt: ts.Statement, sym: ts.Symbol, declName: ts.Node, uses: number): boolean {
    const parent = stmt.parent;
    if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return false;
    const list = parent.statements;
    const next = list[list.indexOf(stmt) + 1];
    if (!next) return false;
    // an if reads its condition once, before either branch runs; only uses in the condition count
    const scope: ts.Node | undefined = ts.isIfStatement(next)
      ? next.expression
      : ts.isExpressionStatement(next) || ts.isVariableStatement(next) || ts.isReturnStatement(next)
        ? next
        : undefined;
    if (!scope) return false;
    let n = 0;
    const walk = (x: ts.Node): void => {
      if (ts.isIdentifier(x) && x !== declName && this.checker.getSymbolAtLocation(x) === sym) n++;
      ts.forEachChild(x, walk);
    };
    walk(scope);
    return n === uses;
  }

  private countUses(sym: ts.Symbol, declName: ts.Node): number {
    let n = 0;
    const walk = (x: ts.Node): void => {
      if (ts.isIdentifier(x) && x !== declName && this.checker.getSymbolAtLocation(x) === sym) n++;
      ts.forEachChild(x, walk);
    };
    walk(this.body);
    return n;
  }

  private exprStmt(node: ts.ExpressionStatement): HirStmt {
    const f: DiagSink = this.sink;
    const e = node.expression;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) return this.assign(e);
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) f.fail("ABFC2099", "compound assignment is not supported", e);
    }
    if (ts.isAwaitExpression(e)) this.awaitFail(e);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && this.containerKind(e.expression.expression) !== undefined) {
      const op = this.containerStatement(e, e.expression, this.sp(node));
      if (op !== undefined) return op;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ARRAY_MUTATORS.has(e.expression.name.text) && this.isArrayNode(e.expression.expression)) {
      return this.arrayMutation(e, e.expression, this.sp(node));
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "forEach" && this.isArrayNode(e.expression.expression)) {
      return this.forEachCall(e, e.expression, this.sp(node));
    }
    if (ts.isCallExpression(e) && runtimeName(this.checker, e) === "bindEvent") return this.bindEvent(e, this.sp(node));
    const h = this.expr(e);
    // spawnActor and createWidget have exec pins: a statement that drops the result still spawns or creates
    if (h.k !== "call" && h.k !== "optional" && h.k !== "callOwn" && h.k !== "spawn" && h.k !== "createWidget") f.fail("ABFC2099", "this expression statement has no effect", e);
    return { k: "expr", e: h, span: this.sp(node) };
  }

  /** `bindEvent(source, "Dispatcher", target, "Function")` as a statement. */
  private bindEvent(e: ts.CallExpression, sp: Span): HirStmt {
    const f: DiagSink = this.sink;
    const [srcArg, dispArg, tgtArg, fnArg] = e.arguments;
    if (!srcArg || !dispArg || !tgtArg || !fnArg || e.arguments.length !== 4) return f.fail("ABFC2099", 'bindEvent(source, "Dispatcher", target, "Function") takes four arguments', e);
    if (!ts.isStringLiteral(dispArg) || !ts.isStringLiteral(fnArg)) return f.fail("ABFC2099", "bindEvent: the dispatcher and function names must be string literals", !ts.isStringLiteral(dispArg) ? dispArg : fnArg);
    const source = this.expr(srcArg);
    if (!source.type.startsWith("object:")) return f.fail("ABFC2099", "bindEvent: the source must be an object", srcArg);
    const sourceClass = source.type.slice("object:".length);
    if (stripParens(tgtArg).kind === ts.SyntaxKind.ThisKeyword) {
      // an own event: its delegate pin feeds Add Delegate straight away
      const own = this.ownSigs.get(fnArg.text);
      if (!own || own.kind !== "event") return f.fail("ABFC2054", `bindEvent(..., this, "${fnArg.text}"): ${fnArg.text} must be an own @event method`, fnArg);
      return { k: "bind", source, sourceClass, dispatcher: dispArg.text, target: null, fn: fnArg.text, ownEvent: true, span: sp };
    }
    const target = this.expr(tgtArg);
    if (!target.type.startsWith("object:")) return f.fail("ABFC2099", "bindEvent: the target must be an object", tgtArg);
    return { k: "bind", source, sourceClass, dispatcher: dispArg.text, target, fn: fnArg.text, span: sp };
  }

  private assign(e: ts.BinaryExpression): HirStmt {
    const f: DiagSink = this.sink;
    const left = e.left;
    if (ts.isPropertyAccessExpression(left) && left.name.text === "length" && this.isArrayNode(left.expression)) {
      const self = this.selfArray(left.expression);
      if (!self) return f.fail("ABFC2041", ARRAY_OWN_ONLY, left.expression);
      const r = stripParens(e.right);
      if (!ts.isNumericLiteral(r) || r.text !== "0") return f.fail("ABFC2099", "only `<array>.length = 0` is supported (it clears the array)", e.right);
      return { k: "arrayOp", op: "clear", array: self, span: this.sp(e) };
    }
    if (ts.isElementAccessExpression(left) && this.isArrayNode(left.expression)) {
      // this.Arr[i] = x: Set Array Elem (Array_Set, bSizeToFit false), on an own array only, like push and splice
      const self = this.selfArray(left.expression);
      if (!self) return f.fail("ABFC2041", ARRAY_OWN_ONLY, left.expression);
      const index = this.expr(left.argumentExpression, "int");
      if (kindOfBpType(index.type) !== "int") return f.fail("ABFC2012", `an array index must be an int, not ${index.type}`, left.argumentExpression);
      const elem = self.type.slice("array:".length);
      return { k: "arrayOp", op: "set", array: self, index, value: this.expr(e.right, elem), span: this.sp(e) };
    }
    if (ts.isPropertyAccessExpression(left) && left.expression.kind !== ts.SyntaxKind.ThisKeyword) {
      // other.Var = value: a Set node on another object (a spawned actor's exposed variable)
      const sym = this.checker.getSymbolAtLocation(left.name);
      const path = sym ? bpPathOf(sym) : undefined;
      const mp = path === undefined ? undefined : splitMemberPath(path);
      if (!sym || !mp) return f.fail("ABFC2060", `member ${left.name.text} has no Blueprint metadata (@bpPath)`, left.name);
      const type = bpTypeOfMember(sym);
      if (type === undefined || ts.isMethodDeclaration(sym.valueDeclaration ?? left)) return f.fail("ABFC2099", `${left.name.text} is not a Blueprint variable`, left.name);
      if (/^(array|map|set):/.test(type)) return f.fail("ABFC2041", "an array, Map or Set of another object cannot be assigned; use its own functions", left);
      const obj = this.expr(left.expression);
      if (!obj.type.startsWith("object:")) return f.fail("ABFC2099", "assignment target must be an object", left.expression);
      return { k: "setOn", obj, owner: mp.owner, name: mp.name, type, value: this.expr(e.right, type), span: this.sp(e) };
    }
    if (!ts.isPropertyAccessExpression(left) || left.expression.kind !== ts.SyntaxKind.ThisKeyword) {
      return f.fail("ABFC2099", "assignment is only supported as this.<variable> = value, other.<variable> = value or this.<array>[i] = value", e);
    }
    const sym = this.checker.getSymbolAtLocation(left.name);
    if (!sym) return f.fail("ABFC2060", `member ${left.name.text} has no Blueprint metadata (@bpPath)`, left.name);
    const ownF = this.ownFields.get(sym);
    const type = ownF?.type ?? bpTypeOfMember(sym);
    if (type === undefined) {
      if (bpPathOf(sym) === undefined) f.fail("ABFC2060", `member ${left.name.text} has no Blueprint metadata (@bpPath)`, left.name);
      return f.fail("ABFC2099", `${left.name.text} is not a Blueprint variable`, left.name);
    }
    const name = ownF?.name ?? splitMemberPath(bpPathOf(sym) ?? "")?.name ?? left.name.text;
    const right = stripParens(e.right);
    if (ts.isConditionalExpression(right)) {
      const cond = this.expr(right.condition, "bool", true);
      const a = this.expr(right.whenTrue, type);
      const b = this.expr(right.whenFalse, type);
      return { k: "setSelfCond", name, type, cond, a, b, span: this.sp(e) };
    }
    const value = this.expr(e.right, type);
    return { k: "setSelf", name, type, value, span: this.sp(e) };
  }

  /** Whether the expression has a TypeScript array type (Blueprint arrays are TypeScript arrays). */
  private isArrayNode(n: ts.Expression): boolean {
    return this.checker.isArrayType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(n)));
  }

  /** `this.<Array>` where the member is a Blueprint array variable of this class. */
  private selfArray(n: ts.Expression): { self: string; type: BpType } | undefined {
    const x = stripParens(n);
    if (!ts.isPropertyAccessExpression(x) || x.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
    const sym = this.checker.getSymbolAtLocation(x.name);
    const ownF = sym ? this.ownFields.get(sym) : undefined;
    if (ownF !== undefined) return ownF.type.startsWith("array:") ? { self: ownF.name, type: ownF.type } : undefined;
    const type = sym ? bpTypeOfMember(sym) : undefined;
    if (!sym || type === undefined || !type.startsWith("array:")) return undefined;
    return { self: splitMemberPath(bpPathOf(sym) ?? "")?.name ?? x.name.text, type };
  }

  /** `Map`/`Set` (also the Weak/Readonly forms, as "other") when the expression has such a TypeScript type. */
  private containerKind(x: ts.Expression | ts.Type): "map" | "set" | "other" | undefined {
    const raw = "kind" in x ? this.checker.getTypeAtLocation(x as ts.Expression) : (x as ts.Type);
    const t = this.checker.getNonNullableType(raw);
    const name = (t.getSymbol() ?? t.aliasSymbol)?.name;
    if (name === undefined || !CONTAINERS.has(name)) return undefined;
    return name === "Map" ? "map" : name === "Set" ? "set" : "other";
  }

  /** `this.<Map|Set>` where the member is an own field of that container type. */
  private selfContainer(n: ts.Expression): { self: string; type: BpType } | undefined {
    const x = stripParens(n);
    if (!this.isOwnContainerField(x)) return undefined;
    const sym = this.checker.getSymbolAtLocation((x as ts.PropertyAccessExpression).name);
    const own = sym ? this.ownFields.get(sym) : undefined;
    return own ? { self: own.name, type: own.type } : undefined;
  }

  /** `this.F.set(k, v)`, `.delete(k)`, `.clear()` (Map) and `.add(x)`, `.delete(x)`, `.clear()` (Set) as statements; undefined for any other member. */
  private containerStatement(call: ts.CallExpression, callee: ts.PropertyAccessExpression, span: Span): HirStmt | undefined {
    const f: DiagSink = this.sink;
    const ck = this.containerKind(callee.expression);
    const op = (ck === "map" ? MAP_MUTATORS : ck === "set" ? SET_MUTATORS : undefined)?.get(callee.name.text);
    if (ck === undefined || ck === "other" || op === undefined) return undefined;
    const self = this.selfContainer(callee.expression);
    if (!self) return f.fail("ABFC2042", CONTAINER_OWN_ONLY, callee.expression);
    const ty = splitContainerType(self.type);
    const want = op === "clear" ? 0 : ck === "map" && op === "add" ? 2 : 1;
    if (call.arguments.length !== want) return f.fail("ABFC2099", `${callee.name.text} takes ${want} argument${want === 1 ? "" : "s"} here`, call);
    const key = want > 0 ? this.expr(call.arguments[0]!, ty.key) : undefined;
    const value = want === 2 ? this.expr(call.arguments[1]!, ty.value) : undefined;
    return { k: "containerOp", container: ck, op, target: self, ...(key ? { key } : {}), ...(value ? { value } : {}), span };
  }

  /** A call on a Map or Set receiver in value position: `has`, `get` (as `this.F.get(k)!`). Everything else is a statement or unsupported. */
  private containerCall(node: ts.CallExpression, callee: ts.PropertyAccessExpression, ck: "map" | "set" | "other", sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const m = callee.name.text;
    const label = ck === "map" ? "Map" : ck === "set" ? "Set" : "this container";
    if (ck === "other") return f.fail("ABFC2040", `${this.checker.getNonNullableType(this.checker.getTypeAtLocation(callee.expression)).getSymbol()?.name ?? "this container"} is not supported`, node);
    const mutators = ck === "map" ? MAP_MUTATORS : SET_MUTATORS;
    if (mutators.has(m)) return f.fail("ABFC2099", `${label}.${m} can only be used as a statement (its result is not available)`, node);
    if (m !== "has" && !(m === "get" && ck === "map")) {
      return f.fail("ABFC2040", `${label}.${m} is not supported (supported: ${ck === "map" ? "set, get, has, delete, clear, size" : "add, has, delete, clear, size"}; no iteration)`, callee.name);
    }
    const self = this.selfContainer(callee.expression);
    if (!self) return f.fail("ABFC2042", CONTAINER_OWN_ONLY, callee.expression);
    if (node.arguments.length !== 1) return f.fail("ABFC2099", `${m} takes one argument`, node);
    if (m === "get" && !ts.isNonNullExpression(node.parent)) {
      return f.fail("ABFC2040", "Map.get must be written this.<Field>.get(k)! (a missing key gives the value type's default)", node);
    }
    const ty = splitContainerType(self.type);
    const target = this.expr(callee.expression);
    const key = this.expr(node.arguments[0]!, ty.key);
    return { k: "containerQuery", container: ck, op: m === "has" ? "has" : "get", target, targetType: self.type, key, type: m === "has" ? "bool" : ty.value, span: sp };
  }

  /** `this.Arr.push(x)` and `this.Arr.splice(i, 1)` as statements. */
  private arrayMutation(call: ts.CallExpression, callee: ts.PropertyAccessExpression, span: Span): HirStmt {
    const f: DiagSink = this.sink;
    const self = this.selfArray(callee.expression);
    if (!self) return f.fail("ABFC2041", ARRAY_OWN_ONLY, callee.expression);
    const elem = self.type.slice("array:".length);
    const args = call.arguments;
    if (callee.name.text === "push") {
      if (args.length !== 1) return f.fail("ABFC2099", "push takes exactly one value", call);
      return { k: "arrayOp", op: "push", array: self, value: this.expr(args[0]!, elem), span };
    }
    const count = args[1] ? stripParens(args[1]) : undefined;
    if (args.length !== 2 || !count || !ts.isNumericLiteral(count) || count.text !== "1") {
      return f.fail("ABFC2099", "splice(index, 1) is the only supported form (the second argument must be the literal 1)", call);
    }
    const index = this.expr(args[0]!, "int");
    if (kindOfBpType(index.type) !== "int") return f.fail("ABFC2012", `an array index must be an int, not ${index.type}`, args[0]!);
    return { k: "arrayOp", op: "removeAt", array: self, index, span };
  }

  /** Loops around the statement being built, counted from the nearest event body or forEach callback (`callback`). */
  private jumps: { loops: number; callback: boolean } = { loops: 0, callback: false };

  private forOf(node: ts.ForOfStatement): HirStmt {
    const f: DiagSink = this.sink;
    if (node.awaitModifier) f.fail("ABFC2099", "for await is not supported", node);
    const init = node.initializer;
    if (!ts.isVariableDeclarationList(init) || !(init.flags & ts.NodeFlags.Const) || init.declarations.length !== 1) {
      return f.fail("ABFC2099", "for..of needs `const x`", node.initializer);
    }
    const d = init.declarations[0];
    if (!d || !ts.isIdentifier(d.name)) return f.fail("ABFC2099", "for..of needs a plain identifier", init);
    const array = this.expr(node.expression);
    if (!array.type.startsWith("array:")) f.fail("ABFC2099", "for..of is only supported over Blueprint arrays", node.expression);
    const elem = array.type.slice("array:".length);
    const sym = this.checker.getSymbolAtLocation(d.name);
    const id = this.nextLocal++;
    if (sym) this.locals.set(sym, { id, name: d.name.text, type: elem, poison: false });
    this.jumps.loops++;
    let body: HirStmt[];
    try {
      body = this.block(node.statement);
    } finally {
      this.jumps.loops--;
    }
    return { k: "forOf", local: id, name: d.name.text, array, elem, body, span: this.sp(node) };
  }

  /** `for (let i = A; cond; i++ | i-- | i = i + 1 | i = i - 1)` with an int counter. */
  private forCount(node: ts.ForStatement): HirStmt {
    const f: DiagSink = this.sink;
    const init = node.initializer;
    if (!init || !ts.isVariableDeclarationList(init) || !(init.flags & ts.NodeFlags.Let) || init.declarations.length !== 1) {
      return f.fail("ABFC2099", "for needs `let i = <int>` as its only initializer (counted loops); use for..of over arrays", node.initializer ?? node);
    }
    const d = init.declarations[0];
    if (!d || !ts.isIdentifier(d.name) || !d.initializer) return f.fail("ABFC2099", "the counter of a for loop needs a name and an initial value", init);
    if (!node.condition) return f.fail("ABFC2099", "a counted for loop needs a condition", node);
    if (!node.incrementor) return f.fail("ABFC2099", "a counted for loop needs a step (i++, i--, i = i + 1 or i = i - 1)", node);
    const sym = this.checker.getSymbolAtLocation(d.name);
    const initE = this.expr(d.initializer, "int");
    if (kindOfBpType(initE.type) !== "int") return f.fail("ABFC2012", `the counter of a counted for loop must be an int, not ${initE.type}`, d.initializer);
    const step = this.countStep(node.incrementor, sym);
    if (step === undefined) return f.fail("ABFC2099", "the step of a counted for loop must be i++, i--, i = i + 1 or i = i - 1 on the loop counter", node.incrementor);
    const id = this.nextLocal++;
    if (sym) this.locals.set(sym, { id, name: d.name.text, type: "int", poison: false });
    try {
      const cond = this.expr(node.condition, "bool", true);
      if (cond.type !== "bool") return f.fail("ABFC2012", `the condition of a for loop must be a boolean, not ${cond.type}`, node.condition);
      this.jumps.loops++;
      let body: HirStmt[];
      try {
        body = this.block(node.statement);
      } finally {
        this.jumps.loops--;
      }
      return { k: "forCount", counter: id, name: d.name.text, init: initE, cond, step, body, span: this.sp(node) };
    } finally {
      if (sym) this.locals.delete(sym); // the counter is not visible after the loop
    }
  }

  private countStep(inc: ts.Expression, sym: ts.Symbol | undefined): 1 | -1 | undefined {
    const isCounter = (x: ts.Expression): boolean => {
      const y = stripParens(x);
      return ts.isIdentifier(y) && sym !== undefined && this.checker.getSymbolAtLocation(y) === sym;
    };
    const x = stripParens(inc);
    if ((ts.isPostfixUnaryExpression(x) || ts.isPrefixUnaryExpression(x)) && isCounter(x.operand)) {
      if (x.operator === ts.SyntaxKind.PlusPlusToken) return 1;
      if (x.operator === ts.SyntaxKind.MinusMinusToken) return -1;
      return undefined;
    }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && isCounter(x.left)) {
      const r = stripParens(x.right);
      if (ts.isBinaryExpression(r) && isCounter(r.left) && ts.isNumericLiteral(r.right) && r.right.text === "1") {
        if (r.operatorToken.kind === ts.SyntaxKind.PlusToken) return 1;
        if (r.operatorToken.kind === ts.SyntaxKind.MinusToken) return -1;
      }
    }
    return undefined;
  }

  private jump(node: ts.BreakStatement | ts.ContinueStatement): HirStmt {
    const f: DiagSink = this.sink;
    if (node.label) return f.fail("ABFC2099", "labeled break/continue is not supported", node);
    if (this.jumps.loops === 0) {
      if (this.jumps.callback) return f.fail("ABFC2090", "break and continue cannot leave a forEach callback; use for..of, or return; to skip to the next element", node);
      return f.fail("ABFC2099", "break/continue outside a loop", node);
    }
    return { k: ts.isBreakStatement(node) ? "break" : "continue", span: this.sp(node) };
  }

  /** `return` inside a forEach callback: `return;` directly in the callback skips to the next element. */
  private callbackReturn(node: ts.ReturnStatement): HirStmt {
    const f: DiagSink = this.sink;
    if (node.expression) return f.fail("ABFC2090", "a forEach callback cannot return a value", node);
    if (this.jumps.loops > 0) return f.fail("ABFC2090", "return inside a loop of a forEach callback is not supported; use for..of with break or continue", node);
    return { k: "continue", span: this.sp(node) };
  }

  /** `<array>.forEach((x, i) => { ... })` as a statement: the same loop as `for (const x of <array>)`, with an optional index. */
  private forEachCall(call: ts.CallExpression, callee: ts.PropertyAccessExpression, span: Span): HirStmt {
    const f: DiagSink = this.sink;
    if (callee.questionDotToken || call.questionDotToken) f.fail("ABFC2090", "?.forEach is not supported", call);
    const arg = call.arguments[0];
    if (call.arguments.length !== 1 || !arg) return f.fail("ABFC2090", "forEach takes exactly one inline callback (no thisArg)", call);
    const cb = stripParens(arg);
    if (!ts.isArrowFunction(cb)) return f.fail("ABFC2090", "the forEach callback must be an inline arrow function: (x, i) => { ... }", arg);
    if (ts.getCombinedModifierFlags(cb) & ts.ModifierFlags.Async) f.fail("ABFC2090", "an async forEach callback is not supported", cb);
    const third = cb.parameters[2];
    if (third) f.fail("ABFC2090", "the forEach callback takes (element) or (element, index); the array parameter is not supported", third);
    for (const p of cb.parameters) {
      if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken) f.fail("ABFC2090", "forEach callback parameters must be plain names", p);
    }
    if (!ts.isBlock(cb.body)) return f.fail("ABFC2090", "the forEach callback needs a block body: (x) => { ... }", cb.body);
    const array = this.expr(callee.expression);
    if (!array.type.startsWith("array:")) return f.fail("ABFC2090", "forEach is only supported over Blueprint arrays", callee.expression);
    const elem = array.type.slice("array:".length);
    const elemParam = cb.parameters[0];
    const id = this.nextLocal++;
    const name = elemParam && ts.isIdentifier(elemParam.name) ? elemParam.name.text : "item";
    if (elemParam) {
      const sym = this.checker.getSymbolAtLocation(elemParam.name);
      if (sym) this.locals.set(sym, { id, name, type: elem, poison: false });
    }
    let index: LocalId | undefined;
    const indexParam = cb.parameters[1];
    if (indexParam && ts.isIdentifier(indexParam.name)) {
      index = this.nextLocal++;
      const sym = this.checker.getSymbolAtLocation(indexParam.name);
      if (sym) this.locals.set(sym, { id: index, name: indexParam.name.text, type: "int", poison: false });
    }
    const outer = this.jumps;
    this.jumps = { loops: 0, callback: true };
    let body: HirStmt[];
    try {
      body = this.block(cb.body);
    } finally {
      this.jumps = outer;
    }
    return { k: "forOf", local: id, name, array, elem, body, span, ...(index !== undefined ? { index } : {}) };
  }

  // ---- expressions ----

  private noteTypes(type: ts.Type): void {
    const t = this.checker.getNonNullableType(type);
    if (t.isUnion()) {
      for (const m of t.types) this.noteTypes(m);
      return;
    }
    if (this.checker.isArrayType(t)) {
      const arg = this.checker.getTypeArguments(t as ts.TypeReference)[0];
      if (arg) this.noteTypes(arg);
      return;
    }
    const sym = t.getSymbol();
    if (sym) this.noteSymbol(sym);
  }

  private noteSymbol(sym: ts.Symbol): void {
    const ci = classInfo(sym);
    if (ci && ci.kind === "class") this.classMeta[ci.path] = ci.meta;
  }

  /**
   * `` `Hunger ${hunger}` ``: FormatText where a text is expected; FormatText then Conv_TextToString where a string is
   * expected or nothing is expected (a const). Arg names come from the substitutions.
   */
  private formatText(node: ts.TemplateExpression, expected: BpType | undefined): HirExpr {
    const f: DiagSink = this.sink;
    if (expected === "name") return f.fail("ABFC2099", "a template literal cannot be a name; build a string and convert it, e.g. KismetStringLibrary.Conv_StringToName(`...`)", node);
    if (expected !== undefined && expected !== "text" && expected !== "string") return f.fail("ABFC2099", `a template literal is only supported where a text or string value is expected, not ${expected}`, node);
    const esc = (s: string): string => s.replace(/`/g, "``").replace(/[{}]/g, (c) => "`" + c);
    const allowed = new Set(["text", "string", "name", "int", "int64", "float", "double", "real", "bool"]);
    const used = new Set<string>();
    const args: Array<{ name: string; value: HirExpr }> = [];
    let format = esc(node.head.text);
    node.templateSpans.forEach((span, i) => {
      const x = span.expression;
      let base = `Arg${i}`;
      if (ts.isIdentifier(x)) base = x.text;
      else if (ts.isPropertyAccessExpression(x)) base = x.name.text;
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
      used.add(name);
      const value = this.expr(x);
      if (!allowed.has(value.type)) f.fail("ABFC2099", `a template substitution of type ${value.type} is not supported (text, string, name, int, double, bool)`, x);
      args.push({ name, value });
      format += `{${name}}` + esc(span.literal.text);
    });
    return { k: "formatText", format, args, type: expected === "text" ? "text" : "string", span: this.sp(node) };
  }

  /** `{ A: 1, B }` where the contextual type is a stub struct: MakeStruct (full literals, property assignments only). */
  private makeStruct(node: ts.ObjectLiteralExpression, expected: BpType | undefined): HirExpr {
    const f: DiagSink = this.sink;
    if (expected === undefined || !expected.startsWith("struct:")) return f.fail("ABFC2099", "an object literal is only supported where a stub struct is expected", node);
    const ctx = this.checker.getContextualType(node);
    const fields: Array<{ name: string; value: HirExpr }> = [];
    for (const p of node.properties) {
      let name: string;
      let init: ts.Expression;
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
        name = p.name.text;
        init = p.initializer;
      } else if (ts.isShorthandPropertyAssignment(p)) {
        name = p.name.text;
        init = p.name;
      } else return f.fail("ABFC2099", "only `name: value` and shorthand properties are supported in a struct literal", p);
      const prop = ctx ? this.checker.getPropertyOfType(ctx, name) : undefined;
      const ft = prop ? bpTypeOf(this.checker, this.checker.getTypeOfSymbolAtLocation(prop, node)) : undefined;
      fields.push({ name: (prop ? tsStructMemberName(prop) : undefined) ?? name, value: this.expr(init, ft) });
    }
    return { k: "makeStruct", struct: expected.slice("struct:".length), fields, type: expected, span: this.sp(node) };
  }

  private lit(node: ts.Expression, value: string | number | boolean | null, type: string): HirExpr {
    return { k: "lit", value, type, span: this.sp(node) };
  }

  private expr(node: ts.Expression, expected?: BpType, inCond = false): HirExpr {
    const hole = this.holes.get(node);
    if (hole) return hole;
    if (ts.isParenthesizedExpression(node)) return this.expr(node.expression, expected, inCond);
    if (ts.isNonNullExpression(node)) return this.expr(node.expression, expected, inCond);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === "const") {
        this.sink.fail("ABFC2099", "a type assertion must keep the Blueprint type; \"as const\" is not supported", node);
      }
      const inner = this.expr(node.expression, expected, inCond);
      const to = bpTypeOf(this.checker, this.checker.getTypeFromTypeNode(node.type));
      if (to === undefined || to !== inner.type) {
        this.sink.fail("ABFC2099", `a type assertion must keep the Blueprint type (${inner.type} -> ${to ?? "?"}); use cast(value, Class)`, node);
      }
      return inner;
    }

    const tsType = this.checker.getTypeAtLocation(node);
    if (tsType.flags & ts.TypeFlags.Any && !("intrinsicName" in tsType && (tsType as { intrinsicName?: string }).intrinsicName === "error")) {
      this.sink.fail("ABFC2020", "'any' is not supported", node);
    }
    const tsym = tsType.getSymbol() ?? tsType.aliasSymbol;
    const onContainer = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && this.containerKind(node.expression.expression) !== undefined;
    if (tsym && CONTAINERS.has(tsym.name) && !onContainer && !this.isOwnContainerField(node)) this.sink.fail("ABFC2040", `${tsym.name} is not supported`, node);

    if (node.flags & ts.NodeFlags.OptionalChain && (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isElementAccessExpression(node))) {
      const q = this.chainRoot(node);
      if (q) return this.optional(node, q);
    }

    const out = this.exprInner(node, expected, inCond);
    this.noteTypes(tsType);
    return out;
  }

  /** `this.F` where F is an own field of map or set type (the only place a Map or Set may appear). */
  private isOwnContainerField(node: ts.Expression): boolean {
    if (!ts.isPropertyAccessExpression(node) || node.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
    const sym = this.checker.getSymbolAtLocation(node.name);
    const own = sym ? this.ownFields.get(sym) : undefined;
    return own !== undefined && /^(map|set):/.test(own.type);
  }

  /** The first-evaluated `?.` of an optional chain that is not being resolved yet. */
  private chainRoot(node: ts.Expression): ts.PropertyAccessExpression | ts.CallExpression | ts.ElementAccessExpression | undefined {
    let found: ts.PropertyAccessExpression | ts.CallExpression | ts.ElementAccessExpression | undefined;
    let cur: ts.Expression = node;
    while (cur.flags & ts.NodeFlags.OptionalChain) {
      if (ts.isNonNullExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (!(ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur) || ts.isElementAccessExpression(cur))) break;
      if (cur.questionDotToken && !this.handled.has(cur)) found = cur;
      cur = cur.expression;
    }
    return found;
  }

  private optional(node: ts.Expression, q: ts.PropertyAccessExpression | ts.CallExpression | ts.ElementAccessExpression): HirExpr {
    const recv = q.expression;
    const value = this.expr(recv);
    this.handled.add(q);
    this.holes.set(recv, { k: "hole", type: value.type, span: this.sp(recv) });
    let then: HirExpr;
    try {
      then = this.expr(node);
    } finally {
      this.holes.delete(recv);
      this.handled.delete(q);
    }
    return { k: "optional", value, then, type: then.type, span: this.sp(node) };
  }

  private exprInner(node: ts.Expression, expected: BpType | undefined, inCond: boolean): HirExpr {
    const f: DiagSink = this.sink;
    const sp = this.sp(node);
    switch (node.kind) {
      case ts.SyntaxKind.ThisKeyword:
        return { k: "self", type: `object:${this.cls.classPath}`, span: sp };
      case ts.SyntaxKind.NullKeyword:
        return { k: "lit", value: null, type: "null", span: sp };
      case ts.SyntaxKind.TrueKeyword:
        return { k: "lit", value: true, type: "bool", span: sp };
      case ts.SyntaxKind.FalseKeyword:
        return { k: "lit", value: false, type: "bool", span: sp };
      case ts.SyntaxKind.NumericLiteral:
        return this.lit(node, Number((node as ts.NumericLiteral).text), expected !== undefined && NUMERIC.has(expected) ? expected : "number");
      case ts.SyntaxKind.TemplateExpression:
        return this.formatText(node as ts.TemplateExpression, expected);
      case ts.SyntaxKind.ObjectLiteralExpression:
        return this.makeStruct(node as ts.ObjectLiteralExpression, expected);
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.StringLiteral:
        if (expected !== undefined && expected.startsWith("enum:")) return this.enumLit(node as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, expected);
        return this.lit(node, (node as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text, expected !== undefined && STRINGY.has(expected) ? expected : "string");
      case ts.SyntaxKind.Identifier: {
        if (expected !== undefined && expected.startsWith("class:")) {
          const ci = this.classArg(node as ts.Identifier);
          if (ci) {
            this.classMeta[ci.path] = ci.meta;
            return { k: "classRef", path: ci.path, type: expected, span: sp };
          }
        }
        return this.identifier(node as ts.Identifier, sp);
      }
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const u = node as ts.PrefixUnaryExpression;
        if (u.operator === ts.SyntaxKind.ExclamationToken) return { k: "not", e: this.expr(u.operand, "bool", inCond), type: "bool", span: sp };
        if (u.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(u.operand)) {
          return this.lit(node, -Number(u.operand.text), expected !== undefined && NUMERIC.has(expected) ? expected : "number");
        }
        return f.fail("ABFC2099", "this unary operator is not supported", node);
      }
      case ts.SyntaxKind.PropertyAccessExpression:
        return this.propAccess(node as ts.PropertyAccessExpression, sp);
      case ts.SyntaxKind.ElementAccessExpression: {
        const ea = node as ts.ElementAccessExpression;
        const array = this.expr(ea.expression);
        if (!array.type.startsWith("array:")) return f.fail("ABFC2099", "indexing is only supported on Blueprint arrays", ea.expression);
        const index = this.expr(ea.argumentExpression, "int");
        if (kindOfBpType(index.type) !== "int") return f.fail("ABFC2012", `an array index must be an int, not ${index.type}`, ea.argumentExpression);
        const elem = array.type.slice("array:".length);
        return { k: "index", array, index, elem, type: elem, span: sp };
      }
      case ts.SyntaxKind.CallExpression:
        return this.callExpr(node as ts.CallExpression, sp);
      case ts.SyntaxKind.BinaryExpression:
        return this.binary(node as ts.BinaryExpression, inCond, sp);
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ClassExpression:
        return f.fail("ABFC2020", "closures and function expressions are not supported", node);
      case ts.SyntaxKind.NewExpression:
        return f.fail("ABFC2020", "`new` is not supported", node);
      case ts.SyntaxKind.SpreadElement:
      case ts.SyntaxKind.YieldExpression:
        return f.fail("ABFC2020", "spread and generators are not supported", node);
      case ts.SyntaxKind.ArrayLiteralExpression: {
        const spread = (node as ts.ArrayLiteralExpression).elements.find((el) => ts.isSpreadElement(el));
        if (spread) f.fail("ABFC2020", "spread is not supported", spread);
        return f.fail("ABFC2099", "array literals are not supported", node);
      }
      case ts.SyntaxKind.AwaitExpression:
        return this.awaitFail(node);
      case ts.SyntaxKind.ConditionalExpression:
        return f.fail("ABFC2099", "the conditional operator `?:` is only supported as the whole right-hand side of this.X = c ? a : b", node);
      case ts.SyntaxKind.TaggedTemplateExpression:
        return f.fail("ABFC2099", "tagged template strings are not supported", node);
      default:
        return f.fail("ABFC2099", `expression of kind ${ts.SyntaxKind[node.kind]} is not supported`, node);
    }
  }

  private enumLit(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, expected: BpType): HirExpr {
    const ctx = this.checker.getContextualType(node);
    if (ctx) {
      const members = ctx.isUnion() ? ctx.types : [ctx];
      const known = members.filter((m): m is ts.StringLiteralType => m.isStringLiteral()).map((m) => m.value);
      if (known.length > 0 && !known.includes(node.text)) {
        this.sink.fail("ABFC2015", `"${node.text}" is not a value of ${expected.slice("enum:".length)} (${known.join(", ")})`, node);
      }
    }
    return { k: "enumLit", text: node.text, enumPath: expected.slice("enum:".length), type: expected, span: this.sp(node) };
  }

  /** The owned method a `this.<Name>` expression names, if any. */
  private ownMethodOf(node: ts.PropertyAccessExpression): OwnSig | undefined {
    if (node.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
    const own = this.ownSigs.get(node.name.text);
    if (!own) return undefined;
    const sym = this.checker.getSymbolAtLocation(node.name);
    return sym === undefined || (sym.declarations ?? []).includes(own.node) ? own : undefined;
  }

  /** A delegate argument: a reference to an owned `@event` method. */
  private delegateArg(arg: ts.Expression): HirExpr {
    let x = arg;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    const own = ts.isPropertyAccessExpression(x) ? this.ownMethodOf(x) : undefined;
    if (!ts.isPropertyAccessExpression(x) || !own || own.kind !== "event") {
      return this.sink.fail("ABFC2054", "a delegate argument must be a reference to an own @event method (this.<Name>)", arg);
    }
    return { k: "delegateRef", event: x.name.text, type: "delegate", span: this.sp(arg) };
  }

  private identifier(node: ts.Identifier, sp: Span): HirExpr {
    // `{ Label }`: the name of a shorthand property stands for the variable of that name, not the property
    const sym = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
      : this.checker.getSymbolAtLocation(node);
    const local = sym ? this.locals.get(sym) : undefined;
    if (local) {
      if (local.poison) throw new Fail();
      return { k: "local", id: local.id, type: local.type, span: sp };
    }
    const par = sym ? this.params.get(sym) : undefined;
    if (par) return { k: "param", name: par.name, type: par.type, span: sp };
    return this.sink.fail("ABFC2099", `identifier "${node.text}" cannot be used as a value`, node);
  }

  private localOf(node: ts.Expression): LocalInfo | undefined {
    if (!ts.isIdentifier(node)) return undefined;
    const sym = this.checker.getSymbolAtLocation(node);
    return sym ? this.locals.get(sym) : undefined;
  }

  private structPathOf(type: ts.Type): string | undefined {
    const sym = this.checker.getNonNullableType(type).getSymbol();
    const ci = sym ? classInfo(sym) : undefined;
    return ci && ci.kind === "struct" ? ci.path : undefined;
  }

  private propAccess(node: ts.PropertyAccessExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    if (ts.isPrivateIdentifier(node.name)) return f.fail("ABFC2099", "private names are not supported", node.name);
    const name = node.name.text;
    const recv = node.expression;
    const memberSym = this.checker.getSymbolAtLocation(node.name);

    if (recv.kind === ts.SyntaxKind.ThisKeyword) {
      if (this.ownMethodOf(node)) return f.fail("ABFC2054", "method references are only allowed as delegate arguments", node);
      const ownF = memberSym ? this.ownFields.get(memberSym) : undefined;
      if (ownF) return { k: "getSelf", name: ownF.name, type: ownF.type, span: sp };
      const type = memberSym ? bpTypeOfMember(memberSym) : undefined;
      if (type === undefined) {
        if (memberSym && bpPathOf(memberSym) !== undefined) f.fail("ABFC2099", `${name} is not a Blueprint variable`, node.name);
        return f.fail("ABFC2060", `member ${name} has no Blueprint metadata (@bpPath)`, node.name);
      }
      const mp = splitMemberPath(bpPathOf(memberSym!) ?? "");
      const bpName = mp?.name ?? name;
      // a member a parent class declares: the get names that class, so the backend's scratch Blueprint (an Actor) can
      // build its pins (a self-context get of IsDepleted on a game crate had none)
      if (mp && mp.owner !== this.cls.classPath) return { k: "getSelf", name: bpName, owner: mp.owner, type, span: sp };
      return { k: "getSelf", name: bpName, type, span: sp };
    }

    const local = this.localOf(recv);
    if (name === "exec" && local?.fn?.execOutputs) {
      return f.fail("ABFC2053", "`.exec` may only be used as `r.exec === \"Pin\"` or `r.exec !== \"Pin\"` in an if condition", node);
    }
    const recvKind = this.containerKind(recv);
    if (recvKind !== undefined) {
      if (recvKind === "other" || name !== "size") return f.fail("ABFC2040", `${recvKind === "map" ? "Map" : recvKind === "set" ? "Set" : "this container"}.${name} is not supported (only .size; no iteration)`, node.name);
      const self = this.selfContainer(recv);
      if (!self) return f.fail("ABFC2042", CONTAINER_OWN_ONLY, recv);
      return { k: "containerQuery", container: recvKind, op: "size", target: this.expr(recv), targetType: self.type, type: "int", span: sp };
    }
    const obj = this.expr(recv);

    if (name === "length" && obj.type.startsWith("array:")) return { k: "length", array: obj, arrayType: obj.type, type: "int", span: sp };

    if (local?.fn) {
      const pin = local.fn.pinOfTs.get(name) ?? name;
      const o = local.fn.outs.find((x) => x.pin === pin);
      if (!o) return f.fail("ABFC2099", `${local.name} has no output "${name}"`, node.name);
      return { k: "out", call: obj, pin, type: o.type, span: sp };
    }

    const recvType = this.checker.getTypeAtLocation(recv);
    const structPath = this.structPathOf(recvType);
    if (structPath !== undefined) {
      const type = (memberSym ? bpTypeOfMember(memberSym) : undefined) ?? (memberSym ? bpTypeOf(this.checker, this.checker.getTypeAtLocation(node)) : undefined) ?? "unknown";
      // A TS @struct names its pins <Field>_<index>_<GUID>.
      return { k: "field", obj, struct: structPath, name: (memberSym ? tsStructMemberName(memberSym) : undefined) ?? name, type, span: sp };
    }

    const path = memberSym ? bpPathOf(memberSym) : undefined;
    const mp = path === undefined ? undefined : splitMemberPath(path);
    if (!memberSym || !mp) {
      const ph = placeholdersOfType(this.checker, this.checker.getTypeAtLocation(recv))[0];
      if (ph !== undefined) {
        return f.fail("ABFC2060", `member ${name} has no Blueprint metadata (@bpPath): ${ph.name} is a placeholder without members; "abfc generate" (or the next "abfc build") generates it because the source uses it`, node.name);
      }
      return f.fail("ABFC2060", `member ${name} has no Blueprint metadata (@bpPath)`, node.name);
    }
    const type = bpTypeOfMember(memberSym) ?? bpTypeOf(this.checker, this.checker.getTypeAtLocation(node));
    if (type === undefined) return f.fail("ABFC2099", `${name} is not a Blueprint variable`, node.name);
    return { k: "getOn", obj, owner: mp.owner, name: mp.name, type, span: sp };
  }

  private classArg(arg: ts.Expression | undefined): { path: string; meta: string; castPin: string | null; sym: ts.Symbol } | undefined {
    if (!arg) return undefined;
    const s = this.checker.getSymbolAtLocation(arg);
    if (!s) return undefined;
    const sym = resolveAlias(this.checker, s);
    const ci = classInfo(sym);
    return ci ? { path: ci.path, meta: ci.meta, castPin: ci.castPin, sym } : undefined;
  }

  /**
   * `asset(Class, "/Mod/Dir/Asset")` or `asset(Class, "@mod/Dir/Asset")`: a hard reference to an existing asset, written as the
   * default object of the pin it is passed to (no load node, so it cooks with the Blueprint). Only valid as a call argument.
   */
  private assetExpr(node: ts.CallExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const [clsArg, pathArg] = node.arguments;
    if (node.arguments.length !== 2 || !pathArg || !(ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg))) {
      return f.fail("ABFC2099", "asset(Class, path) takes a class and one string literal path", node);
    }
    const ci = this.classArg(clsArg);
    if (!ci) return f.fail("ABFC2060", "the asset class has no Blueprint metadata (@bpPath)", clsArg ?? node);
    let path = pathArg.text;
    if (path.startsWith("@mod/")) path = `/${this.mod}/${path.slice("@mod/".length)}`;
    if (!/^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)+(\.[A-Za-z0-9_]+)?$/.test(path) || path.startsWith("/Script/")) {
      return f.fail("ABFC2099", `asset path "${pathArg.text}" must be a package path such as "/Game/Dir/Asset" or "@mod/Dir/Asset"`, pathArg);
    }
    if (!path.includes(".")) path = `${path}.${path.slice(path.lastIndexOf("/") + 1)}`;
    return { k: "assetRef", text: `${ci.path}'${path}'`, type: `object:${ci.path}`, span: sp };
  }

  private callExpr(node: ts.CallExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      const rt = runtimeName(this.checker, node);
      if (rt === "cast") {
        if (node.arguments.length !== 2) f.fail("ABFC2099", "cast(value, Class) takes two arguments", node);
        const arg0 = node.arguments[0]!;
        const value = this.expr(arg0);
        const ci = this.classArg(node.arguments[1]);
        if (!ci) return f.fail("ABFC2060", "the cast target has no Blueprint metadata (@bpPath)", node.arguments[1] ?? node);
        if (ci.castPin === null) return f.fail("ABFC3004", `no cast pin known for ${ci.path}; run "abfc generate" (it generates the classes the source uses) or "abfc generate --add ${ci.path}" to retry it`, node);
        this.classMeta[ci.path] = ci.meta;
        return { k: "cast", value, target: ci.path, castPin: ci.castPin, type: `object:${ci.path}`, span: sp };
      }
      if (rt === "isValid") {
        if (node.arguments.length !== 1) f.fail("ABFC2099", "isValid(value) takes one argument", node);
        return { k: "isValid", value: this.expr(node.arguments[0]!), type: "bool", span: sp };
      }
      if (rt === "nameOf") {
        const a0 = node.arguments[0];
        if (node.arguments.length !== 1 || !a0 || !(ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0))) {
          return f.fail("ABFC2099", "nameOf(text) takes one string literal", node);
        }
        return { k: "nameLit", text: a0.text, type: "name", span: sp };
      }
      if (rt === "idiv") {
        if (node.arguments.length !== 2) return f.fail("ABFC2099", "idiv(a, b) takes two arguments", node);
        const { a, b, kind } = this.numericPair(node.arguments[0]!, node.arguments[1]!, node, "idiv");
        if (kind !== "int") return f.fail("ABFC2012", `idiv takes int operands, not ${a.type}`, node);
        return { k: "arith", op: "/", kind: "int", a, b, type: "int", span: sp };
      }
      if (rt === "asset") return this.assetExpr(node, sp);
      if (rt === "createWidget") return this.createWidgetExpr(node, sp);
      if (rt === "spawnActor") return this.spawnExpr(node, sp);
      if (callee.text === "eval") return f.fail("ABFC2020", "eval is not supported", node);
      return f.fail("ABFC2099", `call of "${callee.text}" is not supported`, node);
    }
    if (!ts.isPropertyAccessExpression(callee)) return f.fail("ABFC2099", "only method and library calls are supported", node);

    if (callee.expression.kind === ts.SyntaxKind.SuperKeyword) return this.superCall(node, callee, sp);

    const ck = this.containerKind(callee.expression);
    if (ck !== undefined) return this.containerCall(node, callee, ck, sp);

    if (this.isArrayNode(callee.expression)) {
      const m = callee.name.text;
      if (m === "indexOf") {
        if (node.arguments.length !== 1) return f.fail("ABFC2099", "indexOf(value) takes one argument", node);
        const array = this.expr(callee.expression);
        if (!array.type.startsWith("array:")) return f.fail("ABFC2099", "indexOf is only supported on Blueprint arrays", callee.expression);
        const elem = array.type.slice("array:".length);
        return { k: "arrayFind", array, value: this.expr(node.arguments[0]!, elem), elem, type: "int", span: sp };
      }
      if (ARRAY_MUTATORS.has(m)) return f.fail("ABFC2041", ARRAY_OWN_ONLY, node);
    }

    const own = this.ownMethodOf(callee);
    if (own) {
      const ownArgs: Array<{ pin: string; value: HirExpr }> = [];
      node.arguments.forEach((a) => {
        const p = own.params[ownArgs.length];
        if (!p) f.fail("ABFC2099", `too many arguments for ${callee.name.text}`, a);
        ownArgs.push({ pin: p.name, value: this.expr(a, p.type) });
      });
      const callees = this.ownCalls.get(this.unitName) ?? new Set<string>();
      callees.add(callee.name.text);
      this.ownCalls.set(this.unitName, callees);
      return { k: "callOwn", name: callee.name.text, args: ownArgs, type: own.returnType ?? "void", span: sp };
    }

    const sym = this.checker.getSymbolAtLocation(callee.name);
    const fi = sym ? (functionInfo(sym) ?? ownEventInfo(this.checker, sym)) : undefined;
    if (!fi) {
      const ph = placeholdersOfType(this.checker, this.checker.getTypeAtLocation(callee.expression))[0];
      if (ph !== undefined) {
        return f.fail("ABFC2060", `function ${callee.name.text} has no Blueprint metadata (@bpPath): ${ph.name} is a placeholder without members; "abfc generate" (or the next "abfc build") generates it because the source uses it`, callee.name);
      }
      return f.fail("ABFC2060", `function ${callee.name.text} has no Blueprint metadata (@bpPath)`, callee.name);
    }
    if (this.unitKind === "function" && fi.latent) {
      f.fail(
        "ABFC2086",
        `${fi.name} is a latent action and cannot be called inside the function ${this.unitName} (Blueprint functions finish in one frame); call it from an @event or @override`,
        callee.name,
      );
    }

    if (fi.execOutputs !== null) {
      const p = node.parent;
      const okParent = ts.isExpressionStatement(p) || (ts.isVariableDeclaration(p) && p.initializer === node);
      if (!okParent) f.fail("ABFC2052", "the result of a function with exec outputs must be stored in a const and branched by the next statement", node);
    }

    let target: HirExpr | null = null;
    if (fi.static) {
      const ns = this.checker.getSymbolAtLocation(callee.expression);
      if (ns) this.noteSymbol(resolveAlias(this.checker, ns));
    } else if (callee.expression.kind !== ts.SyntaxKind.ThisKeyword) {
      target = this.expr(callee.expression);
    }

    const args: Array<{ pin: string; value: HirExpr }> = [];
    node.arguments.forEach((a, argIndex) => {
      const p = fi.params[argIndex];
      if (!p) f.fail("ABFC2099", `too many arguments for ${fi.name}`, a);
      if (ts.isIdentifier(a) && a.text === "undefined") {
        // an omitted argument sets no pin: the call node keeps the default Unreal fills in when the node is created
        if (p.default === undefined) f.fail("ABFC2099", `argument ${p.pin} of ${fi.name} has no default`, a);
        return;
      }
      // `[]` for an array input: the pin stays unwired, which Blueprint reads as an empty array (LineTraceSingle's ActorsToIgnore)
      if (ts.isArrayLiteralExpression(stripParens(a)) && (stripParens(a) as ts.ArrayLiteralExpression).elements.length === 0 && p.type.startsWith("array:")) return;
      args.push({ pin: p.pin, value: p.type === "unsupported:delegate" ? this.delegateArg(a) : this.expr(a, p.type) });
    });

    // A single output that is not ReturnValue stays a result object, as the stubs type it (`GetOverlappingActors(...): { OverlappingActors: Actor[] }`).
    const multi = fi.execOutputs !== null || fi.outs.length > 1 || (fi.outs.length === 1 && fi.outs[0]?.pin !== "ReturnValue");
    const type = multi ? "result" : (fi.outs[0]?.type ?? "void");
    const out: HirExpr = {
      k: "call",
      owner: fi.owner === this.cls.classPath ? null : fi.owner,
      name: fi.name,
      target,
      static: fi.static,
      pure: fi.pure,
      execOutputs: fi.execOutputs,
      args,
      outs: fi.outs,
      type,
      span: sp,
    };
    this.callInfo.set(out, fi);
    return out;
  }

  /** `super.X(args)` inside `@override X`: the parent's implementation (Blueprint "Add Call to Parent Function"). */
  private superCall(node: ts.CallExpression, callee: ts.PropertyAccessExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const name = callee.name.text;
    if (this.unitKind !== "override" || name !== this.unitName) {
      return f.fail("ABFC2099", `super.${name}() can only be called inside @override ${name} (it calls the parent's ${name})`, node);
    }
    const sym = this.checker.getSymbolAtLocation(callee.name);
    const fi = sym ? functionInfo(sym) : undefined;
    if (!fi) return f.fail("ABFC2060", `function ${name} has no Blueprint metadata (@bpPath)`, callee.name);
    if (fi.outs.length > 0 || fi.execOutputs !== null) return f.fail("ABFC2099", `super.${name}() is supported only for parent events without outputs`, node);
    const args: Array<{ pin: string; value: HirExpr }> = [];
    node.arguments.forEach((a, i) => {
      const p = fi.params[i];
      if (!p) f.fail("ABFC2099", `too many arguments for ${name}`, a);
      args.push({ pin: p.pin, value: this.expr(a, p.type) });
    });
    return { k: "call", owner: this.cls.parent, name, target: null, static: false, pure: false, execOutputs: null, args, outs: [], type: "void", parentCall: true, span: sp };
  }

  private createWidgetExpr(node: ts.CallExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    if (node.arguments.length !== 2) return f.fail("ABFC2099", "createWidget(Class, owningPlayer) takes two arguments", node);
    const ci = this.classArg(node.arguments[0]);
    if (!ci) return f.fail("ABFC2060", "the widget class has no Blueprint metadata (@bpPath)", node.arguments[0] ?? node);
    this.classMeta[ci.path] = ci.meta;
    const owner = this.expr(node.arguments[1]!);
    return { k: "createWidget", cls: ci.path, owner, type: `object:${ci.path}`, span: sp };
  }

  private spawnExpr(node: ts.CallExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const [clsArg, optsArg] = node.arguments;
    if (!clsArg || node.arguments.length > 2) return f.fail("ABFC2099", "spawnActor(Class, options?) takes a class and an optional options object", node);
    const ci = this.classArg(clsArg);
    if (!ci) return f.fail("ABFC2060", "the spawned class has no Blueprint metadata (@bpPath)", clsArg);
    this.classMeta[ci.path] = ci.meta;
    let owner: HirExpr | undefined;
    let transform: HirExpr | undefined;
    let collision: string | undefined;
    let scale: string | undefined;
    if (optsArg) {
      if (!ts.isObjectLiteralExpression(optsArg)) return f.fail("ABFC2056", "spawnActor options must be an object literal", optsArg);
      for (const p of optsArg.properties) {
        const key = ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
        if (!ts.isPropertyAssignment(p) || key === undefined) return f.fail("ABFC2056", "spawnActor options must be plain key: value entries", p);
        const init = p.initializer;
        const text = ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init.text : undefined;
        if (key === "owner") owner = this.expr(init);
        else if (key === "transform") {
          transform = this.expr(init, "struct:/Script/CoreUObject.Transform");
          if (transform.type !== "struct:/Script/CoreUObject.Transform") return f.fail("ABFC2056", "spawnActor option transform must be a Transform", init);
        }
        else if (key === "collisionHandlingOverride" || key === "transformScaleMethod") {
          if (text === undefined) return f.fail("ABFC2056", `spawnActor option ${key} must be a string literal (the enum text)`, init);
          if (key === "collisionHandlingOverride") collision = text;
          else scale = text;
        } else if (key === "instigator") return f.fail("ABFC2056", "spawnActor option instigator is not supported yet", p);
        else return f.fail("ABFC2056", `unknown spawnActor option "${key}" (owner, transform, collisionHandlingOverride, transformScaleMethod)`, p.name);
      }
    }
    return {
      k: "spawn",
      cls: ci.path,
      ...(owner ? { owner } : {}),
      ...(transform ? { transform } : {}),
      ...(collision !== undefined ? { collision } : {}),
      ...(scale !== undefined ? { scale } : {}),
      type: `object:${ci.path}`,
      span: sp,
    };
  }

  private isLiteralNode(n: ts.Expression): boolean {
    let x = n;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    return (
      ts.isNumericLiteral(x) ||
      ts.isStringLiteral(x) ||
      x.kind === ts.SyntaxKind.TrueKeyword ||
      x.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(x.operand))
    );
  }

  private binary(node: ts.BinaryExpression, inCond: boolean, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const op = node.operatorToken.kind;
    switch (op) {
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return f.fail("ABFC2011", "`==` and `!=` are not supported; use `===` and `!==`", node);
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return this.eqExpr(node, false, sp);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return this.eqExpr(node, true, sp);
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken: {
        if (!inCond) f.fail("ABFC2099", "`&&` and `||` are only supported inside if conditions", node);
        const a = this.expr(node.left, "bool", true);
        const b = this.expr(node.right, "bool", true);
        return op === ts.SyntaxKind.AmpersandAmpersandToken ? { k: "and", a, b, type: "bool", span: sp } : { k: "or", a, b, type: "bool", span: sp };
      }
      case ts.SyntaxKind.PlusToken:
        return this.arithExpr(node, "+", sp);
      case ts.SyntaxKind.MinusToken:
        return this.arithExpr(node, "-", sp);
      case ts.SyntaxKind.AsteriskToken:
        return this.arithExpr(node, "*", sp);
      case ts.SyntaxKind.LessThanToken:
        return this.cmpExpr(node, "<", sp);
      case ts.SyntaxKind.LessThanEqualsToken:
        return this.cmpExpr(node, "<=", sp);
      case ts.SyntaxKind.GreaterThanToken:
        return this.cmpExpr(node, ">", sp);
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return this.cmpExpr(node, ">=", sp);
      case ts.SyntaxKind.SlashToken: {
        const kinds = [node.left, node.right].map((x) => {
          const t = bpTypeOf(this.checker, this.checker.getTypeAtLocation(x));
          return t === undefined ? undefined : kindOfBpType(t);
        });
        if (kinds.includes("int") || kinds.includes("byte")) return f.fail("ABFC2010", "`/` on integer values is not supported; use idiv(a, b)", node);
        return this.arithExpr(node, "/", sp); // Divide_DoubleDouble
      }
      default:
        return f.fail("ABFC2099", `operator ${node.operatorToken.getText()} is not supported`, node.operatorToken);
    }
  }

  /** Both operands of `+ - * < <= > >=`: same numeric kind (int or real); literals take the other side's type. */
  private numericOperands(node: ts.BinaryExpression): { a: HirExpr; b: HirExpr; kind: "int" | "real" } {
    return this.numericPair(node.left, node.right, node, node.operatorToken.getText());
  }

  /** Two operands of a numeric operation (`node` is the whole expression for diagnostics, `opText` names the operator or function). */
  private numericPair(left: ts.Expression, right: ts.Expression, node: ts.Node, opText: string): { a: HirExpr; b: HirExpr; kind: "int" | "real" } {
    const f: DiagSink = this.sink;
    const strip = (x: ts.Expression): ts.Expression => {
      let y = x;
      while (ts.isParenthesizedExpression(y)) y = y.expression;
      return y;
    };
    const l = strip(left);
    const r = strip(right);
    let a: HirExpr;
    let b: HirExpr;
    if (this.isLiteralNode(l) && !this.isLiteralNode(r)) {
      b = this.expr(r);
      a = this.expr(l, b.type);
    } else {
      a = this.expr(l);
      b = this.expr(r, a.type);
    }
    const ka = kindOfBpType(a.type);
    const kb = kindOfBpType(b.type);
    if (ka === undefined && kb === undefined) return f.fail("ABFC2014", "the number kind of this expression is not inferable; use int, int64, byte, float or double values", node);
    if (ka !== undefined && kb !== undefined && ka !== kb) return f.fail("ABFC2012", `cannot combine ${a.type} with ${b.type}: operands need the same number kind (int or real)`, node);
    const kind = (ka ?? kb)!;
    if (kind !== "int" && kind !== "real") return f.fail("ABFC2012", `${opText} needs int or real operands, not ${a.type}`, node);
    return { a, b, kind };
  }

  private arithExpr(node: ts.BinaryExpression, op: "+" | "-" | "*" | "/", sp: Span): HirExpr {
    const { a, b, kind } = this.numericOperands(node);
    return { k: "arith", op, kind, a, b, type: kind === "int" ? "int" : "double", span: sp };
  }

  private cmpExpr(node: ts.BinaryExpression, op: "<" | "<=" | ">" | ">=", sp: Span): HirExpr {
    const { a, b, kind } = this.numericOperands(node);
    return { k: "cmp", op, kind, a, b, type: "bool", span: sp };
  }

  private eqExpr(node: ts.BinaryExpression, negate: boolean, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const strip = (x: ts.Expression): ts.Expression => {
      let y = x;
      while (ts.isParenthesizedExpression(y)) y = y.expression;
      return y;
    };
    const l = strip(node.left);
    const r = strip(node.right);

    const isNull = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.NullKeyword;
    if (isNull(l) || isNull(r)) {
      const v = this.expr(isNull(r) ? l : r);
      const valid: HirExpr = { k: "isValid", value: v, type: "bool", span: sp };
      return negate ? valid : { k: "not", e: valid, type: "bool", span: sp };
    }

    // r.exec === "Pin"
    const execSide = [l, r].find((x): x is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(x) && x.name.text === "exec");
    if (execSide) {
      const local = this.localOf(execSide.expression);
      if (local?.fn?.execOutputs) {
        const other = execSide === l ? r : l;
        if (!ts.isStringLiteral(other)) f.fail("ABFC2053", "`.exec` must be compared with a string literal pin name", node);
        if (!local.fn.execOutputs.includes(other.text)) f.fail("ABFC2099", `${local.name}.exec has no pin "${other.text}"`, other);
        return { k: "execIs", local: local.id, pin: other.text, negate, type: "bool", span: sp };
      }
    }

    let a: HirExpr;
    let b: HirExpr;
    if (this.isLiteralNode(l) && !this.isLiteralNode(r)) {
      b = this.expr(r);
      a = this.expr(l, b.type);
    } else {
      a = this.expr(l);
      b = this.expr(r, a.type);
    }
    const ka = kindOfBpType(a.type);
    const kb = kindOfBpType(b.type);
    if (ka === undefined && kb === undefined) return f.fail("ABFC2014", "the number kind of this comparison is not inferable; use int, int64, byte, float or double values", node);
    if (ka !== undefined && kb !== undefined && ka !== kb) return f.fail("ABFC2013", `cannot compare ${a.type} with ${b.type} (different Blueprint kinds)`, node);
    const kind = (ka ?? kb)!;
    return { k: "eq", negate, a, b, kind, type: "bool", span: sp };
  }
}

/** Structs ordered so that a struct comes after the structs its fields use (a cycle keeps declaration order). */
function orderStructs(structs: HirStruct[]): HirStruct[] {
  const byObject = new Map(structs.map((x) => [x.objectPath, x]));
  const out: HirStruct[] = [];
  const state = new Map<HirStruct, 1 | 2>();
  const visit = (x: HirStruct): void => {
    if (state.has(x)) return;
    state.set(x, 1);
    for (const f of x.fields) {
      const dep = f.type.startsWith("struct:") ? byObject.get(f.type.slice("struct:".length)) : undefined;
      if (dep !== undefined) visit(dep);
    }
    state.set(x, 2);
    out.push(x);
  };
  for (const x of structs) visit(x);
  return out;
}

/**
 * Builds the HIR of the class files (or of `only`). Subset violations are ABFC2xxx diagnostics in the result; TypeScript's own
 * diagnostics are in `LoadedProgram.diagnostics`.
 */
export function buildHir(loaded: LoadedProgram, config: CompilerProjectConfig, _profile: Profile, only?: readonly ts.SourceFile[]): HirProgram {
  bindPathContext(loaded, config);
  const b = new HirBuilder(loaded, config.mod);
  for (const sf of only ?? loaded.files.classes) {
    b.sink.diagnostics.push(...modImportHints(sf));
    for (const st of sf.statements) if (ts.isClassDeclaration(st)) b.classDecl(st);
  }
  if (only === undefined) {
    // whole program only: a subset cannot see the other file of a duplicate
    const seen = new Map<string, { name: string; file: string }>();
    // a class with a derived path is the established one; an explicit `path:` that lands on it is the odd one out
    const all = [...b.classes, ...b.structs];
    for (const x of [...all.filter((y) => y.pathDerived), ...all.filter((y) => !y.pathDerived)]) {
      const key = x.path.toLowerCase();
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, { name: x.name, file: x.span.file });
      } else {
        b.sink.diagnostics.push({
          severity: "error",
          code: "ABFC2007",
          message: `asset path ${x.path} of ${x.name} is already used by ${first.name} (${first.file})`,
          span: x.span,
        });
      }
    }
  }
  if (only === undefined) {
    const rows = new Map<string, string>();
    for (const c of b.classes) {
      if (c.director === undefined) continue;
      const key = c.director.row.toLowerCase();
      const first = rows.get(key);
      if (first === undefined) rows.set(key, c.name);
      else {
        b.sink.diagnostics.push({
          severity: "error",
          code: "ABFC2075",
          message: `class-manager row ${c.director.row} of ${c.name} is already used by ${first}`,
          span: c.span,
        });
      }
    }
  }
  return { mod: config.mod, classes: b.classes, structs: orderStructs(b.structs), classMeta: b.classMeta, diagnostics: b.sink.diagnostics };
}

/** Diagnostics (TypeScript's and the subset checker's) of one file. */
export function checkSubset(loaded: LoadedProgram, file: ts.SourceFile, config: CompilerProjectConfig, profile: Profile): Diagnostic[] {
  const hir = buildHir(loaded, config, profile, [file]);
  const rel = relFile(loaded.projectDir, file.fileName);
  return [...loaded.diagnostics.filter((d) => d.span?.file === rel), ...hir.diagnostics];
}
