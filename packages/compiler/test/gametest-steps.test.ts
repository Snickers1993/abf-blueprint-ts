import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile, TestCase } from "@abfc/ir";
import { compileTests, loadProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` and `@abfc/testkit` resolve.
const here = fileURLToPath(new URL("./", import.meta.url));
const projectDir = fileURLToPath(new URL("../../test/fixtures/project", import.meta.url));
const profile = { id: "test" } as unknown as Profile;

const HOOK_TEST = `import { test } from "@abfc/testkit";
import { BP_Relay } from "./Relay.js";

const ONE = "result = 1";

test("pull", { map: "/Game/Maps/Facility", timeout: 400 }, (t) => {
  const me = t.find(BP_Relay, { timeout: 90 });
  const hook = t.spawn(BP_Relay);
  me.moveTo(100, -2.5, 300);
  me.aim(-20, 90);
  hook.call("UpdateTarget");
  t.waitUntil(hook.get("Visible"), { timeout: 5, every: 0.5 }).equals(false);
  t.waitUntil(t.distance(me, hook)).above(150);
  t.expect(t.distance(me, hook)).below(2000).knownIssue("not yet");
  const d = t.distance(me, hook);
  t.expect(d).above(1);
  hook.moveTo(me);
  t.waitUntil(t.python(ONE), { timeout: 2 }).equals(1);
});
`;

const BAD_TEST = `import { test } from "@abfc/testkit";
import { BP_Relay } from "./Relay.js";

test("bad", (t) => {
  const r = t.spawn(BP_Relay);
  const v = r.get("Visible");
  t.waitUntil(v).equals(true);
});
test("bad map", { map: "Facility" }, (t) => {
  t.wait(1);
});
`;

function compile(files: Record<string, string>): ReturnType<typeof compileTests> {
  const dir = mkdtempSync(join(here, "gametest-"));
  try {
    cpSync(projectDir, dir, { recursive: true });
    rmSync(join(dir, "src", "Bad.ts"));
    rmSync(join(dir, "src", "Relay.test.ts"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "src", name), text, "utf8");
    const loaded = loadProgram(dir);
    assert.deepEqual(loaded.diagnostics.filter((d) => d.severity === "error"), []);
    return compileTests(loaded, profile, undefined, { mod: "TestMod" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const stepsOf = (c: TestCase): unknown[] => c.steps.map((s) => (s.knownIssue === undefined ? s.step : { ...s.step, knownIssue: s.knownIssue }));

test("test options, t.find, moveTo, aim, t.distance, waitUntil, below/above, a top-level const string", () => {
  const { cases, diagnostics } = compile({ "Hook.test.ts": HOOK_TEST });
  assert.deepEqual(diagnostics, []);
  assert.equal(cases.length, 1);
  const c = cases[0]!;
  assert.equal(c.map, "/Game/Maps/Facility");
  assert.equal(c.timeoutSeconds, 400);
  const dist = `result = ctx["me"].get_distance_to(ctx["hook"])`;
  assert.deepEqual(stepsOf(c), [
    { op: "find", base: "Actor", class_contains: "PersistentLevel.BP_Relay_C_", as: "me", timeout: 90 },
    { op: "spawn", class: "/TestMod/Relay/BP_Relay.BP_Relay_C", as: "hook" },
    { op: "python", code: `ctx["me"].set_actor_location(unreal.Vector(100.0, -2.5, 300.0), False, True)` },
    {
      op: "python",
      code: [
        `a = ctx["me"]`,
        "r = unreal.Rotator(roll=0.0, pitch=-20.0, yaw=90.0)",
        "a.set_actor_rotation(r, True)",
        "c = a.get_controller() if isinstance(a, unreal.Pawn) else None",
        "if c is not None:",
        "    c.set_control_rotation(r)",
      ].join("\n"),
    },
    { op: "call", target: "$hook", function: "UpdateTarget", args: [] },
    { op: "until", probe: { op: "get", target: "$hook", property: "Visible" }, equals: false, timeout: 5, every: 0.5 },
    { op: "until", probe: { op: "python", code: dist }, above: 150, timeout: 10, every: 0.25 },
    { op: "python", code: dist, as: "_v0" },
    { op: "assert", value: "$_v0", below: 2000, knownIssue: "not yet" },
    { op: "python", code: dist, as: "d" },
    { op: "assert", value: "$d", above: 1 },
    { op: "python", code: `ctx["hook"].set_actor_location(ctx["me"].get_actor_location(), False, True)` },
    { op: "until", probe: { op: "python", code: "result = 1" }, equals: 1, timeout: 2, every: 0.25 },
  ]);
});

test("waitUntil refuses a variable (one reading), test options are checked", () => {
  const { cases, diagnostics } = compile({ "Bad.test.ts": BAD_TEST });
  const codes = diagnostics.map((d) => `${d.code} ${d.span?.line ?? 0}`);
  assert.deepEqual(codes, ["ABFC2102 7", "ABFC2102 9"]);
  assert.match(diagnostics[0]!.message, /inline h\.get/);
  assert.deepEqual(cases.map((c) => c.name), ["bad"]);
});

test("t.note reads a variable or an inline probe and labels the step", () => {
  const src = `import { test } from "@abfc/testkit";
import { BP_Relay } from "./Relay.js";

test("notes", (t) => {
  const r = t.spawn(BP_Relay);
  t.note("visible", r.get("Visible"));
  const d = t.distance(r, r);
  t.note("d", d);
  t.note("py", t.python("result = 2"));
});
`;
  const { cases, diagnostics } = compile({ "Notes.test.ts": src });
  assert.deepEqual(diagnostics, []);
  const steps = cases[0]!.steps;
  assert.deepEqual(steps.map((s) => [s.note, s.step]), [
    [undefined, { op: "spawn", class: "/TestMod/Relay/BP_Relay.BP_Relay_C", as: "r" }],
    ["visible", { op: "get", target: "$r", property: "Visible" }],
    [undefined, { op: "python", code: `result = ctx["r"].get_distance_to(ctx["r"])`, as: "d" }],
    ["d", { op: "python", code: `result = ctx["d"]` }],
    ["py", { op: "python", code: "result = 2" }],
  ]);
});
