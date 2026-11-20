# Local patches to the backend

abfc talks to EmekC's [abf-mod-editor-mcp](https://github.com/EmekC/abf-mod-editor-mcp) (see [../backend.md](../backend.md)). These patches add features abfc uses (or that make the editor side safer) that the upstream backend does not have yet. They are kept here so they are versioned with the abfc code that needs them; each one is plain `git diff` output against the backend repository.

Every patch is optional. abfc checks the backend's tool list and `backend_info`, and without a patch it falls back to the old behaviour (usually with a warning).

## Apply order

All sixteen apply cleanly, in this order, on upstream commit `4e77497`:

| # | Patch | What it adds |
| --- | --- | --- |
| 1 | `backend-game-test-until.patch` | `bp_game_test` `until` steps (repeat a probe until an assert holds), `below`/`above` asserts, a longer map load timeout. Used by `t.waitUntil` |
| 2 | `backend-override-blueprint-events.patch` | `@override` of an event a Blueprint class declares (for example a game weapon's `GunStartFiring`): templated in a scratch child of that class, so it is not turned into a custom event |
| 3 | `backend-override-function-graphs.patch` | `@override` of a parent function with outputs as a function graph whose entry and result name the parent |
| 4 | `backend-preload-asset-pin-defaults.patch` | an asset as a pin default (`Class'/Mod/Dir/X.X'`) is loaded first, so the pin is not left empty |
| 5 | `backend-interfaces-components.patch` | interfaces added also without function graphs, never twice; interface events get their pins |
| 6 | `backend-override-access.patch` | an override entry carries the parent function's access specifier, else the editor refuses the compile |
| 7 | `backend-override-no-access-bits.patch` | refines 6: without an explicit access the override entry has no access bits and inherits the parent's |
| 8 | `backend-staging-refresh.patch` | tool `staging_refresh`: copies only the files the real mod changed into the stage and keeps the rest (no full re-sync when only files abfc does not build were saved) |
| 9 | `backend-staging-refresh-take-mod.patch` | `staging_refresh` gains `take_mod`: a conflict listed there (an owned Blueprint saved in the Mod Editor while the stage changed it too) takes the real file instead of refusing the refresh |
| 10 | `backend-raw-memory-guards.patch` | crash guard for the editor-side raw memory scans: a number that only looks like a pointer is checked with `VirtualQuery` before it is read (an unchecked read is an access violation that kills the editor), and the array-offset probes use a second count to rule out stray matches |
| 11 | `backend-warm-reload-changed-only.patch` | the warm editor reloads, before each job, only the mod packages whose files changed since it last matched them (plus what references them and anything modified in memory), instead of every loaded package: reads had grown from 25 s to 100 s each as more packages were loaded and re-saved sounds rebuilt their audio data on every reload |
| 12 | `backend-warm-reload-after-blueprint-jobs.patch` | refines 11: after a job that changes Blueprints (apply, compile, asset ops) only plain data (sounds, meshes, textures, materials) keeps its match; Blueprints, levels and tables are reloaded by the next job, because a compile can change them in memory without marking them modified |
| 13 | `backend-live-publish-instance-guard.patch` | a live publish refuses (before anything is unloaded) when more than 300 actors of the published classes are in the open level (`ABF_LIVE_PUBLISH_MAX_INSTANCES` changes it, 0 switches it off): one publish of 41 classes with about 1,140 preview actors crashed the editor |
| 14 | `backend-staging-new-real-files.patch` | `staging_status` lists a file that is new in the real mod (a Blueprint made and saved in the Mod Editor) as stale, so `staging_refresh` copies it; before, it reached the stage only with a full `staging_sync` |
| 15 | `backend-no-zen-autolaunch.patch` | every headless commandlet, `-game` test run, warm session and hidden windowed instance starts with `-NoZenAutoLaunch`: a hidden windowed run with its own `LOCALAPPDATA` installed and launched a second zenserver on the default port 8558, King's shared Zen derived-data store was recreated, and the mod's meshes stopped drawing in Play until the store was rebuilt. With it, those runs still use the zenserver that is already running (the editor's own), so they do not have a separate store |
| 16 | `backend-live-publish-guard-v2.patch` | refines 13 after a second live publish crash (20 Nov, 3 classes, one of them reloaded live earlier in the same session): the instance count reads the editor world's own actor list (the level-actor list missed tool-spawned preview actors) and counts actors of child classes and of the loaded referencers the publish reloads too; a publish whose classes still have an old copy in memory from an earlier reload in this session (`TRASHCLASS_`/`REINST_` class, `_DEADPACKAGE` package) is refused; the server writes each live step (`prepared`, `copied`, `reload start`, `reload done` or `reload failed`) to `publish-steps.jsonl` in the publish's backup folder, so a crash leaves a record of the step it was in. `ABF_LIVE_PUBLISH_MAX_INSTANCES=0` switches both checks off |

## Applying

In the backend checkout (for example `C:\abfc\abf-mod-editor-mcp`), with no abfc command running:

```
git apply --check <path>\backend-staging-refresh.patch
git apply <path>\backend-staging-refresh.patch
```

Run `--check` first; it changes nothing. A patch that is already applied fails `--check`; `git apply --reverse --check <patch>` succeeding confirms that. The next abfc command starts the patched server.
