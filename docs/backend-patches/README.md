# Local patches to the backend

abfc talks to EmekC's [abf-mod-editor-mcp](https://github.com/EmekC/abf-mod-editor-mcp) (see [../backend.md](../backend.md)). These patches add features abfc uses that the upstream backend does not have yet. They are kept here so they are versioned with the abfc code that needs them; each one is plain `git diff` output against the backend repository.

Every patch is optional. abfc checks the backend's tool list and `backend_info`, and without a patch it falls back to the old behaviour (usually with a warning).

## Apply order

All eight apply cleanly, in this order, on upstream commit `4e77497`:

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

## Applying

In the backend checkout (for example `C:\abfc\abf-mod-editor-mcp`), with no abfc command running:

```
git apply --check <path>\backend-staging-refresh.patch
git apply <path>\backend-staging-refresh.patch
```

Run `--check` first; it changes nothing. A patch that is already applied fails `--check`; `git apply --reverse --check <patch>` succeeding confirms that. The next abfc command starts the patched server.
