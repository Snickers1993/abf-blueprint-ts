import { win32 } from "node:path";
import type { Backend } from "@abfc/backend";
import { assertNotInModFolder, cleanBundledRuntimes, findProjectDir, installInfo, resolveEnvironment, verifyBundledRuntime } from "@abfc/env";
import type { Environment, Host, InstallInfo, ProjectConfig } from "@abfc/env";
import type { ParsedArgs } from "./args.js";
import type { CliFlags } from "./args.js";
import { Output } from "./output.js";
import { Progress, lineTerminal, progressMode, realClock } from "./progress.js";
import type { ProgressClock, Terminal } from "./progress.js";
import { colorEnabled, makeStyler } from "./style.js";
import type { Styler } from "./style.js";

export interface BackendStartOptions {
  cold?: boolean | undefined;
  /** Receives every line the backend server writes to stderr. */
  onStderr?: ((line: string) => void) | undefined;
}

/** Everything with side effects that tests replace. */
export interface CliDeps {
  host: Host;
  startBackend: (env: Environment, o?: BackendStartOptions) => Promise<Backend>;
  now: () => Date;
  /** Lists the files below a mod folder for the publish file check (default: a read-only walk of the real file system). */
  listFiles?: ((root: string) => Array<{ rel: string; size: number }>) | undefined;
  /**
   * Watches a folder tree for `abfc check --watch` and calls `onChange` with the absolute path of every changed file
   * (default: `fs.watch(dir, { recursive: true })`).
   */
  watch?: ((dir: string, onChange: (file: string) => void) => { close(): void }) | undefined;
  /** Ends `abfc check --watch` when aborted (default: aborted by SIGINT). */
  stopSignal?: AbortSignal | undefined;
  /** Folder the command line is relative to (default: `process.cwd()`). */
  cwd?: string | undefined;
  stdout?: ((line: string) => void) | undefined;
  stderr?: ((line: string) => void) | undefined;
  /** File writes of `abfc init` (default: `node:fs`; `writeFile` creates no folders, `mkdir` creates them recursively). */
  fs?: { writeFile(p: string, text: string): void; mkdir(p: string): void } | undefined;
  /** Asks one question and returns the answer (default: `node:readline/promises` on stdin and stdout). */
  prompt?: ((question: string) => Promise<string>) | undefined;
  /** Whether `abfc init` may ask questions (default: stdin and stdout are both terminals). */
  interactive?: boolean | undefined;
  /** Streams `abfc lsp` speaks on (default: stdin and stdout). */
  lspStreams?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } | undefined;
  /** How this abfc is installed and its extracted runtime (default: the `@abfc/env` functions; tests replace it). */
  install?:
    | {
        info(): InstallInfo;
        verify(deep: boolean): ReturnType<typeof verifyBundledRuntime>;
        clean(): ReturnType<typeof cleanBundledRuntimes>;
      }
    | undefined;
  /** Where progress is drawn (default: stderr, or a plain line terminal over `stderr` when that is injected). */
  term?: Terminal | undefined;
  /** Timer source for progress (default: real timers). */
  clock?: ProgressClock | undefined;
}

/** The install functions of `deps`, or the real ones. */
export function installOf(deps: CliDeps): NonNullable<CliDeps["install"]> {
  return deps.install ?? { info: installInfo, verify: verifyBundledRuntime, clean: cleanBundledRuntimes };
}

/** Progress and color settings for one run. */
export interface Ui {
  progress: Progress;
  stdoutStyle: Styler;
  stderrStyle: Styler;
}

export function createUi(flags: CliFlags, term: Terminal, clock: ProgressClock): Ui {
  const stderrStyle = makeStyler(!flags.json && colorEnabled(term.env, term.isTTY));
  const stdoutStyle = makeStyler(!flags.json && colorEnabled(term.env, term.stdoutIsTTY));
  const progress = new Progress({
    mode: progressMode(flags, term),
    term,
    style: stderrStyle,
    clock,
    notes: flags.verbose && !flags.json,
  });
  return { progress, stdoutStyle, stderrStyle };
}

export interface CliPaths {
  abfcDir: string;
  cacheDir: string;
  stubsDir: string;
  manifestDir: string;
  sourcemapDir: string;
  runsFile: string;
  /** Files `staging_refresh` copied into the stage that no build has applied the TypeScript on top of yet. */
  stageRefreshedFile: string;
}

export interface CliContext {
  args: ParsedArgs;
  deps: CliDeps;
  projectDir: string;
  config: ProjectConfig;
  env: Environment;
  output: Output;
  progress: Progress;
  paths: CliPaths;
}

export function pathsFor(projectDir: string): CliPaths {
  const abfcDir = win32.join(projectDir, ".abfc");
  return {
    abfcDir,
    cacheDir: win32.join(abfcDir, "cache"),
    stubsDir: win32.join(abfcDir, "stubs"),
    manifestDir: win32.join(abfcDir, "manifest"),
    sourcemapDir: win32.join(abfcDir, "sourcemaps"),
    runsFile: win32.join(abfcDir, "runs.jsonl"),
    stageRefreshedFile: win32.join(abfcDir, "stage-refreshed.json"),
  };
}

/**
 * Finds the project (`--project` or the working folder, walking up to `abf.config.json`), refuses a project inside a mod
 * folder (ABFC1020) and resolves the environment. Throws AbfcError only for ABFC1020 and ABFC1021.
 */
export function loadContext(args: ParsedArgs, deps: CliDeps, ui?: Ui): CliContext {
  const start = args.flags.project ?? deps.cwd ?? process.cwd();
  const projectDir = findProjectDir(start, (p) => deps.host.exists(p));
  assertNotInModFolder(deps.host, projectDir);
  const f = args.flags;
  const flags: Parameters<typeof resolveEnvironment>[1]["flags"] = {};
  if (f.editorRoot !== undefined) flags.editorRoot = f.editorRoot;
  if (f.modsDir !== undefined) flags.modsDir = f.modsDir;
  if (f.modDir !== undefined) flags.modDir = f.modDir;
  if (f.backendDir !== undefined) flags.backendDir = f.backendDir;
  if (f.python !== undefined) flags.python = f.python;
  if (f.headlessDir !== undefined) flags.headlessDir = f.headlessDir;
  const env = resolveEnvironment(deps.host, { projectDir, flags });
  const { progress, stdoutStyle, stderrStyle } = ui ?? createUi({ ...f, quiet: true }, lineTerminal(() => {}), realClock());
  const output = new Output({
    command: args.command ?? "",
    json: f.json,
    projectDir,
    stdout: deps.stdout,
    stderr: deps.stderr,
    progress,
    stdoutStyle,
    stderrStyle,
  });
  // The environment's other diagnostics are shown by `abfc doctor`; a mod name in the wrong case is corrected silently otherwise.
  if (args.command !== "doctor") for (const d of env.diagnostics) if (d.code === "ABFC1045") output.diag(d);
  return { args, deps, projectDir, config: env.config, env, output, progress, paths: pathsFor(projectDir) };
}
