# Command line reference

`abfc` is one executable with a handful of commands. This page lists every command, every option, the exit codes and the shape of the `--json` output. For a guided first run see [first-mod.md](first-mod.md); for what an `ABFCnnnn` code means see [errors.md](errors.md).

```
abfc <command> [options]
```

Run `abfc` without a command to print the usage text (exit 0).

| Command | Needs a project | Starts the backend | What it does |
| --- | --- | --- | --- |
| [`abfc init`](#abfc-init) | no | only for `abfc generate` and `abfc doctor` at the end | Creates or updates a project and links it to a mod. |
| [`abfc doctor`](#abfc-doctor) | yes (except `--clean-runtimes`) | yes, when the settings are complete | Shows every discovered setting and its source, then the backend and its capabilities. |
| [`abfc generate`](#abfc-generate) | yes | yes | Reflects classes and mod assets through the backend and writes `.abfc/stubs/<profile>/`. |
| [`abfc check`](#abfc-check) | yes | no | Type-checks the project and lowers it, without touching the mod. |
| [`abfc build`](#abfc-build) | yes | yes | Applies the Blueprints to a private staging copy of the mod and compiles them in Unreal. |
| [`abfc test`](#abfc-test) | yes | yes | Builds, then runs the tests through the backend. |
| [`abfc status`](#abfc-status) | yes | yes | Shows the state of every owned unit and of the staged copy. |
| [`abfc adopt`](#abfc-adopt) | yes | yes | Records a hand-made event or engine override as owned by abfc. |
| [`abfc publish`](#abfc-publish) | yes | yes | Builds, then copies the built assets from the staging copy into the mod. |
| [`abfc lsp`](#abfc-lsp) | no | no | Runs the language server over stdio ([language-service.md](language-service.md)). |
| [`abfc version`](#abfc-version) | no | no | Prints the abfc version (also `abfc --version`). |

A command that needs a project looks for `abf.config.json` in the working folder and then in each parent folder, or in the folder given by `--project`. A project folder that sits inside a mod folder (a folder with a `*.uplugin` file above it) is refused with [ABFC1020](errors.md#abfc1020). A missing or invalid `abf.config.json` is [ABFC1021](errors.md#abfc1021).

## Global options

These options are accepted by every command.

| Option | Meaning |
| --- | --- |
| `--json` | Print one machine-readable JSON document instead of text (see [JSON output](#json-output)). |
| `--verbose` | Print more detail: the stack of an unexpected failure, and the warnings Unreal logged while compiling a build. |
| `--project <dir>` | The project folder (default: the working folder, then its parents). For `abfc init` it is the folder to set up when no folder is given as a positional. |

## Environment options

These options override what abfc discovers. They apply to every command that needs a project; precedence and the matching environment variables and config keys are in [config.md](config.md).

| Option | Meaning |
| --- | --- |
| `--editor-root <dir>` | The Mod Editor install folder. |
| `--mods-dir <dir>` | The folder that holds your mods (`Abiotic Factor Mods`). |
| `--mod-dir <dir>` | The folder of this project's mod, when it is not under the mods folder. |
| `--backend-dir <dir>` | The backend checkout (source install; the exe brings its own). |
| `--python <exe>` | The Python the backend runs with (source install; the exe brings its own). |
| `--headless-dir <dir>` | The folder where the backend keeps its hidden-editor profile; must not contain spaces ([troubleshooting.md](troubleshooting.md#user-names-with-spaces-and-the-headless-folder)). |

`abfc init` reads `--editor-root`, `--mods-dir`, `--backend-dir` and `--python` and stores the values you pass in the user config.

## abfc init

```
abfc init [dir] [--mod <name>] [--yes] [--no-generate] [--mods-dir <dir>] [--editor-root <dir>] [--backend-dir <dir>] [--python <exe>]
```

Creates (or updates) the project in `dir` (default: `--project`, else the working folder), links it to a mod of your mods folder, writes the sample class and its test, then runs `abfc generate` and `abfc doctor`. Running it again on an existing project is safe: every file it finds is `kept` (or `updated` when it only adds a missing line, such as new `.gitignore` entries), your `src` and `abf.config.json` are never rewritten, and the sample is written only when `src` holds no TypeScript file. It also writes `.abfc/tags.d.ts` (the gameplay tag constants, see [`abfc generate`](#abfc-generate)) together with `.abfc/tsconfig.paths.json`, also with `--no-generate`. It works outside a project. Without `--yes` it asks questions and shows the files before writing them. A schema-1 `abf.config.json` is upgraded and the old file is kept as `.v1.bak` ([ABFC1031](errors.md#abfc1031)). The steps are in [first-mod.md](first-mod.md) and [config.md](config.md).

| Option | Meaning |
| --- | --- |
| `[dir]` | The project folder, as the first positional. |
| `--mod <name>` | The mod to link to (matched case-insensitively against the mods folder). |
| `--yes` | No questions and no confirmation. Needs `--mod` when the folder has no project yet ([ABFC1040](errors.md#abfc1040) to [ABFC1044](errors.md#abfc1044) are the "cannot ask" and "mod not found" errors). |
| `--no-generate` | Do not run `abfc generate` after writing the files. `--no-stubs` is the old, deprecated name. |

`init --json` result: `{project, mod, modsDir, editorRoot, files: [{path, action}], userConfig: {path, keys}, stubs, doctor}`. `files` lists what was written (or left alone) relative to the project; `userConfig.keys` names the machine-specific settings written to the user config; `stubs` and `doctor` are the exit codes of the generate and doctor steps (the key keeps its old name `stubs`; it is `null` with `--no-generate`).

## abfc doctor

```
abfc doctor [--deep] [--clean-runtimes]
```

Prints the project, the mod, the profile, the Node version, the install kind, then every setting with its winner and source (flag, env, project, user config, auto), then starts the backend and prints its version and a `backend capabilities` line: asset ops (`rename/delete/reparent/recreate`), publish deletions, gameplay tags, reflect defaults, class-manager row tag and variable defaults, each `yes` or `no`. A backend older than 2.6.0, or one without one of the first four capabilities, gets the warning [ABFC4018](errors.md#abfc4018) naming what is missing; everything keeps working, only the matching feature (automatic renames, deletes, tags, default arguments) falls back as described under that code. Without `variable defaults` a changed field initializer cannot be applied to an existing variable ([ABFC2084](errors.md#abfc2084)). Warnings do not change the exit code; errors do. The backend is not started when Python, the backend folder or the headless folder is missing; the output says which.

| Option | Meaning |
| --- | --- |
| `--deep` | For `abfc.exe`: verify the unpacked runtime folder file by file by sha256 and repair it from the exe if it is damaged. Prints `none (source install)` for a source install. |
| `--clean-runtimes` | Delete the unpacked runtime folders of other abfc versions (the one in use is kept; folders in use are reported with [ABFC1051](errors.md#abfc1051) as a warning). Works outside a project and does nothing else. |

`doctor --json` result: `{settings, backend, install}` where `settings` maps `editorRoot`, `documents`, `modsDir`, `modDir`, `python`, `backendDir`, `headlessDir` to `{value, source}` (`value` is `null` when not found), `backend` is the backend's `backend_info` (see [backend.md](backend.md)) or `null`, and `install` is `{kind, abfcVersion, runtimeDir}` (`kind` is `exe` or `source`). With `--deep` there is also `runtimeCheck`: `{files, repaired}` or `null`. `doctor --clean-runtimes --json` result: `{removed, failed, skipped, kept}` (lists of folders, and the kept folder or `null`).

## abfc generate

```
abfc generate [--add <path>]... [--refresh] [--resync]
```

`abfc stubs` is the old name of this command. It still works and does the same, prints a deprecation warning on standard error, and is no longer listed in the usage text.

Generates the stubs automatically. The backend lists the names of the whole game once (the class catalog, about 7 seconds, stored in `.abfc/stubs/<profile>/_catalog.json`); then every `/Game` Blueprint class gets a stub, together with the engine types their members use and the profile's default engine classes. This full set is generated once per Mod Editor build and takes about 3-4 minutes (measured: 3098 game classes, about 17 MB, about 3200 files in about 195 seconds); the result is cached in the profile folder (`_cache.json.gz`), so a later `abfc generate` only generates what is new (the classes you added, the engine names your source imports, the config extras) in about 15-20 seconds. Engine names (`/Script/...` classes, structs and enums) are generated on demand: import one in your source (`import { Actor } from "/Script/Engine"`) or name it with `--add`, and the next `abfc generate` or `abfc build` generates it. Engine classes and structs that are reached only through other types (a designer widget typed `TextBlock`, a return type like `VerticalBoxSlot`) start as placeholders without members. Once your source uses one (reads or calls a member of it, casts to it, names it as a type), `abfc generate` and the start of `abfc build`, `test` and `publish` generate it together with its parent chain, in at most 3 rounds, and remember it in `stubs.lock.json` (`auto.added`); no `stubs.scriptClasses` entry is needed. A class the backend cannot reflect is recorded as failed ([ABFC3023](errors.md#abfc3023)) and not retried until `--add` or `--refresh`. `stubs.classes` and `stubs.scriptClasses` in `abf.config.json` are optional extras. The command holds the project lock while it writes, so nothing else writes the stub folder at the same time. It also reads the hand-made assets of the mod and writes the TypeScript declarations into `.abfc/stubs/<profile>/` together with `stubs.lock.json`. The first run needs the network once, because the backend downloads the Blueprint filter. Besides the engine and mod-asset declarations it writes `.abfc/tags.d.ts`, which declares the gameplay tags as constants (`ClassManager.EntityDirector.<Tag>`, used by `@director`, see [first-mod.md](first-mod.md#director-with-a-gameplay-tag)) from the game's tag list and the `Config/Tags/*.ini` files of your mod; a backend that cannot list the game's tags gives [ABFC3012](errors.md#abfc3012) and the file holds only the mod's own tags. Library functions whose parameters have defaults in the engine are generated with those parameters optional (`PrintString("hi")`). Run it again when the config's `stubs` section, the mod assets or the editor build change, and after updating abfc: stubs made by an older abfc give a warning ([ABFC3001](errors.md#abfc3001)) that names both generator versions and lack the newer additions; `abfc check` and `abfc build` refuse stubs that no longer match ([ABFC3010](errors.md#abfc3010) explains the one `stubs` key that is ignored).

| Option | Meaning |
| --- | --- |
| `--add <path>` | Generate stubs for one more name; repeat it for several. A path is `/Script/<Package>.<Name>` (a class, struct or enum), a `/Game/...` class path (`/Game/Dir/BP_X.BP_X_C`) or a `/Game/...` module (every class of that Blueprint file). Added names are remembered in `stubs.lock.json` and kept by later runs. A name that is not in the catalog gives [ABFC3022](errors.md#abfc3022); a name that failed to reflect earlier is retried. |
| `--refresh` | Forget the cached catalog and the cached reflection and generate everything again (the 3-4 minute full run). Use it after a game update that does not change the editor build, or to retry the classes recorded as failed ([ABFC3023](errors.md#abfc3023)). |
| `--resync` | When mod assets are read, first recreate the staging copy from the mod (see [`abfc build`](#abfc-build)). |

`generate --json` result: `{dir, files, members, opaque, modAssets, full, reflected, catalog, added, failed, notFound, used}` (`dir` is the profile folder; `files` and `members` count what was written; `opaque` lists types abfc could not describe; `modAssets` lists the hand-made mod assets that got stubs; `full` is true when the full game set was generated; `reflected` is the number of classes sent to the backend in this run; `catalog` is `{game, scriptClasses}` counts or null without a catalog; `added`, `failed` and `notFound` are the lists described above; `used` lists the placeholder types the source used that this run generated).

A backend without the `catalog` tool (older than abf-mod-editor-mcp 2.6.0) still works: only the profile defaults, the config lists and the `--add` paths get stubs, and `abfc generate` warns with [ABFC3021](errors.md#abfc3021) each run.

`abfc build`, `test` and `publish` generate missing stubs by themselves at their start: when the lock is missing or stale, or your source imports an engine or game name that has no stub yet, or uses a placeholder type (see above), the build starts the backend, generates just that and goes on. A build with complete, current stubs does not start the backend for this. When the backend cannot be used the build warns once with [ABFC3020](errors.md#abfc3020) and continues from the existing stubs; if those are unusable the lock check that follows stops the build. Neither the language server nor `abfc check` ever starts the editor.

## abfc check

```
abfc check [--watch]
```

Type-checks the project, applies the subset rules, lowers every class to Blueprint graph units and compiles the tests. It does not start the backend and does not change the mod. Diagnostics print as `<file>:<line>:<col>: <severity> ABFCnnnn: <message>`, which editors and CI understand as a problem matcher.

| Option | Meaning |
| --- | --- |
| `--watch` | Stay running and check again after every relevant file change (`*.ts`, `tsconfig*.json`, `abf.config.json`, the manifests and the stub lock). Stop with Ctrl+C (exit 0). Cannot be combined with `--json`. |

`check --json` result (only when there is no error): `{assets: [{asset, units: [unit id]}], tests}` (`tests` is the number of tests found).

## abfc build

```
abfc build [--resync] [--drift] [--full] [--keep-failed-stage] [--replace-editor-edits]
```

Compiles the project and applies only the units whose TypeScript changed to a private staging copy of the mod, then compiles the changed Blueprints in Unreal. Your mod is not changed; `abfc publish` copies the result. The first build creates the staging copy. A build that finds nothing to do prints "up to date".

TypeScript wins: a build makes each Blueprint it applies match the `.ts` file. What was changed in the Mod Editor is replaced, and one [ABFC5014](errors.md#abfc5014) warning per asset lists it; in a class without a `_Manual` interface merge the hand-made nodes, function graphs and variables are removed too. The build never refuses because of editor edits, unless `"protectEditorEdits": true` is set in abf.config.json: then a build that would remove or replace hand-made work stops with [ABFC5019](errors.md#abfc5019) and applies nothing, and `abfc build --replace-editor-edits` lets one build replace it. A plain build reads only the assets whose TypeScript changed (use `--drift` for all).

Read cache: every read of an owned asset is kept in `.abfc/cache/reads`, keyed by the bytes of the asset's files in the staging copy and of the mod files its export references. When the staging copy is copied from the mod again (the Mod Editor saved any file of the mod, a failed compile, `--resync`), a build has to look at every owned asset; with the cache only the assets whose files, or the files they reference, changed are read from the editor. `--full` turns the cache off and reads every owned asset from the editor (as `--drift` does); `abfc publish --full` never uses the cache either.

With backend 2.6.0 the build also does the following without a flag, one output line each:

- `renamed <old> -> <new>`: a class that moved to another folder or was renamed (also together with its file) keeps its Blueprint: the asset is renamed in the staging copy and Unreal fixes the references. An unclear case (several earlier assets match) stays [ABFC5012](errors.md#abfc5012).
- `reparented <asset>: <old> -> <new>`: a changed `extends` clause in the same family (Actor, component, widget, other) is reparented; `recreating <asset>: ...` when the new parent is in another family, which creates the asset again (only for assets abfc created, else [ABFC2048](errors.md#abfc2048)).
- `deleted <asset>`: a class removed from TypeScript deletes the asset abfc created for it, after the build applied the classes that used it ([ABFC5016](errors.md#abfc5016) if another asset still references it). A hand-made asset that a class took over is emptied and stays ([ABFC5017](errors.md#abfc5017)); a `@struct` is never deleted ([ABFC5018](errors.md#abfc5018), once). The class-manager row of a changed or removed `@director` is deleted as well (`deleted <row> (the class-manager row of ...)`).
- `gameplay tag <tag>: added to the mod's tag list`: a `@director` tag the mod did not have yet.
- [ABFC4017](errors.md#abfc4017) (warning): the mod changed since the staging copy was made (for example saved in the Mod Editor), so it was copied again; the class defaults of exactly those assets are applied again.

These operations only change the staging copy; the real mod changes with `abfc publish`. The backend takes at most 20 operations per call, so larger builds are sent in chunks ([ABFC5016](errors.md#abfc5016)). Two builds at once in one project are refused with [ABFC4019](errors.md#abfc4019), see [Running one command at a time](#running-one-command-at-a-time). A `mod.name` written in another letter case than the plugin file is corrected with the warning [ABFC1045](errors.md#abfc1045).

| Option | Meaning |
| --- | --- |
| `--resync` | Recreate the staging copy from the mod before building. Unpublished staged work of every project that targets the same mod is discarded; the manifests are pruned to what the new copy holds, and renames, deletes and class defaults that were not published yet are done again by the build. Rarely needed: when the real mod changed since the staging copy was made (for example saved in the Mod Editor), abfc copies it again by itself and says so ([ABFC4017](errors.md#abfc4017)). |
| `--drift` | Read and drift-check every owned asset, not only the changed ones. Edits made in the Mod Editor to units that did not change in TypeScript are replaced too (TypeScript wins, [ABFC5014](errors.md#abfc5014)), at the cost of one read per asset. Use it after a manifest was lost, or when `abfc status` shows [ABFC5001](errors.md#abfc5001) or [ABFC5002](errors.md#abfc5002) for an asset you did not change. Only `abfc build` accepts it. |
| `--keep-failed-stage` | After an Unreal compile failure keep the failed graphs in the staging copy for inspection. Without it abfc re-syncs the staging copy from the mod, which discards all unpublished staged work in every asset of the mod (like `--resync`), not only in the assets that failed to compile. abfc forgets the units that were never published, and the next build applies them again. If that re-sync fails, abfc warns with [ABFC4016](errors.md#abfc4016) and you run `abfc build --resync` before the next build. Also accepted by `abfc test` and `abfc publish`. |

`build --json` result:

- applied: `{applied: [unit id], assets: [asset path], structs?, route, upToDate, removed?, removedOrphanTags?, renamed?, deleted?}`; `route` is how the backend wrote the graphs; `renamed` is `[{from, to}]` and `deleted` a list of asset paths, each present only when the build did any;
- nothing to do: `{applied: [], upToDate}` (with `renamed` and `deleted` when only those happened);
- compile failure: `{applied: [], compileFailed: true, stageResynced}`.

A compile failure exits 1; the Unreal messages are listed as `ABFC6xxx` diagnostics (see [errors.md](errors.md)).

## abfc test

```
abfc test [pattern] [--no-build] [--resync] [--keep-failed-stage]
```

Builds (unless `--no-build`), compiles the tests of the project and runs each one through the backend's game-test runner in a hidden editor on the staging copy. The runner builds its test harness (`Content/_McpTest`) in the staging copy only; it is never published and never reaches your mod, and your open Mod Editor is not used. `pattern` selects tests whose name contains it. Tests that need the live HUD are skipped with a warning and listed as manual checks (the checklist is written to `.abfc/reports/manual-checks.md`).

| Option | Meaning |
| --- | --- |
| `[pattern]` | Run only the tests that match. |
| `--no-build` | Skip the build; the stubs lock is still checked. |

### Tests in a real map

`test(name, { map, timeout }, body)` runs one test on a game map instead of the empty default (which has no player), with a longer run timeout for the map load. The run uses the backend's own user folder, so no save of yours is read or written. What a test can do:

| In a test | Step |
| --- | --- |
| `t.spawn(Class)` | spawns an actor (at the origin) |
| `t.find(Class, { timeout })` | the first actor of the class in the world, waited for (the player: `t.find(Abiotic_PlayerCharacter_C)`) |
| `h.call("Fn", ...)`, `h.get("Var")`, `h.set("Var", v)` | calls a function or event, reads or writes a variable |
| `h.moveTo(x, y, z)`, `h.moveTo(other)`, `h.aim(pitch, yaw)` | teleports an actor; turns it and its controller's view (the player's camera follows) |
| `t.distance(a, b)` | the distance between two actors (cm) |
| `t.wait(s)`, `t.python(code)` | waits; runs Python in the game (`ctx[name]` holds the values, `result` is the value) |
| `t.expect(v).equals / approx / contains / truthy / notNone / below / above` | checks a value once |
| `t.waitUntil(v, { timeout, every }).equals(...)` | looks at an inline `h.get`, `h.call`, `t.distance` or `t.python` again and again until the check holds; fails after `timeout` (default 10 s) |

A top-level `const NAME = "..."` (or a backtick string without `${}`) of a test file can stand wherever a test takes text, such as `t.python(NAME)`. Read state back (a `Step` variable, a flag) instead of PrintString, which is compiled out of the game build.

`t.waitUntil` polls on a backend with the `game_test_until` extension (backend patch `docs/backend-patches/backend-game-test-until.patch`, which also lets a big map take most of the timeout to load). On an older backend it waits the whole timeout, then looks once, with warning [ABFC6106](errors.md#abfc6106).

`test --json` result: `{tests: [{name, passed, ok, steps, seconds}], manualChecks?}`; each manual check is `{name, file, line, checklist}`. When the build ran and was up to date or applied, the test result replaces the build result in the document. A failed test is [ABFC6104](errors.md#abfc6104) (exit 1).

## abfc status

```
abfc status [--resync]
```

Reads every owned asset from the staging copy and prints one line per unit: `<asset> <unit> <state> <ir hash> <asset hash>`, then how many staged files differ from the mod. Editor edits to a unit abfc owns are reported as warnings ([ABFC5001](errors.md#abfc5001) to [ABFC5004](errors.md#abfc5004)): a preview of what the next build replaces (`abfc build --drift` replaces them now). Status itself changes nothing. A real mod that changed since the staging copy was made is reported as a warning ([ABFC4020](errors.md#abfc4020)); status never copies it again.

`status --json` result: `{units: [{asset, unit, state, irHash, assetHash}], staging: {changed, added, removed, conflicts}}`.

## abfc adopt

```
abfc adopt <asset> <unit> [--remove-node <name>]... [--yes] [--discard-editor-changes] [--resync]
```

Deprecated ([ABFC5015](errors.md#abfc5015)): not needed any more, because `abfc build` replaces a hand-made event of the same name as a TypeScript unit. Records a hand-made event (`UpdateTarget` or `event:UpdateTarget`) or engine override (`override:ReceiveTick`) of an existing Blueprint as owned by abfc, so that a class in TypeScript can take it over. It never applies anything. Without `--yes` it only prints what it would record and exits 3 with [ABFC5006](errors.md#abfc5006). A unit that abfc already applied is refused with [ABFC5007](errors.md#abfc5007) unless `--discard-editor-changes` is given.

| Option | Meaning |
| --- | --- |
| `<asset>` `<unit>` | The asset path and the unit to adopt (exactly two positionals). |
| `--remove-node <name>` | An extra node (comment boxes, unlinked nodes) that goes away with the unit. Repeatable. |
| `--yes` | Write the adoption. |
| `--discard-editor-changes` | Replace a unit abfc already applied with the hand-made version; the next build removes the old generated nodes. |

`adopt --json` result: `{asset, unit, entry, owned, extra, crossLinks, written}`.

## abfc publish

```
abfc publish [--dry-run] [--full] [--resync] [--keep-failed-stage]
```

Builds, then copies the built assets of the project's mod from the staging copy into the mod. The backend refuses to publish on compile errors, conflicts, locked files or an editor in the wrong state, and keeps a backup of every replaced or deleted file. When the Mod Editor is open it reloads the published assets in place. Play In Editor must not be running and no asset may have unsaved changes: otherwise the publish is refused with [ABFC7005](errors.md#abfc7005) (exit 3) and the message says which case; stop Play In Editor, save or revert, and run `abfc publish` again. Nothing is ever uploaded: uploading a mod is a separate step you do yourself.

The publish also carries the structural changes of the build:

- `deleted <file>`: the files of a deleted class (and its class-manager row), the old path of a renamed or moved class and the row of a changed `@director` are deleted from the mod, with a backup. The assets that Unreal edited for a rename (references fixed in other Blueprints) are published with it. A backend older than 2.6.0 cannot delete: the publish goes on and warns with [ABFC7014](errors.md#abfc7014) naming the files to delete by hand; the deletions stay pending for the next publish. An open Mod Editor may keep listing a deleted asset until it is restarted ([troubleshooting.md](troubleshooting.md#the-editor-still-lists-a-deleted-asset)).
- `changed config <file>`: the mod's gameplay tag list `Config/Tags/<Mod>Tags.ini`, when a `@director` tag was added. With the Mod Editor open, backend 2.6.0 registers the new tags in it before the rows reload; only when that fails does [ABFC7015](errors.md#abfc7015) say to restart the editor.

`--dry-run` lists all of these as `changed`, `added`, `changed config` and `deleted` lines and copies nothing. A publish that only deletes files is a real publish (it does not say "nothing to publish").

| Option | Meaning |
| --- | --- |
| `--dry-run` | Print the would-publish list and stop before the copy. |
| `--full` | Run the release checks first, in this order, stopping at the first failure: 1 stubs lock, 2 check and Blueprint-filter hits, 3 build with `--drift` semantics (editor changes are replaced, TypeScript wins), 4 tests, 5 the mod audit of the staged copy ([ABFC7002](errors.md#abfc7002)), 6 upload file check, 7 the would-publish list, 8 the copy. There is no `abfc audit` command: `abfc publish --full --dry-run` runs gates 1 to 7 without copying. |

`publish --json` result: with `--dry-run` `{changed, added, deleted, config, dryRun, full}`; after a copy `{published, deleted, config, backup, route, reloadedInPlace, dirtyAfter, reloadedReferencers, skippedDirty, dirtyPublished, compileErrorsAfter, tagsRegistered, tagsUnregistered, tagsStrategy, tagsError}`. `--timings` prints the time of each gate.

## abfc lsp

```
abfc lsp [--stdio]
```

Starts the language server on stdin and stdout: diagnostics, hover, quick fixes and completion. Completion offers the classes, structs and enums of the game and the engine with their import (typing `BP_Fa` in a type position offers `BP_Fake_C` and adds `import { BP_Fake_C } from "/Game/..."`; names that have no stub yet are offered too), and the engine and mod library functions (typing `PrintS` offers `KismetSystemLibrary.PrintString` and adds the import) and, at the start of a member in a class body, `@override override ReceiveBeginPlay(): void { }` stubs for the events of the parent class (typing `Rec`). It reads the stubs, so run `abfc generate` first. A TypeScript error about an unresolved `/Script/...` or `/Game/...` import has a quick fix "Generate stubs for <names>": it runs `abfc generate --add` for those names (the same fix, "Generate stubs for TextBlock", is offered on a TS2339 or TS2551 error about a missing member whose receiver is a placeholder type; this starts the Mod Editor backend, takes a few seconds to minutes, and reports the result as a message); it never runs on typing. Standard output carries only the protocol; logs go to standard error. `--stdio` and the `--clientProcessId <pid>` that language clients add are accepted and ignored. See [language-service.md](language-service.md) for the editor setup.

## abfc version

```
abfc version [--json]
abfc --version
```

Prints `abfc <version> (<exe|source install>, node <version>)` and exits 0. It works outside a project. `--version` together with another command is a usage error (exit 2). With `--json` it prints one object `{"version", "install", "node"}` without the envelope described below.

## Performance options

| Option | Meaning |
| --- | --- |
| `--timings` | Print a table of the steps of the run after `abfc check`, `build`, `test` and `publish`. The same data is appended to `.abfc/runs.jsonl`. |
| `--cold` | Do not use the backend's warm session; every backend operation starts its own editor. Slower; for diagnosing a stuck session. Applies to `build`, `test`, `status`, `adopt` and `publish`. |

## Option summary

| Option | Applies to |
| --- | --- |
| `--json`, `--verbose`, `--project` | all |
| `--editor-root`, `--mods-dir`, `--mod-dir`, `--backend-dir`, `--python`, `--headless-dir` | all project commands (`init`: the first four, see above) |
| `--timings` | check, build, test, publish |
| `--cold` | build, test, status, adopt, publish |
| `--resync` | generate, build, test, status, adopt, publish |
| `--add`, `--refresh` | generate only |
| `--drift` | build |
| `--keep-failed-stage` | build, test, publish |
| `--no-build` | test |
| `--dry-run`, `--full` | publish |
| `--yes` | init, adopt |
| `--discard-editor-changes`, `--remove-node` | adopt |
| `--watch` | check |
| `--mod`, `--no-generate` | init |
| `--deep`, `--clean-runtimes` | doctor |
| `--version` | `abfc --version` only |
| `--stdio`, `--clientProcessId` | lsp (accepted, ignored) |

A flag the command does not use is ignored, except for the ones that are refused with a usage error: `--drift` outside `build`, `--keep-failed-stage` outside `build`, `test` and `publish`, `--add` and `--refresh` outside `generate`, and `--watch` with `--json`. An unknown option is a usage error too.

## Running one command at a time

`build`, `test`, `publish`, `status`, `generate` and `adopt` take a lock per project, `.abfc/lock.json`. A second one started while the first runs stops with [ABFC4019](errors.md#abfc4019) before it starts the backend; `check`, `doctor`, `init` and `lsp` take no lock. The lock of a crashed run is replaced by the next run.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. Warnings never change the exit code. |
| 1 | Your code or your project is wrong: TypeScript subset errors (`ABFC2xxx`), test and compile failures (`ABFC6xxx`), publish refusals (`ABFC7xxx` except 7005 and 7006), ownership problems that are not conflicts (`ABFC5008` and up), and the `abfc init` user errors `ABFC1040` to `ABFC1044` (nested project, no terminal, mod not found, no mods in the folder). |
| 2 | The setup, the stubs or the backend is wrong, or the command line is malformed: environment and config errors (`ABFC1xxx`), stub errors (`ABFC3xxx`), backend errors (`ABFC4xxx`), `ABFC7006`, an unexpected failure (`ABFC4002`), and every usage error (unknown option, unknown command). |
| 3 | A conflict that needs your decision: `ABFC1020` (project inside a mod folder), `ABFC4090`, adopt conflicts `ABFC5005` to `ABFC5007` (a dry adopt) and `ABFC7005` (publish refused because the editor is playing or has unsaved assets). |

When a command reports several errors the exit code is the highest of them. The exact code of every diagnostic is in [errors.md](errors.md).

## JSON output

With `--json` nothing is printed while the command runs. At the end one document is written to standard output:

```json
{
  "command": "build",
  "ok": true,
  "diagnostics": [],
  "result": { "applied": [], "upToDate": true }
}
```

- `command` is the command name, `ok` is true exactly when the exit code is 0.
- `diagnostics` holds every warning and error: `{severity, code, message, span?, asset?, tried?, fix?, data?}`. `span` is `{file, line, col, ...}`; `tried` lists where abfc looked (`[{source, detail}]`); `data` carries machine-readable facts for a quick fix.
- `result` is the command's result described above, or `null` when the command stopped before it had one (for example after a failed check).

Text-mode diagnostics go to standard error, informational lines to standard output. `abfc version --json` and `abfc lsp` do not use the envelope.

## Not built

- `abfc mv` does not exist and is not needed. With backend 2.6.0 a moved or renamed class file is followed by the next `abfc build` (`renamed <old> -> <new>`, references fixed by Unreal). Only when several earlier assets could be meant, or with an older backend, abfc stops with [ABFC5012](errors.md#abfc5012) and offers a quick fix that keeps the asset where it is with `path: "<its path below the mod>"` in the class decorator.
- `abfc audit` does not exist. Use `abfc publish --full --dry-run` to run gates 1 to 7 of the release checks without copying anything.
