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
  const dir = mkdtempSync(join(here, "snap-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    rmSync(join(dir, "src", "Counter.ts"));
    rmSync(join(dir, "src", "Director.ts"));
    writeFileSync(join(dir, "src", "Snap.ts"), source(body), "utf8");
    const loaded = loadProgram(dir);
    if (!allowTsErrors) assert.deepEqual(loaded.diagnostics, []);
    const res = buildHir(loaded, config, profile);
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


function irOf(body: string): IrModule {
  const hir = hirOf(body);
  assert.deepEqual(hir.diagnostics, []);
  const ir = lower(hir, profile);
  assert.deepEqual(validateIrModule(ir), []);
  return ir;
}
const temps = (ir: IrModule): string[] => ir.assets.flatMap((a) => a.variables.filter((v) => v.temp).map((v) => `${v.name}:${v.type}`));
const nodesOf = (ir: IrModule): IrNode[] => ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes));
const wiresOf = (ir: IrModule): Array<[string, string]> => ir.assets.flatMap((a) => a.units.flatMap((u) => u.wires as Array<[string, string]>));

// The RTS capsule flow bug: `const first = this.Pts.length` was a live Array Length node, read again after the pushes.
test("a const that reads an array length is stored before a later push changes it", () => {
  const ir = irOf("    const first = this.Names.length;\n    this.Names.push(nameOf(\"Slot\"));\n    this.Count = this.Names.length - first;");
  assert.deepEqual(temps(ir), ["abfc_Go_t0:int"]);
  const nodes = nodesOf(ir);
  const set = nodes.find((n) => n.sem?.k === "set" && n.sem.name === "abfc_Go_t0")!;
  const push = nodes.find((n) => n.t3d.props.some((p) => p.includes('MemberName="Array_Add"')))!;
  assert.ok(set && push);
  assert.ok(wiresOf(ir).some(([a, b]) => a === `${set.id}.then` && b === `${push.id}.execute`), "the temp is set before the push runs");
});

test("a const that reads an own variable and is used after a write keeps the old value", () => {
  const ir = irOf("    const old = this.Count;\n    this.Count = 5;\n    this.Elapsed = old * 1.0;");
  assert.equal(temps(ir).length, 1);
});

test("a state-reading const used only by the next statement stays a plain pure value", () => {
  assert.deepEqual(temps(irOf("    const n = this.Count;\n    this.Count = n + 1;")), []);
  assert.deepEqual(temps(irOf("    const n = this.Names.length;\n    if (n > 2) this.Names.length = 0;")), []);
});

test("a const built from a live pure const is stored when it outlives the next statement", () => {
  const ir = irOf("    const a = this.Count;\n    const b = a + 1;\n    this.Count = 7;\n    this.Count = b;");
  assert.deepEqual(temps(ir), ["abfc_Go_t0:int"]);
});

test("a const of literals and parameters needs no temp", () => {
  assert.deepEqual(temps(irOf("    const n = 3;\n    this.Count = 1;\n    this.Count = n;")), []);
});
