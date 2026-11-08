import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";
import type { HirProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;

function source(body: string): string {
  return `import { blueprint, event } from "@abfc/runtime";
import type { double, float } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { FakeSystem } from "/Script/FakeGame";
import type { BP_Counter_Manual } from "/TestMod/Relay/BP_Counter";

export interface BP_Counter extends BP_Counter_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Counter" })
export class BP_Counter extends Actor {
  Far: double = 2;
  Pace: float = 1;
  @event
  Go(): void {
${body}
  }
}
`;
}

function hirOf(body: string): HirProgram {
  const dir = mkdtempSync(join(here, "floatpin-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(dir, "src", f));
    writeFileSync(join(dir, "src", "FloatPin.ts"), source(body), "utf8");
    const loaded = loadProgram(dir);
    assert.deepEqual(loaded.diagnostics, []);
    return buildHir(loaded, { mod: "TestMod" }, profile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a double passes to a float parameter (the pin converts)", () => {
  const hir = hirOf("    FakeSystem.SetTimerThing(this.Go, this.Far * 2);");
  assert.deepEqual(hir.diagnostics, []);
  const ir = lower(hir, profile);
  assert.deepEqual(validateIrModule(ir), []);
  const nodes = ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes));
  assert.ok(nodes.some((n) => n.sem?.k === "call" && n.sem.function === "SetTimerThing"));
});

test("a float field takes a double and keeps its float type", () => {
  const hir = hirOf("    this.Pace = this.Far;");
  assert.deepEqual(hir.diagnostics, []);
  assert.deepEqual(validateIrModule(lower(hir, profile)), []);
  assert.ok(JSON.stringify(hir).includes('"Pace"'));
  assert.ok(/"name":"Pace","type":"float"|"type":"float"[^}]*"name":"Pace"/.test(JSON.stringify(hir)), "Pace is still a float variable");
});
