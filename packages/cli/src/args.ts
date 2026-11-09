import { parseArgs } from "node:util";

export interface CliFlags {
  json: boolean;
  verbose: boolean;
  /** `-q`/`--quiet`: hide the header, steps, summary and `done in` (results and diagnostics still print). */
  quiet: boolean;
  project: string | undefined;
  editorRoot: string | undefined;
  modsDir: string | undefined;
  modDir: string | undefined;
  backendDir: string | undefined;
  python: string | undefined;
  headlessDir: string | undefined;
  timings: boolean;
  resync: boolean;
  noBuild: boolean;
  yes: boolean;
  discardEditorChanges: boolean;
  dryRun: boolean;
  /** `--full`: `abfc publish` runs the release checks (tests, stage audit, upload file check) before the copy; `abfc build` reads every owned asset from the editor (no read cache); `abfc generate` reads every hand-made mod asset again. */
  full: boolean;
  /** `--cold`: do not use the backend warm session (one editor start per operation). */
  cold: boolean;
  /** `--remove-node <name>` (repeatable): extra nodes `abfc adopt` removes with the unit. */
  removeNode: string[];
  /** `--watch`: `abfc check` stays running and checks again after every relevant file change. */
  watch: boolean;
  /** `--mod <name>`: the mod `abfc init` links the project to. */
  mod: string | undefined;
  /** `--no-generate` (or the deprecated `--no-stubs`): `abfc init` does not run `abfc generate`. */
  noGenerate: boolean;
  /** The deprecated `--no-stubs` spelling was used (main prints a warning). */
  noStubsAlias: boolean;
  /** `--deep`: `abfc doctor` checks the extracted runtime by sha256 (abfc.exe). */
  deep: boolean;
  /** `--clean-runtimes`: `abfc doctor` deletes the old extracted runtime folders (works outside a project). */
  cleanRuntimes: boolean;
  /** `--version`: print the abfc version (same as `abfc version`). */
  version: boolean;
  /** `--drift`: `abfc build` reads and drift-checks every owned asset, not only the changed ones. */
  drift: boolean;
  /** `--keep-failed-stage`: after an Unreal compile failure the stage keeps the failed graphs (no re-sync). */
  keepFailedStage: boolean;
  /** `--replace-editor-edits`: with `protectEditorEdits` on, this build replaces hand-made work anyway (TypeScript wins, ABFC5014). */
  replaceEditorEdits: boolean;
  /** `--add <path>` (repeatable): `abfc generate` also generates stubs for this class, struct or enum (`/Script/<Package>.<Name>`, a `/Game/...` class or module). */
  add: string[];
  /** `--refresh`: `abfc generate` discards the cached class catalog and reflect data and generates everything again. */
  refresh: boolean;
}

export interface ParsedArgs {
  /** First positional, or null when none was given. */
  command: string | null;
  /** Positionals after the command. */
  positionals: string[];
  flags: CliFlags;
}

/** Thrown for a malformed command line (unknown option, missing value); `main` prints it and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        verbose: { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        project: { type: "string" },
        "editor-root": { type: "string" },
        "mods-dir": { type: "string" },
        "mod-dir": { type: "string" },
        "backend-dir": { type: "string" },
        python: { type: "string" },
        "headless-dir": { type: "string" },
        timings: { type: "boolean" },
        resync: { type: "boolean" },
        "no-build": { type: "boolean" },
        yes: { type: "boolean" },
        "discard-editor-changes": { type: "boolean" },
        "dry-run": { type: "boolean" },
        full: { type: "boolean" },
        cold: { type: "boolean" },
        "remove-node": { type: "string", multiple: true },
        watch: { type: "boolean" },
        mod: { type: "string" },
        "no-generate": { type: "boolean" },
        "no-stubs": { type: "boolean" },
        deep: { type: "boolean" },
        "clean-runtimes": { type: "boolean" },
        version: { type: "boolean" },
        drift: { type: "boolean" },
        "keep-failed-stage": { type: "boolean" },
        "replace-editor-edits": { type: "boolean" },
        add: { type: "string", multiple: true },
        refresh: { type: "boolean" },
        // `abfc lsp` accepts what language clients add; the values are ignored
        stdio: { type: "boolean" },
        clientProcessId: { type: "string" },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const v = parsed.values;
  const [command, ...positionals] = parsed.positionals;
  if (command === "check" && v.watch === true && v.json === true) throw new UsageError("--watch cannot be combined with --json");
  if (v.drift === true && command !== "build") throw new UsageError("--drift is an option of abfc build only");
  if (v["keep-failed-stage"] === true && command !== "build" && command !== "test" && command !== "publish") {
    throw new UsageError("--keep-failed-stage is an option of abfc build, test and publish");
  }
  if ((v.add !== undefined || v.refresh === true) && command !== "generate" && command !== "stubs") throw new UsageError("--add and --refresh are options of abfc generate");
  return {
    command: command ?? null,
    positionals,
    flags: {
      json: v.json === true,
      verbose: v.verbose === true,
      quiet: v.quiet === true,
      project: v.project,
      editorRoot: v["editor-root"],
      modsDir: v["mods-dir"],
      modDir: v["mod-dir"],
      backendDir: v["backend-dir"],
      python: v.python,
      headlessDir: v["headless-dir"],
      timings: v.timings === true,
      resync: v.resync === true,
      noBuild: v["no-build"] === true,
      yes: v.yes === true,
      discardEditorChanges: v["discard-editor-changes"] === true,
      dryRun: v["dry-run"] === true,
      full: v.full === true,
      cold: v.cold === true,
      removeNode: v["remove-node"] ?? [],
      watch: v.watch === true,
      mod: v.mod,
      noGenerate: v["no-generate"] === true || v["no-stubs"] === true,
      noStubsAlias: v["no-stubs"] === true,
      deep: v.deep === true,
      cleanRuntimes: v["clean-runtimes"] === true,
      version: v.version === true,
      drift: v.drift === true,
      keepFailedStage: v["keep-failed-stage"] === true,
      replaceEditorEdits: v["replace-editor-edits"] === true,
      add: v.add ?? [],
      refresh: v.refresh === true,
    },
  };
}
