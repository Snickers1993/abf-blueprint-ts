// High-level IR: the TypeScript subset after the frontend has resolved every name against the stubs.
// This file never imports `typescript`; later passes (lowering, planning) only see these shapes.
import type { Diagnostic, Span } from "@abfc/ir";

/** bp_apply type grammar, e.g. "int", "object:/Script/Engine.Actor", "array:name". */
export type BpType = string;

/** Name of the output pin that carries the return value of a Blueprint function (and the result pin of a call of one). */
export const FUNCTION_RETURN_PIN = "ReturnValue";

/** `actor`: derives from Actor; `component`: from ActorComponent; `widget`: from UserWidget; `object`: anything else. */
export type ParentFamily = "actor" | "component" | "widget" | "object";

/** An own member variable (`Name!: T;` or `Name: T = <literal>` in the TS class); abfc declares it in the asset. `default` is Unreal default-value text. */
export interface HirField { name: string; type: BpType; default?: string; span: Span }

export interface HirClass {
  name: string;
  /** Package path, e.g. "/Mod/Dir/BP_X". */
  path: string;
  /** True when the path was derived from the file location (no `path:` option). */
  pathDerived: boolean;
  /** `<path>.<AssetName>_C`. */
  classPath: string;
  /** Class path of the parent (`@bpPath` of the `extends` class). */
  parent: string;
  /** What the parent class derives from; a changed `extends` inside one family is a reparent, across families a recreate (docs/design.md 18.2). */
  family: ParentFamily;
  span: Span;
  events: HirEvent[];
  /** Own member variables (`Name!: T;`), in declaration order. */
  fields: HirField[];
  /** Hand-made functions/events of the asset that the TS class sees through `<X>_Manual` (tag `@bpHandMade`). */
  manualUnits: string[];
  /** The class symbol also has an `interface X extends X_Manual` declaration (design 13): the hand-made members are part of the class and are kept. */
  hybrid: boolean;
  /** Class defaults from the `@blueprint` options (pin names -> T3D text); filled by the class-defaults pass. */
  defaults: Record<string, string>;
  /** Row asset path of the `classManagerRow` option (verified, not written). */
  classManagerRow?: string;
  /** `@director("Row")`: the class-manager row (asset `/<mod>/<classManager.table>/<Row>`) that references this class. */
  director?: { row: string; asset: string; /** The gameplay tag the row holds (`@director("Row", tag)`). */ tag?: string };
  /** `widget`: the asset is a Widget Blueprint (`@blueprint({ kind: "widget" })`). */
  kind?: "widget";
}

export interface HirEvent {
  name: string;
  /** `event`: custom event (`@event`); `override`: override of an event/function of a parent class (`@override`); `function`: undecorated method = Blueprint function graph. */
  kind: "event" | "override" | "function";
  /** Class path of the engine class that declares the overridden event (from the stub's `@bpPath`); only for `override`. */
  overrideOf?: string;
  /** Text of the method's JSDoc comment. */
  doc?: string;
  params: Array<{ name: string; type: BpType }>;
  /** Functions: the Blueprint type of the return value; absent = void. */
  returnType?: BpType;
  /** Functions: the access specifier. */
  access?: "public" | "protected" | "private";
  body: HirStmt[];
  span: Span;
}

export type LocalId = number;

export type HirStmt =
  | { k: "expr"; e: HirExpr; span: Span }
  | { k: "setSelf"; name: string; type: BpType; value: HirExpr; span: Span }
  /** `nextOnly`: every use is inside the very next statement (an expression, const or return statement, or the condition of an if), read once right away. */
  | { k: "const"; local: LocalId; name: string; init: HirExpr; uses: number; nextOnly?: boolean; span: Span }
  | { k: "if"; cond: HirExpr; then: HirStmt[]; else: HirStmt[]; span: Span }
  | { k: "return"; value?: HirExpr; span: Span }
  /** `index`: `arr.forEach((x, i) => ...)`: local of the index parameter (the loop index, int). */
  | { k: "forOf"; local: LocalId; name: string; array: HirExpr; elem: BpType; index?: LocalId; body: HirStmt[]; span: Span }
  /** `this.X = c ? a : b`: Branch plus one set per side. */
  | { k: "setSelfCond"; name: string; type: BpType; cond: HirExpr; a: HirExpr; b: HirExpr; span: Span }
  /** `for (let i = A; cond; i++ | i--)` with an int counter; the counter is only visible in `cond` and `body`. */
  | { k: "forCount"; counter: LocalId; name: string; init: HirExpr; cond: HirExpr; step: 1 | -1; body: HirStmt[]; span: Span }
  /** Mutation of an own array variable: `push(x)`, `splice(i, 1)` (removeAt), `length = 0` (clear), `[i] = x` (set). `array.type` is the array type, e.g. "array:name". */
  | { k: "arrayOp"; op: "push" | "removeAt" | "clear" | "set"; array: { self: string; type: BpType }; value?: HirExpr; index?: HirExpr; span: Span }
  /** Mutation of an own map/set variable: Map `set`/`delete`/`clear`, Set `add`/`delete`/`clear`. `target.type` is e.g. "map:name:int" or "set:name". */
  | { k: "containerOp"; container: "map" | "set"; op: "add" | "remove" | "clear"; target: { self: string; type: BpType }; key?: HirExpr; value?: HirExpr; span: Span }
  /** `break`/`continue` of the innermost enclosing loop (a `return;` directly in a forEach callback is a `continue`). */
  | { k: "break"; span: Span }
  | { k: "continue"; span: Span };

export type HirExpr = (
  | { k: "self" }
  | { k: "param"; name: string }
  | { k: "local"; id: LocalId }
  | { k: "lit"; value: string | number | boolean | null }
  | { k: "getSelf"; name: string }
  | { k: "getOn"; obj: HirExpr; owner: string; name: string }
  | { k: "field"; obj: HirExpr; struct: string; name: string } // struct member read -> BreakStruct
  | { k: "out"; call: HirExpr; pin: string } // multi-output / exec-result member
  | {
      k: "call";
      /** Owning class path of the function; null when it is a member of the unit's own class. */
      owner: string | null;
      name: string;
      /** null = the call is made on `this`. */
      target: HirExpr | null;
      static: boolean;
      pure: boolean;
      execOutputs: string[] | null;
      args: Array<{ pin: string; value: HirExpr }>;
      outs: Array<{ pin: string; type: BpType }>;
    }
  | { k: "cast"; value: HirExpr; target: string; castPin: string }
  | { k: "optional"; value: HirExpr; then: HirExpr } // a?.b : `then` refers to value via { k: "hole" }
  | { k: "hole" }
  | { k: "isValid"; value: HirExpr }
  | { k: "eq"; negate: boolean; a: HirExpr; b: HirExpr; kind: "object" | "name" | "string" | "int" | "real" | "bool" | "byte" }
  | { k: "not"; e: HirExpr }
  | { k: "and"; a: HirExpr; b: HirExpr }
  | { k: "or"; a: HirExpr; b: HirExpr }
  | { k: "length"; array: HirExpr; arrayType: BpType }
  | { k: "execIs"; local: LocalId; pin: string; negate: boolean }
  /** Call of an owned `@event`/`@override` of the same class (`this.RelayTick(dt)`); `args` use the event's parameter names as pins. */
  | { k: "callOwn"; name: string; args: Array<{ pin: string; value: HirExpr }> }
  /** A Blueprint class used as a value (`WBP_X_C` in a class-typed argument). */
  | { k: "classRef"; path: string }
  /** An asset used as a pin's default object (`asset(StaticMesh, "@mod/Meshes/SM_X")`); `text` is the full object text `<class>'<package>.<name>'`. */
  | { k: "assetRef"; text: string }
  /** A reference to an owned event passed to a delegate-typed parameter (`this.ScanPlayers`). */
  | { k: "delegateRef"; event: string }
  /** Enum value as its T3D text. */
  | { k: "enumLit"; text: string; enumPath: string }
  | { k: "nameLit"; text: string }
  | { k: "createWidget"; cls: string; owner: HirExpr }
  | { k: "spawn"; cls: string; owner?: HirExpr; collision?: string; scale?: string }
  | { k: "arith"; op: "+" | "-" | "*" | "/"; kind: "int" | "real"; a: HirExpr; b: HirExpr }
  | { k: "cmp"; op: "<" | "<=" | ">" | ">="; kind: "int" | "real"; a: HirExpr; b: HirExpr }
  | { k: "index"; array: HirExpr; index: HirExpr; elem: BpType }
  /** `arr.indexOf(x)`: Array_Find (-1 when absent). `elem` is the element type. */
  | { k: "arrayFind"; array: HirExpr; value: HirExpr; elem: BpType }
  /** Pure query of an own map/set: `has` (Map_Contains/Set_Contains, bool), `get` (Map_Find `Value`, the value type), `size` (Map_Length/Set_Length, int). `key` is the key or element. */
  | { k: "containerQuery"; container: "map" | "set"; op: "has" | "get" | "size"; target: HirExpr; targetType: BpType; key?: HirExpr }
  /** Template literal: FormatText. `type` "text" = the Format Text result; "string" = followed by Conv_TextToString (a string is expected, or no type is expected, e.g. a const). `format` already has `{`, `}` and backticks escaped. */
  | { k: "formatText"; format: string; args: Array<{ name: string; value: HirExpr }> }
  /** Object literal of a stub struct (`@bpKind struct`): MakeStruct. `struct` is the struct path. */
  | { k: "makeStruct"; struct: string; fields: Array<{ name: string; value: HirExpr }> }
) & { type: BpType | "void" | "null"; span: Span };

/** A field of a mod-defined struct (`Name!: T;`); `memberName` is the Blueprint member name `<Name>_<index>_<GUID>`. */
export interface HirStructField { name: string; type: BpType; memberName: string; span: Span }

/** A mod-defined struct (`@struct({ path })`, a UserDefinedStruct created by abfc). */
export interface HirStruct {
  name: string;
  /** Package path, e.g. "/Mod/Dir/S_X". */
  path: string;
  /** True when the path was derived from the file location (no `path:` option). */
  pathDerived: boolean;
  /** `<path>.<AssetName>`. */
  objectPath: string;
  fields: HirStructField[];
  span: Span;
}

export interface HirProgram {
  mod: string;
  classes: HirClass[];
  /** Mod-defined structs, ordered so that a struct comes after the structs its fields use. */
  structs: HirStruct[];
  classMeta: Record<string, string>;
  diagnostics: Diagnostic[];
}
