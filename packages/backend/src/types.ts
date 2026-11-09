import type { BackendInfo } from "@abfc/ir";
import type { PublishGrant } from "./safety.js";

export interface StageReport {
  mod: string;
  files: number;
  stagingPath: string;
}

export interface StageStatus {
  mod: string;
  stagingPath: string;
  syncedAt: string | null;
  changed: string[];
  added: string[];
  removed: string[];
  conflicts: string[];
  /** Files untouched in the stage but saved or deleted in the real mod since the sync (backend 2.6.0; empty on older backends). */
  stale: string[];
}

export interface AssetSnapshot {
  asset: string;
  run: string;
  /** `<run>/export.t3d` */
  exportPath: string;
  structure: unknown;
  seconds: number | null;
  /** The read ran on the warm session. */
  warm?: boolean;
}

export interface CompileMessage {
  asset: string | null;
  message: string;
  /** Real node name from `from Source:` in the compile log, when the backend reports it. */
  node?: string;
  graph?: string;
}

export interface BpApplyResult {
  ok: boolean;
  rolledBack: boolean;
  run: string;
  seconds: number;
  assets: Array<{ asset: string; node_ids: Record<string, Record<string, string>>; final?: string }> | null;
  compile: { errors: CompileMessage[]; warnings: CompileMessage[] };
  /** Class-manager rows the backend wrote after the Blueprints were saved (backend 2.5.0); empty when the spec carried none. */
  rows: Array<{ asset: string; created: boolean; changed: boolean; /** The gameplay tag the row holds after the apply (backend 2.6.0), when the spec asked for one. */ tag?: string | null }>;
  /** Gameplay tags the backend added to the stage's tag ini before the apply (backend 2.6.0); absent/empty when none. */
  tagsAdded?: string[];
  /** The apply ran on the warm session. */
  warm?: boolean;
  error?: string;
  logTail?: string;
}

export interface CompileReport {
  clean: boolean;
  messages: Array<CompileMessage & { severity: "error" | "warning" }>;
  run: string;
  seconds: number;
  /** The report ran on the warm session. */
  warm?: boolean;
}

export interface ReflectRequest {
  mod: string;
  classes: string[];
  structs: string[];
  castTargets: string[];
  /** Also list the gameplay tags the engine knows (backend 2.6.0, capability `gameplayTags`). */
  gameplayTags?: boolean;
  /** Class paths whose parent chain only is wanted (opaque types); backends that report `supers`. */
  supersOf?: string[];
}

/** One pin of a reflected member (the backend's `Pin` shape of `reflect.json`). */
export interface ReflectPin {
  name: string;
  dir: "in" | "out";
  category: string;
  subCategory: string;
  subCategoryObject: string | null;
  objectMeta: string | null;
  container: string;
  hidden: boolean;
  default: string | null;
}

export interface ReflectMember {
  name: string;
  pins: ReflectPin[];
  /** Set for members GetClassDefaults cannot list (backend member pass); absent for class-default properties and functions. */
  kind?: "widget" | "component" | "member";
  /** Function metadata read from the engine (backends with the reflect meta pass); null/absent when unreadable. */
  meta?: { tooltip?: string | null; displayName?: string | null; /** pin name -> default text from the UFunction `CPP_Default_*` metadata (backend 2.6.0); null when unreadable. */ defaults?: Record<string, string> | null } | null;
}

export interface ReflectClass {
  meta: string | null;
  ancestors: string[];
  functions: ReflectMember[];
  properties: ReflectMember[];
  castPin: string | null;
  /** The class appears only as a cast target: no member lists. */
  castOnly?: boolean;
}

/** `<run>/reflect.json` */
export interface ReflectData {
  engineVersion: string | null;
  classes: Record<string, ReflectClass>;
  structs: Record<string, { fields: ReflectPin[] }>;
  errors: string[];
  /** Gameplay tags of the engine (only when requested and the backend supports it); `sources` is the backend's per-source count or error. */
  gameplayTags?: { tags: string[]; sources: Record<string, unknown> };
  /** Class path -> every ancestor, Blueprint and native, nearest first, ending at UObject; absent from older backends. */
  supers?: Record<string, string[]>;
  /** Member sources the backend ran (widgetTree, scs, cookedClass, pythonDoc); absent from older backends. */
  memberSources?: string[];
}

export interface ReflectResult {
  run: string;
  seconds: number;
  file: string;
  data: ReflectData;
  filter: { contentVersion: string | null; rules: Array<["Allow" | "Block", string]> };
}

/** `<run>/catalog.json` of the `catalog` tool (backend 2.6.0, capability `catalog`): names only, no members. `data` is the parsed, unvalidated document. */
export interface CatalogResult {
  run: string;
  seconds: number;
  file: string;
  data: unknown;
  /** The catalog ran on the warm session. */
  warm?: boolean;
}

export interface GameTestReport {
  ok: boolean;
  steps: Array<{ i: number; op: string; ok: boolean; value: unknown; error?: string }>;
  passed: number;
  failed: number;
  complete: boolean;
  runtimeLog: string[];
  run: string;
  seconds: number;
  timedOut: boolean;
  error?: string;
}

export interface AuditReport {
  ok: boolean;
  raw: unknown;
  seconds: number;
}

export interface PublishResult {
  ok: boolean;
  published: string[];
  refused: string | null;
  message: string;
  backup: string | null;
  route: string | null;
  compileErrors: Array<{ asset: string | null; message: string }>;
  conflicts: string[];
  /** Files deleted from the mod by a publish with `deleteRemoved` (backend 2.6.0); empty otherwise. */
  deleted: string[];
  restored: boolean | null;
  editor: string | null;
  /** The open editor's refusal reason (`editor_result.reason`), when it refused. */
  editorReason: string | null;
  /** Packages the open editor reloaded in place (still referenced, not unloaded). */
  reloadedInPlace: string[];
  /** Mod packages that show unsaved changes after the reload. */
  dirtyAfter: string[];
  /** Loaded packages of the same mod that reference the published ones; the open editor reloaded them from their unchanged files. */
  reloadedReferencers: string[];
  /** Referencers the open editor did NOT reload because they were edited during the publish and have unsaved changes (their edits were kept). */
  skippedDirty: string[];
  /** Published packages that were edited in the open editor during the publish; they were reloaded from the new files, so those edits are gone. */
  dirtyPublished: string[];
  /** Blueprint compile errors the open editor logged for the reloaded packages while it reloaded (the files on disk are fine). */
  compileErrorsAfter: Array<{ asset: string | null; message: string }>;
  /** Gameplay tags the backend registered in the open editor before it reloaded the published rows (`tags_registered`, capability `liveTags`); empty otherwise. */
  tagsRegistered: string[];
  /** Tags of the mod's tag list the open editor still does not know after the publish (`tags_unregistered`); empty when all are known or the backend is older. */
  tagsUnregistered: string[];
  /** How the backend registered the tags (`tags_strategy`: "refresh" or "settings"), or null. */
  tagsStrategy: string | null;
  /** Why the tag registration failed or was partial (`tags_error`), or null. */
  tagsError: string | null;
  raw: unknown;
}

/** One `bp_asset_ops` operation (backend 2.6.0). Paths are package paths (`/<Mod>/...`) of the stage. */
export type AssetOp =
  | { op: "rename"; from: string; to: string }
  | { op: "delete"; asset: string }
  | { op: "reparent"; asset: string; parent: string }
  | { op: "recreate"; asset: string };

export interface AssetOpsResult {
  ok: boolean;
  results: Array<{ op: string; ok: boolean; detail?: string }>;
  /** Package paths the backend saved while fixing up references (referencers of renamed assets). */
  touched: string[];
  error: string | null;
  /** The backend restored the stage after a failure. */
  rolledBack?: boolean;
  run?: string;
}

export interface Backend {
  /** True when the most recent commandlet operation (read, apply, compile, reflect) ran on the warm session. */
  readonly lastWarm?: boolean;
  info(): Promise<BackendInfo>;
  stage(modDir: string, o: { discardChanges: boolean }): Promise<StageReport>;
  stageStatus(mod: string): Promise<StageStatus | null>;
  read(mod: string, asset: string): Promise<AssetSnapshot>;
  applySpecs(
    mod: string,
    specs: unknown[],
    o: { label: string; cacheDir: string; keepOnError?: boolean },
  ): Promise<BpApplyResult>;
  compile(mod: string, assets: string[]): Promise<CompileReport>;
  reflect(r: ReflectRequest): Promise<ReflectResult>;
  /** `catalog` (backend 2.6.0, capability `catalog`): names-only catalog of every game Blueprint class and engine class, struct, enum and function library. */
  catalog(mod: string): Promise<CatalogResult>;
  /** `map`: the map the game opens (the backend's default empty map when absent). */
  gameTest(mod: string, steps: unknown[], o: { timeoutSeconds: number; map?: string }): Promise<GameTestReport>;
  audit(mod: string): Promise<AuditReport>;
  /** `bp_publish` for exactly `mod`, only with a {@link PublishGrant} from `grantPublish` (sent only by `abfc publish`). */
  publish(mod: string, assets: string[], grant: PublishGrant, o?: { deleteRemoved?: boolean }): Promise<PublishResult>;
  /** `bp_asset_ops` on the stage (backend 2.6.0, capability `assetOps`): rename, delete, reparent, recreate. Never touches the mod. */
  assetOps(mod: string, ops: AssetOp[]): Promise<AssetOpsResult>;
  close(): Promise<void>;
}
