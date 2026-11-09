// Core IR types (design 6.1) plus the shared shapes used across packages (profile, diagnostics, backend, apply plan, tests).

export interface Span { file: string; line: number; col: number; endLine: number; endCol: number }

export type VarFlag = "transient" | "replicated" | "editable";
export type IrType = string; // bp_apply type grammar: "int", "object:/Script/Engine.Actor", "array:name", ...

export interface IrModule {
  irVersion: 1;
  profile: string; // "ue5.4.4-1050002"
  mod: string; // "ExampleMod"
  assets: IrAsset[];
  /** class path -> meta class path (WidgetBlueprintGeneratedClass vs BlueprintGeneratedClass) used for pin object text. */
  classMeta: Record<string, string>;
}
export interface IrAsset {
  path: string; // "/ExampleMod/PotInfo/BP_PotInfoRelay" (always under /<mod>/)
  create?: { kind: "Blueprint" | "WidgetBlueprint" | "BlueprintInterface" | "UserDefinedStruct"; parent: string };
  classDefaults?: Record<string, string>; // property -> T3D value text
  /** Row asset path whose class reference is verified (read-only) by the class-defaults pass. */
  classManagerRow?: string;
  /** `@director("Row")`: the class-manager row asset (`/<mod>/<table>/<Row>`) that should reference this class. */
  director?: { row: string; asset: string; /** The gameplay tag the row holds (`@director("Row", tag)`). */ tag?: string };
  variables: IrVariable[];
  units: IrUnit[]; // owned functions/events/overrides
  structFields?: IrVariable[]; // only for UserDefinedStruct
}
export interface IrVariable { name: string; type: IrType; default?: string; flags: VarFlag[]; origin: Span; temp?: boolean }
export interface IrParam { name: string; type: IrType }
export interface IrUnit {
  id: string; // "event:UpdateTarget"
  kind: "function" | "event" | "override";
  name: string;
  graph: string; // "EventGraph" for events, the function name for functions
  signature: { inputs: IrParam[]; outputs: IrParam[]; net?: "server" | "client" | "multicast"; reliable?: boolean; /** Functions only: the Blueprint access specifier. */ access?: "public" | "protected" | "private"; /** Functions only: the class path of the parent that declares the function this graph overrides. */ override?: string };
  locals: IrVariable[]; // honored when the backend has functionLocals; else hoisted by the lowering
  nodes: IrNode[];
  wires: IrWire[];
  /**
   * Wires to a node of another unit of the same asset (a delegate argument: the owned event's `OutputDelegate` feeds a pin of this unit).
   * `toUnit` = unit id of the other unit, `from` = `<its entry node id>.<output pin>`, `to` = `<node id in this unit>.<pin>`.
   */
  crossWires?: Array<{ toUnit: string; from: string; to: string }>;
  origin: Span;
  hash: string; // sha256 of the canonical JSON of signature+nodes+wires (no positions)
}
export interface IrNode {
  id: string; // per-unit emission-order id: "<role><n>", e.g. "cast1"
  t3d: { class: string; props: string[] }; // authoritative node text without pins (pins are engine-allocated)
  sem?: SemanticTag; // optional hint so adapters can pick a native kind
  pinDefaults?: Record<string, string>; // raw T3D defaults
  pinObjects?: Record<string, string>; // object/class pin defaults by path
  /** Concrete types for wildcard pins (backend-neutral, bp_apply type grammar). */
  pinTypes?: Record<string, IrType>;
  pos: [number, number];
  origin: Span;
}
/** Tooltip, category and keywords of a custom event (from its TS doc comment); written by bp_apply feature `event_meta`. */
export interface EventMeta { tooltip?: string; category?: string; keywords?: string }
export type SemanticTag =
  | { k: "call"; class?: string; function: string } | { k: "get" | "set"; name: string; class?: string }
  | { k: "event"; name: string; params?: IrParam[]; meta?: EventMeta } | { k: "override"; class: string; function: string }
  | { k: "branch" } | { k: "sequence" } | { k: "cast"; target: string } | { k: "self" }
  | { k: "spawn" } | { k: "create_widget" } | { k: "call_dispatcher" | "bind_dispatcher"; name: string }
  | { k: "std_macro"; name: string };
export type IrWire = [from: `${string}.${string}`, to: `${string}.${string}`]; // output first; "entry"/"result" reserved

export interface Diagnostic {
  severity: "error" | "warning";
  code: string; // "ABFC2001"
  message: string;
  span?: Span;
  asset?: string;
  tried?: Array<{ source: string; detail: string }>;
  fix?: string;
  /** Machine-readable facts for a quick fix (for example ABFC5012: the path to keep). */
  data?: Record<string, string>;
}

export interface BackendCapabilities {
  protocol: number; // abf backend protocol version (handshake, not the server's semver)
  writers: Array<"memswap" | "import_nodes" | "paste">;
  headless: boolean; // no desktop, mouse, keyboard or focus
  needsOpenEditor: boolean;
  createKinds: Array<"Blueprint" | "WidgetBlueprint" | "BlueprintInterface" | "UserDefinedStruct">;
  containerTypes: { array: boolean; set: boolean; map: boolean };
  userPureFunctions: boolean;
  functionLocals: boolean;
  rawNodes: boolean; // arbitrary class + props node text
  replicatedEvents: boolean;
  classDefaults: boolean;
  multiPassPerAsset: boolean; // same asset may appear in several passes of one transaction
  transactional: boolean; // whole plan applies or nothing is saved
  compileErrorNodeRefs: boolean; // compile errors name the node (needed for line-level mapping)
  nodeNameMap: boolean; // returns IR id -> real node name
  reflect: boolean;
  /** The backend has the `catalog` tool (abf-mod-editor-mcp 2.6.0): a names-only catalog of every game and engine class. */
  catalog: boolean;
  gameTest: boolean;
  audit: boolean;
  publish: boolean;
  warmSession: boolean; // can keep one editor process across operations
  /** The backend can type wildcard pins natively (`pin_types` on bp_apply nodes). */
  pinTypes: boolean;
  /** bp_apply node kind `std_macro` (engine StandardMacros instances) AND pinTypes: loops lower to ForEachLoop/ForLoop. */
  stdMacros: boolean;
  /** The backend types a cast's `Object` input pin itself (`cast_object_pin`). */
  castObjectPin: boolean;
  /** bp_apply feature `self_event_calls`: a self call to a custom event added in the same apply gets real pins. */
  selfEventCalls: boolean;
  /** bp_apply feature `event_meta`: an `event` node may carry `meta` ({tooltip, category, keywords}). */
  eventMeta: boolean;
  /** `backend_info.capabilities.classManagerRows` (backend 2.5.0) AND bp_apply feature `class_manager_row`: the defaults spec may carry `class_manager_row`. */
  classManagerRows: boolean;
  /** `backend_info.capabilities.assetOps` (backend 2.6.0) AND the `bp_asset_ops` tool: the operations it supports (`rename`, `delete`, `reparent`, `recreate`); empty when absent. */
  assetOps: string[];
  /** `backend_info.capabilities.publishDeletes` (backend 2.6.0) AND `bp_publish`: `delete_removed` deletes removed files from the mod. */
  publishDeletes: boolean;
  /** `backend_info.capabilities.gameplayTags` (backend 2.6.0): reflect can list gameplay tags and the tag ini is managed. */
  gameplayTags: boolean;
  /** `backend_info.capabilities.liveTags` (backend 2.6.0) AND `bp_publish`: a publish with the Mod Editor open registers the mod's gameplay tags in it before it reloads the rows. */
  liveTags: boolean;
  /** `backend_info.capabilities.reflectDefaults` (backend 2.6.0): reflect function meta carries `defaults`. */
  reflectDefaults: boolean;
  /** `classManagerRows` AND bp_apply feature `class_manager_row_tag` (backend 2.6.0): `class_manager_row` may carry `gameplay_tag`. */
  classManagerRowTag: boolean;
  /** bp_apply feature `variable_defaults`: the spec may carry `variable_defaults` to change or drop the default of an existing variable in place. */
  variableDefaults: boolean;
  /** bp_apply feature `function_graphs`: own functions with access flags and same-name replace. */
  functionGraphs: boolean;
  bpApplyFeatures: string[];
  nodeKinds: string[];
  /** `mod_audit` can audit the stage (false in Phase 1: it audits the real mod). */
  stageAudit: boolean;
  /** Raw container report of the backend, kept for `abfc doctor` only (null when the backend has no `backend_info`). */
  backendContainerTypes: { array: boolean; set: boolean; map: boolean } | null;
}
export interface BackendInfo {
  id: "bp_apply" | "import_nodes" | "paste_graph";
  serverVersion: string;
  /** null = the backend has no `backend_info` tool. */
  protocol: number | null;
  engineVersion: string | null;
  editorRoot: string | null;
  headlessDir: string | null;
  documentsDir: string | null;
  /** Computed by abfc from `headlessDir`. */
  headlessDirHasSpace: boolean;
  /** `abfc_extensions.features`, empty when the tool is absent. */
  extensions: string[];
  capabilities: BackendCapabilities;
}

export interface ProfileFunctionRef { class: string; name: string }
export type ProfileEqualKey = "object" | "name" | "string" | "int" | "real" | "bool" | "byte";
export interface Profile {
  id: string;
  engineVersion: string;
  buildTag: string;
  modEditorVersion: string;
  epicAppVersion: string | null;
  editorDisplayName: string;
  exeRelPath: string;
  programFilesGlob: string;
  modsFolderName: string;
  minProtocol: number;
  defaultHeadlessSubdir: string;
  /** Engine classes (`/Script/...`) that `abfc init` lists in `stubs.scriptClasses` of a new project. */
  initScriptClasses: string[];
  pins: {
    execute: string; then: string; else: string; condition: string; castFailed: string; castObject: string;
    returnValue: string; self: string; isValidObject: string; arrayLengthArray: string; getItemArray: string;
    getItemIndex: string; getItemOutput: string; opA: string; opB: string;
  };
  nodeClasses: {
    callFunction: string; callArrayFunction: string; getArrayItem: string; breakStruct: string; makeStruct: string; formatText: string; variableGet: string;
    variableSet: string; customEvent: string; branch: string; dynamicCast: string; comment: string;
  };
  functions: {
    isValid: ProfileFunctionRef; arrayLength: ProfileFunctionRef; lessInt: ProfileFunctionRef; addInt: ProfileFunctionRef;
    /** Converts a Format Text result to a string (template literal where a string is expected). */
    textToString: ProfileFunctionRef;
    equal: Record<ProfileEqualKey, ProfileFunctionRef>;
    notEqual: Record<ProfileEqualKey, ProfileFunctionRef>;
  };
  castObjectPinType: string;
  variableFlags: { base: number; transient: number };
  filterOverrides: Array<{ parent?: string; member?: string; cast?: string; reason: string }>;
  knownLimits: string[];
}

export interface AssetPlan {
  asset: string;
  /** The asset does not exist in the stage yet: the first `bp_apply` spec creates it (`create: { class, parent, if_missing: true }`). */
  create?: { class: "Blueprint" | "WidgetBlueprint"; parent: string };
  /** A mod-defined struct (UserDefinedStruct) to create with these fields (`name` is the full member name `<Field>_<i>_<GUID>`); units and variables are empty. */
  struct?: { fields: IrVariable[] };
  graphNodes: Record<string /* graph */, Array<{ name: string; pos: [number, number] }>>;
  variables: IrVariable[];
  units: Array<{ unit: IrUnit; removeNodes: string[]; origin: [number, number] }>;
  classMeta: Record<string, string>;
  /** Real entry node name of units that are not in this plan but are the target of a cross wire of a planned unit (from the manifest). */
  entryNames?: Record<string, string>;
  /** Manifest units no longer in the TS whose stage nodes are removed (nodes include the tag comment). */
  removeUnits?: Array<{ id: string; graph: string; nodes: string[] }>;
  /** Orphan ownership tag comments of units that stay as they are (left by an earlier re-plan); removed in the main pass. */
  removeTags?: Array<{ graph: string; nodes: string[] }>;
  /** Manifest units dropped without touching the stage (never applied, or adopted hand-made nodes). */
  forgetUnits?: string[];
  /** TS wins: hand-made nodes (no unit of abfc's) removed from a graph of a non-hybrid class. */
  removeGraphNodes?: Array<{ graph: string; nodes: string[] }>;
  /** TS wins: member variables removed from the asset (hand-made ones of a non-hybrid class, and own fields gone from the TS). */
  removeVariables?: string[];
  /** Own fields declared in the asset whose TS default differs from the manifest: the new text, or null to drop the default. */
  variableDefaults?: Record<string, string | null>;
  /** Function graphs to create (signature only; the body comes in graphs). A name also in removeFunctions is replaced. */
  functions?: Array<{ name: string; inputs: IrParam[]; outputs: IrParam[]; access: "public" | "protected" | "private"; /** Overrides the parent function of this name (class path of its declaring class). */ override?: string }>;
  /** TS wins: hand-made function graphs removed from a non-hybrid class. */
  removeFunctions?: string[];
  /** Own fields gone from the TS that were not in the asset any more: only the manifest record is dropped. */
  forgetVariables?: string[];
  /** Class defaults to apply in pass 5 (plan item `defaults`); present only when they changed. */
  defaults?: { classPath: string; values: Record<string, string>; hash: string; classManagerRow?: string; director?: { asset: string; classPath: string; tag?: string } };
}
export interface ApplyPlan { mod: string; assets: AssetPlan[] }

export interface TestStepRecord { step: Record<string, unknown>; span: Span; knownIssue?: string }
/** `liveHud`: the test needs the live HUD (not available hidden); it is skipped and listed with its manual `checklist`. */
/** `map`/`timeoutSeconds`: `test(name, { map, timeout }, body)` runs on that map (default the backend's empty map) with that run timeout. */
export interface TestCase {
  name: string;
  file: string;
  span: Span;
  steps: TestStepRecord[];
  liveHud?: { checklist: string[] };
  map?: string;
  timeoutSeconds?: number;
}
