import { grantPublish } from "@abfc/backend";
import type { Backend, PublishResult, StageStatus } from "@abfc/backend";
import {
  blockedMemberHits,
  deleteManifest,
  deleteSourceMap,
  listManifests,
  loadProgram,
  readManifest,
  snapshotPublishedManifests,
  writeManifest,
} from "@abfc/compiler";
import type { Diagnostic } from "@abfc/ir";
import { win32 } from "node:path";
import type { CliContext } from "../context.js";
import { dropUnitCacheAsset } from "../unitcache.js";
import { uploadFileDiagnostics, walkFolder } from "../gate/uploadcheck.js";
import { BackendSession, Recorder, compileFrontend, emitAll, lockDiagnostics, since } from "./common.js";
import { runBuild } from "./build.js";
import { runCheck } from "./check.js";
import { runTests } from "./test.js";
import { SLOW_BACKEND_HINT } from "../progress.js";

/** Files below the helper folders of the headless route are never part of a publish. */
const isHelperFile = (f: string): boolean => /(^|[\\/])(_McpTest|_McpTmp)([\\/]|$)/.test(f);

/** A file below `Content/` of the mod folder. */
const isContentFile = (f: string): boolean => /^Content[\\/]/i.test(f);

/** A tag list of the mod: `Config/Tags/<Mod>Tags.ini` (the only config file abfc changes on the stage). */
const isTagIni = (f: string): boolean => /^Config[\\/]Tags[\\/][^\\/]+\.ini$/i.test(f);

/** `Content/Relay/BP_Relay.uasset` -> `relay/bp_relay` (lower case, no extension, no `Content/`). */
const contentKey = (f: string): string =>
  f
    .replaceAll("\\", "/")
    .replace(/^Content\//i, "")
    .replace(/\.[^./]+$/, "")
    .toLowerCase();

/** The backend's reason of an audit that did not pass (first text field it reports, else a cut of its JSON). */
function auditReason(raw: unknown): string {
  if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of ["error", "reason", "message", "detail", "note"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
  }
  const s = JSON.stringify(raw) ?? "";
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
}

/**
 * `abfc publish [--full] [--dry-run]`: builds, then copies the built assets of the project's mod (`mod.name`) into the mod.
 *
 * Default (fast, the edit loop): the incremental build (`build.*` steps), the would-publish list (`publish.list`), then
 * `bp_publish` for those assets (`publish.copy`). The backend refuses on compile errors, conflicts, locked files and an
 * open editor in the wrong state, backs up the replaced files, and copies them (or reloads them in the open editor).
 * No tests, no audit, no upload file check, no read of every owned asset.
 *
 * `--full` (before an upload): eight gates in this order, stopping at the first failure (fail closed): 1 stubs fingerprint,
 * 2 check (and Blueprint-filter hits), 3 build (reads every owned asset), 4 tests, 5 mod_audit of the staged copy,
 * 6 upload file check, 7 the would-publish list, 8 the same `bp_publish` copy. Each gate's time goes to `.abfc/runs.jsonl`
 * as `gate.<n>`.
 *
 * `--dry-run` (either mode) prints the would-publish list and never sends `bp_publish`. `publish.total` covers the command.
 * This is the only command that mints a publish grant; nothing is ever uploaded.
 */
export async function publish(ctx: CliContext): Promise<number> {
  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  const t0 = performance.now();
  const tally: PublishTally = { listed: 0, published: 0 };
  try {
    const code = ctx.args.flags.full ? await publishFull(ctx, rec, session, tally) : await publishFast(ctx, rec, session, tally);
    if (ctx.args.flags.dryRun && code === 0) {
      ctx.progress.summary(true, "Dry run finished", `${tally.listed} file(s) listed, nothing copied`);
    } else if (code === 0 && tally.listed === 0) {
      ctx.progress.summary(true, "Nothing to publish");
    } else if (code === 0) {
      ctx.progress.summary(true, "Published", `${tally.published} file(s) to ${ctx.env.modDir.value ?? ctx.config.mod.name}`);
    } else {
      ctx.progress.summary(false, "Publish stopped", "see the errors above");
    }
    return code;
  } finally {
    rec.record("publish.total", since(t0), ctx.output.exitCode() === 0);
    await session.close();
    rec.print();
  }
}

const fail = (ctx: CliContext): number => ctx.output.exitCode() || 1;

/** What a publish still owes the mod besides new content: per manifest, the stage's removed files it wants deleted. */
type PendingDelete = { manifest: string; kind: "tombstone" | "renamed" | "rows"; files: string[] };
type PublishList = { changed: string[]; added: string[]; deleted: string[]; config: string[]; pending: PendingDelete[]; alsoOf: string[]; syncedAt: string | null };

interface PublishTally {
  listed: number;
  published: number;
}

/** The "Listing files to publish" step: prints the would-publish list and returns it. */
function listStep(ctx: CliContext, stage: StageStatus | null | (() => Promise<StageStatus | null>), tally: PublishTally): Promise<PublishList> {
  return ctx.progress.run("Listing files to publish", async () => wouldPublish(ctx, typeof stage === "function" ? await stage() : stage), {
    done: (l) => {
      tally.listed = l.changed.length + l.added.length + l.config.length + l.deleted.length;
      return `${tally.listed} file(s) to publish`;
    },
  });
}

/** Build, list, copy. */
async function publishFast(ctx: CliContext, rec: Recorder, session: BackendSession, tally: PublishTally): Promise<number> {
  const { output, config, args } = ctx;
  const mod = config.mod.name;
  if (!(await runBuild(ctx, session, rec))) return fail(ctx);

  const t = performance.now();
  const { backend, info } = await session.open();
  const list = await listStep(ctx, () => backend.stageStatus(mod), tally);
  rec.record("publish.list", since(t));

  if (args.flags.dryRun) return output.exitCode();
  return copyToMod(ctx, rec, backend, list, "publish.copy", info.capabilities.publishDeletes, info.capabilities.liveTags, tally);
}

/** The release checks, then the same copy. */
async function publishFull(ctx: CliContext, rec: Recorder, session: BackendSession, tally: PublishTally): Promise<number> {
  const { output, config, args, env } = ctx;
  const mod = config.mod.name;

  // gate 1: stubs fingerprint
  let t = performance.now();
  const lockOk = !emitAll(ctx, lockDiagnostics(ctx, "build"));
  rec.record("gate.1", since(t), lockOk);
  if (!lockOk) return fail(ctx);

  // gate 2: check, then members the Blueprint filter blocks
  t = performance.now();
  let ok = await runCheck(ctx, rec);
  if (ok) {
    const hits = blockedMemberHits(loadProgram(ctx.projectDir));
    ok = !emitAll(ctx, hits);
  }
  rec.record("gate.2", since(t), ok);
  if (!ok) return fail(ctx);

  // gate 3: build (no compile errors, drift clean); reads every owned asset so editor edits to unchanged units fail it (ABFC5001)
  t = performance.now();
  ok = await runBuild(ctx, session, rec, { readAll: true });
  rec.record("gate.3", since(t), ok);
  if (!ok) return fail(ctx);

  // gate 4: tests
  t = performance.now();
  ok = await runTests(ctx, session, rec, undefined);
  rec.record("gate.4", since(t), ok);
  if (!ok) {
    if (output.exitCode() === 0) output.diag({ severity: "error", code: "ABFC6104", message: "one or more tests failed; not publishing." });
    return output.exitCode();
  }

  // gate 5: mod_audit (the backend audits the staged copy when it reports the stageAudit capability)
  t = performance.now();
  const { backend, info } = await session.open();
  const stageAudit = info.capabilities.stageAudit === true;
  if (!stageAudit) {
    output.diag({
      severity: "warning",
      code: "ABFC7003",
      message: "mod_audit audits the real mod, not the staged copy; the audit below does not cover the staged changes.",
      fix: "audit the mod in the editor after the changes are published by hand.",
    });
  }
  const { report, copy, wrongCopy, auditOk } = await ctx.progress.run(
    "Auditing the staged copy",
    async (s) => {
      const report = await backend.audit(mod);
      const copy = (report.raw as { audited_copy?: unknown } | null)?.audited_copy;
      const wrongCopy = report.ok && stageAudit && copy !== undefined && copy !== "stage";
      const auditOk = report.ok && !wrongCopy;
      if (!auditOk) s.fail("Audit did not pass");
      return { report, copy, wrongCopy, auditOk };
    },
    { slowHint: SLOW_BACKEND_HINT, done: () => "Audit passed" },
  );
  rec.record("gate.5", since(t), auditOk);
  if (!auditOk) {
    output.diag({
      severity: "error",
      code: "ABFC7002",
      message: wrongCopy
        ? `mod_audit audited the ${String(copy)} copy of ${mod}, not the staged copy.`
        : `mod_audit did not pass for ${mod}: ${auditReason(report.raw)}`,
      fix: "run mod_audit in the editor for the details.",
    });
    return fail(ctx);
  }

  // gate 6: upload file check on the real mod folder and the stage folder (read-only)
  t = performance.now();
  const { stage, uploadOk } = await ctx.progress.run(
    "Checking upload files",
    async (s) => {
      const stage = await backend.stageStatus(mod);
      const listFiles = ctx.deps.listFiles ?? walkFolder;
      const folders: Array<[string, string]> = [];
      if (env.modDir.value !== null) folders.push(["mod", env.modDir.value]);
      if (stage !== null && stage.stagingPath !== "") folders.push(["stage", stage.stagingPath]);
      let uploadOk = true;
      for (const [label, dir] of folders) {
        if (emitAll(ctx, uploadFileDiagnostics(label, listFiles(dir)))) uploadOk = false;
      }
      if (!uploadOk) s.fail("Upload file check found problems");
      return { stage, uploadOk };
    },
    { slowHint: SLOW_BACKEND_HINT, done: () => "Upload file check passed" },
  );
  rec.record("gate.6", since(t), uploadOk);
  if (!uploadOk) return fail(ctx);

  // gate 7: the would-publish list
  t = performance.now();
  const list = await listStep(ctx, stage, tally);
  rec.record("gate.7", since(t));

  if (args.flags.dryRun) return output.exitCode();
  // gate 8: bp_publish for the owned assets of the list
  return copyToMod(ctx, rec, backend, list, "gate.8", info.capabilities.publishDeletes, info.capabilities.liveTags, tally);
}

/** Prints the would-publish list: files of the stage that differ from the mod, limited to assets that hold owned units or adoptions. */
function wouldPublish(ctx: CliContext, stage: StageStatus | null): PublishList {
  const { output, args } = ctx;
  const fe = compileFrontend(ctx);
  const owned = new Set<string>();
  for (const a of fe.ir?.assets ?? []) {
    if (a.units.length > 0 || a.classDefaults !== undefined || a.classManagerRow !== undefined || a.director !== undefined || a.structFields !== undefined || a.variables.some((v) => v.temp !== true)) owned.add(a.path);
  }
  for (const a of fe.ir?.assets ?? []) {
    const m = readManifest(ctx.projectDir, a.path);
    if (m !== null && m.units.length > 0) owned.add(a.path);
  }
  // Classes whose TypeScript is gone: their units (or the retirement of them) still have to reach the mod.
  for (const m of listManifests(ctx.projectDir)) {
    if (!m.asset.startsWith(`/${ctx.config.mod.name}/`)) continue;
    if (m.units.length > 0 || (m.retiredUnpublished?.length ?? 0) > 0) owned.add(m.asset);
  }
  // Renamed assets (and the referencers the rename saved too) reach the mod with the rename.
  const modManifests = listManifests(ctx.projectDir).filter((m) => m.asset.startsWith(`/${ctx.config.mod.name}/`));
  for (const m of modManifests) {
    if (m.deleted === true) continue;
    if (m.renamedFrom !== undefined) owned.add(m.asset);
    for (const p of m.publishAlso ?? []) if (p.startsWith(`/${ctx.config.mod.name}/`)) owned.add(p);
  }
  // Class-manager rows abfc wrote for classes that still have a `@director` (published only when the stage lists them as changed or added).
  for (const a of fe.ir?.assets ?? []) {
    if (a.director === undefined) continue;
    const row = readManifest(ctx.projectDir, a.path)?.directorRow;
    if (row !== undefined && row.startsWith(`/${ctx.config.mod.name}/`)) owned.add(row);
  }
  const ownedKeys = new Set([...owned].map((p) => p.split("/").slice(2).join("/").toLowerCase()));
  const mine = (f: string): boolean => isContentFile(f) && !isHelperFile(f) && ownedKeys.has(contentKey(f));
  const changed = (stage?.changed ?? []).filter(mine);
  const added = (stage?.added ?? []).filter(mine);
  // Files the stage lost for a deleted class (and its row), a renamed asset's old path and rows retired by a changed `@director`.
  const removedFiles = (stage?.removed ?? []).filter((f) => isContentFile(f) && !isHelperFile(f));
  const keyOf = (asset: string): string => asset.split("/").slice(2).join("/").toLowerCase();
  const pending: PendingDelete[] = [];
  for (const m of modManifests) {
    const gone: Array<[PendingDelete["kind"], string[]]> = [
      ["tombstone", m.deleted === true ? [m.asset, ...(m.directorRow !== undefined ? [m.directorRow] : [])] : []],
      ["renamed", m.deleted !== true && m.renamedFrom !== undefined ? [m.renamedFrom] : []],
      ["rows", m.retiredRows ?? []],
    ];
    for (const [kind, assets] of gone) {
      if (assets.length === 0) continue;
      const keys = new Set(assets.map(keyOf));
      pending.push({ manifest: m.asset, kind, files: removedFiles.filter((f) => keys.has(contentKey(f))) });
    }
  }
  const deleted = [...new Set(pending.flatMap((p) => p.files))];
  const config = [...(stage?.changed ?? []), ...(stage?.added ?? [])].filter(isTagIni);
  const alsoOf = modManifests.filter((m) => (m.publishAlso?.length ?? 0) > 0).map((m) => m.asset);
  output.info("would publish:");
  for (const f of changed) output.info(`  changed ${f}`);
  for (const f of added) output.info(`  added   ${f}`);
  for (const f of config) output.info(`  changed config ${f}`);
  for (const f of deleted) output.info(`  deleted ${f}`);
  if (changed.length + added.length + config.length + deleted.length === 0) output.info("  (nothing)");
  output.json({ changed, added, deleted, config, dryRun: args.flags.dryRun, full: args.flags.full });
  return { changed, added, deleted, config, pending, alsoOf, syncedAt: stage?.syncedAt ?? null };
}

/** `bp_publish` for the owned assets of the list, with a grant for the project's own mod. */
async function copyToMod(
  ctx: CliContext,
  rec: Recorder,
  backend: Backend,
  list: PublishList,
  step: string,
  canDelete: boolean,
  liveTags: boolean,
  tally: PublishTally,
): Promise<number> {
  const { output, config } = ctx;
  const mod = config.mod.name;
  // Removed files are deleted from the mod only by a backend that can (publishDeletes); otherwise they stay and the user deletes them.
  const deleting = canDelete ? list.deleted : [];
  if (!canDelete && list.deleted.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC7014",
      message: `the backend cannot delete files from the mod (no publishDeletes); these removed assets stay in ${mod}: ${list.deleted.join(", ")}`,
      fix: "delete them in the Mod Editor (Content Browser), or update abf-mod-editor-mcp to 2.6.0 or newer and run abfc publish again.",
    });
  }
  const files = [...list.changed, ...list.added, ...deleting];
  if (files.length + list.config.length === 0) {
    finishPending(ctx, list, canDelete, null);
    // The stage's owned assets are the mod's: the manifests describe what the mod holds.
    snapshotPublishedManifests(ctx.projectDir, mod);
    tally.listed = 0;
    output.info("nothing to publish.", "dim");
    return output.exitCode();
  }
  // The backend strips file extensions, so `Config/Tags/<Mod>Tags.ini` names the tag list (published as a file of the mod).
  const assets = [
    ...new Set([
      ...files.map((f) => `/${mod}/${f.replaceAll("\\", "/").replace(/^Content\//i, "").replace(/\.[^./]+$/, "")}`),
      ...list.config.map((f) => f.replaceAll("\\", "/")),
    ]),
  ];
  const grant = grantPublish(mod);
  const t = performance.now();
  const r = await ctx.progress.run(
    `Publishing ${assets.length} asset(s) to ${mod}`,
    async (s) => {
      const res = await (canDelete ? backend.publish(mod, assets, grant, { deleteRemoved: true }) : backend.publish(mod, assets, grant));
      if (!res.ok) s.fail("Publish refused");
      return res;
    },
    { slowHint: SLOW_BACKEND_HINT, done: (res) => `Published ${res.published.length} file(s)` },
  );
  rec.record(step, since(t), r.ok);

  if (!r.ok) {
    for (const d of publishRefusal(mod, r)) output.diag(d);
    for (const e of r.compileErrors.slice(0, 10)) output.info(`  ${e.asset ?? "(unknown asset)"}: ${e.message}`);
    for (const c of r.conflicts.slice(0, 10)) output.info(`  ${c}`);
    if (r.backup !== null) output.info(`backup: ${r.backup}`);
    return fail(ctx);
  }
  // The retirements of these assets are in the mod now; an asset that nothing owns any more is forgotten.
  for (const asset of assets) {
    const m = readManifest(ctx.projectDir, asset);
    if (m === null || m.retiredUnpublished === undefined) continue;
    const { retiredUnpublished: _retired, ...rest } = m;
    if (rest.units.length === 0 && rest.variables.length === 0 && rest.classDefaultsHash === undefined && rest.structFieldsHash === undefined) {
      deleteManifest(ctx.projectDir, asset);
      deleteSourceMap(ctx.projectDir, asset);
      dropUnitCacheAsset(win32.join(ctx.paths.cacheDir, "units.json"), asset);
      output.info(`no longer owned by abfc: ${asset}`);
    } else {
      writeManifest(ctx.projectDir, rest);
    }
  }
  // Class defaults applied to the stage's current sync are in the mod now: a later re-sync brings them back (the planner keeps them).
  for (const asset of assets) {
    const m = readManifest(ctx.projectDir, asset);
    if (m === null || m.classDefaultsHash === undefined || m.classDefaultsPublished === true) continue;
    if (list.syncedAt === null || (m.classDefaultsStageSyncedAt ?? null) !== list.syncedAt) continue;
    writeManifest(ctx.projectDir, { ...m, classDefaultsPublished: true });
  }
  // Own fields' defaults applied to the stage's current sync are in the mod now too.
  for (const asset of assets) {
    const m = readManifest(ctx.projectDir, asset);
    if (m === null || m.variablesPublished === true || list.syncedAt === null || (m.variablesStageSyncedAt ?? null) !== list.syncedAt) continue;
    writeManifest(ctx.projectDir, { ...m, variablesPublished: true });
  }
  finishPending(ctx, list, canDelete, r);
  // What the mod holds now: a later re-sync (the mod saved before the next publish, a publish that fails) falls back to these entries
  // for the nodes it brings back, so abfc's published units are never mistaken for hand-made ones.
  snapshotPublishedManifests(ctx.projectDir, mod);
  tally.published = r.published.length;
  output.info("published:", "ok");
  if (r.published.length === 0) output.info(`  ${r.message}`);
  for (const f of r.published) output.info(`  ${f}`);
  for (const f of r.deleted) output.info(`  deleted ${f}`);
  output.info(`route: ${r.route ?? "(none)"}`);
  output.info(`backup: ${r.backup ?? "(none)"}`);
  if (r.route === "live-reload") {
    output.info(
      "the open Mod Editor reloaded the published assets in place; the asset editor tabs of the published assets and of the assets that reference them were closed (reopen them to see the change).",
    );
  }
  if (r.tagsRegistered.length > 0) output.info(`gameplay tags registered in the open Mod Editor: ${r.tagsRegistered.join(", ")}`);
  const unknownTags = r.tagsUnregistered;
  if (r.route === "live-reload" && (unknownTags.length > 0 || (!liveTags && list.config.length > 0))) {
    output.diag({
      severity: "warning",
      code: "ABFC7015",
      message:
        unknownTags.length > 0
          ? `the open Mod Editor does not know these gameplay tags yet: ${unknownTags.join(", ")}${r.tagsError !== null ? ` (${r.tagsError})` : ""}; rows that use them load with an invalid tag there and their directors do not start in Play In Editor.`
          : `the tag list ${list.config.join(", ")} was published while the Mod Editor is open; this backend cannot register new tags in the open editor (update abf-mod-editor-mcp), so the editor does not know them yet.`,
      fix: 'restart the Mod Editor before you play or open the director rows. Do not save a row the editor reports "Invalid Tags that have been removed" for; if you did, run abfc build and abfc publish again (the tag is set again).',
    });
  }
  if (r.skippedDirty.length > 0) {
    output.info(
      "note: these assets reference the published ones but were NOT reloaded, because they were edited during the publish and have unsaved changes (their edits were kept; they may still use the old classes until you save and reload them):",
    );
    for (const p of r.skippedDirty) output.info(`  ${p}`);
  }
  if (r.dirtyPublished.length > 0) {
    output.info(
      "warning: these published assets were edited in the Mod Editor during the publish; they were reloaded from the new files, so those unsaved edits were discarded:",
    );
    for (const p of r.dirtyPublished) output.info(`  ${p}`);
  }
  if (r.dirtyAfter.length > 0) {
    output.info("note: these assets show unsaved changes after the reload; saving them changes the mod outside abfc:");
    for (const p of r.dirtyAfter) output.info(`  ${p}`);
  }
  if (r.reloadedReferencers.length > 0) {
    output.info("also reloaded from their unchanged files, because they reference the published assets:");
    for (const p of r.reloadedReferencers) output.info(`  ${p}`);
  }
  if (r.compileErrorsAfter.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC7013",
      message: `the open Mod Editor logged ${r.compileErrorsAfter.length} Blueprint compile error(s) while it reloaded the published assets; the published files on disk are fine, the errors are in the editor's memory.`,
      fix: "open the listed Blueprints and compile them again, or restart the Mod Editor; the errors go away when the assets are loaded fresh.",
    });
    for (const e of r.compileErrorsAfter.slice(0, 10)) output.info(`  ${e.asset ?? "(unknown asset)"}: ${e.message}`);
  }
  output.json({
    published: r.published,
    deleted: r.deleted,
    config: list.config,
    backup: r.backup,
    route: r.route,
    reloadedInPlace: r.reloadedInPlace,
    dirtyAfter: r.dirtyAfter,
    reloadedReferencers: r.reloadedReferencers,
    skippedDirty: r.skippedDirty,
    dirtyPublished: r.dirtyPublished,
    compileErrorsAfter: r.compileErrorsAfter,
    tagsRegistered: r.tagsRegistered,
    tagsUnregistered: r.tagsUnregistered,
    tagsStrategy: r.tagsStrategy,
    tagsError: r.tagsError,
  });
  return output.exitCode();
}

/**
 * What a publish settled: the pending deletions (tombstones, renamed-from paths, retired rows) that are done or have nothing left to
 * delete, and the `publishAlso` lists. `r` is null when nothing was sent (nothing left to publish). Without `publishDeletes` the
 * manifests with files still on the stage's removed list stay, so a later publish with a newer backend deletes them.
 */
function finishPending(ctx: CliContext, list: PublishList, canDelete: boolean, r: PublishResult | null): void {
  const { projectDir, output } = ctx;
  for (const p of list.pending) {
    if (p.files.length > 0 && !(canDelete && r !== null)) continue;
    const m = readManifest(projectDir, p.manifest);
    if (m === null) continue;
    if (p.kind === "tombstone") {
      deleteManifest(projectDir, p.manifest);
      deleteSourceMap(projectDir, p.manifest);
      dropUnitCacheAsset(win32.join(ctx.paths.cacheDir, "units.json"), p.manifest);
    } else if (p.kind === "renamed") {
      const { renamedFrom: _r, ...rest } = m;
      writeManifest(projectDir, rest);
    } else {
      const { retiredRows: _rr, ...rest } = m;
      writeManifest(projectDir, rest);
    }
  }
  if (r === null) return;
  for (const asset of list.alsoOf) {
    const m = readManifest(projectDir, asset);
    if (m === null || m.publishAlso === undefined) continue;
    const { publishAlso: _p, ...rest } = m;
    writeManifest(projectDir, rest);
  }
  if (r.deleted.length > 0) output.info(`deleted from the mod: ${r.deleted.length} file(s)`);
}

/** The diagnostic for a refused `bp_publish`: the backend's message and a specific fix. */
export function publishRefusal(mod: string, r: PublishResult): Diagnostic[] {
  const message = `bp_publish refused for ${mod}: ${r.message || r.refused || "no reason given"}`;
  const d = (code: string, fix: string): Diagnostic[] => [{ severity: "error", code, message, fix }];
  const again = "then run abfc publish again.";
  switch (r.refused) {
    case "compile errors":
      return d("ABFC7004", "fix the errors listed below, run abfc build, then abfc publish again.");
    case "conflicts":
      return d(
        "ABFC7005",
        "the mod's files changed outside abfc since the stage was synced (for example saved in the Mod Editor): run abfc publish again (the build copies the mod again by itself); if it keeps happening, close programs that write to the mod folder.",
      );
    case "editor refused": {
      const why = r.editorReason ?? r.message;
      if (/unload incomplete/.test(why)) {
        return d(
          "ABFC7005",
          `the open Mod Editor could not unload these assets because other loaded assets or the open map still use them, and this backend version refuses then. Update the backend (abf-mod-editor-mcp) to a version that reloads in place, or close the Mod Editor; ${again}`,
        );
      }
      if (/unsaved changes/.test(why)) return d("ABFC7005", `save or revert those assets in the Mod Editor, ${again}`);
      if (/live instances/.test(why)) {
        return d(
          "ABFC7005",
          `the open level holds many actors of the published classes (for example a runtime preview); swapping their classes live can crash the Mod Editor. Remove most of them, or close the Mod Editor (the copy then needs no live reload; ABF_LIVE_PUBLISH_MAX_INSTANCES on the backend changes the limit), ${again}`,
        );
      }
      if (/Play In Editor is running/.test(why)) return d("ABFC7005", `stop Play In Editor in the Mod Editor, ${again}`);
      return d("ABFC7005", `close the editors of those assets in the Mod Editor, ${again}`);
    }
    case "file locked":
      if (r.editor === "open") {
        return d(
          "ABFC7005",
          `the open Mod Editor still holds these files after releasing them: close the asset editor tabs of these assets or restart the Mod Editor, ${again}`,
        );
      }
      return d(
        "ABFC7005",
        `close the asset or the mod in the program that holds it (or open the mod in the Mod Editor so it can be reloaded there), ${again}`,
      );
    case "editor unreachable":
      return d("ABFC7006", `close any dialog in the Mod Editor, run only one Mod Editor, or close it; ${again}`);
    case "editor state":
    case "editor error":
      return d("ABFC7006", `restart or close the Mod Editor, ${again}`);
    case "backup failed":
      return d("ABFC7006", "check free disk space and access to the headless folder (ABF_HEADLESS_DIR); nothing was copied.");
    case "copy failed":
    case "reload failed":
      return d(
        "ABFC7006",
        r.restored === false
          ? `copy the listed files back from ${r.backup ?? "the backup folder"} by hand.`
          : "the mod was restored from the backup; fix the reason and run abfc publish again.",
      );
    default:
      return d("ABFC7006", "nothing was copied unless the message says otherwise; run abfc publish again.");
  }
}
