import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestCase } from "@abfc/ir";
import { GAME_TEST_UNTIL, evaluateTest, foldReport, planGameTest } from "../src/runner.js";
import type { GameTestReportLike } from "../src/runner.js";

const span = (line: number) => ({ file: "a.test.ts", line, col: 3, endLine: line, endCol: 40 });

const tc: TestCase = {
  name: "hook",
  file: "a.test.ts",
  span: span(1),
  steps: [
    { step: { op: "spawn", class: "/M/BP_H.BP_H_C", as: "h" }, span: span(2) },
    { step: { op: "until", probe: { op: "get", target: "$h", property: "Pulling" }, equals: false, timeout: 5, every: 0.25 }, span: span(3) },
    { step: { op: "assert", value: "$h", below: 3 }, span: span(4) },
  ],
};

const report = (steps: GameTestReportLike["steps"]): GameTestReportLike => ({ steps, complete: true, timedOut: false, runtimeLog: [] });

test("with game_test_until the steps go 1:1", () => {
  const plan = planGameTest(tc, [GAME_TEST_UNTIL]);
  assert.deepEqual(plan.steps, tc.steps.map((s) => s.step));
  assert.deepEqual(plan.origin, [0, 1, 2]);
  assert.deepEqual(plan.degraded, []);
});

test("without it, until is wait + read + check and below is a python step; the report folds back", () => {
  const plan = planGameTest(tc, []);
  assert.deepEqual(plan.degraded, [1]);
  assert.deepEqual(plan.origin, [0, 1, 1, 1, 2]);
  assert.deepEqual(plan.steps.slice(1, 4), [
    { op: "wait", seconds: 5 },
    { op: "get", target: "$h", property: "Pulling", as: "_until1" },
    { op: "assert", value: "$_until1", equals: false },
  ]);
  const py = plan.steps[4] as { op: string; code: string };
  assert.equal(py.op, "python");
  assert.match(py.code, /if not \(float\(v\) < 3\.0\):/);

  const ok = foldReport(
    report([
      { i: 0, op: "spawn", ok: true, value: "<h>" },
      { i: 1, op: "wait", ok: true, value: null },
      { i: 2, op: "get", ok: true, value: true },
      { i: 3, op: "assert", ok: false, value: true },
      { i: 4, op: "python", ok: false, value: null, error: "AssertionError: expected below 3.0, got 7.0" },
    ]),
    plan,
  );
  assert.deepEqual(ok.steps.map((s) => [s.i, s.ok, s.value]), [[0, true, "<h>"], [1, false, true], [2, false, null]]);
  const ev = evaluateTest(tc, ok);
  assert.equal(ev.passed, false);
  assert.deepEqual(ev.diagnostics.map((d) => [d.code, d.span?.line, d.message]), [
    ["ABFC6101", 3, "expected false within 5 s, got true (step 1)"],
    ["ABFC6101", 4, "AssertionError: expected below 3.0, got 7.0 (step 2)"],
  ]);
});

test("a run cut short reports only the test steps whose backend steps all ran", () => {
  const plan = planGameTest(tc, []);
  const r = foldReport({ ...report([{ i: 0, op: "spawn", ok: true, value: null }, { i: 1, op: "wait", ok: true, value: null }]), complete: false, timedOut: true }, plan);
  assert.deepEqual(r.steps.map((s) => s.i), [0]);
});
