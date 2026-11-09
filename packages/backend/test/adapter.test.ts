import { test } from "node:test";
import assert from "node:assert/strict";
import { AbfcError } from "@abfc/env";
import type { AssetPlan, IrNode, IrUnit } from "@abfc/ir";
import { applyPlan, effectivePinTypes, renderMainSpec, renderTagSpec, specNodeId } from "../src/index.js";
import type { BpNodeSpec } from "../src/index.js";
import { FakeBackend, caps, ir, nodeIdsFor, planOf, profile, realName, result } from "./fixture.js";

const plan = planOf(ir);
const asset = plan.assets[0]!;
const unit = asset.units[0]!.unit;

const withPinTypes = (nodes: BpNodeSpec[]): BpNodeSpec[] => nodes.filter((n) => n.pin_types !== undefined);

function mainNodes(pin: boolean, cast: boolean): BpNodeSpec[] {
  return renderMainSpec(asset, caps(pin, cast), profile).graphs![0]!.add;
}

test("the fixture has the expected shape", () => {
  assert.equal(unit.nodes.length, 52);
  assert.equal(unit.wires.length, 74);
});

test("no pin_types when the backend lacks native pin types", () => {
  assert.equal(withPinTypes(mainNodes(false, false)).length, 0);
  assert.equal(withPinTypes(mainNodes(false, true)).length, 0);
});

test("pin types without cast_object_pin: on the 5 wildcard nodes, casts carry Object", () => {
  const nodes = withPinTypes(mainNodes(true, false));
  assert.equal(nodes.length, 5);
  const casts = nodes.filter((n) => n.k === "cast");
  assert.equal(casts.length, 2);
  for (const c of casts) assert.deepEqual(c.pin_types, { Object: profile.castObjectPinType });
});

test("pin types with cast_object_pin: only the array length nodes and the array item", () => {
  const nodes = withPinTypes(mainNodes(true, true));
  assert.equal(nodes.length, 3);
  assert.equal(nodes.filter((n) => n.k === "cast").length, 0);
  assert.equal(nodes.filter((n) => Object.keys(n.pin_types!).join() === "TargetArray").length, 2);
  assert.equal(nodes.filter((n) => Object.keys(n.pin_types!).join() === "Array,Output").length, 1);
});

test("effectivePinTypes allows map and set types only with the matching container capability", () => {
  const base: IrNode = { id: "x0", t3d: { class: profile.nodeClasses.callFunction, props: [] }, pos: [0, 0], origin: unit.origin };
  const withContainers = (map: boolean, set: boolean) => {
    const c = caps(true, true);
    return { ...c, containerTypes: { ...c.containerTypes, map, set } };
  };
  const pinTypes = { TargetMap: "map:name:int", Key: "name", Value: "int" };
  const setTypes = { TargetSet: "set:name", NewItem: "name" };
  assert.deepEqual(effectivePinTypes({ ...base, pinTypes }, withContainers(true, false), profile), pinTypes);
  assert.deepEqual(effectivePinTypes({ ...base, pinTypes: setTypes }, withContainers(false, true), profile), setTypes);
  assert.throws(() => effectivePinTypes({ ...base, pinTypes }, withContainers(false, true), profile), AbfcError);
  assert.throws(() => effectivePinTypes({ ...base, pinTypes: setTypes }, withContainers(true, false), profile), AbfcError);
  // exec stays refused, even inside a map value
  assert.throws(() => effectivePinTypes({ ...base, pinTypes: { A: "map:name:exec" } }, withContainers(true, true), profile), AbfcError);
});

test("effectivePinTypes refuses what the backend refuses", () => {
  const base: IrNode = { id: "x0", t3d: { class: profile.nodeClasses.callFunction, props: [] }, pos: [0, 0], origin: unit.origin };
  const c = caps(true, true);
  const code = (n: IrNode): string | undefined => {
    try {
      effectivePinTypes(n, c, profile);
      return undefined;
    } catch (e) {
      assert.ok(e instanceof AbfcError);
      assert.equal(e.exitCode, 2);
      return e.diagnostic.code;
    }
  };
  assert.equal(code({ ...base, pinTypes: { A: "exec" } }), "ABFC4010");
  assert.equal(code({ ...base, pinTypes: { A: "array:exec" } }), "ABFC4010");
  assert.equal(code({ ...base, pinTypes: { A: "map:name:int" } }), "ABFC4010");
  assert.equal(code({ ...base, pinTypes: { A: "set:int" } }), "ABFC4010");
  assert.equal(code({ ...base, sem: { k: "self" }, pinTypes: { A: "int" } }), "ABFC4010");
  assert.equal(code({ ...base, pinTypes: { A: "int" } }), undefined);
  assert.deepEqual(effectivePinTypes({ ...base, pinTypes: { A: "array:int" } }, c, profile), { A: "array:int" });
});

test("a std_macro node renders its name and wildcard pin types; a raw macro instance still throws", () => {
  const macro: IrNode = {
    id: "loop0",
    t3d: { class: "/Script/BlueprintGraph.K2Node_MacroInstance", props: ["MacroGraphReference=(MacroGraph=\"x\")"] },
    sem: { k: "std_macro", name: "ForEachLoop" },
    pinTypes: { Array: "array:name", "Array Element": "name" },
    pos: [0, 0],
    origin: unit.origin,
  };
  const c = caps(true, true);
  assert.deepEqual(effectivePinTypes(macro, c, profile), { Array: "array:name", "Array Element": "name" });
  const withMacro = {
    ...asset,
    units: asset.units.map((pu, i) => i !== 0 ? pu : { ...pu, unit: { ...pu.unit, nodes: [...pu.unit.nodes, macro] } }),
  };
  const spec = renderMainSpec(withMacro, c, profile).graphs![0]!.add.find((n) => n.k === "std_macro");
  assert.ok(spec);
  assert.equal(spec.name, "ForEachLoop");
  assert.deepEqual(spec.pin_types, { Array: "array:name", "Array Element": "name" });
  assert.equal("class" in spec, false);
  const { sem: _sem, ...raw } = macro;
  assert.throws(() => effectivePinTypes(raw, c, profile), AbfcError);
});

test("event meta is emitted only with the event_meta capability", () => {
  const meta = { tooltip: "Does it.", category: "Cat" };
  const metaAsset = {
    ...asset,
    units: asset.units.map((pu, i) => i !== 0 ? pu : {
      ...pu,
      unit: { ...pu.unit, nodes: pu.unit.nodes.map((n) => n.sem?.k === "event" ? { ...n, sem: { ...n.sem, meta } } : n) },
    }),
  };
  const events = (c: ReturnType<typeof caps>): BpNodeSpec[] =>
    renderMainSpec(metaAsset, c, profile).graphs![0]!.add.filter((n) => n.k === "event");
  assert.equal(events(caps(true, true)).length, 1);
  assert.equal(events(caps(true, true))[0]!.meta, undefined);
  assert.deepEqual(events({ ...caps(true, true), eventMeta: true })[0]!.meta, meta);
  // the spec holds a copy, and an undocumented event never gets the key
  assert.equal(renderMainSpec(asset, { ...caps(true, true), eventMeta: true }, profile).graphs![0]!.add.some((n) => "meta" in n), false);
});

test("variables carry flags 8196", () => {
  const spec = renderMainSpec(asset, caps(true, true), profile);
  assert.deepEqual(spec.variables!.map((v) => v.name), ["abfc_UpdateTarget_t0", "abfc_UpdateTarget_i0"]);
  for (const v of spec.variables!) assert.equal(v.flags, 8196);
});

test("ids are unique and dot-free, wires use them, positions are offset by the origin", () => {
  const spec = renderMainSpec(asset, caps(true, true), profile);
  assert.equal(spec.graphs!.length, 1);
  const g = spec.graphs![0]!;
  assert.equal(g.graph, "EventGraph");
  assert.deepEqual(g.remove, []);
  const ids = g.add.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(!id.includes("."), id);
  assert.ok(ids.includes("UpdateTarget_cast0"));
  assert.equal(specNodeId(unit, "cast0"), "UpdateTarget_cast0");
  assert.equal(g.wires!.length, unit.wires.length);
  for (const [from, to] of g.wires!) {
    for (const end of [from, to]) assert.ok(ids.includes(end.slice(0, end.indexOf("."))), end);
  }
  unit.nodes.forEach((n, i) => assert.deepEqual(g.add[i]!.pos, [100 + n.pos[0], 200 + n.pos[1]], n.id));
});

test("sem nodes use native kinds, others are raw nodes", () => {
  const nodes = mainNodes(true, true);
  const cast = nodes.find((n) => n.k === "cast")!;
  assert.equal(typeof cast.target, "string");
  const raw = nodes.filter((n) => n.k === "node");
  for (const r of raw) {
    assert.equal(typeof r.class, "string");
    assert.ok(Array.isArray(r.props));
  }
  assert.ok(nodes.some((n) => n.k === "event" && n.name === "UpdateTarget"));
});

test("removeNodes are passed through to the graph", () => {
  const p = planOf(ir);
  p.assets[0]!.units[0]!.removeNodes = ["K2Node_A", "K2Node_B"];
  assert.deepEqual(renderMainSpec(p.assets[0]!, caps(true, true), profile).graphs![0]!.remove, ["K2Node_A", "K2Node_B"]);
});

test("a cross-wire to an event that is neither in the plan nor recorded in the manifest is ABFC4015 (exit 2)", () => {
  const a = planOf(ir).assets[0]!;
  const first = a.units[0]!;
  const broken = {
    ...a,
    units: [{ ...first, unit: { ...first.unit, crossWires: [{ toUnit: "event:Missing", from: "n1.then", to: "n2.execute" }] } }],
  };
  assert.throws(
    () => renderMainSpec(broken, caps(true, true), profile),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC4015" && e.exitCode === 2,
  );
});

test("tag spec: one comment box per unit, above and left of the origin", () => {
  const spec = renderTagSpec(asset, asset.units, profile);
  assert.equal(spec.asset, asset.asset);
  const add = spec.graphs![0]!.add;
  assert.equal(add.length, 1);
  assert.equal(add[0]!.id, "cmt_UpdateTarget");
  assert.equal(add[0]!.class, profile.nodeClasses.comment);
  assert.deepEqual(add[0]!.pos, [50, 80]);
  assert.match(add[0]!.props![0]!, /^NodeComment="abfc:owned unit=event:UpdateTarget src=.+ ir=[0-9a-f]{8} - generated by abfc, edit the \.ts file"$/);
  assert.match(add[0]!.props![1]!, /^NodeWidth=\d+$/);
  assert.match(add[0]!.props![2]!, /^NodeHeight=\d+$/);
});

test("applyPlan on the native route: one main call, then the tag pass; node ids and tag names are mapped", async () => {
  const c = caps(true, true);
  const ids = nodeIdsFor(plan, c);
  const backend = new FakeBackend((call) =>
    call.label === "main"
      ? result({ assets: [{ asset: asset.asset, node_ids: ids }] })
      : result({ assets: [{ asset: asset.asset, node_ids: { "graph:0": { cmt_UpdateTarget: "EdGraphNode_Comment_0" } } }] }),
  );
  const timings: string[] = [];
  const out = await applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: (s) => timings.push(s) });
  assert.equal(out.ok, true);
  assert.deepEqual(backend.calls.map((x) => x.label), ["main", "tags"]);
  assert.equal(backend.calls[0]!.specs.length, 1);
  assert.deepEqual(timings, ["apply.main", "apply.tags"]);
  const a = out.perAsset[0]!;
  assert.equal(a.nodeIds["event:UpdateTarget/cast0"], realName("UpdateTarget_cast0"));
  assert.equal(Object.keys(a.nodeIds).length, unit.nodes.length);
  assert.equal(a.tagName, "EdGraphNode_Comment_0");
  assert.deepEqual(a.tagNames, { "event:UpdateTarget": "EdGraphNode_Comment_0" });
  assert.equal(a.tagWarning, undefined);
});

test("applyPlan: a failing tag pass is a warning, a failing main pass skips the tags", async () => {
  const c = caps(true, true);
  const ids = nodeIdsFor(plan, c);
  const tagFails = new FakeBackend((call) =>
    call.label === "main" ? result({ assets: [{ asset: asset.asset, node_ids: ids }] }) : result({ ok: false, error: "nope" }),
  );
  const a = await applyPlan(tagFails, plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(a.ok, true);
  assert.equal(a.perAsset[0]!.tagWarning?.code, "ABFC5101");
  assert.equal(a.perAsset[0]!.tagName, null);

  const mainFails = new FakeBackend(() =>
    result({ ok: false, rolledBack: true, compile: { errors: [{ asset: asset.asset, message: "Bad pin", node: realName("UpdateTarget_br0") }], warnings: [] } }),
  );
  const b = await applyPlan(mainFails, plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(b.ok, false);
  assert.deepEqual(mainFails.calls.map((x) => x.label), ["main"]);
  assert.equal(b.perAsset[0]!.compile.length, 1);
  assert.equal(b.perAsset[0]!.compile[0]!.message, "Bad pin");
});

test("applyPlan with no assets does nothing", async () => {
  const backend = new FakeBackend(() => result());
  const out = await applyPlan(backend, { mod: "TestMod", assets: [] }, caps(true, true), profile, { cacheDir: "cache", record: () => {} });
  assert.deepEqual(out, { ok: true, perAsset: [] });
  assert.equal(backend.calls.length, 0);
});

test("removeUnits: their nodes join the graph's remove list (a graph entry is created when only a removal touches it)", () => {
  const p = planOf(ir);
  const a = p.assets[0]!;
  a.units[0]!.removeNodes = ["K2Node_A"];
  a.removeUnits = [
    { id: "event:Old", graph: a.units[0]!.unit.graph, nodes: ["K2Node_A", "K2Node_B", "EdGraphNode_Comment_3"] },
    { id: "function:Gone", graph: "Gone", nodes: ["K2Node_F"] },
  ];
  const graphs = renderMainSpec(a, caps(true, true), profile).graphs!;
  assert.deepEqual(graphs[0]!.remove, ["K2Node_A", "K2Node_B", "EdGraphNode_Comment_3"]);
  const gone = graphs.find((g) => g.graph === "Gone")!;
  assert.deepEqual(gone, { graph: "Gone", remove: ["K2Node_F"], add: [], wires: [] });
});

test("applyPlan: an asset with only removals is applied (no units, so no tag pass); a spec error stands in when no real compile error is left", async () => {
  const c = caps(true, true);
  const only = { mod: "TestMod", assets: [{ ...planOf(ir).assets[0]!, units: [], variables: [], removeUnits: [{ id: "event:Old", graph: "EventGraph", nodes: ["K2Node_A", "EdGraphNode_Comment_3"] }] }] };
  const ok = new FakeBackend(() => result({ assets: [{ asset: only.assets[0]!.asset, node_ids: {} }] }));
  const out = await applyPlan(ok, only, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(out.ok, true);
  assert.deepEqual(ok.calls.map((x) => x.label), ["main"], "no tag pass for an asset without units");
  assert.deepEqual(ok.calls[0]!.specs[0]!.graphs[0].remove, ["K2Node_A", "EdGraphNode_Comment_3"]);

  const failing = new FakeBackend(() =>
    result({
      ok: false,
      rolledBack: true,
      compile: { errors: [{ asset: "/TestMod/_McpTmp/BP_BkScratch1", message: "scratch" }, { asset: only.assets[0]!.asset, message: "real" }], warnings: [] },
      error: "[spec:Caller_call1] no pin 'execute'",
    }),
  );
  const bad = await applyPlan(failing, only, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.perAsset[0]!.compile.map((m) => m.message), ["real"], "the apply error is only a summary next to real compile errors");

  const specOnly = new FakeBackend(() =>
    result({
      ok: false,
      rolledBack: true,
      compile: { errors: [{ asset: "/TestMod/_McpTmp/BP_BkScratch1", message: "scratch" }], warnings: [] },
      error: "[spec:Caller_call1] no pin 'execute'",
    }),
  );
  const spec = await applyPlan(specOnly, only, c, profile, { cacheDir: "cache", record: () => {} });
  assert.deepEqual(spec.perAsset[0]!.compile.map((m) => m.message), ["[spec:Caller_call1] no pin 'execute'"], "scratch messages are dropped, the apply error stands in");
});

test("removeTags: orphan tag comments join the graph's remove list; an asset with only orphans is applied without a tag pass", async () => {
  const c = caps(true, true);
  const a = planOf(ir).assets[0]!;
  a.units[0]!.removeNodes = ["K2Node_A", "EdGraphNode_Comment_1"];
  a.removeTags = [{ graph: a.units[0]!.unit.graph, nodes: ["EdGraphNode_Comment_1", "EdGraphNode_Comment_2"] }, { graph: "Other", nodes: ["EdGraphNode_Comment_9"] }];
  const graphs = renderMainSpec(a, c, profile).graphs!;
  assert.deepEqual(graphs[0]!.remove, ["K2Node_A", "EdGraphNode_Comment_1", "EdGraphNode_Comment_2"]);
  assert.deepEqual(graphs.find((g) => g.graph === "Other"), { graph: "Other", remove: ["EdGraphNode_Comment_9"], add: [], wires: [] });

  const only = { mod: "TestMod", assets: [{ ...planOf(ir).assets[0]!, units: [], variables: [], removeTags: [{ graph: "EventGraph", nodes: ["EdGraphNode_Comment_2"] }] }] };
  const ok = new FakeBackend(() => result({ assets: [{ asset: only.assets[0]!.asset, node_ids: {} }] }));
  const out = await applyPlan(ok, only, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(out.ok, true);
  assert.deepEqual(ok.calls.map((x) => x.label), ["main"]);
  assert.deepEqual(ok.calls[0]!.specs[0]!.graphs[0].remove, ["EdGraphNode_Comment_2"]);
});

test("a plan item for a missing asset puts create (with if_missing) in its main spec; others have none", () => {
  assert.equal(renderMainSpec(asset, caps(true, true), profile).create, undefined);
  const spec = renderMainSpec({ ...asset, create: { class: "WidgetBlueprint", parent: "/Script/UMG.UserWidget" } }, caps(true, true), profile);
  assert.deepEqual(spec.create, { class: "WidgetBlueprint", parent: "/Script/UMG.UserWidget", if_missing: true });
});

test("a struct plan item renders create UserDefinedStruct plus struct_fields (friendly and guid from the member name)", () => {
  const G = "0123456789ABCDEF0123456789ABCDEF";
  const item = {
    asset: "/TestMod/S_Entry",
    struct: { fields: [{ name: `Count_0_${G}`, type: "int", flags: [], origin: { file: "a.ts", line: 1, col: 1, endLine: 1, endCol: 2 } }] },
    graphNodes: {},
    variables: [],
    units: [],
    classMeta: {},
  };
  const spec = renderMainSpec(item, caps(true, true), profile);
  assert.deepEqual(spec, {
    asset: "/TestMod/S_Entry",
    create: { class: "UserDefinedStruct", if_missing: true },
    struct_fields: [{ name: `Count_0_${G}`, friendly: "Count", guid: G, type: "int" }],
  });
});

// ---- function graphs (bp_apply feature function_graphs) ----

const fnNode: IrNode = { id: "call0", t3d: { class: profile.nodeClasses.callFunction, props: [] }, pos: [0, 0], origin: unit.origin };
const { crossWires: _noCross, ...unitNoCross } = unit;
const fnUnit = (name: string, wires: IrUnit["wires"]): AssetPlan["units"][number]["unit"] => ({
  ...unitNoCross,
  id: `function:${name}`,
  kind: "function",
  name,
  graph: name,
  signature: { inputs: [{ name: "amount", type: "int" }], outputs: [{ name: "ReturnValue", type: "int" }], access: "private" },
  nodes: [fnNode],
  wires,
});
const fnAsset = (over: Partial<AssetPlan>): AssetPlan => ({ ...asset, units: [], variables: [], ...over });

test("a function unit: the entry/result wire ends keep the backend's reserved ids, the spec carries functions with access", () => {
  const u = fnUnit("runTest", [["entry.then", "call0.execute"], ["entry.amount", "call0.A"], ["call0.then", "result.execute"], ["call0.ReturnValue", "result.ReturnValue"]]);
  const a = fnAsset({
    units: [{ unit: u, removeNodes: [], origin: [0, 250] }],
    functions: [{ name: "runTest", inputs: u.signature.inputs, outputs: u.signature.outputs, access: "private" }],
  });
  const spec = renderMainSpec(a, caps(true, true), profile);
  assert.deepEqual(spec.functions, [{ name: "runTest", inputs: [{ name: "amount", type: "int" }], outputs: [{ name: "ReturnValue", type: "int" }], access: "private" }]);
  assert.equal(spec.remove_functions, undefined);
  const g = spec.graphs!.find((x) => x.graph === "runTest")!;
  assert.deepEqual(g.remove, []);
  assert.deepEqual(g.wires, [
    ["entry.then", "runTest_call0.execute"],
    ["entry.amount", "runTest_call0.A"],
    ["runTest_call0.then", "result.execute"],
    ["runTest_call0.ReturnValue", "result.ReturnValue"],
  ]);
});

test("a replaced function graph is listed in remove_functions and functions; its graph edit removes nothing", () => {
  const u = fnUnit("runTest", [["entry.then", "call0.execute"]]);
  const a = fnAsset({
    units: [{ unit: u, removeNodes: [], origin: [0, 250] }],
    functions: [{ name: "runTest", inputs: [], outputs: [], access: "public" }],
    removeFunctions: ["runTest"],
  });
  const spec = renderMainSpec(a, caps(true, true), profile);
  assert.deepEqual(spec.remove_functions, ["runTest"]);
  assert.deepEqual(spec.functions!.map((f) => f.name), ["runTest"]);
  assert.deepEqual(spec.graphs!.find((x) => x.graph === "runTest")!.remove, []);
});

test("a removed function graph has no graph entry; a recreated empty one has none either", () => {
  const gone = fnAsset({ removeUnits: [{ id: "function:runTest", graph: "runTest", nodes: [] }], removeFunctions: ["runTest"] });
  const spec = renderMainSpec(gone, caps(true, true), profile);
  assert.deepEqual(spec.remove_functions, ["runTest"]);
  assert.equal(spec.functions, undefined);
  assert.deepEqual(spec.graphs, []);

  const empty = { ...fnUnit("noop", []), nodes: [] };
  const made = fnAsset({
    units: [{ unit: empty, removeNodes: [], origin: [0, 250] }],
    functions: [{ name: "noop", inputs: [], outputs: [], access: "public" }],
    removeFunctions: ["noop"],
  });
  const spec2 = renderMainSpec(made, caps(true, true), profile);
  assert.deepEqual(spec2.functions!.map((f) => f.name), ["noop"]);
  assert.deepEqual(spec2.graphs, []);
});

test("interfaces: an interface function graph goes to its interface entry, not to functions; components carry ensure and values", () => {
  const IF = "/Game/Fake/I_Use.I_Use_C";
  const a = fnAsset({
    interfaces: [IF],
    functions: [
      { name: "CanUse", inputs: [], outputs: [{ name: "ReturnValue", type: "bool" }], access: "public", override: IF },
      { name: "Own", inputs: [], outputs: [], access: "public" },
    ],
    components: [{ name: "Lid", class: "/Script/Engine.StaticMeshComponent", attachTo: "Mesh", props: { bHiddenInGame: { k: "bool", v: true } }, origin: unit.origin }],
  });
  const spec = renderMainSpec(a, caps(true, true), profile);
  assert.deepEqual(spec.functions?.map((f) => f.name), ["Own"]);
  assert.deepEqual(spec.interfaces, [{ class: IF, functions: [{ name: "CanUse", inputs: [], outputs: [{ name: "ReturnValue", type: "bool" }] }] }]);
  assert.deepEqual(spec.components, [{ name: "Lid", class: "/Script/Engine.StaticMeshComponent", parent: "Mesh", ensure: true, values: { bHiddenInGame: { k: "bool", v: true } } }]);
});
