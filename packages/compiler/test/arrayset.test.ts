import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Diagnostic, IrNode, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";
import type { HirProgram, HirStmt } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
const config = { mod: "TestMod" };

function source(body: string): string {
  return `import { blueprint, event, nameOf } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import type { BP_Counter_Manual } from "/TestMod/Relay/BP_Counter";

export interface BP_Counter extends BP_Counter_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Counter" })
export class BP_Counter extends Actor {
  @event
  Go(): void {
${body}
  }
}
`;
}

/** HIR of a one-event BP_Counter whose body is `body`, in a copy of the phase2 fixture. */
function hirOf(body: string, allowTsErrors = false): HirProgram {
  const dir = mkdtempSync(join(here, "arrset-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    rmSync(join(dir, "src", "Counter.ts"));
    rmSync(join(dir, "src", "Director.ts"));
    writeFileSync(join(dir, "src", "ArrSet.ts"), source(body), "utf8");
    const loaded = loadProgram(dir);
    if (!allowTsErrors) assert.deepEqual(loaded.diagnostics, []);
    const res = buildHir(loaded, config, profile);
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codes = (ds: Diagnostic[]): string[] => ds.map((d) => d.code);
const stmts = (hir: HirProgram): HirStmt[] => hir.classes.flatMap((c) => c.events.flatMap((ev) => ev.body));

test("this.Arr[i] = x is an arrayOp set in the HIR", () => {
  const hir = hirOf("    this.Names[this.Count] = nameOf(\"Slot\");");
  assert.deepEqual(hir.diagnostics, []);
  const set = stmts(hir).find((s) => s.k === "arrayOp");
  assert.ok(set && set.k === "arrayOp");
  assert.equal(set.op, "set");
  assert.equal(set.array.self, "Names");
  assert.equal(set.index?.type, "int");
  assert.equal(set.value?.type, "name");
});

test("this.Arr[i] = x lowers to Array_Set with typed pins and bSizeToFit false", () => {
  const hir = hirOf("    this.Names[0] = nameOf(\"Slot\");");
  assert.deepEqual(hir.diagnostics, []);
  const ir = lower(hir, profile);
  assert.deepEqual(validateIrModule(ir), []);
  const nodes: IrNode[] = ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes));
  const set = nodes.filter((n) => n.t3d.class === profile.nodeClasses.callArrayFunction && n.t3d.props.some((p) => p.includes('MemberName="Array_Set"')));
  assert.equal(set.length, 1);
  assert.deepEqual(set[0]!.pinTypes, { TargetArray: "array:name", Item: "name" });
  assert.deepEqual(set[0]!.pinDefaults, { Index: "0", Item: "Slot", bSizeToFit: "false" });
  assert.ok(!set[0]!.t3d.props.includes("bIsPureFunc=True"));
});

test("an index that is not an int is ABFC2012", () => {
  const hir = hirOf("    this.Names[this.Elapsed] = nameOf(\"Slot\");", true);
  assert.ok(codes(hir.diagnostics).includes("ABFC2012"));
});

test("setting an element of a local array is ABFC2041", () => {
  const hir = hirOf("    const copy = this.Names;\n    copy[0] = nameOf(\"Slot\");");
  assert.ok(codes(hir.diagnostics).includes("ABFC2041"));
});
