// Hash manifest (design 8.3): `.abfc/manifest/<asset>.json`, committed with the project.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ManifestUnit {
  /** "event:UpdateTarget" */
  id: string;
  graph: string;
  irHash: string;
  /** `unitStateHash` of `nodes` after the last apply; null until the unit was applied. */
  assetHash: string | null;
  /** Real node names of the unit. */
  nodes: string[];
  /** IR node id -> real node name. */
  nodeIds: Record<string, string>;
  /** Real name of the ownership comment box. */
  tag: string | null;
  /** `StageStatus.syncedAt` of the stage the unit was last applied to. */
  stageSyncedAt: string | null;
  adopt: {
    entry: string;
    nodes: string[];
    hash: string;
    recordedAt: string;
    stageSyncedAt: string | null;
    /** Delegate links to or from other units' entries found at adoption (informational). */
    crossLinks?: Array<{ node: string; pin: string; entry: string; role: "uses" | "supplies" }>;
  } | null;
  /** Per-node state hashes (optional; used to count edits in ABFC5001). */
  nodeHashes?: Record<string, string>;
  /** Sorted link list of the unit (optional; used to count links added/removed in ABFC5001). */
  links?: string[];
}

export interface Manifest {
  asset: string;
  compiler: string;
  profile: string;
  units: ManifestUnit[];
  variables: Array<{ name: string; type: string; hash: string; default?: string }>;
  /** Hash of the class defaults (and class manager row) of the last pass 5 that succeeded; absent until then. */
  classDefaultsHash?: string;
  /** `StageStatus.syncedAt` of the stage the class defaults were applied to (a resync discards them). */
  classDefaultsStageSyncedAt?: string | null;
  /**
   * The class defaults recorded above reached the mod (a publish copied the asset while the stage still held the sync they were
   * applied to). A later re-sync copies from the mod, so they are still there and the pass does not run again; cleared (absent)
   * whenever a defaults pass applies new ones.
   */
  classDefaultsPublished?: true;
  /** Asset path of the class-manager row abfc wrote for this class's `@director` (set after a defaults pass whose backend wrote the row). */
  directorRow?: string;
  /** Hash of the fields of a mod-defined struct (`structFieldsHash`) the struct was created with; absent for a Blueprint asset. */
  structFieldsHash?: string;
  /** A struct whose TypeScript is gone: ABFC5018 was reported once (abfc never deletes a struct); cleared when the struct is declared again. */
  structRetired?: true;
  /** Unit ids a build removed from the stage that are not published yet (cleared by a successful publish). */
  retiredUnpublished?: string[];
  /** Where the asset came from at the last build (docs/design.md 18.2); absent in manifests written before 1.0. */
  source?: { file: string; class: string; derived: boolean };
  /** abfc created the asset (its plan had `create`): only such assets are deleted when the class leaves the TS. Absent for hand-made/adopted assets and manifests written before 1.0. */
  created?: boolean;
  /** Class path of the parent the asset was last built with (`extends`); absent in manifests written before the reparent support. */
  parent?: string;
  /** Family of that parent (`actor`, `component`, `widget`, `object`); decides between reparent and recreate. */
  parentFamily?: "actor" | "component" | "widget" | "object";
  /** The asset path this asset was renamed from on the stage; the old files are deleted by the next publish (cleared by it). */
  renamedFrom?: string;
  /** Tombstone: the class left the TS and abfc deleted the asset from the stage; the next publish deletes its files, then the manifest goes. */
  deleted?: boolean;
  /** Packages other than the asset itself that a stage-only rename fixup saved (referencers); the next publish copies them. */
  publishAlso?: string[];
  /** Class-manager rows abfc deleted from the stage because the class's `@director` row changed or went away; the next publish deletes their files (cleared by it). */
  retiredRows?: string[];
}

/** `/Mod/Dir/BP_X` -> `Mod__Dir__BP_X` */
export function assetFileStem(asset: string): string {
  return asset.slice(1).replaceAll("/", "__");
}

export function manifestPath(dir: string, asset: string): string {
  return join(dir, ".abfc", "manifest", `${assetFileStem(asset)}.json`);
}

/** The manifest of an asset, or null when there is none. */
export function readManifest(dir: string, asset: string): Manifest | null {
  const file = manifestPath(dir, asset);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Manifest;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/** Pretty JSON with sorted keys and a trailing newline. */
export function stringifySorted(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2) + "\n";
}

/** Writes the manifest and returns its file path. */
export function writeManifest(dir: string, m: Manifest): string {
  const file = manifestPath(dir, m.asset);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifySorted(m), "utf8");
  return file;
}

/** Every manifest under `.abfc/manifest`, sorted by file name. */
export function listManifests(dir: string): Manifest[] {
  const folder = join(dir, ".abfc", "manifest");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((x) => x.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(folder, f), "utf8").replace(/^﻿/, "")) as Manifest);
}

/** Removes the manifest file of an asset (no-op when there is none). */
export function deleteManifest(dir: string, asset: string): void {
  const file = manifestPath(dir, asset);
  if (existsSync(file)) rmSync(file);
}

/**
 * `.abfc/published/<asset>.json`: the manifests as they stood after the last publish that succeeded (every owned asset of the stage
 * was then the same as in the mod). A stage copied from the mod again holds what was published, so when the current manifest names
 * nodes the stage no longer holds (a build that was never published, a publish that failed), the published entry says which of the
 * stage's nodes are abfc's own: they stay owned and are replaced, instead of counting as hand-made.
 */
export function publishedManifestPath(dir: string, asset: string): string {
  return join(dir, ".abfc", "published", `${assetFileStem(asset)}.json`);
}

/** The manifest of an asset as of the last successful publish, or null (never published by this abfc, or unreadable). */
export function readPublishedManifest(dir: string, asset: string): Manifest | null {
  try {
    const file = publishedManifestPath(dir, asset);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Manifest;
  } catch {
    return null;
  }
}

/** Replaces `.abfc/published` with the current manifests of the mod's assets (call after a publish that succeeded). Best effort. */
export function snapshotPublishedManifests(dir: string, mod: string): number {
  const folder = join(dir, ".abfc", "published");
  const tmp = `${folder}.tmp`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    let n = 0;
    for (const m of listManifests(dir)) {
      if (!m.asset.startsWith(`/${mod}/`)) continue;
      writeFileSync(join(tmp, `${assetFileStem(m.asset)}.json`), stringifySorted(m), "utf8");
      n++;
    }
    rmSync(folder, { recursive: true, force: true });
    renameSync(tmp, folder);
    return n;
  } catch {
    rmSync(tmp, { recursive: true, force: true });
    return 0;
  }
}

/** Owned unit ids (`event:Name`) and variable names per asset, for stub generation and the frontend. */
export function ownedSets(dir: string): Record<string, { units: string[]; variables: string[] }> {
  const folder = join(dir, ".abfc", "manifest");
  const out: Record<string, { units: string[]; variables: string[] }> = {};
  if (!existsSync(folder)) return out;
  for (const f of readdirSync(folder).filter((x) => x.endsWith(".json")).sort()) {
    const m = JSON.parse(readFileSync(join(folder, f), "utf8").replace(/^﻿/, "")) as Manifest;
    out[m.asset] = {
      units: m.units.map((u) => u.id),
      variables: m.variables.map((v) => v.name),
    };
  }
  return out;
}

const RETIRED_FILE = "retired.json";

/**
 * Units abfc removed from an asset after the stubs were generated, per asset: `<stubs>/<profile>/retired.json`. The stubs still list
 * them as hand-made members; they are hidden like owned ones until `abfc generate` rewrites the folder (which deletes this file) from the stage.
 */
export function readRetired(dir: string, profileId?: string, onCorrupt?: (file: string, why: string) => void): Record<string, string[]> {
  const root = join(dir, ".abfc", "stubs");
  const out: Record<string, string[]> = {};
  if (!existsSync(root)) return out;
  for (const profile of profileId !== undefined ? [profileId] : readdirSync(root).sort()) {
    const file = join(root, profile, RETIRED_FILE);
    if (!existsSync(file)) continue;
    let parsed: Record<string, string[]>;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, string[]>;
    } catch (e) {
      onCorrupt?.(file, e instanceof Error ? e.message : String(e));
      continue;
    }
    for (const [asset, ids] of Object.entries(parsed)) out[asset] = [...new Set([...(out[asset] ?? []), ...ids])].sort();
  }
  return out;
}

/** Records that these unit ids were removed from `asset` (merged into what the profile's folder already holds). No-op without a stub folder. */
export function writeRetired(stubsProfileDir: string, asset: string, ids: string[]): void {
  if (ids.length === 0 || !existsSync(stubsProfileDir)) return;
  const file = join(stubsProfileDir, RETIRED_FILE);
  let all: Record<string, string[]> = {};
  try {
    if (existsSync(file)) all = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, string[]>;
  } catch {
    all = {}; // unreadable: rewritten from what this build retires
  }
  all[asset] = [...new Set([...(all[asset] ?? []), ...ids])].sort();
  writeFileSync(file, stringifySorted(all), "utf8");
}
