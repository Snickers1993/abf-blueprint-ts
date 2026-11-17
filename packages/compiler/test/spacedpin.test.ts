import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;

// A function whose input pin name has a space, written the way abfc generate writes such a pin.
const STUB = `import type { int } from "@abfc/runtime";

/**
 * @bpPath /Script/FakeGame.FakeSpaced
 * @bpMeta /Script/CoreUObject.Class
 */
export declare namespace FakeSpaced {
  /**
   * @bpPath /Script/FakeGame.FakeSpaced:PlaceThing
   * @bpPin Source_Items "Source Items"
   * @bpParam Target int
   * @bpParam Source Items array:int
   */
  function PlaceThing(Target: int, Source_Items: int[]): void;
}
`;

const SOURCE = `import { blueprint, event } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import type { BP_Counter_Manual } from "/TestMod/Relay/BP_Counter";
import { FakeSpaced } from "./FakeSpaced.js";

export interface BP_Counter extends BP_Counter_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Counter" })
export class BP_Counter extends Actor {
  Items!: int[];
  @event
  Go(): void {
    FakeSpaced.PlaceThing(3, this.Items);
  }
}
`;

function irOf() {
  const dir = mkdtempSync(join(here, "spacedpin-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(dir, "src", f));
    writeFileSync(join(dir, "src", "FakeSpaced.d.ts"), STUB, "utf8");
    writeFileSync(join(dir, "src", "Spaced.ts"), SOURCE, "utf8");
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

test("an input pin whose name has a space is wired by its whole name; a one-word pin is unchanged", () => {
  const ir = irOf();
  const units = ir.assets.flatMap((a) => a.units);
  const call = units.flatMap((u) => u.nodes).find((n) => n.sem?.k === "call" && n.sem.function === "PlaceThing");
  assert.ok(call, "PlaceThing is called");
  const text = JSON.stringify(call) + JSON.stringify(units.flatMap((u) => u.wires));
  assert.ok(text.includes('"call0.Source Items"'), "the spaced pin is wired by its whole name: " + text.slice(0, 1500));
  assert.ok(!text.includes('"call0.Source"'), "no wire to a pin named only by the first word: " + text.slice(0, 1500));
  assert.deepEqual(call.pinDefaults, { Target: "3" }, "the one-word pin keeps its name");
});
