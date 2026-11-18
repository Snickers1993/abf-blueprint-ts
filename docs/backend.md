# The backend: abf-mod-editor-mcp

abfc does not touch Blueprint assets itself. It talks to a headless Mod Editor backend, the MCP server in https://github.com/EmekC/abf-mod-editor-mcp. That repository is the only supported backend, and it owns its version numbers. abfc spawns the server (`python -I -X utf8 <backend dir>\server.py`), speaks MCP JSON-RPC over stdio and calls its tools (`bp_apply`, `staging_sync`, `bp_compile_report`, `bp_game_test`, `mod_audit`, `bp_publish`, `reflect`, `backend_info`). See [design.md](design.md) section 7 for the transport and the mapping from the IR to `bp_apply`.

## The bundled backend

`abfc.exe` (the installer and the zip, see [install.md](install.md)) carries a copy of this backend and its own Python. There is nothing to install or configure: the first command that needs them unpacks them into the runtime folder, and `abfc doctor` prints the backend version it uses. A release of abfc is built with one pinned backend version, so the exe and the backend always match. The rest of this page is about the settings and capabilities that apply to every install, and about the source install, where you provide the backend yourself.

## Requirements

| What | Value |
| --- | --- |
| Recommended server version | 2.6.0 (tag `v2.6.0`): asset operations, publish deletions, director tags, parameter defaults, variable defaults. `abfc.exe` bundles it |
| Minimum server version | 2.4.0 (tag `v2.4.0`) for a source install; class-manager rows (`@director`) need 2.5.0 (tag `v2.5.0`) |
| Protocol | 1 or higher (`backend_info.protocol`) |
| Python | 3.9 or newer on the PC (the editor uses its own Python internally) |
| Mod Editor | installed from the Epic Games Launcher |

An older server still works where it can: abfc gates every feature on a capability and prints a warning, not an error, below 2.4.0. With a server older than 2.5.0 the build warns with [ABFC2077](errors.md#abfc2077) and writes no class-manager row for `@director`. A protocol below 1 is an error.

Server 2.4.0 and 2.5.0 therefore still work, with these differences from 2.6.0:

- no `assetOps`: a moved or renamed class file stops the build with [ABFC5012](errors.md#abfc5012), a changed `extends` with [ABFC2048](errors.md#abfc2048), and a class that left TypeScript only loses its units ([ABFC5010](errors.md#abfc5010));
- no `publishDeletes`: files that should disappear from the mod are listed by [ABFC7014](errors.md#abfc7014) for you to delete in the Mod Editor;
- no `gameplayTags`: the director tag is ignored ([ABFC2082](errors.md#abfc2082));
- no `reflectDefaults`: engine parameters stay required in the stubs (only the curated zero defaults of the stub generator apply);
- no `variable_defaults`: changing the initializer of an existing field leaves the default as it is ([ABFC2084](errors.md#abfc2084));
- no `std_macro` node kind in `bpApply.nodeKinds` (or no `pinTypes`): array `for..of` and simple counted `for` loops are built as counter loops instead of For Each Loop / For Loop macro nodes ([ABFC2088](errors.md#abfc2088));
- no `function_graphs`: an undecorated method (a Blueprint function) is refused with [ABFC2044](errors.md#abfc2044);
- no `staging_status` `stale` list: an asset saved in the Mod Editor that the stage never touched is not noticed as a change; use `abfc build --resync`.

`abfc doctor` prints [ABFC4018](errors.md#abfc4018) with the list of what an older server lacks.

## Source install

Only a source install needs this (see [install.md](install.md#source-install)); `abfc.exe` does not.

1. Clone the repository: `git clone https://github.com/EmekC/abf-mod-editor-mcp <backend dir>`.
2. Check out the release: `git -C <backend dir> checkout v2.6.0` (the tag the abfc release is built with; `v2.4.0` is the minimum, and then renames, deletions and `@director` rows are not available, see Requirements).
3. Make sure Python 3.9 or newer is on `PATH` (not the Microsoft Store alias), or tell abfc where it is (see below).

To update, fetch and check out a newer tag. abfc never modifies the checkout.

## Point abfc at the backend

abfc resolves the backend folder in this order: the `--backend-dir <backend dir>` flag, the environment variable `ABFC_BACKEND_DIR`, the `backend.serverDir` setting of `abf.config.json` (or the user config). There is no auto-discovery of the backend folder, and it must hold `server.py`. The Python executable comes from `--python`, `ABFC_PYTHON`, `backend.python` or `python` on `PATH`.

```json
{
  "backend": { "serverDir": "<backend dir>", "python": "<path to python.exe>" }
}
```

Both keys are optional. `abfc doctor` prints which source each setting came from.

## What abfc sets for the server

| Variable | Set by abfc | Meaning |
| --- | --- | --- |
| `ABF_ABFC_TOOLS=1` | always | registers the opt-in tools `reflect`, `abfc_extensions` and `warm_session`, and makes `backend_info` report `reflect: true` |
| `ABF_WARM_SESSION=1` | unless `--cold` | keeps one hidden editor alive between operations (a build with several steps starts the editor once). `--cold` removes an inherited value, so the server stays cold even when your shell exports it |
| `ABF_REFLECT_META` | never | optional, set it yourself. `0` makes `abfc generate` skip the function tooltip and display-name read in `reflect` (the stubs then carry no hover descriptions). The `reflect` tool argument `meta` wins over the variable. abfc passes no argument, so the variable it inherits decides |

Use `ABF_REFLECT_META=0` if the hidden editor crashes during the function-template chunk of `abfc generate`; the stubs are complete apart from the descriptions.

## abfc doctor

`abfc doctor` starts the backend, calls `backend_info` and prints what it found, for example:

```
backend: server 2.6.0 (minimum 2.4.0), protocol 1
  engine: 5.4.4
  wildcard pin types: native
  containers: backend array: true, map: true, set: true; abfc array: true, map: true, set: true, struct: true
  reflect: yes, compile node refs: yes, game test: yes, audit: yes
  warm session: yes, stage audit: yes, class-manager rows: yes
  backend capabilities: asset ops: rename/delete/reparent/recreate, publish deletions: yes, gameplay tags: yes, reflect defaults: yes, class-manager row tag: yes, variable defaults: yes (recommended server 2.6.0)
  extensions: ...
```

- `server ... (minimum ...)`: the reported server version next to the minimum abfc is built for.
- `engine`: the Mod Editor's engine version (`null` is not printed).
- `wildcard pin types`: `native` is one apply; `fallback` is the slower two-phase route.
- `containers`: what the backend's type grammar accepts, then what abfc enables (abfc keeps its own policy for maps, sets and structs).
- The last lines show the capabilities, the warm-session state, the extensions and the headless folder the backend uses.

Warnings and errors from the backend check use the codes below. `abfc doctor` exits 0 with warnings, nonzero with errors. Every command that opens the backend runs the same check.

## backend_info capabilities and what abfc does with them

| Key | abfc feature |
| --- | --- |
| `protocol`, `serverVersion`, `engineVersion` | version check (ABFC4001, ABFC4014), `abfc doctor` |
| `capabilities.pinTypes` | wildcard pins (array length and item, casts) in one apply; without it, the two-phase route |
| `capabilities.containerTypes` | `Map` and `Set` types; gate ABFC2044 |
| `capabilities.warmSession` | warm hidden editor between steps |
| `capabilities.stageAudit` | `mod_audit` audits the staged copy (`abfc publish --full`) |
| `capabilities.reflect` | `abfc generate` (abfc also checks the tool list) |
| `capabilities.catalog` | backend 2.6.0: the read-only `catalog` tool (see below); without it `abfc generate` only generates the profile defaults, the config lists and `--add` paths ([ABFC3021](errors.md#abfc3021)) |
| `capabilities.compileErrorNodeRefs` | compile errors name the node and graph, mapped back to the TypeScript line |
| `capabilities.createKinds` | asset kinds that `bp_apply` can create (`Blueprint`, `WidgetBlueprint`, `BlueprintInterface`, `UserDefinedStruct`); gate ABFC2044 |
| `capabilities.gameTest` | `abfc test`, `abfc publish --full` |
| `capabilities.audit` | `abfc publish --full` |
| `capabilities.publish` | `abfc publish` |
| `capabilities.classManagerRows` | backend 2.5.0 or newer: `bp_apply` accepts the `class_manager_row` key, so `@director("RowName")` writes the class-manager row asset; without it the build warns and writes no row |
| `capabilities.assetOps` | backend 2.6.0, list of `rename`, `delete`, `reparent`, `recreate` (tool `bp_asset_ops`, at most 20 operations per call, all-or-nothing per call): moved and renamed classes, changed `extends`, deleted classes. Without it: ABFC5012, ABFC2048, ABFC5010 |
| `capabilities.publishDeletes` | backend 2.6.0: `bp_publish` with `delete_removed` removes files that are gone from the stage (with backup and a conflict check); `abfc publish` lists them as `deleted`. Without it: ABFC7014 |
| `capabilities.gameplayTags` | backend 2.6.0: `reflect` can list the gameplay tags of the game and the mod (completion of `@director` tags), and the backend adds a missing tag to the stage's `Config/Tags/<mod>Tags.ini` before the editor starts. Without it: ABFC2082, ABFC3012 |
| `capabilities.liveTags` | backend 2.6.0: `bp_publish` with an open Mod Editor registers the gameplay tags of the real mod's `Config/Tags/<Mod>Tags.ini` that the editor does not know before it reloads the published rows (result keys `tags_registered`, `tags_unregistered`, `tags_strategy`, `tags_error`). Without it: ABFC7015 when the tag list is published while the editor is open |
| `capabilities.reflectDefaults` | backend 2.6.0: `reflect` returns `meta.defaults` for function parameters, read in Unreal's own order (the metadata key equal to the parameter name, then `CPP_Default_<Param>`); `abfc generate` makes the trailing defaulted inputs optional. Without it: parameters stay required |
| `capabilities.classManagerRowTag` (`bpApply.features` entry `class_manager_row_tag`) | backend 2.6.0: `class_manager_row` accepts `gameplay_tag`, and the row's tag is verified after the write |
| `capabilities.variableDefaults` (`bpApply.features` entry `variable_defaults`) | changing the default of an existing variable in place; first appears in backend 2.6.0. Without it: ABFC2084 |
| `staging_status` `stale` | backend 2.6.0: lists stage files that the stage never touched but whose real file was saved or deleted in the Mod Editor since the sync; abfc treats them like conflicts and re-syncs the stage (ABFC4017) |
| `stageRefresh` (tool `staging_refresh`) | local backend patch `docs/backend-patches/backend-staging-refresh.patch` (not upstream): when every stale file is outside what abfc builds (no owned asset, no struct it creates, no manifest asset) and nothing conflicts, `abfc build` copies only the stale files from the real mod into the stage and keeps the rest, unpublished work included, so there is no ABFC4017, no prune and no read from the editor. A stale owned file or any conflict still re-syncs the whole stage |
| `capabilities.functionLocals` | always `false` today; abfc hoists temporaries into owned member variables instead |
| `capabilities.userPureFunctions` | always `false` today; every function is impure (exec pins) |
| `bpApply.features` | per-feature gates, for example `event_meta` (event tooltips, ABFC2071), `self_event_calls` (ABFC4013), `variable_defaults` (changing the default of an existing variable in place, ABFC2084) and `function_graphs` (own function graphs with access flags, replaced by name, ABFC2044) |
| `capabilities.functionGraphs` (`bpApply.features` entry `function_graphs`) | backend 2.6.0: `functions` entries in a `bp_apply` spec create function graphs (signature, `access`); a name in both `remove_functions` and `functions` is replaced. Without it: ABFC2044 |
| `class_manager_row` (`bp_apply` key, backend 2.5.0) | the row name from `@director`; the backend creates the row asset in the class-manager table of the mod if it is missing, with only the row name and the class reference set (no game-specific values), and updates the class reference otherwise |

## Diagnostics

| Code | Severity | Meaning | Fix |
| --- | --- | --- | --- |
| [ABFC4001](errors.md#abfc4001) | error | the backend reports a protocol below the one abfc needs | update the checkout to the tag named above |
| [ABFC4012](errors.md#abfc4012) | warning | the backend has no `backend_info` tool (an old checkout); abfc uses the two-phase wildcard route, about 10-20 s more per build | update to 2.4.0 or newer |
| [ABFC4014](errors.md#abfc4014) | warning | the server version is older than the minimum (2.4.0); it may miss capabilities abfc uses. Versions that do not parse (for example in test doubles) never warn | check out tag `v2.4.0` or newer |
| [ABFC2044](errors.md#abfc2044) | error | a `Map`, `Set` or struct needs a backend capability that is missing | update the backend, or remove the type |
| [ABFC2071](errors.md#abfc2071) | warning | the backend has no `event_meta`, so an `@event` doc comment is not written as its Blueprint tooltip | update the backend |
| [ABFC2072](errors.md#abfc2072) | warning | the doc comment of an `@event` is longer than 2000 characters; the Blueprint tooltip, category or keywords are cut to 2000 (ending in `...`) | shorten the comment |
| [ABFC2077](errors.md#abfc2077) | warning | the backend cannot write class-manager rows (older than 2.5.0), so the `@director` row is only checked | update to 2.5.0 or newer, or create the row in the Mod Editor |
| [ABFC4015](errors.md#abfc4015) | error | an event that supplies a delegate is neither in this build nor recorded as built | declare the event again or remove its use |

Every code, including the ones not listed here, is explained in [errors.md](errors.md).

## Known fallbacks

- Without `backend_info` (server older than 2.4.0 and old enough to lack the tool), wildcard pins use a two-phase route: apply, patch the rolled-back graph, apply it again as a raw block. Builds work and take longer.
- Function-graph tooltips are not written. Event tooltips are written (`event_meta`); a function's doc comment stays in the TypeScript source and in the stubs' hover text. The engine drops function metadata on import, and Python cannot read compiled function metadata back.
- Function local variables are not supported by the backend; abfc hoists temporaries into members it owns.
- User pure functions are not supported; use impure functions.
- Changing the fields of an existing `UserDefinedStruct` is not supported (ABFC2046); abfc creates new structs and compares existing ones.

### The `catalog` tool

Provided by abf-mod-editor-mcp 2.6.0 or newer (feature flag `catalog`, `capabilities.catalog` in abfc). Read-only: a hidden editor on the staging copy, no asset loads, about 7 seconds. Arguments: `mod` (the mod name) and optional `timeout_seconds` (default 300). Result: `{ok, run, seconds, file, counts, warm}`; `file` is `<run>/catalog.json`.

catalog.json (version 1): `{version, engineVersion, game, scriptClasses, scriptStructs, scriptEnums, counts, errors}`. `game` rows are `{path, kind, parent, interface}` for every `/Game` Blueprint generated class (`path` like `/Game/Dir/BP_X.BP_X_C`); `scriptClasses` rows are `{path, parent}` plus `interface: true` for interfaces and `library: true` with a sorted `functions` name list for Blueprint function libraries; `scriptStructs` and `scriptEnums` are sorted paths; `counts` has `game`, `scriptClasses`, `scriptStructs`, `scriptEnums`, `libraries`, `functions`; `errors` holds up to 200 per-item messages. abfc stores it as `_catalog.json` in the stub profile folder. The tool is on the client allowlist ([ABFC4090](errors.md#abfc4090) otherwise).
