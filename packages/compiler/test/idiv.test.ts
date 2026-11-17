import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Diagnostic, IrNode, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";
import type { HirExpr, HirProgram, HirStmt } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
const config = { mod: "TestMod" };

function source(body: string): string {
  return `import { blueprint, event, idiv } from "@abfc/runtime";
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
  const dir = mkdtempSync(join(here, "idiv-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    rmSync(join(dir, "src", "Counter.ts"));
    rmSync(join(dir, "src", "Director.ts"));
    writeFileSync(join(dir, "src", "Idiv.ts"), source(body), "utf8");
    const loaded = loadProgram(dir);
    if (!allowTsErrors) assert.deepEqual(loaded.diagnostics, []);
    const res = buildHir(loaded, config, profile);
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function exprsOf(s: HirStmt, out: HirExpr[]): void {
  const walk = (e: HirExpr): void => {
    out.push(e);
    for (const v of Object.values(e)) {
      if (v && typeof v === "object" && "k" in v) walk(v as HirExpr);
    }
  };
  for (const v of Object.values(s)) {
    if (v && typeof v === "object" && "k" in v) {
      const o = v as { k: string };
      if (["arith", "cmp", "lit", "field", "getOn"].includes(o.k)) walk(v as HirExpr);
    }
  }
}

const codes = (ds: Diagnostic[]): string[] => ds.map((d) => d.code);

test("idiv(this.Count, 2) is an int arith `/` in the HIR", () => {
  const hir = hirOf("    this.Count = idiv(this.Count, 2);");
  assert.deepEqual(hir.diagnostics, []);
  const found: HirExpr[] = [];
  for (const c of hir.classes) for (const ev of c.events) for (const st of ev.body) exprsOf(st, found);
  const div = found.find((e) => e.k === "arith" && e.op === "/");
  assert.ok(div && div.k === "arith");
  assert.equal(div.kind, "int");
  assert.equal(div.type, "int");
});

test("idiv lowers to KismetMathLibrary Divide_IntInt", () => {
  const hir = hirOf("    this.Count = idiv(this.Count, 2);");
  assert.deepEqual(hir.diagnostics, []);
  const ir = lower(hir, profile);
  assert.deepEqual(validateIrModule(ir), []);
  const nodes: IrNode[] = ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes));
  const div = nodes.filter((n) => n.sem?.k === "call" && n.sem.function === "Divide_IntInt");
  assert.equal(div.length, 1);
  assert.match(div[0]!.sem?.k === "call" ? (div[0]!.sem.class ?? "") : "", /KismetMathLibrary$/);
});

test("idiv with a real operand is ABFC2012", () => {
  const hir = hirOf("    this.Count = idiv(this.Elapsed + 1, 2);");
  assert.deepEqual(codes(hir.diagnostics), ["ABFC2012"]);
  assert.match(hir.diagnostics[0]!.message, /idiv takes int operands/);
});

test("idiv with one argument is ABFC2099", () => {
  const hir = hirOf("    this.Count = idiv(this.Count);", true);
  assert.ok(codes(hir.diagnostics).includes("ABFC2099"));
  assert.ok(hir.diagnostics.some((d) => d.message.includes("idiv(a, b) takes two arguments")));
});

test("`/` on ints is still ABFC2010", () => {
  const hir = hirOf("    this.Count = this.Count / 2;");
  assert.deepEqual(codes(hir.diagnostics), ["ABFC2010"]);
});

test("`/` on reals lowers to Divide_DoubleDouble", () => {
  const hir = hirOf("    this.Elapsed = this.Elapsed / 2;");
  assert.deepEqual(hir.diagnostics, []);
  const ir = lower(hir, profile);
  assert.deepEqual(validateIrModule(ir), []);
  const nodes: IrNode[] = ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes));
  const div = nodes.filter((n) => n.sem?.k === "call" && n.sem.function === "Divide_DoubleDouble");
  assert.equal(div.length, 1);
  assert.deepEqual(div[0]!.pinDefaults, { B: "2.0" });
});
