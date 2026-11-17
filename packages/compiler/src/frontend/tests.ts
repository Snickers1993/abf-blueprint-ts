// Test-file compiler: `*.test.ts` statements -> `TestCase` steps (design 11). Nothing here runs the tests.
import ts from "typescript";
import type { Diagnostic, Profile, TestCase, TestStepRecord } from "@abfc/ir";
import { classPathOf, importOf } from "./build.js";
import { bindPathContext, modImportHints } from "./assetpaths.js";
import type { CompilerProjectConfig } from "./assetpaths.js";
import { DiagSink, Fail, relFile, spanOf } from "./diag.js";
import type { LoadedProgram } from "./program.js";
import { classInfo, resolveAlias, tsBlueprintOfDecl } from "./tags.js";

type Lit = string | number | boolean | null;

class TestCompiler {
  readonly sink: DiagSink;
  readonly steps: TestStepRecord[] = [];
  private readonly names = new Map<ts.Symbol, string>();
  private tSym: ts.Symbol | undefined;
  private tmp = 0;

  constructor(private readonly checker: ts.TypeChecker, root: string, private readonly consts: ReadonlyMap<ts.Symbol, string> = new Map()) {
    this.sink = new DiagSink(root);
  }

  compile(cb: ts.ArrowFunction | ts.FunctionExpression): void {
    const p = cb.parameters[0];
    if (p && ts.isIdentifier(p.name)) this.tSym = this.checker.getSymbolAtLocation(p.name);
    if (!ts.isBlock(cb.body)) {
      this.sink.error("ABFC2101", "a test body must be a block", cb.body);
      return;
    }
    for (const st of cb.body.statements) {
      try {
        this.statement(st);
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
      }
    }
  }

  private add(node: ts.Node, step: Record<string, unknown>, knownIssue?: string): void {
    const rec: TestStepRecord = { step, span: spanOf(node, this.sink.root) };
    if (knownIssue !== undefined) rec.knownIssue = knownIssue;
    this.steps.push(rec);
  }

  private isT(e: ts.Expression): boolean {
    return ts.isIdentifier(e) && this.tSym !== undefined && this.checker.getSymbolAtLocation(e) === this.tSym;
  }

  /** The name of a handle or value variable (`h` -> `$h`). */
  private refName(e: ts.Expression): string | undefined {
    if (!ts.isIdentifier(e)) return undefined;
    const sym = this.checker.getSymbolAtLocation(e);
    return sym ? this.names.get(sym) : undefined;
  }

  private method(e: ts.Expression): { call: ts.CallExpression; recv: ts.Expression; name: string } | undefined {
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      return { call: e, recv: e.expression.expression, name: e.expression.name.text };
    }
    return undefined;
  }

  private literal(n: ts.Expression): { value: Lit } | undefined {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return { value: n.text };
    if (ts.isNumericLiteral(n)) return { value: Number(n.text) };
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return { value: -Number(n.operand.text) };
    if (n.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
    if (n.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
    if (n.kind === ts.SyntaxKind.NullKeyword) return { value: null };
    return undefined;
  }

  private strArg(n: ts.Expression | undefined, what: string, at: ts.Node): string {
    if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) return n.text;
    if (n && ts.isIdentifier(n)) {
      const sym = this.checker.getSymbolAtLocation(n);
      const v = sym ? this.consts.get(sym) : undefined;
      if (v !== undefined) return v;
    }
    return this.sink.fail("ABFC2102", `${what} must be a string literal (or a top-level const of one)`, n ?? at);
  }

  private argValue(n: ts.Expression): Lit {
    const lit = this.literal(n);
    if (lit) return lit.value;
    const ref = this.refName(n);
    if (ref !== undefined) return `$${ref}`;
    return this.sink.fail("ABFC2102", "a test argument must be a literal or a handle", n);
  }

  private classPathArg(n: ts.Expression | undefined, at: ts.Node): string {
    const s = n ? this.checker.getSymbolAtLocation(n) : undefined;
    if (!n || !s) return this.sink.fail("ABFC2102", "expected a class", n ?? at);
    const sym = resolveAlias(this.checker, s);
    for (const d of sym.declarations ?? []) {
      if (ts.isClassDeclaration(d)) {
        const p = tsBlueprintOfDecl(d)?.path;
        if (p !== undefined) return classPathOf(p);
      }
    }
    const ci = classInfo(sym);
    if (ci) return ci.path;
    return this.sink.fail("ABFC2102", "the class has no Blueprint path (@blueprint or @bpPath)", n);
  }

  private statement(st: ts.Statement): void {
    if (ts.isEmptyStatement(st)) return;
    if (ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations[0];
      if (!(st.declarationList.flags & ts.NodeFlags.Const) || st.declarationList.declarations.length !== 1 || !d || !ts.isIdentifier(d.name) || !d.initializer) {
        this.sink.fail("ABFC2101", "only `const x = ...` is supported in a test", st);
      }
      const sym = this.checker.getSymbolAtLocation(d.name);
      const as = d.name.text;
      this.value(d.initializer, as, sym);
      return;
    }
    if (ts.isExpressionStatement(st)) {
      this.exprStatement(st.expression);
      return;
    }
    this.sink.fail("ABFC2101", `statement of kind ${ts.SyntaxKind[st.kind]} is not supported in a test`, st);
  }

  /** `const as = <call>`: spawn/widget/python/call/get. */
  private value(e: ts.Expression, as: string, sym: ts.Symbol | undefined): void {
    const m = this.method(e);
    if (!m) this.sink.fail("ABFC2101", "expected t.spawn, t.find, t.widget, t.distance, t.python, h.call or h.get", e);
    const args = m.call.arguments;
    if (this.isT(m.recv)) {
      if (m.name === "spawn" || m.name === "widget") {
        this.add(m.call, { op: m.name, class: this.classPathArg(args[0], m.call), as });
      } else if (m.name === "find") {
        this.add(m.call, this.findStep(m.call, as));
      } else if (m.name === "distance") {
        this.add(m.call, { ...this.distanceStep(m.call), as });
      } else if (m.name === "python") {
        const { code, known } = this.python(m.call);
        this.add(m.call, { op: "python", code, as }, known);
      } else {
        this.sink.fail("ABFC2101", `t.${m.name} cannot be assigned`, e);
      }
    } else if (this.refName(m.recv) !== undefined) {
      if (m.name !== "call" && m.name !== "get") this.sink.fail("ABFC2101", `h.${m.name} cannot be assigned`, e);
      this.handleCall(m.call, m.recv, m.name, as);
    } else {
      this.sink.fail("ABFC2101", "expected a call on t or on a handle", e);
    }
    if (sym) this.names.set(sym, as);
  }

  private python(call: ts.CallExpression): { code: string; known: string | undefined } {
    const code = this.strArg(call.arguments[0], "python code", call);
    let known: string | undefined;
    const opt = call.arguments[1];
    if (opt) {
      if (!ts.isObjectLiteralExpression(opt)) this.sink.fail("ABFC2102", "t.python options must be an object literal", opt);
      for (const p of opt.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "knownIssue") known = this.strArg(p.initializer, "knownIssue", p);
        else this.sink.fail("ABFC2102", "unsupported t.python option", p);
      }
    }
    return { code, known };
  }

  /**
   * `t.find(Class, { timeout })`: the first actor of the class placed or spawned in a level, waited for. The backend's `find`
   * matches a substring of the object's path; `PersistentLevel.<Class>_` (an instance is named `<Class>_<n>`) keeps out the
   * actor templates a Blueprint class holds (`<Class>:Child_GEN_VARIABLE...`, at the origin, in no world).
   */
  private findStep(call: ts.CallExpression, as: string): Record<string, unknown> {
    const path = this.classPathArg(call.arguments[0], call);
    const step: Record<string, unknown> = { op: "find", base: "Actor", class_contains: `PersistentLevel.${path.slice(path.lastIndexOf(".") + 1)}_`, as };
    const o = this.options(call.arguments[1], ["timeout"], "t.find");
    if (o.timeout !== undefined) step["timeout"] = o.timeout;
    return step;
  }

  /** `t.distance(a, b)`: the distance between two handles, as a python step. */
  private distanceStep(call: ts.CallExpression): Record<string, unknown> {
    const [a, b] = [call.arguments[0], call.arguments[1]].map((x) => {
      const r = x ? this.refName(x) : undefined;
      return r ?? this.sink.fail("ABFC2102", "t.distance needs two handles", x ?? call);
    });
    return { op: "python", code: `result = ctx[${py(a!)}].get_distance_to(ctx[${py(b!)}])` };
  }

  /** An options object literal whose properties are number literals, e.g. `{ timeout: 5 }`. */
  private options(n: ts.Expression | undefined, allowed: string[], what: string): Record<string, number> {
    const out: Record<string, number> = {};
    if (n === undefined) return out;
    if (!ts.isObjectLiteralExpression(n)) this.sink.fail("ABFC2102", `${what} options must be an object literal`, n);
    for (const p of n.properties) {
      const name = ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? p.name.text : undefined;
      if (name === undefined || !allowed.includes(name)) this.sink.fail("ABFC2102", `unsupported ${what} option (${allowed.join(", ")})`, p);
      const v = this.literal((p as ts.PropertyAssignment).initializer);
      if (!v || typeof v.value !== "number" || !(v.value > 0)) this.sink.fail("ABFC2102", `${what} option ${name} must be a positive number literal`, p);
      out[name] = v.value;
    }
    return out;
  }

  /** The step of `h.call(...)` or `h.get(...)` (without `as`), or undefined for any other method. */
  private probeStep(call: ts.CallExpression, recv: ts.Expression, name: string): Record<string, unknown> | undefined {
    const target = `$${this.refName(recv)}`;
    const args = call.arguments;
    if (name === "call") {
      const fn = this.strArg(args[0], "function name", call);
      return { op: "call", target, function: fn, args: args.slice(1).map((a) => this.argValue(a)) };
    }
    if (name === "get") return { op: "get", target, property: this.strArg(args[0], "property name", call) };
    return undefined;
  }

  private numArgs(call: ts.CallExpression, count: number, what: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const v = call.arguments[i] ? this.literal(call.arguments[i]!) : undefined;
      if (!v || typeof v.value !== "number") this.sink.fail("ABFC2102", `${what} needs ${count} number literals`, call.arguments[i] ?? call);
      out.push(v.value);
    }
    return out;
  }

  private handleCall(call: ts.CallExpression, recv: ts.Expression, name: string, as: string | undefined): void {
    const ref = this.refName(recv)!;
    const args = call.arguments;
    const probe = this.probeStep(call, recv, name);
    if (probe !== undefined) {
      this.add(call, as === undefined ? probe : { ...probe, as });
    } else if (name === "set") {
      const prop = this.strArg(args[0], "property name", call);
      const v = args[1] ? this.literal(args[1]) : undefined;
      if (!v) this.sink.fail("ABFC2102", "the value of set must be a literal", args[1] ?? call);
      this.add(call, { op: "set", target: `$${ref}`, property: prop, value: v.value });
    } else if (name === "moveTo" && args.length === 1) {
      const other = args[0] ? this.refName(args[0]) : undefined;
      if (other === undefined) this.sink.fail("ABFC2102", "moveTo needs x, y, z number literals or a handle", args[0] ?? call);
      this.add(call, { op: "python", code: `ctx[${py(ref)}].set_actor_location(ctx[${py(other)}].get_actor_location(), False, True)` });
    } else if (name === "moveTo") {
      const [x, y, z] = this.numArgs(call, 3, "moveTo");
      this.add(call, { op: "python", code: `ctx[${py(ref)}].set_actor_location(unreal.Vector(${num(x!)}, ${num(y!)}, ${num(z!)}), False, True)` });
    } else if (name === "aim") {
      const [pitch, yaw] = this.numArgs(call, 2, "aim");
      const code = [
        `a = ctx[${py(ref)}]`,
        `r = unreal.Rotator(roll=0.0, pitch=${num(pitch!)}, yaw=${num(yaw!)})`,
        "a.set_actor_rotation(r, True)",
        "c = a.get_controller() if isinstance(a, unreal.Pawn) else None",
        "if c is not None:",
        "    c.set_control_rotation(r)",
      ].join("\n");
      this.add(call, { op: "python", code });
    } else {
      this.sink.fail("ABFC2101", `h.${name} is not supported in a test`, call);
    }
  }

  private exprStatement(e: ts.Expression): void {
    const top = this.method(e);
    if (!top) this.sink.fail("ABFC2101", "expected a call statement", e);
    if (this.isT(top.recv)) {
      if (top.name === "wait") {
        const n = top.call.arguments[0] ? this.literal(top.call.arguments[0]) : undefined;
        if (!n || typeof n.value !== "number") this.sink.fail("ABFC2102", "t.wait needs a number literal", top.call);
        this.add(top.call, { op: "wait", seconds: n.value });
        return;
      }
      if (top.name === "python") {
        const { code, known } = this.python(top.call);
        this.add(top.call, { op: "python", code }, known);
        return;
      }
      if (top.name === "note") {
        this.note(top.call);
        return;
      }
      this.sink.fail("ABFC2101", `t.${top.name} is not supported as a statement`, e);
    }
    if (this.refName(top.recv) !== undefined) {
      this.handleCall(top.call, top.recv, top.name, undefined);
      return;
    }
    this.assertion(e);
  }

  /** `t.note("label", v)`: reads `v` (a variable, or an inline h.get/h.call/t.distance/t.python) for the run's output. */
  private note(call: ts.CallExpression): void {
    const label = this.strArg(call.arguments[0], "the note label", call);
    const v = call.arguments[1];
    if (!v) this.sink.fail("ABFC2102", "t.note needs a label and a value", call);
    let step: Record<string, unknown> | undefined;
    const ref = this.refName(v);
    if (ref !== undefined) step = { op: "python", code: `result = ctx[${py(ref)}]` };
    else {
      const inner = this.method(v);
      if (inner && this.refName(inner.recv) !== undefined) step = this.probeStep(inner.call, inner.recv, inner.name);
      else if (inner && this.isT(inner.recv) && inner.name === "distance") step = this.distanceStep(inner.call);
      else if (inner && this.isT(inner.recv) && inner.name === "python") step = { op: "python", code: this.python(inner.call).code };
    }
    if (step === undefined) this.sink.fail("ABFC2102", "t.note needs a variable or an inline h.get(...), h.call(...), t.distance(...) or t.python(...)", v);
    this.add(call, step);
    this.steps[this.steps.length - 1]!.note = label;
  }

  /** `t.expect(X).equals(v)` or `t.waitUntil(X, { timeout }).equals(v)`, with an optional trailing `.knownIssue(reason)`. */
  private assertion(e: ts.Expression): void {
    let node = e;
    let known: string | undefined;
    const outer = this.method(node);
    if (outer && outer.name === "knownIssue") {
      known = this.strArg(outer.call.arguments[0], "knownIssue reason", outer.call);
      node = outer.recv;
    }
    const m = this.method(node);
    if (!m) this.sink.fail("ABFC2101", "expected t.expect(...).<assertion>(...)", e);
    const exp = this.method(m.recv);
    if (!exp || (exp.name !== "expect" && exp.name !== "waitUntil") || !this.isT(exp.recv)) this.sink.fail("ABFC2101", "expected t.expect(...).<assertion>(...)", e);
    const subject = exp.call.arguments[0];
    if (!subject) this.sink.fail("ABFC2102", `t.${exp.name} needs a value`, exp.call);
    const check = this.expectation(m);

    if (exp.name === "waitUntil") {
      const inner = this.method(subject);
      let probe: Record<string, unknown> | undefined;
      if (inner && this.refName(inner.recv) !== undefined) probe = this.probeStep(inner.call, inner.recv, inner.name);
      else if (inner && this.isT(inner.recv) && inner.name === "distance") probe = this.distanceStep(inner.call);
      else if (inner && this.isT(inner.recv) && inner.name === "python") {
        const { code, known: k } = this.python(inner.call);
        if (k !== undefined) this.sink.fail("ABFC2102", "put knownIssue on the waitUntil expectation, not on its t.python", inner.call);
        probe = { op: "python", code };
      }
      if (probe === undefined) {
        this.sink.fail("ABFC2102", "t.waitUntil needs an inline h.get(...), h.call(...), t.distance(...) or t.python(...) (a variable holds one reading)", subject);
      }
      const o = this.options(exp.call.arguments[1], ["timeout", "every"], "t.waitUntil");
      this.add(node, { op: "until", probe, ...check, timeout: o.timeout ?? 10, every: o.every ?? 0.25 }, known);
      return;
    }

    let value = this.refName(subject);
    if (value === undefined) {
      const inner = this.method(subject);
      if (inner && this.refName(inner.recv) !== undefined && (inner.name === "call" || inner.name === "get")) {
        value = `_v${this.tmp++}`;
        this.handleCall(inner.call, inner.recv, inner.name, value);
      } else if (inner && this.isT(inner.recv) && inner.name === "distance") {
        value = `_v${this.tmp++}`;
        this.add(inner.call, { ...this.distanceStep(inner.call), as: value });
      } else {
        this.sink.fail("ABFC2102", "t.expect needs a variable or an h.call/h.get/t.distance expression", subject);
      }
    }
    this.add(node, { op: "assert", value: `$${value}`, ...check }, known);
  }

  /** The check fields of `.equals(v)`, `.approx(v, tol)`, ...: the bp_game_test assert keys. */
  private expectation(m: { call: ts.CallExpression; name: string }): Record<string, unknown> {
    const a = m.call.arguments;
    const step: Record<string, unknown> = {};
    switch (m.name) {
      case "equals": {
        const lit = a[0] ? this.literal(a[0]) : undefined;
        if (!lit) this.sink.fail("ABFC2102", "equals needs a literal", a[0] ?? m.call);
        step["equals"] = lit.value;
        break;
      }
      case "approx": {
        const v = a[0] ? this.literal(a[0]) : undefined;
        if (!v || typeof v.value !== "number") this.sink.fail("ABFC2102", "approx needs a number literal", a[0] ?? m.call);
        const tol = a[1] ? this.literal(a[1]) : undefined;
        if (a[1] && (!tol || typeof tol.value !== "number")) this.sink.fail("ABFC2102", "the approx tolerance must be a number literal", a[1]);
        step["approx"] = v.value;
        step["tolerance"] = tol ? tol.value : 0.0001;
        break;
      }
      case "below":
      case "above": {
        const v = a[0] ? this.literal(a[0]) : undefined;
        if (!v || typeof v.value !== "number") this.sink.fail("ABFC2102", `${m.name} needs a number literal`, a[0] ?? m.call);
        step[m.name] = v.value;
        break;
      }
      case "contains":
        step["contains"] = this.strArg(a[0], "contains text", m.call);
        break;
      case "truthy":
        step["truthy"] = true;
        break;
      case "notNone":
        step["not_none"] = true;
        break;
      default:
        this.sink.fail("ABFC2101", `expectation ${m.name} is not supported`, m.call);
    }
    return step;
  }
}

/** A Python string literal (a TS identifier, so JSON quoting is valid Python). */
const py = (name: string): string => JSON.stringify(name);
/** A Python number literal. */
const num = (n: number): string => (Number.isInteger(n) && Math.abs(n) < 1e15 ? `${n}.0` : String(n));

/** `{ map: "/Game/Maps/Facility", timeout: 300 }` of `test(name, options, body)`; undefined after an error. */
function runOptions(n: ts.Expression, sink: DiagSink): { map?: string; timeoutSeconds?: number } | undefined {
  if (!ts.isObjectLiteralExpression(n)) {
    sink.error("ABFC2102", "test options must be an object literal ({ map, timeout })", n);
    return undefined;
  }
  const out: { map?: string; timeoutSeconds?: number } = {};
  for (const p of n.properties) {
    const name = ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? p.name.text : undefined;
    const init = ts.isPropertyAssignment(p) ? p.initializer : undefined;
    if (name === "map" && init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) && /^\/[A-Za-z0-9_]+\/[A-Za-z0-9_/]+$/.test(init.text)) {
      out.map = init.text;
    } else if (name === "timeout" && init && ts.isNumericLiteral(init) && Number(init.text) > 0) {
      out.timeoutSeconds = Number(init.text);
    } else {
      sink.error("ABFC2102", 'test options are map (a package path literal such as "/Game/Maps/Facility") and timeout (seconds, a number literal)', p);
      return undefined;
    }
  }
  return out;
}

/**
 * Compiles every top-level `test("name", (t) => { ... })` of the project's `*.test.ts` files into bp_game_test steps.
 * `filter` keeps cases whose name or file contains it.
 */
export function compileTests(loaded: LoadedProgram, _profile: Profile, filter?: string, config?: CompilerProjectConfig): { cases: TestCase[]; diagnostics: Diagnostic[] } {
  if (config !== undefined) bindPathContext(loaded, config);
  const cases: TestCase[] = [];
  const diagnostics: Diagnostic[] = [];
  const root = loaded.projectDir;
  for (const sf of loaded.files.tests) {
    const file = relFile(root, sf.fileName);
    diagnostics.push(...modImportHints(sf));
    // top-level `const NAME = "text"` (or a backtick string without ${}): shared text such as python code
    const consts = new Map<ts.Symbol, string>();
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        const sym = ts.isIdentifier(d.name) ? loaded.checker.getSymbolAtLocation(d.name) : undefined;
        if (sym && init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) consts.set(sym, init.text);
      }
    }
    const isConst = (d: ts.VariableDeclaration): boolean => {
      const sym = ts.isIdentifier(d.name) ? loaded.checker.getSymbolAtLocation(d.name) : undefined;
      return sym !== undefined && consts.has(sym);
    };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isEmptyStatement(st)) continue;
      if (ts.isVariableStatement(st) && st.declarationList.declarations.every((d) => isConst(d))) continue;
      const call = ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) ? st.expression : undefined;
      // `test(...)` or `test.liveHud(...)`
      const liveHud = call !== undefined && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "liveHud";
      const callee = call && ts.isIdentifier(call.expression)
        ? call.expression
        : call && liveHud && ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) ? call.expression.expression : undefined;
      const imp = callee ? importOf(loaded.checker, callee) : undefined;
      if (!call || !imp || imp.module !== "@abfc/testkit" || imp.name !== "test") {
        const sink = new DiagSink(root);
        sink.error("ABFC2101", "only top-level test(...) and test.liveHud(...) calls (and const strings) are supported in a test file", st);
        diagnostics.push(...sink.diagnostics);
        continue;
      }
      const nameArg = call.arguments[0];
      // test(name, body) or test(name, { map, timeout }, body)
      const withOptions = !liveHud && call.arguments.length === 3;
      const cb = call.arguments[liveHud || withOptions ? 2 : 1];
      const tc = new TestCompiler(loaded.checker, root, consts);
      if (!nameArg || !(ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg)) || !cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
        tc.sink.error(
          "ABFC2101",
          liveHud ? 'test.liveHud("name", ["check", ...], (t) => { ... }) needs a literal name, a checklist and an inline callback' : 'test("name", (t) => { ... }) needs a literal name and an inline callback',
          call,
        );
        diagnostics.push(...tc.sink.diagnostics);
        continue;
      }
      let checklist: string[] | undefined;
      if (liveHud) {
        const list = call.arguments[1];
        const items = list && ts.isArrayLiteralExpression(list) ? list.elements : undefined;
        if (!list || !items || items.length === 0 || !items.every((x) => ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x))) {
          tc.sink.error("ABFC2101", "the checklist of test.liveHud must be a non-empty array literal of string literals", list ?? call);
          diagnostics.push(...tc.sink.diagnostics);
          continue;
        }
        checklist = items.map((x) => (x as ts.StringLiteral).text);
      }
      let run: { map?: string; timeoutSeconds?: number } = {};
      if (withOptions) {
        const r = runOptions(call.arguments[1]!, tc.sink);
        if (r === undefined) {
          diagnostics.push(...tc.sink.diagnostics);
          continue;
        }
        run = r;
      }
      tc.compile(cb);
      diagnostics.push(...tc.sink.diagnostics);
      if (filter !== undefined && !nameArg.text.includes(filter) && !file.includes(filter)) continue;
      const tcase: TestCase = { name: nameArg.text, file, span: spanOf(call, root), steps: tc.steps };
      if (checklist !== undefined) tcase.liveHud = { checklist };
      if (run.map !== undefined) tcase.map = run.map;
      if (run.timeoutSeconds !== undefined) tcase.timeoutSeconds = run.timeoutSeconds;
      cases.push(tcase);
    }
  }
  return { cases, diagnostics };
}
