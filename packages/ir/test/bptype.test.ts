import { test } from "node:test";
import assert from "node:assert/strict";
import { BpTypeError, bpTypeFromPin, parseBpType, pinObjectText, sameBpType, validateIrModule, renderT3D } from "../src/index.js";
import type { IrModule, IrNode, Span } from "../src/index.js";

const span: Span = { file: "a.ts", line: 1, col: 1, endLine: 1, endCol: 2 };

/** Grammar string -> parsed -> pin-like record -> grammar string. */
function roundTrip(t: string): string {
  const p = parseBpType(t);
  const obj = p.path;
  return bpTypeFromPin({ category: p.cat, subCategory: p.sub, subCategoryObject: obj, container: p.container });
}

test("grammar round trip for every simple type", () => {
  for (const t of ["bool", "byte", "int", "int64", "name", "string", "text", "float", "real"]) {
    assert.equal(roundTrip(t), t, t);
  }
  assert.equal(roundTrip("double"), "real");
});

test("grammar round trip for path types and arrays", () => {
  for (const t of [
    "object:/Script/Engine.Actor",
    "class:/Script/Engine.Actor",
    "softobject:/Script/Engine.Actor",
    "softclass:/Script/Engine.Actor",
    "interface:/Script/Fake.Iface",
    "struct:/Script/Fake.Pair",
    "enum:/Script/Fake.Kind",
    "array:object:/Script/Engine.Actor",
    "array:name",
    "array:struct:/Script/Fake.Pair",
    "array:enum:/Script/Fake.Kind",
  ]) {
    assert.equal(roundTrip(t), t, t);
  }
});

test("parseBpType fields", () => {
  assert.deepEqual(parseBpType("real"), { cat: "real", sub: "double", path: null, container: "None" });
  assert.deepEqual(parseBpType("float"), { cat: "real", sub: "float", path: null, container: "None" });
  assert.deepEqual(parseBpType("enum:/Script/Fake.Kind"), { cat: "byte", sub: "", path: "/Script/Fake.Kind", container: "None" });
  assert.deepEqual(parseBpType("array:object:/Script/Engine.Actor"), {
    cat: "object", sub: "", path: "/Script/Engine.Actor", container: "Array",
  });
});

test("parseBpType refusals", () => {
  for (const t of ["", "  ", "array:array:int", "object", "struct:", "wibble", "object: "]) {
    assert.throws(() => parseBpType(t), BpTypeError, JSON.stringify(t));
  }
  assert.throws(() => bpTypeFromPin({ category: "delegate", subCategory: "", subCategoryObject: null, container: "None" }), BpTypeError);
  assert.throws(() => bpTypeFromPin({ category: "int", subCategory: "", subCategoryObject: null, container: "Map" }), BpTypeError);
});

test("map and set grammar", () => {
  assert.deepEqual(parseBpType("map:name:int"), {
    cat: "name", sub: "", path: null, container: "Map", value: { cat: "int", sub: "", path: null, container: "None" },
  });
  assert.deepEqual(parseBpType("map:string:struct:/Script/Fake.Pair"), {
    cat: "string", sub: "", path: null, container: "Map",
    value: { cat: "struct", sub: "", path: "/Script/Fake.Pair", container: "None" },
  });
  assert.deepEqual(parseBpType("set:int64"), { cat: "int64", sub: "", path: null, container: "Set" });
  assert.equal("value" in parseBpType("set:name"), false);
  assert.equal("value" in parseBpType("array:name"), false);
});

test("map and set refusals", () => {
  for (const t of [
    "map:", "map:name", "map:name:", "map:name:array:int", "map:name:map:name:int", "map:name:set:int", "map:name:exec",
    "map:bool:int", "map:text:int", "map:float:int", "map:object:/Script/Engine.Actor:int", "map:wibble:int", "map:name:wibble",
    "set:", "set:bool", "set:float", "set:array:int", "set:exec", "set:object:/Script/Engine.Actor", "set:set:int", "array:map:name:int", "array:set:int",
  ]) {
    assert.throws(() => parseBpType(t), BpTypeError, JSON.stringify(t));
  }
});

test("map and set round trip through pins", () => {
  const toPin = (t: string) => {
    const p = parseBpType(t);
    return bpTypeFromPin({
      category: p.cat, subCategory: p.sub, subCategoryObject: p.path, container: p.container,
      valueType: p.value ? { category: p.value.cat, subCategory: p.value.sub, subCategoryObject: p.value.path } : null,
    });
  };
  for (const t of [
    "map:name:int", "map:int:name", "map:string:bool", "map:int64:float", "map:byte:text", "map:name:object:/Script/Engine.Actor",
    "map:name:struct:/Script/Fake.Pair", "map:name:enum:/Script/Fake.Kind", "set:name", "set:int", "set:string", "set:byte", "set:int64",
  ]) {
    assert.equal(toPin(t), t, t);
  }
  assert.equal(toPin("map:name:double"), "map:name:real");
  // maps need a value type; unsupported keys and values are refused
  assert.throws(() => bpTypeFromPin({ category: "name", subCategory: "", subCategoryObject: null, container: "Map" }), BpTypeError);
  assert.throws(
    () => bpTypeFromPin({ category: "bool", subCategory: "", subCategoryObject: null, container: "Set" }),
    BpTypeError,
  );
  assert.throws(
    () => bpTypeFromPin({
      category: "name", subCategory: "", subCategoryObject: null, container: "Map",
      valueType: { category: "delegate", subCategory: "", subCategoryObject: null },
    }),
    BpTypeError,
  );
  assert.throws(() => bpTypeFromPin({ category: "int", subCategory: "", subCategoryObject: null, container: "Wibble" }), BpTypeError);
});

test("bpTypeFromPin maps real/float and byte", () => {
  const pin = (category: string, subCategory = "", subCategoryObject: string | null = null, container = "None") =>
    ({ category, subCategory, subCategoryObject, container });
  assert.equal(bpTypeFromPin(pin("real", "float")), "float");
  assert.equal(bpTypeFromPin(pin("real", "double")), "real");
  assert.equal(bpTypeFromPin(pin("byte")), "byte");
  assert.equal(bpTypeFromPin(pin("byte", "", "/Script/Fake.Kind", "Array")), "array:enum:/Script/Fake.Kind");
});

test("pinObjectText", () => {
  const widgetClass = "/Fake/Mod/WBP_Thing.WBP_Thing_C";
  const meta = { [widgetClass]: "/Script/UMG.WidgetBlueprintGeneratedClass" };
  assert.equal(pinObjectText("object", "/Script/Engine.Actor", meta), "/Script/CoreUObject.Class'/Script/Engine.Actor'");
  assert.equal(pinObjectText("object", widgetClass, meta), `/Script/UMG.WidgetBlueprintGeneratedClass'${widgetClass}'`);
  assert.equal(pinObjectText("class", "/Fake/Mod/BP_Plain.BP_Plain_C", meta), "/Script/Engine.BlueprintGeneratedClass'/Fake/Mod/BP_Plain.BP_Plain_C'");
  assert.equal(pinObjectText("struct", "/Script/Fake.Pair", meta), "/Script/CoreUObject.ScriptStruct'/Script/Fake.Pair'");
  assert.equal(pinObjectText("struct", "/Fake/Mod/S_Pair.S_Pair", meta), "/Script/Engine.UserDefinedStruct'/Fake/Mod/S_Pair.S_Pair'");
  assert.equal(pinObjectText("enum", "/Script/Fake.Kind", meta), "/Script/CoreUObject.Enum'/Script/Fake.Kind'");
  assert.equal(pinObjectText("enum", "/Fake/Mod/E_Kind.E_Kind", meta), "/Script/Engine.UserDefinedEnum'/Fake/Mod/E_Kind.E_Kind'");
});

function node(id: string, extra: Partial<IrNode> = {}): IrNode {
  return { id, t3d: { class: "/Script/Fake.Node", props: ["Foo=1"] }, pos: [0, 0], origin: span, ...extra };
}

test("validateIrModule", () => {
  const unit = (nodes: IrNode[], wires: Array<[`${string}.${string}`, `${string}.${string}`]>) => ({
    id: "event:Go", kind: "event" as const, name: "Go", graph: "EventGraph",
    signature: { inputs: [], outputs: [] }, locals: [], nodes, wires, origin: span, hash: "",
  });
  const mod = (u: ReturnType<typeof unit>, path = "/Mod/BP_A"): IrModule => ({
    irVersion: 1, profile: "p", mod: "Mod", classMeta: {},
    assets: [{ path, variables: [], units: [u] }],
  });
  assert.deepEqual(validateIrModule(mod(unit([node("a1"), node("b2")], [["a1.then", "b2.execute"], ["entry.then", "a1.execute"]]))), []);
  assert.equal(validateIrModule(mod(unit([node("a1")], [["a1.then", "zz.execute"]]))).length, 1);
  assert.equal(validateIrModule(mod(unit([node("a1"), node("a1")], []))).length, 1);
  assert.equal(validateIrModule(mod(unit([node("entry")], []))).length, 1);
  assert.equal(validateIrModule(mod(unit([node("1bad")], []))).length, 1);
  assert.equal(validateIrModule(mod(unit([node("a1")], []), "/Other/BP_A")).length, 1);
  assert.equal(validateIrModule(mod(unit([node("a1", { pinTypes: { Object: "map:name:array:int" } })], []))).length, 1);
  assert.equal(validateIrModule(mod(unit([node("a1", { pinTypes: { Object: "set:bool" } })], []))).length, 1);
  assert.deepEqual(validateIrModule(mod(unit([node("a1", { pinTypes: { TargetMap: "map:name:int", TargetSet: "set:name" } })], []))), []);
  assert.deepEqual(validateIrModule(mod(unit([node("a1", { pinTypes: { Object: "object:/Script/Engine.Actor" } })], []))), []);
});

test("renderT3D", () => {
  const text = renderT3D(node("a1", { pos: [10.4, -20.6] }), "Fake_Node_0", "0123456789ABCDEF0123456789ABCDEF");
  assert.equal(
    text,
    [
      'Begin Object Class=/Script/Fake.Node Name="Fake_Node_0"',
      "   Foo=1",
      "   NodePosX=10",
      "   NodePosY=-21",
      "   NodeGuid=0123456789ABCDEF0123456789ABCDEF",
      "End Object",
    ].join("\n"),
  );
  assert.match(renderT3D(node("a1"), "N"), /NodeGuid=[0-9A-F]{32}\nEnd Object$/);
});

test("sameBpType: real and double are one type, float is not, containers and paths must match", () => {
  assert.equal(sameBpType("array:real", "array:double"), true);
  assert.equal(sameBpType("double", "real"), true);
  assert.equal(sameBpType("Int", "int"), true);
  assert.equal(sameBpType("float", "double"), false);
  assert.equal(sameBpType("array:double", "double"), false);
  assert.equal(sameBpType("object:/Game/A.A_C", "object:/Game/B.B_C"), false);
  assert.equal(sameBpType("not a type!", "int"), false);
});
