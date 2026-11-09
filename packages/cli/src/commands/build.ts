import { applyPlan, nodeKey, specNodeId } from "@abfc/backend";
import type { AssetApplyOutcome, Backend } from "@abfc/backend";
import {
  assetsNeedingRead,
  fingerprintUnit,
  listManifests,
  lowerChecked,
  mapCompileMessages,
  featureGates,
  planAssetOps,
  planBuild,
  readManifest,
  readSourceMap,
  rebaseStaleUnits,
  writeManifest,
  writeRetired,
  writeSourceMap,
} from "@abfc/compiler";
import type { Manifest, ManifestUnit, SourceMapFile } from "@abfc/compiler";
import { parseExport, sha256, structFieldsHash, t3dNodeKey } from "@abfc/ir";
import type { AssetPlan, Diagnostic, IrAsset, IrModule, IrUnit, Span, T3dNode } from "@abfc/ir";
import { readLock } from "@abfc/stubgen";
import { win32 } from "node:path";
import type { CliContext } from "../context.js";
import { SLOW_BACKEND_HINT } from "../progress.js";
import { readUnitCache, stubLockHashOf, writeUnitCache } from "../unitcache.js";
import { ReadCache, readCacheIdentity } from "../readcache.js";
import type { UnitCache } from "../unitcache.js";
import {
  BackendSession,
  COMPILER_ID,
  Recorder,
  compileFrontend,
  countUnits,
  emitAll,
  hasError,
  lockDiagnostics,
  missingInStage,
  previousNames,
  pruneManifestsToStage,
  readAsset,
  readCacheOf,
  sourceMapOf,
  since,
  useReadCache,
} from "./common.js";
import { refreshTagsFile } from "../tags.js";
import { deleteRetiredRows, runAssetOps, runParentChange } from "./assetops.js";
import { ensureStage } from "./stage.js";
import { ensureStubsForBuild, ensureUsedStubsForBuild } from "./generate.js";

/** True for an @event whose doc comment is its tooltip: the backend only writes it with the bp_apply feature `event_meta`. */
function hasEventTooltip(u: IrUnit): boolean {
  const entry = u.nodes.find((n) => n.sem?.k === "event");
  return entry?.sem?.k === "event" && entry.sem.meta !== undefined;
}

/** Records every unit of the owned assets as built with the current compiler and stub lock (read by the next build). */
function writeCache(ctx: CliContext, owned: IrAsset[], cache: UnitCache, stubLockHash: string, eventMeta: boolean): void {
  const next: UnitCache = { ...cache };
  for (const a of owned) {
    const units: UnitCache[string] = {};
    for (const u of a.units) units[u.id] = { irHash: u.hash, stubLockHash, compilerVersion: COMPILER_ID, ...(hasEventTooltip(u) ? { eventMeta } : {}) };
    next[a.path] = units;
  }
  writeUnitCache(win32.join(ctx.paths.cacheDir, "units.json"), next);
}

/** real node name -> `<unit id>/<IR node id>` */
function invert(nodeIds: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, real] of Object.entries(nodeIds)) out[real] = key;
  return out;
}

/** What maps an apply or compile message back to a call: spec node id -> `<unit id>/<IR node id>`, and the TS spans of calls to owned functions. */
function callMaps(asset: IrAsset): { specIds: Record<string, string>; ownCalls: Record<string, Span[]> } {
  const specIds: Record<string, string> = {};
  const ownCalls: Record<string, Span[]> = {};
  for (const u of asset.units) {
    for (const n of u.nodes) {
      specIds[specNodeId(u, n.id)] ??= nodeKey(u, n.id);
      if (n.sem?.k === "call" && n.sem.class === undefined) (ownCalls[n.sem.function] ??= []).push(n.origin);
    }
  }
  return { specIds, ownCalls };
}

function errorDiagnostics(
  asset: AssetPlan,
  irAsset: IrAsset,
  outcome: AssetApplyOutcome,
): Diagnostic[] {
  const sm = sourceMapOf(irAsset, outcome.nodeIds);
  const { specIds, ownCalls } = callMaps(irAsset);
  return mapCompileMessages(asset.asset, outcome.compile, sm, invert(outcome.nodeIds), specIds, ownCalls);
}

/**
 * The build logic shared by `abfc build`, `abfc test` and `abfc publish`. Returns true when the stage holds the compiled
 * units (or already did) and Unreal compiled them without errors. `readAll` reads every owned asset (the publish gate does this
 * so editor drift in an unchanged asset is found); by default assets with nothing to plan are not read.
 */
export async function runBuild(ctx: CliContext, session: BackendSession, rec: Recorder, opts: { readAll?: boolean } = {}): Promise<boolean> {
  return (await runBuildWithSummary(ctx, session, rec, opts)).ok;
}

/** What a build did, for the summary line. */
export interface BuildSummary {
  ok: boolean;
  upToDate: boolean;
  units: number;
  assets: number;
  unchanged: number;
}

const FAILED_BUILD: BuildSummary = { ok: false, upToDate: false, units: 0, assets: 0, unchanged: 0 };

/** {@link runBuild} that also says how many units and assets were built. */
export async function runBuildWithSummary(
  ctx: CliContext,
  session: BackendSession,
  rec: Recorder,
  opts: { readAll?: boolean } = {},
): Promise<BuildSummary> {
  const t0 = performance.now();
  let ok = false;
  try {
    const summary = await buildInner(ctx, session, rec, opts.readAll === true);
    ok = summary.ok;
    return summary;
  } finally {
    rec.record("build.total", since(t0), ok);
  }
}

async function buildInner(ctx: CliContext, session: BackendSession, rec: Recorder, readAll: boolean): Promise<BuildSummary> {
  const { output, config, env, args, projectDir, paths } = ctx;
  const mod = config.mod.name;
  const profile = env.profile;

  await ensureStubsForBuild(ctx, session, rec);
  if (emitAll(ctx, lockDiagnostics(ctx, "build"))) return FAILED_BUILD;
  const loaded = await ensureUsedStubsForBuild(ctx, session, rec);

  const tFront = performance.now();
  const fe = await ctx.progress.run(
    "Checking TypeScript",
    (s) => {
      const r = compileFrontend(ctx, loaded);
      if (r.ir === null) s.fail("TypeScript has errors");
      return r;
    },
    { done: (r) => `Checked ${countUnits(r.ir!)} unit(s) in ${r.ir!.assets.length} asset(s)` },
  );
  rec.record("build.frontend", since(tFront), fe.ir !== null, fe.ir === null ? 0 : countUnits(fe.ir));
  if (fe.ir === null) return FAILED_BUILD;
  let ir = fe.ir;
  const { backend, info } = await session.open();
  const caps = info.capabilities;
  // A backend without the std_macro node kind gets counter loops instead of For Each Loop / For Loop nodes.
  if (!caps.stdMacros && ir.assets.some((a) => a.units.some((u) => u.nodes.some((n) => n.sem?.k === "std_macro")))) {
    const re = lowerChecked(fe.hir, profile, { loopMacros: false });
    for (const d of re.diagnostics) ctx.output.diag(d);
    if (re.ir === null) return FAILED_BUILD;
    ir = re.ir;
    ctx.output.diag({
      severity: "warning",
      code: "ABFC2088",
      message: "the backend has no bp_apply node kind std_macro: loops are built as counter loops instead of For Each Loop / For Loop nodes; update abf-mod-editor-mcp.",
      fix: "update abf-mod-editor-mcp to the version bundled with this abfc.",
    });
  }
  // Where each asset comes from (recorded in its manifest, docs/design.md 18.2).
  const classByPath = new Map(fe.hir.classes.map((c) => [c.path, c]));
  const sources = new Map<string, NonNullable<Manifest["source"]>>();
  for (const c of [...fe.hir.classes, ...fe.hir.structs]) sources.set(c.path, { file: c.span.file, class: c.name, derived: c.pathDerived });
  // Mod-defined structs (UserDefinedStruct): created from the TS, never read; planned first.
  const structAssets = ir.assets.filter((a) => a.structFields !== undefined);
  /** The manifest of an asset; a tombstone (the asset was deleted by an earlier build) counts as none. */
  const liveManifest = (asset: string): Manifest | null => {
    const m = readManifest(projectDir, asset);
    return m === null || m.deleted === true ? null : m;
  };
  const owned = ir.assets.filter((a) => a.units.length > 0 || a.classDefaults !== undefined || a.classManagerRow !== undefined || a.director !== undefined || a.variables.some((v) => v.temp !== true) || (a.director === undefined && liveManifest(a.path)?.directorRow !== undefined));
  // Feature gates: Map/Set types and creatable kinds the backend (or abfc's native policy) lacks fail here, before the stage is touched.
  if (emitAll(ctx, featureGates({ ...ir, assets: [...structAssets, ...owned] }, caps))) return FAILED_BUILD;

  // Renames of moved classes and deletes of assets abfc created are decided before the stage is touched (ABFC5012 errors stop here).
  const opsPlan = planAssetOps(fe.hir, listManifests(projectDir), mod, { assetOps: caps.assetOps });
  if (emitAll(ctx, opsPlan.diagnostics)) return FAILED_BUILD;

  const tStage = performance.now();
  const { status: stage, resynced, changedInMod } = await ensureStage(backend, env, config, {
    resync: args.flags.resync,
    warn: (d) => output.diag(d),
    progress: ctx.progress,
  });
  // Reads of assets whose stage files (and referenced mod files) are byte-identical to an earlier read come from .abfc/cache/reads,
  // not the editor: after a re-sync that is every asset nobody saved. `--full` (build and publish) reads everything from the editor.
  const fullRead = args.flags.full;
  useReadCache(
    ctx,
    fullRead || stage.stagingPath === ""
      ? null
      : new ReadCache(paths.cacheDir, stage.stagingPath, mod, readCacheIdentity({ server: info.serverVersion, engine: info.engineVersion, ext: info.extensions, caps, stubs: stubLockHashOf(readLock(win32.join(ctx.paths.stubsDir, profile.id))), profile: profile.id })),
  );
  // The assets the Mod Editor saved (their files caused the re-sync): their class defaults are applied again, TypeScript wins.
  const editedInMod = new Set<string>();
  for (const rel of changedInMod) {
    const m = /^Content\/(.+)\.uasset$/i.exec(rel.replace(/\\/g, "/"));
    if (m !== null) editedInMod.add(`/${mod}/${m[1]!}`.toLowerCase());
  }
  // A re-sync no conflict or stale file caused (`--resync`, a missing stage) says nothing about which assets the editor saved: every
  // owned asset counts as saved, so its class defaults are applied again (TypeScript wins). Only the re-sync after changed files
  // keeps the published assets that were not touched.
  if (resynced && changedInMod.length === 0) for (const a of owned) editedInMod.add(a.path.toLowerCase());
  // A stage copied from the mod again holds no unpublished work: the manifests follow before anything is planned from them.
  if (resynced) await pruneManifestsToStage(ctx, backend, mod, { ir, owned });
  rec.record("build.stage", since(tStage));
  // Stage-only operations: renames and deletes (and their repetition after a re-sync) run now, before anything is read or planned.
  const tOps = performance.now();
  const assetOpsOutcome = await runAssetOps(ctx, backend, {
    stagingPath: stage.stagingPath,
    plan: opsPlan,
    classPaths: new Set([...fe.hir.classes, ...fe.hir.structs].map((c) => c.path)),
    owned: new Set(owned.map((a) => a.path)),
    manifests: listManifests(projectDir),
    assetOps: caps.assetOps,
    directorRows: owned.flatMap((a) => (a.director !== undefined ? [a.director.asset] : [])),
  });
  rec.record("build.assetOps", since(tOps), assetOpsOutcome.ok);
  if (!assetOpsOutcome.ok) return FAILED_BUILD;
  const opsJson: { renamed?: Array<{ from: string; to: string }>; deleted?: string[] } = {
    ...(assetOpsOutcome.renamed.length > 0 ? { renamed: assetOpsOutcome.renamed } : {}),
    ...(assetOpsOutcome.deleted.length > 0 ? { deleted: assetOpsOutcome.deleted } : {}),
  };
  // The deletes of assets abfc created run after the referencers' new specs are applied and compiled: a class and the last use of it
  // in TypeScript can go in one build. Nothing is read or planned from an asset that waits for its delete.
  const deferredDeletes = new Set((assetOpsOutcome.deferred ?? []).map((a) => a.toLowerCase()));
  const runDeferredDeletes = async (): Promise<boolean> => {
    if (deferredDeletes.size === 0) return true;
    const tDel = performance.now();
    const done = await runAssetOps(ctx, backend, {
      stagingPath: stage.stagingPath,
      plan: opsPlan,
      classPaths: new Set([...fe.hir.classes, ...fe.hir.structs].map((c) => c.path)),
      owned: new Set(owned.map((a) => a.path)),
      manifests: listManifests(projectDir),
      assetOps: caps.assetOps,
      directorRows: owned.flatMap((a) => (a.director !== undefined ? [a.director.asset] : [])),
      phase: "deletes",
    });
    rec.record("build.assetOps.deletes", since(tDel), done.ok);
    if (!done.ok) return false;
    if (done.deleted.length > 0) opsJson.deleted = [...(opsJson.deleted ?? []), ...done.deleted];
    return true;
  };
  // A class whose TypeScript is gone but whose manifest still lists units: its units are retired like those of a removed event.
  for (const m of listManifests(projectDir)) {
    if (!m.asset.startsWith(`/${mod}/`) || m.units.length === 0 || owned.some((a) => a.path === m.asset) || deferredDeletes.has(m.asset.toLowerCase())) continue;
    owned.push(ir.assets.find((a) => a.path === m.asset) ?? { path: m.asset, variables: [], units: [] });
    if (m.classDefaultsHash !== undefined) {
      output.diag({
        severity: "warning",
        code: "ABFC5010",
        asset: m.asset,
        message: `${m.asset} is no longer declared in TypeScript; its owned units are removed, the class defaults abfc set stay as they are.`,
      });
    }
    // abfc deletes only assets it created: an emptied hand-made asset (or one from a manifest written before `created` existed) stays.
    if (m.created !== true && m.structFieldsHash === undefined) {
      output.diag({
        severity: "warning",
        code: "ABFC5017",
        asset: m.asset,
        message: `${m.asset} was not created by abfc, so it was not deleted; its TypeScript parts were removed. Delete it in the Mod Editor if you no longer need it.`,
        fix: "delete the asset in the Mod Editor if you do not need it; abfc never deletes an asset it did not create.",
      });
    }
  }

  // A struct whose TypeScript is gone stays (Blueprints and saved games that use it would break): reported once, then recorded.
  const declaredStructs = new Set(fe.hir.structs.map((s) => s.path.toLowerCase()));
  for (const m of listManifests(projectDir)) {
    if (m.structFieldsHash === undefined || m.deleted === true || !m.asset.startsWith(`/${mod}/`)) continue;
    if (declaredStructs.has(m.asset.toLowerCase())) {
      // declared again: a later removal is reported again
      if (m.structRetired === true) {
        const { structRetired: _retired, ...rest } = m;
        writeManifest(projectDir, rest);
      }
      continue;
    }
    if (m.structRetired === true) continue;
    output.diag({
      severity: "warning",
      code: "ABFC5018",
      asset: m.asset,
      message: `the @struct ${m.asset} is no longer declared in TypeScript; abfc never deletes a struct (Blueprints and saved games that use it would break). Delete it in the Mod Editor once nothing uses it.`,
      fix: "delete the struct in the Mod Editor when no Blueprint uses it, or declare it in TypeScript again.",
    });
    writeManifest(projectDir, { ...m, structRetired: true });
  }

  // A class whose asset is not in the stage yet is created by the apply: it is not read, its manifest (if any) is ignored, every unit is planned.
  const missing = missingInStage(ctx, stage.stagingPath, [...structAssets, ...owned].filter((a) => a.create !== undefined).map((a) => a.path));

  // Units built with another compiler or stub lock, or whose cached IR hash differs from the current one (an earlier build did not
  // finish: the cache is written last), are re-planned although the manifest's IR hash is equal.
  const stubLockHash = stubLockHashOf(readLock(win32.join(ctx.paths.stubsDir, profile.id)));
  const cache = readUnitCache(win32.join(ctx.paths.cacheDir, "units.json"));
  const forceReplan = new Set<string>();
  const manifests = new Map<string, Manifest | null>();
  // A struct's manifest is read even when the stage lacks the file: its field hash guards against changing a created struct.
  for (const a of structAssets) manifests.set(a.path, liveManifest(a.path));
  for (const a of owned) {
    manifests.set(a.path, missing.has(a.path) ? null : liveManifest(a.path));
    for (const u of a.units) {
      const c = cache[a.path]?.[u.id];
      if (c !== undefined && (c.stubLockHash !== stubLockHash || c.compilerVersion !== COMPILER_ID || c.irHash !== u.hash)) forceReplan.add(`${a.path} ${u.id}`);
      // A documented event built without the tooltip (backend without event_meta) is applied again once the backend can write it.
      else if (c !== undefined && hasEventTooltip(u) && (c.eventMeta ?? false) !== (caps.eventMeta === true)) forceReplan.add(`${a.path} ${u.id}`);
    }
  }

  // Assets that cannot have anything to plan are not read (no drift check there; `abfc status` still reads everything), unless `readAll`.
  const tRead = performance.now();
  const existing = owned.filter((a) => !missing.has(a.path));
  const toRead = readAll || fullRead ? new Set(existing.map((a) => a.path)) : assetsNeedingRead({ ...ir, assets: existing }, { manifests, stage, forceReplan, directorRows: caps.classManagerRows, editedInMod });
  // The asset ops edited the nodes of renamed assets and of their referencers: those are read too, so drifted units are replaced now
  // (editedByAbfc) instead of reading as editor edits in `abfc status` and blaming the modder at the next real change.
  for (const p of assetOpsOutcome.edited ?? []) if (existing.some((a) => a.path === p)) toRead.add(p);
  const readAssets = existing.filter((a) => toRead.has(a.path));
  const skipped = existing.filter((a) => !toRead.has(a.path));
  const snapshots = new Map<string, Map<string, T3dNode>>();
  const snapshotVariables = new Map<string, string[]>();
  const snapshotVariableTypes = new Map<string, Map<string, string>>();
  const snapshotParents = new Map<string, string | null>();
  const keepSnapshot = (path: string, parsed: Awaited<ReturnType<typeof readAsset>>["parsed"]): void => {
    snapshots.set(path, parsed.nodes);
    snapshotVariables.set(path, parsed.variables.map((v) => v.name));
    snapshotVariableTypes.set(path, new Map(parsed.variables.map((v) => [v.name, v.type])));
    snapshotParents.set(path, parsed.parentClass);
  };
  const hitsBefore = readCacheOf(ctx)?.stats.hits ?? 0;
  if (readAssets.length > 0) {
    await ctx.progress.run(
      "Reading owned assets",
      async (s) => {
        for (const [i, a] of readAssets.entries()) {
          keepSnapshot(a.path, (await readAsset(ctx, backend, a.path)).parsed);
          s.tick(i + 1, readAssets.length);
        }
      },
      {
        total: readAssets.length,
        slowHint: SLOW_BACKEND_HINT,
        done: () => {
          const cached = (readCacheOf(ctx)?.stats.hits ?? 0) - hitsBefore;
          return `Read ${readAssets.length} asset(s)${cached > 0 ? ` (${cached} unchanged since an earlier read, from the cache)` : ""}${skipped.length > 0 ? `, ${skipped.length} unchanged not read` : ""}`;
        },
      },
    );
  }

  // A changed `extends`: the same family is reparented on the stage (every unit is applied again), another family recreates the asset
  // (it is planned as missing, its manifest ignored). Assets read here without a recorded parent learn it (backfill).
  const parentRecords = new Set<string>();
  const reparented = new Set<string>();
  for (const a of readAssets) {
    const cls = classByPath.get(a.path);
    const m = manifests.get(a.path) ?? null;
    if (cls === undefined || m === null) continue;
    const res = await runParentChange(ctx, backend, { asset: a.path, manifest: m, snapshotParent: snapshotParents.get(a.path) ?? null, cls, assetOps: caps.assetOps });
    if (emitAll(ctx, res.diagnostics)) return FAILED_BUILD;
    if (res.action === "reparent") {
      keepSnapshot(a.path, (await readAsset(ctx, backend, a.path)).parsed);
      for (const u of a.units) forceReplan.add(`${a.path} ${u.id}`);
      reparented.add(a.path);
      parentRecords.add(a.path);
    } else if (res.action === "recreate") {
      missing.add(a.path);
      manifests.set(a.path, null);
      for (const map of [snapshots, snapshotVariables, snapshotVariableTypes, snapshotParents]) map.delete(a.path);
      toRead.delete(a.path);
    } else if (m.parent === undefined && snapshotParents.get(a.path) !== undefined && snapshotParents.get(a.path) !== null) {
      parentRecords.add(a.path);
    }
  }
  rec.record("build.read", since(tRead), true, readAssets.length);

  // A stage re-synced from a published mod that holds the abfc-built graphs: record the new sync time in the manifests of those units.
  for (const a of readAssets) {
    const m = manifests.get(a.path) ?? null;
    const snap = snapshots.get(a.path);
    if (m === null || snap === undefined) continue;
    const rebased = rebaseStaleUnits(m, snap, stage);
    if (!rebased.changed) continue;
    manifests.set(a.path, rebased.manifest);
    writeManifest(projectDir, rebased.manifest);
  }

  const planIr: IrModule = { ...ir, assets: [...structAssets, ...owned.filter((a) => toRead.has(a.path) || missing.has(a.path))] };
  const planned = planBuild(planIr, {
    protectEditorEdits: config.protectEditorEdits === true && !args.flags.replaceEditorEdits,
    manifests,
    snapshots,
    stage,
    handMadeUnits: new Map(fe.hir.classes.map((c) => [c.path, c.manualUnits])),
    hybrid: new Set(fe.hir.classes.filter((c) => c.hybrid).map((c) => c.path)),
    snapshotVariables,
    snapshotVariableTypes,
    forceReplan,
    editedByAbfc: new Set([...(assetOpsOutcome.edited ?? []), ...reparented]),
    editedInMod,
    selfEventCalls: caps.selfEventCalls,
    missing,
    createKinds: caps.createKinds,
    directorRows: caps.classManagerRows,
    variableDefaults: caps.variableDefaults,
  });
  if (emitAll(ctx, planned.diagnostics)) return FAILED_BUILD;
  for (const a of skipped) for (const u of a.units) planned.upToDate.push(`${a.path} ${u.id}`);
  // A parent change or backfill of an asset the plan does not apply anything to is recorded now (applied assets get it with their final manifest).
  const planAssetPaths = new Set(planned.plan.assets.map((a) => a.asset));
  for (const p of parentRecords) {
    const m = manifests.get(p) ?? null;
    const cls = classByPath.get(p);
    if (m === null || cls === undefined || planAssetPaths.has(p)) continue;
    const next: Manifest = { ...m, parent: cls.parent, parentFamily: cls.family };
    manifests.set(p, next);
    writeManifest(projectDir, next);
  }

  // Manifests of assets this build does not touch still learn where their class lives now (an older manifest has no source yet).
  const refreshSources = (touched: ReadonlySet<string>): void => {
    // An asset this build does not apply keeps its graph, but its TS may have moved (file renamed or moved, lines shifted): the source map's spans follow.
    for (const a of owned) {
      if (touched.has(a.path)) continue;
      const sm = readSourceMap(projectDir, a.path);
      if (sm === null) continue;
      const next = structuredClone(sm);
      for (const u of a.units) {
        const su = next.units[u.id];
        if (su === undefined) continue;
        su.span = u.origin;
        for (const n of u.nodes) {
          const sn = su.nodes[n.id];
          if (sn !== undefined) sn.span = n.origin;
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(sm)) writeSourceMap(projectDir, next);
    }
    for (const [p, m] of manifests) {
      const s = sources.get(p);
      if (m === null || s === undefined || touched.has(p)) continue;
      if (m.source?.file === s.file && m.source.class === s.class && m.source.derived === s.derived) continue;
      writeManifest(projectDir, { ...m, source: s });
    }
  };

  if (planned.plan.assets.length === 0) {
    refreshSources(new Set());
    if (!(await runDeferredDeletes())) return FAILED_BUILD;
    writeCache(ctx, owned, cache, stubLockHash, caps.eventMeta === true);
    output.info(`up to date (${planned.upToDate.length} unit(s) unchanged)`, "ok");
    output.json({ applied: [], upToDate: planned.upToDate, ...opsJson });
    return { ok: true, upToDate: true, units: 0, assets: 0, unchanged: planned.upToDate.length };
  }

  let route: "native" | "fallback" = "native";
  const unitCount = planned.plan.assets.reduce((n, a) => n + a.units.length, 0);
  const applied = await ctx.progress.run(
    `Applying ${unitCount} unit(s) to ${planned.plan.assets.length} asset(s)`,
    (s) =>
      applyPlan(backend, planned.plan, caps, profile, {
        cacheDir: paths.cacheDir,
        record: (step, seconds) => {
          if (step === "apply.phaseA") route = "fallback";
          s.detail(`${step.replace(/^apply\./, "")} pass done`);
          rec.record(step, seconds);
        },
      }).then((r) => {
        if (!r.ok) s.fail("bp_apply failed; the staged copy was rolled back");
        return r;
      }),
    {
      slowHint: SLOW_BACKEND_HINT,
      done: () => (route === "fallback" ? "Applied to the staged copy (two-phase fallback)" : "Applied to the staged copy"),
    },
  );

  const irByPath = new Map(owned.map((a) => [a.path, a]));
  if (!applied.ok) {
    let reported = 0;
    planned.plan.assets.forEach((a, i) => {
      const outcome = applied.perAsset[i];
      const irAsset = irByPath.get(a.asset);
      if (outcome !== undefined && irAsset === undefined && a.struct !== undefined) {
        for (const m of outcome.compile) {
          output.diag({ severity: "error", code: "ABFC4002", asset: a.asset, message: `[backend] ${m.message}` });
          reported++;
        }
        return;
      }
      if (outcome === undefined || irAsset === undefined) return;
      for (const d of errorDiagnostics(a, irAsset, outcome)) {
        output.diag(d);
        reported++;
      }
    });
    if (reported === 0) {
      output.diag({
        severity: "error",
        code: "ABFC4002",
        message: "bp_apply failed and reported no compile message; the stage was rolled back.",
        fix: "run abfc build --verbose, or check the run folder named in the backend log.",
      });
    }
    return FAILED_BUILD;
  }

  // Success: record the manifest and the source map of every touched asset. The manifest keeps what is on the stage (nodes, hashes)
  // but takes the IR hash of the applied units and the class defaults hash only after Unreal's compile passed: until then the
  // applied units count as changed, so a failed compile is repeated (and reported) by the next build instead of passing as up to date.
  const finals: Manifest[] = [];
  const badOverrides: Diagnostic[] = [];
  const stagedUnits: string[] = [];
  const appliedAssets: string[] = [];
  const createdStructs: string[] = [];
  const removedUnits: string[] = [];
  let removedOrphanTags = 0;
  const retireRows: Array<{ asset: string; row: string; lost: boolean }> = [];
  // Gameplay tags the defaults pass added to the stage's tag list (backend 2.6.0); they reach the mod with `abfc publish`.
  const tagsAdded = applied.tagsAdded ?? [];
  for (const t of tagsAdded) output.info(`gameplay tag ${t}: added to the mod's tag list (published with abfc publish)`);
  // The constants of .abfc/tags.d.ts follow: the stored game list, the mod's own ini, and the tags that live only in the stage until publish.
  if (tagsAdded.length > 0) refreshTagsFile(ctx, tagsAdded);
  for (let i = 0; i < planned.plan.assets.length; i++) {
    const a = planned.plan.assets[i]!;
    const outcome = applied.perAsset[i]!;
    if (a.struct !== undefined) {
      // The struct exists in the stage now (the backend compiled it): record the field hash that guards later changes.
      writeManifest(projectDir, { asset: a.asset, compiler: COMPILER_ID, profile: profile.id, units: [], variables: [], structFieldsHash: structFieldsHash(a.struct.fields), ...(sources.has(a.asset) ? { source: sources.get(a.asset)! } : {}) });
      createdStructs.push(a.asset.slice(a.asset.lastIndexOf("/") + 1));
      continue;
    }
    const irAsset = irByPath.get(a.asset)!;
    if (outcome.tagWarning) output.diag(outcome.tagWarning);
    for (const d of outcome.defaultsWarnings) output.diag(d);
    const nodes = parseExport(outcome.finalText ?? (await readAsset(ctx, backend, a.asset)).text).nodes;
    // An @override must come out as an override event. An event Unreal could not resolve while the backend templated it (a backend
    // without the Blueprint-class override fix templates against an Actor scratch) is turned into a custom event named like the
    // parent's function (GunStartFiring_1): it compiles clean but is never called, so the parent's code keeps running.
    for (const p of a.units) {
      if (p.unit.kind !== "override") continue;
      const entry = p.unit.nodes.find((n) => n.sem?.k === "override");
      const real = entry === undefined ? undefined : outcome.nodeIds[nodeKey(p.unit, entry.id)];
      const node = real === undefined ? undefined : nodes.get(t3dNodeKey(p.unit.graph, real));
      if (node === undefined || node.head.includes("bOverrideFunction=True")) continue;
      const custom = node.head.map((h) => /^CustomFunctionName="([^"]+)"/.exec(h)?.[1]).find((x) => x !== undefined);
      badOverrides.push({
        severity: "error",
        code: "ABFC6003",
        asset: a.asset,
        span: p.unit.origin,
        message: `@override ${p.unit.name} did not become an override event in ${a.asset.slice(a.asset.lastIndexOf("/") + 1)}${custom !== undefined ? `: Unreal made it the custom event ${custom}` : ""}, so the parent's ${p.unit.name} would still run and this code never would.`,
        fix: "apply backend-override-blueprint-events.patch to abf-mod-editor-mcp (an event declared in a Blueprint class, such as a game weapon's GunStartFiring, needs it) and build again; until then call a custom @event from a hand-made override.",
      });
    }

    const old = manifests.get(a.asset) ?? null;
    // Units that left the TS are gone from the stage now (or were never there): drop them from the manifest. This is not held back
    // until Unreal's compile passes: a failed compile does not roll the removal back, and a manifest that still listed the removed
    // nodes would make the next build report them as missing (ABFC5002).
    const dropIds = new Set([...(a.removeUnits ?? []).map((r) => r.id), ...(a.forgetUnits ?? [])]);
    for (const r of a.removeUnits ?? []) removedUnits.push(r.id.slice(r.id.indexOf(":") + 1));
    // The stubs still list a removed event as a hand-made member: hide it until `abfc generate` reads the stage again.
    // Only units whose nodes were really deleted: a forgotten unit (never applied, or adopted hand-made nodes) left them on the stage.
    const retired = (a.removeUnits ?? []).map((r) => r.id);
    writeRetired(win32.join(paths.stubsDir, profile.id), a.asset, retired);
    for (const r of a.removeTags ?? []) removedOrphanTags += r.nodes.length;
    const units: ManifestUnit[] = (old?.units ?? []).filter((u) => !dropIds.has(u.id));
    for (const p of a.units) {
      const nodeIds: Record<string, string> = {};
      for (const n of p.unit.nodes) {
        const real = outcome.nodeIds[nodeKey(p.unit, n.id)];
        if (real !== undefined) nodeIds[n.id] = real;
      }
      const names = Object.values(nodeIds).map((real) => t3dNodeKey(p.unit.graph, real));
      const fp = fingerprintUnit(nodes, names);
      const next: ManifestUnit = {
        id: p.unit.id,
        graph: p.unit.graph,
        irHash: p.unit.hash,
        assetHash: fp.assetHash,
        nodes: names,
        nodeIds,
        tag: outcome.tagNames[p.unit.id] ?? null,
        stageSyncedAt: stage.syncedAt,
        adopt: units.find((u) => u.id === p.unit.id)?.adopt ?? null,
        nodeHashes: fp.nodeHashes,
        links: fp.links,
      };
      const at = units.findIndex((u) => u.id === p.unit.id);
      if (at >= 0) units[at] = next;
      else units.push(next);
      stagedUnits.push(`${p.unit.name}`);
    }
    // TS wins: variables removed from the asset (and own fields gone from the TS) leave the manifest too.
    const goneVars = new Set([...(a.removeVariables ?? []), ...(a.forgetVariables ?? [])]);
    const variables = (old?.variables ?? []).filter((v) => !goneVars.has(v.name));
    for (const v of a.variables) {
      const entry = { name: v.name, type: v.type, hash: sha256(`${v.name}:${v.type}:${v.flags.join(",")}`), ...(v.default !== undefined ? { default: v.default } : {}) };
      const at = variables.findIndex((x) => x.name === v.name);
      if (at >= 0) variables[at] = entry;
      else variables.push(entry);
    }
    // A changed or dropped default of a variable that stays in the asset (the backend applied `variable_defaults`).
    for (const [name, def] of Object.entries(a.variableDefaults ?? {})) {
      const at = variables.findIndex((x) => x.name === name);
      if (at < 0) continue;
      const { default: _old, ...rest } = variables[at]!;
      variables[at] = def === null ? rest : { ...rest, default: def };
    }
    // Class defaults: the hash is recorded only when pass 5 succeeded, so a failed pass is repeated by the next build.
    const defaultsDone = a.defaults !== undefined && outcome.defaultsApplied;
    const classDefaultsHash = defaultsDone ? a.defaults!.hash : old?.classDefaultsHash;
    const classDefaultsStageSyncedAt = defaultsDone ? stage.syncedAt : old?.classDefaultsStageSyncedAt;
    // The class-manager row the backend wrote for `@director` (recorded with the defaults hash, only after pass 5 succeeded).
    // A class that no longer has a `@director` drops the record once the pass ran (the row asset itself stays in the mod).
    const lostDirector = defaultsDone && a.defaults!.director === undefined && old?.directorRow !== undefined;
    const directorRow = defaultsDone && outcome.directorRow !== undefined ? outcome.directorRow.asset : lostDirector ? undefined : old?.directorRow;
    if (defaultsDone && outcome.directorRow !== undefined && (outcome.directorRow.created || outcome.directorRow.changed)) {
      output.info(`class-manager row ${outcome.directorRow.asset}: ${outcome.directorRow.created ? "created" : "updated"}`);
    }
    // The row of the old `@director` (changed row name, or no `@director` any more): deleted from the stage below when the backend can.
    const changedRow = defaultsDone && outcome.directorRow !== undefined && old?.directorRow !== undefined && old.directorRow.toLowerCase() !== outcome.directorRow.asset.toLowerCase();
    if (changedRow || lostDirector) retireRows.push({ asset: a.asset, row: old!.directorRow!, lost: lostDirector });
    const appliedIds = new Set(a.units.map((p) => p.unit.id));
    // Removed from the stage, not published yet: `abfc publish` lists the asset until a publish clears this.
    const retiredUnpublished = [...new Set([...(old?.retiredUnpublished ?? []), ...retired])].sort();
    const source = sources.get(a.asset) ?? old?.source;
    // abfc created the asset (the apply creates it now, or an earlier build did); the class it was built from gives the parent.
    const created = old?.created === true || a.create !== undefined;
    const cls = classByPath.get(a.asset);
    /** Pending stage-only renames/deletes survive the rewrite until a publish clears them. */
    // A recreated asset (another family) or one the stage lost is planned without its manifest (`old` is null), but the paths the
    // mod still holds from an earlier rename or move are read from disk: a publish deletes them.
    const pending = old ?? readManifest(projectDir, a.asset);
    const carried = {
      ...(pending?.renamedFrom !== undefined ? { renamedFrom: pending.renamedFrom } : {}),
      ...(pending?.publishAlso !== undefined ? { publishAlso: pending.publishAlso } : {}),
      ...(pending?.retiredRows !== undefined ? { retiredRows: pending.retiredRows } : {}),
    };
    const finalManifest: Manifest = {
      asset: a.asset,
      compiler: COMPILER_ID,
      profile: profile.id,
      units,
      variables,
      ...(classDefaultsHash !== undefined ? { classDefaultsHash } : {}),
      ...(classDefaultsStageSyncedAt !== undefined ? { classDefaultsStageSyncedAt } : {}),
      // Kept only when this build planned no defaults pass; a planned pass that did not succeed clears it (the next build must apply the defaults).
      ...(a.defaults === undefined && old?.classDefaultsPublished === true ? { classDefaultsPublished: true as const } : {}),
      ...(directorRow !== undefined ? { directorRow } : {}),
      ...(retiredUnpublished.length > 0 ? { retiredUnpublished } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(created ? { created } : {}),
      ...(cls !== undefined ? { parent: cls.parent, parentFamily: cls.family } : {}),
      ...carried,
    };
    finals.push(finalManifest);
    writeManifest(projectDir, {
      asset: a.asset,
      compiler: COMPILER_ID,
      profile: profile.id,
      variables,
      units: units.map((u) => (appliedIds.has(u.id) ? { ...u, irHash: "" } : u)),
      ...(old?.classDefaultsHash !== undefined ? { classDefaultsHash: old.classDefaultsHash } : {}),
      ...(old?.classDefaultsStageSyncedAt !== undefined ? { classDefaultsStageSyncedAt: old.classDefaultsStageSyncedAt } : {}),
      ...(old?.directorRow !== undefined ? { directorRow: old.directorRow } : {}),
      ...(retiredUnpublished.length > 0 ? { retiredUnpublished } : {}),
      ...(source !== undefined ? { source } : {}),
      // the new parent is recorded only after Unreal's compile passed (the finals below); a failed compile re-syncs the stage to the old one
      ...(old?.created === true ? { created: true } : {}),
      ...(old?.parent !== undefined ? { parent: old.parent } : {}),
      ...(old?.parentFamily !== undefined ? { parentFamily: old.parentFamily } : {}),
      ...carried,
    });
    writeSourceMap(projectDir, sourceMapOf(irAsset, { ...previousNames(old), ...outcome.nodeIds }));
    appliedAssets.push(a.asset);
  }

  // Unreal's own compile of the changed assets.
  const tCompile = performance.now();
  // A struct was compiled by the backend when it was created; a build that only created structs has nothing else to compile.
  type CompileReport = Awaited<ReturnType<typeof backend.compile>>;
  const compileClean = (r: CompileReport): boolean => r.clean || !r.messages.some((m) => m.severity === "error");
  const report: CompileReport =
    appliedAssets.length > 0
      ? await ctx.progress.run(
          `Compiling ${appliedAssets.length} asset(s) in Unreal`,
          async (s) => {
            const r = await backend.compile(mod, appliedAssets);
            if (!compileClean(r)) s.fail("Unreal compile reported errors");
            return r;
          },
          {
            slowHint: SLOW_BACKEND_HINT,
            done: (r) => {
              const w = r.messages.filter((m) => m.severity === "warning").length;
              return w > 0 ? `Unreal compile clean (${w} warning(s))` : "Unreal compile clean";
            },
          },
        )
      : ({ clean: true, messages: [] } as unknown as CompileReport);
  for (const d of badOverrides) output.diag(d);
  // A lost override fails the build like a compile error: the stage is re-synced so the stray custom event is not published.
  const compileOk = compileClean(report) && badOverrides.length === 0;
  rec.record("build.compile", since(tCompile), compileOk);
  if (!compileOk) {
    for (const asset of appliedAssets) {
      const sm = readSourceMap(projectDir, asset);
      if (sm === null) continue;
      const messages = report.messages.filter((m) => m.severity === "error");
      const names: Record<string, string> = {};
      for (const [unitId, u] of Object.entries(sm.units)) {
        for (const [irId, n] of Object.entries(u.nodes)) if (n.real !== null) names[n.real] = `${unitId}/${irId}`;
      }
      const irAsset = ir.assets.find((a) => a.path === asset);
      const { specIds, ownCalls } = irAsset ? callMaps(irAsset) : { specIds: {}, ownCalls: {} };
      for (const d of mapCompileMessages(asset, messages, sm, names, specIds, ownCalls)) output.diag(d);
    }
    if (!hasError(output.diagnostics)) {
      output.diag({ severity: "error", code: "ABFC6002", message: "[Unreal] the compile report lists errors that could not be mapped." });
    }
    // The stage now holds graphs Unreal could not compile. Re-sync it from the mod so a later build starts from a clean copy
    // (the next build applies the units again, as it does after `--resync`).
    let stageResynced = false;
    if (!args.flags.keepFailedStage && env.modDir.value !== null) {
      const tR = performance.now();
      try {
        await backend.stage(env.modDir.value, { discardChanges: true });
        stageResynced = true;
        await pruneManifestsToStage(ctx, backend, mod, { base: manifests, appliedAssets, ir, owned });
        // The re-synced stage may hold class defaults the editor saved: an asset whose defaults pass was planned here is not "published" any more.
        for (const pa of planned.plan.assets) {
          if (pa.defaults === undefined) continue;
          const m = readManifest(projectDir, pa.asset);
          if (m !== null && m.classDefaultsPublished === true) {
            const { classDefaultsPublished: _p, ...rest } = m;
            writeManifest(projectDir, rest);
          }
        }
        output.info("the stage was re-synced from the mod: all unpublished changes in the staged copy were discarded; the next build applies the units again (--keep-failed-stage keeps them for inspection)");
      } catch (e) {
        output.diag({
          severity: "warning",
          code: "ABFC4016",
          message: `the stage could not be re-synced after the failed compile: ${e instanceof Error ? e.message : String(e)}`,
          fix: "run abfc build --resync before the next build.",
        });
      }
      rec.record("build.resync", since(tR), stageResynced);
    } else if (args.flags.keepFailedStage) {
      output.info("the stage keeps the graphs that failed to compile (--keep-failed-stage); abfc build --resync discards them");
    }
    output.json({ applied: [], compileFailed: true, stageResynced, ...opsJson });
    return FAILED_BUILD;
  }
  if (retireRows.length > 0) {
    // A row another class still uses is never deleted.
    const stillUsed = (row: string, asset: string): boolean =>
      finals.some((f) => f.asset !== asset && f.directorRow?.toLowerCase() === row.toLowerCase()) ||
      [...manifests.values()].some((m) => m !== null && m.asset !== asset && !finals.some((f) => f.asset === m.asset) && m.directorRow?.toLowerCase() === row.toLowerCase());
    const todo = retireRows.filter((r) => !stillUsed(r.row, r.asset));
    const deletedRows = await deleteRetiredRows(ctx, backend, caps.assetOps, todo.map((r) => r.row));
    for (const rr of todo) {
      const f = finals.find((x) => x.asset === rr.asset);
      if (deletedRows && f !== undefined) {
        f.retiredRows = [...new Set([...(f.retiredRows ?? []), rr.row])].sort();
        output.info(`deleted ${rr.row} (the class-manager row of ${rr.asset}; the file leaves the mod with abfc publish)`);
      } else {
        output.diag({
          severity: "warning",
          code: "ABFC5013",
          asset: rr.asset,
          message: rr.lost
            ? `the class has no @director any more; its class-manager row ${rr.row} stays in the mod; delete it in the Mod Editor`
            : `the previous class-manager row ${rr.row} stays in the mod; delete it in the Mod Editor`,
        });
      }
    }
  }
  for (const m of finals) writeManifest(projectDir, m);
  refreshSources(new Set(planned.plan.assets.map((a) => a.asset)));
  if (!(await runDeferredDeletes())) {
    output.json({ applied: stagedUnits, assets: appliedAssets, deleteFailed: true, ...opsJson });
    return FAILED_BUILD;
  }
  for (const m of report.messages) if (m.severity === "warning" && args.flags.verbose) output.info(`[Unreal warning] ${m.message}`, "warn");

  writeCache(ctx, owned, cache, stubLockHash, caps.eventMeta === true);
  output.info(`applied ${stagedUnits.length > 0 ? stagedUnits.join(", ") : "no units"} in ${appliedAssets.join(", ")} (route: ${route})${createdStructs.length > 0 ? `, created struct ${createdStructs.join(", ")}` : ""}${removedUnits.length > 0 ? `, removed ${removedUnits.join(", ")}` : ""}${removedOrphanTags > 0 ? `, removed ${removedOrphanTags} orphan tag comment(s)` : ""}`, "ok");
  output.json({ applied: stagedUnits, assets: appliedAssets, ...(createdStructs.length > 0 ? { structs: createdStructs } : {}), route, upToDate: planned.upToDate, ...(removedUnits.length > 0 ? { removed: removedUnits } : {}), ...(removedOrphanTags > 0 ? { removedOrphanTags } : {}), ...opsJson });
  return { ok: true, upToDate: false, units: stagedUnits.length, assets: appliedAssets.length, unchanged: planned.upToDate.length };
}

/** `abfc build`. */
export async function build(ctx: CliContext): Promise<number> {
  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  try {
    const s = await runBuildWithSummary(ctx, session, rec, { readAll: ctx.args.flags.drift });
    if (s.ok && s.upToDate) ctx.progress.summary(true, "Nothing to build", `${s.unchanged} unit(s) unchanged`);
    else if (s.ok) ctx.progress.summary(true, "Built", `${s.units} unit(s) in ${s.assets} asset(s)`);
    else ctx.progress.summary(false, "Build failed", "see the errors above");
  } finally {
    await session.close();
    rec.print();
  }
  return ctx.output.exitCode();
}
