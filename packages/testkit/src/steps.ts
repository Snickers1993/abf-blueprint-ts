import type { TestCase } from "@abfc/ir";
import type { GameTestReportLike } from "./evaluate.js";

/** The backend extension feature (`abfc_extensions`) of a `bp_game_test` that runs `until` steps and `below`/`above` asserts. */
export const GAME_TEST_UNTIL = "game_test_until";

/** The `bp_game_test` steps of a compiled test, in order, as a backend with every step op runs them. */
export function toGameTestSteps(tc: TestCase): unknown[] {
  return tc.steps.map((s) => s.step);
}

/** What a run sends: the steps, and for each the index of the test step it belongs to. */
export interface GameTestPlan {
  steps: unknown[];
  /** `origin[k]` = the test step that backend step `k` belongs to. */
  origin: number[];
  /** Test steps that run in a weaker form on this backend (an `until` without the `game_test_until` feature). */
  degraded: number[];
}

const CHECK_KEYS = ["equals", "approx", "tolerance", "contains", "truthy", "not_none", "below", "above"] as const;

const pyNum = (n: unknown): string => {
  const v = Number(n);
  return Number.isInteger(v) && Math.abs(v) < 1e15 ? `${v}.0` : String(v);
};

/** A `below`/`above` assert as a python step (raises AssertionError), for a backend whose assert has neither. */
function comparePython(value: string, key: "below" | "above", bound: unknown): Record<string, unknown> {
  const name = JSON.stringify(value.startsWith("$") ? value.slice(1) : value);
  const op = key === "below" ? "<" : ">";
  return {
    op: "python",
    code: [
      `v = ctx[${name}]`,
      `if not (float(v) ${op} ${pyNum(bound)}):`,
      `    raise AssertionError("expected ${key} ${pyNum(bound)}, got %r" % (v,))`,
      "result = v",
    ].join("\n"),
  };
}

function lowerAssert(step: Record<string, unknown>, until: boolean): Record<string, unknown> {
  if (until) return step;
  for (const key of ["below", "above"] as const) if (key in step) return comparePython(String(step.value), key, step[key]);
  return step;
}

/**
 * The steps of a compiled test for a backend with the given extension features. With `game_test_until` the steps go 1:1.
 * Without it, `until` becomes "wait the whole timeout, read once, check" (the condition must still hold at the end) and
 * `below`/`above` asserts become python steps.
 */
export function planGameTest(tc: TestCase, features: readonly string[]): GameTestPlan {
  const until = features.includes(GAME_TEST_UNTIL);
  const plan: GameTestPlan = { steps: [], origin: [], degraded: [] };
  tc.steps.forEach((rec, i) => {
    const step = rec.step;
    const push = (s: Record<string, unknown>): void => {
      plan.steps.push(s);
      plan.origin.push(i);
    };
    if (step.op === "until" && !until) {
      plan.degraded.push(i);
      const as = `_until${i}`;
      push({ op: "wait", seconds: step.timeout ?? 10 });
      push({ ...(step.probe as Record<string, unknown>), as });
      const check: Record<string, unknown> = { op: "assert", value: `$${as}` };
      for (const k of CHECK_KEYS) if (k in step) check[k] = step[k];
      push(lowerAssert(check, false));
    } else if (step.op === "assert") {
      push(lowerAssert(step, until));
    } else {
      push(step);
    }
  });
  return plan;
}

/** The report of a planned run with one entry per test step: ok when all of its backend steps were, the last value, the first error. */
export function foldReport<R extends GameTestReportLike>(r: R, plan: GameTestPlan): R {
  const folded = new Map<number, GameTestReportLike["steps"][number]>();
  for (const s of r.steps) {
    const i = plan.origin[s.i];
    if (i === undefined) continue;
    const prev = folded.get(i);
    if (prev === undefined) {
      folded.set(i, { ...s, i });
      continue;
    }
    const next: GameTestReportLike["steps"][number] = { i, op: prev.op, ok: prev.ok && s.ok, value: s.value };
    const error = prev.error ?? s.error;
    if (error !== undefined) next.error = error;
    folded.set(i, next);
  }
  // a test step is reported only when all of its backend steps were
  const counts = new Map<number, number>();
  for (const o of plan.origin) counts.set(o, (counts.get(o) ?? 0) + 1);
  const seen = new Map<number, number>();
  for (const s of r.steps) {
    const i = plan.origin[s.i];
    if (i !== undefined) seen.set(i, (seen.get(i) ?? 0) + 1);
  }
  const steps = [...folded.values()].filter((s) => s.ok === false || seen.get(s.i) === counts.get(s.i)).sort((a, b) => a.i - b.i);
  return { ...r, steps };
}
