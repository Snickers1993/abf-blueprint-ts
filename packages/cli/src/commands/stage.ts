import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Backend, StageStatus } from "@abfc/backend";
import { listManifests } from "@abfc/compiler";
import { AbfcError } from "@abfc/env";
import type { Environment, ProjectConfig } from "@abfc/env";
import type { Diagnostic } from "@abfc/ir";
import { SLOW_BACKEND_HINT } from "../progress.js";
import type { Progress } from "../progress.js";

/**
 * The packages (lowercase) a refresh treats specially: `owned`, the Blueprints abfc builds (taken from the real mod one by one, the
 * TypeScript applied on top again); `never`, the other packages abfc builds (structs, deleted assets, old paths of renames), whose
 * change needs the full re-sync. `ownedBlueprints` and `structs` are the asset paths of this build's IR, when there is one.
 */
export function refreshSets(
  projectDir: string,
  pendingFile: string,
  ownedBlueprints: Iterable<string> = [],
  structs: Iterable<string> = [],
): { never: Set<string>; owned: Set<string>; pendingFile: string } {
  const owned = new Set([...ownedBlueprints].map((a) => a.toLowerCase()));
  const never = new Set([...structs].map((a) => a.toLowerCase()));
  for (const m of listManifests(projectDir)) {
    const a = m.asset.toLowerCase();
    if (m.structFieldsHash !== undefined || m.deleted === true) never.add(a);
    else owned.add(a);
    if (m.renamedFrom !== undefined) never.add(m.renamedFrom.toLowerCase());
  }
  for (const a of never) owned.delete(a);
  return { never, owned, pendingFile };
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
     * On a backend with `staging_refresh`: copy only what the real mod changed instead of re-syncing the whole stage. `never`: the
     * packages (lowercase) whose change needs the full re-sync (assets abfc builds that cannot be redone one by one: structs, old
     * paths of renames). `owned`: the owned Blueprints the stage may take from the real mod one by one, also on a conflict (the
     * caller prunes their manifests and applies the TypeScript on top again). Any other file is copied as it is. `pendingFile` keeps
     * the files copied this way until a build has applied the TypeScript on top ({@link clearRefreshPending}), so a failed build or
     * an `abfc generate` in between does not lose them. `note` says what was copied.
     */
    refresh?: { never: ReadonlySet<string>; owned: ReadonlySet<string>; pendingFile: string };
    note?: (line: string) => void;
  },
): Promise<StageResult> {
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
  const pending = o.refresh !== undefined ? readPending(o.refresh.pendingFile) : { files: [], owned: [] };
  const body = async (): Promise<StageResult> => {
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
      } else if (refreshable(status)) {
        // Only files the stage can take one by one changed (a room bake, a material saved, a mesh reimported, an owned Blueprint the
        // Mod Editor saved): copy just those into the stage. Everything else stays as it was, unpublished work included.
        const r = await tryRefresh(status);
        if (r !== null) {
          status = r.status;
          const files = [...r.copied, ...r.removed];
          const owned = files.map(packageOf).filter((p): p is string => p !== null && o.refresh!.owned.has(p));
          const all = { files: union(pending.files, files), owned: union(pending.owned, owned) };
          writePending(o.refresh!.pendingFile, all);
          const n = files.length;
          o.note?.(
            `the Mod Editor saved ${n} file(s) (${listed}): copied ${n} file(s) into the staged copy, the rest is kept (no re-sync)` +
              (owned.length > 0 ? `; the TypeScript is applied on top of ${owned.length} owned asset(s) again` : ""),
          );
          return { status, resynced: false, changedInMod: all.files, refreshed: files, refreshedOwned: all.owned };
        }
        ({ status, resynced, editedInMod } = await fullResync(changedInMod, listed));
      } else {
        ({ status, resynced, editedInMod } = await fullResync(changedInMod, listed));
      }
    }
    if (o.refresh !== undefined && !(resynced && editedInMod.length === 0)) {
      // Files an earlier refresh copied whose TypeScript no build has applied on top yet. A re-sync for no file (`--resync`, a new
      // stage) already counts every owned asset as edited.
      editedInMod = union(editedInMod, pending.files);
      if (resynced) writePending(o.refresh.pendingFile, { files: [], owned: [] });
      else if (pending.owned.length > 0) return { status, resynced, changedInMod: editedInMod, refreshedOwned: pending.owned };
    }
    return { status, resynced, changedInMod: editedInMod };
  };

  /** Whether every changed file can be taken one by one: none needs the full re-sync, and every conflict is an owned Blueprint. */
  const refreshable = (status: StageStatus): boolean => {
    if (o.refresh === undefined || backend.refreshStage === undefined) return false;
    const pkgs = [...status.conflicts, ...status.stale].map(packageOf);
    if (pkgs.some((p) => p !== null && o.refresh!.never.has(p))) return false;
    return status.conflicts.every((rel) => {
      const p = packageOf(rel);
      return p !== null && o.refresh!.owned.has(p);
    });
  };
  /** staging_refresh, taking the real file of each conflict; null when the backend refused (an older patch refuses every conflict). */
  const tryRefresh = async (status: StageStatus): Promise<{ status: StageStatus; copied: string[]; removed: string[] } | null> => {
    let r: { copied: string[]; removed: string[] };
    try {
      r = await backend.refreshStage!(mod, status.conflicts);
    } catch (e) {
      o.note?.(`staging_refresh refused (${e instanceof Error ? e.message : String(e)}); copying the whole mod again`);
      return null;
    }
    const fresh = await backend.stageStatus(mod);
    if (fresh === null) throw new AbfcError({ severity: "error", code: "ABFC4002", message: `staging_refresh for ${mod} finished but staging_status reports no stage.` });
    if (fresh.conflicts.length > 0 || fresh.stale.length > 0) return null; // something saved meanwhile: the full re-sync settles it
    return { status: fresh, ...r };
  };
  const fullResync = async (changedInMod: string[], listed: string): Promise<{ status: StageStatus; resynced: boolean; editedInMod: string[] }> => {
    // The stage only holds abfc's own work, which the same build regenerates from the TypeScript: copy the mod again and go on.
    const status = await stageFrom(true);
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
    return { status, resynced: true, editedInMod: changedInMod };
  };
  return (
    o.progress?.run(o.resync ? `Re-syncing staged copy of ${mod}` : `Checking staged copy of ${mod}`, body, {
      slowHint: SLOW_BACKEND_HINT,
      done: (r) => `Staged copy ready (${r.status.changed.length} changed, ${r.status.added.length} added)`,
    }) ?? body()
  );
}

/** What {@link ensureStage} did. `refreshedOwned`: owned Blueprints (lowercase) taken from the real mod without a re-sync, whose
 * manifests the caller prunes to the stage before planning. */
export interface StageResult {
  status: StageStatus;
  resynced: boolean;
  changedInMod: string[];
  refreshed?: string[];
  refreshedOwned?: string[];
}

interface Pending {
  files: string[];
  owned: string[];
}

function readPending(file: string): Pending {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<Pending>;
    return { files: Array.isArray(j.files) ? j.files.map(String) : [], owned: Array.isArray(j.owned) ? j.owned.map(String) : [] };
  } catch {
    return { files: [], owned: [] };
  }
}

function writePending(file: string, p: Pending): void {
  if (p.files.length === 0 && p.owned.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(p, null, 2) + "\n", "utf8");
}

/** A build applied the TypeScript on top of every refreshed file: they are no longer pending. */
export function clearRefreshPending(file: string): void {
  rmSync(file, { force: true });
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}
