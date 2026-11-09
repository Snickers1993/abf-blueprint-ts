# Changelog

All notable changes to abfc are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

abfc uses semantic versioning for its command-line surface: the commands, their flags, the exit codes, the error codes, the `abf.config.json` schema and the decorators. A new config schema or a removed option is a major change. All `@abfc/*` packages share one version.

## [Unreleased]

### Added

- Read cache (`.abfc/cache/reads`): a build serves `bp_read` of an owned asset from the cache when the asset's files in the staging copy, and the files of the mod packages its export references, are byte-identical to an earlier read (and the backend, editor and stub identity are the same). After a re-sync (any file of the mod saved in the Mod Editor, or a failed compile) a build used to read every owned asset twice from the hidden editor, about 10 s each; now only the assets that changed. `abfc build --full` reads every owned asset from the editor without the cache.
- `if (isValid(x))` right after `const x = cast(...)` sends a failed cast to the false side (the else branch, or the code after the if), as `if (x)` does. It used to leave Cast Failed unwired, so a failed cast silently ended the event (the Return Hook's creature check stopped every wall shot). `if (!isValid(x))` keeps its graph so published Blueprints do not change; ABFC2103 warns when its branch does more than `return;`. All 39 units of the RTS project hash the same as before.
- ABFC6003: a build fails when an `@override` comes out of the apply as a custom event instead of an override event (Unreal does this to an event declared in a Blueprint class, such as a game weapon's `GunStartFiring`, when the backend templates it in its Actor scratch; it compiled clean as `GunStartFiring_1` and was never called). The fix itself is the backend patch backend-override-blueprint-events.patch; native events are unchanged.
- A `float` parameter or field takes a `double` (the editor converts real to float on the pin, as when wired by hand); `float` stays its own Blueprint type. `KismetSystemLibrary.Delay(this.Seconds)` with a double field no longer needs a float copy.

- `asset(Class, path)` in `@abfc/runtime`: a hard reference to an existing asset (`asset(StaticMesh, "@mod/Meshes/SM_Crate")`, `asset(SoundBase, "/Game/Audio/S_Beep")`) as the default object of the pin it feeds: a call argument, an array `push` or element write, or a variable set. No load node, so the asset cooks with the Blueprint. `@mod/` names the mod being built; a path without an object name gets the asset name appended. A path that is not a package path is ABFC2099. A class or asset reference that reaches a pin that cannot hold a default object now fails the build instead of being dropped.
- `spawnActor(Class, { transform })`: spawn at a Transform (`KismetMathLibrary.MakeTransform(...)`), so Begin Play already sees the place. Without it the actor spawns at the origin, as before.
- `other.Var = value` sets a variable of another object (a Set node with its Target wired), e.g. a station's `StationId` right after spawning it.
- `bindEvent(source, "Dispatcher", target, "Function")` binds another object's function or event to an object's event dispatcher (Add Delegate fed by Create Event), as a hand-made "Bind Event to ..." does.
- `bindEvent(source, "Dispatcher", this, "OwnEvent")` binds an own `@event` through its delegate pin (Add Delegate only, no Create Event node).
- `super.X(...)` inside `@override X` calls the parent's implementation (a Call Parent Function node), e.g. `super.ReceiveBeginPlay()` in a child of a game Blueprint that has its own Begin Play.
- `@override` of a parent Blueprint function with outputs (`Abiotic_Weapon_ParentBP_C:Local_FirePressed`, `@bpOut ConsumedByWeapon bool`) builds a function graph whose entry and Return node name the parent, not an event. Return the outputs as an object literal with every output (`return { ConsumedByWeapon: true }`); a parent function whose only output is `ReturnValue` returns a plain value. Needs the backend bp_apply feature `override_functions` (the graph joins the Blueprint's FunctionGraphs). `super.X()` stays limited to parents without outputs.
- `[]` as the argument of an array input leaves the pin unwired, which Blueprint reads as an empty array (`LineTraceSingle(..., [], ...)` for ActorsToIgnore).
- A `Vector`, `Vector2D` or `Rotator` literal whose fields are all numbers, fed straight into a pin, is the pin's default text (no make node): a spawn at a literal place is two nodes.
- Stubs of hand-made actors list the components they add themselves (`readonly Car: SceneComponent`, tagged `@bpComponent`), from the `components` of `bp_read`; inherited and native components still come from the parent's stub. Run `abfc generate --refresh` once to pick them up.
- `/` on real values lowers to `Divide_DoubleDouble` (it was ABFC2099). `/` on integers stays ABFC2010 (use `idiv`).
- `abfc generate` with `stubs.modAssets: "all"` skips mod packages whose name table has no `BlueprintGeneratedClass` (meshes, textures, materials, sounds) before reading them through the backend. Each read is a headless export of 15-18 s, so a mod of 877 assets went from about 4 hours to the Blueprints only.
- Struct literals of `Vector`, `Vector2D` and `Rotator` lower to `MakeVector`, `MakeVector2D` and `MakeRotator` (KismetMathLibrary). A Make Struct node on these core structs fails the Unreal compile ("is not a BlueprintType"), found on the first real build of an RTS Blueprint.
- Element writes on own arrays: `this.Arr[i] = x` as a statement lowers to Set Array Elem (`Array_Set`, `bSizeToFit` false, typed `Item` pin). The index must be an `int` (ABFC2012); a local array or a parameter is ABFC2041, as for `push` and `splice`.
- Automatic stubs. `abfc generate` generates a stub for every game class once per Mod Editor build (about 3-4 minutes, then cached so later runs take seconds); engine names your source imports (`/Script/...` classes, structs, enums) are generated on demand when `abfc build`, `test` or `publish` starts, and only when something is missing. New options `abfc generate --add <path>` (an engine name, a game class or a game module) and `abfc generate --refresh`. Needs the `catalog` tool of abf-mod-editor-mcp 2.6.0 (older backends keep the old behaviour with a warning). New files in the stub folder: `_catalog.json`, `_names.json`, `_cache.json.gz`, `_coverage.json`, `_library.json`; `stubs.lock.json` gained `auto`.
- Editor: completion offers the classes, structs and enums of the game and the engine, with their import, also in type positions and after `extends`; a TypeScript error about an unresolved `/Script/...` or `/Game/...` import has the quick fix "Generate stubs for ..." (runs `abfc generate --add`; the language server never starts the editor otherwise).
- New diagnostics ABFC3020 (stubs could not be generated at build start), ABFC3021 (backend without `catalog`), ABFC3022 (`--add` name unknown), ABFC3023 (classes the backend could not reflect).

### Changed

- A `const` bound to a pure expression that reads state (an own variable, an array length or element, a member getter) is stored in a temp where it stands, so a use after a later write still sees the old value. It used to be a live pure node, re-read at every use: `const first = this.Pts.length` read the length after the pushes in a route parser and skipped every route. A const read only by the very next statement (or the next `if` condition) stays a plain pure value.
- The mod audit (`publish --full` gate 5) gets 1800 s instead of 420 s; a mod of about 900 assets was killed after 7 minutes with no verdict. `ABFC_AUDIT_TIMEOUT_SECONDS` sets another limit (60 or more).
- `abfc check` shows Blueprint filter hits (ABFC7011) as warnings. They were only reported at `publish --full` gate 2, so a check and a build passed and the publish gate failed.
- A temp variable whose type changed (temps are numbered in source order, so a new temp shifts the ones after it) is removed and declared again. The planner used to keep the old variable, and the Unreal compile failed with type mismatches on the temp Get and Set nodes.
- `spawnActor(...)` and `createWidget(...)` can stand alone as statements (they were ABFC2099 "has no effect").
- `real` and `double` are one type when an own variable's recorded or read-back type is compared: a `double` field no longer gets recreated (ABFC5014) on every build because the asset reports it as `real`.

- `abfc init` writes an empty `stubs.scriptClasses`; `stubs.classes` and `stubs.scriptClasses` are optional extras (the profile's default engine classes are always generated). The first build after updating generates the full game set (about 3-4 minutes). The fix of ABFC3011 and ABFC3004 now points to `abfc generate --add <path>`.
- `abfc stubs` is now `abfc generate`, and `abfc init --no-stubs` is now `--no-generate`. Generated stub files start with `// generated by abfc generate`. The `.abfc/stubs/` folder, `stubs.lock.json`, the `stubs` keys of `abf.config.json` and the `stubs` key of the `init --json` result keep their names.

### Deprecated

- `stubs.widgetMembers`: designer widgets, components and widget/component variables are found by `abfc generate` itself. Entries that reflection finds warn ABFC3015; the others are still emitted.
- `abfc stubs` and `abfc init --no-stubs` still work exactly as before but print a deprecation warning on standard error; they are no longer listed in the usage text and will be removed in a future major version.

### Fixed

- Reading a variable or component that a parent class declares (`this.IsDepleted` in a child of a game Blueprint) names that class as the get's MemberParent, with a Self node as its Target; the self-context get had no pins in bp_apply's scratch Blueprint, so the apply failed with "no pin 'IsDepleted'".


- Engine types used only through other types (designer widgets, return values) were left as placeholders without members. `abfc generate` and the start of `abfc build`, `test` and `publish` now generate the placeholder classes and structs the source uses, record them in `auto.added`, and no `stubs.scriptClasses` entry is needed; the editor offers the quick fix "Generate stubs for ..." on TS2339 and TS2551 for a placeholder receiver.
- Stubs now list the designer widgets (`readonly`, `@bpWidget`), SCS components (`readonly`, `@bpComponent`) and widget- or component-typed variables of game Blueprints, and the component and widget properties of native classes (a character's mesh or movement component), on the declaring class only. Needs a backend with the member pass (otherwise warning ABFC3014). `_index.json` lists them under `discovered`. Run `abfc generate` once (generator 0.7.0).
- Stubs keep the complete parent chain of every class: a Blueprint whose parent is a game-module class or another Blueprint now inherits all its ancestors' functions and properties (for example `IsLocalController` and `K2_GetPawn` on a player controller Blueprint), and placeholder types extend their real parent. Needs a backend whose `reflect` reports `supers`; with an older one Blueprint parents are skipped (warning ABFC3013). `_index.json` lists `chainGaps`, `noSupers` and `opaqueNoParent`, and `node scripts/stub-chain-audit.mjs --stubs <dir>` audits any stub folder. Run `abfc generate` once (generator 0.6.0).
- Editor completion finds Blueprint library functions by the C++ name without its `K2_`/`BP_` prefix, by any word of the name (`timer`) and by the Blueprint node name (`settimerbyevent` offers `KismetSystemLibrary.K2_SetTimerDelegate` with its import). After a dot, stub members are also found by their node name. Works with existing stubs.

## [1.0.0] - 2026-11-08

### Added

- Array `for..of` and simple counted `for` loops compile to Unreal's For Each Loop / For Loop macro nodes (backend node kind `std_macro`; older backends keep counter loops and warn ABFC2088). A rebuild removes the old `abfc_<unit>_i<n>` counter variables that such loops no longer use.
- `break` and `continue` in loops (For Each Loop / For Loop With Break macro nodes when the loop has a `break`), and `arr.forEach((x, i) => { ... })` over Blueprint arrays (ABFC2090 for unsupported callback forms). ESLint `no-loop-in-tick` also flags `forEach`.
- Undecorated methods of a `@blueprint` class compile to Blueprint function graphs (parameters as inputs, a non-void return as `ReturnValue`, `private`/`protected` as access), callable as `this.fn(...)` or `other.fn(...)`. The graph is owned whole and recreated on any change; needs the backend feature `function_graphs` (ABFC2044). New errors ABFC2085 (recursion), ABFC2086 (`await` or latent call in a function), ABFC2087 (name of a parent member).
- Own fields may have a literal initializer (`Speed: float = 2.5`); it becomes the Blueprint variable's default and changing it updates the default in place (backend feature `variable_defaults`, else warning ABFC2084).
- Derived asset paths: a class gets its Blueprint asset path from its file and class name, with the `path:` keep-path quick fix (ABFC5012) for a moved file.
- `@mod/` imports for classes of the mod being built.
- Schema-2 `abf.config.json` and a user config file; `abfc init` creates a project and upgrades a schema-1 config.
- `@director` rows (class-manager rows), which need backend 2.5.0 or newer.
- `abfc lsp` (the language server) and a VS Code extension packaged as a `.vsix`.
- `abfc.exe` with the backend and Python bundled, a per-user installer and a zip; neither is code-signed.
- `abfc version` and `abfc --version`.
- `abfc build --drift`, which reads and drift-checks every owned asset.
- Automatic stage re-sync after an Unreal compile failure, and `--keep-failed-stage` to keep the failed graphs for inspection (build, test, publish).
- Release hygiene: allowlisted artifacts, an artifact scanner (names, user and build paths, dev folders, game-derived files), npm tarballs without source maps, lockstep versions, and CI workflows for pull requests and releases.
- Template literals where a string is expected (``KismetSystemLibrary.PrintString(`Count ${this.Count}`)``) or in a `const` without a type annotation: Format Text followed by To String (Text) (`const t: text = ...` stays plain Format Text). Backtick strings without substitutions are string literals. A template literal where a `name` or another type is expected stays ABFC2099, with a clearer message.
- Hardening, found by using abfc on real mods (details of every fix: [docs/known-issues.md](docs/known-issues.md)):
  - Renames and moves just work. A class whose file moved or whose name changed (also class and file together) renames its Blueprint asset with Unreal's own rename and reference fixup; a changed `extends` reparents the asset (same family) or creates it again (other family); a class that left TypeScript has its asset deleted when abfc created it; `abfc publish` carries the deletions. Needs backend 2.6.0 (`bp_asset_ops`, `bp_publish` deletions); older backends keep ABFC5012 and ABFC2048. Asset operations are sent in calls of at most 20.
  - TypeScript wins. A build never refuses because of an edit in the Mod Editor; it replaces what TypeScript describes and removes hand-made nodes, function graphs and variables from classes that are not hybrid (components, the widget tree, timelines, macros, dispatchers and interface graphs are kept). One warning per asset (ABFC5014) lists everything replaced or removed. `interface X extends X_Manual` (hybrid) opts a class out of the sweep. A mod changed outside abfc is re-synced on its own (ABFC4017). Class defaults of assets the editor saved are applied again.
  - `@director("Row", ClassManager.EntityDirector.X)` writes the row's gameplay tag and adds a missing tag to the mod's `Config/Tags` ini; known tags are offered as globals from `.abfc/tags.d.ts`.
  - A new director tag works after `abfc publish` with the Mod Editor open, without a restart. The backend registers the mod's tags in the open editor before it reloads the published row (capability `liveTags`; abfc prints `gameplay tags registered in the open Mod Editor`; ABFC7015 only when that fails and then names the tags), and a director row that the Mod Editor saved (and stripped of an unknown tag) gets its tag again at the next build. Needs backend 2.6.0.
  - `@director` on a class that does not derive from ActorComponent is warning ABFC2089: the game adds directors as components of its AI director, so an Actor-based director never started. The director docs now use ActorComponent and say how to see a director run in Play In Editor. `publish --json` reports `tagsRegistered`/`tagsUnregistered`/`tagsStrategy`/`tagsError`.
  - Engine parameters with a default are optional: `KismetSystemLibrary.PrintString("hi")`, `Delay()`, `GetPlayerCharacter()`; the node keeps Unreal's default. A short curated list of very common functions adds the K2 zero defaults (`bSweep`, `bTeleport`, `PlayerIndex`).
  - `abfc lsp` completes library functions and `@override` stubs for the parent's events.
  - One abfc run at a time per project (`.abfc/lock.json`).
  - New codes: ABFC1045, ABFC2048, ABFC2078, ABFC2079, ABFC2080, ABFC2081, ABFC2082, ABFC2083, ABFC2089, ABFC3012, ABFC4017, ABFC4018, ABFC4019, ABFC5014, ABFC5015, ABFC5016, ABFC5017, ABFC5018, ABFC7014, ABFC7015 (`docs/errors.md`).

### Changed

- Behaviour changes of the hardening release: the Mod Editor's edits to a class's assets no longer stop a build or publish (ABFC5001 to ABFC5004 and ABFC4020 are warnings in `abfc status`); a field removed from TypeScript is removed from the asset (ABFC5011); changing a field's type recreates the variable (ABFC2047 is a warning); `@event` on a method that overrides a parent member is error ABFC2078 with a quick fix; `abfc adopt` is deprecated (ABFC5015); ABFC5012 only reports an ambiguous or unsupported rename; every re-sync (explicit, automatic, after a failed compile) prunes the manifests to the stage, so ABFC5002 cannot loop; class defaults that a publish already carried to the mod are not applied or republished again after a re-sync, unless the editor saved that asset (or the re-sync was explicit); `mod.name` in another letter case than the plugin file is read as the file's spelling (ABFC1045); the stub generator is at version 0.5.0 (optional parameters), so ABFC3002 asks for `abfc stubs` once.
- Backend 2.6.0 is recommended (`abfc doctor` warns with ABFC4018 about what an older one lacks). The minimum stays 2.4.0: every new feature is gated on a capability (`assetOps`, `publishDeletes`, `gameplayTags`, `reflectDefaults`, `classManagerRowTag`, `variableDefaults`) and an older backend prints a clear warning or keeps the earlier behaviour.

- The tsserver plugin is retired in favour of the language server.
- ABFC4015 now reports the adapter's missing cross-wire entry; ABFC4012 stays "no backend_info".
- Lint: `no-unbounded-array-growth` accepts pushes in the one-time overrides `ReceiveBeginPlay`, `Construct` and `OnInitialized`; `rpc-misuse` no longer reports a client-from-client call inside a server RPC or a private method reachable only from one.

### Known issues

- `abfc publish --full` stops at gate 5 (ABFC7002) on the machine where it was tried: the audit's hidden Mod Editor shows the Epic/mod.io login window, which no wait or sign-in in a normal session resolved (two live runs, 60 s and 240 s). Build, test and the default publish do not need it; run the Asset Audit in the Mod Editor before an upload. See the troubleshooting guide, "The Epic login window of the stage audit".
- The backend gives the audit's hidden editor a private home whose `AppData\Local` folder is linked to the backend's own headless folder instead of the real Local folder, so a stored mod.io session cannot be seen there. A fix is recorded for the backend; whether a bypass flag for gate 5 is wanted is an open decision.
- There is no `abfc mv`; it is not needed with backend 2.6.0, where a moved or renamed file renames its asset on the next build. With an older backend a moved file stops the build with ABFC5012 and the quick fix keeps the old asset path.
- Function locals and changing the fields of an existing struct are not supported yet. A struct that leaves TypeScript stays in the mod (ABFC5018).
- After a published deletion the open Mod Editor's asset registry keeps listing the asset until the editor is restarted; the files are already gone.
- The full list of limitations and fixed problems is [docs/known-issues.md](docs/known-issues.md).
- The exe, installer and zip are not code-signed, so Windows SmartScreen warns on the first run.

### Requirements

- The Mod Editor with a mod created in it.
- Source install: Node 24 or newer and backend 2.4.0 or newer; `@director` rows need backend 2.5.0. Backend 2.6.0 (tag `v2.6.0`) is recommended: renames, deletions, director tags, optional parameters and variable defaults need it. `abfc.exe` bundles it.
