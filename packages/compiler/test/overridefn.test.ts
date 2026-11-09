import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Diagnostic, IrModule, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profile = JSON.parse(readFileSync(fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url)), "utf8")) as Profile;

// A parent with overridable functions that return values, like a game weapon parent's fire handler.
const STUB = `import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
/**
 * @bpPath /Script/FakeWeapon.Weapon
 * @bpMeta /Script/CoreUObject.Class
 */
export declare class Weapon extends Actor {
  /**
   * @bpPath /Script/FakeWeapon.Weapon:Local_FirePressed
   * @bpOut ConsumedByWeapon bool
   */
  Local_FirePressed(): { ConsumedByWeapon: boolean };
  /**
   * @bpPath /Script/FakeWeapon.Weapon:Pick
   * @bpParam Index int
   * @bpOut Ok bool
   * @bpOut Count int
   */
  Pick(Index: int): { Ok: boolean; Count: int };
  /**
   * @bpPath /Script/FakeWeapon.Weapon:CanFire
   * @bpOut ReturnValue bool
   */
  CanFire(): boolean;
}
`;

const HEAD = `import { blueprint, override } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Weapon } from "/Script/FakeWeapon";
`;

const SOURCE = `${HEAD}
@blueprint({ path: "/TestMod/Hook/BP_Hook" })
export class BP_Hook extends Weapon {
  Armed: boolean = false;
  Shots: int = 0;
  @override
  override Local_FirePressed(): { ConsumedByWeapon: boolean } {
    this.Shots = this.Shots + 1;
    return { ConsumedByWeapon: true };
  }
  @override
  override Pick(Index: int): { Ok: boolean; Count: int } {
    if (Index > 2) return { Ok: false, Count: 0 };
    return { Count: Index, Ok: this.Armed };
  }
  @override
  override CanFire(): boolean {
    return this.Armed;
  }
}
`;

function build(source: string): { ir?: IrModule; diagnostics: Diagnostic[] } {
  const dir = mkdtempSync(join(here, "ovfn-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(dir, "src", f));
    writeFileSync(join(dir, ".abfc", "stubs", "test", "Script", "FakeWeapon.d.ts"), STUB, "utf8");
    writeFileSync(join(dir, "src", "Hook.ts"), source, "utf8");
    const loaded = loadProgram(dir);
    assert.deepEqual(loaded.diagnostics, []);
    const hir = buildHir(loaded, { mod: "TestMod" }, profile);
    if (hir.diagnostics.length > 0) return { diagnostics: hir.diagnostics };
    const ir = lower(hir, profile);
    assert.deepEqual(validateIrModule(ir), []);
    return { ir, diagnostics: [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an @override of a parent function with outputs is a function graph that names the parent and feeds its Return node", () => {
  const { ir, diagnostics } = build(SOURCE);
  assert.deepEqual(diagnostics, []);
  const units = ir!.assets[0]!.units;
  const fire = units.find((u) => u.name === "Local_FirePressed")!;
  assert.equal(fire.kind, "function");
  assert.equal(fire.graph, "Local_FirePressed");
  assert.equal(fire.signature.override, "/Script/FakeWeapon.Weapon");
  assert.deepEqual(fire.signature.outputs, [{ name: "ConsumedByWeapon", type: "bool" }]);
  assert.ok(!fire.nodes.some((n) => n.sem?.k === "override"), "no event node");
  // the literal true is a default on the result pin or a temp; either way the result is reached by exec
  assert.ok(fire.wires.some(([, to]) => to === "result.execute"));
});

test("several outputs: each returned field goes to its own pin; two returns use a temp per pin", () => {
  const { ir } = build(SOURCE);
  const units = ir!.assets[0]!.units;
  const pick = units.find((u) => u.name === "Pick")!;
  assert.deepEqual(pick.signature.inputs, [{ name: "Index", type: "int" }]);
  assert.deepEqual(pick.signature.outputs, [{ name: "Ok", type: "bool" }, { name: "Count", type: "int" }]);
  const tos = pick.wires.map(([, to]) => to);
  assert.ok(tos.includes("result.Ok"));
  assert.ok(tos.includes("result.Count"));
  const vars = ir!.assets[0]!.variables.map((v) => v.name);
  assert.ok(vars.includes("abfc_Pick_Ok") && vars.includes("abfc_Pick_Count"), vars.join(","));
});

test("a parent function whose only output is ReturnValue is overridden with a plain return value", () => {
  const { ir } = build(SOURCE);
  const can = ir!.assets[0]!.units.find((u) => u.name === "CanFire")!;
  assert.equal(can.kind, "function");
  assert.equal(can.signature.override, "/Script/FakeWeapon.Weapon");
  assert.deepEqual(can.signature.outputs, [{ name: "ReturnValue", type: "bool" }]);
  assert.ok(can.wires.some(([, to]) => to === "result.ReturnValue"));
});

test("an outputs override returns an object literal (TypeScript checks its fields)", () => {
  const plain = build(SOURCE.replace("return { ConsumedByWeapon: true };", "return true as never;"));
  assert.ok(plain.diagnostics.some((d) => /returns its outputs as an object literal/.test(d.message)), JSON.stringify(plain.diagnostics));
});
