# Configuration

abfc reads two JSON files and a set of environment variables and flags.

- The **project config**, `abf.config.json`, sits in the project folder and is committed. It says which mod the project builds and which stubs to generate.
- The **user config**, `%APPDATA%\abfc\config.json`, belongs to one machine and is never committed. It holds paths that differ from PC to PC: where the Mod Editor, the mods folder and (for a source install) the backend are.

`abfc init` writes both; you rarely edit them by hand. `abfc doctor` prints every setting, the value in use and which source it came from.

## Project config: `abf.config.json`

Schema 2. A JSON schema ships with the VS Code extension, so the editor completes and checks the keys.

| Key | Type, default | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer, absent means 1 | `2` today. A higher number is [ABFC1022](errors.md#abfc1022): the file was written by a newer abfc. |
| `mod.name` | string, required | Folder name of the mod: `<mods folder>\<name>\<name>.uplugin`. Letters, digits and `_` only. |
| `sourceRoot` | string, `"src"` | Project-relative folder with the class files. Asset paths derive from the folders below it. A relative path, `/` or `\`, no `..`. |
| `classManager.table` | string, `"DataTables/DT_ClassManager"` | Mod-relative folder and name of the class-manager table that `@director` rows go into. |
| `stubs.classes` | string array, `[]` | Optional extras. Every `/Game` class and every engine name your source imports gets stubs automatically; list a path here only to force it (for example a class no source imports yet). |
| `stubs.scriptClasses` | string array, `[]` | Optional extras: `/Script/Module.Class` paths to generate stubs for. The profile's default engine classes are always generated; `abfc init` writes an empty list. |
| `stubs.modAssets` | `"all"` or a list | `"all"` stubs every Blueprint of the mod. A list holds mod-relative paths such as `"Relays/BP_Example"`. A leading `/` is [ABFC1021](errors.md#abfc1021). |
| `stubs.classOnly` | list | Mod-relative Blueprints stubbed as their class and parent only, without own members. Each is read once and then kept when its files change, so a room bake that re-saves it costs `abfc generate` nothing. Use it for Blueprints the TypeScript only spawns or names, or uses only through inherited members. An entry need not also be in `modAssets`. `generate --full` reads them again, and so does the first `generate` after an entry moves back to `modAssets`. An asset abfc builds into warns [ABFC3016](errors.md#abfc3016). |
| `stubs.widgetMembers` | object | Deprecated. Members are found by `abfc generate`; entries that reflection finds warn [ABFC3015](errors.md#abfc3015), others are still emitted (class path, then member name, then widget class path). |
| `stubs.scriptModules` | ignored | Deprecated; use `stubs.scriptClasses` ([ABFC3010](errors.md#abfc3010)). |
| `backend.kind` | `"bp_apply"` | The only supported backend. |
| `backend.minProtocol` | integer, `1` | Lowest backend protocol the project needs. |

Machine keys are read from the project config but discouraged there, and `abfc doctor` warns ([ABFC1021](errors.md#abfc1021)): `editor.root`, `modsDir`, `mod.dir`, `headlessDir`, `backend.serverDir`, `backend.python`. Put them in the user config.

Unknown keys are ignored. A file that is not valid UTF-8 JSON, or has a wrong type, stops with [ABFC1021](errors.md#abfc1021) and the path of the key.

### Upgrading from schema 1

Every config written before 1.0 is schema 1. It still loads in every command, with the warning [ABFC1031](errors.md#abfc1031). The upgrade happens only in `abfc init`, run in the project folder:

- the old file is saved once as `abf.config.json.v1.bak` (an existing backup is not overwritten);
- `schemaVersion` becomes `2` and the `stubs.modAssets` entries become mod-relative (`/ExampleMod/Relays/BP_X` becomes `Relays/BP_X`);
- the machine keys `editor.root`, `modsDir`, `backend.serverDir` and `backend.python` may move to the user config. They move only with your consent (or `--yes`), and only when a user config path exists on this machine; otherwise they stay. `mod.dir` and `headlessDir` always stay in the project config.

Your TypeScript files are never rewritten. The warnings and quick fixes of `abfc check` and the editor lead you through the new asset-path rules.

## User config: `%APPDATA%\abfc\config.json`

Same format as the project config with every key optional. What counts are the machine keys:

| Key | Meaning |
| --- | --- |
| `schemaVersion` | `2`, written by `abfc init`. |
| `editor.root` | Folder of the Mod Editor installation. |
| `modsDir` | The folder that holds your mods. |
| `mod.dir` | A specific mod folder. `abfc init` never writes it. |
| `backend.serverDir` | Backend checkout, for a source install. |
| `backend.python` | Python executable, for a source install. |
| `headlessDir` | Folder for the backend's headless runs; must not contain a space ([ABFC1012](errors.md#abfc1012)). |

`abfc init` merges into an existing file. Keys it does not know and the order of keys are kept, a `config.json.bak` is written before an overwrite, and a key is written only when it is missing, was given as a flag, or was chosen in the prompt. Set `ABFC_USER_CONFIG` to use another file, for example for a portable setup or a test.

## Precedence

Each setting is resolved on its own, and the first source that has a valid value wins:

**command-line flag, then environment variable, then project config, then user config, then auto-discovery.**

An environment variable therefore beats anything `abfc init` wrote, and a project value beats the user config. There is no merging of values within a setting.

| Setting | Flag | Environment variable | Config key | Auto-discovery |
| --- | --- | --- | --- | --- |
| Mod Editor folder | `--editor-root` | `ABFC_EDITOR_ROOT`, then `ABF_EDITOR_ROOT` | `editor.root` | The Epic launcher's manifests, then `Program Files\Epic Games\AbioticFactorModEdit*`. |
| Mods folder | `--mods-dir` | `ABFC_MODS_DIR` | `modsDir` | `<Documents>\Abiotic Factor Mods`, with Documents taken from Windows' Known Folder (so OneDrive and moved Documents work). |
| Mod folder | `--mod-dir` | `ABFC_MOD_DIR` | `mod.dir` | `<mods folder>\<mod.name>`, which must hold `<mod.name>.uplugin`. |
| Backend folder | `--backend-dir` | `ABFC_BACKEND_DIR` | `backend.serverDir` | `abfc.exe`: the bundled backend in the runtime folder. Source install: none, it must be given. |
| Python | `--python` | `ABFC_PYTHON` | `backend.python` | `abfc.exe`: the bundled Python. Source install: the `py -3` launcher, then `python` on `PATH` (3.9 or newer). |
| Headless folder | `--headless-dir` | `ABF_HEADLESS_DIR` | `headlessDir` | The backend's default, `%LOCALAPPDATA%\abf-mod-editor-mcp\headless`. |

`ABF_EDITOR_ROOT` and `ABF_HEADLESS_DIR` are the backend's own variable names; abfc understands and passes them through.

## Other environment variables

| Variable | Meaning |
| --- | --- |
| `ABFC_USER_CONFIG` | Path of the user config file instead of `%APPDATA%\abfc\config.json`. |
| `ABFC_RUNTIME_DIR` | Root folder into which `abfc.exe` unpacks its backend and Python instead of `%LOCALAPPDATA%\abfc\runtime`. |

abfc itself reads no other variables. When it starts the backend it sets `ABF_ABFC_TOOLS=1` (and `ABF_WARM_SESSION=1` for warm sessions) for that child process only; you do not set those. See [backend.md](backend.md).

## Where things go

| What | Where |
| --- | --- |
| Project settings | `abf.config.json` in the project folder (committed) |
| Machine settings | `%APPDATA%\abfc\config.json` or `ABFC_USER_CONFIG` |
| Unpacked runtime of `abfc.exe` | `%LOCALAPPDATA%\abfc\runtime` or `ABFC_RUNTIME_DIR` |
| Stubs, caches, reports | `.abfc\` in the project folder (ignored by git, except `.abfc\manifest\`) |

The install, update and uninstall steps are in [install.md](install.md).
