import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Diagnostic, IrModule, Profile } from "@abfc/ir";
import { buildHir, featureGates, loadProgram, lower } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profile = JSON.parse(readFileSync(fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url)), "utf8")) as Profile;

const PARTS = `import type { UObject } from "/Script/CoreUObject";
import type { double } from "@abfc/runtime";
/**
 * @bpPath /Script/FakeParts.Vector
 * @bpKind struct
 */
export declare interface Vector {
  /** @bpType double */
  X: double;
  /** @bpType double */
  Y: double;
  /** @bpType double */
  Z: double;
}
/**
 * @bpPath /Script/FakeParts.StaticMesh
 * @bpMeta /Script/CoreUObject.Class
 */
export declare class StaticMesh extends UObject {}
/**
 * @bpPath /Script/FakeParts.ActorComponent
 * @bpMeta /Script/CoreUObject.Class
 */
export declare class ActorComponent extends UObject {}
/**
 * @bpPath /Script/FakeParts.StaticMeshComponent
 * @bpMeta /Script/CoreUObject.Class
 */
export declare class StaticMeshComponent extends ActorComponent {
  /**
   * @bpPath /Script/FakeParts.StaticMeshComponent:StaticMesh
   * @bpType object:/Script/FakeParts.StaticMesh
   */
  StaticMesh: StaticMesh | null;
  /**
   * @bpPath /Script/FakeParts.StaticMeshComponent:RelativeLocation
   * @bpType struct:/Script/FakeParts.Vector
   */
  RelativeLocation: Vector;
  /**
   * @bpPath /Script/FakeParts.StaticMeshComponent:bHiddenInGame
   * @bpType bool
   */
  bHiddenInGame: boolean;
  /**
   * @bpPath /Script/FakeParts.StaticMeshComponent:SetVisibility
   * @bpParam bNewVisibility bool
   */
  SetVisibility(bNewVisibility: boolean): void;
}
`;

const SOURCE = (fields: string, body = "") => `import { asset, blueprint, component, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { StaticMesh, StaticMeshComponent } from "/Script/FakeParts";
@blueprint({ path: "/TestMod/Parts/BP_Crate" })
export class BP_Crate extends Actor {
${fields}
  @event
  Show(): void {
${body}
  }
}
`;

function build(source: string): { ir?: IrModule; diagnostics: Diagnostic[] } {
  const dir = mkdtempSync(join(here, "comp-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(dir, "src", f));
    writeFileSync(join(dir, ".abfc", "stubs", "test", "Script", "FakeParts.d.ts"), PARTS, "utf8");
    writeFileSync(join(dir, "src", "Crate.ts"), source, "utf8");
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

const FIELDS = `  Mesh = component(StaticMeshComponent, { StaticMesh: asset(StaticMesh, "@mod/Meshes/SM_Crate"), RelativeLocation: { X: 0, Y: 0, Z: 50 }, bHiddenInGame: true });
  Lid = component(StaticMeshComponent, undefined, { attachTo: "Mesh" });`;

test("a component field is an IR component (not a variable) with its props as field-default values", () => {
  const { ir, diagnostics } = build(SOURCE(FIELDS, "    this.Mesh.SetVisibility(true);"));
  assert.deepEqual(diagnostics.map((d) => d.message), []);
  const a = ir!.assets[0]!;
  assert.equal(a.variables.some((v) => v.name === "Mesh" || v.name === "Lid"), false);
  const comps = a.components!.map(({ origin: _o, ...c }) => c);
  assert.deepEqual(comps[1], { name: "Lid", class: "/Script/FakeParts.StaticMeshComponent", attachTo: "Mesh", props: {} });
  assert.equal(comps[0]!.name, "Mesh");
  assert.deepEqual(comps[0]!.props["bHiddenInGame"], { k: "bool", v: true });
  assert.equal((comps[0]!.props["StaticMesh"] as { k: string; path: string }).k, "asset");
  assert.match((comps[0]!.props["StaticMesh"] as { path: string }).path, /^\/TestMod\/Meshes\/SM_Crate/);
  assert.equal((comps[0]!.props["RelativeLocation"] as { k: string }).k, "struct");
  // the structure hash makes the asset re-plan when components change
  assert.match(a.classDefaults?.["abfc:structure"] ?? "", /^[0-9a-f]{32}$/);
  // reading the component is a variable get of its name, the call targets it
  const show = a.units.find((u) => u.name === "Show")!;
  const get = show.nodes.find((n) => n.sem?.k === "get" && n.sem.name === "Mesh");
  assert.ok(get, JSON.stringify(show.nodes.map((n) => n.sem)));
});

test("a changed component prop changes the structure hash", () => {
  const a = build(SOURCE(FIELDS)).ir!.assets[0]!.classDefaults!["abfc:structure"];
  const b = build(SOURCE(FIELDS.replace("Z: 50", "Z: 60"))).ir!.assets[0]!.classDefaults!["abfc:structure"];
  assert.notEqual(a, b);
});

test("a component cannot be assigned, needs a component class and known props (ABFC2105)", () => {
  const codes = (src: string) => build(src).diagnostics.map((d) => d.code);
  assert.ok(codes(SOURCE(FIELDS, "    this.Mesh = this.Lid;")).includes("ABFC2105"));
  assert.ok(codes(SOURCE("  Bad = component(StaticMesh);")).includes("ABFC2105"));
  assert.ok(codes(SOURCE("  Bad = component(StaticMeshComponent, { Nope: 1 } as never);")).includes("ABFC2105"));
  assert.ok(codes(SOURCE("  Bad = component(StaticMeshComponent, undefined, { attachTo: \"a b\" });")).includes("ABFC2105"));
});

test("a backend without bp_apply feature components fails before the stage is touched (ABFC2044)", () => {
  const { ir } = build(SOURCE(FIELDS));
  const caps = { containerTypes: { map: false, set: false }, createKinds: ["Blueprint"], functionGraphs: true };
  assert.ok(featureGates(ir!, caps).some((d) => d.code === "ABFC2044" && /feature components/.test(d.message)));
  assert.ok(!featureGates(ir!, { ...caps, components: true }).some((d) => d.code === "ABFC2044"));
});
