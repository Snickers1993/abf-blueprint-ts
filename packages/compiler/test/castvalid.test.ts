import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { IrUnit, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profile = JSON.parse(readFileSync(fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url)), "utf8")) as Profile;

// The Return Hook shape: cast the hit actor, `if (isValid(pawn)) { ...; return; }`, then the wall path. A failed cast must reach the
// wall path (the else side), not end the event.
const SOURCE = `import { blueprint, cast, event, isValid } from "@abfc/runtime";
import { Actor, FakeController } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Relay/BP_CastValid" })
export class BP_CastValid extends Actor {
  Hit!: Actor | null;
  Creature: boolean = false;
  Wall: boolean = false;
  @event
  Fire(): void {
    const pawn = cast(this.Hit, FakeController);
    if (isValid(pawn)) {
      this.Creature = true;
      return;
    }
    this.Wall = true;
  }
  @event
  Plain(): void {
    const pawn = cast(this.Hit, FakeController);
    if (pawn) {
      this.Creature = true;
      return;
    }
    this.Wall = true;
  }
  @event
  Neg(): void {
    const pawn = cast(this.Hit, FakeController);
    if (!isValid(pawn)) return;
    this.Creature = true;
  }
  @event
  NegBody(): void {
    const pawn = cast(this.Hit, FakeController);
    if (!isValid(pawn)) {
      this.Wall = true;
      return;
    }
    this.Creature = true;
  }
}
`;

let warnings: string[] = [];

function units(): Map<string, IrUnit> {
  const dir = mkdtempSync(join(here, "castvalid-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(dir, "src", f));
    writeFileSync(join(dir, "src", "CastValid.ts"), SOURCE, "utf8");
    const loaded = loadProgram(dir);
    assert.deepEqual(loaded.diagnostics, []);
    const hir = buildHir(loaded, { mod: "TestMod" }, profile);
    warnings = hir.diagnostics.map((d) => `${d.code} ${d.span?.line ?? 0}`);
    assert.ok(hir.diagnostics.every((d) => d.severity === "warning"), JSON.stringify(hir.diagnostics));
    const ir = lower(hir, profile);
    assert.deepEqual(validateIrModule(ir), []);
    const asset = ir.assets.find((a) => a.path.endsWith("BP_CastValid"))!;
    return new Map(asset.units.map((u) => [u.name, u]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The node that sets `name`, and what feeds its exec pin. */
function setterInputs(u: IrUnit, name: string): string[] {
  const set = u.nodes.find((n) => n.sem?.k === "set" && n.sem.name === name);
  assert.ok(set, `a set of ${name}`);
  return (u.wires as Array<[string, string]>).filter(([, b]) => b === `${set.id}.execute`).map(([a]) => a);
}

test("if (isValid(castResult)): a failed cast takes the else path instead of ending the event", () => {
  const u = units().get("Fire")!;
  const cast = u.nodes.find((n) => n.sem?.k === "cast")!;
  assert.ok(cast);
  const intoWall = setterInputs(u, "Wall");
  assert.ok(intoWall.includes(`${cast.id}.CastFailed`), `CastFailed -> set Wall (got ${intoWall.join(", ")})`);
  // the success side goes to the creature path
  const intoCreature = setterInputs(u, "Creature");
  assert.ok(intoCreature.some((s) => s.startsWith(`${cast.id}.`) || /^br\d+\.then$/.test(s)), intoCreature.join(", "));
});

test("isValid(castResult) builds the same graph as if (castResult)", () => {
  const all = units();
  const shape = (u: IrUnit) => JSON.stringify({ nodes: u.nodes.map((n) => [n.id, n.t3d.class]), wires: u.wires });
  assert.equal(shape(all.get("Fire")!), shape(all.get("Plain")!));
});

test("!isValid(castResult) keeps its old graph (published Blueprints use it); a branch that does more than return is warned (ABFC2103)", () => {
  const u = units();
  const neg = u.get("Neg")!;
  // the old shape: an IsValid call and a Branch, the Cast Failed pin unwired
  assert.ok(neg.nodes.some((n) => n.sem?.k === "call" && n.sem.function === "IsValid"), "IsValid call kept");
  const cast = neg.nodes.find((n) => n.sem?.k === "cast")!;
  assert.ok(!(neg.wires as Array<[string, string]>).some(([a]) => a === `${cast.id}.CastFailed`), "CastFailed stays unwired");
  // the bare `if (!isValid(pawn)) return;` is not warned; the one with a body is
  const lines = SOURCE.split("\n");
  const bodyLine = lines.findIndex((l) => l.includes("if (!isValid(pawn)) {")) + 1;
  assert.deepEqual(warnings, [`ABFC2103 ${bodyLine}`]);
});
