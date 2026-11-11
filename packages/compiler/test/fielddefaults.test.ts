import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { IrModule, IrNode, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";
import type { HirProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
const config = { mod: "TestMod" };

const VECTOR_STUB = `
/**
 * @bpPath /Script/CoreUObject.Vector
 * @bpKind struct
 */
export declare interface Vector {
  /**
   * @bpType double
   */
  X: import("@abfc/runtime").double;
  /**
   * @bpType double
   */
  Y: import("@abfc/runtime").double;
  /**
   * @bpType double
   */
  Z: import("@abfc/runtime").double;
}
`;

function source(members: string, options = "", body = ""): string {
  return `import { asset, blueprint, event, spawnActor } from "@abfc/runtime";
import type { int, name, text, TSubclassOf } from "@abfc/runtime";
import type { Vector } from "/Script/CoreUObject";
import { BP_FakePot_C } from "/Game/Fake/BP_FakePot";
import { Actor } from "/Script/FakeEngine";
import type { BP_Counter_Manual } from "/TestMod/Relay/BP_Counter";

export interface BP_Counter extends BP_Counter_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Counter"${options} })
export class BP_Counter extends Actor {
${members}
  @event
  Go(): void {
${body}
  }
}
`;
}

function hirOf(members: string, options = "", body = ""): HirProgram {
  const dir = mkdtempSync(join(here, "fielddef-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    rmSync(join(dir, "src", "Counter.ts"));
    rmSync(join(dir, "src", "Director.ts"));
    writeFileSync(join(dir, "src", "FieldDefaults.ts"), source(members, options, body), "utf8");
    const core = join(dir, ".abfc", "stubs", "test", "Script", "CoreUObject.d.ts");
    writeFileSync(core, readFileSync(core, "utf8") + VECTOR_STUB, "utf8");
    const loaded = loadProgram(dir);
    assert.deepEqual(loaded.diagnostics, []);
    return buildHir(loaded, config, profile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const defaultsOf = (hir: HirProgram): Record<string, string> => hir.classes[0]!.defaults;
const codes = (hir: HirProgram): string[] => hir.diagnostics.map((d) => d.code);

test("struct, array, name and text field initializers become CDO field defaults", () => {
  const hir = hirOf(`  Spots: Vector[] = [{ X: 1, Y: -2, Z: 3 }, { X: 0, Y: 0, Z: 0 }];
  Labels: name[] = ["a", "b"];
  Empty: int[] = [];
  Title: text = "Hello";
  Home: Vector = { X: 5, Y: 6, Z: 7 };
  Pot: TSubclassOf<BP_FakePot_C> = BP_FakePot_C;
  Amount: int = 3;`);
  assert.deepEqual(hir.diagnostics.map((d) => d.message), []);
  const d = defaultsOf(hir);
  assert.ok(d["field:Spots"], JSON.stringify(d));
  const spots = JSON.parse(d["field:Spots"]!) as { k: string; items: Array<{ k: string }> };
  assert.equal(spots.k, "array");
  assert.equal(spots.items.length, 2);
  assert.equal(spots.items[0]!.k, "struct");
  assert.match(d["field:Labels"]!, /"name"/);
  assert.equal(JSON.parse(d["field:Empty"]!).k, "array");
  assert.match(d["field:Title"]!, /Hello/);
  assert.match(d["field:Home"]!, /"name":"Vector"/);
  assert.match(d["field:Pot"]!, /BP_FakePot/);
  // a plain int keeps its pin-style variable default
  assert.equal(d["field:Amount"], undefined);
});

test("a fractional value in an int array is ABFC2047", () => {
  const hir = hirOf("  Bad: int[] = [1, 2.5];");
  assert.ok(codes(hir).includes("ABFC2047"), codes(hir).join(","));
});

test("tickEnabled: false sets bStartWithTickEnabled", () => {
  const hir = hirOf("", ", tickEnabled: false");
  assert.deepEqual(codes(hir), []);
  assert.equal(defaultsOf(hir)["bStartWithTickEnabled"], "False");
});

test("spawnActor instigator feeds the Instigator pin", () => {
  const hir = hirOf("", "", "    spawnActor(BP_FakePot_C, { instigator: this, collisionHandlingOverride: \"AlwaysSpawn\" });");
  assert.deepEqual(codes(hir), []);
  const ir: IrModule = lower(hir, profile);
  assert.deepEqual(validateIrModule(ir), []);
  const wires = ir.assets.flatMap((a) => a.units.flatMap((u) => u.wires as Array<[string, string]>));
  const nodes: IrNode[] = ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes));
  const spawn = nodes.find((n) => n.t3d.class.includes("SpawnActor"));
  assert.ok(spawn);
  assert.ok(wires.some(([, to]) => to === `${spawn!.id}.Instigator`), JSON.stringify(wires));
});
