import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic, Profile } from "@abfc/ir";
import { buildHir, checkSubset, compileTests, loadProgram } from "../src/index.js";
import type { HirExpr, HirStmt } from "../src/index.js";
import { udsGuid, udsMemberName } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/project
const projectDir = fileURLToPath(new URL("../../test/fixtures/project", import.meta.url));
const profile = { id: "test" } as unknown as Profile;
const config = { mod: "TestMod" };

const loaded = loadProgram(projectDir);
const fileOf = (name: string) => {
  const sf = loaded.files.classes.find((f) => f.fileName.endsWith(`/${name}`));
  assert.ok(sf, `${name} is a root file`);
  return sf;
};
const inFile = (ds: Diagnostic[], file: string) => ds.filter((d) => d.span?.file === file);

test("project loads: class files and test files are split", () => {
  assert.deepEqual(loaded.files.classes.map((f) => f.fileName.slice(f.fileName.lastIndexOf("/") + 1)).sort(), ["Bad.ts", "Relay.ts"]);
  assert.deepEqual(loaded.files.tests.map((f) => f.fileName.slice(f.fileName.lastIndexOf("/") + 1)), ["Relay.test.ts"]);
});

const relay = buildHir(loaded, config, profile, [fileOf("Relay.ts")]);

test("an Actor subclass has the parent family actor", () => {
  assert.equal(relay.classes[0]!.family, "actor");
});

test("Relay.ts is clean (TypeScript and subset)", () => {
  assert.deepEqual(inFile(loaded.diagnostics, "src/Relay.ts"), []);
  assert.deepEqual(inFile(loaded.diagnostics, "src/Relay.test.ts"), []);
  assert.deepEqual(relay.diagnostics, []);
});

function allExprs(s: HirStmt, out: HirExpr[]): void {
  const walk = (e: HirExpr): void => {
    out.push(e);
    switch (e.k) {
      case "getOn": case "field": walk(e.obj); break;
      case "out": walk(e.call); break;
      case "call": if (e.target) walk(e.target); e.args.forEach((a) => walk(a.value)); break;
      case "cast": case "isValid": walk(e.value); break;
      case "optional": walk(e.value); walk(e.then); break;
      case "eq": case "and": case "or": walk(e.a); walk(e.b); break;
      case "not": walk(e.e); break;
      case "length": walk(e.array); break;
      default: break;
    }
  };
  switch (s.k) {
    case "expr": walk(s.e); break;
    case "setSelf": walk(s.value); break;
    case "const": walk(s.init); break;
    case "if": walk(s.cond); s.then.forEach((x) => allExprs(x, out)); s.else.forEach((x) => allExprs(x, out)); break;
    case "forOf": walk(s.array); s.body.forEach((x) => allExprs(x, out)); break;
    default: break;
  }
}

test("HIR of Relay.UpdateTarget", () => {
  assert.equal(relay.classes.length, 1);
  const cls = relay.classes[0]!;
  assert.equal(cls.name, "BP_Relay");
  assert.equal(cls.path, "/TestMod/Relay/BP_Relay");
  assert.equal(cls.classPath, "/TestMod/Relay/BP_Relay.BP_Relay_C");
  assert.equal(cls.parent, "/Script/FakeEngine.Actor");
  assert.deepEqual(cls.manualUnits, ["HideAll"]);
  assert.equal(cls.events.length, 1);
  const ev = cls.events[0]!;
  assert.equal(ev.name, "UpdateTarget");
  assert.deepEqual(ev.params, []);
  assert.deepEqual(
    ev.body.map((s) => s.k),
    ["const", "const", "if", "const", "if", "setSelf", "setSelf", "const", "if", "const", "if", "forOf", "setSelf"],
  );

  const consts = ev.body.filter((s): s is Extract<HirStmt, { k: "const" }> => s.k === "const");
  assert.deepEqual(consts.map((c) => [c.name, c.uses]), [["player", 1], ["pot", 6], ["rowName", 2], ["row", 2], ["info", 6]]);
  assert.equal(consts[0]!.init.k, "cast");
  assert.equal(consts[3]!.init.type, "result");

  const exprs: HirExpr[] = [];
  ev.body.forEach((s) => allExprs(s, exprs));
  assert.deepEqual(exprs.flatMap((e) => (e.k === "eq" ? [e.kind] : [])), ["object", "name", "real", "real", "int"]);
  const loop = ev.body.find((s): s is Extract<HirStmt, { k: "forOf" }> => s.k === "forOf");
  assert.equal(loop?.elem, "object:/Game/Fake/WBP_Show.WBP_Show_C");
  assert.equal(loop?.name, "w");
  const exec = exprs.find((e) => e.k === "execIs");
  assert.ok(exec && exec.k === "execIs" && exec.pin === "Valid" && exec.negate);
  const casts = exprs.flatMap((e) => (e.k === "cast" ? [e.castPin] : []));
  assert.deepEqual(casts, ["AsBPFakeCharacter", "AsBPFakePot"]);

  assert.equal(relay.classMeta["/Game/Fake/WBP_Show.WBP_Show_C"], "/Script/UMG.WidgetBlueprintGeneratedClass");
  assert.equal(relay.classMeta["/Game/Fake/BP_FakePot.BP_FakePot_C"], "/Script/Engine.BlueprintGeneratedClass");
  assert.equal(relay.classMeta["/TestMod/Relay/BP_Relay.BP_Relay_C"], "/Script/Engine.BlueprintGeneratedClass");
});

test("Bad.ts: every marked error is reported at its line and column, and nothing else", () => {
  const text = readFileSync(`${projectDir}/src/Bad.ts`, "utf8").split(/\r?\n/);
  const expected: Array<{ line: number; code: string; col: number | undefined }> = [];
  text.forEach((raw, i) => {
    const m = /\/\/ ((?:ABFC\d{4}\s*)+)(?:@(.*))?$/.exec(raw);
    if (!m) return;
    const codes = m[1]!.trim().split(/\s+/);
    const snippet = m[2]?.trimEnd();
    for (const code of codes) expected.push({ line: i + 1, code, col: snippet !== undefined && codes.length === 1 ? raw.indexOf(snippet) + 1 : undefined });
  });
  assert.ok(expected.length >= 18, "Bad.ts carries one marker per error");

  const hir = buildHir(loaded, config, profile, [fileOf("Bad.ts")]);
  const actual = inFile([...loaded.diagnostics, ...hir.diagnostics], "src/Bad.ts");
  assert.ok(actual.every((d) => d.severity === "error"));
  const key = (line: number, code: string): string => `${line}:${code}`;
  assert.deepEqual(
    [...new Set(actual.map((d) => key(d.span!.line, d.code)))].sort(),
    [...new Set(expected.map((e) => key(e.line, e.code)))].sort(),
  );
  for (const e of expected) {
    if (e.col === undefined) continue;
    const hits = actual.filter((d) => d.code === e.code && d.span?.line === e.line);
    assert.ok(hits.some((d) => d.span?.col === e.col), `${e.code} on line ${e.line} should start at column ${e.col}, got ${hits.map((d) => d.span?.col).join(",")}`);
  }
  const codes = new Set(actual.map((d) => d.code));
  for (const c of ["ABFC2000", "ABFC2001", "ABFC2010", "ABFC2011", "ABFC2013", "ABFC2014", "ABFC2020", "ABFC2040", "ABFC2050", "ABFC2052", "ABFC2053", "ABFC2060", "ABFC2099", "ABFC3004"]) {
    assert.ok(codes.has(c), `Bad.ts should trigger ${c}`);
  }
});

test("TypeScript errors carry the [TSnnnn] prefix and a 1-based position", () => {
  const ts2322 = loaded.diagnostics.find((d) => d.span?.file === "src/Bad.ts" && d.message.startsWith("[TS2322]"));
  assert.ok(ts2322);
  assert.equal(ts2322.code, "ABFC2000");
  assert.ok(ts2322.span && ts2322.span.line >= 1 && ts2322.span.col >= 1 && ts2322.span.endCol > ts2322.span.col);
});

test("checkSubset reports one file's diagnostics", () => {
  const ds = checkSubset(loaded, fileOf("Bad.ts"), config, profile);
  assert.ok(ds.some((d) => d.code === "ABFC2000"));
  assert.ok(ds.some((d) => d.code === "ABFC2010"));
  assert.deepEqual(checkSubset(loaded, fileOf("Relay.ts"), config, profile), []);
});

test("compileTests: steps JSON", () => {
  const { cases, diagnostics } = compileTests(loaded, profile);
  assert.deepEqual(diagnostics, []);
  const view = cases.map((c) => ({ name: c.name, file: c.file, steps: c.steps.map((s) => (s.knownIssue === undefined ? s.step : { ...s.step, knownIssue: s.knownIssue })) }));
  const cls = "/TestMod/Relay/BP_Relay.BP_Relay_C";
  assert.deepEqual(view, [
    {
      name: "update target clears without a pot",
      file: "src/Relay.test.ts",
      steps: [
        { op: "spawn", class: cls, as: "relay" },
        { op: "call", target: "$relay", function: "UpdateTarget", args: [] },
        { op: "get", target: "$relay", property: "Visible", as: "_v0" },
        { op: "assert", value: "$_v0", equals: false },
        { op: "python", code: "result=str(ctx['relay'].get_editor_property('LastTarget'))", as: "last" },
        { op: "assert", value: "$last", equals: "None" },
        { op: "wait", seconds: 0.5 },
      ],
    },
    {
      name: "assertion forms",
      file: "src/Relay.test.ts",
      steps: [
        { op: "spawn", class: cls, as: "relay" },
        { op: "set", target: "$relay", property: "Visible", value: true },
        { op: "get", target: "$relay", property: "Visible", as: "vis" },
        { op: "assert", value: "$vis", truthy: true },
        { op: "get", target: "$relay", property: "LastName", as: "_v0" },
        { op: "assert", value: "$_v0", contains: "Row" },
        { op: "call", target: "$relay", function: "HideAll", args: [], as: "_v1" },
        { op: "assert", value: "$_v1", not_none: true, knownIssue: "pre-existing" },
        { op: "python", code: "result=1.0", as: "v", knownIssue: "wrong name in this build" },
        { op: "assert", value: "$v", approx: 1, tolerance: 0.01 },
        { op: "python", code: "result=None" },
      ],
    },
  ]);
  const first = cases[0]!;
  assert.equal(first.span.file, "src/Relay.test.ts");
  assert.equal(first.steps[1]!.span.line, 6);
  assert.equal(first.steps[3]!.span.line, 7);
});

test("compileTests: filter keeps matching names and files", () => {
  assert.equal(compileTests(loaded, profile, "assertion").cases.length, 1);
  assert.equal(compileTests(loaded, profile, "Relay.test").cases.length, 2);
  assert.equal(compileTests(loaded, profile, "nothing like this").cases.length, 0);
});

// ---- Phase 2: overrides, own calls, delegates, enums, widgets, spawns, arithmetic ----

const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const loaded2 = loadProgram(phase2Dir);
const file2 = (name: string) => {
  const sf = loaded2.files.classes.find((f) => f.fileName.endsWith(`/${name}`));
  assert.ok(sf, `${name} is a root file`);
  return sf;
};
const director = buildHir(loaded2, config, profile, [file2("Director.ts")]);

function walkExprs(s: HirStmt, out: HirExpr[]): void {
  const walk = (e: HirExpr): void => {
    out.push(e);
    switch (e.k) {
      case "getOn": case "field": walk(e.obj); break;
      case "out": walk(e.call); break;
      case "call": if (e.target) walk(e.target); e.args.forEach((a) => walk(a.value)); break;
      case "callOwn": e.args.forEach((a) => walk(a.value)); break;
      case "cast": case "isValid": walk(e.value); break;
      case "optional": walk(e.value); walk(e.then); break;
      case "eq": case "and": case "or": case "arith": case "cmp": walk(e.a); walk(e.b); break;
      case "not": walk(e.e); break;
      case "length": walk(e.array); break;
      case "index": walk(e.array); walk(e.index); break;
      case "arrayFind": walk(e.array); walk(e.value); break;
      case "createWidget": walk(e.owner); break;
      case "spawn": if (e.owner) walk(e.owner); break;
      default: break;
    }
  };
  switch (s.k) {
    case "setSelfCond": walk(s.cond); walk(s.a); walk(s.b); break;
    case "forCount": walk(s.init); walk(s.cond); s.body.forEach((x) => walkExprs(x, out)); break;
    case "arrayOp": if (s.value) walk(s.value); if (s.index) walk(s.index); break;
    case "expr": walk(s.e); break;
    case "setSelf": walk(s.value); break;
    case "const": walk(s.init); break;
    case "if": walk(s.cond); s.then.forEach((x) => walkExprs(x, out)); s.else.forEach((x) => walkExprs(x, out)); break;
    case "forOf": walk(s.array); s.body.forEach((x) => walkExprs(x, out)); break;
    default: break;
  }
}

test("Director.ts is clean and its class options are accepted", () => {
  assert.deepEqual(inFile(loaded2.diagnostics, "src/Director.ts"), []);
  assert.deepEqual(director.diagnostics, []);
  assert.equal(director.classes.length, 1);
  assert.deepEqual(director.classes[0]!.defaults, { bReplicates: "True", NetUpdateFrequency: "2.000000", TickInterval: "0.100000" });
});

test("HIR of the Director: override, events, docs", () => {
  const cls = director.classes[0]!;
  assert.deepEqual(cls.events.map((e) => [e.name, e.kind]), [["ReceiveTick", "override"], ["Step", "event"], ["Announce", "event"], ["Start", "event"], ["Scan", "event"]]);
  const ov = cls.events[0]!;
  assert.equal(ov.overrideOf, "/Script/FakeEngine.Actor");
  assert.deepEqual(ov.params.map((p) => p.name), ["DeltaSeconds"]);
  assert.equal(ov.doc, "Forwards the engine tick.");
  assert.equal(cls.events[1]!.doc, "Counts the elapsed time down and bumps the counter.");
  assert.equal(cls.events[1]!.overrideOf, undefined);
  assert.equal(cls.events[2]!.doc, undefined);
});

test("HIR of the Director: own calls, arithmetic and comparisons", () => {
  const ev = (n: string) => director.classes[0]!.events.find((e) => e.name === n)!;
  const exprsOf = (n: string): HirExpr[] => {
    const out: HirExpr[] = [];
    ev(n).body.forEach((s) => walkExprs(s, out));
    return out;
  };
  const tick = exprsOf("ReceiveTick").find((e) => e.k === "callOwn");
  assert.ok(tick && tick.k === "callOwn" && tick.name === "Step" && tick.args.length === 1 && tick.args[0]!.pin === "Delta");

  const step = exprsOf("Step");
  assert.deepEqual(step.flatMap((e) => (e.k === "arith" ? [[e.op, e.kind]] : [])), [["-", "real"], ["+", "int"], ["*", "real"]]);
  assert.deepEqual(step.flatMap((e) => (e.k === "cmp" ? [[e.op, e.kind]] : [])), [["<=", "real"], [">=", "int"], [">", "real"]]);
  const own = step.find((e) => e.k === "callOwn");
  assert.ok(own && own.k === "callOwn" && own.name === "Announce" && own.args.map((a) => a.pin).join() === "N,Left");
  assert.ok(exprsOf("Announce").some((e) => e.k === "cmp" && e.op === "<" && e.kind === "int"));
});

test("HIR of the Director: delegate, enum, class, widget, spawn and name literals", () => {
  const ev = (n: string) => director.classes[0]!.events.find((e) => e.name === n)!;
  const collect = (n: string): HirExpr[] => {
    const out: HirExpr[] = [];
    ev(n).body.forEach((s) => walkExprs(s, out));
    return out;
  };
  const start = collect("Start");
  const del = start.find((e) => e.k === "delegateRef");
  assert.ok(del && del.k === "delegateRef" && del.event === "Scan");
  const cw = start.find((e) => e.k === "createWidget");
  assert.ok(cw && cw.k === "createWidget" && cw.cls === "/Game/Fake/WBP_Panel.WBP_Panel_C");
  const en = start.find((e) => e.k === "enumLit");
  assert.ok(en && en.k === "enumLit" && en.text === "Collapsed" && en.enumPath === "/Script/FakeEngine.EFakeVisibility");
  const cr = start.find((e) => e.k === "classRef");
  assert.ok(cr && cr.k === "classRef" && cr.path === "/Game/Fake/WBP_Panel.WBP_Panel_C");

  const scan = collect("Scan");
  const sp = scan.find((e) => e.k === "spawn");
  assert.ok(sp && sp.k === "spawn" && sp.cls === "/Game/Fake/BP_FakePot.BP_FakePot_C" && sp.collision === "AlwaysSpawn" && sp.owner !== undefined && sp.scale === undefined);
  const nm = scan.find((e) => e.k === "nameLit");
  assert.ok(nm && nm.k === "nameLit" && nm.text === "Spawned");
  const idx = scan.find((e) => e.k === "index");
  assert.ok(idx && idx.k === "index" && idx.elem === "object:/Game/Fake/BP_FakePot.BP_FakePot_C");
});

// ---- statements: ternary assignment, counted for loops, array operations ----

const counter = buildHir(loaded2, config, profile, [file2("Counter.ts")]);

test("Counter.ts is clean", () => {
  assert.deepEqual(inFile(loaded2.diagnostics, "src/Counter.ts"), []);
  assert.deepEqual(counter.diagnostics, []);
  assert.equal(counter.classes[0]!.events.length, 2);
});

test("HIR of the Counter: this.X = c ? a : b", () => {
  const pick = counter.classes[0]!.events[0]!;
  assert.equal(pick.name, "Pick");
  assert.equal(pick.doc, "Picks the interval and the starting count from the armed flag.");
  assert.equal(pick.body.length, 2);
  const [first, second] = pick.body;
  assert.ok(first && first.k === "setSelfCond" && first.name === "Elapsed" && first.type === "double");
  assert.deepEqual([first.cond.k, first.a.k, first.b.k], ["getSelf", "getSelf", "getSelf"]);
  assert.ok(first.a.k === "getSelf" && first.a.name === "Fast" && first.b.k === "getSelf" && first.b.name === "Slow");
  assert.ok(second && second.k === "setSelfCond" && second.name === "Count" && second.cond.k === "and" && second.a.k === "lit" && second.b.k === "lit");
});

test("HIR of the Counter: counted for loops and array operations", () => {
  const sweep = counter.classes[0]!.events[1]!;
  const [down, up, find, clear] = sweep.body;
  assert.ok(down && down.k === "forCount" && down.name === "i" && down.step === -1);
  assert.ok(down.init.k === "arith" && down.init.op === "-" && down.init.kind === "int" && down.init.a.k === "length");
  assert.ok(down.cond.k === "cmp" && down.cond.op === ">=" && down.cond.kind === "int" && down.cond.a.k === "local" && down.cond.a.id === down.counter);
  const [pot, check] = down.body;
  assert.ok(pot && pot.k === "const" && pot.init.k === "index" && pot.init.index.k === "local" && pot.init.index.id === down.counter);
  assert.ok(check && check.k === "if");
  assert.deepEqual(check.then.map((s) => (s.k === "arrayOp" ? [s.op, s.array.self, s.array.type, s.index?.k] : s.k)), [
    ["removeAt", "Pots", "array:object:/Game/Fake/BP_FakePot.BP_FakePot_C", "local"],
    ["removeAt", "Names", "array:name", "local"],
  ]);

  assert.ok(up && up.k === "forCount" && up.name === "j" && up.step === 1 && up.init.k === "lit" && up.init.type === "int");
  const push = up.body[0];
  assert.ok(push && push.k === "arrayOp" && push.op === "push" && push.array.self === "Names" && push.value?.k === "nameLit");

  assert.ok(find && find.k === "if" && find.cond.k === "eq" && find.cond.kind === "int");
  assert.ok(find.cond.a.k === "arrayFind" && find.cond.a.elem === "name" && find.cond.a.type === "int" && find.cond.a.array.k === "getSelf" && find.cond.a.value.k === "nameLit");
  assert.ok(find.cond.b.k === "lit" && find.cond.b.value === -1);

  assert.ok(clear && clear.k === "arrayOp" && clear.op === "clear" && clear.array.self === "Names");
  assert.equal(sweep.body.length, 4);
});

test("Phase2Bad.ts: every marked error is reported at its line and column, and nothing else", () => {
  const text = readFileSync(`${phase2Dir}/src/Phase2Bad.ts`, "utf8").split(/\r?\n/);
  const expected: Array<{ line: number; code: string; col: number | undefined }> = [];
  text.forEach((raw, i) => {
    const m = /\/\/ ((?:ABFC\d{4}\s*)+)(?:@(.*))?$/.exec(raw);
    if (!m) return;
    const codes = m[1]!.trim().split(/\s+/);
    const snippet = m[2]?.trimEnd();
    for (const code of codes) expected.push({ line: i + 1, code, col: snippet !== undefined && codes.length === 1 ? raw.indexOf(snippet) + 1 : undefined });
  });
  assert.ok(expected.length >= 8);

  const hir = buildHir(loaded2, config, profile, [file2("Phase2Bad.ts")]);
  const actual = inFile([...loaded2.diagnostics, ...hir.diagnostics], "src/Phase2Bad.ts");
  assert.ok(actual.every((d) => d.severity === "error"));
  const key = (line: number, code: string): string => `${line}:${code}`;
  assert.deepEqual(
    [...new Set(actual.map((d) => key(d.span!.line, d.code)))].sort(),
    [...new Set(expected.map((e) => key(e.line, e.code)))].sort(),
  );
  for (const e of expected) {
    if (e.col === undefined) continue;
    const hits = actual.filter((d) => d.code === e.code && d.span?.line === e.line);
    assert.ok(hits.some((d) => d.span?.col === e.col), `${e.code} on line ${e.line} should start at column ${e.col}, got ${hits.map((d) => d.span?.col).join(",")}`);
  }
});

// ---- Phase 3: kind "widget" ----

const phase3Dir = fileURLToPath(new URL("../../test/fixtures/phase3", import.meta.url));
const loaded3 = loadProgram(phase3Dir);
const file3 = (name: string) => {
  const sf = loaded3.files.classes.find((f) => f.fileName.endsWith(`/${name}`));
  assert.ok(sf, `${name} is a root file`);
  return sf;
};

test("a kind widget class extending a UserWidget stub compiles with the widget class meta", () => {
  const widget = buildHir(loaded3, config, profile, [file3("Widget.ts")]);
  assert.deepEqual(inFile(loaded3.diagnostics, "src/Widget.ts"), []);
  assert.deepEqual(widget.diagnostics, []);
  assert.equal(widget.classes.length, 1);
  const cls = widget.classes[0]!;
  assert.equal(cls.kind, "widget");
  assert.equal(cls.family, "widget");
  assert.equal(cls.parent, "/Script/UMG.UserWidget");
  assert.equal(cls.classPath, "/TestMod/UI/WBP_ExampleInfo.WBP_ExampleInfo_C");
  assert.equal(widget.classMeta[cls.classPath], "/Script/UMG.WidgetBlueprintGeneratedClass");
  const set = cls.events[0]!.body.find((s) => s.k === "setSelf");
  assert.ok(set && set.k === "setSelf" && set.name === "Score");
  const call = cls.events[0]!.body.find((s) => s.k === "expr");
  assert.ok(call && call.k === "expr" && call.e.k === "call");
  assert.equal(call.e.k === "call" && call.e.target?.k, "getSelf");
  assert.equal(call.e.k === "call" && call.e.target?.k === "getSelf" ? call.e.target.name : "", "NameText");
});

test("a @bpWidget readonly field is read like any member: SetText on this.<widget> and on another class's widget", () => {
  const widget = buildHir(loaded3, config, profile, [file3("Widget.ts")]);
  assert.deepEqual(widget.diagnostics, []);
  const label = widget.classes[0]!.events.find((e) => e.name === "Label");
  assert.ok(label, "Label event");
  const calls = label.body.flatMap((s) => (s.k === "expr" && s.e.k === "call" ? [s.e] : []));
  assert.equal(calls.length, 2);
  const [own, other] = calls as [HirExpr & { k: "call" }, HirExpr & { k: "call" }];
  assert.equal(own.name, "SetText");
  assert.equal(own.owner, "/Script/UMG.TextBlock");
  assert.ok(own.target && own.target.k === "getSelf" && own.target.name === "NameText");
  assert.equal(other.name, "SetText");
  assert.ok(other.target && other.target.k === "getOn", "a widget of another class is a member read on that object");
  if (other.target && other.target.k === "getOn") {
    assert.equal(other.target.name, "Caption");
    assert.equal(other.target.owner, "/TestMod/UI/WBP_ExampleRow.WBP_ExampleRow_C");
    assert.equal(other.target.obj.k, "param");
  }
});

test("a template literal where a text is expected is a formatText with escaped braces and unique arg names", () => {
  const widget = buildHir(loaded3, config, profile, [file3("Widget.ts")]);
  assert.deepEqual(widget.diagnostics, []);
  const tag = widget.classes[0]!.events.find((e) => e.name === "Tag");
  assert.ok(tag, "Tag event");
  const stmt = tag.body[0];
  assert.ok(stmt && stmt.k === "expr" && stmt.e.k === "call");
  const arg = stmt.e.k === "call" ? stmt.e.args[0]?.value : undefined;
  assert.ok(arg && arg.k === "formatText");
  if (arg && arg.k === "formatText") {
    assert.equal(arg.type, "text");
    assert.equal(arg.format, "+ {name} `{{hint}`} {hint_2}");
    assert.deepEqual(arg.args.map((a) => a.name), ["name", "hint", "hint_2"]);
  }
});

test("an object literal where a stub struct is expected is a makeStruct; shorthand properties and field types are kept", () => {
  const widget = buildHir(loaded3, config, profile, [file3("Widget.ts")]);
  assert.deepEqual(widget.diagnostics, []);
  const style = widget.classes[0]!.events.find((e) => e.name === "Style");
  assert.ok(style, "Style event");
  const call = style.body.flatMap((s) => (s.k === "expr" && s.e.k === "call" ? [s.e] : []))[0];
  assert.ok(call && call.name === "SetFont");
  const arg = call.args[0]?.value;
  assert.ok(arg && arg.k === "makeStruct");
  if (arg && arg.k === "makeStruct") {
    assert.equal(arg.struct, "/Script/TestCore.ExampleFont");
    assert.equal(arg.type, "struct:/Script/TestCore.ExampleFont");
    assert.deepEqual(arg.fields.map((f) => [f.name, f.value.type]), [["Size", "int"], ["Family", "name"], ["Label", "text"]]);
  }
});

test("a one-substitution template literal is a formatText with the substitution's name", () => {
  const widget = buildHir(loaded3, config, profile, [file3("Widget.ts")]);
  const join = widget.classes[0]!.events.find((e) => e.name === "Join");
  assert.ok(join, "Join event");
  const stmt = join.body[0];
  const arg = stmt && stmt.k === "expr" && stmt.e.k === "call" ? stmt.e.args[0]?.value : undefined;
  assert.ok(arg && arg.k === "formatText");
  if (arg && arg.k === "formatText") {
    assert.equal(arg.format, "+ {name}");
    assert.deepEqual(arg.args.map((a) => [a.name, a.value.type]), [["name", "text"]]);
  }
});

test("a TS @blueprint widget class is a Blueprint type: createWidget, @event calls and `as` resolve like the stub", () => {
  const refs = buildHir(loaded3, config, profile, [file3("TsRefs.ts")]);
  assert.deepEqual(inFile(loaded3.diagnostics, "src/TsRefs.ts"), []);
  assert.deepEqual(refs.diagnostics, []);
  const line = "/TestMod/UI/WBP_ExampleLine.WBP_ExampleLine_C";
  const host = refs.classes.find((c) => c.name === "WBP_ExampleHost");
  assert.ok(host, "WBP_ExampleHost");
  const fill = host.events.find((e) => e.name === "Fill");
  assert.ok(fill, "Fill event");
  const made = fill.body.find((st) => st.k === "const");
  assert.ok(made && made.k === "const" && made.init.k === "createWidget");
  if (made && made.k === "const" && made.init.k === "createWidget") assert.equal(made.init.cls, line);
  assert.equal(refs.classMeta[line], "/Script/UMG.WidgetBlueprintGeneratedClass");
  const call = fill.body.flatMap((st) => (st.k === "expr" && st.e.k === "call" ? [st.e] : []))[0];
  assert.ok(call && call.k === "call");
  assert.equal(call.owner, line);
  assert.equal(call.name, "SetLine");
  assert.notEqual(call.target, null);
  assert.deepEqual(call.args.map((a) => a.pin), ["Label", "bBad"]);

  const retype = host.events.find((e) => e.name === "Retype");
  assert.ok(retype, "Retype event");
  const viaAs = retype.body.flatMap((st) => (st.k === "expr" && st.e.k === "call" ? [st.e] : []))[0];
  assert.ok(viaAs && viaAs.k === "call");
  assert.equal(viaAs.owner, line);
  assert.equal(viaAs.name, "SetLine");
  assert.equal(viaAs.target?.k, "param", "the as expression emits no cast node");
});

test("Phase3Bad.ts: ABFC2060/2061/2064/2065/2066/2099 are reported at their line and column", () => {
  const text = readFileSync(`${phase3Dir}/src/Phase3Bad.ts`, "utf8").split(/\r?\n/);
  const expected: Array<{ line: number; code: string; col: number }> = [];
  text.forEach((raw, i) => {
    const m = /\/\/ (ABFC\d{4})\s+@(.*)$/.exec(raw);
    if (m) expected.push({ line: i + 1, code: m[1]!, col: raw.indexOf(m[2]!.trimEnd()) + 1 });
  });
  assert.equal(expected.length, 12);

  const hir = buildHir(loaded3, config, profile, [file3("Phase3Bad.ts")]);
  const actual = inFile(hir.diagnostics, "src/Phase3Bad.ts");
  const key = (line: number, code: string): string => `${line}:${code}`;
  assert.deepEqual(actual.map((d) => key(d.span!.line, d.code)).sort(), expected.map((e) => key(e.line, e.code)).sort());
  for (const e of expected) {
    const hits = actual.filter((d) => d.code === e.code && d.span?.line === e.line);
    assert.ok(hits.some((d) => d.span?.col === e.col), `${e.code} on line ${e.line} should start at column ${e.col}, got ${hits.map((d) => d.span?.col).join(",")}`);
  }
});

test("compileTests: test.liveHud keeps the checklist and its body; test.liveHud with a bad checklist is ABFC2101", () => {
  const { cases, diagnostics } = compileTests(loaded3, profile);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(cases.map((c) => [c.name, c.liveHud?.checklist.length]), [
    ["HUD shows the example panel", 3],
    ["hidden test next to a live one", undefined],
  ]);
  const live = cases[0]!;
  assert.deepEqual(live.liveHud!.checklist, ["Start Play In Editor", "Look at the example item; the panel appears", "Look away; the panel hides"]);
  assert.equal(live.file, "src/Hud.test.ts");
  assert.equal(live.span.line, 4);
  assert.deepEqual(live.steps.map((s) => s.step["op"]), ["widget", "call", "wait"]);
  assert.equal("liveHud" in cases[1]!, false);
});

const phase4Dir = fileURLToPath(new URL("../../test/fixtures/phase4", import.meta.url));

test("own fields: Name!: T becomes a variable and is usable as this.Name; bad declarations are ABFC2047 at their line", () => {
  const loaded4 = loadProgram(phase4Dir);
  const sf = loaded4.files.classes.find((f) => f.fileName.endsWith("/Fields.ts"));
  assert.ok(sf, "Fields.ts is a root file");
  const hir = buildHir(loaded4, config, profile, [sf]);
  const cls = hir.classes[0]!;
  assert.deepEqual(cls.fields.map((f) => [f.name, f.type]), [
    ["Score", "int"],
    ["Counts", "map:name:int"],
    ["Seen", "set:name"],
    ["Names", "array:name"],
  ]);
  const text = readFileSync(`${phase4Dir}/src/Fields.ts`, "utf8").split(/\r?\n/);
  const expected = text.flatMap((l, i) => (/\/\/ ABFC2043/.test(l) ? [`${i + 1}:ABFC2043`] : /\/\/ ABFC2047/.test(l) ? [`${i + 1}:ABFC2047`] : []));
  assert.deepEqual(hir.diagnostics.map((d) => `${d.span?.line}:${d.code}`), expected);
  const body = cls.events[0]!.body;
  assert.deepEqual(body.map((s) => s.k), ["setSelf", "arrayOp"]);
  const set = body[0]!;
  assert.ok(set.k === "setSelf" && set.name === "Score" && set.type === "int");
  const push = body[1]!;
  assert.ok(push.k === "arrayOp" && push.array.self === "Names" && push.array.type === "array:name");
});

/** Fields and diagnostics of a one-class file `BP_Init` extending the phase2 Actor stub, with the given members. */
function fieldsHir(members: string): { fields: Array<{ name: string; type: string; default?: string }>; diagnostics: Diagnostic[] } {
  const dir = mkdtempSync(join(here78, "fields-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(dir, "src", f));
    writeFileSync(
      join(dir, "src", "Init.ts"),
      `import { blueprint } from "@abfc/runtime";
import type { int, int64, byte, float, double, name } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Relay/BP_Init" })
export class BP_Init extends Actor {
${members}
}
`,
      "utf8",
    );
    const ld = loadProgram(dir);
    const sf = ld.files.classes.find((f) => f.fileName.endsWith("/Init.ts"));
    assert.ok(sf);
    const res = buildHir(ld, config, profile, [sf]);
    return { fields: res.classes.flatMap((c) => c.fields.map((f) => ({ name: f.name, type: f.type, ...(f.default !== undefined ? { default: f.default } : {}) }))), diagnostics: res.diagnostics };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("own field initializers: literals become the variable default; other initializers are ABFC2047", () => {
  const ok = fieldsHir(`  Speed: float = 2.5;
  Neg: float = -1;
  Wide: double = (3);
  Cnt: int = -3;
  Big: int64 = 9007199254740991;
  Low: byte = 255;
  Armed: boolean = true;
  Off: boolean = false;
  Label: string = "hi";
  Tpl: string = \`x\`;
  Tag: name = "N";
  Plain!: int;`);
  assert.deepEqual(ok.diagnostics, []);
  assert.deepEqual(
    ok.fields.map((f) => [f.name, f.type, f.default]),
    [
      ["Speed", "float", "2.5"],
      ["Neg", "float", "-1"],
      ["Wide", "double", "3"],
      ["Cnt", "int", "-3"],
      ["Big", "int64", "9007199254740991"],
      ["Low", "byte", "255"],
      ["Armed", "bool", "true"],
      ["Off", "bool", "false"],
      ["Label", "string", "hi"],
      ["Tpl", "string", "x"],
      ["Tag", "name", "N"],
      ["Plain", "int", undefined],
    ],
  );
  const members = [
    `Cast: name = "N" as name;`,
    `Sum: float = 1 + 1;`,
    `Frac: int = 2.5;`,
    `Over: byte = 256;`,
    `Huge: int = 3000000000;`,
    `Flag: boolean = 1;`,
    `Str: string = 3;`,
    `Bang!: int = 1;`,
    `Bare: int;`,
  ];
  const bad = fieldsHir(members.map((m) => `  ${m}`).join("\n"));
  assert.deepEqual(bad.fields, []);
  assert.ok(bad.diagnostics.every((d) => d.code === "ABFC2047"), JSON.stringify(bad.diagnostics.map((d) => d.code)));
  assert.deepEqual(
    bad.diagnostics.map((d) => /^field (\w+):/.exec(d.message)?.[1]),
    members.map((m) => /^\w+/.exec(m)![0]),
  );
  assert.match(bad.diagnostics[3]!.message, /256 is out of range for byte/);
  assert.match(bad.diagnostics[1]!.message, /must be a literal of the field type/);
});

test("native Map and Set: operations build containerOp/containerQuery", () => {
  const loaded4 = loadProgram(phase4Dir);
  const sf = loaded4.files.classes.find((f) => f.fileName.endsWith("/Maps.ts"));
  assert.ok(sf, "Maps.ts is a root file");
  const hir = buildHir(loaded4, config, profile, [sf]);
  assert.deepEqual(hir.diagnostics, []);
  const [bump, forget] = hir.classes[0]!.events;
  const ops = (b: typeof bump): string[] => b!.body.flatMap((s) => (s.k === "containerOp" ? [`${s.container}.${s.op}`] : []));
  assert.deepEqual(ops(forget), ["map.remove", "set.remove", "map.clear", "set.clear"]);
  const iff = bump!.body[0]!;
  assert.ok(iff.k === "if" && iff.cond.k === "containerQuery" && iff.cond.op === "has" && iff.cond.type === "bool");
  assert.deepEqual(iff.then.map((s) => s.k), ["containerOp"]);
  const add = iff.then[0]!;
  assert.ok(add.k === "containerOp" && add.op === "add" && add.target.type === "map:name:int" && add.value?.k === "arith");
  const size = bump!.body[2]!;
  assert.ok(size.k === "setSelf" && size.value.k === "arith" && size.value.a.k === "containerQuery" && size.value.a.op === "size" && size.value.a.type === "int");
});

test("native Map and Set: unsupported forms are ABFC2040/2042/2043/2099 at their line", () => {
  const loaded4 = loadProgram(phase4Dir);
  const sf = loaded4.files.classes.find((f) => f.fileName.endsWith("/Bad.ts"));
  assert.ok(sf, "Bad.ts is a root file");
  const hir = buildHir(loaded4, config, profile, [sf]);
  const text = readFileSync(`${phase4Dir}/src/Bad.ts`, "utf8").split(/\r?\n/);
  const expected = text.flatMap((l, i) => {
    const m = /\/\/ (ABFC\d{4})/.exec(l);
    return m ? [`${i + 1}:${m[1]}`] : [];
  });
  const got = hir.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.span?.line}:${d.code}`);
  assert.deepEqual([...got].sort(), [...expected].sort());
});

test("@struct: member names, topological order, Break/Make pins use <Field>_<index>_<GUID>; bad structs are ABFC2046 at their line", () => {
  const loaded4 = loadProgram(phase4Dir);
  const sf = loaded4.files.classes.find((f) => f.fileName.endsWith("/Structs.ts"));
  assert.ok(sf, "Structs.ts is a root file");
  const hir = buildHir(loaded4, config, profile, [sf]);
  assert.deepEqual(hir.diagnostics, []);
  assert.deepEqual(hir.structs.map((s) => s.objectPath), ["/TestMod/Phase4/S_Entry.S_Entry", "/TestMod/Phase4/S_Outer.S_Outer"]);
  const entry = hir.structs[0]!;
  assert.equal(udsMemberName(entry.objectPath, "Count", 0), "Count_0_3F70D0D71A9C98101CC97B836AB365CC");
  assert.deepEqual(entry.fields.map((f) => [f.name, f.type, f.memberName]), [
    ["Count", "int", "Count_0_3F70D0D71A9C98101CC97B836AB365CC"],
    ["Label", "name", "Label_1_8BA0182DFAD609FCAD1E4B65D8EBA684"],
    ["Seen", "bool", `Seen_2_${udsGuid(entry.objectPath, "Seen")}`],
  ]);
  assert.equal(hir.structs[1]!.fields[0]!.type, "struct:/TestMod/Phase4/S_Entry.S_Entry");
  const body = hir.classes[0]!.events[0]!.body;
  const set = body[0]!;
  assert.ok(set.k === "setSelf" && set.value.k === "arith" && set.value.a.k === "field" && set.value.a.name === "Count_0_3F70D0D71A9C98101CC97B836AB365CC");
  const lit = body[1]!;
  assert.ok(lit.k === "setSelf" && lit.value.k === "makeStruct");
  assert.deepEqual(lit.value.fields.map((f) => f.name), entry.fields.map((f) => f.memberName));

  const bad = loaded4.files.classes.find((f) => f.fileName.endsWith("/BadStructs.ts"));
  assert.ok(bad);
  const badHir = buildHir(loaded4, config, profile, [bad]);
  const text = readFileSync(`${phase4Dir}/src/BadStructs.ts`, "utf8").split(/\r?\n/);
  const expected = text.flatMap((l, i) => (/\/\/ ABFC2046/.test(l) ? [`${i + 1}:ABFC2046`] : []));
  const got = badHir.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.span?.line}:${d.code}`);
  assert.deepEqual([...got].sort(), [...expected].sort());
  assert.deepEqual(badHir.structs, []);
});

// ---- ABFC2078: @event named like a parent Blueprint member ----

const here78 = fileURLToPath(new URL("./", import.meta.url));

/** Diagnostics and class events of a one-class file `BP_Shadow` extending the phase2 Actor stub (which also has a member without @bpPath: PlainMember). */
function shadowHir(members: string): { diagnostics: Diagnostic[]; events: string[] } {
  const dir = mkdtempSync(join(here78, "shadow-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(dir, "src", f));
    const stub = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
    const stubText = readFileSync(stub, "utf8");
    assert.ok(stubText.includes("K2_DestroyActor(): void;"));
    writeFileSync(stub, stubText.replace("K2_DestroyActor(): void;", "K2_DestroyActor(): void;\n  PlainMember(): void;"), "utf8");
    writeFileSync(
      join(dir, "src", "Shadow.ts"),
      `import { blueprint, event, override } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import type { BP_Shadow_Manual } from "/TestMod/Relay/BP_Shadow";

export interface BP_Shadow extends BP_Shadow_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Shadow" })
export class BP_Shadow extends Actor {
${members}
}
`,
      "utf8",
    );
    const ld = loadProgram(dir);
    const sf = ld.files.classes.find((f) => f.fileName.endsWith("/Shadow.ts"));
    assert.ok(sf);
    const res = buildHir(ld, config, profile, [sf]);
    return { diagnostics: res.diagnostics, events: res.classes.flatMap((c) => c.events.map((e) => e.name)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ABFC2078: @event ReceiveBeginPlay is an error at the decorator, with and without the override keyword, and is not lowered", () => {
  for (const kw of ["", "override "]) {
    const r = shadowHir(`  @event\n  ${kw}ReceiveBeginPlay(): void {}\n`);
    const d = r.diagnostics.filter((x) => x.code === "ABFC2078");
    assert.equal(d.length, 1, `override keyword "${kw}"`);
    assert.equal(d[0]!.severity, "error");
    assert.deepEqual(d[0]!.data, { fix: "useOverride" });
    assert.match(d[0]!.message, /@event ReceiveBeginPlay would create a custom event named like the parent's ReceiveBeginPlay \(\/Script\/FakeEngine\.Actor\)/);
    assert.match(d[0]!.message, /Use @override/);
    assert.equal(d[0]!.span?.line, 9,"reported on the decorator line");
    assert.deepEqual(r.events, []);
  }
});

test("ABFC2078: the override keyword alone is reported, a parent member without @bpPath is not, a new custom event is not", () => {
  // `override` modifier on an @event with a name the parent does not have
  const kw = shadowHir(`  @event\n  override Brand(): void {}\n`);
  assert.equal(kw.diagnostics.filter((d) => d.code === "ABFC2078").length, 1);
  // PlainMember exists in the parent type but carries no @bpPath, and there is no override keyword
  const plain = shadowHir(`  @event\n  PlainMember(): void {}\n`);
  assert.deepEqual(plain.diagnostics.filter((d) => d.code === "ABFC2078"), []);
  assert.deepEqual(plain.events, ["PlainMember"]);
  // a name the parent's declared type does not have (a hand-made _Manual event is such a name): an @event stays allowed
  const fresh = shadowHir(`  @event\n  Brand(): void {}\n`);
  assert.deepEqual(fresh.diagnostics.filter((d) => d.code === "ABFC2078"), []);
  assert.deepEqual(fresh.events, ["Brand"]);
  // @override of the same parent member is fine
  const ov = shadowHir(`  @override\n  override ReceiveBeginPlay(): void {}\n`);
  assert.deepEqual(ov.diagnostics.filter((d) => d.code === "ABFC2078"), []);
});

test("ABFC2083: @override UserConstructionScript is an error at the method name and is not lowered; other overrides are not affected", () => {
  const r = shadowHir(`  @override\n  override UserConstructionScript(): void {}\n`);
  const d = r.diagnostics.filter((x) => x.code === "ABFC2083");
  assert.equal(d.length, 1);
  assert.equal(d[0]!.severity, "error");
  assert.match(d[0]!.message, /UserConstructionScript cannot be overridden/);
  assert.equal(d[0]!.span?.line, 10, "reported on the method name line");
  assert.deepEqual(r.events, []);
  const ok = shadowHir(`  @override\n  override ReceiveBeginPlay(): void {}\n`);
  assert.deepEqual(ok.diagnostics.filter((x) => x.code === "ABFC2083"), []);
  assert.deepEqual(ok.events, ["ReceiveBeginPlay"]);
});
