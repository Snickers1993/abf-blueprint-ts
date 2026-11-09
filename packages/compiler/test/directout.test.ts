import { test } from "node:test";
import assert from "node:assert/strict";
import { codes, compileFiles } from "./fn-harness.js";

// An output read straight off a call (`Lib.Fn(...).Out`) needs no const, except on a call with exec outputs, whose
// next statement must branch on `.exec` (ABFC2052).
const src = (body: string): string => `import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { FakeLibrary } from "/Script/FakeGame";
import type { FakeRowHandle } from "/Script/FakeGame";

@blueprint({ path: "/TestMod/Relay/BP_Printer" })
export class BP_Printer extends Actor {
  Seen!: boolean;
  @event
  Go(h: FakeRowHandle): void {
${body}
  }
}
`;

test("an output of a call with exec outputs still needs its const (ABFC2052)", () => {
  const c = compileFiles({ "Printer.ts": src("    this.Seen = FakeLibrary.GetRow(h).Data.Info.A > 0;") });
  assert.ok(codes(c).includes("ABFC2052"), JSON.stringify(c.hir.diagnostics.map((d) => d.code + " " + d.message)));
  assert.ok(!codes(c).includes("ABFC2060"));
});
