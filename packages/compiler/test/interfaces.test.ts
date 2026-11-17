import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Diagnostic, IrModule, Profile } from "@abfc/ir";
import { buildHir, featureGates, loadProgram, lower } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profile = JSON.parse(readFileSync(fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url)), "utf8")) as Profile;

// A Blueprint interface as abfc generate writes it: a class with the interface's functions.
const IFACE_STUB = `import type { UObject } from "/Script/CoreUObject";
import type { Actor } from "/Script/FakeEngine";
/**
 * @bpPath /Game/Fake/I_FakeUse.I_FakeUse_C
 * @bpMeta /Script/Engine.BlueprintGeneratedClass
 */
export declare class I_FakeUse_C extends UObject {
  /**
   * @bpPath /Game/Fake/I_FakeUse.I_FakeUse_C:Use_A
   * @bpParam User object:/Script/FakeEngine.Actor
   */
  Use_A(User: Actor | null): void;
  /**
   * @bpPath /Game/Fake/I_FakeUse.I_FakeUse_C:CanUse_A
   * @bpOut ReturnValue bool
   */
  CanUse_A(): boolean;
}
`;

const SOURCE = (opts: string, body = "") => `import { blueprint, override } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { I_FakeUse_C } from "/Game/Fake/I_FakeUse";
@blueprint({ path: "/TestMod/Use/BP_User"${opts} })
export class BP_User extends Actor {
  Uses: int = 0;
  Open: boolean = true;
  @override
  Use_A(User: Actor | null): void {
    this.Uses = this.Uses + 1;
  }
  @override
  CanUse_A(): boolean {
    return this.Open;
  }
${body}}
`;

function build(source: string): { ir?: IrModule; diagnostics: Diagnostic[] } {
  const dir = mkdtempSync(join(here, "iface-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(dir, "src", f));
    writeFileSync(join(dir, ".abfc", "stubs", "test", "Game", "Fake", "I_FakeUse.d.ts"), IFACE_STUB, "utf8");
    writeFileSync(join(dir, "src", "User.ts"), source, "utf8");
    const loaded = loadProgram(dir);
    assert.deepEqual(loaded.diagnostics, []);
    const hir = buildHir(loaded, { mod: "TestMod" }, profile);
    if (hir.diagnostics.length > 0) return { diagnostics: hir.diagnostics };
    const ir = lower(hir, profile);
    assert.deepEqual(validateIrModule(ir), []);
    return { ir, diagnostics: [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const IFACE = "/Game/Fake/I_FakeUse.I_FakeUse_C";

test("an interface event is an override event node whose EventReference names the interface", () => {
  const { ir, diagnostics } = build(SOURCE(", interfaces: [I_FakeUse_C]"));
  assert.deepEqual(diagnostics, []);
  const asset = ir!.assets[0]!;
  assert.deepEqual(asset.interfaces, [IFACE]);
  const use = asset.units.find((u) => u.name === "Use_A")!;
  assert.equal(use.kind, "override");
  assert.equal(use.graph, "EventGraph");
  const ev = use.nodes.find((n) => n.sem?.k === "override")!;
  assert.deepEqual(ev.sem, { k: "override", class: IFACE, function: "Use_A" });
  assert.ok(ev.t3d.props.includes(`EventReference=(MemberParent="/Script/Engine.BlueprintGeneratedClass'${IFACE}'",MemberName="Use_A")`), ev.t3d.props.join(" "));
  assert.ok(ev.t3d.props.includes("bOverrideFunction=True"));
});

test("an interface function with an output is a function graph that names the interface", () => {
  const { ir } = build(SOURCE(", interfaces: [I_FakeUse_C]"));
  const can = ir!.assets[0]!.units.find((u) => u.name === "CanUse_A")!;
  assert.equal(can.kind, "function");
  assert.equal(can.signature.override, IFACE);
  assert.deepEqual(can.signature.outputs, [{ name: "ReturnValue", type: "bool" }]);
});

test("without the interfaces option an interface event is ABFC2060 with a hint", () => {
  const { diagnostics } = build(SOURCE(""));
  const d = diagnostics.find((x) => x.code === "ABFC2060");
  assert.ok(d, JSON.stringify(diagnostics));
  assert.match(d!.message, /interfaces: \[\.\.\.\]/);
});

test("interfaces must be an array of classes, each once (ABFC2104)", () => {
  assert.ok(build(SOURCE(", interfaces: I_FakeUse_C as never")).diagnostics.some((d) => d.code === "ABFC2104"));
  assert.ok(build(SOURCE(", interfaces: [I_FakeUse_C, I_FakeUse_C]")).diagnostics.some((d) => d.code === "ABFC2104"));
});

test("a backend without bp_apply feature interfaces fails the build before the stage is touched (ABFC2044)", () => {
  const { ir } = build(SOURCE(", interfaces: [I_FakeUse_C]"));
  const caps = { containerTypes: { map: false, set: false }, createKinds: ["Blueprint"], functionGraphs: true };
  assert.ok(featureGates(ir!, caps).some((d) => d.code === "ABFC2044" && /feature interfaces/.test(d.message)));
  assert.ok(!featureGates(ir!, { ...caps, interfaces: true }).some((d) => d.code === "ABFC2044"));
});

test("message(obj, I_X_C).Fn(...) is a K2Node_Message naming the interface, its self pin wired to obj", () => {
  const body = `  @event
  Poke(Other: Actor | null): void {
    if (message(Other, I_FakeUse_C).CanUse_A()) message(Other, I_FakeUse_C).Use_A(this);
  }
`;
  const { ir, diagnostics } = build(SOURCE("", body).replace("import { blueprint, override }", "import { blueprint, event, message, override }").replace(/  @override\n  Use_A[\s\S]*?\n  }\n  @override\n  CanUse_A[\s\S]*?\n  }\n/, ""));
  assert.deepEqual(diagnostics, []);
  const poke = ir!.assets[0]!.units.find((u) => u.name === "Poke")!;
  const msgs = poke.nodes.filter((n) => n.t3d.class === "/Script/BlueprintGraph.K2Node_Message");
  assert.equal(msgs.length, 2);
  for (const m of msgs) {
    assert.equal(m.sem, undefined);
    assert.ok(m.t3d.props.some((p) => p.includes(`MemberParent="/Script/Engine.BlueprintGeneratedClass'${IFACE}'"`)), m.t3d.props.join(" "));
    assert.ok(poke.wires.some(([, to]) => to === `${m.id}.self`), JSON.stringify(poke.wires));
  }
});

test("message(...) outside a call target is refused", () => {
  const body = `  @event
  Poke(Other: Actor | null): void {
    const x = message(Other, I_FakeUse_C);
    void x;
  }
`;
  const { diagnostics } = build(SOURCE("", body).replace("import { blueprint, override }", "import { blueprint, event, message, override }").replace(/  @override\n  Use_A[\s\S]*?\n  }\n  @override\n  CanUse_A[\s\S]*?\n  }\n/, ""));
  assert.ok(diagnostics.some((d) => /only valid as the target/.test(d.message)), JSON.stringify(diagnostics.map((d) => d.message)));
});
