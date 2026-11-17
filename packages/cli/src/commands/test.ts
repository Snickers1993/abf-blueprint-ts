import { compileTests, loadProgram } from "@abfc/compiler";
import type { TestCase } from "@abfc/ir";
import { GAME_TEST_UNTIL, evaluateTest, foldReport, planGameTest } from "@abfc/testkit/runner";
import type { CliContext } from "../context.js";
import { SLOW_BACKEND_HINT } from "../progress.js";
import { BackendSession, Recorder, compilerConfigOf, emitAll, lockDiagnostics, since } from "./common.js";
import { runBuild } from "./build.js";
import { writeManualChecks } from "./manualchecks.js";

export interface TestSummary {
  ok: boolean;
  passed: number;
  total: number;
}

/**
 * Compiles the matching tests and runs each through `bp_game_test`. The caller decides whether to build first.
 * Returns true when every test passed (and at least the compilation was clean).
 */
export async function runTests(ctx: CliContext, session: BackendSession, rec: Recorder, pattern: string | undefined): Promise<boolean> {
  return (await runTestsWithSummary(ctx, session, rec, pattern)).ok;
}

/** `runTests` with the pass counts, for the final summary line. */
export async function runTestsWithSummary(
  ctx: CliContext,
  session: BackendSession,
  rec: Recorder,
  pattern: string | undefined,
): Promise<TestSummary> {
  const { output, config, env } = ctx;
  const mod = config.mod.name;
  const compiledTests = await ctx.progress.run(
    "Compiling tests",
    (s): { cases: TestCase[] | null } => {
      const loaded = loadProgram(ctx.projectDir);
      if (emitAll(ctx, loaded.diagnostics)) {
        s.fail("Test compilation failed");
        return { cases: null };
      }
      const compiled = compileTests(loaded, env.profile, pattern, compilerConfigOf(config));
      if (emitAll(ctx, compiled.diagnostics)) {
        s.fail("Test compilation failed");
        return { cases: null };
      }
      return { cases: compiled.cases };
    },
    { done: (r) => `Found ${r.cases === null ? 0 : r.cases.length} test(s)` },
  );
  if (compiledTests.cases === null) return { ok: false, passed: 0, total: 0 };
  const live: TestCase[] = compiledTests.cases.filter((c) => c.liveHud !== undefined);
  const cases: TestCase[] = compiledTests.cases.filter((c) => c.liveHud === undefined);
  const manualChecks = live.map((c) => ({ name: c.name, file: c.file, line: c.span.line, checklist: c.liveHud!.checklist }));
  for (const c of live) {
    output.diag({ severity: "warning", code: "ABFC6105", message: `${c.name} needs the live HUD; skipped hidden (manual check)`, span: c.span });
  }
  if (live.length > 0) output.info(`manual checks: ${writeManualChecks(ctx.projectDir, mod, live)}`);
  if (cases.length === 0) {
    if (live.length === 0) output.info(pattern === undefined ? "no tests found" : `no tests match "${pattern}"`);
    output.json(live.length > 0 ? { tests: [], manualChecks } : { tests: [] });
    return { ok: true, passed: 0, total: 0 };
  }

  const { backend, info } = await session.open("test.backendStart");
  const degraded = cases.filter((c) => planGameTest(c, info.extensions).degraded.length > 0);
  if (degraded.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC6106",
      message: `the backend has no ${GAME_TEST_UNTIL}: t.waitUntil waits its whole timeout and looks once (${degraded.map((c) => c.name).join(", ")}).`,
    });
  }
  let failed = 0;
  const results: Array<{ name: string; passed: boolean; ok: number; steps: number; seconds: number }> = [];
  for (const [i, tc] of cases.entries()) {
    const t0 = performance.now();
    const step = ctx.progress.start(`Running ${tc.name} (${i + 1}/${cases.length})`, { slowHint: SLOW_BACKEND_HINT });
    const plan = planGameTest(tc, info.extensions);
    let report;
    try {
      const o: { timeoutSeconds: number; map?: string } = { timeoutSeconds: tc.timeoutSeconds ?? 180 };
      if (tc.map !== undefined) o.map = tc.map;
      report = foldReport(await backend.gameTest(mod, plan.steps, o), plan);
    } catch (e) {
      step.fail();
      throw e;
    }
    step.dismiss();
    const ev = evaluateTest(tc, report);
    rec.record(`test.${tc.name}`, since(t0), ev.passed, tc.steps.length);
    output.info(`${ev.passed ? "PASS" : "FAIL"} ${tc.name} (${ev.summary.ok}/${tc.steps.length}, ${report.seconds.toFixed(1)} s)`, ev.passed ? "ok" : "fail");
    for (const [k, rec] of tc.steps.entries()) {
      if (rec.note === undefined) continue;
      const got = report.steps.find((s) => s.i === k);
      const shown = got === undefined ? "(not reached)" : got.error !== undefined ? `error: ${got.error}` : JSON.stringify(got.value) ?? String(got.value);
      output.info(`  note ${tc.file}:${rec.span.line} ${rec.note}: ${shown}`);
    }
    for (const d of ev.diagnostics) output.diag(d);
    if (!ev.passed) failed++;
    results.push({ name: tc.name, passed: ev.passed, ok: ev.summary.ok, steps: tc.steps.length, seconds: report.seconds });
  }
  output.info(`${cases.length - failed} of ${cases.length} test(s) passed`, failed === 0 ? "ok" : "fail");
  output.json(live.length > 0 ? { tests: results, manualChecks } : { tests: results });
  return { ok: failed === 0, passed: cases.length - failed, total: cases.length };
}

/** `abfc test [pattern] [--no-build]`. */
export async function test(ctx: CliContext): Promise<number> {
  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  try {
    if (!ctx.args.flags.noBuild) {
      if (!(await runBuild(ctx, session, rec))) {
        ctx.progress.summary(false, "Build failed", "tests not run");
        return ctx.output.exitCode() || 1;
      }
    } else if (emitAll(ctx, lockDiagnostics(ctx, "build"))) {
      return ctx.output.exitCode();
    }
    const s = await runTestsWithSummary(ctx, session, rec, ctx.args.positionals[0]);
    if (!s.ok && ctx.output.exitCode() === 0) {
      // a failed test is an error even when every diagnostic of it was a warning
      ctx.output.diag({ severity: "error", code: "ABFC6104", message: "one or more tests failed." });
    }
    if (s.total === 0) {
      if (s.ok) ctx.progress.summary(true, "No tests to run");
      else ctx.progress.summary(false, "Tests not run", "see the errors above");
    } else {
      ctx.progress.summary(s.ok, `${s.passed} of ${s.total} tests passed`);
    }
  } finally {
    await session.close();
    rec.print();
  }
  return ctx.output.exitCode();
}
