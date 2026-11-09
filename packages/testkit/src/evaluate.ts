import type { Diagnostic, TestCase } from "@abfc/ir";

/** The part of the backend's `bp_game_test` report that evaluation needs. */
export interface GameTestReportLike {
  steps: Array<{ i: number; op: string; ok: boolean; value: unknown; error?: string }>;
  complete: boolean;
  timedOut: boolean;
  runtimeLog: string[];
  error?: string;
}

export interface TestEvaluation {
  passed: boolean;
  diagnostics: Diagnostic[];
  summary: { ok: number; failed: number; knownIssues: number };
}

const show = (v: unknown): string => {
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

function expectation(step: Record<string, unknown>): string {
  const within = step.op === "until" ? ` within ${show(step.timeout)} s` : "";
  if ("equals" in step) return `expected ${show(step.equals)}${within}`;
  if ("approx" in step) return `expected approx ${show(step.approx)}${within}`;
  if ("contains" in step) return `expected to contain ${show(step.contains)}${within}`;
  if ("below" in step) return `expected below ${show(step.below)}${within}`;
  if ("above" in step) return `expected above ${show(step.above)}${within}`;
  if ("not_none" in step) return `expected a value (not None)${within}`;
  return `expected a truthy value${within}`;
}

/**
 * Judges one test against the backend report. Step `i` of the report is step `i` of `tc` (the order of
 * {@link toGameTestSteps}). A failing step is ABFC6101 at its span unless it is a known issue (warning ABFC6102); a known
 * issue that passes is warning ABFC6103. An incomplete or timed-out run is ABFC6104; runtime log lines are warnings ABFC6201.
 */
export function evaluateTest(tc: TestCase, r: GameTestReportLike): TestEvaluation {
  const diagnostics: Diagnostic[] = [];
  const summary = { ok: 0, failed: 0, knownIssues: 0 };
  const byIndex = new Map(r.steps.map((s) => [s.i, s]));

  tc.steps.forEach((rec, i) => {
    const got = byIndex.get(i);
    if (got === undefined) {
      if (r.complete) {
        summary.failed++;
        diagnostics.push({
          severity: "error",
          code: "ABFC6104",
          message: `test "${tc.name}": the backend reported no result for step ${i}.`,
          span: rec.span,
        });
      }
      return;
    }
    const known = rec.knownIssue;
    if (known !== undefined) summary.knownIssues++;
    if (got.ok) {
      summary.ok++;
      if (known !== undefined) {
        diagnostics.push({
          severity: "warning",
          code: "ABFC6103",
          message: `known issue now passes (step ${i}): ${known}`,
          span: rec.span,
        });
      }
      return;
    }
    const message = got.error !== undefined ? `${got.error} (step ${i})` : `${expectation(rec.step)}, got ${show(got.value)} (step ${i})`;
    if (known !== undefined) {
      diagnostics.push({ severity: "warning", code: "ABFC6102", message: `known issue still fails: ${message} - ${known}`, span: rec.span });
      return;
    }
    summary.failed++;
    diagnostics.push({ severity: "error", code: "ABFC6101", message, span: rec.span });
  });

  if (!r.complete || r.timedOut) {
    diagnostics.push({
      severity: "error",
      code: "ABFC6104",
      message:
        `test "${tc.name}" did not finish` +
        (r.timedOut ? " (timed out)" : "") +
        (r.error !== undefined ? `: ${r.error}` : "") +
        ".",
      span: tc.span,
    });
  }
  for (const line of r.runtimeLog) {
    diagnostics.push({ severity: "warning", code: "ABFC6201", message: line });
  }
  const passed = summary.failed === 0 && r.complete && !r.timedOut;
  return { passed, diagnostics, summary };
}
