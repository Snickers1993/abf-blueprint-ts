import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { IrModule, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profile = JSON.parse(readFileSync(fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url)), "utf8")) as Profile;

// A function whose only output is an out parameter (not ReturnValue), as UPrimitiveComponent::GetOverlappingActors.
const STUB = `import type { TSubclassOf } from "@abfc/runtime";
import type { Actor } from "/Script/FakeEngine";
/**
 * @bpPath /Script/FakeOverlap.Box
 * @bpMeta /Script/CoreUObject.Class
 */
export declare class Box {
  /**
   * @bpPath /Script/FakeOverlap.Box:GetOverlappingActors
   * @bpPure
   * @bpParam ClassFilter class:/Script/FakeEngine.Actor
   * @bpOut OverlappingActors array:object:/Script/FakeEngine.Actor
   */
  GetOverlappingActors(ClassFilter: TSubclassOf<Actor> | (abstract new (...a: never[]) => Actor) | null): Actor[];
}
`;

const SOURCE = `import { blueprint } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import type { Box } from "/Script/FakeOverlap";

@blueprint({ path: "/TestMod/Relay/BP_Overlap" })
export class BP_Overlap extends Actor {
  Count: int = 0;
  private Anyone(box: Box): boolean {
    return box.GetOverlappingActors(Actor).length > 0;
  }
  private Store(box: Box): void {
    const all = box.GetOverlappingActors(null);
    this.Count = all.length;
  }
}
`.replace('import { blueprint } from "@abfc/runtime";', 'import { blueprint } from "@abfc/runtime";\nimport type { int } from "@abfc/runtime";');

function irOf(): IrModule {
  const dir = mkdtempSync(join(here, "single-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(dir, "src", f));
    writeFileSync(join(dir, ".abfc", "stubs", "test", "Script", "FakeOverlap.d.ts"), STUB, "utf8");
    writeFileSync(join(dir, "src", "Overlap.ts"), SOURCE, "utf8");
    const loaded = loadProgram(dir);
    assert.deepEqual(loaded.diagnostics, []);
    const hir = buildHir(loaded, { mod: "TestMod" }, profile);
    assert.deepEqual(hir.diagnostics, []);
    const ir = lower(hir, profile);
    assert.deepEqual(validateIrModule(ir), []);
    return ir;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a call whose only output is an out parameter is a value read from that pin (array length, const)", () => {
  const ir = irOf();
  const asset = ir.assets.find((a) => a.path.endsWith("BP_Overlap"))!;
  for (const id of ["function:Anyone", "function:Store"]) {
    const u = asset.units.find((x) => x.id === id)!;
    const named = (fn: string) => u.nodes.find((n) => (n.t3d.props ?? []).some((p) => p.includes(`MemberName="${fn}"`)));
    const call = named("GetOverlappingActors")!;
    const len = named("Array_Length");
    assert.ok(call && len, `${id}: the overlap call and Array_Length`);
    const wires = u.wires as Array<[string, string]>;
    const fromOut = wires.filter(([a]) => a === `${call.id}.OverlappingActors`);
    assert.ok(fromOut.length > 0, `${id}: OverlappingActors is wired`);
    assert.ok(!wires.some(([a]) => a === `${call.id}.ReturnValue`), `${id}: no ReturnValue pin is read`);
  }
});
