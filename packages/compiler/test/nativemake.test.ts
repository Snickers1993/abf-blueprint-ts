import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Diagnostic, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";
import type { HirProgram } from "../src/index.js";
import type { IrNode } from "@abfc/ir";

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

function source(body: string): string {
  return `import { blueprint, event } from "@abfc/runtime";
import type { double } from "@abfc/runtime";
import type { Vector } from "/Script/CoreUObject";
import { Actor } from "/Script/FakeEngine";
import type { BP_Counter_Manual } from "/TestMod/Relay/BP_Counter";

export interface BP_Counter extends BP_Counter_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Counter" })
export class BP_Counter extends Actor {
  Spot!: Vector;
  Far!: double;
  @event
  Go(): void {
${body}
  }
}
`;
}

/** HIR of a one-event BP_Counter whose body is `body`, in a copy of the phase2 fixture. */
function hirOf(body: string, allowTsErrors = false): HirProgram {
  const dir = mkdtempSync(join(here, "nativemake-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    rmSync(join(dir, "src", "Counter.ts"));
    rmSync(join(dir, "src", "Director.ts"));
    writeFileSync(join(dir, "src", "NativeMake.ts"), source(body), "utf8");
    const core = join(dir, ".abfc", "stubs", "test", "Script", "CoreUObject.d.ts");
    writeFileSync(core, readFileSync(core, "utf8") + VECTOR_STUB, "utf8");
    const loaded = loadProgram(dir);
    if (!allowTsErrors) assert.deepEqual(loaded.diagnostics, []);
    const res = buildHir(loaded, config, profile);
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codes = (ds: Diagnostic[]): string[] => ds.map((d) => d.code);

function nodesOf(body: string): IrNode[] {
  const hir: HirProgram = hirOf(body);
  assert.deepEqual(hir.diagnostics, []);
  const ir = lower(hir, profile);
  assert.deepEqual(validateIrModule(ir), []);
  return ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes));
}

test("a Vector literal lowers to KismetMathLibrary.MakeVector, not a Make Struct node", () => {
  const nodes = nodesOf("    this.Spot = { X: 1, Y: this.Far, Z: 3 };");
  assert.equal(nodes.filter((n) => n.t3d.class === profile.nodeClasses.makeStruct).length, 0);
  const mk = nodes.filter((n) => n.sem?.k === "call" && n.sem.function === "MakeVector");
  assert.equal(mk.length, 1);
  assert.ok(mk[0]!.t3d.props.includes("bIsPureFunc=True"));
  assert.deepEqual(mk[0]!.pinDefaults, { X: "1.0", Z: "3.0" });
});

void codes;
