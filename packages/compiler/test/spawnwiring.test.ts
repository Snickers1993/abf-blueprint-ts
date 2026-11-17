import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { IrModule, IrNode, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";
import { structLiteralText } from "../src/lower/builder.js";
import type { HirExpr } from "../src/index.js";
import type { HirProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
const config = { mod: "TestMod" };

function source(body: string, members = ""): string {
  return `import { bindEvent, blueprint, event, nameOf, override, spawnActor } from "@abfc/runtime";
import { BP_FakePot_C } from "/Game/Fake/BP_FakePot";
import { Actor } from "/Script/FakeEngine";
import type { BP_Counter_Manual } from "/TestMod/Relay/BP_Counter";

export interface BP_Counter extends BP_Counter_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Counter" })
export class BP_Counter extends Actor {
  @event
  Go(): void {
${body}
  }
${members}}
`;
}

/** HIR of a one-event BP_Counter whose body is `body`, in a copy of the phase2 fixture. */
function hirOf(body: string, allowTsErrors = false, members = ""): HirProgram {
  const dir = mkdtempSync(join(here, "wire-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    rmSync(join(dir, "src", "Counter.ts"));
    rmSync(join(dir, "src", "Director.ts"));
    writeFileSync(join(dir, "src", "Wire.ts"), source(body, members), "utf8");
    const loaded = loadProgram(dir);
    if (!allowTsErrors) assert.deepEqual(loaded.diagnostics, []);
    const res = buildHir(loaded, config, profile);
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


function irOf(body: string, members = ""): IrModule {
  const hir = hirOf(body, false, members);
  assert.deepEqual(hir.diagnostics, []);
  const ir = lower(hir, profile);
  assert.deepEqual(validateIrModule(ir), []);
  return ir;
}
const nodesOf = (ir: IrModule): IrNode[] => ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes));
const wiresOf = (ir: IrModule): Array<[string, string]> => ir.assets.flatMap((a) => a.units.flatMap((u) => u.wires as Array<[string, string]>));
const span = { file: "x.ts", line: 1, col: 1 };
const lit = (v: number): HirExpr => ({ k: "lit", value: v, type: "double", span }) as HirExpr;

test("other.Var = value sets a variable of a spawned actor (Set node with its Target wired)", () => {
  const ir = irOf("    const pot = spawnActor(BP_FakePot_C, { collisionHandlingOverride: \"AlwaysSpawn\" });\n    pot.Ready = true;");
  const nodes = nodesOf(ir);
  const spawn = nodes.find((n) => n.sem?.k === "spawn")!;
  const set = nodes.find((n) => n.sem?.k === "set" && n.sem.name === "Ready")!;
  assert.ok(set, "a Set node for Ready");
  assert.deepEqual(set.sem, { k: "set", name: "Ready", class: "/Game/Fake/BP_FakePot.BP_FakePot_C" });
  assert.deepEqual(set.pinDefaults, { Ready: "true" });
  const w = wiresOf(ir);
  assert.ok(w.some(([a, b]) => a === `${spawn.id}.ReturnValue` && b === `${set.id}.self`));
  assert.ok(w.some(([a, b]) => a === `${spawn.id}.then` && b === `${set.id}.execute`));
});

test("bindEvent lowers to Add Delegate on the source's dispatcher fed by Create Event of the target's function", () => {
  const ir = irOf(
    "    const a = spawnActor(BP_FakePot_C, { collisionHandlingOverride: \"AlwaysSpawn\" });\n" +
      "    const b = spawnActor(BP_FakePot_C, { collisionHandlingOverride: \"AlwaysSpawn\" });\n" +
      "    bindEvent(a, \"ButtonPressed\", b, \"OnPressed\");",
  );
  const nodes = nodesOf(ir);
  const [sa, sb] = nodes.filter((n) => n.sem?.k === "spawn");
  const cd = nodes.find((n) => n.t3d.class.endsWith("K2Node_CreateDelegate"))!;
  const ad = nodes.find((n) => n.t3d.class.endsWith("K2Node_AddDelegate"))!;
  assert.deepEqual(cd.t3d.props, ['SelectedFunctionName="OnPressed"']);
  assert.deepEqual(ad.t3d.props, ["DelegateReference=(MemberParent=\"/Script/Engine.BlueprintGeneratedClass'/Game/Fake/BP_FakePot.BP_FakePot_C'\",MemberName=\"ButtonPressed\")"]);
  const w = wiresOf(ir);
  assert.ok(w.some(([x, y]) => x === `${sb!.id}.ReturnValue` && y === `${cd.id}.self`), "the target feeds Create Event");
  assert.ok(w.some(([x, y]) => x === `${sa!.id}.ReturnValue` && y === `${ad.id}.self`), "the source feeds Add Delegate");
  assert.ok(w.some(([x, y]) => x === `${cd.id}.OutputDelegate` && y === `${ad.id}.Delegate`));
  assert.ok(w.some(([x, y]) => x === `${sb!.id}.then` && y === `${ad.id}.execute`));
});

test("bindEvent(..., this, \"Event\") feeds Add Delegate from the own event's delegate pin, without Create Event", () => {
  const ir = irOf(
    "    const a = spawnActor(BP_FakePot_C, { collisionHandlingOverride: \"AlwaysSpawn\" });\n    bindEvent(a, \"ButtonPressed\", this, \"OnPressed\");",
    "  @event\n  OnPressed(): void {}\n",
  );
  const nodes = nodesOf(ir);
  assert.equal(nodes.filter((n) => n.t3d.class.endsWith("K2Node_CreateDelegate")).length, 0);
  const ad = nodes.find((n) => n.t3d.class.endsWith("K2Node_AddDelegate"))!;
  const go = ir.assets[0]!.units.find((u) => u.id === "event:Go")!;
  assert.deepEqual(go.crossWires, [{ toUnit: "event:OnPressed", from: "ev0.OutputDelegate", to: `${ad.id}.Delegate` }]);
  const sa = nodes.find((n) => n.sem?.k === "spawn")!;
  assert.ok(wiresOf(ir).some(([x, y]) => x === `${sa.id}.ReturnValue` && y === `${ad.id}.self`));
});

test("bindEvent(..., this, name) needs an own @event", () => {
  const hir = hirOf("    const a = spawnActor(BP_FakePot_C, {});\n    bindEvent(a, \"ButtonPressed\", this, \"Nope\");", true);
  assert.ok(hir.diagnostics.some((d) => d.code === "ABFC2054"));
});

test("super.X() in @override X is a Call Parent Function node on the parent class, first on the exec line", () => {
  const ir = irOf("", "  @override\n  override ReceiveBeginPlay(): void {\n    super.ReceiveBeginPlay();\n    this.Go();\n  }\n");
  const u = ir.assets[0]!.units.find((x) => x.id === "override:ReceiveBeginPlay")!;
  const parent = u.nodes.find((n) => n.t3d.class.endsWith("K2Node_CallParentFunction"))!;
  assert.ok(parent, "a Call Parent Function node");
  assert.equal(parent.sem, undefined);
  assert.deepEqual(parent.t3d.props, ["FunctionReference=(MemberParent=\"/Script/CoreUObject.Class'/Script/FakeEngine.Actor'\",MemberName=\"ReceiveBeginPlay\")"]);
  assert.ok((u.wires as Array<[string, string]>).some(([a, b]) => a === "ev0.then" && b === `${parent.id}.execute`));
});

test("super.X() outside @override X is refused", () => {
  const hir = hirOf("    super.ReceiveBeginPlay();", true);
  assert.ok(hir.diagnostics.some((d) => d.code === "ABFC2099" && /super\.ReceiveBeginPlay/.test(d.message)));
});

test("bindEvent needs string literal names", () => {
  const hir = hirOf("    const a = spawnActor(BP_FakePot_C, {});\n    const n = \"X\";\n    bindEvent(a, n, a, \"Y\");", true);
  assert.ok(hir.diagnostics.some((d) => d.code === "ABFC2099"));
});

test("a Vector or Rotator literal of numbers is a pin default text, in the editor's order", () => {
  const vec = { k: "makeStruct", struct: "/Script/CoreUObject.Vector", fields: [{ name: "Z", value: lit(3) }, { name: "X", value: lit(-1.5) }], type: "struct:/Script/CoreUObject.Vector", span } as HirExpr;
  assert.equal(structLiteralText(vec), "-1.500000,0.000000,3.000000");
  const rot = { k: "makeStruct", struct: "/Script/CoreUObject.Rotator", fields: [{ name: "Yaw", value: lit(90) }, { name: "Roll", value: lit(1) }, { name: "Pitch", value: lit(-45) }], type: "struct:/Script/CoreUObject.Rotator", span } as HirExpr;
  assert.equal(structLiteralText(rot), "-45.000000,90.000000,1.000000");
  const live = { k: "makeStruct", struct: "/Script/CoreUObject.Vector", fields: [{ name: "X", value: { k: "param", name: "A", type: "double", span } as HirExpr }], type: "struct:/Script/CoreUObject.Vector", span } as HirExpr;
  assert.equal(structLiteralText(live), undefined, "a field that is not a literal keeps the make node");
});
