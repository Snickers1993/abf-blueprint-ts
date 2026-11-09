import { startBackend } from "@abfc/backend";
import { AbfcError, cleanBundledRuntimes, installInfo, realHost, verifyBundledRuntime } from "@abfc/env";
import { parseCliArgs, UsageError } from "./args.js";
import type { ParsedArgs } from "./args.js";
import { adopt } from "./commands/adopt.js";
import { build } from "./commands/build.js";
import { check } from "./commands/check.js";
import { cleanRuntimesCommand, doctor } from "./commands/doctor.js";
import { generate } from "./commands/generate.js";
import { runInit } from "./commands/init.js";
import { runLsp } from "./commands/lsp.js";
import { publish } from "./commands/publish.js";
import { status } from "./commands/status.js";
import { test } from "./commands/test.js";
import { createUi, loadContext } from "./context.js";
import type { CliContext, CliDeps } from "./context.js";
import { acquireProjectLock, LOCKED_COMMANDS } from "./lock.js";
import type { ProjectLock } from "./lock.js";
import { Output } from "./output.js";
import { lineTerminal, processTerminal, realClock } from "./progress.js";
import { ABFC_VERSION } from "./version.js";

export type CommandFn = (ctx: CliContext) => Promise<number>;

export const COMMANDS: Record<string, CommandFn> = {
  doctor,
  generate,
  check,
  build,
  test,
  status,
  adopt,
  publish,
};

/** Hidden, deprecated command names: still accepted with a warning on stderr, never listed in the usage text. */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = { stubs: "generate" };

const USAGE = [
  "usage: abfc <command> [options]",
  "commands: init, lsp, version, " + Object.keys(COMMANDS).join(", "),
  "options: --json --verbose --quiet --project <dir> --editor-root <dir> --mods-dir <dir> --mod-dir <dir>",
  "         --backend-dir <dir> --python <exe> --headless-dir <dir> --timings --resync --no-build --yes --dry-run --full --discard-editor-changes --cold --watch (check)",
  "         --drift --full (build: every asset from the editor, no read cache) --keep-failed-stage (build, test, publish)",
  "output:  results on stdout; diagnostics and progress on stderr (live on a terminal, one line per step otherwise); -q/--quiet hides progress, --json prints one JSON document and no progress",
  "generate: abfc generate [--add <path>]... [--refresh] [--resync]",
  "doctor:  abfc doctor [--deep] [--clean-runtimes]",
  "init:    abfc init [dir] [--mod <name>] [--yes] [--no-generate] [--mods-dir <dir>] [--editor-root <dir>] [--backend-dir <dir>] [--python <exe>]",
  "lsp:     abfc lsp [--stdio]   language server over stdio (docs/language-service.md)",
  "version: abfc version [--json] | abfc --version",
];

export function defaultDeps(): CliDeps {
  return {
    host: realHost(),
    startBackend: (env, o) => startBackend(env, o),
    now: () => new Date(),
    install: { info: installInfo, verify: verifyBundledRuntime, clean: cleanBundledRuntimes },
  };
}

/** Runs one command line and returns the process exit code. Never throws. */
export async function main(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  const out = deps.stdout ?? ((line: string): void => void process.stdout.write(line + "\n"));
  const err = deps.stderr ?? ((line: string): void => void process.stderr.write(line + "\n"));

  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`abfc: error: ${e.message}`);
      for (const l of USAGE) err(l);
      return 2;
    }
    throw e;
  }

  const command = args.command;
  if (args.flags.version && command !== null && command !== "version") {
    err(`abfc: error: --version is not an option of abfc ${command}`);
    for (const l of USAGE) err(l);
    return 2;
  }
  if (command === "version" || args.flags.version) {
    const kind = deps.install?.info().kind ?? "source";
    if (args.flags.json) {
      out(JSON.stringify({ version: ABFC_VERSION, install: kind, node: process.versions.node }));
    } else {
      out(`abfc ${ABFC_VERSION} (${kind === "exe" ? "exe" : "source install"}, node ${process.versions.node})`);
    }
    return 0;
  }
  if (command === null) {
    for (const l of USAGE) out(l);
    return 0;
  }
  if (command === "init" && args.flags.noStubsAlias) err("abfc: warning: --no-stubs is deprecated; use --no-generate");
  if (command === "init") {
    try {
      return await runInit(args, deps);
    } catch (e) {
      const output = new Output({ command, json: args.flags.json, projectDir: args.flags.project, stdout: deps.stdout, stderr: deps.stderr });
      output.diag({
        severity: "error",
        code: "ABFC4002",
        message: `unexpected failure: ${e instanceof Error ? (args.flags.verbose ? (e.stack ?? e.message) : e.message) : String(e)}`,
      });
      output.finish();
      return 2;
    }
  }
  if (command === "lsp") {
    try {
      return await runLsp(args, deps);
    } catch (e) {
      err(`abfc: error: language server failed: ${e instanceof Error ? (args.flags.verbose ? (e.stack ?? e.message) : e.message) : String(e)}`);
      return 2;
    }
  }
  if (command === "doctor" && args.flags.cleanRuntimes) {
    try {
      return cleanRuntimesCommand(args, deps);
    } catch (e) {
      err(`abfc: error: could not clean the runtime folders: ${e instanceof Error ? (args.flags.verbose ? (e.stack ?? e.message) : e.message) : String(e)}`);
      return 2;
    }
  }
  const alias = Object.hasOwn(COMMAND_ALIASES, command) ? COMMAND_ALIASES[command] : undefined;
  if (alias !== undefined) err(`abfc: warning: "abfc ${command}" is deprecated; use "abfc ${alias}"`);
  const name = alias ?? command;
  const run = COMMANDS[name];
  if (run === undefined) {
    err(`abfc: error: unknown or not yet available command "${command}"`);
    for (const l of USAGE) err(l);
    return 2;
  }

  const term = deps.term ?? (deps.stderr !== undefined ? lineTerminal(deps.stderr) : processTerminal(deps.stdout === undefined));
  // `check --watch` loops and prints its own [abfc] lines: no header, steps or "done in" around it.
  const watching = name === "check" && args.flags.watch;
  const ui = createUi(watching ? { ...args.flags, quiet: true } : args.flags, term, deps.clock ?? realClock());

  let ctx: CliContext | null = null;
  let lock: ProjectLock | null = null;
  try {
    ctx = loadContext(args, deps, ui);
    if (LOCKED_COMMANDS.includes(name)) lock = acquireProjectLock(ctx.projectDir, name, deps.now());
    if (name !== "doctor") ctx.progress.header(name, [`profile ${ctx.env.profile.id}`, `mod ${ctx.config.mod.name}`]);
    await run(ctx);
    return ctx.output.finish();
  } catch (e) {
    const output =
      ctx?.output ??
      new Output({
        command,
        json: args.flags.json,
        projectDir: args.flags.project,
        stdout: deps.stdout,
        stderr: deps.stderr,
        stdoutStyle: ui.stdoutStyle,
        stderrStyle: ui.stderrStyle,
      });
    if (e instanceof UsageError) {
      output.finish();
      err(`abfc: error: ${e.message}`);
      for (const l of USAGE) err(l);
      return 2;
    }
    if (e instanceof AbfcError) {
      output.diag(e.diagnostic);
      output.finish();
      return Math.max(e.exitCode, output.exitCode());
    }
    output.diag({
      severity: "error",
      code: "ABFC4002",
      message: `unexpected failure: ${e instanceof Error ? (args.flags.verbose ? (e.stack ?? e.message) : e.message) : String(e)}`,
    });
    output.finish();
    return 2;
  } finally {
    lock?.release();
    // no project: nothing ran, so no header and no "done in"
    if (ctx === null) ui.progress.dispose();
    else ui.progress.finish();
  }
}
