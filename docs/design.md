# abfc: TypeScript to Blueprint compiler for Abiotic Factor mods (design, phase 1)

Status: draft for review. Phase 0 (2026-11-05) ran probes P1 to P9 (listed in docs/roadmap.md) on the cooked Mod Editor. Facts marked **(verified in Phase 0, P<n>)** were confirmed by probe P<n>. Facts still marked **(unverified)** were not settled by a probe.

Target: Mod Editor 1.5.0, engine `5.4.4-1050002+++DF+ABF`, Windows only. MIT, public, published as npm packages. The only supported backend is `https://github.com/EmekC/abf-mod-editor-mcp`. abfc depends on no other backend repository.

## 1. Goals and non-goals

Goals
- Write a mod's Blueprint logic as TypeScript classes. The `.ts` files are the source of truth, and Blueprint graphs are build artifacts.
- It works on any Windows machine with the Mod Editor installed. Nothing is hardcoded to one PC, and nothing derived from Deep Field content is committed or published.
- A plain CLI (`abfc`) runs from any terminal or VS Code task and starts the Python backend itself. MCP and Claude are optional.
- Errors, from the TS subset checker, the Unreal compiler or a failed test, are reported as `file.ts:line:col: error ABFCnnnn: message`.
- A swappable backend: the compiler emits a backend-neutral graph IR and never calls `bp_apply` directly.
- Coexistence: the compiler owns only what it generated. Hand-made graphs, components and widget layouts in the same asset are left alone, and manual edits to owned parts are detected and refused.
- A release gate: nothing reaches the real mod folder unless the build is clean, tests pass and the audit passes.

Non-goals (phase 1)
- C++, cross-platform support, or more than one Mod Editor build at a time. A new build means a new profile, not code changes.
- Uploading to mod.io. The user always does uploads in the editor.
- Widget designer layout as code. Layout stays in the designer (hybrid mode, section 13).
- Round-tripping hand-made Blueprints back into TypeScript (no decompiler).
- Closures, exceptions, Promises, `new` on plain classes, user-defined pure functions.

## 2. User-facing workflow

### 2.1 Layout

The mod project (the `.uplugin` folder, usually `<Documents>\Abiotic Factor Mods\<Mod>`) and the TS project are separate folders. `abfc init` refuses to create a TS project inside a mod folder: it walks up from the target and fails if any ancestor holds a `.uplugin`.

```
example-mod-ts/                   # TS project, its own git repo, linked to exactly one mod
  abf.config.json                 # project config (schema 2), committed, names the mod, no machine paths
  tsconfig.json                   # strict, extends .abfc/tsconfig.paths.json (no tsserver plugin since 1.0)
  src/                            # sourceRoot: the folder layout below it IS the asset layout (section 18.1)
    Relays/MyRelay.ts             # @blueprint() class MyRelay -> /<mod>/Relays/MyRelay
    Relays/MyRelay.test.ts        # compiled to bp_game_test steps (test files never define assets)
  .abfc/                          # gitignored except manifest/
    tsconfig.paths.json           # per machine: /Script/*, /Game/*, @mod/*, @abfc/runtime, @abfc/testkit
    stubs/<profileId>/...         # generated per machine (never committed)
    manifest/<asset>.json         # ownership + hashes + recorded source file (committed)
    sourcemap/<asset>.json        # IR id <-> TS span <-> real node name
    cache/                        # incremental build cache, env discovery cache
    reports/                      # manual-checks.md
    runs.jsonl                    # timings of every build step
  .vscode/tasks.json, extensions.json   # written by abfc init when absent
```

No `package.json` and no `node_modules` are needed: the types of `@abfc/runtime` and `@abfc/testkit` come from the abfc install through `.abfc/tsconfig.paths.json` (section 18.8). A source install (npm or git) works the same way. `abfc init` (section 18.5) writes `.gitignore` with `.abfc/stubs/`, `.abfc/cache/`, `.abfc/sourcemap/`, `.abfc/sourcemaps/`, `.abfc/reports/`, `.abfc/runs.jsonl`, `.abfc/lock.json`, `.abfc/tsconfig.paths.json`, `node_modules/`.

### 2.2 `abf.config.json` (project, committed)

```json
{
  "schemaVersion": 2,
  "mod": { "name": "ExampleMod" },
  "sourceRoot": "src",
  "classManager": { "table": "DataTables/DT_ClassManager" },
  "stubs": {
    "classes": [
      "/Game/Blueprints/Characters/Abiotic_PlayerCharacter.Abiotic_PlayerCharacter_C"
    ],
    "scriptClasses": ["/Script/Engine.Actor", "/Script/Engine.KismetSystemLibrary"],
    "modAssets": "all",
    "widgetMembers": {}
  },
  "backend": { "kind": "bp_apply", "minProtocol": 1 }
}
```

The full key list, validation, the schema-1 migration and the per-machine user config are in section 18.4. `mod.name` is the only place the mod's name appears in a project: switching the target mod (a test mod and the real mod, for example) is a change of that one value. Machine-specific values (`editor.root`, `modsDir`, `mod.dir`, `backend.serverDir`, `backend.python`, `headlessDir`) are still read here but `abfc doctor` warns about them (ABFC1021 warning). Their home is the user config `%APPDATA%\abfc\config.json` (or the file named by `ABFC_USER_CONFIG`), which `abfc init` writes and which is never committed.

### 2.3 CLI

| Command | Needs editor | What it does |
| --- | --- | --- |
| `abfc init [dir] [--mod <name>] [--yes] [--no-generate]` | no (the installed editor for stubs) | Detects the Mod Editor and the mods folder, lists the mods, links one existing mod, writes the project files and the user config, runs `abfc generate`, ends with `doctor` (section 18.5). Refuses inside a mod folder. Re-running upgrades a schema-1 config and fills in missing files. |
| `abfc lsp [--stdio]` | no | Language server over stdio for any LSP editor (section 18.6). |
| `abfc version [--json]` (alias `abfc --version`) | no | Prints the abfc version, the install kind (exe or source install) and the Node version; `--json` prints one object. Works outside a project. |
| `abfc mv <asset> <new path>` | no | Not needed: with backend 2.6.0 a moved or renamed class file renames its asset on the next build (section 8.6, 18.2). The original probe (7a) failed because `bp_apply` forbids asset rename and delete; the separate `bp_asset_ops` tool does them. |
| `abfc doctor [--deep] [--clean-runtimes]` | no (yes with `--deep`) | Print every discovered path with its source (flag, env, config, auto) and the backend version and capabilities. `--deep` verifies the exe's runtime folder by sha256 (section 18.8) and runs one commandlet to read the engine version. `--clean-runtimes` works outside a project. |
| `abfc generate` | yes | Generate `.d.ts` stubs from editor reflection for the current editor build (section 5). |
| `abfc check` | no | tsc, the TS subset checker and lowering to IR. No backend. Fast. `--watch` re-runs on every save (0.3 to 0.5 s on the test project) and cannot be combined with `--json`. ESLint (`@abfc/eslint-plugin`) runs separately, in the editor or with `eslint`; `abfc check` does not run it. |
| `abfc build [--resync] [--drift] [--keep-failed-stage]` | yes | check, then stage, drift check, apply the changed units, compile report, update manifest and source map. After an Unreal compile failure the stage is re-synced from the mod unless `--keep-failed-stage` is given. `--drift` reads and drift-checks every owned asset. |
| `abfc test [pattern]` | yes | build, then run `*.test.ts` as bp_game_test runs. |
| `abfc audit` | yes | Not built for 1.0; `abfc publish --full --dry-run` runs gates 1 to 7 without copying. |
| `abfc publish [--full] [--dry-run]` | yes | Build, then bp_publish of the owned assets into the project's mod (section 12). `--full` first runs the release checks (tests, stage audit, upload file check). Never uploads. |
| `abfc adopt <asset> <event\|function>` | yes | One-time takeover of an existing hand-made unit (section 8.4). Deprecated since the TypeScript-wins model (warning ABFC5015): a build replaces a hand-made unit of the same name anyway. |
| `abfc status` | yes | Drift report: owned units, their hashes, manual edits found. |

Global flags: `--json` (machine-readable output for scripts and AI front ends), `--editor-root`, `--mod-dir`, `--backend-dir`, `--python`, `--headless-dir`, `--verbose`, `--quiet`/`-q`, `--timings`. Exit codes: 0 ok, 1 diagnostics (user errors), 2 environment or backend failure, 3 refused by a safety rule.

Output contract: stdout carries results (and, with `--json`, the single JSON document); stderr carries diagnostics, progress and, with `--verbose`, the backend's own log (dimmed and indented while a step runs). Progress is a header (`abfc <command> · profile … · mod …`, except for `doctor`, whose stdout already says the same), one step per slow phase, a summary and `done in <time>`. A live spinner with counters (`Reading mod assets 12/40`) is drawn only when stderr is a terminal; otherwise (pipe, CI, tests) each finished step prints one plain line, `✔ <step> (<time>)` (`✖` on failure), with no `\r` and no ANSI. In plain mode, result lines that belong to a step (such as the status unit lines or the publish `would publish:` list) print before that step's `✔` line, and a `--timings` report prints after the summary. `--quiet` hides the header, steps, summary and `done in`; results and diagnostics still print. `--json` has no progress, no notes and no colors. Colors follow `FORCE_COLOR`, then `NO_COLOR`, then `TERM=dumb`, then whether the stream is a terminal; stdout results are colored only when stdout itself is a terminal. Colors are ANSI only: the text of results and diagnostics is identical with or without them.

### 2.4 VS Code

- Since 1.0 the editor support is `abfc lsp` (section 18.6), started by the small VS Code extension shipped as a `.vsix` in the release (section 18.7). VS Code's own TypeScript service keeps doing completion, TypeScript errors and type hover; the abfc server adds the ABFC diagnostics (subset checker, lowering, tests, lock codes, the lint rules), the Blueprint-node hover and the quick fixes. The workspace TypeScript and `typescript.tsdk` are no longer needed.
- Phase 5 to 6 (before 1.0): squiggles came from tsc plus `@abfc/ts-plugin`, a tsserver plugin running the same subset checker as `abfc check`; it needed the workspace TypeScript (6.0.3). The plugin is retired in 1.0 (section 18.6).
- Hover on a statement shows the Blueprint nodes it lowers to. Quick fixes: `/` on integers (`idiv(a, b)`, ABFC2010), TypeScript's "possibly null" errors on a property access (`?.`, lowers to IsValid plus Branch), and the project-model fixes of section 18 (ABFC2005, ABFC2006, ABFC2008, ABFC2076, ABFC5012). Setup and limits: [language-service.md](language-service.md).
- `@abfc/eslint-plugin` adds five lint rules (heavy calls, loops and unbounded array growth in tick, replicated writes without authority, RPC misuse), documented with examples in [lint-rules.md](lint-rules.md).
- `abfc init` writes tasks `abfc: check` (watch), `abfc: build` and `abfc: test`, with a problem matcher for `^(.*\.ts):(\d+):(\d+): (error|warning) (ABFC\d+): (.*)$`.
- Problem-matcher lines are always printed at column 0 (never indented), and tasks should pass `--quiet` so the live progress line never shares a terminal line with a diagnostic.
- Unreal compile errors and test failures show up in the Problems panel at the TS line that produced the failing node (section 8.6).

## 3. Architecture and packages

npm workspaces monorepo `abf-blueprint-ts`, built with `tsc -b`, tests on `node:test`. No bundler, no native addons: every runtime dependency is pure JS so `bunx abfc` can work, but only Node 24 LTS is tested and supported. `package.json` has `engines.node: ">=24 <25"`, `.nvmrc` is `24`, and `typescript` is pinned to one exact version, chosen in Phase 0 from the JS-based 5.x/6.x line because the compiler API is needed: `6.0.3`, the highest stable 6.x (verified in Phase 0, P9). TypeScript 7.x exposes only `typescript/unstable/*` API subpaths, so it is not used until it has a stable programmatic API. The seam of section 3 compiles with `tsc -b` on this version. The npm scope `@abfc` is a placeholder (open question).

| Package | Role | Depends on |
| --- | --- | --- |
| `@abfc/runtime` | Ambient declarations users import: decorators (`blueprint`, `override`, `event`, `replicated`...), intrinsics (`cast`, `isValid`, `idiv`, `await`-able latent helpers), branded number types. Types only, no runtime code. | none |
| `@abfc/ir` | IR types, JSON schema, `renderT3D(node)`, hashing, validation. | none |
| `@abfc/env` | Config precedence, editor, mods folder, Python and backend discovery, profiles. | none |
| `@abfc/compiler` | Frontend (TS -> HIR), lowering (HIR -> IR), planner (IR + manifest -> passes), source maps. | `typescript`, `@abfc/ir` |
| `@abfc/backend` | `Backend` interface, MCP-over-stdio client, the `bp_apply`, `import_nodes` and `paste_graph` adapters. | `@abfc/ir`, `@abfc/env` |
| `@abfc/stubgen` | Reflection result -> `.d.ts` files plus stub lock. | `@abfc/backend`, `@abfc/env` |
| `@abfc/testkit` | `*.test.ts` recorder -> bp_game_test steps. | `@abfc/ir` |
| `@abfc/ts-plugin` | Retired; deleted in 7b (replaced by `@abfc/lsp`). | |
| `@abfc/lsp` (1.0) | Stdio language server behind `abfc lsp`: diagnostics, hover, code actions (section 18.6). | `@abfc/compiler`, `@abfc/env`, `@abfc/ir`, `@abfc/stubgen` (stub lock check), `@abfc/eslint-plugin`, `eslint` (`Linter` only), `@typescript-eslint/parser`, `vscode-languageserver`, `vscode-languageserver-textdocument` |
| `@abfc/eslint-plugin` | Network and performance rules. | `@typescript-eslint/utils` |
| `@abfc/cli` | `abfc` bin. Orchestration and diagnostics printing. | all |
| `abfc-vscode` (1.0, `packages/vscode`, private) | The VS Code extension, built to a `.vsix`, never published to npm or the marketplace (section 18.7). | `vscode-languageclient` |

Release builds (section 18.8, 18.10) bundle the CLI with esbuild into one CommonJS file for the Node single-executable `abfc.exe`, and the extension into one file for the `.vsix`. The npm packages themselves stay unbundled `tsc -b` output.

Pipeline:

```
.ts --frontend--> HIR --lower--> IR (assets, vars, units, nodes, wires)
                                  |
manifest + bp_read snapshot --planner--> ApplyPlan (ordered passes, only changed units)
                                  |
                       Backend.apply / compile / gameTest / audit / publish
                                  |
            node-name map + compile log --> source map --> file.ts:l:c diagnostics
```

Type-checker isolation: `packages/compiler/src/frontend/` is the only code that imports `typescript`. It turns the checked program into HIR, a small typed tree that holds resolved symbols, Blueprint types and source spans. Lowering, planning and backends never see a `ts.Node` or `ts.Type`. Replacing the frontend with a native TypeScript (tsgo / TS 7) API is then a change in one folder. The language server (`@abfc/lsp`) calls the compiler's `checkProject()`, the same function `abfc check` uses, so the subset rules have a single source of truth.

## 4. The TS subset and lowering rules

### 4.1 Classes and members

| TS | Blueprint |
| --- | --- |
| `@blueprint({path?, parent?, replicates?, alwaysRelevant?, onlyRelevantToOwner?, netUpdateFrequency?, minNetUpdateFrequency?, tickInterval?, kind?, classManagerRow?}) class X extends Parent`, also `@blueprint()` | Since 1.0 the asset path is derived from the file's folder under `src/` and the class name (section 18.1); `path` is an optional override, relative to the mod (`"Relays/X"`) or, for older code, absolute under `/<Mod>/`. `@director("Row")` (section 18.3) replaces `classManagerRow`, which is deprecated (ABFC2076). Before 1.0: Blueprint asset at `path` (must be under `/<Mod>/`), parent class, class defaults applied in the class-defaults pass. `classManagerRow` names the DT_ClassManager row asset (verify-only: the class-defaults pass checks read-only that the row references this class and reports ABFC2070 as a warning otherwise; abfc does not create or change the row). Option values must be literals (ABFC2061); the actor-only options need an `Actor` parent (ABFC2062). `tickEnabled` is not supported yet: it is ABFC2063, because writing the saved `PrimaryActorTick.bStartWithTickEnabled` (not the CDO tick function's state, which is all `set_actor_tick_enabled` changes) has not been verified in the editor. |
| Own field `Name!: T;` or `Name: T = <literal>` (also `Map<K,V>`, `Set<T>` with `!`) | Member variable owned by abfc, declared with `!` and no initializer, or without `!` and with a literal initializer of the field type (a number for `int`, `int64`, `byte`, `float`, `double`; `true` or `false` for `boolean`; a string for `string` and `name`; an enum value for an enum field), which becomes the variable's default (any other form is ABFC2047; struct, object, array, Map, Set and text fields have no default). Changing or removing the initializer of a field already in the manifest updates the default in place, with the guid kept (bp_apply feature `variable_defaults`; a backend without it leaves the default as it is and prints warning ABFC2084). Changing the type of a field already in the manifest recreates the variable (remove and add in one spec, every unit of the class applied again) with warning ABFC2047. A field removed from the TS is removed from the asset and the manifest, with warning ABFC5011. |
| `@override ReceiveTick(dt: double)` | `K2Node_Event` with `bOverrideFunction` (bp_apply `override`). The name must exist on a parent stub with `@bpPath`; parameters are typed from the stub; the unit id is `override:<Name>`. `abfc adopt <asset> override:<Name>` takes over a hand-made override event. |
| `@event Foo(a: int)` | `K2Node_CustomEvent` in `EventGraph`. `@event({server|client|multicast, reliable})` sets net flags (raw node props, Phase 2). A `/** ... */` doc comment on an `@event` becomes the tooltip of its custom event node: the text before the first `@` line is the tooltip (newlines kept), `@category <text>` and `@keywords <text>` fill the other two fields. The backend writes them as the node's `MetaData=(ToolTip=,Category=,Keywords=)` (bp_apply feature `event_meta`, events only; the function-level `FunctionMetaData` line is dropped on import and function graphs are not covered). Against a backend without `event_meta`, a documented `@event` still builds (without the tooltip) and abfc prints warning ABFC2071. The unit cache (`.abfc/cache/units.json`) records per documented event whether the backend wrote the tooltip; after the backend is updated, the next `abfc build` applies those events again (once) and the warning goes away, with no flag needed. Undocumented events are unaffected. An own `@event` or `@override` called as `this.Foo(x)` lowers to a call of that event; a reference to an own `@event` method passed to a delegate-typed parameter becomes a delegate cross wire (section 6.1), anywhere else it is ABFC2054. |
| Undecorated method | Function graph `<Name>` (unit `function:<Name>`): parameters = inputs, a non-void return = output `ReturnValue`, `private`/`protected` = Blueprint access. The graph is owned whole: any change recreates it (bp_apply `remove_functions` + `functions`, feature `function_graphs`), and callers in the same class are applied again. Calls are impure call nodes. Several `return`s or a literal go through a member temp `abfc_<Name>_r`. No getters or setters, static methods, optional or default parameters (ABFC2099), recursion (ABFC2085), `await` or latent calls (ABFC2086), names of parent members (ABFC2087). |
| `interface BP_X extends BP_X_Manual {}` | Declaration merging with the stub of the asset's hand-made members, so TS sees members it does not own (section 8.4). |

### 4.2 Expressions and statements

- `&&`, `||`, `?:` and `??` lower to Branch nodes and merge points. Blueprint AND, OR and Select evaluate both sides, so `x !== null && x.foo` would read None. The rule holds everywhere in phase 1. A later optimization may use BooleanAND for operands proven pure and null-safe.
- Pure results: a pure node's output is recomputed for every consumer. When a pure call result (not a plain variable get or literal) has two or more consumers, it is stored in a temp variable first. Temps are owned member variables named `abfc_<unit>_t<n>` (transient, not replicated, not editable) in event graphs, and function locals in functions when the backend reports `functionLocals`. Otherwise functions also get member temps (`abfc_<Function>_t<n>`, and `abfc_<Function>_r` for a return value). bp_apply has no local-variable spec today, so a function has no locals of its own and recursion is error ABFC2085.
- Numbers: branded `int`, `int64`, `byte`, `float`, `double` (Blueprint `real`/double). Literals are inferred from context. Mixing kinds needs an explicit conversion (`toDouble(i)`, `trunc(d)`). `/` on integer types is error ABFC2010 (use `idiv(a, b)`, a runtime intrinsic that lowers to `Divide_IntInt`; non-integer operands are ABFC2012); `%` on ints maps to `Percent_IntInt`.
- `cast(x, T)` returns `T | null`. `if (c)`, `if (!c)` and `?.` on the result are wired to the cast node's success and `CastFailed` exec pins, not to an extra IsValid. `?.` on other values lowers to `KismetSystemLibrary.IsValid` plus Branch. A null path through `cast(a?.b, T)` merges into the cast-failed path.
- `isValid(x)` is a type guard that maps to `IsValid` plus Branch.
- Enums: an enum-typed pin or parameter is typed `EnumText<"/Script/Module.EEnum">` in the stubs (the reflect data has no value lists, so no literal union). A string literal passed to it becomes a pin default (`enumLit`); the text is checked against the enum only when a literal union is known (ABFC2015). `nameOf("x")` gives a `name` literal.
- Assets: `asset(Class, "/Game/Dir/Asset")` or `asset(Class, "@mod/Dir/Asset")` is an asset reference typed as `Class`. It lowers to no node: it becomes the default object (`<class>'<package>.<name>'`) of the pin it feeds (call argument, `push`, `[i] =`, variable set), so the reference is hard and cooks with the Blueprint. Anywhere else (an operand of another expression) it is ABFC2099.
- Widgets and spawning: `createWidget(WidgetClass, owningPlayer)` lowers to `K2Node_CreateWidget` (the class as a pin object). `spawnActor(ActorClass, {owner?, instigator?, collisionHandlingOverride?, transformScaleMethod?})` lowers to `K2Node_SpawnActorFromClass` with a `MakeTransform` node (zero location and rotation, unit scale) on `SpawnTransform`; the options must be an object literal with those four optional keys. An imported Blueprint class in an argument position typed as a class lowers to a class pin object.
- Ternary in assignment: `this.X = c ? a : b` (a statement on a self variable) lowers to Branch plus two variable sets, no Select node (each arm is evaluated only on its own path).
- Arithmetic and comparison: `+ - *` and `< <= > >=` on `int` or `double`, and `/` on `double`, lower to `Add_`/`Subtract_`/`Multiply_`/`Divide_`/`Less_`/`LessEqual_`/`Greater_`/`GreaterEqual_` with the `IntInt` or `DoubleDouble` suffix. Mixed kinds are ABFC2012. `&&` and `||` stay condition-only.
- Counted `for`: `for (let i = init; cond; i++ | i--)` is a loop (see Loops: a simple `i < E` or `i <= E` loop becomes a ForLoop macro, any other a counter variable `abfc_<unit>_i<n>` plus Branch and a back-edge); the counter is usable as an `int` inside the body only. Array mutation (`push`, `splice(i, 1)`, `length = 0`, and element writes `this.Arr[i] = x`, which lower to `Array_Set` with `bSizeToFit` false) needs a self variable as the array (ABFC2041 otherwise); `indexOf` lowers to `Array_Find` and `a[i]` to `K2Node_GetArrayItem`.
- `===`/`!==` map to the typed `EqualEqual_*`/`NotEqual_*` from stubs (object, name, int, double, bool, enum). `==` is error ABFC2011.
- Functions with ExpandEnumAsExecs outputs (such as `GetGlobalItemRow`, with `Valid`/`NotValid`) return a discriminated value: `const r = f(); if (r.exec === "Valid") {...}`. The compiler wires the branches to the exec pins. Using `r.exec` in any other way is an error.
- Loops: `for (const x of arr)` without a `return` anywhere in its body lowers to one instance of the StandardMacros `ForEachLoop` (bp_apply node kind `std_macro`; the element is the macro's `Array Element` pin, no counter variable). A counted `for (let i = A; i < E; i++)` or `i <= E` (step +1, a pure bound `E` that does not read `i`, no `return` in the body) lowers to a `ForLoop` instance (`i < E` maps to `LastIndex` = `E - 1`; `FirstIndex` is `A`, evaluated once before the loop). A body with a `break` of the loop uses `ForEachLoopWithBreak` / `ForLoopWithBreak` instead (each `break` is wired to the macro's `Break` pin, and the code after the loop runs from `Completed`); `continue` ends the body chain (the next iteration), and in counter loops `break` joins the loop exit and `continue` runs into the increment. `arr.forEach((x, i) => { ... })` (an inline arrow function with a block body, over a Blueprint array) is the same loop with `i` = the `Array Index` pin, and `return;` in the callback skips to the next element; other forms are ABFC2090. Every other loop (a decrementing counter, any other condition, an impure bound, a `return` in the body) lowers to Branch nodes plus a back-edge and an owned counter variable `abfc_<unit>_i<n>` (a counter plus `Array_Length` and `Array_Get` for `for..of`); `return` stays on the counter lowering because ending a macro body chain means "next iteration", not "leave the event". `while`, `do` and labeled `break`/`continue` are not supported. A backend without the `std_macro` node kind makes `abfc build` lower the same loops as counter loops and warn with ABFC2088. Exec back-edges are accepted by bp_apply in both a function graph and the event graph, and a counter loop counted to 10 in a game test (verified in Phase 0, P4). Loops inside `@override ReceiveTick` get an ESLint warning.
- `await latentCall(...)` (stub flag `latent`) is allowed only directly in `@event` and `@override` event bodies, never inside a function (ABFC2086), and not inside loops (ABFC2030, ABFC2031). The code after the `await` continues from the latent node's completion pin.
- Arrays: `T[]` maps to Blueprint arrays. `.length`, `push`, `[i]` (typed `T | undefined` under `noUncheckedIndexedAccess`; the compiler requires a bounds check or `!`, and `!` is flagged by lint), `includes`, `indexOf`, `splice(i,1)`, `length = 0` (`Array_Clear`). These map to `K2Node_CallArrayFunction` and `K2Node_GetArrayItem`, which need native node kinds with explicit pin types (see 7.3; verified in Phase 0, P5).
- `Map<K,V>` and `Set<T>`: lowered only when the backend reports `containerTypes.map/set`. Otherwise the feature gate reports ABFC2044 before anything launches (ABFC2040/2042/2043 for unsupported element types and operations; parallel-array lowering was not needed). Native `Map`/`Set` work on own fields (`Name!: Map<name, int>;`, ABFC2047). A `Map<name,int>` variable compiled and passed a game test in Phase 0 (P6), and Phase 4 added the backend `set:` grammar and verified the Map/Set pins live. The `map` and `set` capabilities are on by policy (**stage audit pending**: the stage `mod_audit` has not passed, see the Phase 4 result in docs/roadmap.md). If a later audit rejects them, the policy flips to false.
- Struct literals of existing engine structs map to `Make<Struct>`, and member reads map to `Break<Struct>`, cached as pure results. Mod-defined `@struct` classes become UserDefinedStructs (create-if-missing). Python in this build cannot set struct fields, so the backend (`struct_fields`) writes `VariablesDescriptions` on a throwaway struct and duplicates it to the final path. Changing the fields of an existing struct is refused (ABFC2046); it needs a trusted delete plus recompiling referencers and is deferred. The `struct` capability is on by policy (**stage audit pending**: acceptance by audit and cook is unverified; compile and game tests passed). If a later audit rejects it, `@struct` is dropped and ABFC2045 explains why.
- Template literals lower to `K2Node_FormatText` (arguments named after the substituted identifiers or properties, braces escaped). Where a `text` is expected that is the value; where a `string` is expected, or nothing is expected (a `const`), it is followed by `KismetTextLibrary.Conv_TextToString` (profile `functions.textToString`). Other expected types (such as `name`) are ABFC2099; a backtick string without substitutions is a string literal. `name`, `string` and `text` are distinct branded types.
- Compile errors with clear messages: closures and arrow functions (except `@abfc/testkit` callbacks and an inline `forEach` callback), `try/catch/throw`, Promises other than `await` on latent calls, `new` on non-Blueprint classes, generators, `any`, `eval`, spread of objects, optional parameters without defaults, recursion between `@event`s through `await`.

`tsconfig` is generated strict: `strict`, `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useDefineForClassFields`, with TS standard decorators (not `experimentalDecorators`). Decorators never run: the compiler reads them statically.

### 4.3 Example: an info relay, `UpdateTarget`

In the example mod `ExampleMod`, the relay actor `BP_PotInfoRelay` has a hand-made event `UpdateTarget` (about 41 nodes in `EventGraph`) that does this: `OwnerPC.K2_GetPawn` -> cast to `Abiotic_PlayerCharacter_C` -> read `BestInteractable_InteractA` -> cast to `Deployed_PotOfSoup_C` -> IsValid macro -> branch on `CanFillSoupBowl` -> compare with `LastTarget`/`LastRowName` (BooleanAND) -> set both -> `GetGlobalItemRow` (Valid/NotValid) -> break `AbioticInventoryItem` -> `AbioticConsumable` -> skip when hunger, thirst and buff count are all zero -> `ForEachLoop` over `Infos` -> `ShowInfo` -> `bLastVisible = true`. Every failure path calls `HideAll`. The first ones also clear `LastTarget`.

```ts
import { blueprint, event, cast, isValid } from "@abfc/runtime";
import { Actor } from "/Script/Engine";
import { GlobalItemHandleFunctionLibrary as Items } from "/Script/AbioticFactor";
import { Abiotic_PlayerCharacter_C } from "/Game/Blueprints/Characters/Abiotic_PlayerCharacter";
import { Deployed_PotOfSoup_C } from "/Game/Blueprints/DeployedObjects/Furniture/Deployed_PotOfSoup";
import type { BP_PotInfoRelay_Manual } from "/ExampleMod/PotInfo/BP_PotInfoRelay";

export interface BP_PotInfoRelay extends BP_PotInfoRelay_Manual {} // OwnerPC, LastTarget, Infos, HideAll...

@blueprint({ path: "/ExampleMod/PotInfo/BP_PotInfoRelay" })
export class BP_PotInfoRelay extends Actor {
  @event
  UpdateTarget(): void {
    const player = cast(this.OwnerPC?.K2_GetPawn(), Abiotic_PlayerCharacter_C);
    const pot = cast(player?.BestInteractable_InteractA, Deployed_PotOfSoup_C);
    if (!pot || !pot.CanFillSoupBowl) {
      this.HideAll();
      this.LastTarget = null;
      return;
    }
    const rowName = Items.Conv_GlobalItemToName(pot.ItemRow);
    if (pot === this.LastTarget && rowName === this.LastRowName) return;
    this.LastTarget = pot;
    this.LastRowName = rowName;
    const row = Items.GetGlobalItemRow(pot.ItemRow);
    if (row.exec !== "Valid") { this.HideAll(); return; }
    const c = row.Data.ConsumableData;
    if (c.HungerFill === 0 && c.ThirstFill === 0 && c.BuffsToAdd.length === 0) { this.HideAll(); return; }
    for (const info of this.Infos) {
      if (isValid(info)) info.ShowInfo(c.HungerFill, c.ThirstFill, c.BuffsToAdd, c.BuffsToRemove, true);
    }
    this.bLastVisible = true;
  }
}
```

What it lowers to (IR nodes, abbreviated):

```
ev   CustomEvent UpdateTarget
g0   VariableGet OwnerPC
v0   CallFunction KismetSystemLibrary.IsValid(g0)   ; from ?. (strictNullChecks forces it; the original
b0   Branch(v0)                                      ;   graph called K2_GetPawn on a possible None)
p0   CallFunction Controller.K2_GetPawn self=g0      ; pure
c0   DynamicCast -> Abiotic_PlayerCharacter_C (p0)   ; b0.else -> fail path F1
g1   VariableGet Abiotic_PlayerCharacter_C.BestInteractable_InteractA self=c0.AsAbiotic...
c1   DynamicCast -> Deployed_PotOfSoup_C (g1)        ; c0.CastFailed, c1.CastFailed -> F1
g2   VariableGet Deployed_PotOfSoup_C.CanFillSoupBowl self=c1.As...
b1   Branch(g2)                                      ; else -> F1
n0   CallFunction Items.Conv_GlobalItemToName(ItemRow)  ; 2 consumers -> cached:
s0   VariableSet abfc_UpdateTarget_t0 = n0
e0   EqualEqual_ObjectObject(c1.As..., LastTarget) ; b2 Branch(e0) -> then: e1 EqualEqual_NameName(t0, LastRowName); b3 Branch(e1) then -> return
...  VariableSet LastTarget, VariableSet LastRowName(t0), CallFunction GetGlobalItemRow (Valid / NotValid exec pins)
...  BreakStruct AbioticInventoryItem -> BreakStruct AbioticConsumable (cached: used by compare and by ShowInfo)
...  3 chained Branches for the && chain, loop (counter var abfc_UpdateTarget_i0, Array_Length, Array_Get, back-edge)
F1   CallFunction HideAll -> VariableSet LastTarget = None
```

Behavior matches the original, except for the extra IsValid on `OwnerPC`, which removes an "Accessed None" on unowned relays. The `&&` chains become Branch chains instead of BooleanAND. A hand-made caller that calls `UpdateTarget` by name (for example in `RelayTick`) keeps working because the event name does not change. Pin names here (`CastFailed`, `ReturnValue`, `Valid`, `NotValid`, `Data`, `InHandle`, `RowHandle`) are the ones in today's export, and the stubs reproduce them byte-for-byte (verified in Phase 0, P1). Phase 0 built and ran an equivalent slice of a real mod against a staged copy (P3): the original unit was 41 nodes, the lowered one 51, it compiled clean, the mod's existing game test still passed and the caller still linked. The caller's `MemberGuid` stays stale after the event is replaced and still resolves by name. The real graph differed in detail from this example (no `OwnerPC` `IsValid`, a `StandardMacros` `IsValid` on the pot, and `Double` zero checks plus `Array_Length` ANDed); the probe followed the original data flow. The slice built only after the wildcard pins of the array and cast nodes were resolved (7.3).

## 5. Stubs: generation and versioning

### 5.1 What is generated

- `/Script/<Module>` (from `stubs.scriptModules`): every class, struct and enum with Blueprint-visible members. Function libraries become `declare namespace`s with static functions.
- `/Game/...` classes: every game class of the catalog (see "Automatic stubs" in 5.3; `stubs.classes` only adds optional extras), plus the closure of the types their members use, to a depth of 2. The parent chain of every emitted class is always complete: each ancestor, Blueprint or native (a game module's controller class, a parent Blueprint, an engine class), is reflected with its members whatever its depth, and every class extends its real direct parent up to UObject. Only types reached through member signatures beyond depth 2 become opaque `declare class X extends <real parent or UObject> {}` with `@bpPath` and `@bpOpaque`; an opaque class extends its real parent whenever the backend's `supers` or a chain names it. `_index.json` lists `chainGaps` (a class whose chain reaches a placeholder or a loop), `noSupers` (reflected `/Game` classes the backend gave no Blueprint parents for) and `opaqueNoParent` (opaque classes whose parent is unknown and that extend UObject). `abfc generate` warns ABFC3013 for `noSupers` and `chainGaps`, and `node scripts/stub-chain-audit.mjs --stubs <profile dir>` runs the same rule over any written stub folder (read only).
- The mod's own hand-made assets (`stubs.modAssets`): one `<Asset>_Manual` interface per asset, holding only members the manifest does not mark as owned.
- Module specifiers are UE package paths (`"/Script/Engine"`, `"/Game/Blueprints/Characters/Abiotic_PlayerCharacter"`), mapped by `tsconfig.paths` to `.abfc/stubs/<profileId>/...`. Imports stay unambiguous and identical on every machine.

Each member carries JSDoc tags read by the compiler: `@bpPath`, `@bpPin` (real pin name when it differs from the TS name), `@bpPure`, `@bpLatent`, `@bpExecOutputs Valid,NotValid`, `@bpWorldContext`, `@bpDefaultToSelf`, `@bpNode K2Node_CallArrayFunction` (when the call needs a special node class), plus the description. For hand-made members of the mod's own assets, `@bpReplicated` marks a variable with the replicated flag (`CPF_Net`), and `@bpRpc server|client|multicast` with `@bpReliable` mark a custom event with net flags; the networking lint rules read these tags.

Description line rule: every instance and static function in the stubs starts its JSDoc with one line, `<description> (<Node Name>)`, shown by VS Code on hover and in completion. `<Node Name>` is the display name in the Blueprint node editor: a `displayName` in the curated entry when the editor name differs from the rule, else the reflected `DisplayName` when the engine has one, else Unreal's naming rule (`displayNameOf`: strip `K2_`, underscores to spaces, split camelCase, `Vector2D` becomes `Vector 2D`). The description comes from, in this order: (1) the curated table `packages/stubgen/data/descriptions.json` (own words, keyed by `@bpPath`; 32 entries for engine modules cover every engine function the test corpus calls; the table names no game module), (2) the tooltip reflected from the editor (`reflect` reads `ToolTip` and `DisplayName` per function; this is the route for the functions of game modules, and it only helps where the editor carries a tooltip), (3) the fallback `Calls <Class>.<Function> (<Node Name>).`. Hand-made members of the mod's own assets read `Hand-made function|event of <Asset> (<Display Name>).` Reflected tooltips only land in per-machine generated stubs and are never committed. `scripts/stub-desc-coverage.mjs --project <dir>` lists every function a project calls with its description source and exits 1 when a called engine-module (or `/Game`) function is neither curated nor hand-made or a line does not end in the parenthesized name. A game-module function is accepted with a reflected tooltip or with the fallback line (printed as `reflected` or `fallback`); on the test corpus the 3 game-module functions it calls show the fallback line with the reflected display name, because the editor has no tooltip for them. A guard test (`no-deep-field-names`) keeps game names out of `packages/*/test` and `packages/*/data`. It does not apply to the compiler test fixtures, which use hand-written fake stubs without description lines. Functions the Blueprint filter blocks are kept and tagged `@deprecated Blocked by Blueprint filter: <rule>`, so VS Code strikes them through.

Built-in supplements: reflection lists only the properties of a class's defaults object, which omits instanced subobject properties such as `UWidget::Slot`. stubgen therefore adds a short built-in table of Blueprint-visible properties (`supplements.ts`), merged into the emitted class unless reflection already lists the member. Today it holds `Slot: PanelSlot | null` on `/Script/UMG.Widget`, `readonly` (a graph can read it, not set it). A change to the table changes the generator version (`STUBGEN 0.2.1`), so the stubs are regenerated by `abfc generate`. The complete parent chains described above are generator version 0.6.0: older stubs get the ABFC3001 warning until `abfc generate` runs once.

Calling and typing Blueprint classes written in TypeScript: a TS `@blueprint` class is usable wherever its stub class could be, as the class passed to `createWidget` or `spawnActor`, as a variable or parameter type, and for calls to its own `@event`s. Once abfc owns an event, it disappears from the `<Asset>_C` stub (section 8.3), so a caller uses the TS class, not the stub. `x as T` is allowed only when it leaves the Blueprint type unchanged (the same class, or a type that lowers to the same pin type): it produces no node. Any other `as`, and `as const`, is `ABFC2099`; use `cast(x, T)` for a real cast. A no-substitution template literal is not accepted as text (use a string literal); a template with substitutions lowers to Format Text (section 13).

The filter tag is a warning, not an error. `blueprint_filter_check` has raised false alarms (a PlayerController cast, `IsLocalController`, `K2_GetPawn`) that the real `mod_audit` passed, and `UpdateTarget` uses `K2_GetPawn`. The profile holds a `filterOverrides` list of members that `mod_audit` has passed despite a filter match. Each entry is `{parent, member, reason}` or, for a cast, `{cast, reason}`. Members without an override get `@deprecated Blocked by Blueprint filter: <rule>`, members with one get `@bpFilterOverride <rule>` instead, and a class that resolves to Block carries `@bpCastFilter` (verified in Phase 0, P2: three blocked references, all in the relay, 0 `@deprecated` left once the overrides are applied). The audit in the release gate is the only hard filter check.

### 5.2 How reflection works (verified in Phase 0, P1)

A new backend op `reflect` runs in a hidden commandlet:
1. Enumerate members. `unreal.load_class` loads `/Game` Blueprint classes (no `load_asset`). In this build `unreal.Function` and `unreal.Property` do not exist, so UFunctions come through `unreal.ObjectIterator(unreal.Field)` filtered by `get_outer() == cls` (real FNames), and the super chain is not walkable from Python (`reflect` therefore reports `supers`, every parent class of a loaded class, Blueprint and native, nearest first, from the asset registry's class inheritance with each link checked with `class_is_child_of`; `supers_of` asks for the chains of opaque types without loading their members; a backend that does not report `supers` leaves only the native `ancestors`, and abfc warns ABFC3013). Property names with real FNames come from the output pins of a `K2Node_GetClassDefaults` node whose `Class` pin names the class (the class must be preloaded the way bp_apply's `objects` map does it); that also returns inherited properties. The Python wrapper's `dir()` mapping and the property-chain walk with per-build offsets were not needed and are kept only as fallbacks if the node route breaks on a new build, under the same discover-or-refuse rule bp_apply uses. Nothing under `/Game` is ever T3D-exported: that has crashed the editor.
2. Materialize pins. For each function, property get and property set, place a node in a throwaway scratch Blueprint (the same carrier mechanism bp_apply uses for templates), let the engine allocate pins, export the scratch Blueprint (a mod-side object, which is safe), and parse the pins. That gives the exact pin names, directions, types, defaults, hidden pins, ExpandEnumAsExecs pins, purity (no exec pins) and latency (a `LatentInfo` pin), as the Blueprint editor would create them. The scratch Blueprint is never saved.
3. Metadata (tooltips, display names) is best effort. The Python routes tried in Phase 0 returned no metadata from a spawned node. Phase 5 probed again and found a working route for `/Script` functions: `unreal.EditorAssetLibrary.get_metadata_tag(<UFunction>, "ToolTip" | "DisplayName")`. `reflect` now adds `"meta": {"tooltip", "displayName"}` per function (or null) in a pass capped at 20 s, in the same function chunks; the node-based steps above do not depend on it. Tags on the compiled generated-class functions of a Blueprint read empty, so metadata of mod Blueprint functions cannot be read back this way (verified in Phase 5). In the other direction, an event node's `MetaData=(ToolTip=...)` survives a T3D import and export, while the function-level `FunctionMetaData` line is dropped (section 4.1). Cost: about 60 to 70 s for a cold reflect of the relay's two `/Game` classes plus the library classes (about 1064 members, estimated), once per game version.

### 5.3 Versioning

`.abfc/stubs/<profileId>/stubs.lock.json`:
```json
{ "generator": "0.1.0", "profile": "ue5.4.4-1050002", "engineVersion": "5.4.4-1050002+++DF+ABF",
  "modEditorVersion": "1.5.0", "editorFingerprint": "sha256 of exe size+mtime+Epic AppVersionString",
  "filterContentVersion": "<from the filter header>", "classes": ["..."], "createdAt": "..." }
```
Every `abfc check` and `abfc build` compares the lock with the current editor fingerprint and the compiler's profile:
- Fingerprint changed: `ABFC3001: stubs were generated for Mod Editor 5.4.4-1050002 (1.5.0) but the installed editor is <new>. Run "abfc generate" to regenerate.` The build refuses, and `check` is a warning.
- No profile for the detected build: `ABFC3002: abfc 0.1.0 supports Mod Editor build 5.4.4-1050002 only; found <new>. Update abfc, or wait for a release with a profile for this build.`
- `stubs.classes` changed in the config: regenerate only the delta.

#### Automatic stubs (catalog, full /Game set, on-demand /Script names)

Nobody has to list classes any more. The backend's read-only `catalog` tool (abf-mod-editor-mcp 2.6.0, about 7 s, no asset loads) returns the names of every `/Game` Blueprint class with its parent, and every `/Script` class, struct, enum and function library (with its function names). abfc stores it as `.abfc/stubs/<profile>/_catalog.json` (per project, with the editor fingerprint). From it:
- The full `/Game` set: every catalog game class (widgets, animation Blueprints and interfaces included) gets a stub, minus the classes recorded in `lock.auto.failed`. It is generated once per Mod Editor build in one `reflect` call (about 3-4 minutes, about 195 s for 3098 game classes, about 17 MB, about 3200 files); if that call fails, abfc splits it into chunks of 500 and bisects failing chunks down to single classes, and a class that cannot be reflected lands in `failed` (ABFC3023) instead of failing the run.
- `/Script` names are generated per package on demand: the profile's default engine classes always, plus the names your source imports (`sourceStubImports`), the `--add` paths and the config extras. Enums that nothing references are emitted as opaque types.
- Files in the profile folder: `_catalog.json` (the catalog), `_names.json` (catalog names with module and TypeScript identifier, read by completion), `_cache.json.gz` (merged reflection data, filter pairs and mod assets, valid while editor fingerprint and generator version match, so a later run reflects only the small fresh set), `_coverage.json` (what is reflected and declared, so a build can tell offline whether a name is present), `_library.json` (library functions, so completion does not walk every `.d.ts`).
- Writes are atomic per file (temporary file and rename, retried on Windows sharing errors), unchanged files are not touched, stale ones are pruned, `stubs.lock.json` is removed first and written last, so a crash leaves "no lock" (ABFC3003), which the next build repairs. The single writer lock is the project lock `.abfc/lock.json` that `generate` and `build` already take; the language server only spawns `abfc generate`.
- `stubs.lock.json` gained `auto` (`catalogSha256`, `gameClasses`, `failed`, `added`, and `noCatalog` for backends without the tool). `stubLockHash` (unit cache) hashes only generator, profile, engine version, editor version, fingerprint and filter version, so the longer class lists and `auto` never re-plan units.
- Triggers: `abfc generate`, `abfc init` (runs generate), the start of `abfc build`/`test`/`publish` (decided offline from the lock, catalog, coverage and source imports; the backend is started only when something is missing, never for complete stubs; a failure is ABFC3020 and the build goes on), and the explicit editor quick fix "Generate stubs" (`abfc generate --add`). Keystrokes, `abfc check` and the language server's checks never start the editor.

### 5.4 Per-build profile

`packages/env/profiles/ue5.4.4-1050002.json` holds every version-specific fact. Code reads facts only from the profile.
- engine version string, Mod Editor version, Epic `AppVersionString`, exe relative path
- minimum backend protocol, and backend capabilities expected for this build
- type mapping (`real` is double, `float` is a single-precision property), standard pin names (`execute`, `then`, `else`, `CastFailed`, `ReturnValue`)
- node class paths, and the StandardMacros asset path (fallback loops)
- `filterOverrides`, known limits (`PrintString` not logged, no live HUD hidden, user pure functions rejected), harness constraints
- default mods folder name `Abiotic Factor Mods`

## 6. The IR

### 6.1 Schema (TypeScript, in `@abfc/ir`)

```ts
export interface IrModule {
  irVersion: 1;
  profile: string;                      // "ue5.4.4-1050002"
  mod: string;                          // "ExampleMod"
  assets: IrAsset[];
}
export interface IrAsset {
  path: string;                         // "/ExampleMod/PotInfo/BP_PotInfoRelay" (always under /<mod>/)
  create?: { kind: "Blueprint" | "WidgetBlueprint" | "BlueprintInterface" | "UserDefinedStruct"; parent: string };
  classDefaults?: Record<string, string>;      // property -> T3D value text (True/False, %f floats)
  classManagerRow?: string;                    // row asset path, verified read-only in pass 5
  variables: IrVariable[];
  units: IrUnit[];                      // owned functions/events/overrides
  structFields?: IrVariable[];          // only for UserDefinedStruct
}
export interface IrVariable { name: string; type: IrType; default?: string; flags: VarFlag[]; origin: Span; temp?: boolean }
export type IrType = string;            // bp_apply type grammar: "int", "object:/Script/Engine.Actor", "array:name", "map:name:int" ...
export interface IrUnit {
  id: string;                           // "event:UpdateTarget"
  kind: "function" | "event" | "override";
  name: string;
  graph: string;                        // "EventGraph" for events, the function name for functions
  signature: { inputs: IrParam[]; outputs: IrParam[]; net?: "server" | "client" | "multicast"; reliable?: boolean };
  locals: IrVariable[];                 // honored when the backend has functionLocals; else hoisted by the lowering
  nodes: IrNode[];
  wires: IrWire[];
  crossWires?: Array<{ toUnit: string; from: string; to: string }>;  // delegate wires to another unit's event node
  entryNames?: Record<string, string>;  // real entry node names of cross-wire targets that are not in the plan (from the manifest)
  origin: Span;
  hash: string;                         // sha256 of the canonical JSON of signature+nodes+wires (no positions)
}
export interface IrNode {
  id: string;                           // stable within the unit, derived from AST path: "n_if3_cast0"
  t3d: { class: string; props: string[] };    // authoritative node text without pins (pins are engine-allocated)
  sem?: SemanticTag;                    // optional hint so adapters can pick a native kind
  pinDefaults?: Record<string, string>; // raw T3D defaults
  pinObjects?: Record<string, string>;  // object/class pin defaults by path
  pos: [number, number];
  origin: Span;
}
export type SemanticTag =
  | { k: "call"; class?: string; function: string } | { k: "get" | "set"; name: string; class?: string }
  | { k: "event"; name: string } | { k: "override"; class: string; function: string }
  | { k: "branch" } | { k: "sequence" } | { k: "cast"; target: string } | { k: "self" }
  | { k: "spawn" } | { k: "create_widget" } | { k: "call_dispatcher" | "bind_dispatcher"; name: string };
export type IrWire = [from: `${string}.${string}`, to: `${string}.${string}`]; // output first; "entry"/"result" reserved
export interface Span { file: string; line: number; col: number; endLine: number; endCol: number }
```

`crossWires` connect an owned event's `OutputDelegate` (`from` = `<entry node id>.<pin>`) to a pin of this unit (`to`). The adapter resolves the event node of `toUnit` by IR id when both units are in the plan, otherwise by the real name in the manifest (`entryNames`). When the delegate target is planned, the planner also re-plans the unit that owns the wire, so both hashes are recomputed after apply.

Every node has `t3d` text, so the text-based backends (import_nodes, paste_graph) need nothing else. `sem` exists only so the bp_apply adapter can use its native `k` kinds, which handle class preloading and retargeting. When `sem` is absent, the adapter sends `k: "node"` with `class` and `props`. `renderT3D(node)` in `@abfc/ir` produces the full `Begin Object ... End Object` block (fresh NodeGuid, no pins) for text backends.

### 6.2 Pass ordering

The planner turns an `IrModule` plus the manifest into an `ApplyPlan` with ordered passes. Within each pass, assets are ordered so that callees come before callers (a topological order over cross-asset calls; a cycle is fine because of pass 2).

| Pass | Content | Why |
| --- | --- | --- |
| 0 create | New assets (and UserDefinedStructs) | Later passes reference them. |
| 1 declare | New and changed variables (incl. temps), dispatchers | Variables must exist before get/set nodes. |
| 2 shells | Function signatures (entry and result only), custom event nodes with no body, in all assets | Custom events and functions must exist and compile before callers, or calls are dropped silently (the paste_graph lesson). |
| 3 bodies | Remove the old nodes of changed owned units (by real name from the manifest), add the new nodes and wires, wire them to the shells | The shells are compiled by now. |
| 4 retire | Remove owned variables, functions and events no longer in source | A variable can be removed only after its nodes are gone. In bp_apply, `remove_variables` runs before graphs within one asset spec. A class whose TypeScript is deleted entirely is retired the same way: its orphan manifest is planned as an empty asset (all its units removed), and the retired unit ids are recorded in the manifest as `retiredUnpublished`. With backend 2.6.0 the emptied asset is then deleted in the delete phase after the apply when abfc created it (`created: true`; otherwise it stays, ABFC5017), and a non-hybrid class also loses everything the sweep covers (section 8.1). Structs are never deleted (ABFC5018). Without `assetOps` class defaults abfc set earlier stay as they are (warning `ABFC5010`). |
| 5 defaults | `classDefaults` (tick interval, replication flags) | One bp_apply asset spec with `raw: [{kind: "python", code}]`. The code comes from a fixed template (`defaults-template.ts`): only keys from a validated map and bool/float literals reach it, never user text. It also runs the read-only `classManagerRow` check (ABFC2070 warning). A defaults-only change is its own plan item (`defaults`, hash `classDefaultsHash` in the manifest). |
| 6 tags | Ownership comment boxes (section 8.2) | Its own pass so a refused comment node cannot roll back logic. |

The backend compiles after every pass. A pass with nothing in it is skipped.

### 6.3 Layout

Lowering assigns positions: columns follow exec depth and pure nodes sit left of their consumer. Each owned unit gets its own region below the existing nodes, using the same placement rule bp_apply uses, so generated graphs stay readable when someone opens them in the editor.

## 7. Backend interface

### 7.1 Interface (in `@abfc/backend`)

```ts
export interface BackendCapabilities {
  protocol: number;                       // abf backend protocol version (handshake, not the server's semver)
  writers: Array<"memswap" | "import_nodes" | "paste">;
  headless: boolean;                      // no desktop, mouse, keyboard or focus
  needsOpenEditor: boolean;
  createKinds: Array<"Blueprint" | "WidgetBlueprint" | "BlueprintInterface" | "UserDefinedStruct">;
  containerTypes: { array: boolean; set: boolean; map: boolean };
  userPureFunctions: boolean;
  functionLocals: boolean;
  rawNodes: boolean;                      // arbitrary class + props node text
  replicatedEvents: boolean;
  classDefaults: boolean;
  multiPassPerAsset: boolean;             // same asset may appear in several passes of one transaction
  transactional: boolean;                 // whole plan applies or nothing is saved
  compileErrorNodeRefs: boolean;          // compile errors name the node (needed for line-level mapping)
  nodeNameMap: boolean;                   // returns IR id -> real node name
  reflect: boolean; gameTest: boolean; audit: boolean; publish: boolean;
  warmSession: boolean;                   // can keep one editor process across operations (backend_info capabilities.warmSession and the warm_session tool)
  stageAudit: boolean;                    // mod_audit can audit the staged copy (backend_info capabilities.stageAudit)
}
export interface BackendInfo {
  id: "bp_apply" | "import_nodes" | "paste_graph";
  serverVersion: string; protocol: number; engineVersion: string; editorRoot: string; headlessDir: string;
  capabilities: BackendCapabilities;
}
export interface Backend {
  info(): Promise<BackendInfo>;
  stage(modDir: string, opts: { discardChanges: boolean }): Promise<StageReport>;
  stageStatus(mod: string): Promise<StageStatus>;
  read(mod: string, asset: string): Promise<AssetSnapshot>;        // drift detection, manual-member stubs
  apply(mod: string, plan: ApplyPlan): Promise<ApplyReport>;      // all passes; per-pass compile
  compile(mod: string, assets: string[]): Promise<CompileReport>;
  reflect(req: ReflectRequest): Promise<ReflectResult>;
  gameTest(mod: string, steps: TestStep[], opts: { map?: string; timeoutSeconds: number }): Promise<TestReport>;
  audit(mod: string): Promise<AuditReport>;
  uploadCheck(modDir: string): Promise<UploadCheckReport>;
  publish(mod: string, assets: string[], grant: PublishGrant): Promise<PublishResult>;  // bp_publish; only with a grant from grantPublish(mod.name), minted by abfc publish
  close(): Promise<void>;
}
export interface ApplyReport {
  ok: boolean; rolledBack: boolean; seconds: number; run: string;
  passes: Array<{ pass: number; ok: boolean }>;
  nodeNames: Record<string /*asset*/, Record<string /*unit id*/, Record<string /*IR node id*/, string /*K2Node_X_N*/>>>;
  compile: { errors: CompileMessage[]; warnings: CompileMessage[] };
}
export interface CompileMessage { asset: string; message: string; node?: string /* real node name when available */ }
```

Before `apply`, the planner checks the plan against `capabilities` and fails with a clear error before anything launches, for example `ABFC4010: src/X.ts:12:3: Map<name,int> needs a backend with map support; bp_apply (protocol 1) has none.` Feature gates: maps and sets, user pure functions, UserDefinedStruct, raw nodes, replicated events, headless (tests need `gameTest`), and `transactional` (if it is false, the CLI resyncs staging after a failed build).

### 7.2 Transport

Every adapter talks to `abf-mod-editor-mcp`'s `server.py` the way `test_client.py` does: it spawns `python -I -X utf8 <serverDir>\server.py`, speaks MCP JSON-RPC 2.0 over stdio (one JSON object per line), and calls `tools/call`. There is no second protocol to maintain, and the same server stays usable from Claude. Arguments go in an argv array (never `shell: true`), and the child's environment gets `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`. Large plans go through `spec_file` (a JSON file in `.abfc/cache/`) rather than inline arguments.

Version check: abfc does not rely on the server's semver alone. The backend exposes a read-only tool, `backend_info`, which returns `protocol`, `serverVersion`, `engineVersion`, paths and capabilities. The protocol number is a small integer that changes only when the tool contract changes, so abfc can tell whether the backend has the tools and capabilities it needs, and `abfc doctor` can print them. Version numbers are owned solely by `EmekC/abf-mod-editor-mcp`. If the tool is missing, or `protocol < minProtocol`, the result is `ABFC4001: abf-mod-editor-mcp at <dir> (server <version>) has no backend_info / protocol <n>; abfc needs protocol >= 1. Update it (see docs/backend.md).` The server version has one soft rule on top: abfc names a minimum server version (`MIN_BACKEND_VERSION`, 2.4.0, in `@abfc/backend`), and a backend that reports an older parseable version gets the warning `ABFC4014` in every command that opens the backend and in `abfc doctor`; the protocol stays the hard check. It is a warning because features are already gated per capability (ABFC2044, ABFC2071, ABFC4013) and unparseable versions (test doubles) never warn.

### 7.3 Adapter (a): `bp_apply` (today)

| IR | bp_apply spec |
| --- | --- |
| pass 0 `create` | Missing assets and missing mod-defined structs are created: `create: {class, parent, if_missing: true}`, and for a UserDefinedStruct `create: {class: "UserDefinedStruct", if_missing: true}` plus `struct_fields` (existing structs are compared, never replaced) |
| pass 1 variables | `variables: [{name, type, default, flags}]`, `dispatchers` |
| pass 2 function shells | `functions: [{name, inputs, outputs}]` with no nodes |
| pass 2 event shells | `graphs: [{graph: "EventGraph", add: [{k:"event", name, params}]}]` |
| pass 3 bodies | `functions[].nodes/wires` for new functions. Changed functions and events get `graphs: [{graph, remove: [old names], add, wires}]`, addressing the shell by the real name from `node_ids`. |
| pass 4 retire | `remove_variables`, `remove_functions`, `graphs[].remove` |
| pass 5 defaults | `raw: [{kind: "python", code}]` with a generated, fixed template (CDO `set_editor_property` / `set_actor_tick_interval`; `bStartWithTickEnabled` is not in the template until verified) |
| pass 6 tags | `graphs[].add` of `k:"node"` `EdGraphNode_Comment` |
| node with `sem` | the matching `k` (`call`, `get`, `set`, `event`, `override`, `branch`, `sequence`, `cast`, `self`, `spawn`, `create_widget`, dispatchers) |
| node without `sem` | `{k: "node", class, props}` |

Node classes that bp_apply's `k` kinds do not express and that go through `k: "node"`: `K2Node_CallArrayFunction` (array ops have wildcard pins), `K2Node_GetArrayItem`, `K2Node_BreakStruct`/`K2Node_MakeStruct`, `K2Node_FunctionResult` for early returns with values, `K2Node_CallParentFunction` (`super.X()`), `K2Node_SwitchEnum`/`SwitchName`/`SwitchInteger`, `K2Node_EnumEquality`, `K2Node_FormatText`, `K2Node_MakeArray`, `K2Node_TemporaryVariable` plus `K2Node_AssignmentStatement`, `K2Node_MacroInstance` (StandardMacros fallback; needs the macro graph GUID from reflection), and `K2Node_CustomEvent` with net flags (`FunctionFlags`). Phase 0 probe P5 results: `K2Node_BreakStruct` through `k:"node"` allocates correct pins and compiles. The scratch-template step also allocates the right pin names for `K2Node_CallArrayFunction` and `K2Node_GetArrayItem`, but their wildcard pins (`TargetArray`, `Array`, `Output`) stay undetermined after wiring, because bp_apply wires by text and never runs the engine's pin-type propagation, so the compile fails. Resolved pin lines placed in `props` are ignored. P3 and P6 showed the same for the `Object` pin of the native `cast` kind and for `Map_Add`/`Map_Find` pins. Fallback applied: the backend gets native kinds (`array_call`, `break_struct`, `make_struct`) that set pin types explicitly after template creation, and the same resolution for `cast` and `Map_*` nodes (and, untested, `Select`, `MakeArray`, macros); see section 14. Until then the adapter can use a two-phase route (verified in Phase 0, P3, P5, P6): apply, read the rolled-back `final_0.t3d`, patch the wildcard pins to the real types, and apply the whole graph as a `raw` graph block together with the `variables`. That is safe for existing hand-made nodes only because the text comes from the export and keeps them unchanged. The graph block is never written from scratch.

Other mappings:
- `multiPassPerAsset`: whether one bp_apply batch may list the same asset several times is **unverified**. If it may not, the adapter issues one bp_apply call per pass. bp_apply then rolls back only the failing call, so `transactional` is false and the CLI re-runs `staging_sync` with `discard_changes` on failure. That is safe because staging is abfc's build area and the real mod stays untouched until publish.
- Capabilities with backend 2.4.0: `headless`, `rawNodes`, `classDefaults`, `nodeNameMap` (`node_ids`), `gameTest`, `audit`, `publish`, `reflect` (when the server runs with `ABF_ABFC_TOOLS=1`, which abfc sets), `compileErrorNodeRefs` (compile messages carry the node and graph), `pinTypes` (native array, struct and cast kinds with explicit pin types), `containerTypes.map/set` and the `struct` feature (`struct_fields`; on by policy with the stage audit pending; `abfc publish --full` re-runs the audit), `warmSession` (opt-in, `ABF_WARM_SESSION=1`, which abfc sets unless `--cold`) and `stageAudit` are true. `userPureFunctions` and `functionLocals` are false (section 14). `backend_info` also reports `engineVersion` and `createKinds`.
- The memory-swap approach discovers offsets per build and refuses rather than guess. abfc shows that refusal as `ABFC4100: the bp_apply backend refused (<reason>) — this editor build may need a backend update.` It never retries with other settings.

### 7.4 Adapter (b): `import_nodes` (future)

Only relevant if Deep Field exposes `FEdGraphUtilities::ImportNodesFromText(graph, text)` to Python in the mod kit. The server then gains a writer option (`bp_apply` with `writer: "import_nodes"`, or an equivalent tool), and nodes are imported from `renderT3D(node)` text, so the engine allocates pins as on a paste. Wires are applied after the import by pin name. Stage, compile, test, audit and publish are unchanged. The compiler does not change: the user sets `"backend": {"kind": "import_nodes"}`, or the adapter is picked automatically when `backend_info.writers` includes it. Capabilities are expected to match bp_apply, minus the offset fragility (`writers: ["import_nodes"]`).

### 7.5 Adapter (c): `paste_graph` (fallback)

It uses the open, visible editor: function and variable shells through editor Python (`BlueprintEditorLibrary`), and nodes as clipboard T3D through the existing `paste_graph` tool, one paste per pass (shells and custom events first, then bodies), with a fresh node-name prefix per paste. Capabilities: `headless: false`, `needsOpenEditor: true`, `transactional: false`, `nodeNameMap` only through a read-back. The CLI requires `--interactive-backend` and warns that it takes over the desktop clipboard and focus. It writes into the open mod, not into staging, so the CLI refuses it unless the user confirms that the mod is under version control or backed up. This is the last resort if bp_apply breaks after an editor update and no import_nodes exists yet.

## 8. Ownership, hash manifest and source map

### 8.1 What is owned

TypeScript wins. For a Blueprint class that is not hybrid, abfc owns the whole Blueprint: the units (custom events, overrides) and the variables (including temps) declared in TS, the comment boxes that tag them, and, on every build, everything else that the asset holds and TS has no form for in the graphs it manages. An edit made in the Mod Editor to what TS describes is replaced by the next build, and what the editor added in those places is removed.

Hybrid classes. A class is hybrid when its symbol also has an `interface X extends X_Manual` declaration merge (the TS code explicitly includes the hand-made members: designer widgets, `_Manual` events it calls). Hybrid classes are the opt-out: abfc owns only the units and variables declared in TS and leaves the hand-made graphs, nodes and variables alone, because removing them would break the documented widget workflow. A TS field removed from the class is still removed from the asset (it was TS-owned).

Sweep scope. For a non-hybrid class the build removes, in the same bp_apply spec that applies the units:

- every node in the event-graph pages that does not belong to a staying unit or its tag, including hand-made comment boxes, except the disabled engine default event nodes (`K2Node_Event` with `EnabledState=Disabled`);
- every function graph that is not a TS unit (`remove_functions`; only K2 `EdGraph` content, see below); the function graphs of TS functions (undecorated methods) are owned and are never swept as hand-made;
- every member variable that TS does not declare, that is not an abfc temp of a staying unit and not an event dispatcher (`remove_variables`).

Kept always, because TS has no form for them: components, the widget tree and designer widgets, timelines, macros, event dispatchers, the graphs of implemented interfaces (their existence stays; hand-made nodes in them are swept), intermediate stub graphs of the engine, and class defaults abfc does not set. Only K2 `EdGraph` content is swept; nothing is removed from components, the widget tree, timelines, macros, dispatchers or interface graphs beyond the nodes of their event-graph pages.

One warning ABFC5014 per touched asset lists what was replaced or removed (unit ids with the node counts, hand-made event names, node count and the first five names per graph, function names, variable names). `abfc status` previews the same situations as warnings with the old codes ABFC5001 to ABFC5004 and ABFC4020. A build never stops for an editor edit.

Mod changed outside abfc. When the real mod changed since the last stage sync (the user saved in the Mod Editor: a conflict, a stage file that was never touched but whose real file was saved or deleted (`stale`), or a missing stage), the build makes the stage again from the mod on its own (warning ABFC4017 naming the files; the stage only holds abfc-generated work that the same build regenerates from TS), prunes the manifests to what the stage holds, and applies. Assets whose files the editor saved (`changedInMod`) re-apply their class defaults, class-manager row and tag, because the saved CDO may differ; assets the editor did not save keep their published defaults (`classDefaultsPublished`) and are not applied or republished again. After an explicit `--resync` or a re-sync that lists no file, every owned asset's defaults are applied again.

### 8.2 Tags inside the asset

Each owned unit gets one `EdGraphNode_Comment` around its region: `abfc:owned unit=event:UpdateTarget src=src/PotInfoRelay.ts ir=<sha8> — generated by abfc, edit the .ts file`. The tag is visible to anyone who opens the graph, survives in the asset, and lets `abfc status` rebuild ownership if the manifest is lost (it then asks the user to confirm). Comment nodes do not affect compile or audit (comment boxes in a published mod passed the audit).

### 8.3 Manifest (`.abfc/manifest/<asset>.json`, committed)

```json
{ "asset": "/ExampleMod/PotInfo/BP_PotInfoRelay", "compiler": "0.1.0", "profile": "ue5.4.4-1050002",
  "units": [{ "id": "event:UpdateTarget", "graph": "EventGraph", "irHash": "sha256:...", "assetHash": "sha256:...",
              "nodes": ["K2Node_CustomEvent_12", "K2Node_CallFunction_77", "..."], "tag": "EdGraphNode_Comment_31" }],
  "variables": [{ "name": "abfc_UpdateTarget_t0", "type": "name", "hash": "sha256:..." }] }
```

`nodes` (and the keys of `nodeHashes`, the ends in `links`) are snapshot keys: a node of the EventGraph by its name, a node of any other graph (a function graph) as `<graph>/<name>`, because Unreal names nodes uniquely only inside a graph (a function's nodes reuse names like `K2Node_CallFunction_9001`). `nodeIds`, `tag` and the source map keep the real node names.

`retiredUnpublished?: string[]` (optional) lists unit ids that a build removed from the stage but that are not published yet. `abfc publish` includes such assets in its asset list even though they hold no units. After a successful publish the field is cleared; a manifest left with no units, no variables and no `classDefaultsHash` is then deleted together with its source map and its unit-cache entry (`no longer owned by abfc`).

Further optional manifest fields (all absent in manifests written by older versions):

- `variables[].default`: the literal default text of an own field with an initializer (`Speed: float = 2.5`); the `hash` formula is unchanged, so builds without defaults do not churn.
- `source`: `{ file, class, derived }` (section 18.2).
- `created`: abfc created the asset (its plan had `create`). Only such assets are deleted when the class leaves TS; for any other asset (hand-made or taken over) the units and variables are removed, the emptied asset stays and the build warns ABFC5017.
- `parent` and `parentFamily` (`actor`, `component`, `widget`, `object`): the `extends` the asset was last built with. A different parent in the same family is a reparent, another family a recreate (section 8.6).
- `renamedFrom`: the path the asset was renamed from on the stage; the next publish deletes the old files and clears it. `publishAlso`: other packages that a rename fixup saved (referencers) and the next publish copies.
- `deleted: true`: tombstone of a class that left TS and whose asset abfc deleted from the stage; the next publish deletes its files, then the manifest goes. Tombstones and `renamedFrom` survive a re-sync, and a build after a re-sync repeats the rename or delete when it finds the old asset on the stage again.
- `retiredRows`: class-manager row assets abfc deleted from the stage because the class's `@director` row changed or went away; the next publish deletes their files.
- `directorRow`, `classDefaultsHash`, `classDefaultsStageSyncedAt`: the class-manager row abfc wrote and the state of the last class-defaults pass. `classDefaultsPublished: true`: those defaults reached the mod through a publish (while the stage still held the sync they were applied to), so a later re-sync copies them back and the pass does not run again; it is cleared whenever a defaults pass applies new ones, and for assets the editor saved.
- `structFieldsHash`: the fields a mod-defined struct was created with. `structRetired: true`: the struct's TypeScript is gone and ABFC5018 was reported once; cleared when the struct is declared again.

`assetHash` is computed from the read-back of the unit: the nodes' class and member references, pin defaults, links between owned nodes, links from owned to foreign nodes (by foreign node name and pin), sorted. Positions, GUIDs and comment sizes are excluded, so moving nodes is not an edit.

Drift check (every build, before apply): `read()` each asset with owned units, recompute `assetHash`, and compare.
- Equal: the unit is safe to replace.
- Different: The unit is replaced (TypeScript wins): the build prints the warning ABFC5014 naming what was replaced ("BP_PotInfoRelay: event UpdateTarget was edited in the editor, 3 nodes changed"); a change you want to keep goes into src/PotInfoRelay.ts first. `abfc status` previews it as ABFC5001.
- An owned node is missing: the unit is applied again (TypeScript wins); `abfc status` shows it as the warning `ABFC5002`.
- A plain build reads only the assets it has something to plan for; an editor edit of an up-to-date asset shows up in `abfc status` and in `abfc build --drift`, and is replaced by the next build that changes that class.
- A foreign node links into an owned unit (for example a hand-made call to `UpdateTarget`): allowed, and recorded so the link is restored after replacement. The call references the event by name, so recreating it keeps the link valid.
- A removed or renamed owned event that a node staying on the stage still calls (a unit the build does not re-plan, or a hand-made node): `ABFC5009: X is no longer declared in TypeScript, but <node> in graph <graph> (unit <id>) still calls it.` It is refused before the apply, because Unreal's compile would refuse the graph without naming a TS line. Redeclaring X as another unit of the same name is not reported. This is only the backstop; the frontend reports the call itself (next bullet).
- Ownership also hides stubs: every frontend run removes from the `<Asset>_Manual` interfaces the `@bpHandMade` members whose `event:`/`function:` unit (or variable) is in the asset's manifest. The manifests are read on each load, with no backend call and no stub regeneration. Once abfc owns `event:X`, the only way to call X from TS is the method the class declares, so a call to a dropped or renamed event is a TypeScript error (`ABFC2000`, TS2339 or TS2551) at the call line, even when the stub files were generated before the adoption. A unit the build removes is recorded in `.abfc/stubs/<profile>/retired.json` and stays hidden the same way, until `abfc generate` rewrites that folder from the stage (which deletes the file).

### 8.4 Adoption and hand-made members

- Deprecated (warning ABFC5015): under TypeScript wins a build replaces a hand-made unit of the same name by itself, so adoption is no longer needed. The command still works. `abfc adopt <asset> <unit>` takes over an existing hand-made unit once. It computes the nodes reachable only from that unit's entry (exec plus the pure nodes feeding them), refuses (ABFC5005) if any of them is shared with another unit, if another entry's event parameter pin or a hand-made node outside every owned or adopted unit is linked to them (a node that takes this event as its delegate would silently lose that link when the build replaces the event; a delegate between two owned or adopted units is recorded as a cross link instead), shows the list, and on confirmation removes them in the same transaction that adds the compiled unit. The real mod keeps its pre-adoption state until publish, and bp_publish backs it up. This is how the Phase 1 slice replaces `UpdateTarget`.
- Hand-made members that TS code uses (`OwnerPC`, `HideAll`, `Infos`) come from the generated `<Asset>_Manual` interface through declaration merging, so they are type-checked and never duplicated by hand.

### 8.5 Source map (`.abfc/sourcemap/<asset>.json`)

`irNodeId -> Span` from lowering, and `realNodeName -> irNodeId` from `ApplyReport.nodeNames`. Mapping:
- A compile error with a node reference (needs backend capability `compileErrorNodeRefs`) maps to the exact TS span. The Phase 1 assumption that the compile log carries `:EventGraph.K2Node_X_N` was wrong (the log ends in `from Source: <asset path>`); the backend takes the node from the `ErrorMsg=` the compiler stores on the node in the T3D export of the compiled asset and matches message text to node (the T3D text is escaped, so it is unescaped first). Verified live in Phase 2 (`ABFC6001` at the compared expression).
- Without a node reference, it maps to the unit's span, with the message prefixed `(node not identified)`.
- A runtime error in a test (`Accessed None ... Node: <title> Graph: <graph> Function: <fn>`) maps to the unit, and to the node when the title is unique in the unit (unverified log format: Phase 0 captured no sample, because the harness logged no "Accessed None" line even for the original graph's null `OwnerPC` path).

Printed as `src/PotInfoRelay.ts:14:5: error ABFC6001: [Unreal] <message>`.

### 8.6 Asset operations: rename, move, reparent, recreate, delete

With backend 2.6.0 (capability `assetOps`: `rename`, `delete`, `reparent`, `recreate`) the build changes assets that already exist. The operations are done by the separate backend tool `bp_asset_ops` on the stage; `bp_apply` still refuses rename and delete. Nothing reaches the mod before `abfc publish`, which backs up every file it replaces or deletes. No flag is needed.

- Rename or move (a class file moved, or the class renamed, or both): a class (derived or explicit `path:`) whose path has no manifest and for which exactly one orphan manifest matches is renamed from that manifest's asset. Matching: same class name, or same file, or (third tier) within one folder and one parent exactly one declaration without an earlier asset and exactly one earlier asset that abfc created with a recorded parent (a class and its file renamed together). The tier-3 guess names its reason in the `renamed A -> B (reason)` build line and in the ABFC5012 warning. Several candidates, another folder or parent, or a hand-made or unknown-parent manifest: no guess (ABFC5012 as error with the keep-path quick fix, or delete plus create). The rename is Unreal's own: referencers are fixed up, the redirector is deleted, dirty referencers are saved. The new manifest records `renamedFrom` and `publishAlso`, the source maps follow the new file, and variables whose type is the renamed class are not treated as retyped. The nodes that the rename fixup edits are replaced without the ABFC5014 editor-edit warning (the edit was abfc's own) and are read in the same build, so no drift is left behind.
- Reparent (`extends` changed): same family: `reparent`, then every unit is planned again. Another family (Actor, ActorComponent, UserWidget, other UObject): `recreate`, which deletes the asset's files from the stage only; the asset is then planned as missing and created again (referencers keep their path references). A recreated asset keeps `renamedFrom` and `publishAlso` of the manifest it replaces. Without `assetOps` a parent change is error ABFC2048 and renames stay ABFC5012.
- Delete: a Blueprint asset whose class left TS is deleted only when its manifest has `created: true` (together with its `directorRow`); other assets keep the emptied shell (ABFC5017). Structs are never deleted (Blueprints and saved games use them): the build warns once (ABFC5018, `structRetired`) and leaves them. A changed `@director` row deletes the old row asset when abfc wrote it, else ABFC5013.
- Deferred deletes: the delete phase runs after the apply, the Unreal compile and the manifest writes, so a class and the last TS use of it can be deleted in one build (the delete is refused while an asset outside the delete set still references it, ABFC5016). A rolled-back delete leaves what the build applied on the stage.
- Chunking: operations are sent in calls of at most 20 (`ASSET_OPS_PER_CALL`, the backend's limit; mass deletes crash the editor). A call is all-or-nothing, the build is not: after a failed chunk the manifests and source maps of the operations of the succeeded chunks are kept (they are on the stage) and the failed chunk is ABFC5016 ("the N operations before it were done and are kept"). The next build does the rest.
- Retired rows: rows listed in `retiredRows` are deleted in the delete phase too.
- Publish: the removed files of tombstones, `renamedFrom` paths and `retiredRows` are passed to `bp_publish` with `delete_removed` (capability `publishDeletes`), together with the `publishAlso` packages. A deletion-only publish is a success. Without the capability the deletions are listed as warning ABFC7014 for the user to delete by hand. With the Mod Editor open, a published deletion can leave the asset in the editor's registry until it is restarted; the files are already gone ([known-issues.md](known-issues.md)).
- Superseded structs: a struct renamed to a new name leaves the old struct asset in the mod (a struct has no rename that is safe for saved data, and the new name is a new asset). abfc warns once (ABFC5018) and the old struct is deleted by the user in the Mod Editor when nothing uses it.

### 8.7 One run at a time

`build`, `test`, `publish`, `status`, `generate` and `adopt` take a project lock, `.abfc/lock.json` (`{ pid, command, startedAt }`, created with an exclusive open, listed in the `.gitignore` that `abfc init` writes). A second run in the same project stops with ABFC4019 before it starts the backend; two runs at once wrote the same staged copy and manifests and one of them failed with a file-in-use error. A lock whose process is gone, one older than 12 hours (a reused pid), and an unreadable one older than 30 seconds are replaced (claimed by rename, so two runs cannot both replace it); a lock that cannot be written never blocks a run. `check`, `doctor`, `init` and `lsp` take no lock.

### 8.8 Field defaults

An own field may carry a literal initializer (`Speed: float = 2.5`); it becomes the variable's `default` in the manifest and in the bp_apply spec. Forms: number (`int` range checked, `byte` 0 to 255), `true`/`false`, string or name literal, enum value; anything else, an out-of-range number or a `text` default is ABFC2047. Changing or removing the initializer of a field already in the manifest updates the default in place (bp_apply feature `variable_defaults`, guid kept); without the feature the default stays and ABFC2084 repeats until the backend is updated. A Mod Editor edit of a default is not detected. Changing the type of a field recreates the variable (remove and add in one spec) and applies every unit of the class again; ABFC2047 is a warning in that case. The same recreate happens when the editor retyped the variable on the stage (the stage type differs from the TS type): warning ABFC5014 "TypeScript wins".

## 9. Environment discovery and config

### 9.1 Precedence

For every setting: **CLI flag > environment variable > project `abf.config.json` > user `%APPDATA%\abfc\config.json` > auto-discovery.** `abfc doctor` prints the winner and its source for each one. `ABFC_USER_CONFIG` (1.0) names a different user-config file (tests, portable setups). The user config is written by `abfc init` (section 18.4); a mod's folder is always `<mods folder>\<mod.name>` unless `--mod-dir`/`ABFC_MOD_DIR` says otherwise (the user config no longer gets `mod.dir`, because one machine can hold projects for several mods).

| Setting | Flag | Env | Auto-discovery |
| --- | --- | --- | --- |
| Editor root | `--editor-root` | `ABFC_EDITOR_ROOT`, then `ABF_EDITOR_ROOT` | Epic manifests `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` with `DisplayName` "Abiotic Factor Mod Editor" (the install folder has a random suffix), validated by the exe path from the profile. Then `Program Files\Epic Games\AbioticFactorModEdit*`. The same order as the backend's `paths.py`. |
| Documents | — | — | Known Folder `FOLDERID_Documents`. Node has no Win32 FFI without native addons, so (1) `backend_info` reports the server's `documents_dir()` (`SHGetFolderPathW`, follows redirection), and (2) without a backend, `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" /v Personal`, with `%VAR%` expanded. Never `%USERPROFILE%\Documents`. |
| Mods folder | `--mods-dir` | `ABFC_MODS_DIR` | `<Documents>\Abiotic Factor Mods` (folder name from the profile) |
| Mod dir | `--mod-dir` | `ABFC_MOD_DIR` | `<mods folder>\<mod.name>`, which must hold `<mod.name>.uplugin` |
| Backend dir | `--backend-dir` | `ABFC_BACKEND_DIR` | `abfc.exe` (1.0): the pinned backend extracted from the executable, i.e. the runtime folder `<runtime root>\<abfc version>-<sha8>\backend`, where the runtime root is `ABFC_RUNTIME_DIR` or `%LOCALAPPDATA%\abfc\runtime` (section 18.8). Source install: none (explicit is required; `abfc init --backend-dir` writes it to the user config). There is no `abfc backend install` command. In the exe an older source-install setting (a flag, `ABFC_BACKEND_DIR`/`ABFC_PYTHON`, or `backendDir`/`python` in a config) still wins by the precedence above; `abfc doctor` then warns `ABFC1053` (the exe uses a backend or Python outside its own runtime folder). |
| Python | `--python` | `ABFC_PYTHON` | `abfc.exe` (1.0): the bundled embeddable Python in the runtime folder (`python\python.exe`); in the exe it is the only auto-discovered Python. Source install: `py -3` launcher, then `python` on PATH. Requires 3.9+. Rejects the Microsoft Store alias stub (`...\WindowsApps\python.exe`). |
| Headless dir | `--headless-dir` | `ABF_HEADLESS_DIR` (passed through to the server) | the server's default `%LOCALAPPDATA%\abf-mod-editor-mcp\headless` |

### 9.2 Robustness rules

- Paths are handled as strings and passed in argv arrays. No shell is used, so spaces are fine.
- The headless dir must have no spaces (the backend refuses one). A Windows user name with a space puts a space in `%LOCALAPPDATA%`. `abfc doctor` and `build` detect this before launching and print `ABFC1012: the headless folder "C:\Users\Jane Doe\AppData\Local\abf-mod-editor-mcp\headless" contains a space, which the Mod Editor launch cannot handle. Set ABF_HEADLESS_DIR (or "headlessDir" in %APPDATA%\abfc\config.json) to a folder without spaces, e.g. C:\abfc-headless.` Non-ASCII user names get the same advice as a warning (unverified whether UE launch args handle them).
- All files are read and written as UTF-8 (JSON with BOM tolerated on read). Log files from the editor may be UTF-16 (the server already handles this).
- Mods on another drive, OneDrive-redirected Documents, and localized Windows are covered by the Known Folder lookup and by the explicit override.
- Discovery results are cached in `.abfc/cache/env.json`, keyed by the editor fingerprint, and re-validated (file existence) on every run.

### 9.3 Error shape

Every environment error has a code, what was tried in order, and one concrete fix:

```
abfc: error ABFC1001: Abiotic Factor Mod Editor not found.
  tried:
    --editor-root           not given
    ABFC_EDITOR_ROOT        not set
    ABF_EDITOR_ROOT         not set
    abf.config.json         editor.root not set
    %APPDATA%\abfc\config.json  editor.root not set
    Epic manifests          no "Abiotic Factor Mod Editor" in C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests
    Program Files wildcard  nothing matches C:\Program Files\Epic Games\AbioticFactorModEdit*
  fix: install the Mod Editor from the Epic Games Launcher, or set "editor": {"root": "<folder>"} in %APPDATA%\abfc\config.json.
```

On a terminal the severity word and code are colored and the `tried`/`fix` lines are dimmed; the text is otherwise identical.

Code ranges: 1xxx environment, 2xxx TS subset and lowering, 3xxx stubs and profiles, 4xxx backend, 5xxx ownership and drift, 6xxx Unreal compile and tests, 7xxx release gate.

## 10. Incremental build and warm editor

- Unit-level incrementality: `cache/units.json` (`{asset: {unit id: {irHash, stubLockHash, compilerVersion}}}`) holds `irHash + stubLockHash + compilerVersion` per unit. `stubLockHash` identifies the editor and the generator only: generator version, profile, engine version, Mod Editor version, editor fingerprint and filter content version. It does not cover the class lists, so adding a class to `stubs.classes` does not re-plan every unit. A unit whose stubLockHash or compilerVersion differs, or whose cached irHash differs from the current IR hash (an earlier build did not finish), is re-planned even when the manifest's irHash is equal. Only changed units, plus the shells of new units and the owners of delegate wires to a planned unit, go into the ApplyPlan. An asset with no planned unit and no class-defaults change is not read at all (no drift check there; `abfc status` still reads every asset), so a stage edit of an owned node in an untouched asset is found by `abfc status`, by `abfc publish --full` (which reads every owned asset) or when that unit is next re-planned. A change to a signature also re-plans that unit's callers in owned code (hand-made callers are recompiled by the engine).
- `abfc check` never launches the editor. In watch mode it reruns the frontend and lowering on change (target under 1 s for a small mod (a few Blueprint assets)).
- Staging: abfc runs `staging_sync` when `staging_status` shows conflicts or a real-mod change, and otherwise reuses the stage, so successive builds stack on it. A failure inside `bp_apply` rolls back that call on the backend (verified live in Phase 2: stage bytes identical after a failed apply). Open gap: the passes are not one transaction. When the post-apply `bp_compile_report` finds errors, the build fails but the applied passes stay on the stage (the manifests are written with what is on the stage, but without the IR hash of the applied units and without the new class defaults hash, and the unit cache is not written, so the next build re-applies those units, reports the error again and a publish gate 3 on it fails; the hashes are recorded only after the compile passed); the stage is only discarded by `abfc build --resync`, by the automatic re-sync after a failed Unreal compile (unless `--keep-failed-stage`) or by `staging_sync` with `discard_changes`. A backend restore tool for this case is a follow-up.
- Cold cost today: each bp_apply, compile report or reflect call launches its own commandlet (about 10 s of launch overhead per the server's notes, plus the work). `bp_game_test` launches a `-game` process, and `mod_audit` a hidden editor. Measured in Phase 0 (P8): one asset cold apply + compile report + game test took 58.6 s as built today (20.5 failed first apply + 11.9 + 11.6 + 14.6; 38.1 s once pin types are resolved up front), a full multi-step game test of the real mod 38.8 s, and `mod_audit` 44.5 s. A cold reflect of the relay's classes took about 60 to 70 s (estimate) and happens once per game version. A failed first apply (wildcard pins) adds 10 to 20 s, so the adapter resolves pin types before the first apply. The warm editor (below) is the Phase 2 answer.
- Warm editor (Phase 2, backend extension `warmSession`, implemented): the server (opt-in with `ABF_WARM_SESSION=1`, tool `warm_session {action: start|stop|status}`) keeps one hidden `-run=pythonscript` commandlet alive. Its loop script polls `<root>/warm/<session>/queue/*.json`, reloads the staged mod's packages (`EditorLoadingAndSavingUtils.reload_packages`) before each job, runs the job through the same dispatcher as cold jobs, writes `result.json` into the job's run folder and deletes the queue file. It exits on `stop.json` or after an idle timeout (`ABF_WARM_IDLE_SECONDS`, default 600). Same `-userdir`, one lock, so all operations are serialized. On any warm failure (dead process, timeout) the server kills the process tree (Job Object) and reruns the job cold; results carry `warm: bool` and `seconds`. The reload phase logs stale-class compile errors for cross-asset references; the server cuts the job log at the reload marker (reload-phase lines go to `reload.log`), so they do not count as compile errors of the job. `staging_sync`, `bp_game_test` and `mod_audit` stop or bypass the session. The warm editor lives only as long as the server process, so every abfc command that touches the editor pays one editor start (about 10 s); `abfc test` gets no warm benefit (each test is its own `-game` process). `--cold` clears an inherited `ABF_WARM_SESSION`. abfc starts the server with the opt-in unless `--cold`, calls `warm_session start` lazily before the first commandlet operation (a failed start means cold for the rest of the run), restarts after a stage sync and stops it on close.
- Every step's duration goes to `.abfc/runs.jsonl` (`{step, seconds, units, mode: "cold"|"warm"}`), and `abfc build --timings` prints them.

## 11. Testing: `*.test.ts` -> bp_game_test

Test files run in Node, not in the game. `@abfc/testkit` records a step list: handles are opaque `$names`, so test code cannot branch on game values, and every `expect` becomes an `assert` step.

```ts
import { test } from "@abfc/testkit";
import { BP_PotInfoRelay } from "./PotInfoRelay";

test("unowned relay stops ticking and never builds UI", async (t) => {
  const relay = t.spawn(BP_PotInfoRelay);
  t.expect(relay.call("GetActorTickInterval")).approx(0.1, 0.001);
  t.wait(1);
  t.expect(relay.call("IsActorTickEnabled")).equals(true);
  relay.call("UpdateTarget");                        // OwnerPC is None: must take the hide path
  t.expect(relay.get("LastTarget")).equals(null);
  t.expect(relay.get("bLastVisible")).equals(false);
  t.wait(17);
  t.expect(relay.call("IsActorTickEnabled")).equals(false);
});
```

- Steps map 1:1 to bp_game_test ops (`new`, `spawn`, `widget`, `call`, `get`, `set`, `find`, `wait`, `assert`, `python`, and `until` with the backend extension `game_test_until`). `h.moveTo`, `h.aim` and `t.distance` compile to `python` steps. Without `game_test_until`, testkit's `planGameTest` turns an `until` into wait + read + assert and a `below`/`above` assert into a `python` step, and `foldReport` maps the backend's step results back to the test's steps. Member names are checked against the stubs, so a typo is a TS error. `call` uses the Python-side name (`get_actor_tick_interval`), which testkit derives from the stub's real name using the profile's naming rule (unverified for every case; `t.raw.call("snake_name")` is the escape hatch).
- Each step keeps the `Span` of its `t.*` call, so a failed assert prints `src/PotInfoRelay.test.ts:9:3: error ABFC6101: expected false, got true (step 7)`.
- `test.liveHud(name, checklist, body)` marks tests that need `W_PlayerHUD_Main`; `checklist` is an array literal of string literals (otherwise `ABFC2101`) and `body` is type-checked and compiled like any test body. The hidden game has no live HUD, so these tests are never sent to `bp_game_test`: each is skipped with warning `ABFC6105` and listed in the "manual checks" report `.abfc/reports/manual-checks.md` (test name, `file:line`, numbered checklist) and as `manualChecks` in the `--json` result. A run with only `liveHud` tests does not start the backend. Widget injection into `W_PlayerHUD_InteractionPrompt_C` cannot be tested hidden. A PIE-based runner through the open editor is a later optional extra.
- `PrintString` is not logged in this build, so tests read state back with `get`, never from logs.
- The public repo's own tests use synthetic fixtures (made-up classes and reflection JSON) and no Deep Field content. The end-to-end test against a real mod runs only on a machine that has that mod, and lives in that mod's TS project.

## 12. Publish (`abfc publish`)

**Default (fast, the edit loop):** the incremental build (lock check, frontend, drift check of the assets it re-plans, apply, compile report), the would-publish list (item 7 below), then `bp_publish` for those assets (item 8). The backend refuses on compile errors (its own compile check), on real-mod files changed since the sync, on locked files, and, with the mod open in the editor, on Play In Editor, unsaved assets or an unreachable editor. It backs up the replaced files outside the mod and copies Content only, or reloads them in the open editor (live-reload). About 30 s with a warm build. There are no tests, no audit, no upload file check and no full drift read; the full read is skipped because the stage is written only by tools, edits in the Mod Editor go to the real mod where the backend's conflict check and abfc's re-sync catch them, and assets that get re-planned are still read and drift-checked.

**`--full` (before an upload):** items 1 to 8 in order, stopping at the first failure, and failing closed:
1. Stubs and profile match the installed editor (no ABFC3001 or 3002).
2. `abfc check` is clean (warnings allowed, except `@deprecated` Blueprint filter hits outside `filterOverrides`, which are errors ABFC7011 with their span).
3. `abfc build` is clean: no compile errors in any changed asset, and drift is clean. The gate's build reads every owned asset (a plain `abfc build` skips assets with nothing to plan), so an editor edit of an owned unit fails it with ABFC5001 even when the TypeScript is unchanged.
4. `abfc test` passes (all tests; `knownIssue` rules as in section 11; `test.liveHud` tests are skipped with `ABFC6105` and do not fail the gate; they are listed in `.abfc/reports/manual-checks.md`).
5. `mod_audit` with `stage: true` passes (capability `stageAudit`): the hidden editor is launched with an empty mods folder (redirected `USERPROFILE`, with junctions for `AppData\Local` and `AppData\Roaming` back to the real ones, because the editor hangs during startup without them) and only the staged copy as the recent entry (the tile is then the only one, at a fixed window coordinate tried first), and the backend checks the editor log that it mounted the requested mod (`picker mounted <other>` fails, one retry). Without `stageAudit` the gate prints warning ABFC7003 and audits the real mod folder. A result that is not `ok`, or an audited copy other than the stage under `stageAudit`, fails with ABFC7002 and the backend's reason. There is no bypass flag in phase 1 (open question 2).
6. abfc's own upload file check, read-only, on the real mod folder and the stage folder (rules copied from the backend's `check_upload`: shippable file types, no `Saved`/`Intermediate`/`Binaries`/`DerivedDataCache`, no `.md` files). ABFC7010 per offending file (error), ABFC7012 for working folders and unknown types (warning). The `/Game` reference check of `check_upload` needs the retail asset list and is not repeated here.
7. The would-publish list: `staging_status` changed and added files under `Content/` (no `_McpTest`/`_McpTmp`), restricted to assets that hold owned units, class defaults, a class manager row (since 1.0 also the row asset itself when abfc wrote it, section 18.3), an adoption, or units retired but not yet published (`retiredUnpublished`). `--dry-run` prints it and exits 0 in both modes; `bp_publish` is never sent with `--dry-run`.
8. `bp_publish` for exactly the assets of the would-publish list, so staged edits that abfc does not own are never published. The backend copies Content only and backs the old files up outside the mod. When the list is empty abfc prints "nothing to publish." and calls nothing. Refusals: ABFC7004 compile errors (exit 1), ABFC7005 conflicts, Play In Editor, unsaved or locked assets (exit 3), ABFC7006 editor unreachable or a backup, copy or reload failure (exit 2), each with the backend's message and a fix. On the live-reload route abfc lists the referencers the editor reloaded and the assets left with unsaved changes after the reload, and prints warning ABFC7013 (exit 0) when the open editor logs Blueprint compile errors during the reload (the published files on disk are fine). Timed as `gate.8` (`--full`) or `publish.copy`; `publish.total` covers the whole command.

abfc never uploads to mod.io and never offers to.

## 13. Widgets (hybrid mode, Phase 3)

A `@blueprint({ path, kind: "widget" })` class extending a `UserWidget` stub owns only the graphs it generates. The widget tree and layout stay in the designer. The stub `<Asset>_Manual` exposes designer widgets marked `IsVariable` as typed fields. Compiler-made `create_widget` and `AddChild` calls work as in the relay. The `widget_tree` and `animations` features of bp_apply are not used in phase 1.

Designer widgets appear in the stubs as `readonly` fields tagged `@bpWidget` (assigning one is a plain TypeScript readonly error; declaring a class property that shadows a designer widget is `ABFC2066`; `kind: "widget"` misuse is `ABFC2064`/`ABFC2065`). Reflection finds them itself, as it does the SCS components of game Blueprints (`readonly`, `@bpComponent`) and plain variables of widget or component type (a HUD reference; writable, no tag). `K2Node_GetClassDefaults` cannot list these: widgets and actor components are `DefaultToInstanced`, so single object properties of those types carry the instanced-reference flag the node excludes (arrays are listed). The backend's member pass therefore collects candidate names from the widget tree, the SCS templates and the class package's cooked name map (for native `/Script` classes from the property list of the class default object's Python documentation, the source `pythonDoc`), keeps the names that exist on the class default object and not on its parent's (so a member is listed only on the declaring class), and types the object-typed survivors with a VariableGet node. Each such member carries `kind` `widget`, `component` or `member` in `reflect.json`, and `memberSources` names the sources that ran; without `cookedClass` in it `abfc generate` warns `ABFC3014`. Discovery has deliberate limits (docs/known-issues.md, Stubs): only widget, component and timeline-typed members are kept, numbered names are probed up to `_9`, and some cooked containers are skipped. The stubs repeat nothing: a discovered member is skipped when a class further up the chain already lists the name. `_index.json` lists them under `discovered` (`<class>:<member> (<kind>)`). Generator 0.7.0 (run `abfc generate` once). The setting `stubs.widgetMembers` (`{ "<class path>": { "<member>": "<widget class path>" } }`) is deprecated: entries that reflection finds warn `ABFC3015` (remove them); other entries are still emitted. A `widgetMembers` entry whose widget class is not in the stubs is typed `UObject` and `abfc generate` warns with `ABFC3011` (widget classes are generated automatically; check the path or retry it with `abfc generate --add <path>`). A template literal where a `text` is expected lowers to Format Text (arguments named after the substituted identifiers, braces escaped; where a `string` is expected, followed by Conv_TextToString), an object literal where a stub struct is expected to Make Struct; other uses are `ABFC2099`. A widget class written in TypeScript can be passed to `createWidget` and its `@event`s called from other TS classes. Layout evidence for a published widget: `scripts/layout-diff.mjs` compares exports of the widget before and after (normalized: the same multiset of byte-identical sibling blocks) and with `--strict` (raw order).

## 14. Backend work required (in EmekC/abf-mod-editor-mcp)

All items land in `EmekC/abf-mod-editor-mcp`. Each item is small and gated by a capability, and abfc works without the optional ones:
1. `backend_info` tool (required, protocol 1): done (2.4.0). Versions (`serverVersion`, `engineVersion`), paths (`documents_dir`, headless dir, editor root), capabilities.
2. `reflect` op for stubs (required for `abfc generate`): done (2.4.0). Opt-in with `ABF_ABFC_TOOLS=1`; function metadata is read after the template runs and can be skipped (`meta: false` or `ABF_REFLECT_META=0`).
3. Compile messages keep the `from Source:` node path (`compileErrorNodeRefs`): done (2.4.0).
4. Required for Phase 1 (from Phase 0 probes P5, P3, P6): native node kinds `array_call`, `break_struct`, `make_struct`, with pin-type resolution for every wildcard-capable node (array functions, `GetArrayItem`, `cast`, `Map_*`, and untested `Select`, `MakeArray`, macros). Gated by a capability: done (2.4.0, `pinTypes`).
5. Map and set types in the type grammar (`map:<K>:<V>`, `set:<T>`), UserDefinedStruct creation and field authoring (`struct_fields`), the audit login fail-fast and `warmSession`: done except changing the fields of an existing struct and function local variables (deferred, Phase 7).
6. `mod_audit` must audit the staged copy (in Phase 0 it mounted the real mod folder, so the P3, P6 and P7 audit results are not verified), and `bp_read` and reflect runs should return `seconds`: done (2.4.0).
7. Single backend: the headless tools (bpkit, staging, headless runs) already live in `EmekC/abf-mod-editor-mcp`, which is the one supported backend. abfc checks `protocol` through `backend_info` and warns below the minimum server version (ABFC4014), and server version numbers are owned only by that repository. The backend has a CHANGELOG; the release is tagged `v2.4.0`.
8. Metadata: reflect reads `ToolTip` and `DisplayName` through `get_metadata_tag` (done); `bp_apply` writes event tooltip, category and keywords through `event_meta` (done, clamped to 2000 code points by abfc with ABFC2072); function-graph metadata is a documented fallback (the engine drops it on import and Python cannot read compiled metadata). The route through a spawned call node was not probed: its title and tooltip come from the same function metadata, so it would not add information.
9. Phase 7 (1.0): class-manager row writing in `bp_apply` (`class_manager_row` asset-spec key, capability `classManagerRows`, backend 2.5.0, section 18.3); the headless asset-move probe (section 18.2), which led to the separate `bp_asset_ops` tool of backend 2.6.0 (section 8.6); a release layout the abfc release build can vendor (section 18.8: stdlib only, runs from an embeddable Python, no game-derived data required at runtime).

## 15. Security and safety

- Never write `/Game`. The compiler rejects any `@blueprint` path not under `/<mod.name>/` (ABFC2001), and the backend refuses again.
- Nothing is written into mod folders except through `bp_publish` (Content only, backed up outside the mod, conflict- and lock-checked). The TS project, caches, manifests and logs live outside the mod. `abfc init` refuses inside a mod folder, and `check_upload` in the gate catches stray files.
- Nothing is published without a passing build and Unreal compile check; `--full` adds the tests, the stage audit and the upload file check. Nothing is ever uploaded.
- `bp_publish` is not on the tool allowlist (ABFC4090). The client sends it only with a `PublishGrant` that `grantPublish(mod.name)` minted (a private set, so a forged object is refused) and only for that grant's mod. Only `abfc publish` mints grants, so no other command can write a mod folder. The read-only `catalog` tool (the names of the game's classes, section 5) is on the allowlist; no other tool was added for auto stubs.
- Editor edits to what abfc owns are replaced by the TypeScript, never silently: every replacement or removal is named in one warning per asset (ABFC5014, section 8.1). This replaces the phase 1 rule "no silent overwrite of manual edits" (which stopped the build with ABFC5001). There are no force flags.
- Pass-5 class-default Python is generated from a fixed template with validated property names and values. User text never becomes Python code.
- Nothing derived from Deep Field content is committed or published: stubs, the filter list and reflection caches are per machine and gitignored, and the public repo uses synthetic fixtures only. Docs may name base-game classes and members (as in the example in 4.3).
- Run folders and logs can hold tokens (per the server README). abfc never copies them into the project, and prints paths, not contents.
- Hidden processes are owned by the server (Job Object). abfc closes the server's stdin on exit and kills its process tree on Ctrl+C.
- `abfc init` (1.0) writes only inside the target project folder and the one user-config file; it never writes into the mods folder or a mod folder, and it only links a mod that already exists. `abfc.exe` extracts its runtime only under `%LOCALAPPDATA%\abfc\runtime\`, verifies every extracted file against the sha256 list embedded at build time, and never downloads anything at run time (section 18.8).
- Release artifacts are built from allowlists and scanned after the build for mod names, user paths and game-derived files (section 18.10).

## 16. Risks and open technical questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| bp_apply's memory swap breaks after a Mod Editor update (offsets, array layouts) | Builds stop | The backend refuses rather than guesses. The per-build profile records a new build. The swappable backend, paste_graph as fallback, and a feature request to Deep Field to expose `ImportNodesFromText` to Python. |
| Reflection cannot list properties of `/Game` Blueprint classes with real names | Stubs incomplete | Resolved in Phase 0 (P1): `K2Node_GetClassDefaults` pins give real names, 1064 members and 15/15 reference pin lists matched. Fallbacks in 5.2 stay for a future build. A last resort is a hand-maintained override file per profile, kept outside the repo. |
| Cooked editor strips function metadata (confirmed for the Python routes tried in Phase 0, P1) | No tooltips, `WorldContext`, `DefaultToSelf` | Pin materialization gets the essentials from the nodes themselves. Metadata is best effort: reflect reads the metadata tags that survive (`get_metadata_tag`), and function-graph tooltips are not written (fallback; event tooltips are). |
| `k:"node"` raw nodes leave wildcard pins undetermined (CallArrayFunction, GetArrayItem; also native `cast` and `Map_*`). BreakStruct works (confirmed, Phase 0 P5, P3, P6) | Arrays, casts, maps fail to compile | Native kinds with explicit pin types in `EmekC/abf-mod-editor-mcp` (section 14). Interim: two-phase raw-graph apply (7.3). |
| Exec back-edges for loops rejected | Loops | Not a risk: accepted in function and event graphs (verified in Phase 0, P4). StandardMacros stays as a documented fallback. |
| UserDefinedStruct creation and field authoring (backend `struct_fields`, Phase 4) compile and pass game tests, but acceptance by the stage audit and cloud cook is pending | Mod-defined structs | If a later audit of the stage rejects the struct, only engine structs (already supported as `struct:<path>`) and ABFC2045. |
| Native Map/Set (backend `map:`/`set:` grammar, Phase 4) compile and pass game tests, but the stage audit is pending (Epic login in the hidden editor) | `Map`/`Set` | Re-run `abfc publish --full` when the audit can mount the mod. A failed audit: flip the capability policy to false and use parallel-array lowering. |
| User pure functions rejected by the engine | Getters | Impure functions or inlining (decided). |
| No live HUD in hidden runs | Widget injection untested | `liveHud` tests skipped with a manual checklist. Optional PIE runner later. |
| `mod_audit` depends on a fragile Mod Browser tile click | Gate cannot run | Fails closed with the reason. `ABF_PICKER_TILE` override documented. |
| Branch-only lowering makes graphs larger than hand-made ones | Readability, tiny perf cost | Layout regions, comment tags. Later the pure-operand optimization. |
| Temps as member variables in event graphs | Asset clutter | Owned, prefixed, transient. Later `K2Node_TemporaryVariable` (already used in hand-made mod graphs). |
| Same asset listed several times in one bp_apply batch (unverified) | Atomicity | One call per pass plus a resync on failure. |
| Replacing an owned function whose signature changed: hand-made callers may break between passes (unverified) | Callers lose links | Keep the graph and replace the body when the signature is unchanged. On a signature change, warn and re-check foreign callers after compile. |
| Backend extensions (section 14) are late | Optional features and stubs missing | They are all in `EmekC/abf-mod-editor-mcp`, under the same owner. abfc gates each one by capability and checks `protocol`. |

## 17. Open questions for the user

1. npm scope and package names. Resolved (2026-11-07): `@abfc/*` and the CLI name `abfc` are final; the extension id `abfc.abfc-vscode` and the installer AppId stay. The npm scope's availability is checked by the maintainer before the first publish.
2. Release gate when `mod_audit` cannot run (fragile Mod Browser tile): fail closed with no bypass (current design), or allow `--no-audit` with a loud warning, since the upload runs the real audit anyway? Phase 2 narrowed the cause (the picker could mount an arbitrary mod from the user's mods folder; the stage audit now isolates the mods folder and verifies the mounted mod), and the stage audit passed live at the end of Phase 2 (`mounted` equal to the requested mod). The remaining risk was the fixed tile coordinate; the question stays open for a decision on a bypass flag. Phase 7 (2026-11-08) found a different blocker: the audit's hidden editor stops at the Epic and mod.io login chooser because it has neither the launcher's login arguments nor a stored session (two live runs, 60 s and 240 s of grace), and the backend junctions the hidden editor's `AppData\Local` to its own headless `la` folder instead of the real Local folder, so a stored mod.io session cannot be seen. Recommended order for the decision: first the backend fix (junction only the mod.io and Epic session sub-folders of the real Local folder, then retry); if the audit still needs a login, answer with an opt-out flag or capability policy for gate 5 (fail closed stays the default, the flag prints a loud warning and tells the user to run the Asset Audit in the Mod Editor before an upload). Not decided; 1.0 does not need gate 5.
3. Manifest location: committed in the TS project (current design), so ownership travels with the source. Is the mod folder itself under version control anywhere, so the two can stay in step?
4. Backend versioning: resolved. The user decided to use `EmekC/abf-mod-editor-mcp` entirely, with nothing from the original maintainer and no dependency on other repositories. The `backend_info` protocol number is kept as a capability check, and version numbers are owned by that repo.

## 18. Public release 1.0 (Phase 7)

Decisions are in docs/roadmap.md (Phase 7, "Decisions (2026-11-07)"). This section is the specification. Sub-milestones: 7a project model, `@director`, `abfc init` (18.1 to 18.5); 7b `abfc lsp` and the VS Code extension (18.6, 18.7); 7c `abfc.exe`, the bundled backend and Python, the installer (18.8, 18.9); 7d release hygiene, npm, docs and carry-overs (18.10 to 18.12).

### 18.1 Derived asset paths

Every `@blueprint` and `@struct` class gets its asset path from where its file is, so TypeScript source never names the mod.

- Source root: `<project>\<sourceRoot>` (config `sourceRoot`, default `src`). Test files (`*.test.ts`) never define assets; their folder is free.
- Rule: `/<mod.name>/` + the folder of the file relative to the source root (segments joined with `/`, none for a file directly in the source root) + `/` + the class name. `src/Relays/MyCustomRelay.ts` with `class MyCustomRelay` gives `/<mod>/Relays/MyCustomRelay`; `src/MyRelay.ts` gives `/<mod>/MyRelay`. Two classes in one file each derive from their own name. The object path of a struct is `<path>.<ClassName>`, the generated class of a Blueprint `<path>.<ClassName>_C` (unchanged).
- `@blueprint()` and `@struct()` need no arguments. `@blueprint` without parentheses is a TypeScript error (the decorator is a factory).
- Allowed characters, per folder segment and class name: ASCII letters, digits and `_` (`^[A-Za-z0-9_]+$`), at most 64 characters, not a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9`, any case). The class name must not end in `_C`. The whole package path (`/<mod>/.../<Class>`) is at most 160 characters, so `<mods folder>\<mod>\Content\...\<Class>.uasset` and the staged copy stay under the Windows path limit in a normal install. A violation is error `ABFC2002` at the class name, naming the bad segment (`folder "My Relays" of src/My Relays/X.ts contains " " (Unreal allows only A-Z, a-z, 0-9 and _ in asset paths)`) with the fix "rename the folder or class, or give path:". This keeps out what Unreal refuses in long package names (space, `. , : ; ' " \ * ? < > | & ! ~ @ # $ % ^ ( ) [ ] { } = +`) and the dash and non-ASCII letters, which the backend's path checks also refuse.
- A class file outside the source root and without `path:` is error `ABFC2003` (`src`-relative folder unknown; move the file under `src/` or give `path:`).
- Two classes with the same asset path (compared case-insensitively, as Unreal and NTFS do) are error `ABFC2007` on the second one, naming the first one's file.
- Case: when a manifest exists whose asset equals the derived path case-insensitively, the manifest's spelling is used (a folder renamed only in case is not a move).
- Override `path:` (optional): relative to the mod (`path: "Relays/OldName"` gives `/<mod>/Relays/OldName`), or absolute under `/<mod.name>/` (all code before 1.0; anything else is `ABFC2001`, as before). Same character rules (`ABFC2002`). Uses: adopting a hand-made asset whose folder or name differs from the TS layout (hybrid mode, widgets), keeping an asset where it was after a move (18.2).
- Diagnostics on `path:` (warnings, each with a quick fix): `ABFC2006` the path equals the derived one (fix: remove `path:`, and `@blueprint({})` becomes `@blueprint()`); `ABFC2005` an absolute path that names the mod (fix: rewrite it relative to the mod). When both apply, only `ABFC2006` is reported.
- Widgets (`@blueprint({ kind: "widget" })`), hybrid classes (`interface X extends X_Manual`), `@struct` classes and the class-defaults options follow the same rule; nothing else about them changes.
- Imports of the mod's own stubs: the specifier `@mod/<path below the mod>` (`import type { BP_X_Manual } from "@mod/Relays/BP_X"`), mapped in `.abfc/tsconfig.paths.json` to `./stubs/<profile>/Mod/<mod>/*.js`. The old `/<mod>/*` mapping stays for older code; such an import is warning `ABFC2008` with a quick fix to `@mod/...`.
- Manifests stay keyed by the full asset path (`.abfc/manifest/<Mod>__<Dir>__<Asset>.json`). They are project state, not source. After switching `mod.name`, the other mod has its own (initially empty) ownership; nothing is carried over between mods.

### 18.2 Recorded paths and moved or renamed files

- Every successful build writes `source: { file: "src/Relays/MyRelay.ts", class: "MyRelay", derived: true }` into the manifest of each asset it built (`derived: false` when `path:` was given). The first build records it; later builds keep it current.
- Move check (`abfc check`, `abfc build` before planning, `abfc lsp`): for each class without `path:` whose derived path P has no manifest, abfc looks for an orphan manifest M of the current mod (no class resolves to `M.asset`) that matches the class: `M.source.class` equals the class name, or `M.source.file` equals the class's file, or (a manifest written before 1.0, without `source`) the last segment of `M.asset` equals the class name. With backend 2.6.0 (capability `assetOps`) exactly one match is renamed automatically on the next build (section 8.6): `renamed /<mod>/Old/MyRelay -> /<mod>/New/MyRelay`, references fixed by Unreal's rename fixup, the old files deleted by the next publish. Only an ambiguous case, or a backend without `assetOps`, is error `ABFC5012` at the class name:
  `MyRelay was built as /<mod>/Old/MyRelay (from src/Old/MyRelay.ts) but its file now gives /<mod>/New/MyRelay. abfc will not create a second asset or retire the first one.` Fix text: `keep the asset where it is with path: "Old/MyRelay" (quick fix)`, and, without `assetOps`, `update the backend to 2.6.0 to rename it`. Several matches: the same error listing them, without a quick fix. The build stops before anything launches (exit 1).
- Quick fix "Keep the existing asset path": inserts `path: "<M.asset relative to the mod>"` as the first option (`@blueprint()` becomes `@blueprint({ path: "Old/MyRelay" })`).
- Starting a new asset on purpose: remove the class (a build deletes the old asset when abfc created it, sections 6.2 pass 4 and 8.6), then add it in the new place.
- A moved file whose class and derived path are unchanged (a new `sourceRoot` over the same folders, or a file moved inside its folder) changes no asset path: the build is up to date and only the manifests' `source` and the source maps follow. A deeper `sourceRoot` changes every path, so every class is renamed (chunks of 20, section 8.6). `mod.name` in another letter case than the plugin file is read as the file's spelling (warning ABFC1045).
- History (the 7a probe, docs/roadmap.md): the probe of `bp_apply` failed (it forbids asset rename and delete, and `bp_publish` never removed files), so `abfc mv` was dropped for 1.0. The hardening release solved it differently: backend 2.6.0 adds `bp_asset_ops` and `bp_publish` deletions, and abfc renames automatically (8.6). The probe as specified was: `abfc mv <asset> <new mod-relative path>` exists only if this probe passes on a staged copy of a test mod: (1) `staging_sync`; (2) in a `bp_apply` raw Python step, `unreal.EditorAssetLibrary.rename_asset(old, new)` on a struct that a Blueprint uses, then save; (3) `bp_compile_report` of the referencing Blueprint is clean and `bp_read` shows the new struct path; (4) the old path holds no asset or only an `ObjectRedirector` that a further raw step can remove (`EditorAssetLibrary.delete_asset` after fixing up referencers) with the referencer still compiling; (5) `staging_status` lists the old file as deleted and the new one as added; (6) by reading the backend code (no call), `bp_publish` can remove a file from the real mod, or a small backend change can. All six pass: `abfc mv` is built in 7d (stage move, manifest and source-map rename, `path:`-free source moved by the user beforehand, publish carries the deletion). Any fails: no `abfc mv`; ABFC5012 offers the `path:` fix and the docs explain moving the asset in the Mod Editor, then dropping `path:`. The probe result is recorded in docs/roadmap.md.

### 18.3 `@director("RowName")` and class-manager rows

- `import { blueprint, director } from "@abfc/runtime"`; `@director("EntityDirector_MyFeature") @blueprint() export class BPC_MyDirector extends ActorComponent {}`. Decorator order is free. Declaration: `director(row: string): ClassDecorator-compatible factory`.
- Tag argument (since the hardening release, backend 2.6.0): `director(row: string, tag?: GameplayTag | keyof AbfcKnownGameplayTags | (string & {}))`, for example `@director("MyDirector", ClassManager.EntityDirector.MyDirector)`. The game starts a director only when its class-manager row carries the gameplay tag `ClassManager.EntityDirector.<Row>`, so the build writes `row.gameplay_tag` (capability `gameplayTags`, bp_apply feature `class_manager_row_tag`) and reads it back. A tag that does not exist yet is added to the mod's `Config/Tags/<mod>Tags.ini` (`GameplayTagList=(Tag="...",DevComment="")` in `[/Script/GameplayTags.GameplayTagsList]`) on the stage before the editor starts; staging tracks the ini like content, so `abfc publish` copies it (with backup), and when the Mod Editor is open the backend (capability `liveTags`) registers the mod's tags in it before it reloads the published row; if it cannot, or is older, `abfc publish` warns ABFC7015 (the open editor loads tags at its next start, so restart it and do not save the row there before). A director row file that the Mod Editor saved makes the class defaults stale, so the next build writes the row's tag again. Unused tags stay in the ini (shared mod content, abfc never removes a tag). `.abfc/tags.d.ts` (written by `abfc generate`, and refreshed from the mod's own tag inis whenever abfc writes a tag) declares the known tags as globals (`ClassManager.EntityDirector.X`) and `AbfcKnownGameplayTags`, and is included through `files` in `.abfc/tsconfig.paths.json`. A `@director` without a tag is warning ABFC2079 (quick fix inserts `"ClassManager.EntityDirector.<Row>"`), a tag that is not a literal or has bad characters ABFC2080, one outside `ClassManager.EntityDirector.` ABFC2081, a backend without `gameplayTags` ABFC2082.
- Row asset: `/<mod>/<classManager.table>/<RowName>` (default table `DataTables/DT_ClassManager`, so `/<mod>/DataTables/DT_ClassManager/EntityDirector_MyFeature`). The row name is a string literal (`ABFC2061` otherwise) matching `^[A-Za-z0-9_]+$`, at most 64 characters (`ABFC2073`).
- Only on a `@blueprint` class that is not a widget (`ABFC2074`); one `@director` per class; two classes with the same row are `ABFC2075`.
- `classManagerRow` (an option of `@blueprint`) is deprecated: warning `ABFC2076`, with a quick fix to `@director("<last segment>")` when the path is `/<mod>/<table>/<Row>`. Until removed it keeps its pre-1.0 meaning (verify only). Both on one class is `ABFC2061`.
- What the build does (class-defaults pass 5): with backend capability `classManagerRows` (backend 2.5.0), the defaults spec of the asset carries `class_manager_row: { "asset_path": "/<mod>/DataTables/DT_ClassManager/<Row>", "class_path": "/<mod>/.../<Class>.<Class>_C" }`. The backend, inside the same commandlet run on the stage: loads the row asset or, when it is missing, creates it with the class-manager row asset class (the class and its class-reference field are pinned in the backend from the 7a probe) and the row name equal to the asset name; sets the class field (`row.object_class`) to the loaded generated class object (not a soft class path) and changes no other field; saves; returns `rows: [{ asset, created, changed }]`. abfc records the row in the manifest (`directorRow`, part of `classDefaultsHash`) and adds the row asset to the would-publish list (section 12, item 7) when it was created or changed. A different row name later leaves the old row asset in the mod with warning `ABFC5013` (delete it in the Mod Editor). Removing `@director` from a class does the same: the defaults pass runs once more, the manifest drops `directorRow`, `ABFC5013` names the row left behind, and `abfc publish` lists only the rows of classes that still have a `@director`. Without the capability abfc keeps the pre-1.0 check (ABFC2070 when the row does not reference the class) and adds warning `ABFC2077` (`the backend cannot write class-manager rows; update abf-mod-editor-mcp to 2.5.0 or newer`).
- The 7a probe (read only, on the stage) fixes the unknowns before the backend step: the Python class of the existing row asset, its `row` struct type and fields, which field references the class, and which other fields hold non-default values. If a new row needs non-default values in other fields to work in game, the backend sets those fixed values on creation and the docs list them.

### 18.4 Project config and user config

Project `abf.config.json` (committed), schema 2:

| Key | Type, default | Rule |
| --- | --- | --- |
| `schemaVersion` | integer, absent = 1 | `2` today. Higher than abfc knows: error `ABFC1022` (written by a newer abfc). |
| `mod.name` | string, required | Folder name of the mod: `<mods folder>\<name>\<name>.uplugin`. `^[A-Za-z0-9_]+$`. |
| `sourceRoot` | string, `"src"` | Project-relative folder, `/` or `\`, no `..`, not absolute. |
| `classManager.table` | string, `"DataTables/DT_ClassManager"` | Mod-relative package folder of the class-manager rows; segments follow 18.1. |
| `stubs.classes`, `stubs.scriptClasses` | as before | unchanged |
| `stubs.widgetMembers` | as before | deprecated (ABFC3015); members are found by reflection |
| `stubs.modAssets` | `"all"` or mod-relative paths | Schema 2: entries are mod-relative (`"Relays/BP_X"`); a leading `/` is `ABFC1021`. Schema 1: `/<mod>/X` entries are accepted and read as `X`. |
| `stubs.scriptModules` | ignored | unchanged (ABFC3010) |
| `backend.kind`, `backend.minProtocol` | as before | unchanged |
| machine keys | discouraged | `editor.root`, `modsDir`, `mod.dir`, `headlessDir`, `backend.serverDir`, `backend.python`: read, `abfc doctor` warns (ABFC1021 warning). |

Schema 1 (every config before 1.0) still loads in every command, with warning `ABFC1031` (`abf.config.json uses schema 1; run "abfc init" in the project to upgrade it`). Migration happens only in `abfc init` (18.5): it writes `abf.config.json.v1.bak` (only if that file does not exist), sets `schemaVersion: 2`, rewrites `stubs.modAssets` entries to mod-relative, and offers to move `editor.root`, `modsDir`, `backend.serverDir` and `backend.python` to the user config (moved only with consent or `--yes`, and only when a user config file path exists on the machine; otherwise they stay). `mod.dir` and `headlessDir` always stay in the project config (init never writes them to the user config; schema 2 still reads them and `abfc doctor` warns). TS sources are never rewritten by init; the quick fixes of 18.1 to 18.3 and `abfc check` warnings lead the way.

User config (per machine, never committed): `%APPDATA%\abfc\config.json`, or the file named by `ABFC_USER_CONFIG`. Same parser as before (all keys optional), plus `schemaVersion`. `abfc init` writes `schemaVersion: 2`, `editor.root` and `modsDir` (absolute paths), and for a source install `backend.serverDir` and `backend.python` when they were given as flags. It merges into an existing file (other keys kept, key order kept, `config.json.bak` written before an overwrite) and writes a key only when it is missing, was given as a flag, or was chosen in the prompt. It never writes `mod.dir`. Precedence stays CLI flag > environment > project > user > auto (9.1), so `ABFC_BACKEND_DIR` and other environment variables keep winning over anything init writes.

### 18.5 `abfc init`

`abfc init [dir] [--mod <name>] [--yes] [--no-generate] [--mods-dir <dir>] [--editor-root <dir>] [--backend-dir <dir>] [--python <exe>] [--json]`. It runs without an existing project (the command is dispatched before the project lookup).

1. Target: `dir` or the working folder, created when missing. `ABFC1020` (exit 3) inside a mod folder (unchanged rule). `ABFC1040` when an ancestor folder (not the target) holds `abf.config.json` (nested projects).
2. Mode: no `abf.config.json` in the target: new project. Schema 1: upgrade (18.4). Schema 2: re-run (fill in missing files; switching the mod needs the prompt's confirmation or `--mod <other> --yes`).
3. Mod Editor: `--editor-root` > `ABFC_EDITOR_ROOT`/`ABF_EDITOR_ROOT` > (schema-1 upgrade only: the old project config's `editor.root`) > user config > Epic manifests > `Program Files\Epic Games\AbioticFactorModEdit*` (the order of 9.1 without the project config), validated by the profile's exe path. Not found: the prompt asks for the folder (validated, re-asked); with `--yes` it is `ABFC1001` (exit 2).
4. Mods folder: `--mods-dir` > `ABFC_MODS_DIR` > (schema-1 upgrade only: the old project config's `modsDir`) > user config `modsDir` > `<Documents>\Abiotic Factor Mods` (Documents from the Known Folder lookup of 9.1). It must exist (else the prompt asks; with `--yes` `ABFC1003`).
5. Scan: every direct subfolder `X` of the mods folder that holds `X\X.uplugin` (case-insensitive) is a mod. Shown per mod: folder name, the `.uplugin` `FriendlyName` when the JSON reads, and the number of `.uasset` files under `Content` (walk capped at 5000). Sorted by name. Folders without a matching `.uplugin` are skipped silently.
6. Prompt (interactive only when stdin and stdout are terminals; otherwise without `--yes` it is `ABFC1041`, exit 1, "use --mod <name> --yes"):
   ```
   Mod Editor: C:\Program Files\Epic Games\AbioticFactorModEditXXXX  (Epic manifest)
   Mods folder: C:\Users\Jane\Documents\Abiotic Factor Mods  (auto)
     1) ExampleMod        "Example Mod"         12 assets
     2) OtherMod          "Other Mod"            3 assets
     c) change the mods folder and rescan
     q) quit without writing anything
   Link which mod? [1-2, c, q]:
   ```
   `c` asks for a folder, validates it and rescans (the list repeats). An empty scan prints `ABFC1044` (no mods in the folder; create one in the Mod Editor first) and offers `c`/`q` only. Then a summary of the files to write and `Write these files? [y/N]`. Nothing is written before that answer.
7. `--mod X --yes`: no prompt. X must be in the scan (case-insensitive; written with the folder's spelling), else `ABFC1042` listing the mods found (exit 1). `--mod X` without `--yes` preselects X and still asks the final question.
8. Files (project folder): `abf.config.json` (18.4: `schemaVersion` 2, `mod.name`, `sourceRoot` `src`, `classManager.table`, `stubs` with `classes: []`, `scriptClasses` from the profile's new `initScriptClasses` list (engine classes only), `modAssets: "all"`, `widgetMembers: {}`, `backend`); `tsconfig.json` (the strict options of 4.2, `extends: "./.abfc/tsconfig.paths.json"`, `include: ["src"]`, `noEmit`, `skipLibCheck`, `types: []`, no plugins); `.gitignore` (2.1 list; existing file: missing lines appended, nothing removed); `.vscode/tasks.json` (tasks `abfc: check` with `--watch`, `abfc: build`, `abfc: test`, inline problem matcher of 2.4) and `.vscode/extensions.json` (recommends the abfc extension), each only when absent; the sample `src/Samples/BP_HelloAbfc.ts` plus `src/Samples/BP_HelloAbfc.test.ts` only when `src` holds no `.ts` file (an Actor with an own `Count!: int` field and an `@event Bump()` that adds 1; the test spawns it, calls `Bump` twice and expects 2). Then the user config (18.4).
9. Existing files on a re-run: `tsconfig.json` is never rewritten; when it lacks the `extends` or still loads `@abfc/ts-plugin`, warning `ABFC1043` prints the exact change. `.vscode` files and the sample are left alone when present. Running init twice with the same answers changes nothing (second run: every file "kept", exit 0).
10. Stubs: unless `--no-generate`, init runs `abfc generate` in-process for the new project (needs the installed editor, not an open one). A stubs failure is printed and does not undo the written files.
11. Doctor: init ends with the `abfc doctor` checklist (in-process). Exit code: the highest of stubs and doctor (0 when both pass).
12. `--json`: one object `{ project, mod, modsDir, editorRoot, files: [{ path, action: "written" | "kept" | "updated" }], userConfig: { path, keys }, stubs: <exit code or null>, doctor: <exit code> }`.

New codes: `ABFC1022` newer schema, `ABFC1031` schema 1 (warning), `ABFC1040` nested project, `ABFC1041` no terminal, `ABFC1042` mod not found, `ABFC1043` tsconfig needs a manual change (warning), `ABFC1044` no mods in the folder.

### 18.6 `abfc lsp`

- `abfc lsp` (alias `abfc lsp --stdio`; a `--clientProcessId=<n>` argument some clients add is accepted and ignored) speaks LSP 3.17 over stdio, built on `vscode-languageserver` 9 (pure JS). It finds the project per document by walking up to `abf.config.json`; several projects per workspace are supported (one compiler state per project, kept while one of its documents is open). Stdout carries only the protocol; logs go to the client's output channel or stderr. The server resolves the environment like `abfc check` (editor install, profile, stub fingerprint) but never starts Python or the backend.
- Capabilities: `textDocumentSync` incremental; `publishDiagnostics` (push) with source `abfc`, code `ABFCnnnn`, and `codeDescription.href` to the error code reference (18.11); `hoverProvider`; `codeActionProvider` (kind `quickfix`); `workspace.didChangeWatchedFiles` for `abf.config.json`, `.abfc/manifest/*.json`, `.abfc/stubs/**/stubs.lock.json` (reload). `completionProvider` (since the hardening release) offers two things from a pure compiler module (`frontend/completions.ts`): library functions (a static function of any `export declare namespace X` in the project's stubs; accepting inserts the qualified `KismetSystemLibrary.PrintString` and adds or extends the import) and, in a class body, `@override override ReceiveBeginPlay(): void { }` snippets for the overridable events of the parent type (a parent instance method with `@bpPath`, returning `void`, not pure, not deprecated, not already declared; engine events by the name pattern `Receive*`, `K2_On*`, `BP_On*`, `OnReceive*` or a first doc line starting with `Event`, any such method of a Blueprint parent). A wrong extra offer is harmless: Unreal's compile reports it as ABFC6001 at the TS line. VS Code merges these with its TypeScript completions through the existing client. No go-to-definition, no rename: those stay with the editor's TypeScript server.
- Diagnostics per open file: what `abfc check` reports for it (the compiler's `checkProject()` over the whole program, once per program version, then filtered to the file, exactly as the tsserver plugin did), the stub-lock codes ABFC3001 to ABFC3003 on the config, the move check (ABFC5012), and the `@abfc/eslint-plugin` recommended rules run in-process through ESLint's `Linter` class with `@typescript-eslint/parser` given the server's own `ts.Program` (no ESLint config file is read). TypeScript's own diagnostics (ABFC2000) are left out by default because the editor's TypeScript server shows them; initialization option `{ "tsDiagnostics": true }` turns them on for editors without one. Debounce 300 ms after the last change. Lint findings have source `abfc`, the rule id as code (`abfc/no-loop-in-tick`), severity warning and `codeDescription.href` to the rule's section of `lint-rules.md`. Config-level codes (ABFC3001 to ABFC3003, and a config that does not load) are published on `abf.config.json` at its first line. Unsaved editor text is what the server checks (open documents overlay the files on disk).
- Hover: the Blueprint nodes the statement lowers to (the existing `explain` output, at most six, only when the project lowers without errors) and, on a stub member, the first line of its description; with `{ "tsHover": true }` also the symbol and its TypeScript type (`name: type`), for editors without a TypeScript server.
- Code actions: `idiv` (ABFC2010), `?.` (TypeScript's possibly-null errors 2531, 2532, 18047, 18048, 18049), remove redundant `path:` (ABFC2006), relative `path:` (ABFC2005), `@mod/` import (ABFC2008), `@director` (ABFC2076), keep existing asset path (ABFC5012, from the diagnostic's `data.keepPath`). Each is a pure text-edit function in `@abfc/compiler` (`frontend/fixes.ts`), unit tested without an editor. The server computes the actions from its own diagnostics in the requested range (including the TypeScript ones it holds even when `tsDiagnostics` is off), so they work whatever diagnostics the client sends back.
- TypeScript: the server uses its bundled TypeScript 6.0.3 (the compiler's own), never the workspace's, so no `typescript.tsdk` and no version match are needed.
- The tsserver plugin is retired: not written by `abfc init`, not shipped in `abfc.exe` or the `.vsix`, not published; `scripts/plugin-parity.mjs` is replaced by `scripts/lsp-parity.mjs`, which compares `abfc lsp` (driven by a scripted LSP client over stdio) with `abfc check`, and once it passes on the corpus the `packages/ts-plugin` folder is deleted (7b). `abfc init` keeps warning (ABFC1043) about a tsconfig that still loads the plugin. Reason: it only works with the workspace TypeScript 6.0.3 from `node_modules`, which the exe install does not have, and it cannot serve other editors.
- Editors: VS Code through the extension (18.7); Neovim (`vim.lsp.start{ cmd = {"abfc","lsp"}, root_dir = <dir with abf.config.json> }`), Helix (`languages.toml` language server entry), Zed and JetBrains (generic LSP client plugins): documented snippets only.

### 18.7 VS Code extension (`.vsix`)

- `packages/vscode` (private, name `abfc-vscode`, publisher placeholder `abfc`, so the extension id is `abfc.abfc-vscode`, engine `vscode ^1.90`, `vscode-languageclient` 9 for LSP 3.17), compiled by `tsc -b` and bundled by esbuild into `dist/extension.js` (CommonJS, `vscode` external), packed with `@vscode/vsce` (`--no-dependencies`) into `build/vsix/abfc-vscode-<version>.vsix` at the repo root by `npm run vsix`; the release scripts (18.10) pick it up from there. Never published to the marketplace.
- Activation: `workspaceContains:**/abf.config.json`. It starts `abfc lsp` with `vscode-languageclient` (stdio, which adds `--stdio`) for `typescript` documents (`file` scheme; the server ignores files outside a project), with `{ tsDiagnostics: false, tsHover: false }`. One client serves every project of the workspace.
- Finding abfc, first hit wins: setting `abfc.path` (an executable, or a `.js` file started with `node`; a `.cmd`/`.bat` value is mapped to the `node_modules\@abfc\cli\dist\src\bin.js` beside it when that exists, else rejected with a message to point it at `abfc.exe` or `bin.js`); `abfc.exe` on `PATH`; an npm global install (`abfc.cmd` on `PATH` with `node_modules\@abfc\cli\dist\src\bin.js` beside it); `%LOCALAPPDATA%\Programs\abfc\abfc.exe` (the installer default); for a source install, `node_modules\@abfc\cli\dist\src\bin.js` in a workspace folder, then `abfc.cliPath` when it names an existing `bin.js`. `.js` entries run as `node <file>` with `node` from `PATH` (a `.cmd` shim is never started, because Node needs a shell for it). None: one notification with a link to the install docs; no retry loop.
- Workspace Trust: `capabilities.untrustedWorkspaces` is `limited`, with `abfc.path` and `abfc.cliPath` as restricted configurations and both settings `machine-overridable`, because they and the workspace `node_modules` bin.js can come from the opened repo. In an untrusted workspace discovery skips the workspace-set steps (`abfc.path`, the workspace `bin.js`, `abfc.cliPath`) and uses only `PATH`, the npm global install and the installer folder; granting trust (`onDidGrantWorkspaceTrust`) restarts the server and so repeats the discovery.
- Contributes: `jsonValidation` for `abf.config.json` (the schema JSON ships inside the `.vsix`; its source is `packages/cli/schema/abf.config.schema.json`), the problem matcher `$abfc` (the 2.4 pattern), commands `abfc: Build`, `abfc: Test`, `abfc: Publish (dry run)`, `abfc: Doctor` (each runs the CLI as a VS Code task with a process execution in the project folder, so no shell quoting is involved, and the `$abfc` matcher), `abfc: Restart Language Server` (finds abfc again, then restarts), and settings `abfc.path`, `abfc.cliPath`, `abfc.trace.server`. A change of `abfc.path` or `abfc.cliPath` restarts the server.

### 18.8 `abfc.exe`

- Node single executable application, built with `node --build-sea sea-config.json` (Node 25.5+, no postject) from the `node.exe` pinned in `release/pins.json` (Node 26.x; the installed `node.exe` is used when its sha256 equals the pin, otherwise the official one is downloaded once). The build strips the PE certificate table of the output (the same effect as `signtool remove /s`), because the official Node signature no longer matches; abfc itself is not signed (decided).
- Entry: esbuild bundles `packages/cli/dist/src/exe.js` (the CLI entry without top-level await; `bin.js` stays the entry of the npm install) with every dependency (TypeScript 6.0.3, ESLint's `Linter`, the LSP libraries) into one CommonJS file (`platform: node`, `target: node24`, `import.meta.url` defined as a banner-defined file URL built from `process.execPath`). TypeScript's `lib*.d.ts` files load from the runtime's `tslib\` folder (the compiler frontend replaces `ts.sys.getExecutingFilePath`, which TypeScript uses to find them). `useCodeCache: true`, `disableExperimentalSEAWarning: true`.
- Assets (SEA `assets`): `runtime.zip` and `runtime.sha256.json`. `runtime.zip` holds `backend\` (the pinned `abf-mod-editor-mcp` release, allowlisted files only, see 18.10), `python\` (the pinned Windows embeddable Python, its `._pth` gaining the line `..\backend`), `profiles\` (`packages/env/profiles/*.json`), `data\descriptions.json` (stubgen), `types\runtime\*.d.ts`, `types\testkit\*.d.ts`, `types\ir\*.d.ts` (testkit's declarations import `@abfc/ir`, so `abfc generate` maps all three), `tslib\lib*.d.ts`, `schema\abf.config.schema.json`, `THIRD-PARTY-NOTICES.txt`.
- Extraction: on the first command that needs a runtime file, to `<runtime root>\<abfc version>-<sha8 of runtime.zip>\`, where the runtime root is `ABFC_RUNTIME_DIR` (abfc only) or `%LOCALAPPDATA%\abfc\runtime`. Each process extracts into its own temp sibling folder (`.tmp-*`), verifies every file against `runtime.sha256.json`, writes the marker `.abfc-runtime.json` last and renames the folder into place; the first rename wins, a loser deletes its copy and uses the winner's folder (the rename is retried briefly on EPERM/EBUSY/EACCES, because antivirus scanners lock fresh executables). An existing folder is verified quickly (marker plus the existence and size of every file) on each run, and fully by sha256 with `abfc doctor --deep`; a mismatch moves the folder aside and re-extracts (a process that finds the folder already moved aside by another one extracts its own copy; the first rename wins). Failures are ABFC1050 (extraction failed), ABFC1051 (a damaged folder is in use and cannot be replaced) and ABFC1052 (the exe's `runtime.zip` does not match its manifest: reinstall). Older runtime folders are deleted by the installer's uninstall step and by `abfc doctor --clean-runtimes`, which works outside a project and keeps the running exe's folder. It deletes only what abfc created in the runtime root: folders named `<version>-<8 hex digits>` that hold the marker `.abfc-runtime.json` (or are empty) and `.tmp-*` / `.bad-*` leftovers; every other file or folder (the root may be a shared folder set by `ABFC_RUNTIME_DIR`) is left alone and listed as not removed. `ABFC1053` (warning, `abfc doctor`): the exe resolved its backend folder or Python from a source-install setting outside its runtime folder.
- Locating files: a new `@abfc/env` module `install.ts` (`runtimeLayout()`) returns the paths of profiles, descriptions, runtime and testkit type files, the bundled backend and Python: from the extracted runtime when `require("node:sea").isSea()`, else from the package-relative locations used today (source install). `profile.ts`, `stubgen/describe.ts` and `cli/commands/generate.ts` (the three `import.meta.url`/`createRequire` sites) read through it. The backend dir and Python auto-discovery of 9.1 use it.
- Pins: `release/pins.json` (committed) holds `node` (version, URL, sha256 of `node.exe`, the URL of Node's checksum list, the URL and sha256 of Node's license text), `python` (embeddable zip version, URL, sha256; 3.14.x, because 3.12 has had no binary releases since 3.12.10 and the backend already runs on 3.14), `backend` (repository, version, tag, commit, `filesSha256`), `innosetup` (version, URL, sha256). `backend.filesSha256` is the sha256 over the sorted lines `path<TAB>sha256-of-blob<LF>` of the vendored files, read with `git ls-tree` and `git cat-file`; unlike a tarball hash it does not depend on the git version or the archive format. An empty sha256 means not yet pinned: `scripts/release/fetch-pins.mjs --record` fills it on the first approved download and never overwrites a non-empty pin. The release build refuses any download whose sha256 differs and an empty pin. The backend release pinned for 1.0 is the first one with `classManagerRows` (2.5.0), pinned by commit until its tag exists.
- Source install fallback: `npm install -g @abfc/cli` (Node 24) or a git clone plus `npm ci && npm run build`; the backend is a git checkout of the pinned tag, given once with `abfc init --backend-dir <dir>` (written to the user config) or `ABFC_BACKEND_DIR`; Python from `PATH`. Nothing is downloaded by abfc at run time.

### 18.9 Installer and zip

- Tool: Inno Setup 6 (classic wizard, one `.iss` script under `release/installer/`, built by `scripts/release/build-installer.mjs`, which stages `build/release/installer-input/`, writes `build/release/zip/` and compiles with `iscc` when it is found: in CI, or locally with a portable Inno Setup under `build/tools/`). Output `abfc-setup-<version>.exe`, unsigned.
- Installs per user, no admin: `%LOCALAPPDATA%\Programs\abfc\` with `abfc.exe`, `abfc-vscode-<version>.vsix`, `LICENSE.txt`, `THIRD-PARTY-NOTICES.txt`, `README.txt`. Adds that folder to the user `PATH` (HKCU `Environment`, with a broadcast so newly opened terminals pick it up; the checkbox reads "Add abfc to PATH"; removed on uninstall). The tasks are `addtopath` (default on) and `vsix` (shown only when `code.cmd` is found): `code --install-extension <vsix> --force`; the silent test form is `/MERGETASKS="!addtopath,!vsix"`. Fixed `AppId` so a newer installer upgrades in place; an update is running the newer installer (no updater, no network). Uninstall removes the program folder and the PATH entry and asks before deleting `%LOCALAPPDATA%\abfc\runtime` (the question defaults to No in silent mode, so silent uninstalls keep it); it never touches the user config, projects or mods.
- Zip: `abfc-<version>-win-x64.zip` with the same files; the docs show the PATH step and the `code --install-extension` command.
- SmartScreen: unsigned downloads show "Windows protected your PC"; the docs explain "More info" then "Run anyway", how to check the file against `SHA256SUMS.txt` from the release page (`Get-FileHash`), and that the zip avoids the installer prompt but not the first-run check.

### 18.10 Release hygiene

- Allowlists: `release/allowlist.json` lists, per artifact (`exe`, `zip`, `installer`, `vsix`, each npm package, the vendored backend), the files or globs that may go in. Build scripts (`scripts/release/*.mjs`) copy only allowlisted files into `build/release/<artifact>/` and fail on an allowlisted path that is missing. Never shipped: tests, fixtures, scripts, `.plans`, `.claude`, internal docs (roadmap, design), source maps of other machines, any `.abfc` folder. For the backend: the host modules `server.py`, `abfc_tools.py`, `bpscan.py`, `headless.py`, `headless_tools.py`, `hiddendesk.py`, `paths.py`, `staging.py`, `wininput.py`, `fscopy.py`, `tagsini.py`, then `editor/**`, `LICENSE`, `README.md`, `CHANGELOG.md`; never `data/` (game-derived file lists and the Blueprint filter list: the file lists are only used by `check_upload`, which is not an abfc tool, and the backend downloads the Blueprint filter into its `data\` on first use, as in a source checkout), `tests/`, `exports/`, run folders. The release build scans the vendored `.py` files for `import` and `from ... import` lines and fails when one imports a local module of the backend repository that the allowlist leaves out.
- Scan: `scripts/release/scan-artifacts.mjs --version <v>` opens every built artifact and exits 1 on any hit. Artifacts: the exe (`build/release/exe/abfc.exe`, its SEA blob scanned as binary), `runtime.zip` (entries scanned; the `python/` entries are scanned but not recursed, they are the pinned official CPython), the release zip, every file of the installer input folder, the installer exe (scanned as binary; it is LZMA-compressed, so the real check is the installer input), the `.vsix` and the npm tarballs `build/release/npm/*.tgz`. Containers are recursed: `.zip` and `.vsix` entries, `.tgz` through gunzip and a minimal ustar reader. Rules: `name` (a mod name, case-insensitive substring); `userPath` (`[A-Za-z]:\Users\<name>` in either slash style, `/home/<name>`, `/Users/<name>`, where `<name>` is not `Public` or a documented placeholder such as `Jane Doe` or `<you>`; the report masks the user name to its first two characters); `buildPath` (the absolute repo root of the build, both slash styles, which catches a CI checkout path); `devFile` and `devPath` (`.claude`, `.plans`, `.abfc` and `.git` as path segments of an entry name, or `.claude`/`.plans` folders in text); `gameFile` (by name: `*.uasset`, `*.umap`, `*.pak`, `*.utoc`, `*.ucas`, `stubs.lock.json`, `reflect*.json`, `BlueprintFilter*`, `*-files.json.gz`); `gameContent` (a `.d.ts` that starts with the generated-stubs header or contains an `@bpPath /Game/` tag, and JSON with `/Game/` class reflection keys). Names: the committed guard words are the mod-name fragments of the backend's name guard plus the game-internal identifiers of abfc's own name guard (assembled from pieces in the source; the game's name is not a guard word, because the product names it legitimately); scan names come from the committed guard words only (no CI secret); an optional local `--denylist <file>` (a file outside the repo, one name per line, never committed) can add more. In binary data a name shorter than 5 characters must stand alone (no letter or digit next to it), because such a short word turns up by chance in compressed bytes; in text files every name matches as a substring. Name hits are printed as `guard word #i` or `denylist entry #i`, never as the word, so that no name reaches a log. A hit prints the rule, the artifact chain (`outer.zip > inner.vsix > extension/x.js`), a masked detail and the first 12 hex digits of a context hash. `release/scan-exceptions.json` holds exceptions keyed by `{rule, artifact, entry, context}`, where `context` is the sha256 of the lowercased text 32 characters around the hit (no word or path is committed); an unused exception is a warning. Only third-party content may be excepted; abfc's own files are fixed instead. The scan runs in CI on every pull request against a full build.
- npm: all public packages share one version (lockstep semver; 1.0.0 first). Each package ships positive `files` patterns (`dist/src/**/*.js`, `dist/src/**/*.d.ts` and its data folder if any), so no source maps and no tests, plus a `LICENSE` and a short `README.md`; the manifest has `repository.directory`, `publishConfig.access: public` and `engines.node >=24`. `scripts/release/pack-npm.mjs` runs `npm pack` for each public package and checks the file list against `release/allowlist.json` `npm`, rejects `file:`, `link:` and `workspace:` dependencies and writes `build/release/npm/packages.json` in topological publish order (ties by name). The real `npm publish --provenance --access public` runs only on a manual dispatch of `release.yml` with `publish_npm: true`, in the GitHub environment `npm` (required reviewers, secret `NPM_TOKEN`, `id-token: write` for provenance), and only after the scan passed; every other run uses `npm publish --dry-run`. A prerelease version is published with `--tag next`. `@abfc/ts-plugin` is not published; the vscode package is private.
- Versioning: semver for the CLI surface (commands, flags, exit codes, error codes, config schema, decorators). A new config schema or a removed option is a major change. `CHANGELOG.md` (Keep a Changelog) per release. `scripts/release/set-version.mjs <semver>` sets the lockstep version in every package manifest, the exact `@abfc/*` dependency versions, `package-lock.json` and `packages/cli/src/version.ts`; `--check <semver>` lists mismatches and exits 1. `build-exe.mjs` refuses a `--version` that differs from the CLI package version unless `--dev`, so the exe's runtime folder and `abfc version` cannot disagree. Release candidates are `set-version 1.0.0-rc.N` plus a tag by the person releasing.
- CI: `.github/workflows/ci.yml` runs on pull requests, pushes to `main` and manual dispatch on a Windows runner. Job `test` builds and tests on Node 24 and on the pinned Node 26.7.0 and runs `pack-npm.mjs --dry-run`; job `artifacts` builds the exe, `.vsix`, installer and npm tarballs at the package version, runs `inspect.mjs` and the scan with the committed guard words. `.github/workflows/release.yml` runs on a tag push `v*.*.*` and on manual dispatch (inputs `tag`, `draft_release`, `publish_npm`): it checks the tag against `set-version --check`, builds, runs the scan, stages the release files with `scripts/release/stage-github.mjs` (the files, `SHA256SUMS.txt`, `release-notes.md` with the CHANGELOG section), uploads them as workflow artifacts, creates a draft GitHub release (tag push, or dispatch with `draft_release`) and runs the npm job described above. Inno Setup comes from the runner image (`ISCC.exe` under `Program Files (x86)`), else from the pinned download in `release/pins.json` installed portably under `build/tools/`; the build fails while that pin is empty and the runner has none. The workflows are checked by text tests only; nothing is published by an agent. Node 26.7.0 is not an LTS build; it is re-pinned to the current LTS patch before 1.0. GitHub Actions are referenced by `@v4` tags and re-pinned to commit SHAs by the maintainer.
- GitHub releases: CI creates a draft release for the tag with the exe, installer, zip, `.vsix`, `SHA256SUMS.txt` and the changelog section; a person publishes it. Tags and releases are never created by an agent without the user's go-ahead.

### 18.11 Docs set (`docs/`, public)

`install.md` (installer, zip, source install, PATH, the `.vsix`, SmartScreen), `first-mod.md` (Mod Editor, create the mod in the editor, `abfc init`, the sample, build, test, `abfc publish` into the mod, open the result in the editor), `cli.md` (every command and flag, exit codes, `--json` shapes), `errors.md` (every ABFC code with one `### ABFCnnnn` heading, which is also the anchor the language server links to: meaning, typical cause, fix; a test checks both ways that every code in the source has a section and every section has a code in the source), `config.md` (18.4), `backend.md` (bundled backend, source-install backend, versions and capabilities), `language-service.md` (the language server and the editors page: VS Code, Neovim, Helix, Zed, JetBrains; `editors.md` is dropped), `troubleshooting.md` (OneDrive-redirected Documents, user names with spaces and the headless folder, non-English Windows and localized folder names, long paths, SmartScreen, the Epic login window of the audit, antivirus quarantining the exe, a stale runtime folder), `releasing.md` (the maintainer procedure: CI, secrets, tags, pins), and `CHANGELOG.md` at the repository root. `lint-rules.md` is updated; `design.md` and `roadmap.md` stay as internal history but are not shipped. A docs test checks relative links, `errors.md` and `lint-rules.md` anchors, user paths and guard words.

### 18.12 Carry-overs

| Carry-over | Where | Decision |
| --- | --- | --- |
| `classManagerRow` row writing | 7a | `@director` plus backend `class_manager_row` (18.3). |
| ABFC4012 code collision | 7d | The adapter's missing cross-wire entry becomes `ABFC4015`; `ABFC4012` stays "no `backend_info`". Done. |
| `no-unbounded-array-growth` false positive on one-time setup pushes | 7d | No report when the same class clears the array (`this.X.length = 0`) anywhere (already so), and, new, for a push lexically inside an `@override` method named `ReceiveBeginPlay`, `Construct` or `OnInitialized` (one-time events; option `oneTimeMethods` replaces the list). A push inside a callback in such a method is still reported. RuleTester cases for both, and the Phase 5 fixture finding re-reviewed. |
| `rpc-misuse` on calls inside server RPCs | 7d | A call to a server RPC (`clientFromClient`) is not reported inside the body of a server RPC method (its own symbol or the base member it overrides carries `@bpRpc server`), nor inside a `private` method of the same class whose every `this.M(...)` call site lies directly in a server RPC or in another such private method. Callbacks (arrow or function expressions) inside a server RPC are not exempt. `reliableSpam` is unchanged. |
| Restore after a post-apply compile failure | 7d | abfc-only: when the post-apply Unreal compile report fails, abfc resyncs the stage (`staging_sync` with `discard_changes`); unpublished stage work of every asset of the mod (not only of the assets that build applied) is discarded as with `--resync`. The manifests of all owned assets go back to their state from before that build and then drop the units whose nodes the re-synced stage does not hold (never published; adopted units keep their entry), and the source maps follow. A published unit that the build re-applied keeps its old entry and node names, and a unit the build removed is tracked again, because the mod still holds their nodes. The next build therefore re-applies the unpublished units on a clean stage, without ABFC5002 or ABFC5003. A failed resync is warning `ABFC4016` (the build already failed). `--keep-failed-stage` keeps the failed state for inspection. A failed `bp_apply` is already rolled back by the backend. No backend restore tool. |
| Opt-in drift read for unchanged builds | 7d | `abfc build --drift` (build only; usage error elsewhere) reads and drift-checks every owned asset (the gate-3 read), without changing what is applied. |
| `abfc publish --full` gate 5 (ABFC7002, Epic login) | 7d | One live investigation step of the audit's hidden editor; if it stays open, it is a documented known issue and open question 2 (a bypass flag) goes back to the user. The 1.0 exit (build and default publish) does not need gate 5. Result (2026-11-08): not resolved; two live audits of the stage failed the same way (60 s and 240 s grace, 74 s and 248 s wall time, nothing mounted, no audit ran), and with the open Mod Editor running no code path of abfc could change that. Evidence: the hidden editor's login window offers only "Login with Epic Games Store" and "Login with Mod.io"; its command line has none of the Epic launcher's credential arguments that the user's normally started editor receives (the launcher passes an exchange-code login and portal flag, after which that editor's login window closes within a second at startup), and the log shows no mod.io user request, unlike the normal editor. Raising `ABF_LOGIN_GRACE` does not help because the window waits for a user. The backend also builds the private home's `AppData\Local` junction after it has already redirected `LOCALAPPDATA`, so the junction points at the headless `la` folder and not at the real Local folder (the real folder holds the mod.io data; the `la` folder has no session data), and a stored mod.io session is not visible to the hidden editor; whether the editor would reuse such a session is untested. Hypothesis: the editor logs in from launcher-supplied credentials or a stored session, and the hidden launch has neither. A fix, not built here: keep the real local-app-data folder visible to the hidden editor for the mod.io (and Epic) session data (a junction for that sub-folder only), or start the editor through the launcher's login arguments; if neither works, the 1.0 answer to open question 2 is an opt-out flag or capability policy for gate 5. |
| `abfc mv` and asset moves (7a) | 7d, hardening | Done differently: automatic rename, reparent, recreate and delete through backend 2.6.0 `bp_asset_ops` and `bp_publish` deletions (8.6, 18.2). No `abfc mv`. |
| TypeScript wins over Mod Editor edits | hardening | Done (8.1): no build refuses for an editor edit; one ABFC5014 warning per asset names what was replaced or removed; hybrid classes opt out of the sweep; a changed mod is re-synced automatically (ABFC4017). |
| Optional engine parameters | hardening | Done: the backend reads Unreal's own default lookup (metadata key equal to the parameter name, then `CPP_Default_<Param>`) into `meta.defaults`; stubs make the longest trailing run of defaulted inputs optional with `@bpDefault`. An omitted argument sets no pin, so the node keeps the default Unreal places. `packages/stubgen/src/curated.ts` adds K2 zero defaults (`bool` false, `int` 0) for a short list of very common functions (`GetPlayerCharacter`, `K2_SetActorLocation` and similar), used only when the backend gave no default; no general "trailing bools are optional" rule. `STUBGEN_VERSION` 0.5.0. |
| Completion in `abfc lsp` | hardening | Done (18.6): library functions and `@override` stubs. Snippets with argument placeholders are not built. |
| Project lock | hardening | Done (8.7): ABFC4019. |
| Open editor's asset registry after a published deletion | hardening | Limitation: the entry stays until the Mod Editor is restarted (the files are gone); no package unloading in a user's open editor. |
| Function locals (backend and lowering) | deferred (after 1.0) | abfc does not need them (temps are member variables), `functionLocals` stays false. |
| Changing the fields of an existing struct | deferred (after 1.0) | Needs a trusted delete plus recompiling referencers; ABFC2046 and `errors.md` explain the workaround (a new struct name). |

## Credits

`abf-mod-editor-mcp` was originally created by theelites11gamer (https://github.com/theelites11gamer/abf-mod-editor-mcp, MIT) and extended with the headless Blueprint tools by DezionDev. abfc depends only on `EmekC/abf-mod-editor-mcp`.
