import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Diagnostic, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";
import type { HirProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
const config = { mod: "TestMod" };

function source(body: string): string {
  return `import { asset, blueprint, event } from "@abfc/runtime";
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
}
`;
}

/** HIR of a one-event BP_Counter whose body is `body`, in a copy of the phase2 fixture. */
function hirOf(body: string, allowTsErrors = false): HirProgram {
  const dir = mkdtempSync(join(here, "asset-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    rmSync(join(dir, "src", "Counter.ts"));
    rmSync(join(dir, "src", "Director.ts"));
    writeFileSync(join(dir, "src", "Asset.ts"), source(body), "utf8");
    const loaded = loadProgram(dir);
    if (!allowTsErrors) assert.deepEqual(loaded.diagnostics, []);
    const res = buildHir(loaded, config, profile);
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codes = (ds: Diagnostic[]): string[] => ds.map((d) => d.code);

const POT = "/Game/Fake/BP_FakePot.BP_FakePot_C";

function objectsOf(body: string): Array<Record<string, string>> {
  const hir = hirOf(body);
  assert.deepEqual(hir.diagnostics, []);
  const ir = lower(hir, profile);
  assert.deepEqual(validateIrModule(ir), []);
  return ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes)).filter((n) => n.pinObjects).map((n) => n.pinObjects!);
}

test("asset(Class, path) feeds a pin as its default object, with the asset name added", () => {
  assert.deepEqual(objectsOf("    this.Pots.push(asset(BP_FakePot_C, \"/Game/Fake/Pots/Pot_A\"));"), [
    { NewItem: `${POT}'/Game/Fake/Pots/Pot_A.Pot_A'` },
  ]);
});

test("asset(Class, \"@mod/...\") resolves to the mod being built and keeps an explicit object name", () => {
  assert.deepEqual(objectsOf("    this.Pots[0] = asset(BP_FakePot_C, \"@mod/Props/Pot_B.Pot_B\");"), [
    { Item: `${POT}'/TestMod/Props/Pot_B.Pot_B'` },
  ]);
});

test("asset(Class, path) with a path that is not a package path is ABFC2099", () => {
  for (const bad of ["Pots/Pot_A", "/Script/Engine.Actor", "/Game/Fake/Pot A"]) {
    const hir = hirOf(`    this.Pots.push(asset(BP_FakePot_C, "${bad}"));`);
    assert.deepEqual(codes(hir.diagnostics), ["ABFC2099"], bad);
  }
});
