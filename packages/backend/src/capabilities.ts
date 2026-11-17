import type { BackendCapabilities } from "@abfc/ir";

/** The minimum abf-mod-editor-mcp server version abfc is built for; an older (parseable) version gets warning ABFC4014. */
export const MIN_BACKEND_VERSION = "2.4.0";

/** The backend version with every feature abfc uses (asset ops, publish deletions, gameplay tags, reflect defaults); an older one still works, abfc doctor warns. */
export const RECOMMENDED_BACKEND_VERSION = "2.6.0";

/**
 * Compares two `major.minor.patch` versions (an optional leading `v`, anything after the patch number is ignored):
 * -1 when `version` is older than `min`, 0 when equal, 1 when newer, null when either does not parse (e.g. `fake-1`).
 */
export function compareServerVersion(version: string, min: string): number | null {
  const re = /^v?(\d+)\.(\d+)\.(\d+)/;
  const a = re.exec(version);
  const b = re.exec(min);
  if (a === null || b === null) return null;
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The JSON of `backend_info` (abf-mod-editor-mcp 2.4.0); every key optional, unknown keys ignored. */
export interface RawBackendInfo {
  protocol?: unknown;
  serverVersion?: unknown;
  engineVersion?: unknown;
  editorRoot?: unknown;
  headlessDir?: unknown;
  documentsDir?: unknown;
  capabilities?: {
    pinTypes?: unknown;
    containerTypes?: { array?: unknown; map?: unknown; set?: unknown } | null;
    warmSession?: unknown;
    stageAudit?: unknown;
    reflect?: unknown;
    compileErrorNodeRefs?: unknown;
    functionLocals?: unknown;
    createKinds?: unknown;
    classManagerRows?: unknown;
    assetOps?: unknown;
    publishDeletes?: unknown;
    gameplayTags?: unknown;
    liveTags?: unknown;
    reflectDefaults?: unknown;
  } | null;
  bpApply?: { features?: unknown; nodeKinds?: unknown } | null;
}

/** abfc's static view of bp_apply protocol 1; `capabilitiesFrom` overlays what the backend reports. */
export const BP_APPLY_P1_BASE: BackendCapabilities = {
  protocol: 0,
  writers: ["memswap"],
  headless: true,
  needsOpenEditor: false,
  createKinds: ["Blueprint", "WidgetBlueprint", "BlueprintInterface"],
  containerTypes: { array: true, set: false, map: false },
  userPureFunctions: false,
  functionLocals: false,
  rawNodes: true,
  replicatedEvents: false,
  classDefaults: true,
  multiPassPerAsset: false,
  transactional: false,
  compileErrorNodeRefs: false,
  nodeNameMap: true,
  reflect: false,
  catalog: false,
  gameTest: false,
  audit: false,
  publish: false,
  warmSession: false,
  stageAudit: false,
  pinTypes: false,
  stdMacros: false,
  castObjectPin: false,
  selfEventCalls: false,
  eventMeta: false,
  classManagerRows: false,
  assetOps: [],
  publishDeletes: false,
  gameplayTags: false,
  liveTags: false,
  reflectDefaults: false,
  classManagerRowTag: false,
  variableDefaults: false,
  functionGraphs: false,
  interfaces: false,
  components: false,
  bpApplyFeatures: [],
  nodeKinds: [],
  backendContainerTypes: null,
};

/**
 * abfc-owned policy for the native Map, Set and mod-defined struct (UserDefinedStruct) routes, ANDed with what the backend
 * reports. Map, Set and struct are enabled on compile and game-test evidence ("native now, audit later"): their stage `mod_audit`
 * verdict is still pending because the audit's hidden Mod Editor could not mount the mod, and `abfc publish --full` still runs
 * the audit before anything is published. A failed audit (a real verdict) would switch the feature off again here.
 */
export interface NativePolicy { map: boolean; set: boolean; struct: boolean }
export const NATIVE_POLICY: NativePolicy = { map: true, set: true, struct: true };

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function bool(v: unknown): boolean {
  return v === true;
}

/**
 * Phase 1 gate: `pinTypes` needs `backend_info` to say so AND list `pin_types`. Map and Set need abfc's native policy AND the
 * backend's report AND `pinTypes` (their wildcard pins are typed through `pin_types`); `UserDefinedStruct` joins `createKinds`
 * with the policy AND the `struct_fields` feature. The backend's raw report is kept in `backendContainerTypes` for `abfc doctor`.
 */
export function capabilitiesFrom(
  tools: string[],
  info: RawBackendInfo | null,
  ext: { features?: string[] } | null,
  policy: NativePolicy = NATIVE_POLICY,
): BackendCapabilities {
  const bpApplyFeatures = strings(info?.bpApply?.features);
  const rawContainers = info?.capabilities?.containerTypes ?? null;
  const pinTypes = bool(info?.capabilities?.pinTypes) && bpApplyFeatures.includes("pin_types");
  return {
    ...BP_APPLY_P1_BASE,
    createKinds:
      policy.struct && bpApplyFeatures.includes("struct_fields")
        ? [...BP_APPLY_P1_BASE.createKinds, "UserDefinedStruct"]
        : [...BP_APPLY_P1_BASE.createKinds],
    containerTypes: {
      ...BP_APPLY_P1_BASE.containerTypes,
      map: policy.map && bool(rawContainers?.map) && pinTypes,
      set: policy.set && bool(rawContainers?.set) && pinTypes,
    },
    protocol: typeof info?.protocol === "number" ? info.protocol : 0,
    bpApplyFeatures,
    pinTypes,
    stdMacros: pinTypes && strings(info?.bpApply?.nodeKinds).includes("std_macro"),
    castObjectPin: bpApplyFeatures.includes("cast_object_pin"),
    selfEventCalls: bpApplyFeatures.includes("self_event_calls"),
    eventMeta: bpApplyFeatures.includes("event_meta"),
    classManagerRows: bool(info?.capabilities?.classManagerRows) && bpApplyFeatures.includes("class_manager_row"),
    classManagerRowTag:
      bool(info?.capabilities?.classManagerRows) &&
      bpApplyFeatures.includes("class_manager_row") &&
      bpApplyFeatures.includes("class_manager_row_tag"),
    variableDefaults: bpApplyFeatures.includes("variable_defaults"),
    functionGraphs: bpApplyFeatures.includes("function_graphs"),
    interfaces: bpApplyFeatures.includes("interfaces"),
    components: bpApplyFeatures.includes("components"),
    assetOps: tools.includes("bp_asset_ops") ? strings(info?.capabilities?.assetOps) : [],
    publishDeletes: bool(info?.capabilities?.publishDeletes) && tools.includes("bp_publish"),
    gameplayTags: bool(info?.capabilities?.gameplayTags),
    liveTags: bool(info?.capabilities?.liveTags) && tools.includes("bp_publish"),
    reflectDefaults: bool(info?.capabilities?.reflectDefaults),
    nodeKinds: strings(info?.bpApply?.nodeKinds),
    backendContainerTypes:
      rawContainers === null
        ? null
        : { array: bool(rawContainers.array), set: bool(rawContainers.set), map: bool(rawContainers.map) },
    reflect: tools.includes("reflect"),
    catalog: tools.includes("catalog"),
    gameTest: tools.includes("bp_game_test"),
    audit: tools.includes("mod_audit"),
    publish: tools.includes("bp_publish"),
    compileErrorNodeRefs:
      bool(info?.capabilities?.compileErrorNodeRefs) || (ext?.features?.includes("compile_node_refs") ?? false),
    warmSession: bool(info?.capabilities?.warmSession) && tools.includes("warm_session"),
    stageAudit: bool(info?.capabilities?.stageAudit),
  };
}
