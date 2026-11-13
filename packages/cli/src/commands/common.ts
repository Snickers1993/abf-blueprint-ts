// Pieces shared by check, build, test, status, adopt and publish: timings, lock check, frontend, backend session.
import { win32 } from "node:path";
import { nodeKey } from "@abfc/backend";
import type { Backend } from "@abfc/backend";
import { buildHir, engineNormalisedFunction, listManifests, loadProgram, lowerChecked, readManifest, readSourceMap, sameClassPath, writeManifest, writeSourceMap } from "@abfc/compiler";
import type { CompilerProjectConfig, HirProgram, LoadedProgram, Manifest, ManifestUnit, SourceMapFile } from "@abfc/compiler";
import { AbfcError } from "@abfc/env";
import type { ProjectConfig } from "@abfc/env";
import { parseExport } from "@abfc/ir";
import type { BackendInfo, Diagnostic, IrAsset, IrModule, T3dExport, T3dNode } from "@abfc/ir";
import { checkLock, readLock } from "@abfc/stubgen";
import type { BackendStartOptions, CliContext } from "../context.js";
import { SLOW_BACKEND_HINT } from "../progress.js";
import { backendInfoDiagnostics } from "./backend-version.js";
import { formatTimings, recordRun } from "../runs.js";
import type { RunEntry } from "../runs.js";

/**
 * A codegen epoch, not the release version: it is stored in units.json, and a change marks every unit for forceReplan
 * (every unit is re-applied, which means a republish). Change it only when code generation changes; never on a release bump.
 */
export const COMPILER_ID = "abfc 0.1.0";

/** What the compiler frontend needs from the project config (derived asset paths, migration hints). */
export function compilerConfigOf(config: ProjectConfig): CompilerProjectConfig {
  return {
    mod: config.mod.name,
    sourceRoot: config.sourceRoot,
    migrationHints: config.schemaVersion >= 2,
    classManagerTable: config.classManager.table,
  };
}

/** Seconds since `t0` (a `performance.now()` value). */
export const since = (t0: number): number => (performance.now() - t0) / 1000;

/** Writes timings to `.abfc/runs.jsonl` and keeps them for `--timings`. */
export class Recorder {
  readonly entries: RunEntry[] = [];
  /** Says whether the backend ran its last commandlet operation on the warm session (set by {@link BackendSession}). */
  warmSource: (() => boolean) | null = null;
  constructor(private readonly ctx: CliContext) {}

  record(step: string, seconds: number, ok = true, units?: number): void {
    const entry: RunEntry = {
      at: this.ctx.deps.now().toISOString(),
      step,
      seconds,
      ok,
      mode: this.warmSource?.() === true ? "warm" : "cold",
    };
    if (units !== undefined) entry.units = units;
    this.entries.push(entry);
    recordRun(this.ctx.paths.runsFile, entry);
  }

  /** Prints the table of this invocation when `--timings` was given. */
  print(): void {
    if (!this.ctx.args.flags.timings) return;
    for (const line of formatTimings(this.entries)) this.ctx.output.info(line);
  }
}

export const hasError = (ds: Diagnostic[]): boolean => ds.some((d) => d.severity === "error");

/** Prints the diagnostics and says whether one of them is an error. */
export function emitAll(ctx: CliContext, ds: Diagnostic[]): boolean {
  for (const d of ds) ctx.output.diag(d);
  return hasError(ds);
}

export const hasErrors = (ctx: CliContext): boolean => hasError(ctx.output.diagnostics);

/** Fingerprint and coverage check of the stubs (`mode` decides the severity of ABFC3001). */
export function lockDiagnostics(ctx: CliContext, mode: "check" | "build"): Diagnostic[] {
  const lock = readLock(win32.join(ctx.paths.stubsDir, ctx.env.profile.id));
  return checkLock(lock, ctx.env, ctx.config, mode);
}

export interface Frontend {
  loaded: LoadedProgram;
  hir: HirProgram;
  /** null when the frontend reported errors. */
  ir: IrModule | null;
}

/** TypeScript program -> HIR -> IR, printing every diagnostic. `loaded` is the program when the caller already has a current one. */
export function compileFrontend(ctx: CliContext, loaded: LoadedProgram = loadProgram(ctx.projectDir)): Frontend {
  const hir = buildHir(loaded, compilerConfigOf(ctx.config), ctx.env.profile);
  const diags = [...loaded.diagnostics, ...hir.diagnostics];
  emitAll(ctx, diags);
  if (hasError(diags)) return { loaded, hir, ir: null };
  const lowered = lowerChecked(hir, ctx.env.profile);
  for (const d of lowered.diagnostics) ctx.output.diag(d);
  return { loaded, hir, ir: lowered.ir };
}

export function countUnits(ir: IrModule): number {
  return ir.assets.reduce((n, a) => n + a.units.length, 0);
}

/** Problems of the backend's `backend_info`: warnings ABFC4012 (none) and ABFC4014 (older than the minimum), error ABFC4001 (protocol too old, thrown). */
function checkProtocol(ctx: CliContext, info: BackendInfo): void {
  const { config, env, output } = ctx;
  for (const d of backendInfoDiagnostics(info, config.backend.minProtocol, env.backendDir.value ?? "?")) {
    if (d.severity === "error") throw new AbfcError(d);
    output.diag(d);
  }
}

/** Options for `startBackend`: `cold` when given, and the backend's stderr lines as progress notes when `--verbose`. */
export function backendStartOptions(ctx: CliContext, cold?: boolean): BackendStartOptions {
  return {
    ...(cold !== undefined ? { cold } : {}),
    ...(ctx.progress.notes ? { onStderr: (l: string) => ctx.progress.note(l) } : {}),
  };
}

/** One backend per command run, started on first use. */
export class BackendSession {
  private opened: { backend: Backend; info: BackendInfo } | null = null;
  constructor(
    private readonly ctx: CliContext,
    private readonly rec: Recorder,
  ) {}

  async open(step = "build.backendStart"): Promise<{ backend: Backend; info: BackendInfo }> {
    if (this.opened !== null) return this.opened;
    return this.ctx.progress.run(
      "Starting backend",
      async () => {
        const t0 = performance.now();
        const backend = await this.ctx.deps.startBackend(this.ctx.env, backendStartOptions(this.ctx, this.ctx.args.flags.cold));
        this.rec.warmSource = () => backend.lastWarm === true;
        let opened: { backend: Backend; info: BackendInfo };
        try {
          const info = await backend.info();
          checkProtocol(this.ctx, info);
          opened = { backend, info };
          this.opened = opened;
        } catch (e) {
          this.rec.record(step, since(t0), false);
          try {
            await backend.close();
          } catch {
            // the backend is gone already
          }
          throw e;
        }
        this.rec.record(step, since(t0));
        return opened;
      },
      { slowHint: SLOW_BACKEND_HINT, done: (o) => `Backend ready (server ${o.info.serverVersion})` },
    );
  }

  async close(): Promise<void> {
    const o = this.opened;
    this.opened = null;
    if (o === null) return;
    try {
      await o.backend.close();
    } catch {
      // the backend is gone already
    }
  }
}

/**
 * The assets (package paths under `/<mod>/`) that have no file in the stage: `<stagingPath>\Content\<path under /<mod>/>.uasset`
 * does not exist. An empty `stagingPath` (a backend that does not report it) means nothing is judged missing.
 */
export function missingInStage(ctx: CliContext, stagingPath: string, assets: string[]): Set<string> {
  const out = new Set<string>();
  if (stagingPath === "") return out;
  const prefix = `/${ctx.config.mod.name}/`;
  for (const a of assets) {
    if (!a.startsWith(prefix)) continue;
    const file = win32.join(stagingPath, "Content", ...a.slice(prefix.length).split("/")) + ".uasset";
    if (!ctx.deps.host.exists(file)) out.add(a);
  }
  return out;
}

/** `bp_read` of an asset and the parsed export. */
export async function readAsset(ctx: CliContext, backend: Backend, asset: string): Promise<{ text: string; parsed: T3dExport }> {
  const snap = await backend.read(ctx.config.mod.name, asset);
  const text = ctx.deps.host.readFile(snap.exportPath);
  return { text, parsed: parseExport(text) };
}

export const shortHash = (h: string | null): string => (h === null || h === "" ? "-" : h.replace(/^sha256:/, "").slice(0, 8));

/** real node name -> `<unit id>/<IR node id>` for the units recorded in a manifest (the node names a source map keeps). */
export function previousNames(manifest: Manifest | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of manifest?.units ?? []) {
    for (const [irId, real] of Object.entries(u.nodeIds)) out[`${u.id}/${irId}`] = real;
  }
  return out;
}

/** Source map of one asset: spans from the IR, real names from `names` (`<unit id>/<IR node id>` -> real). */
export function sourceMapOf(asset: IrAsset, names: Record<string, string>): SourceMapFile {
  const units: SourceMapFile["units"] = {};
  for (const u of asset.units) {
    const nodes: SourceMapFile["units"][string]["nodes"] = {};
    for (const n of u.nodes) nodes[n.id] = { span: n.origin, real: names[nodeKey(u, n.id)] ?? null };
    units[u.id] = { span: u.origin, nodes };
  }
  return { asset: asset.path, units };
}

/**
 * The manifest units a re-synced stage still holds: every owned node is there, the unit is an adoption (a build replays it), or it is
 * a published function whose only missing nodes are the struct break/make nodes the editor rewrites on save (it stays tracked and the
 * build rebases it onto the stage graph, instead of being dropped and rebuilt as a hand-made function).
 */
export function unitsHeldByStage<U extends ManifestUnit>(units: readonly U[], stage: Map<string, T3dNode>): U[] {
  return units.filter((u) => u.adopt !== null || u.nodes.every((n) => stage.has(n)) || engineNormalisedFunction(u, stage) !== null);
}

/**
 * After the stage was re-synced from the mod (`--resync`, the automatic re-sync after a failed compile, a stage created from
 * scratch): the stage holds only what the mod holds, so the unpublished work of every asset of the mod is gone. The manifests
 * (and source maps) are brought back in line: units whose nodes the stage does not hold are dropped (they were never published,
 * so the next build applies them again instead of reporting their nodes as missing, ABFC5002, with a fix that pointed back to
 * `--resync`). Adopted units keep their entry (a build replays the adoption); tombstones, `renamedFrom` and every other manifest
 * field stay. `o.base` is the state of the manifests from before the build wrote anything (the failed-compile path); without it
 * the manifests on disk are the base. `o.appliedAssets` always get their base manifest back (a failed build wrote a half-applied
 * one). Units this build removed come back with the stage and are tracked again; a published unit this build re-applied keeps
 * the node names the mod still holds. Best effort per asset: an unreadable stage or a write failure leaves that manifest as it is.
 */
export async function pruneManifestsToStage(
  ctx: CliContext,
  backend: Backend,
  mod: string,
  o: {
    base?: ReadonlyMap<string, Manifest | null>;
    appliedAssets?: readonly string[];
    ir?: IrModule;
    owned?: readonly IrAsset[];
  } = {},
): Promise<void> {
  const { projectDir } = ctx;
  const appliedAssets = o.appliedAssets ?? [];
  const applied = new Set(appliedAssets);
  const assets = new Set(appliedAssets);
  for (const m of listManifests(projectDir)) if (m.asset.startsWith(`/${mod}/`)) assets.add(m.asset);
  for (const asset of assets) {
    try {
      const current = readManifest(projectDir, asset);
      const base = o.base?.get(asset) ?? current;
      if (base === null || base.structFieldsHash !== undefined) continue;
      let units = base.units;
      let stageParent: string | null = null; // the parent the stage holds now (a reparent or recreate of an unpublished stage is gone with the re-sync)
      if (units.length === 0 && base.parent !== undefined) {
        try {
          stageParent = (await readAsset(ctx, backend, asset)).parsed.parentClass;
        } catch {
          // unreadable: the recorded parent stays
        }
      }
      if (units.length > 0) {
        let heldNodes: Map<string, T3dNode>;
        try {
          const parsed = (await readAsset(ctx, backend, asset)).parsed;
          heldNodes = parsed.nodes;
          stageParent = parsed.parentClass;
        } catch {
          // A stage-only rename is gone after a re-sync: the published nodes are still in the asset under its old path.
          try {
            if (base.renamedFrom === undefined) throw new Error("no earlier path");
            const parsed = (await readAsset(ctx, backend, base.renamedFrom)).parsed;
            heldNodes = parsed.nodes;
            stageParent = parsed.parentClass;
          } catch {
            // unreadable stage: do not treat it as empty (that would drop published units), keep this manifest as it is
            continue;
          }
        }
        units = unitsHeldByStage(base.units, heldNodes);
      }
      const parentChanged = base.parent !== undefined && stageParent !== null && !sameClassPath(base.parent, stageParent);
      if (!applied.has(asset) && units.length === base.units.length && !parentChanged) continue;
      // The family recorded with the old parent no longer says anything about the parent the stage holds: dropped (the next build asks the backend).
      const { parentFamily: _family, ...rest } = base;
      const restored: Manifest = parentChanged ? { ...rest, units, parent: stageParent! } : { ...base, units };
      writeManifest(projectDir, restored);
      const irAsset = o.owned?.find((a) => a.path === asset) ?? o.ir?.assets.find((a) => a.path === asset);
      if (irAsset !== undefined) {
        writeSourceMap(projectDir, sourceMapOf(irAsset, previousNames(restored)));
        continue;
      }
      // No IR here (status, stubs, adopt): the dropped units keep their spans in the source map but lose their node names.
      const sm = readSourceMap(projectDir, asset);
      if (sm === null) continue;
      const kept = new Set(units.map((u) => u.id));
      for (const [id, u] of Object.entries(sm.units)) {
        if (kept.has(id)) continue;
        for (const n of Object.values(u.nodes)) n.real = null;
      }
      writeSourceMap(projectDir, sm);
    } catch {
      // the manifest stays as it is; the next build reports what it finds
    }
  }
}
