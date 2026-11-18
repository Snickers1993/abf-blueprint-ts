import type { Backend, StageStatus } from "@abfc/backend";
import { listManifests } from "@abfc/compiler";
import { AbfcError } from "@abfc/env";
import type { Environment, ProjectConfig } from "@abfc/env";
import type { Diagnostic } from "@abfc/ir";
import { SLOW_BACKEND_HINT } from "../progress.js";
import type { Progress } from "../progress.js";

/** The packages (lowercase) whose files changing in the mod need the full re-sync: every asset of a manifest and its old name, plus `extra`. */
export function abfcPackages(projectDir: string, extra: Iterable<string> = []): Set<string> {
  const out = new Set([...extra].map((a) => a.toLowerCase()));
  for (const m of listManifests(projectDir)) {
    out.add(m.asset.toLowerCase());
    if (m.renamedFrom !== undefined) out.add(m.renamedFrom.toLowerCase());
  }
  return out;
}

/**
 * Makes sure the mod has a staged copy and returns its status. `resync` discards the stage and copies the real mod again;
 * otherwise an existing stage is kept (its edits are the work in progress). A stage that conflicts with the real mod (the mod
 * changed outside abfc since the sync, for example saved in the Mod Editor) is copied again automatically (warning ABFC4017
 * through `warn`): the stage only holds abfc's own work, which the build regenerates from the TypeScript. With
 * `onConflict: "report"` (abfc status) nothing is discarded; the conflict is reported as warning ABFC4020. `resynced` is true
 * when the stage was copied from the mod in this call (`resync`, a conflict, or no stage existed): the caller prunes the
 * manifests to what the stage holds ({@link pruneManifestsToStage}), because unpublished work is gone.
 */
export async function ensureStage(
  backend: Backend,
  env: Environment,
  config: ProjectConfig,
  o: {
    resync: boolean;
    onConflict?: "resync" | "report";
    warn?: (d: Diagnostic) => void;
    progress?: Progress | undefined;
    /**
     * The assets abfc builds (lowercase package paths). When the real mod changed only files the stage never touched and none of
     * them belongs to one of these, a backend with `staging_refresh` copies just those files and the stage keeps everything else
     * (no ABFC4017, nothing to prune or read again); `note` says what it copied.
     */
    refreshUnless?: ReadonlySet<string>;
    note?: (line: string) => void;
  },
): Promise<{ status: StageStatus; resynced: boolean; changedInMod: string[]; refreshed?: string[] }> {
  const mod = config.mod.name;
  const modDir = env.modDir.value;
  const stageFrom = async (discardChanges: boolean): Promise<StageStatus> => {
    if (modDir === null) {
      throw new AbfcError({
        severity: "error",
        code: "ABFC1004",
        message: `mod folder of ${mod} not found; the stage cannot be created.`,
        fix: "run abfc doctor, or pass --mod-dir.",
      });
    }
    await backend.stage(modDir, { discardChanges });
    const status = await backend.stageStatus(mod);
    if (status === null) {
      throw new AbfcError({
        severity: "error",
        code: "ABFC4002",
        message: `staging_sync for ${mod} finished but staging_status reports no stage.`,
      });
    }
    return status;
  };

  /** The package of a staged file (`Content/Rooms/BP_X.uasset` -> `/<mod>/rooms/bp_x`, lowercase), null outside Content. */
  const packageOf = (rel: string): string | null => {
    const m = /^Content\/(.+)\.[^./]+$/i.exec(rel.replace(/\\/g, "/"));
    return m === null ? null : `/${mod}/${m[1]!}`.toLowerCase();
  };
  const body = async (): Promise<{ status: StageStatus; resynced: boolean; changedInMod: string[]; refreshed?: string[] }> => {
    let status: StageStatus | null;
    let resynced = false;
    if (o.resync) {
      status = await stageFrom(true);
      resynced = true;
    } else {
      status = await backend.stageStatus(mod);
      if (status === null) {
        status = await stageFrom(false);
        resynced = true;
      }
    }
    // Conflicts (edited in the stage and in the mod) and stale files (untouched in the stage, saved or deleted in the mod): either way
    // the stage no longer shows the real mod.
    const changedInMod = [...status.conflicts, ...status.stale];
    // The files whose change caused the automatic re-sync below (the caller re-applies the class defaults of those assets: the editor saved them).
    let editedInMod: string[] = [];
    if (changedInMod.length > 0) {
      const listed = changedInMod.slice(0, 10).join(", ") + (changedInMod.length > 10 ? `, and ${changedInMod.length - 10} more` : "");
      if (o.onConflict === "report") {
        // Read-only commands (abfc status) never discard the stage: they only say what the next build will do.
        o.warn?.({
          severity: "warning",
          code: "ABFC4020",
          message: `the real mod ${mod} changed since the staged copy was made (${listed}); the next abfc build copies the mod again and applies the TypeScript on top (TypeScript wins).`,
        });
      } else if (
        o.refreshUnless !== undefined &&
        backend.refreshStage !== undefined &&
        status.conflicts.length === 0 &&
        !status.stale.some((rel) => {
          const pkg = packageOf(rel);
          return pkg !== null && o.refreshUnless!.has(pkg);
        })
      ) {
        // Only files nothing of abfc's lives in changed (a room bake, a material saved, a mesh reimported): copy just those into the
        // stage. Everything else stays as it was, unpublished work included, so nothing is pruned or read again.
        const r = await backend.refreshStage(mod);
        const fresh = await backend.stageStatus(mod);
        if (fresh === null) throw new AbfcError({ severity: "error", code: "ABFC4002", message: `staging_refresh for ${mod} finished but staging_status reports no stage.` });
        status = fresh;
        const n = r.copied.length + r.removed.length;
        o.note?.(`the Mod Editor saved ${n} file(s) abfc does not build (${listed}): copied ${n} file(s) into the staged copy, the rest is kept (no re-sync)`);
        return { status, resynced: false, changedInMod: [], refreshed: [...r.copied, ...r.removed] };
      } else {
        // The stage only holds abfc's own work, which the same build regenerates from the TypeScript: copy the mod again and go on.
        status = await stageFrom(true);
        resynced = true;
        editedInMod = changedInMod;
        if (status.conflicts.length > 0) {
          throw new AbfcError({
            severity: "error",
            code: "ABFC4020",
            message: `the staged copy of ${mod} still conflicts with the real mod after it was copied again: ${status.conflicts.slice(0, 10).join(", ")}.`,
            fix: "close programs that write to the mod folder (for example the Mod Editor saving), then run the command again.",
          });
        }
        o.warn?.({
          severity: "warning",
          code: "ABFC4017",
          message: `the real mod ${mod} changed since the staged copy was made (${listed}); the staged copy was replaced by the current mod and the TypeScript is applied on top again (unpublished staged work is regenerated by this build).`,
        });
      }
    }
    return { status, resynced, changedInMod: editedInMod };
  };
  return (
    o.progress?.run(o.resync ? `Re-syncing staged copy of ${mod}` : `Checking staged copy of ${mod}`, body, {
      slowHint: SLOW_BACKEND_HINT,
      done: (r) => `Staged copy ready (${r.status.changed.length} changed, ${r.status.added.length} added)`,
    }) ?? body()
  );
}
