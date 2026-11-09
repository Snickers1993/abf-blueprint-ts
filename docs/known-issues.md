# Known issues

This page records what users ran into while abfc was hardened against real projects, what changed, and what is still limited. Every entry has a status:

- **Fixed**: the problem is gone. All fixes here landed before 1.0.0, so no released version has the problem.
- **Limitation**: abfc behaves this way on purpose or cannot do better yet. The entry says how to work with it.
- **Open**: a known gap that is not decided or not fixed yet.

Several fixes need backend 2.6.0 (the backend bundled in `abfc.exe`, or `abf-mod-editor-mcp` tag `v2.6.0` in a source install). With an older backend (2.4.0 or newer) abfc still works and prints a clear code where a feature is missing; `abfc doctor` lists what is missing (ABFC4018). See [backend.md](backend.md).

Error codes link to [errors.md](errors.md). For step-by-step help see [troubleshooting.md](troubleshooting.md).

## Fixed before 1.0.0

### The eight reported problems

#### P1. `@event ReceiveBeginPlay` on a method that overrides a parent event

- **What users hit:** a method with `@event` and the same name as an event of the parent class (`ReceiveBeginPlay`, `ReceiveTick`) built, and Unreal then refused it with ABFC6001 ("a custom event cannot share a native member name").
- **What changed:** abfc reports error ABFC2078 at the decorator before anything is built. The editor quick fix "Use @override" replaces the decorator, adds the `override` modifier and the import.
- **How to use it now:** write `@override` for the parent's events and `@event` only for new custom events.

#### P2. A changed `extends` was ignored

- **What users hit:** changing the parent class in TypeScript did nothing to the existing Blueprint asset.
- **What changed:** with backend 2.6.0 the asset is reparented when the old and new parent are in the same family (Actor, ActorComponent, UserWidget, other objects), and created again when the family changes. The build prints `reparented ...` or `recreating ...`. A recreate of an asset that abfc did not create is refused with ABFC2048 (it would delete hand-made content). With an older backend a parent change is error ABFC2048.
- **How to use it now:** change `extends` and build.

#### P3. The ABFC5002 loop after a stage re-sync

- **What users hit:** after `--resync` (or an automatic re-sync) every build reported the same missing units (ABFC5002) and nothing could be built.
- **What changed:** every re-sync (explicit, automatic, after a failed compile) now prunes abfc's records to what the stage really holds, so the loop cannot start.
- **How to use it now:** nothing; `abfc build --resync` is safe.

#### P4. Editor edits blocked the build ("TS wins")

- **What users hit:** after saving a Blueprint in the Mod Editor, `abfc build` and `abfc publish` refused with ABFC5001 to ABFC5004 or ABFC4020 and pointed to `abfc adopt` or `--resync`.
- **What changed:** build and publish never refuse because of editor edits. What the TypeScript owns is replaced, and one warning ABFC5014 per asset lists what was replaced or removed. If the mod changed outside abfc, the stage is re-synced by itself (warning ABFC4017). For a class that is not hybrid, the whole Blueprint is owned: hand-made nodes in event graphs, hand-made function graphs and hand-made variables are removed. Kept always: components, the widget tree and designer widgets, macros, event dispatchers, disabled default event nodes. A hybrid class (one that merges `interface X extends X_Manual`) keeps its hand-made members. `abfc status` shows the same situations as warnings (ABFC5001 to ABFC5004) so you can preview them. `abfc adopt` still works but prints ABFC5015 (not needed).
- **How to use it now:** the TypeScript is the source of truth. Do designer work (widgets, components, layout) in the editor, and write logic in TypeScript. If you want hand-made nodes to stay, make the class hybrid (see [first-mod.md](first-mod.md)).

#### P5. Director gameplay tags

- **What users hit:** a new `@director` row was written without a gameplay tag, so the director never started.
- **What changed:** `@director("Row", ClassManager.EntityDirector.X)` (or a string tag) sets the row's tag. A tag that does not exist yet is added to the mod's `Config/Tags/<Mod>Tags.ini` and published with the mod. All known tags autocomplete through the generated `.abfc/tags.d.ts`. A director must be an ActorComponent (ABFC2089 otherwise). Related diagnostics: ABFC2079 (no tag), ABFC2080 (bad tag), ABFC2081 (not under `ClassManager.EntityDirector.`), ABFC2082 (backend too old), ABFC2089 (not an ActorComponent).
- **How to use it now:** give every new director a tag. With backend 2.6.0 `abfc publish` registers the mod's new tags in the open Mod Editor before it reloads the row, so nothing needs a restart. If the editor cannot take them, ABFC7015 names the tags and says to restart it (see Limitations).

#### P6. Engine functions needed every optional argument

- **What users hit:** `KismetSystemLibrary.PrintString("hi")` failed to type-check because the stub demanded all parameters.
- **What changed:** parameters with an engine default are optional in the generated stubs (`InString?: string`, marked `@bpDefault`). An omitted argument sets no pin, so the node keeps the default Unreal itself fills in, exactly as when you place the node in the editor. A short curated list covers common functions whose engine default is not readable (for example `GetPlayerCharacter()`, and the sweep, teleport and teleport-physics booleans of the actor move and rotate functions). A default found by the backend always wins over the curated one.
- **How to use it now:** run `abfc generate` once with backend 2.6.0, then leave out arguments you do not need (`PrintString("hi")`, `Delay()`, `GetPlayerCharacter()`).

#### P7. No completion in the editor

- **What users hit:** the language server offered no abfc completions.
- **What changed:** `abfc lsp` completes library functions (inserting `Container.Function` and the import) and, in a class body, `@override` stubs for the parent's events. VS Code gets them through the existing extension. See [language-service.md](language-service.md).
- **How to use it now:** type the start of a function or event name. A wrong extra offer is harmless; Unreal's compile reports it as ABFC6001 at the TypeScript line.

#### P8. Renames, moves, deletes and reparenting needed hand work

- **What users hit:** moving a file or renaming a class was ABFC5012 (an error), deleting a class left its asset in the mod, and a published mod never lost files.
- **What changed:** with backend 2.6.0 abfc renames, moves, deletes and reparents assets itself (Unreal's own rename, references fixed up, done on the stage; nothing reaches the mod before publish). `abfc publish` deletes files that were removed (`deleted <file>` in the output, backed up first). Only assets abfc created are deleted; others are left and you get ABFC5017. ABFC5012 remains for the ambiguous case and for an old backend. Operations go to the backend in chunks of 20; if a later chunk fails (ABFC5016), the earlier ones are kept and the message says how many.
- **How to use it now:** move files and rename classes freely, then build and publish.

### Findings from the live scenarios

These were found by running abfc against a real mod through the Mod Editor, with the fixes and a regression test for each.

- **A new class that uses another new class failed (ABFC6002).** The classes were applied in file-name order, so the user could come before the class it uses. Now the new classes are applied in dependency order. Two new classes that use each other in a cycle keep their order and may need two builds (see Limitations).
- **Renaming a referenced class tripped ABFC2047.** The retype check compared against a stale record. Fixed: a field whose type already matches the stage is not a retype.
- **Renaming a class and its file in the same edit was not recognised as a rename** (delete and create, then ABFC5016 because the old asset was still referenced). Now one removed and one new class in the same folder with the same parent is treated as a rename (see the heuristic under Limitations).
- **After a file move the source map still named the old file.** Fixed; the diagnostics point at the new file.
- **Reparenting failed with a backend read error** (`parent_class` is not readable from Python). The backend now reads the parent from the asset registry and checks the result.
- **A spurious ABFC5014 after a rename or reparent.** The warning blamed you for abfc's own reference fixes. The planner now replaces those units without the warning. A rename or reparent that edits an asset's nodes with nothing else to apply no longer leaves editor-edit drift behind either.
- **Recreating a moved class forgot the old path, so publish did not delete it.** Fixed; the old path to delete is carried over.
- **A publish that only deleted files was reported as failed (ABFC7006).** Fixed; a deletion-only publish is a success.
- **Deleting a class together with the last TypeScript use of it in one build failed (ABFC5016).** Fixed: deletes run after the apply and the Unreal compile, in the same build.
- **A stale stage after the editor saved an asset the stage had not touched.** The next build did not notice. The backend now reports such files, and the build re-syncs (ABFC4017).
- **Class defaults were applied again after every re-sync** (needless republish and editor reload). The manifest now records that the defaults were published. A re-sync caused by the editor saving that very asset, an explicit `--resync`, or a failed-compile re-sync does apply them again (TypeScript wins), at the cost of one extra publish of that asset.
- **The ABFC4017 message printed the backend's conflict objects as raw JSON.** Now it names the files.
- **A Blueprint variable retyped in the Mod Editor** (for example after you renamed a class there) made the next build fail with ABFC6001. The variable is recreated from the TypeScript type, with warning ABFC5014.
- **Overriding the Construction Script (`UserConstructionScript`) as an event** failed in Unreal. It is now error ABFC2083 at the method.
- **Changing the type of an own field** is no longer an error: the variable is recreated, all units of the asset are applied again, and you get warning ABFC2047 (values set on placed instances are reset).
- **Own fields can have a literal initializer** (`Speed: float = 2.5`): it becomes the variable's default, and changing or removing it updates the default in place. Backends without the `variable_defaults` feature get ABFC2084 (see Limitations).
- **A row, tag or director that was renamed or removed** retires the old class-manager row and the build deletes it; the published mod loses the row file. Tags abfc added stay (see Limitations).
- **Duplicate class names in different folders** are separate assets; deleting one before it was ever published never touches the other.
- **A struct whose TypeScript is gone** stayed silently. It now warns once (ABFC5018) and stays (see Limitations).
- **The ABFC2046 text** (changing the fields of an existing struct) now says that the old struct stays and how to get out (rename the struct).
- **A mod name in another letter case** (`mod.name` differs from the plugin file) is normalised to the plugin's spelling, with warning ABFC1045 (visible in every command).
- **Director tag invalid after publish with the editor open.** The row showed "Invalid Tags that have been removed" in the Mod Editor and the director did not start in Play In Editor. The open editor reads gameplay tags only when it starts, and the publish reloaded the row before the editor knew the new tag; saving the row there then removed the tag from the row file. Now the backend registers the mod's tags in the open editor before it reloads the row (ABFC7015 only when that fails), and a director row that the Mod Editor saved gets its tag again at the next build. A director that extends Actor never starts even with a valid tag; abfc now warns (ABFC2089).
- **A second abfc run in the same project** at the same time could fail on a staged file or corrupt nothing but report a confusing backend error. Build, test, publish, status, stubs and adopt now take a project lock; a second run is ABFC4019. A lock of a dead process, an old one or an unreadable one is replaced.
- **A hidden file copy was still in use (WinError 32)** during an apply: the backend now waits up to 60 seconds and, if the file is still held, names the holder. See Limitations.
- **Engine defaults that live under the parameter name** (not `CPP_Default_`) were not found. The backend now follows Unreal's own lookup; a few common move and player functions have curated zero defaults.
- **Intermediate stub graphs** created by Unreal are never swept as hand-made.
- **A rename to many classes at once** (a folder moved with 21 classes) works: operations are sent in chunks of 20.
- **A source root change** (`sourceRoot`) that keeps the folder structure changes no asset path; a deeper root renames every class in one build.
- **`abfc init`** on an existing project changes nothing that exists (everything is `kept`), and a project copied without `.abfc` is repaired by `abfc generate`.
- **A project without its generated folders** (a clone with `.abfc/cache`, stubs and `tags.d.ts` missing) now says `abfc generate` is needed (ABFC3003).
- **`abfc test` and renames** work together: a renamed class and its test file build and pass, the harness is never published.

## Limitations

These are known and documented; work around them as described.

### Mod Editor and publish

- **The open Mod Editor keeps listing deleted assets until it is restarted.** After a publish deleted assets (or a class or row was renamed), the editor's asset registry still shows them, even though their files are gone. Restart the Mod Editor; nothing needs to be cleaned up. abfc does not unload packages in your editor (risk of a crash).
- **New gameplay tags need an editor restart only when registration fails** (ABFC7015, which names the tags). Do not save the director row there before restarting. Tags that abfc registered live can drop out of the open editor again after a tag-settings refresh in the editor itself (Project Settings > GameplayTags changes); the next `abfc publish` registers them again, and a restart always loads them.
- **Play In Editor.** `abfc build` works while Play In Editor runs, but `abfc publish` is refused (ABFC7005) until you stop it. abfc never stops it or clicks in the editor.
- **Publish with unsaved changes** in the open Mod Editor is refused (ABFC7005) and names the assets. Save or revert them, then publish again; the next build re-syncs and applies the TypeScript on top.
- **"Staged file still in use" (WinError 32).** A virus scanner, the search indexer, a leftover hidden editor or a second tool using the same mod can hold a staged file for a moment. The backend waits up to 60 seconds and names the holder in the message ("nothing was changed; wait a moment and run the command again"). If it still fails, run the same command again. It was seen right after `abfc generate` and when two abfc runs overlapped (now ABFC4019).

### Deleting and renaming

- **Structs are never deleted.** Blueprints and saved games may use them. If a struct's TypeScript is gone, abfc warns once (ABFC5018) and leaves it. Delete it in the Mod Editor when nothing uses it.
- **Struct field changes are not supported (ABFC2046).** The error appears after the struct exists. Declare a new struct under a new name (rename the class and file, for example `F_Data` to `F_Data2`) and change the users; then delete the old one in the editor.
- **abfc deletes only what it created.** A hand-made asset, or one that abfc took over from the editor, is not deleted when its class disappears; its TypeScript parts are removed and you get ABFC5017. A copy you renamed in the editor stays too.
- **Tags that abfc added are never removed**, even when no director uses them any more. The tag list is shared mod content. Remove unused tags from `Config/Tags/<Mod>Tags.ini` yourself, and restart the editor.
- **A removed struct, array, text or class initializer keeps its last value.** These field defaults are written to the class defaults, and a build only writes the values the TypeScript still has. To clear one, write the empty value (`[]`, `""`, a zeroed struct) instead of deleting the initializer, or reset the variable in the Mod Editor.
- **Components and interfaces are only added.** Removing `component(...)` or an `interfaces` entry from the TypeScript leaves it on the Blueprint; remove it in the Mod Editor.
- **Rename heuristic (tier 3).** If one class disappeared and one new class appeared in the same folder with the same parent, and neither the name nor the file matches, abfc treats it as a rename (`renamed A -> B (reason)`). If two classes are involved on either side, or the folder or parent differs, it never guesses and does a delete plus create. If it paired two classes you meant to be separate, set `path: "<path below the mod>"` in `@blueprint` on one of them.
- **Deleting a class works together with removing its uses** in the same build (this was fixed; earlier it needed two builds). A hand-made Blueprint that still references the deleted asset makes the delete fail with ABFC5016; the changes of that build stay on the stage. Remove the reference in the editor, or keep the class.
- **Cycles between two new classes.** When two classes that do not exist yet use each other, the order is the file order and the first build may fail with ABFC6002. Build again; the second build succeeds.

### TypeScript language

- **TypeScript enums are not supported.** A Blueprint enum has no TypeScript equivalent here; a bare `enum` compiles as plain TypeScript but cannot be a field or event parameter type. Use a string-literal union or an enum from the engine stubs.
- **Template literals** become a Format Text node; where a string is expected (for example `PrintString`) or in a `const` without a type annotation, abfc adds To String (Text); `const t: text = ...` stays Format Text. Numbers are formatted as Format Text formats them (culture rules), not as JavaScript does. A template literal cannot be a `name` (ABFC2099); convert a string with `KismetStringLibrary.Conv_StringToName`.
- **Functions (undecorated methods) are impure and have no locals.** They have exec pins (no pure functions, no getters or setters). Their temporaries are member variables, so recursion is an error (ABFC2085). A function needs a backend with the `function_graphs` feature (ABFC2044).
- **A function graph is recreated whole.** Any change to the method replaces the entire graph, so edits made by hand inside it in the Mod Editor are lost (ABFC5014). The callers in the same class are applied again; callers in other Blueprints are not: when you change the signature of a function that another class calls through `other.fn(...)`, change something in that class's calling code as well (the call sites are then built again).
- **Own field initializers** accept literals of the field type only (number, boolean, string, name, enum text). Struct, object, array and text defaults are set in the editor.
- **ABFC2084 repeats on every build** on a backend without the `variable_defaults` feature, as long as an initializer of an existing field is changed. Update the backend (`abfc doctor` shows `variable defaults: yes`).

### Editor edits and drift

- **"TS wins" replaces editor edits.** Nodes, functions and variables you add by hand to an owned Blueprint are removed at the next build (ABFC5014 lists them), unless the class is hybrid. Components, widget layout and designer widgets are kept.
- **Drift on unchanged assets is replaced only by `abfc build --drift`** (or by the next build that changes that class). A plain build does not read assets it has nothing to do for. `abfc status` shows the drift (ABFC5001, ABFC5002) and says which command replaces it.
- **A real editor edit in the same build as a rename or reparent of that asset** is replaced without the ABFC5014 line, because abfc cannot tell its own reference fix from your edit. The TypeScript still wins.
- **Hand-made variables and a non-empty widget tree** could not be created through the editor's Python in the live checks, so those sweeps are covered by fake-backend tests only. In use they behave as described under P4.
- **Class defaults edited by hand** in the Mod Editor (and saved) are applied from the TypeScript again at the next build; keep defaults in `@blueprint` options.
- **`_Manual` hand-made member lists** in the stubs are not refreshed by a build after the sweep removed a member. Run `abfc generate` to refresh them.
- **Takeover after a lost manifest** (`.abfc/manifest` deleted or from another machine): the next build re-applies every unit, republishes all assets once, and prints ABFC5014 for the hand-made events it replaced. An override's old event node counts as hand-made until you run `abfc build --drift` once. The message `created struct` can appear for a struct that already existed.
- **`--resync` re-applies class defaults** of every owned asset (one extra publish of those assets), because a re-synced stage holds the editor's version.
- **A touch-save in the Mod Editor** of a class with class defaults makes the next publish include that asset once.

### Stubs

- **Stubs from a backend without `supers` skip Blueprint parents (ABFC3013).** Members declared on a parent Blueprint are missing from the stub of a class that inherits from it; the class extends its nearest native ancestor instead. Update the backend (a version whose `reflect` reports `supers`) and run `abfc generate`. A class that fails to load stays a members-less placeholder in the chain (ABFC3013 names it).

- **Member discovery needs the backend's member pass (ABFC3014).** Widgets, components and widget/component variables of game Blueprints are found from the widget tree, the SCS templates and the class package's cooked name map; native classes' component and widget properties (a character's mesh or movement component) come from the class's Python documentation. The cooked reader needs the editor's uncompressed, unencrypted IoStore content; otherwise `cookedClass` is missing and the warning appears. Members that none of these sources names are still missing, and only single object references are recovered (arrays and other types are listed by the class defaults anyway).

- **Native members found from the Python docstring can differ in case from the C++ name.** They are named by converting snake_case to PascalCase, so acronyms come out differently (`Hud` for `HUD`). They still resolve in the engine because FNames ignore case.

- **Discovery keeps only widget, component and timeline-typed members.** Other members that GetClassDefaults does not list are deliberately dropped. Timelines are emitted as readonly components.

- **Numbered variables are found only up to `_9`.** Cooked containers that are signed, encrypted, multi-partition or older than TOC version 4 are skipped; the reason is reported in `errors`.

### Engine defaults

- **Optional parameters come from engine metadata.** Functions whose default is not stored as metadata keep their parameters required, except the short curated list. If an argument you expect to be optional is required, pass it explicitly.

## Open

- **A real two-client Play In Editor check** and some node-level editor edits (variable creation, widget trees) cannot be driven from outside the editor, so they are not covered by live runs.
- **`abfc publish --full`** (the stage audit) still stops at the Epic login window (ABFC7002); see [troubleshooting.md](troubleshooting.md). The default `abfc publish` is not affected.
- **Repeating ABFC2084** on an old backend: a marker in the manifest to stop the repeat is not built; update the backend instead.
- **Struct field changes and TypeScript enums** are not planned for 1.0.0.
