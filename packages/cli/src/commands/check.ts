import { watch as fsWatch } from "node:fs";
import { join, relative } from "node:path";
import { blockedMemberHits, checkProject, loadProgram } from "@abfc/compiler";
import type { LoadedProgram } from "@abfc/compiler";
import { AbfcError } from "@abfc/env";
import { loadContext } from "../context.js";
import type { CliContext, CliDeps } from "../context.js";
import { Output } from "../output.js";
import { Recorder, compilerConfigOf, countUnits, emitAll, hasErrors, lockDiagnostics, since } from "./common.js";

/**
 * Lock check, TypeScript check, HIR, lowering and test compilation. Returns true when there is no error.
 * `state` carries the previous TypeScript program between runs (watch mode) and is updated.
 */
export async function runCheck(ctx: CliContext, rec: Recorder, state?: { oldProgram?: LoadedProgram["program"] }): Promise<boolean> {
  const t0 = performance.now();
  if (emitAll(ctx, lockDiagnostics(ctx, "check"))) {
    rec.record("check.frontend", since(t0), false);
    return false;
  }
  const { result, ok } = await ctx.progress.run(
    "Checking TypeScript",
    (s) => {
      const loaded = loadProgram(ctx.projectDir, state?.oldProgram);
      if (state) state.oldProgram = loaded.program;
      emitAll(ctx, loaded.diagnostics);
      const result = checkProject(loaded, compilerConfigOf(ctx.config), ctx.env.profile);
      emitAll(ctx, result.diagnostics);
      // Blueprint filter hits are errors at publish (gate 2) only; check shows them as warnings so they are seen before a build
      emitAll(ctx, blockedMemberHits(loaded).map((d) => ({ ...d, severity: "warning" as const })));
      const ok = result.ir !== null && !hasErrors(ctx);
      if (!ok) s.fail("TypeScript has errors");
      return { result, ok };
    },
    { done: (r) => `Checked ${r.result.ir === null ? 0 : countUnits(r.result.ir)} unit(s), ${r.result.tests} test(s)` },
  );
  rec.record("check.frontend", since(t0), ok, result.ir === null ? 0 : countUnits(result.ir));
  if (ok && result.ir !== null) {
    const units = countUnits(result.ir);
    ctx.output.info(`checked ${units} unit(s) in ${result.ir.assets.length} asset(s), ${result.tests} test(s): no errors`, "ok");
    ctx.output.json({ assets: result.ir.assets.map((a) => ({ asset: a.path, units: a.units.map((u) => u.id) })), tests: result.tests });
  }
  return ok;
}

const DEBOUNCE_MS = 150;

/** Says whether a change to `rel` (project-relative, forward slashes) can change the result of `abfc check`. */
function isRelevantChange(rel: string): boolean {
  if (rel === "" || rel.startsWith("../") || /^[a-zA-Z]:/.test(rel)) return false;
  const parts = rel.split("/");
  if (parts.includes("node_modules")) return false;
  const base = parts[parts.length - 1] ?? "";
  if (rel === "abf.config.json" || rel === ".abfc/tsconfig.paths.json") return true;
  if (rel.startsWith(".abfc/manifest/")) return true;
  if (/^\.abfc\/stubs\/[^/]+\/stubs\.lock\.json$/.test(rel)) return true;
  if (rel.startsWith(".abfc/") && !rel.startsWith(".abfc/stubs/")) return false;
  if (rel.endsWith(".ts")) return true;
  return !rel.startsWith(".abfc/") && /^tsconfig.*\.json$/.test(base);
}

function defaultWatch(dir: string, onChange: (file: string) => void): { close(): void } {
  const watcher = fsWatch(dir, { recursive: true }, (_event, name) => {
    if (name !== null) onChange(join(dir, name.toString()));
  });
  watcher.on("error", () => undefined);
  return watcher;
}

function sigintSignal(): AbortSignal {
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  return ac.signal;
}

/**
 * `abfc check --watch`: checks once, then again after every relevant change (debounced; a change during a run
 * triggers one more run after it). Resolves 0 when `signal` aborts.
 */
export async function runWatch(ctx: CliContext, watch: NonNullable<CliDeps["watch"]>, signal: AbortSignal): Promise<number> {
  const state: { oldProgram?: LoadedProgram["program"] } = {};
  let base = ctx;
  let configChanged = false;

  const runOnce = async (): Promise<void> => {
    if (configChanged) {
      configChanged = false;
      try {
        base = loadContext(ctx.args, ctx.deps);
      } catch {
        // keep the previous configuration; the check below reports what is wrong with the project
      }
    }
    const run: CliContext = {
      ...base,
      output: new Output({ command: "check", json: false, projectDir: base.projectDir, stdout: ctx.deps.stdout, stderr: ctx.deps.stderr }),
    };
    run.output.info("[abfc] check started");
    const t0 = performance.now();
    try {
      await runCheck(run, new Recorder(run), state);
    } catch (e) {
      if (e instanceof AbfcError) run.output.diag(e.diagnostic);
      else run.output.diag({ severity: "error", code: "ABFC4002", message: `unexpected failure: ${e instanceof Error ? e.message : String(e)}` });
    }
    const errors = run.output.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = run.output.diagnostics.length - errors;
    run.output.info(`[abfc] check finished: ${errors} error(s), ${warnings} warning(s) in ${since(t0).toFixed(2)} s`);
  };

  let running: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = async (): Promise<void> => {
    do {
      again = false;
      await runOnce();
    } while (again && !signal.aborted);
  };
  const start = (): void => {
    if (signal.aborted) return;
    if (running !== null) {
      again = true;
      return;
    }
    running = loop().finally(() => {
      running = null;
    });
  };

  const watcher = watch(ctx.projectDir, (file) => {
    const rel = relative(ctx.projectDir, file).replaceAll("\\", "/");
    if (!isRelevantChange(rel)) return;
    if (rel === "abf.config.json") configChanged = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      start();
    }, DEBOUNCE_MS);
  });

  start();
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  if (timer !== null) clearTimeout(timer);
  watcher.close();
  if (running !== null) await running;
  return 0;
}

/** `abfc check`: no backend needed. */
export async function check(ctx: CliContext): Promise<number> {
  if (ctx.args.flags.watch) return runWatch(ctx, ctx.deps.watch ?? defaultWatch, ctx.deps.stopSignal ?? sigintSignal());
  const rec = new Recorder(ctx);
  await runCheck(ctx, rec);
  rec.print();
  const code = ctx.output.exitCode();
  ctx.progress.summary(code === 0, code === 0 ? "Check passed" : "Check failed");
  return code;
}
