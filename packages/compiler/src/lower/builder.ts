// Per-unit IR builder: lowers the statements and expressions of one HIR event into nodes and wires.
import { pinObjectText, unitHash } from "@abfc/ir";
import type { IrNode, IrUnit, IrVariable, IrWire, Profile, SemanticTag, Span } from "@abfc/ir";
import { FUNCTION_RETURN_PIN } from "../hir.js";
import type { HirEvent, HirExpr, HirStmt, LocalId } from "../hir.js";
import { eventMetaOf } from "./eventmeta.js";
import { assignPositions } from "./layout.js";

/** `"<node>.<pin>"` */
type Exit = string;

interface LocalInfo {
  /** Value source pin. */
  pin?: string;
  /** Name of the temp variable holding the value (each use reads it again). */
  temp?: string;
  /** Exec exits taken when a cast (or optional chain) that produced this local failed. */
  pendingNull?: Exit[];
  execOuts?: Record<string, Exit[]>;
  /** Value is a literal (its default text). */
  lit?: string;
}

interface Value {
  pin: string;
  nulls: Exit[];
  execOuts?: Record<string, Exit[]>;
  pendingNull?: Exit[];
}

interface Operand {
  pin?: string;
  lit?: string;
  /** Class path for a class-typed pin (pin object default). */
  obj?: string;
  /** Owned event whose `OutputDelegate` feeds the pin (recorded as a cross wire). */
  delegate?: string;
  nulls: Exit[];
}

interface Extra {
  pinDefaults?: Record<string, string>;
  pinObjects?: Record<string, string>;
  pinTypes?: Record<string, string>;
}

/** A loop being lowered: where its `break` and `continue` exits go (macro loops wire `break` into the `Break` pin, counter loops collect the exits). */
interface LoopCtx {
  macro: boolean;
  breakPin?: string;
  breaks: Exit[];
  continues: Exit[];
}

const REAL_TYPES = new Set(["float", "double", "real"]);

const MATH_LIBRARY = "/Script/Engine.KismetMathLibrary";
/**
 * Struct literals of core math structs lower to their native make functions instead of a Make Struct node, which the
 * editor refuses on them ("is not a BlueprintType"). Fields left out of the literal get `fill` (default 0).
 */
const NATIVE_MAKE: Readonly<Record<string, { fn: string; pins: readonly string[]; fill?: string }>> = {
  "/Script/CoreUObject.Vector": { fn: "MakeVector", pins: ["X", "Y", "Z"] },
  "/Script/CoreUObject.Vector2D": { fn: "MakeVector2D", pins: ["X", "Y"] },
  "/Script/CoreUObject.Rotator": { fn: "MakeRotator", pins: ["Roll", "Pitch", "Yaw"] },
};
/**
 * Pin default text of a core math struct literal whose fields are all number literals, in the struct's text order:
 * a Vector pin reads "X,Y,Z" and a Rotator pin "Pitch,Yaw,Roll" (as the editor writes them). Such a literal fed straight
 * into a pin needs no make node; a missing field is 0.
 */
const LITERAL_STRUCT_ORDER: Readonly<Record<string, readonly string[]>> = {
  "/Script/CoreUObject.Vector": ["X", "Y", "Z"],
  "/Script/CoreUObject.Vector2D": ["X", "Y"],
  "/Script/CoreUObject.Rotator": ["Pitch", "Yaw", "Roll"],
};
export function structLiteralText(e: HirExpr): string | undefined {
  if (e.k !== "makeStruct") return undefined;
  const order = LITERAL_STRUCT_ORDER[e.struct];
  if (!order) return undefined;
  const vals: Record<string, number> = {};
  for (const f of e.fields) {
    if (f.value.k !== "lit" || typeof f.value.value !== "number" || !order.includes(f.name)) return undefined;
    vals[f.name] = f.value.value;
  }
  return order.map((n) => (vals[n] ?? 0).toFixed(6)).join(",");
}
const ARITH_NAMES = { "+": "Add", "-": "Subtract", "*": "Multiply", "/": "Divide" } as const;
const CMP_NAMES = { "<": "Less", "<=": "LessEqual", ">": "Greater", ">=": "GreaterEqual" } as const;
const K2_EVENT = "/Script/BlueprintGraph.K2Node_Event";
const K2_CREATE_WIDGET = "/Script/UMGEditor.K2Node_CreateWidget";
const K2_SPAWN_ACTOR = "/Script/BlueprintGraph.K2Node_SpawnActorFromClass";
/** Engine function libraries of native Map and Set operations (pin names verified against exports of the Mod Editor). */
const MAP_LIBRARY = "/Script/Engine.BlueprintMapLibrary";
const SET_LIBRARY = "/Script/Engine.BlueprintSetLibrary";
const K2_MACRO_INSTANCE = "/Script/BlueprintGraph.K2Node_MacroInstance";
/** Engine macro library of the standard loops (For Each Loop, For Loop). */
const STD_MACROS_ASSET = "/Engine/EditorBlueprintResources/StandardMacros.StandardMacros";
/** Pin names of the StandardMacros loop macros (their tunnel pins; ForEachLoop takes its exec input on `Exec`, ForLoop on `execute`, verified live). */
const FOR_EACH = { exec: "Exec", array: "Array", body: "LoopBody", element: "Array Element", index: "Array Index", completed: "Completed" } as const;
const FOR_LOOP = { exec: "execute", first: "FirstIndex", last: "LastIndex", body: "LoopBody", index: "Index", completed: "Completed" } as const;
/** The ...WithBreak variants: the same pins plus the `Break` exec input (verified live: ForLoopWithBreak takes its exec input on `Execute`, capital E). */
const FOR_EACH_BREAK = { ...FOR_EACH, brk: "Break" } as const;
const FOR_LOOP_BREAK = { ...FOR_LOOP, exec: "Execute", brk: "Break" } as const;
type StdLoop = "ForEachLoop" | "ForEachLoopWithBreak" | "ForLoop" | "ForLoopWithBreak";
const STD_LOOP_EXEC: Record<StdLoop, string> = {
  ForEachLoop: FOR_EACH.exec,
  ForEachLoopWithBreak: FOR_EACH_BREAK.exec,
  ForLoop: FOR_LOOP.exec,
  ForLoopWithBreak: FOR_LOOP_BREAK.exec,
};

/** Splits `map:<K>:<V>` into key and value type, `set:<T>` into the element type (as `key`). */
function containerTypes(type: string): { key: string; value?: string } {
  if (type.startsWith("set:")) return { key: type.slice(4) };
  const rest = type.slice(4);
  const sep = rest.indexOf(":");
  return { key: rest.slice(0, sep), value: rest.slice(sep + 1) };
}
/** Id of the entry node of every unit (the first node emitted, role "ev"). */
const ENTRY_ID = "ev0";

/**
 * Escapes TS-source string text for a quoted T3D default (`DefaultValue="..."`, `NSLOCTEXT("","k","...")`), the way the engine
 * exports it: backslash, double quote, CR, LF and tab. The backend writes pin defaults verbatim, so this is the one place it happens;
 * only defaults that come from TS string, name and text literals and FormatText templates go through it.
 */
export function escapeT3dString(s: string): string {
  return s.replace(/[\\"\r\n\t]/g, (c) => (c === "\r" ? "\\r" : c === "\n" ? "\\n" : c === "\t" ? "\\t" : "\\" + c));
}

/** Default text of a literal for a pin of the given type (undefined for null). */
export function formatLiteral(value: string | number | boolean | null, type: string): string | undefined {
  if (value === null) return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (REAL_TYPES.has(type)) return Number.isInteger(value) ? value.toFixed(1) : String(value);
    return String(value);
  }
  return escapeT3dString(value);
}

/** Whether control never leaves the statement list normally: it ends in a `return`, `break` or `continue`, or an `if` whose branches both do. */
function exits(list: HirStmt[]): boolean {
  return list.some((s) => s.k === "return" || s.k === "break" || s.k === "continue" || (s.k === "if" && exits(s.then) && exits(s.else)));
}

/** Number of `return <value>` statements anywhere in a body. */
function valueReturns(list: HirStmt[]): number {
  let n = 0;
  for (const s of list) {
    if (s.k === "return") n += s.value !== undefined || s.outs !== undefined ? 1 : 0;
    else if (s.k === "if") n += valueReturns(s.then) + valueReturns(s.else);
    else if (s.k === "forOf" || s.k === "forCount") n += valueReturns(s.body);
  }
  return n;
}

const idOf = (pin: string): string => pin.slice(0, pin.indexOf("."));
const wire = (a: string, b: string): IrWire => [a as `${string}.${string}`, b as `${string}.${string}`];
const shortName = (path: string): string => path.slice(path.lastIndexOf(".") + 1);

export class UnitBuilder {
  readonly vars: IrVariable[] = [];
  /** Lower eligible loops to StandardMacros instances (ForEachLoop, ForLoop) instead of counter loops. */
  loopMacros = true;
  /** Enclosing loops of the statement being lowered, innermost last: where break and continue go. */
  private readonly loops: LoopCtx[] = [];
  private readonly nodes: IrNode[] = [];
  private readonly wires: IrWire[] = [];
  private cur: Exit[] = [];
  private readonly locals = new Map<LocalId, LocalInfo>();
  private readonly roleCount = new Map<string, number>();
  private readonly getMemo = new Map<string, string>();
  private readonly brkMemo = new Map<string, string>();
  private readonly holes: string[] = [];
  /** Cast guards consumed by the condition being lowered (see the `if` statement). */
  private readonly guards: Array<{ info: LocalInfo; nulls: Exit[] }> = [];
  private params = new Map<string, string>();
  private entryId = "";
  private tempCount = 0;
  /** Consts bound to a live pure value that reads state (not stored in a temp): a const built from them reads state too. */
  private unstable = new Set<LocalId>();
  private loopCount = 0;
  /** Functions: the only value `return` is the last top-level statement, so its value can feed the result node directly. */
  private directReturn = false;
  /** Functions: the return temp `abfc_<name>_r` exists and is read by the result node. */
  private returnTemps = new Set<string>();
  private readonly cross: NonNullable<IrUnit["crossWires"]> = [];

  constructor(
    private readonly profile: Profile,
    private readonly classMeta: Record<string, string>,
    private readonly event: HirEvent,
  ) {}

  build(): IrUnit {
    const P = this.profile.pins;
    const ev = this.event;
    if (ev.kind === "function") {
      // no entry node is emitted: the backend's function entry and result nodes are addressed by the reserved ids `entry` and `result`
      this.entryId = "entry";
      const last = ev.body[ev.body.length - 1];
      this.directReturn = valueReturns(ev.body) === 1 && last !== undefined && last.k === "return" && (last.value !== undefined || last.outs !== undefined);
    } else if (ev.kind === "override") {
      if (ev.overrideOf === undefined) throw new Error(`ABFC2060: override ${ev.name} has no declaring class`);
      const sem: SemanticTag = { k: "override", class: ev.overrideOf, function: ev.name };
      const ref = `EventReference=(MemberParent="${pinObjectText("class", ev.overrideOf, this.classMeta)}",MemberName="${ev.name}")`;
      this.entryId = this.emit("ev", K2_EVENT, [ref, "bOverrideFunction=True"], sem, ev.span);
    } else {
      const evSem: Extract<SemanticTag, { k: "event" }> = { k: "event", name: ev.name };
      if (ev.params.length > 0) evSem.params = ev.params.map((p) => ({ name: p.name, type: p.type }));
      const meta = ev.doc === undefined ? undefined : eventMetaOf(ev.doc);
      if (meta !== undefined) evSem.meta = meta;
      this.entryId = this.emit("ev", this.profile.nodeClasses.customEvent, [`CustomFunctionName="${ev.name}"`], evSem, ev.span);
    }
    for (const p of ev.params) this.params.set(p.name, `${this.entryId}.${p.name}`);
    this.cur = [`${this.entryId}.${P.then}`];
    this.stmts(ev.body);
    const unit: IrUnit = {
      id: `${ev.kind}:${ev.name}`,
      kind: ev.kind,
      name: ev.name,
      graph: ev.kind === "function" ? ev.name : "EventGraph",
      signature: {
        inputs: ev.params.map((p) => ({ name: p.name, type: p.type })),
        outputs: ev.kind !== "function" ? [] : ev.outputs !== undefined ? ev.outputs.map((o) => ({ name: o.name, type: o.type })) : ev.returnType !== undefined ? [{ name: FUNCTION_RETURN_PIN, type: ev.returnType }] : [],
        ...(ev.kind === "function" ? { access: ev.access ?? "public" } : {}),
        ...(ev.kind === "function" && ev.overrideOf !== undefined ? { override: ev.overrideOf } : {}),
      },
      locals: [],
      nodes: this.nodes,
      wires: this.wires,
      origin: ev.span,
      hash: "",
    };
    if (this.cross.length > 0) unit.crossWires = this.cross;
    assignPositions(unit, P.execute);
    unit.hash = unitHash(unit);
    return unit;
  }

  // ---- emission helpers ----

  private emit(role: string, cls: string, props: string[], sem: SemanticTag | undefined, origin: Span, extra?: Extra): string {
    const n = this.roleCount.get(role) ?? 0;
    this.roleCount.set(role, n + 1);
    const node: IrNode = { id: `${role}${n}`, t3d: { class: cls, props }, pos: [0, 0], origin };
    if (sem) node.sem = sem;
    if (extra?.pinDefaults && Object.keys(extra.pinDefaults).length > 0) node.pinDefaults = extra.pinDefaults;
    if (extra?.pinObjects && Object.keys(extra.pinObjects).length > 0) node.pinObjects = extra.pinObjects;
    if (extra?.pinTypes && Object.keys(extra.pinTypes).length > 0) node.pinTypes = extra.pinTypes;
    this.nodes.push(node);
    return node.id;
  }

  private link(from: string, to: string): void {
    this.wires.push(wire(from, to));
  }

  private execInto(id: string): void {
    const P = this.profile.pins;
    for (const x of this.cur) this.link(x, `${id}.${P.execute}`);
    this.cur = [`${id}.${P.then}`];
  }

  private funcRef(owner: string | null, name: string): string {
    return owner === null
      ? `FunctionReference=(MemberName="${name}",bSelfContext=True)`
      : `FunctionReference=(MemberParent="${pinObjectText("class", owner, this.classMeta)}",MemberName="${name}")`;
  }

  private varRef(name: string, owner?: string): string {
    return owner === undefined
      ? `VariableReference=(MemberName="${name}",bSelfContext=True)`
      : `VariableReference=(MemberParent="${pinObjectText("class", owner, this.classMeta)}",MemberName="${name}")`;
  }

  private getVar(name: string, origin: Span): string {
    const id = this.emit("get", this.profile.nodeClasses.variableGet, [this.varRef(name)], { k: "get", name }, origin);
    return `${id}.${name}`;
  }

  private setVar(name: string, origin: Span, extra?: Extra): string {
    return this.emit("set", this.profile.nodeClasses.variableSet, [this.varRef(name)], { k: "set", name }, origin, extra);
  }

  private pureCall(owner: string, name: string, origin: Span, extra?: Extra): string {
    return this.emit(
      "call",
      this.profile.nodeClasses.callFunction,
      ["bIsPureFunc=True", this.funcRef(owner, name)],
      { k: "call", class: owner, function: name },
      origin,
      extra,
    );
  }

  private isValidCall(objectPin: string, origin: Span): string {
    const f = this.profile.functions.isValid;
    const id = this.pureCall(f.class, f.name, origin);
    this.link(objectPin, `${id}.${this.profile.pins.isValidObject}`);
    return `${id}.${this.profile.pins.returnValue}`;
  }

  private branch(condPin: string | undefined, condLit: string | undefined, origin: Span): string {
    const id = this.emit("br", this.profile.nodeClasses.branch, [], { k: "branch" }, origin,
      condLit !== undefined ? { pinDefaults: { [this.profile.pins.condition]: condLit } } : undefined);
    this.execInto(id);
    if (condPin !== undefined) this.link(condPin, `${id}.${this.profile.pins.condition}`);
    return id;
  }

  private local(id: LocalId): LocalInfo {
    const l = this.locals.get(id);
    if (!l) throw new Error(`lowering: unknown local #${id}`);
    return l;
  }

  private unsupported(what: string, span: Span): never {
    throw new Error(`ABFC2099: ${span.file}:${span.line}:${span.col}: ${what} is not supported in lowering`);
  }

  // ---- expressions ----

  private operand(e: HirExpr, asType?: string): Operand {
    if (e.k === "lit") {
      const lit = formatLiteral(e.value, asType ?? e.type);
      if (lit === undefined) return this.unsupported("a null literal here", e.span);
      return { lit, nulls: [] };
    }
    if (e.k === "local") {
      const l = this.local(e.id);
      if (l.lit !== undefined) return { lit: l.lit, nulls: [] };
    }
    if (e.k === "enumLit") return { lit: e.text, nulls: [] };
    if (e.k === "nameLit") return { lit: escapeT3dString(e.text), nulls: [] };
    const structLit = structLiteralText(e);
    if (structLit !== undefined) return { lit: structLit, nulls: [] };
    if (e.k === "classRef") return { obj: e.path, nulls: [] };
    if (e.k === "assetRef") return { obj: e.text, nulls: [] };
    if (e.k === "delegateRef") return { delegate: e.event, nulls: [] };
    const v = this.value(e);
    return { pin: v.pin, nulls: v.nulls };
  }

  /** Wires an operand into `<id>.<pin>` (pin, default, class object or delegate cross wire). */
  private feed(o: Operand, id: string, pin: string, defaults: Record<string, string>, objects?: Record<string, string>): void {
    if (o.pin !== undefined) this.link(o.pin, `${id}.${pin}`);
    else if (o.lit !== undefined) defaults[pin] = o.lit;
    else if (o.obj !== undefined) {
      if (!objects) throw new Error(`ABFC2099: a class or asset reference cannot feed ${pin} here; pass it to a call or assign it to a variable`);
      objects[pin] = o.obj;
    }
    else if (o.delegate !== undefined) this.cross.push({ toUnit: `event:${o.delegate}`, from: `${ENTRY_ID}.OutputDelegate`, to: `${id}.${pin}` });
  }

  /** Stores the collected pin defaults and pin objects on a node. */
  private settle(id: string, defaults: Record<string, string>, objects?: Record<string, string>): void {
    const n = this.nodes.find((x) => x.id === id)!;
    if (Object.keys(defaults).length > 0) n.pinDefaults = { ...n.pinDefaults, ...defaults };
    if (objects && Object.keys(objects).length > 0) n.pinObjects = { ...n.pinObjects, ...objects };
  }

  private mathFn(op: string, kind: "int" | "real"): { class: string; name: string } {
    return { class: this.profile.functions.addInt.class, name: `${op}_${kind === "int" ? "IntInt" : "DoubleDouble"}` };
  }

  private arrayFn(name: string): string {
    return this.funcRef(this.profile.functions.arrayLength.class, name);
  }

  /** Operand of an optional argument: undefined for a `null` literal. */
  private optOperand(e: HirExpr, asType?: string): Operand | undefined {
    return e.k === "lit" && e.value === null ? undefined : this.operand(e, asType);
  }

  private value(e: HirExpr): Value {
    const P = this.profile.pins;
    switch (e.k) {
      case "self": {
        const id = this.emit("self", "/Script/BlueprintGraph.K2Node_Self", [], { k: "self" }, e.span);
        return { pin: `${id}.${P.self}`, nulls: [] };
      }
      case "param": {
        const pin = this.params.get(e.name);
        if (pin === undefined) return this.unsupported(`parameter ${e.name}`, e.span);
        return { pin, nulls: [] };
      }
      case "local": {
        const l = this.local(e.id);
        if (l.temp !== undefined) return { pin: this.getVar(l.temp, e.span), nulls: [] };
        if (l.pin === undefined) return this.unsupported("a local without a value", e.span);
        return { pin: l.pin, nulls: [] };
      }
      case "lit":
        return this.unsupported("a literal in this position", e.span);
      case "getSelf":
        if (e.owner !== undefined) {
          // Target = a Self node: Unreal's compile refuses the other-context get with its Target unwired ("invalid target")
          const id = this.emit("get", this.profile.nodeClasses.variableGet, [this.varRef(e.name, e.owner)], { k: "get", name: e.name, class: e.owner }, e.span);
          const me = this.emit("self", "/Script/BlueprintGraph.K2Node_Self", [], { k: "self" }, e.span);
          this.link(`${me}.${this.profile.pins.self}`, `${id}.${this.profile.pins.self}`);
          return { pin: `${id}.${e.name}`, nulls: [] };
        }
        return { pin: this.getVar(e.name, e.span), nulls: [] };
      case "getOn": {
        const src = this.value(e.obj);
        const key = `${src.pin}|${e.owner}|${e.name}`;
        let id = this.getMemo.get(key);
        if (id === undefined) {
          id = this.emit("get", this.profile.nodeClasses.variableGet, [this.varRef(e.name, e.owner)],
            { k: "get", name: e.name, class: e.owner }, e.span);
          this.getMemo.set(key, id);
          this.link(src.pin, `${id}.${P.self}`);
        }
        return { pin: `${id}.${e.name}`, nulls: src.nulls };
      }
      case "field": {
        const src = this.value(e.obj);
        let id = this.brkMemo.get(src.pin);
        if (id === undefined) {
          id = this.emit("brk", this.profile.nodeClasses.breakStruct,
            ["bMadeAfterOverridePinRemoval=True", `StructType="${pinObjectText("struct", e.struct, this.classMeta)}"`], undefined, e.span);
          this.brkMemo.set(src.pin, id);
          this.link(src.pin, `${id}.${shortName(e.struct)}`);
        }
        return { pin: `${id}.${e.name}`, nulls: src.nulls };
      }
      case "out": {
        const v = this.value(e.call);
        return { pin: `${idOf(v.pin)}.${e.pin}`, nulls: v.nulls };
      }
      case "call":
        return this.call(e);
      case "cast": {
        const v = this.value(e.value);
        const id = this.emit("cast", this.profile.nodeClasses.dynamicCast,
          [`TargetType="${pinObjectText("class", e.target, this.classMeta)}"`], { k: "cast", target: e.target }, e.span,
          { pinTypes: { [P.castObject]: this.profile.castObjectPinType } });
        this.execInto(id);
        this.link(v.pin, `${id}.${P.castObject}`);
        return { pin: `${id}.${e.castPin}`, nulls: [], pendingNull: [...v.nulls, `${id}.${P.castFailed}`] };
      }
      case "optional": {
        const v = this.value(e.value);
        const nulls = [...v.nulls];
        const info = e.value.k === "local" ? this.local(e.value.id) : undefined;
        if (info?.pendingNull !== undefined) {
          nulls.push(...info.pendingNull);
          // the null exits rejoin the main path through `nulls`, so a later use must check validity again
          delete info.pendingNull;
        } else {
          const valid = this.isValidCall(v.pin, e.span);
          const br = this.branch(valid, undefined, e.span);
          this.cur = [`${br}.${P.then}`];
          nulls.push(`${br}.${P.else}`);
        }
        this.holes.push(v.pin);
        const t = this.value(e.then);
        this.holes.pop();
        return { pin: t.pin, nulls: [...nulls, ...t.nulls] };
      }
      case "hole": {
        const pin = this.holes[this.holes.length - 1];
        if (pin === undefined) return this.unsupported("a stray optional-chain hole", e.span);
        return { pin, nulls: [] };
      }
      case "isValid": {
        const v = this.value(e.value);
        return { pin: this.isValidCall(v.pin, e.span), nulls: v.nulls };
      }
      case "eq": {
        const kindType = e.kind === "real" ? "real" : e.kind;
        let a = this.operand(e.a, kindType);
        let b = this.operand(e.b, kindType);
        if (a.lit !== undefined && b.lit === undefined) [a, b] = [b, a];
        const fn = this.profile.functions[e.negate ? "notEqual" : "equal"][e.kind];
        const defaults: Record<string, string> = {};
        const id = this.pureCall(fn.class, fn.name, e.span);
        this.feed(a, id, P.opA, defaults);
        this.feed(b, id, P.opB, defaults);
        if (Object.keys(defaults).length > 0) this.nodes.find((n) => n.id === id)!.pinDefaults = defaults;
        return { pin: `${id}.${P.returnValue}`, nulls: [...a.nulls, ...b.nulls] };
      }
      case "length": {
        const arr = this.value(e.array);
        const f = this.profile.functions.arrayLength;
        const id = this.emit("arr", this.profile.nodeClasses.callArrayFunction,
          ["bIsPureFunc=True", this.funcRef(f.class, f.name)], undefined, e.span,
          { pinTypes: { [P.arrayLengthArray]: e.arrayType } });
        this.link(arr.pin, `${id}.${P.arrayLengthArray}`);
        return { pin: `${id}.${P.returnValue}`, nulls: arr.nulls };
      }
      case "callOwn":
        return this.callOwn(e);
      case "createWidget": {
        const owner = this.optOperand(e.owner);
        const defaults: Record<string, string> = {};
        const id = this.emit("widget", K2_CREATE_WIDGET, [], { k: "create_widget" }, e.span, { pinObjects: { Class: e.cls } });
        this.execInto(id);
        if (owner) this.feed(owner, id, "OwningPlayer", defaults);
        this.settle(id, defaults);
        return { pin: `${id}.${P.returnValue}`, nulls: owner?.nulls ?? [] };
      }
      case "spawn": {
        const owner = e.owner ? this.optOperand(e.owner) : undefined;
        const where = e.transform ? this.operand(e.transform) : undefined;
        const mk = where
          ? undefined
          : this.pureCall(this.profile.functions.addInt.class, "MakeTransform", e.span, {
              pinDefaults: { Location: "0, 0, 0", Rotation: "0, 0, 0", Scale: "1.000000,1.000000,1.000000" },
            });
        const defaults: Record<string, string> = {};
        if (e.collision !== undefined) defaults.CollisionHandlingOverride = e.collision;
        if (e.scale !== undefined) defaults.TransformScaleMethod = e.scale;
        const id = this.emit("spawn", K2_SPAWN_ACTOR, [], { k: "spawn" }, e.span, { pinObjects: { Class: e.cls } });
        this.execInto(id);
        if (where) this.feed(where, id, "SpawnTransform", defaults);
        else this.link(`${mk}.${P.returnValue}`, `${id}.SpawnTransform`);
        if (owner) this.feed(owner, id, "Owner", defaults);
        this.settle(id, defaults);
        return { pin: `${id}.${P.returnValue}`, nulls: [...(owner?.nulls ?? []), ...(where?.nulls ?? [])] };
      }
      case "arith":
      case "cmp": {
        const t = e.kind === "int" ? "int" : "real";
        const a = this.operand(e.a, t);
        const b = this.operand(e.b, t);
        const op = e.k === "arith" ? ARITH_NAMES[e.op] : CMP_NAMES[e.op];
        const fn = this.mathFn(op, e.kind);
        const defaults: Record<string, string> = {};
        const id = this.pureCall(fn.class, fn.name, e.span);
        this.feed(a, id, P.opA, defaults);
        this.feed(b, id, P.opB, defaults);
        this.settle(id, defaults);
        return { pin: `${id}.${P.returnValue}`, nulls: [...a.nulls, ...b.nulls] };
      }
      case "index": {
        const arr = this.value(e.array);
        const idx = this.operand(e.index, "int");
        const defaults: Record<string, string> = {};
        const id = this.emit("item", this.profile.nodeClasses.getArrayItem, ["bReturnByRefDesired=False"], undefined, e.span,
          { pinTypes: { [P.getItemArray]: e.array.type, [P.getItemOutput]: e.elem } });
        this.link(arr.pin, `${id}.${P.getItemArray}`);
        this.feed(idx, id, P.getItemIndex, defaults);
        this.settle(id, defaults);
        return { pin: `${id}.${P.getItemOutput}`, nulls: [...arr.nulls, ...idx.nulls] };
      }
      case "arrayFind": {
        const arr = this.value(e.array);
        const item = this.operand(e.value, e.elem);
        const defaults: Record<string, string> = {};
        const id = this.emit("arr", this.profile.nodeClasses.callArrayFunction, ["bIsPureFunc=True", this.arrayFn("Array_Find")], undefined, e.span,
          { pinTypes: { [P.arrayLengthArray]: e.array.type, ItemToFind: e.elem } });
        this.link(arr.pin, `${id}.${P.arrayLengthArray}`);
        this.feed(item, id, "ItemToFind", defaults);
        this.settle(id, defaults);
        return { pin: `${id}.${P.returnValue}`, nulls: [...arr.nulls, ...item.nulls] };
      }
      case "containerQuery": {
        const map = e.container === "map";
        const ty = containerTypes(e.targetType);
        const targetPin = map ? "TargetMap" : "TargetSet";
        const keyPin = map ? "Key" : "ItemToFind";
        const fn = e.op === "size" ? (map ? "Map_Length" : "Set_Length") : e.op === "has" ? (map ? "Map_Contains" : "Set_Contains") : "Map_Find";
        const target = this.value(e.target);
        const key = e.key ? this.operand(e.key, ty.key) : undefined;
        const pinTypes: Record<string, string> = { [targetPin]: e.targetType };
        if (key) pinTypes[keyPin] = ty.key;
        if (e.op === "get" && ty.value !== undefined) pinTypes.Value = ty.value;
        const defaults: Record<string, string> = {};
        const id = this.pureCall(map ? MAP_LIBRARY : SET_LIBRARY, fn, e.span, { pinTypes });
        this.link(target.pin, `${id}.${targetPin}`);
        if (key) this.feed(key, id, keyPin, defaults);
        this.settle(id, defaults);
        return { pin: `${id}.${e.op === "get" ? "Value" : P.returnValue}`, nulls: [...target.nulls, ...(key?.nulls ?? [])] };
      }
      case "formatText": {
        // Real exports: PinNames(i)="<arg>" on the node, Format pin DefaultValue = the format text, output pin "Result", arg pins named like the args.
        const nulls: Exit[] = [];
        const ops = e.args.map((a) => ({ a, o: this.operand(a.value, a.value.type === "void" || a.value.type === "null" ? undefined : a.value.type) }));
        for (const x of ops) nulls.push(...x.o.nulls);
        const pinTypes: Record<string, string> = {};
        for (const x of ops) if (x.a.value.type !== "void" && x.a.value.type !== "null") pinTypes[x.a.name] = x.a.value.type;
        const id = this.emit("fmt", this.profile.nodeClasses.formatText, e.args.map((a, i) => `PinNames(${i})="${a.name}"`), undefined, e.span,
          { pinDefaults: { Format: escapeT3dString(e.format) }, pinTypes });
        const defaults: Record<string, string> = {};
        for (const x of ops) this.feed(x.o, id, x.a.name, defaults);
        this.settle(id, defaults);
        if (e.type === "string") {
          // `string` expected: Format Text -> Conv_TextToString (its input pin is InText).
          const fn = this.profile.functions.textToString;
          const conv = this.pureCall(fn.class, fn.name, e.span);
          this.link(`${id}.Result`, `${conv}.InText`);
          return { pin: `${conv}.${P.returnValue}`, nulls };
        }
        return { pin: `${id}.Result`, nulls };
      }
      case "makeStruct": {
        const nulls: Exit[] = [];
        const ops = e.fields.map((a) => ({ a, o: this.operand(a.value, a.value.type === "void" || a.value.type === "null" ? undefined : a.value.type) }));
        for (const x of ops) nulls.push(...x.o.nulls);
        const native = NATIVE_MAKE[e.struct];
        if (native) {
          // core math structs are not BlueprintType: the editor refuses a Make Struct node on them, so use their native make
          const id = this.pureCall(MATH_LIBRARY, native.fn, e.span);
          const defaults: Record<string, string> = {};
          for (const pin of native.pins) defaults[pin] = native.fill ?? "0.0";
          for (const x of ops) {
            if (!native.pins.includes(x.a.name)) this.unsupported(`field ${x.a.name} of ${shortName(e.struct)}`, e.span);
            delete defaults[x.a.name];
            this.feed(x.o, id, x.a.name, defaults);
          }
          this.settle(id, defaults);
          return { pin: `${id}.${P.returnValue}`, nulls };
        }
        const id = this.emit("mk", this.profile.nodeClasses.makeStruct,
          ["bMadeAfterOverridePinRemoval=True", `StructType="${pinObjectText("struct", e.struct, this.classMeta)}"`], undefined, e.span);
        const defaults: Record<string, string> = {};
        for (const x of ops) this.feed(x.o, id, x.a.name, defaults);
        this.settle(id, defaults);
        return { pin: `${id}.${shortName(e.struct)}`, nulls };
      }
      case "not":
      case "and":
      case "or":
      case "execIs":
      case "classRef":
      case "assetRef":
      case "delegateRef":
      case "enumLit":
      case "nameLit":
        return this.unsupported(`'${e.k}' as a value`, e.span);
    }
  }

  private call(e: Extract<HirExpr, { k: "call" }>): Value {
    const P = this.profile.pins;
    const nulls: Exit[] = [];
    const target = e.target ? this.value(e.target) : null;
    if (target) nulls.push(...target.nulls);
    const defaults: Record<string, string> = {};
    const objects: Record<string, string> = {};
    const fed: Array<{ pin: string; o: Operand }> = [];
    for (const a of e.args) {
      if (a.value.k === "lit" && a.value.value === null) continue;
      const o = this.operand(a.value);
      nulls.push(...o.nulls);
      fed.push({ pin: a.pin, o });
    }
    const props = e.pure ? ["bIsPureFunc=True"] : [];
    props.push(this.funcRef(e.owner, e.name));
    const sem: SemanticTag = e.owner === null
      ? { k: "call", function: e.name }
      : { k: "call", class: e.owner, function: e.name };
    const nodeClass = e.parentCall ? "/Script/BlueprintGraph.K2Node_CallParentFunction" : this.profile.nodeClasses.callFunction;
    // a parent call is a raw node (bp_apply has no kind for it): no semantic tag
    const id = this.emit("call", nodeClass, props, e.parentCall ? undefined : sem, e.span);
    if (!e.pure) this.execInto(id);
    if (target) this.link(target.pin, `${id}.${P.self}`);
    for (const f of fed) this.feed(f.o, id, f.pin, defaults, objects);
    this.settle(id, defaults, objects);
    const result: Value = { pin: `${id}.${P.returnValue}`, nulls };
    if (e.execOutputs) {
      this.cur = [];
      result.execOuts = Object.fromEntries(e.execOutputs.map((p) => [p, [`${id}.${p}`]]));
    }
    return result;
  }

  /** Call of an owned event/override of the same class (`this.Step(dt)`). */
  private callOwn(e: Extract<HirExpr, { k: "callOwn" }>): Value {
    const P = this.profile.pins;
    const nulls: Exit[] = [];
    const fed: Array<{ pin: string; o: Operand }> = [];
    for (const a of e.args) {
      const o = this.optOperand(a.value);
      if (!o) continue;
      nulls.push(...o.nulls);
      fed.push({ pin: a.pin, o });
    }
    const id = this.emit("call", this.profile.nodeClasses.callFunction, [this.funcRef(null, e.name)], { k: "call", function: e.name }, e.span);
    this.execInto(id);
    const defaults: Record<string, string> = {};
    const objects: Record<string, string> = {};
    for (const f of fed) this.feed(f.o, id, f.pin, defaults, objects);
    this.settle(id, defaults, objects);
    return { pin: `${id}.${P.returnValue}`, nulls };
  }

  // ---- conditions ----

  /** `negated`: under a `!` (or inside the operand of one), where `isValid(castResult)` keeps its old shape (see the isValid case). */
  private cond(e: HirExpr, from: Exit[], negated = false): { t: Exit[]; f: Exit[] } {
    const P = this.profile.pins;
    this.cur = from;
    switch (e.k) {
      case "and": {
        const a = this.cond(e.a, from, negated);
        const b = this.cond(e.b, a.t, negated);
        return { t: b.t, f: [...a.f, ...b.f] };
      }
      case "or": {
        const a = this.cond(e.a, from, negated);
        const b = this.cond(e.b, a.f, negated);
        return { t: [...a.t, ...b.t], f: b.f };
      }
      case "not": {
        const r = this.cond(e.e, from, !negated);
        return { t: r.f, f: r.t };
      }
      case "local": {
        const l = this.local(e.id);
        if (l.pendingNull !== undefined) {
          const f = l.pendingNull;
          // stays an (empty) guard for now: `if` drops it again when the null path can rejoin
          l.pendingNull = [];
          this.guards.push({ info: l, nulls: f });
          return { t: from, f };
        }
        break;
      }
      case "execIs": {
        const outs = this.local(e.local).execOuts ?? {};
        const t = outs[e.pin] ?? [];
        const f = Object.entries(outs).filter(([k]) => k !== e.pin).flatMap(([, v]) => v);
        return e.negate ? { t: f, f: t } : { t, f };
      }
      case "isValid": {
        // `isValid(x)` on a cast result right after the cast: the failed cast is the false side (as for `if (x)`), so the else path
        // runs when the cast fails. Without this the Cast Failed pin stayed unwired and a failed cast silently ended the unit.
        // `!isValid(x)` keeps its old graph (a failed cast still ends the unit): in the usual `if (!isValid(x)) return;` that is the
        // same behaviour, and published Blueprints built from it must not change; the frontend warns (ABFC2089) when it is not.
        if (e.value.k === "local" && !negated) {
          const l = this.local(e.value.id);
          if (l.pendingNull !== undefined) return this.cond(e.value, from);
        }
        const v = this.value(e.value);
        const br = this.branch(this.isValidCall(v.pin, e.span), undefined, e.span);
        return { t: [`${br}.${P.then}`], f: [...v.nulls, `${br}.${P.else}`] };
      }
      default:
        break;
    }
    const o = this.operand(e);
    let condPin = o.pin;
    if (condPin !== undefined && e.type.startsWith("object:")) condPin = this.isValidCall(condPin, e.span);
    const br = this.branch(condPin, condPin === undefined ? o.lit : undefined, e.span);
    return { t: [`${br}.${P.then}`], f: [...o.nulls, `${br}.${P.else}`] };
  }

  // ---- statements ----

  private stmts(list: HirStmt[]): void {
    for (const s of list) this.stmt(s);
  }

  private stmt(s: HirStmt): void {
    const P = this.profile.pins;
    switch (s.k) {
      case "expr": {
        const v = this.value(s.e);
        if (v.nulls.length > 0) this.cur = [...this.cur, ...v.nulls];
        return;
      }
      case "bind": {
        // what a hand-made "Bind Event to <Dispatcher>" is: Add Delegate (Target = source) fed by Create Event (Target = target)
        const src = this.value(s.source);
        const tgt = s.target === null ? null : this.value(s.target);
        let cd: string | null = null;
        if (tgt !== null) {
          cd = this.emit("cdlg", "/Script/BlueprintGraph.K2Node_CreateDelegate", [`SelectedFunctionName="${s.fn}"`], undefined, s.span);
          this.link(tgt.pin, `${cd}.${P.self}`);
        }
        const ad = this.emit("adlg", "/Script/BlueprintGraph.K2Node_AddDelegate",
          [`DelegateReference=(MemberParent="${pinObjectText("object", s.sourceClass, this.classMeta)}",MemberName="${s.dispatcher}")`], undefined, s.span);
        this.execInto(ad);
        this.link(src.pin, `${ad}.${P.self}`);
        if (cd !== null) this.link(`${cd}.OutputDelegate`, `${ad}.Delegate`);
        else this.cross.push({ toUnit: `event:${s.fn}`, from: `${ENTRY_ID}.OutputDelegate`, to: `${ad}.Delegate` });
        const nulls = [...src.nulls, ...(tgt?.nulls ?? [])];
        if (nulls.length > 0) this.cur = [...this.cur, ...nulls];
        return;
      }
      case "setOn": {
        const target = this.value(s.obj);
        const defaults: Record<string, string> = {};
        const o = s.value.k === "lit" && s.value.value === null ? null : this.operand(s.value, s.type);
        const id = this.emit("set", this.profile.nodeClasses.variableSet, [this.varRef(s.name, s.owner)], { k: "set", name: s.name, class: s.owner }, s.span);
        this.execInto(id);
        this.link(target.pin, `${id}.${P.self}`);
        const objects: Record<string, string> = {};
        if (o) this.feed(o, id, s.name, defaults, objects);
        this.settle(id, defaults, objects);
        const nulls = [...target.nulls, ...(o?.nulls ?? [])];
        if (nulls.length > 0) this.cur = [...this.cur, ...nulls];
        return;
      }
      case "setSelf": {
        const defaults: Record<string, string> = {};
        let o: Operand | null = null;
        if (!(s.value.k === "lit" && s.value.value === null)) o = this.operand(s.value, s.type);
        const id = this.setVar(s.name, s.span);
        this.execInto(id);
        const objects: Record<string, string> = {};
        if (o) this.feed(o, id, s.name, defaults, objects);
        this.settle(id, defaults, objects);
        if (o && o.nulls.length > 0) this.cur = [...this.cur, ...o.nulls];
        return;
      }
      case "const": {
        const init = s.init;
        if (init.k === "lit") {
          const lit = formatLiteral(init.value, init.type);
          this.locals.set(s.local, lit === undefined ? {} : { lit });
          return;
        }
        const v = this.value(init);
        // a pure node is evaluated again at every consumer: a value that reads state (an own variable, an array length, a member
        // getter) would see later writes, so it is stored where the const stands; so is a pure call used twice (it may be random)
        const reads = readsState(init, this.unstable);
        const snapshot = (init.k === "call" && init.pure && s.uses >= 2) || (reads && !s.nextOnly);
        if (snapshot && v.nulls.length === 0 && !v.execOuts && !v.pendingNull && init.type !== "result") {
          const name = `abfc_${this.event.name}_t${this.tempCount++}`;
          this.vars.push({ name, type: init.type === "void" || init.type === "null" ? "name" : init.type, flags: ["transient"], origin: s.span, temp: true });
          const set = this.setVar(name, s.span);
          this.execInto(set);
          this.link(v.pin, `${set}.${name}`);
          this.locals.set(s.local, { temp: name });
          return;
        }
        if (reads) this.unstable.add(s.local); // read right away by the next statement: still a live pure value there
        if (v.nulls.length > 0) this.unsupported("an optional chain bound to a constant", s.span);
        const info: LocalInfo = { pin: v.pin };
        if (v.execOuts) info.execOuts = v.execOuts;
        if (v.pendingNull) info.pendingNull = v.pendingNull;
        this.locals.set(s.local, info);
        return;
      }
      case "if": {
        const mark = this.guards.length;
        const c = this.cond(s.cond, this.cur);
        const consumed = this.guards.splice(mark);
        // a branch entered from a failed cast may mix in other exits where the local is still nullable: `?.` must check validity there
        const enter = (side: Exit[], body: HirStmt[]): void => {
          const hit = consumed.filter((g) => g.nulls.some((x) => side.includes(x)));
          const saved = hit.map((g) => g.info.pendingNull);
          for (const g of hit) delete g.info.pendingNull;
          this.stmts(body);
          hit.forEach((g, i) => {
            if (saved[i] !== undefined) g.info.pendingNull = saved[i];
          });
        };
        this.cur = c.t;
        enter(c.t, s.then);
        const endThen = this.cur;
        this.cur = c.f;
        enter(c.f, s.else);
        this.cur = [...endThen, ...this.cur];
        // a cast local stays known-valid after the `if` only when every branch the failed cast went into ends in an exit
        for (const g of consumed) {
          const rejoins = (side: Exit[], body: HirStmt[]): boolean => g.nulls.some((x) => side.includes(x)) && !exits(body);
          if (rejoins(c.t, s.then) || rejoins(c.f, s.else)) delete g.info.pendingNull;
        }
        return;
      }
      case "return": {
        if (s.value === undefined && s.outs === undefined) {
          this.cur = [];
          return;
        }
        const outs =
          s.outs !== undefined
            ? s.outs.map((x) => ({ pin: x.pin, value: x.value, type: this.event.outputs!.find((y) => y.name === x.pin)!.type }))
            : [{ pin: FUNCTION_RETURN_PIN, value: s.value!, type: this.event.returnType! }];
        for (const out of outs) {
          const o = this.operand(out.value, out.type);
          if (o.nulls.length > 0) this.unsupported("an optional chain (?.) in a return value; check isValid first", s.span);
          if (this.directReturn && o.pin !== undefined) {
            this.link(o.pin, `result.${out.pin}`);
            continue;
          }
          // a value that is not a pin, or several returns: a temp per out pin, set before each return, read once into the result
          const temp = out.pin === FUNCTION_RETURN_PIN ? `abfc_${this.event.name}_r` : `abfc_${this.event.name}_${out.pin}`;
          const first = !this.returnTemps.has(out.pin);
          if (first) this.vars.push({ name: temp, type: out.type, flags: ["transient"], origin: s.span, temp: true });
          const defaults: Record<string, string> = {};
          const objects: Record<string, string> = {};
          const set = this.setVar(temp, s.span);
          this.execInto(set);
          this.feed(o, set, temp, defaults, objects);
          this.settle(set, defaults, objects);
          if (first) {
            this.returnTemps.add(out.pin);
            this.link(this.getVar(temp, s.span), `result.${out.pin}`);
          }
        }
        for (const x of this.cur) this.link(x, `result.${P.execute}`);
        this.cur = [];
        return;
      }
      case "setSelfCond":
        // c ? a : b assigned to a variable is an if/else with one set per side
        this.stmt({
          k: "if",
          cond: s.cond,
          then: [{ k: "setSelf", name: s.name, type: s.type, value: s.a, span: s.span }],
          else: [{ k: "setSelf", name: s.name, type: s.type, value: s.b, span: s.span }],
          span: s.span,
        });
        return;
      case "arrayOp": {
        const fn = { push: "Array_Add", removeAt: "Array_Remove", clear: "Array_Clear", set: "Array_Set" }[s.op];
        const elem = s.array.type.slice("array:".length);
        const arr = this.getVar(s.array.self, s.span);
        const pinTypes: Record<string, string> = { [P.arrayLengthArray]: s.array.type };
        // [operand, pin, pin type]: push feeds NewItem, removeAt IndexToRemove, set Index and Item
        const args: Array<[HirExpr, string, string]> = [];
        if (s.op === "push" && s.value) args.push([s.value, "NewItem", elem]);
        if (s.op === "removeAt" && s.index) args.push([s.index, "IndexToRemove", "int"]);
        if (s.op === "set" && s.index && s.value) args.push([s.index, "Index", "int"], [s.value, "Item", elem]);
        const ops: Array<{ o: Operand; pin: string }> = [];
        for (const [x, pin, ty] of args) {
          const o = this.optOperand(x, ty);
          if (o) ops.push({ o, pin });
        }
        if (s.op === "push") pinTypes.NewItem = elem;
        if (s.op === "set") pinTypes.Item = elem;
        const id = this.emit("arr", this.profile.nodeClasses.callArrayFunction, [this.arrayFn(fn)], undefined, s.span, { pinTypes });
        this.execInto(id);
        this.link(arr, `${id}.${P.arrayLengthArray}`);
        const defaults: Record<string, string> = {};
        const objects: Record<string, string> = {};
        for (const { o, pin } of ops) this.feed(o, id, pin, defaults, objects);
        if (s.op === "set") defaults.bSizeToFit = "false";
        this.settle(id, defaults, objects);
        const nulls = ops.flatMap(({ o }) => o.nulls);
        if (nulls.length > 0) this.cur = [...this.cur, ...nulls];
        return;
      }
      case "containerOp": {
        const map = s.container === "map";
        const ty = containerTypes(s.target.type);
        const lib = map ? MAP_LIBRARY : SET_LIBRARY;
        const fn = map
          ? { add: "Map_Add", remove: "Map_Remove", clear: "Map_Clear" }[s.op]
          : { add: "Set_Add", remove: "Set_Remove", clear: "Set_Clear" }[s.op];
        const targetPin = map ? "TargetMap" : "TargetSet";
        const keyPin = map ? "Key" : s.op === "add" ? "NewItem" : "Item";
        const target = this.getVar(s.target.self, s.span);
        const key = s.key ? this.optOperand(s.key, ty.key) : undefined;
        const value = s.value && ty.value !== undefined ? this.optOperand(s.value, ty.value) : undefined;
        const pinTypes: Record<string, string> = { [targetPin]: s.target.type };
        if (s.key) pinTypes[keyPin] = ty.key;
        if (s.value && ty.value !== undefined) pinTypes.Value = ty.value;
        const id = this.emit("cont", this.profile.nodeClasses.callFunction, [this.funcRef(lib, fn)], { k: "call", class: lib, function: fn }, s.span, { pinTypes });
        this.execInto(id);
        this.link(target, `${id}.${targetPin}`);
        const defaults: Record<string, string> = {};
        if (key) this.feed(key, id, keyPin, defaults);
        if (value) this.feed(value, id, "Value", defaults);
        this.settle(id, defaults);
        const nulls = [...(key?.nulls ?? []), ...(value?.nulls ?? [])];
        if (nulls.length > 0) this.cur = [...this.cur, ...nulls];
        return;
      }
      case "forCount": {
        if (this.loopMacros && s.step === 1 && !hasReturn(s.body)) {
          const b = forLoopBound(s);
          if (b) return this.forLoopMacro(s, b);
        }
        const counter = `abfc_${this.event.name}_i${this.loopCount++}`;
        this.vars.push({ name: counter, type: "int", flags: ["transient"], origin: s.span, temp: true });
        this.locals.set(s.counter, { temp: counter });
        const start = this.operand(s.init, "int");
        const init = this.setVar(counter, s.span);
        this.execInto(init);
        const initDefaults: Record<string, string> = {};
        this.feed(start, init, counter, initDefaults);
        this.settle(init, initDefaults);
        if (start.nulls.length > 0) this.cur = [...this.cur, ...start.nulls];
        // the loop head is whatever exec node the condition starts with; the back-edge returns there
        const fromInit = new Set(this.cur);
        const mark = this.wires.length;
        const c = this.cond(s.cond, this.cur);
        const heads = this.wires.slice(mark).filter((w) => fromInit.has(w[0]) && w[1].endsWith(`.${P.execute}`)).map((w) => w[1]);
        const head = heads[0];
        if (head === undefined || heads.length !== 1) return this.unsupported("a loop condition without a single entry", s.span);
        this.cur = c.t;
        const ctx: LoopCtx = { macro: false, breaks: [], continues: [] };
        this.loops.push(ctx);
        this.stmts(s.body);
        this.loops.pop();
        this.cur = [...this.cur, ...ctx.continues];
        if (this.cur.length > 0) {
          const get = this.getVar(counter, s.span);
          const fn = this.mathFn(s.step === 1 ? "Add" : "Subtract", "int");
          const step = this.pureCall(fn.class, fn.name, s.span, { pinDefaults: { [P.opB]: "1" } });
          this.link(get, `${step}.${P.opA}`);
          const next = this.setVar(counter, s.span);
          this.execInto(next);
          this.link(`${step}.${P.returnValue}`, `${next}.${counter}`);
          this.link(`${next}.${P.then}`, head);
        }
        this.cur = [...c.f, ...ctx.breaks];
        return;
      }
      case "forOf": {
        if (this.loopMacros && !hasReturn(s.body)) return this.forEachMacro(s);
        const arr = this.value(s.array);
        const counter = `abfc_${this.event.name}_i${this.loopCount++}`;
        this.vars.push({ name: counter, type: "int", flags: ["transient"], origin: s.span, temp: true });
        const init = this.setVar(counter, s.span, { pinDefaults: { [counter]: "0" } });
        this.execInto(init);
        const head = this.branch(undefined, undefined, s.span);
        const getI = this.getVar(counter, s.span);
        const f = this.profile.functions.arrayLength;
        const len = this.emit("arr", this.profile.nodeClasses.callArrayFunction,
          ["bIsPureFunc=True", this.funcRef(f.class, f.name)], undefined, s.span,
          { pinTypes: { [P.arrayLengthArray]: s.array.type } });
        this.link(arr.pin, `${len}.${P.arrayLengthArray}`);
        const less = this.pureCall(this.profile.functions.lessInt.class, this.profile.functions.lessInt.name, s.span);
        this.link(getI, `${less}.${P.opA}`);
        this.link(`${len}.${P.returnValue}`, `${less}.${P.opB}`);
        this.link(`${less}.${P.returnValue}`, `${head}.${P.condition}`);
        this.cur = [`${head}.${P.then}`];
        const getI2 = this.getVar(counter, s.span);
        const item = this.emit("item", this.profile.nodeClasses.getArrayItem, ["bReturnByRefDesired=False"], undefined, s.span,
          { pinTypes: { [P.getItemArray]: s.array.type, [P.getItemOutput]: s.elem } });
        this.link(arr.pin, `${item}.${P.getItemArray}`);
        this.link(getI2, `${item}.${P.getItemIndex}`);
        this.locals.set(s.local, { pin: `${item}.${P.getItemOutput}` });
        if (s.index !== undefined) this.locals.set(s.index, { temp: counter });
        const ctx: LoopCtx = { macro: false, breaks: [], continues: [] };
        this.loops.push(ctx);
        this.stmts(s.body);
        this.loops.pop();
        this.cur = [...this.cur, ...ctx.continues];
        const getI3 = this.getVar(counter, s.span);
        const add = this.pureCall(this.profile.functions.addInt.class, this.profile.functions.addInt.name, s.span,
          { pinDefaults: { [P.opB]: "1" } });
        this.link(getI3, `${add}.${P.opA}`);
        const inc = this.setVar(counter, s.span);
        this.execInto(inc);
        this.link(`${add}.${P.returnValue}`, `${inc}.${counter}`);
        this.link(`${inc}.${P.then}`, `${head}.${P.execute}`);
        this.cur = [`${head}.${P.else}`, ...ctx.breaks];
        return;
      }
      case "break": {
        const loop = this.loops[this.loops.length - 1];
        if (loop === undefined) return this.unsupported("break outside a loop", s.span);
        if (loop.breakPin !== undefined) for (const x of this.cur) this.link(x, loop.breakPin);
        else loop.breaks.push(...this.cur);
        this.cur = [];
        return;
      }
      case "continue": {
        const loop = this.loops[this.loops.length - 1];
        if (loop === undefined) return this.unsupported("continue outside a loop", s.span);
        if (!loop.macro) loop.continues.push(...this.cur); // in a macro body the end of the chain is the next iteration
        this.cur = [];
        return;
      }
    }
  }

  /** Instances an engine StandardMacros loop macro; every current exit runs into its exec input pin (`Exec` for ForEachLoop, `execute` for ForLoop). */
  private stdMacro(name: StdLoop, origin: Span, pinTypes?: Record<string, string>): string {
    const id = this.emit(
      "loop",
      K2_MACRO_INSTANCE,
      [`MacroGraphReference=(MacroGraph="/Script/Engine.EdGraph'${STD_MACROS_ASSET}:${name}'",GraphBlueprint="/Script/Engine.Blueprint'${STD_MACROS_ASSET}'")`],
      { k: "std_macro", name },
      origin,
      pinTypes ? { pinTypes } : undefined,
    );
    for (const x of this.cur) this.link(x, `${id}.${STD_LOOP_EXEC[name]}`);
    return id;
  }

  /** `for (const x of arr)` as a ForEachLoop instance: the element is the `Array Element` pin; the end of the body chain means "next iteration". */
  private forEachMacro(s: Extract<HirStmt, { k: "forOf" }>): void {
    const arr = this.value(s.array);
    const brk = hasBreak(s.body);
    const pins = brk ? FOR_EACH_BREAK : FOR_EACH;
    const id = this.stdMacro(brk ? "ForEachLoopWithBreak" : "ForEachLoop", s.span, { [pins.array]: s.array.type, [pins.element]: s.elem });
    this.link(arr.pin, `${id}.${pins.array}`);
    this.locals.set(s.local, { pin: `${id}.${pins.element}` });
    if (s.index !== undefined) this.locals.set(s.index, { pin: `${id}.${pins.index}` });
    this.cur = [`${id}.${pins.body}`];
    this.loops.push({ macro: true, ...(brk ? { breakPin: `${id}.${FOR_EACH_BREAK.brk}` } : {}), breaks: [], continues: [] });
    this.stmts(s.body);
    this.loops.pop();
    this.cur = [`${id}.${pins.completed}`];
  }

  /** A counted `for` (see `forLoopBound`) as a ForLoop instance: FirstIndex = init, LastIndex = bound (`<`: bound - 1). */
  private forLoopMacro(s: Extract<HirStmt, { k: "forCount" }>, b: { bound: HirExpr; inclusive: boolean }): void {
    const start = this.operand(s.init, "int");
    // On a null start the invalid exit still enters the loop: the macro then reads FirstIndex from an invalid object (Accessed None, reads
    // as 0), whereas the manual lowering keeps a stale counter. Neither matches TypeScript exactly.
    if (start.nulls.length > 0) this.cur = [...this.cur, ...start.nulls];
    const last = this.operand(b.bound, "int");
    const brk = hasBreak(s.body);
    const id = this.stdMacro(brk ? "ForLoopWithBreak" : "ForLoop", s.span);
    const defaults: Record<string, string> = {};
    this.feed(start, id, FOR_LOOP.first, defaults);
    if (b.inclusive) this.feed(last, id, FOR_LOOP.last, defaults);
    else if (last.lit !== undefined) defaults[FOR_LOOP.last] = String(Number(last.lit) - 1);
    else {
      const P = this.profile.pins;
      const fn = this.mathFn("Subtract", "int");
      const sub = this.pureCall(fn.class, fn.name, s.span, { pinDefaults: { [P.opB]: "1" } });
      this.link(last.pin!, `${sub}.${P.opA}`);
      this.link(`${sub}.${P.returnValue}`, `${id}.${FOR_LOOP.last}`);
    }
    this.settle(id, defaults);
    this.locals.set(s.counter, { pin: `${id}.${FOR_LOOP.index}` });
    this.cur = [`${id}.${FOR_LOOP.body}`];
    this.loops.push({ macro: true, ...(brk ? { breakPin: `${id}.${FOR_LOOP_BREAK.brk}` } : {}), breaks: [], continues: [] });
    this.stmts(s.body);
    this.loops.pop();
    this.cur = [`${id}.${FOR_LOOP.completed}`];
  }
}

/** Whether a `return` occurs anywhere in the statements (nested `if` and loop bodies included). */
function hasReturn(list: HirStmt[]): boolean {
  return list.some(
    (s) =>
      s.k === "return" ||
      (s.k === "if" && (hasReturn(s.then) || hasReturn(s.else))) ||
      ((s.k === "forOf" || s.k === "forCount") && hasReturn(s.body)),
  );
}

/** Whether a `break` of this loop occurs in the statements (nested `if` bodies included, nested loops not: their break is their own). */
function hasBreak(list: HirStmt[]): boolean {
  return list.some((s) => s.k === "break" || (s.k === "if" && (hasBreak(s.then) || hasBreak(s.else))));
}

/** The bound of `for (let i = A; i < E | i <= E; i++)` when E is pure and does not read the counter (ForLoop-eligible), else undefined. */
function forLoopBound(s: Extract<HirStmt, { k: "forCount" }>): { bound: HirExpr; inclusive: boolean } | undefined {
  const c = s.cond;
  if (c.k !== "cmp" || c.kind !== "int" || (c.op !== "<" && c.op !== "<=")) return undefined;
  if (c.a.k !== "local" || c.a.id !== s.counter || !isPureBound(c.b, s.counter)) return undefined;
  return { bound: c.b, inclusive: c.op === "<=" };
}

/**
 * Whether a pure expression reads state that a later statement can change, so that its value depends on when a consumer
 * runs: own or other objects' variables, arrays, containers, and pure member calls. Literals, parameters, locals (stable:
 * a literal, an exec node's output or a temp) and outputs of impure calls are fixed once evaluated.
 */
export function readsState(e: HirExpr, unstable: ReadonlySet<LocalId> = new Set()): boolean {
  const r = (x: HirExpr): boolean => readsState(x, unstable);
  switch (e.k) {
    case "local":
      return unstable.has(e.id);
    case "getSelf":
    case "getOn":
    case "containerQuery":
      return true;
    case "call":
      if (!e.pure) return false;
      if (!e.static) return true;
      return e.args.some((a) => r(a.value));
    case "out":
      return r(e.call);
    case "field":
      return r(e.obj);
    case "length":
      return r(e.array);
    case "index":
      return r(e.array) || r(e.index);
    case "arrayFind":
      return r(e.array) || r(e.value);
    case "arith":
    case "cmp":
    case "eq":
    case "and":
    case "or":
      return r(e.a) || r(e.b);
    case "not":
      return r(e.e);
    case "isValid":
    case "cast":
      return r(e.value);
    case "formatText":
      return e.args.some((a) => r(a.value));
    case "makeStruct":
      return e.fields.some((f) => r(f.value));
    default:
      return false;
  }
}

/** Whether evaluating the expression emits no exec node and no null exit, and does not read the loop counter. */
function isPureBound(e: HirExpr, counter: LocalId): boolean {
  switch (e.k) {
    case "lit":
    case "enumLit":
    case "nameLit":
    case "self":
    case "param":
    case "getSelf":
      return true;
    case "local":
      return e.id !== counter;
    case "getOn":
    case "field":
      return isPureBound(e.obj, counter);
    case "length":
      return isPureBound(e.array, counter);
    case "index":
      return isPureBound(e.array, counter) && isPureBound(e.index, counter);
    case "arrayFind":
      return isPureBound(e.array, counter) && isPureBound(e.value, counter);
    case "arith":
      return isPureBound(e.a, counter) && isPureBound(e.b, counter);
    case "out":
      return isPureBound(e.call, counter);
    case "containerQuery":
      return isPureBound(e.target, counter) && (e.key === undefined || isPureBound(e.key, counter));
    case "call":
      return (
        e.pure &&
        e.execOutputs === null &&
        (e.target === null || isPureBound(e.target, counter)) &&
        e.args.every((a) => isPureBound(a.value, counter))
      );
    default:
      return false;
  }
}
