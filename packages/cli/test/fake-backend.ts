// A fake `Backend` for the CLI end-to-end tests: an in-memory stage of Blueprint assets that renders real-looking T3D
// exports, so that the planner, the drift check, the fallback route and the manifests run on genuine data.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capabilitiesFrom } from "@abfc/backend";
import type {
  AssetOp,
  AssetOpsResult,
  AssetSnapshot,
  AuditReport,
  Backend,
  BpApplyResult,
  CatalogResult,
  CompileMessage,
  CompileReport,
  GameTestReport,
  PublishGrant,
  PublishResult,
  RawBackendInfo,
  ReflectData,
  ReflectRequest,
  ReflectResult,
  StageReport,
  StageStatus,
} from "@abfc/backend";
import { loadProfile } from "@abfc/env";
import { parseBpType, parseExport, pinObjectText, sha256 } from "@abfc/ir";
import type { BackendInfo, IrParam, T3dNode } from "@abfc/ir";
import { ALL_TOOLS, fixInfo } from "./helpers.js";

const profile = loadProfile();
const CLS = profile.nodeClasses;

/** The only asset of the fake mod. */
export const RELAY_ASSET = "/TestMod/Relay/BP_Relay";

const EXT_FEATURES = ["reflect", "compile_node_refs", "bp_read_seconds"];
const EXEC_PINS = new Set(["execute", "then", "else", "CastFailed", "NotValid", "Valid", "Completed", "LoopBody", "Exec", "Execute", "Break"]);

interface FPin {
  id: string;
  name: string;
  dir: "in" | "out";
  category: string;
  sub: string;
  /** Inner path of `PinSubCategoryObject`. */
  obj: string | null;
  container: string;
  def: string | null;
  defObj: string | null;
  links: Array<{ node: string; pinId: string }>;
}

interface FNode {
  name: string;
  cls: string;
  graph: string;
  /** Non-pin lines of the node body (position, references, comment text). */
  head: string[];
  pins: FPin[];
}

interface FAsset {
  path: string;
  variables: Array<{ name: string; type: string; default?: string }>;
  nodes: FNode[];
  /** Set for a UserDefinedStruct: its members as the apply spec gave them. */
  structFields?: Array<{ name: string; type: string }>;
  /** Parent class path of a Blueprint (set by `create` and `reparent`); rendered as `ParentClass=` when known. */
  parent?: string;
  /** Second-level subobjects that are not EdGraphs (components, widget tree, timeline templates), rendered verbatim after the graphs. */
  extraBlocks?: string[];
}

interface SpecNode {
  id: string;
  k: string;
  name?: string;
  class?: string;
  function?: string;
  target?: string;
  props?: string[];
  pos: [number, number];
  set?: Record<string, string>;
  objects?: Record<string, string>;
  pin_types?: Record<string, string>;
}
interface SpecGraph {
  graph: string;
  remove?: string[];
  add: SpecNode[];
  wires?: Array<[string, string]>;
}
interface Spec {
  asset: string;
  create?: { class: string; parent: string; if_missing?: boolean };
  variables?: Array<{ name: string; type: string; flags: number; default?: string }>;
  variable_defaults?: Record<string, string | null>;
  remove_variables?: string[];
  remove_functions?: string[];
  functions?: Array<{ name: string; inputs?: IrParam[]; outputs?: IrParam[]; access?: string }>;
  struct_fields?: Array<{ name: string; friendly: string; guid: string; type: string }>;
  graphs?: SpecGraph[];
  raw?: Array<{ kind: "graph"; graph: string; text: string } | { kind: "python"; code: string }>;
  class_manager_row?: { asset_path: string; class_path: string };
}

export interface RecordedCall {
  /** MCP tool name: `backend_info`, `staging_sync`, `staging_status`, `bp_read`, `bp_apply`, `bp_compile_report`, `bp_game_test`, `mod_audit`. */
  tool: string;
  /** `bp_apply` label (`main`, `main-a`, `main-b`, `tags`). */
  label?: string;
  specs?: Array<Record<string, any>>;
}

export interface FakeBackendOptions {
  /** The backend lists `backend_info` in the shape of the wildcard-pins branch (default false: an older backend without it). */
  backendInfo?: boolean;
  /**
   * Like a backend without backend-override-blueprint-events.patch: an `override` of an event declared in a Blueprint class (not
   * /Script/) comes out as a custom event named `<function>_1`, as Unreal turns an event the Actor template scratch cannot resolve.
   */
  overrideAsCustomEvent?: boolean;
  /** The initial asset holds a hand-made `UpdateTarget` event (default true). */
  handMadeEvent?: boolean;
  /** `staging_sync` with discardChanges (a resync) fails; the first sync of a missing stage still works (default false). */
  failResync?: boolean;
  /** Further Blueprint assets (paths) the mod holds from the start, empty: they are in the stage after every resync. */
  emptyAssets?: string[];
  /** `backend_info` reports the stageAudit capability (default false: mod_audit audits the real mod). */
  stageAudit?: boolean;
  /** The initial asset also holds a hand-made engine override event (`ReceiveTick`, calling HideAll). */
  overrideEvent?: boolean;
  /** Advertise the `std_macro` node kind (default: true only with `backendInfo`). */
  stdMacros?: boolean;
  /** The initial asset also holds the unlinked node `SPARE_NODE` (to be removed with `--remove-node`). */
  spareNode?: boolean;
  /**
   * The backend has the bp_apply feature `self_event_calls` (default true). Without it the fake fails like the old real one: a call
   * to a custom event added in the same apply has no pins, so the apply fails with a `[spec:<id>]` error and rolls back.
   */
  selfEventCalls?: boolean;
  /** With `selfEventCalls: false`, still advertise the feature (a backend that lies), so the apply failure itself can be tested. */
  advertiseSelfEventCalls?: boolean;
  /** The backend has the bp_apply feature `event_meta` (default false: documented events get no tooltip and ABFC2071). */
  eventMeta?: boolean;
  /** The backend has the bp_apply feature `struct_fields` (UserDefinedStruct in `createKinds`; default false). */
  structs?: boolean;
  /** The backend writes class-manager rows (`classManagerRows` capability, backend 2.5.0; default false). */
  classManagerRows?: boolean;
  /** The backend has `bp_asset_ops` with these operations (backend 2.6.0; default none). `true` = all four. */
  assetOps?: boolean | string[];
  /** The backend can delete removed files from the mod on publish (`publishDeletes`; default false). */
  publishDeletes?: boolean;
  /** The backend lists/creates gameplay tags (`gameplayTags`; default false). */
  gameplayTags?: boolean;
  /** A publish with the Mod Editor open registers the mod's gameplay tags in it (`liveTags`; default false). */
  liveTags?: boolean;
  /** The backend returns `defaults` in reflect function meta (`reflectDefaults`; default false). */
  reflectDefaults?: boolean;
  /** The class-manager row may carry `gameplay_tag` (`classManagerRowTag`; needs `classManagerRows`; default false). */
  classManagerRowTag?: boolean;
  /** The backend has the bp_apply feature `variable_defaults` (`variableDefaults` capability; default false). */
  variableDefaults?: boolean;
  /** The backend has the bp_apply feature `function_graphs` (`functionGraphs` capability; default true). */
  functionGraphs?: boolean;
  /**
   * Name nodes like Unreal: unique only inside their graph (`<Class>_<n>` counted per asset, graph and class from 9001; a function
   * graph's entry/result are `K2Node_FunctionEntry_0`/`K2Node_FunctionResult_0`), and write `final_<i>.t3d` with the graphs other than
   * the EventGraph in reverse order (the real compile T3D lists graphs in another order than export.t3d). Default false.
   */
  perGraphNames?: boolean;
  /** The raw catalog document `catalog()` returns; the `catalog` tool and capability exist only when this is set. */
  catalog?: unknown;
  /** The reflect data `reflect()` returns for a request (default: reflect throws, as the fake never reflects). */
  reflectData?: (r: ReflectRequest) => ReflectData;
}

const ALL_ASSET_OPS = ["rename", "delete", "reparent", "recreate"];

/** Family of a parent class path, like the backend's reparent check (Actor / ActorComponent / UserWidget / other object). */
export function parentFamily(parent: string): "actor" | "component" | "widget" | "object" {
  if (/\.(ActorComponent|SceneComponent|PrimitiveComponent|StaticMeshComponent)$/.test(parent)) return "component";
  if (/\.UserWidget$/.test(parent)) return "widget";
  if (/\.(Actor|Pawn|Character|Info|GameModeBase|GameMode|PlayerController)$/.test(parent)) return "actor";
  return "object";
}

const fileOfAsset = (path: string): string => `Content/${path.split("/").slice(2).join("/")}.uasset`;

/** Name of the unlinked node that `spareNode` adds. */
export const SPARE_NODE = "K2Node_CallFunction_77";

const shortOf = (cls: string): string => cls.slice(cls.lastIndexOf(".") + 1);
const pinId = (node: string, name: string, dir: string): string => sha256(`${node}|${name}|${dir}`).slice(0, 32).toUpperCase();

function getPin(n: FNode, name: string, dir: "in" | "out"): FPin {
  let p = n.pins.find((x) => x.name === name && x.dir === dir);
  if (p === undefined) {
    p = {
      id: pinId(n.name, name, dir),
      name,
      dir,
      category: EXEC_PINS.has(name) ? "exec" : "misc",
      sub: "",
      obj: null,
      container: "None",
      def: null,
      defObj: null,
      links: [],
    };
    n.pins.push(p);
  }
  return p;
}

function typePin(p: FPin, type: string): void {
  const t = parseBpType(type);
  p.category = t.cat;
  p.sub = t.sub;
  p.obj = t.path;
  p.container = t.container;
}

function wildcardPin(p: FPin, container: string): void {
  p.category = "wildcard";
  p.sub = "";
  p.obj = null;
  p.container = container;
}

/** The pins that stay wildcards until a type is given (design 7.3: casts, array functions, array item). */
function wildcardPins(cls: string): Array<{ name: string; dir: "in" | "out"; container: string }> {
  if (cls === CLS.dynamicCast) return [{ name: "Object", dir: "in", container: "None" }];
  if (cls === CLS.callArrayFunction) return [{ name: "TargetArray", dir: "in", container: "Array" }];
  if (cls === CLS.getArrayItem) {
    return [
      { name: "Array", dir: "in", container: "Array" },
      { name: "Output", dir: "out", container: "None" },
    ];
  }
  return [];
}

const objectKind = (category: string): string => (category === "struct" ? "struct" : category === "byte" ? "enum" : "object");

function renderPin(p: FPin): string {
  const obj = p.obj === null ? "None" : `"${pinObjectText(objectKind(p.category), p.obj, {})}"`;
  const parts = [`PinId=${p.id}`, `PinName="${p.name}"`];
  if (p.dir === "out") parts.push('Direction="EGPD_Output"');
  parts.push(
    `PinType.PinCategory="${p.category}"`,
    `PinType.PinSubCategory="${p.sub}"`,
    `PinType.PinSubCategoryObject=${obj}`,
    "PinType.PinSubCategoryMemberReference=()",
    "PinType.PinValueType=()",
    `PinType.ContainerType=${p.container}`,
    "PinType.bIsReference=False",
  );
  if (p.links.length > 0) parts.push(`LinkedTo=(${p.links.map((l) => `${l.node} ${l.pinId}`).join(",")},)`);
  if (p.def !== null) parts.push(`DefaultValue="${p.def}"`);
  if (p.defObj !== null) parts.push(`DefaultObject="${p.defObj}"`);
  parts.push("PersistentGuid=00000000000000000000000000000000", "bHidden=False");
  return `CustomProperties Pin (${parts.join(",")},)`;
}

function renderVarType(type: string): string {
  const t = parseBpType(type);
  const obj = t.path === null ? "None" : `"${pinObjectText(objectKind(t.cat), t.path, {})}"`;
  return `PinCategory="${t.cat}",PinSubCategory="${t.sub}",PinSubCategoryObject=${obj},ContainerType=${t.container}`;
}

/** The editor export (copy format) of an asset, laid out like the real one: class stubs block, then the body block per graph. */
function renderAsset(a: FAsset, opts: { reverseGraphs?: boolean } = {}): string {
  const name = a.path.slice(a.path.lastIndexOf("/") + 1);
  const bp = `${a.path}.${name}`;
  const others = [...new Set(a.nodes.map((n) => n.graph))].filter((g) => g !== "EventGraph");
  const graphs = ["EventGraph", ...(opts.reverseGraphs ? others.reverse() : others)];
  const out = [`Begin Object Class=/Script/Engine.Blueprint Name="${name}" ExportPath="/Script/Engine.Blueprint'${bp}'"`];
  a.variables.forEach((v, i) => {
    const def = v.default !== undefined ? `,DefaultValue="${v.default.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : "";
    out.push(`   NewVariables(${i})=(VarName="${v.name}",VarType=(${renderVarType(v.type)}),PropertyFlags=0${def})`);
  });
  for (const g of graphs) {
    const nodes = a.nodes.filter((n) => n.graph === g);
    out.push(`   Begin Object Class=/Script/Engine.EdGraph Name="${g}" ExportPath="/Script/Engine.EdGraph'${bp}:${g}'"`);
    for (const n of nodes) {
      out.push(`      Begin Object Class=${n.cls} Name="${n.name}" ExportPath="${n.cls}'${bp}:${g}.${n.name}'"`);
      out.push("      End Object");
    }
    out.push("   End Object");
    out.push(`   Begin Object Name="${g}" ExportPath="/Script/Engine.EdGraph'${bp}:${g}'"`);
    for (const n of nodes) {
      out.push(`      Begin Object Name="${n.name}" ExportPath="${n.cls}'${bp}:${g}.${n.name}'"`);
      for (const h of n.head) out.push(`         ${h}`);
      for (const p of n.pins) out.push(`         ${renderPin(p)}`);
      out.push("      End Object");
    }
    out.push("   End Object");
  }
  for (const block of a.extraBlocks ?? []) out.push(block);
  if (a.parent !== undefined) out.push(`   ParentClass=/Script/CoreUObject.Class'${a.parent}'`);
  out.push("End Object", "");
  return out.join("\n");
}

function fromT3d(n: T3dNode, graph: string): FNode {
  return {
    name: n.name,
    cls: n.cls,
    graph,
    head: [...n.head],
    pins: n.pins.map((p) => ({
      id: p.id,
      name: p.name,
      dir: p.dir,
      category: p.category,
      sub: p.subCategory,
      obj: p.subCategoryObject,
      container: p.container,
      def: p.defaultValue,
      defObj: p.defaultObject,
      links: p.links.map((l) => ({ node: l.node, pinId: l.pinId })),
    })),
  };
}

function handMade(name: string, cls: string, head: string[], x: number, y: number): FNode {
  return { name, cls, graph: "EventGraph", head: [`NodePosX=${x}`, `NodePosY=${y}`, ...head], pins: [] };
}

function connect(from: FNode, fromPin: string, to: FNode, toPin: string): void {
  const a = getPin(from, fromPin, "out");
  const b = getPin(to, toPin, "in");
  a.links.push({ node: to.name, pinId: b.id });
  b.links.push({ node: from.name, pinId: a.id });
}

/** The asset as it is in the real mod: two hand-made events, each calling HideAll. */
function initialAsset(withUpdateTarget: boolean, o: FakeBackendOptions = {}): FAsset {
  const nodes: FNode[] = [];
  const events: Array<[string, string, number]> = [["K2Node_CustomEvent_1", "OtherEvent", 400]];
  if (withUpdateTarget) events.unshift(["K2Node_CustomEvent_0", "UpdateTarget", 0]);
  for (const [evName, fn, y] of events) {
    const idx = evName.slice(evName.lastIndexOf("_") + 1);
    const ev = handMade(evName, CLS.customEvent, [`CustomFunctionName="${fn}"`], 0, y);
    const call = handMade(`K2Node_CallFunction_${idx}`, CLS.callFunction, ['FunctionReference=(MemberName="HideAll")'], 300, y);
    getPin(ev, "then", "out");
    getPin(call, "execute", "in");
    getPin(call, "then", "out");
    connect(ev, "then", call, "execute");
    nodes.push(ev, call);
  }
  if (o.overrideEvent === true) {
    const ev = handMade(
      "K2Node_Event_5",
      "/Script/BlueprintGraph.K2Node_Event",
      [`EventReference=(MemberParent="/Script/CoreUObject.Class'/Script/FakeEngine.Actor'",MemberName="ReceiveTick")`, "bOverrideFunction=True"],
      0,
      800,
    );
    const call = handMade("K2Node_CallFunction_5", CLS.callFunction, ['FunctionReference=(MemberName="HideAll")'], 300, 800);
    getPin(ev, "then", "out");
    getPin(call, "execute", "in");
    getPin(call, "then", "out");
    connect(ev, "then", call, "execute");
    nodes.push(ev, call);
  }
  if (o.spareNode === true) {
    const spare = handMade(SPARE_NODE, CLS.callFunction, ['FunctionReference=(MemberName="HideAll")'], 700, 400);
    getPin(spare, "execute", "in");
    nodes.push(spare);
  }
  return { path: RELAY_ASSET, variables: [], nodes };
}

export class FakeBackend implements Backend {
  readonly calls: RecordedCall[] = [];
  /** Python code of the raw `python` entries (the class-defaults pass), in order. */
  readonly pythonCode: Array<{ asset: string; code: string }> = [];
  /** Folder of the run folders (`export.t3d`, `final_<i>.t3d`); real files, below the system temp folder. */
  readonly root: string;
  closed = 0;
  /** Every `bp_read` after a resync (`staging_sync` with discardChanges) fails (default false). */
  failReadsAfterResync = false;
  private resynced = false;
  /** Makes the apply that creates `<unit>_<irId>` fail with this message (the failing node is named in the compile error). */
  compileError: { irId: string; unit?: string; message: string } | null = null;
  /** Messages of `bp_compile_report`; any error makes the report unclean. */
  reportMessages: CompileReport["messages"] = [];
  /** Per `bp_game_test` call (in order, counted from `gameTestCalls`): the step indexes that fail. */
  gameTestFailures: number[][] = [];
  gameTestCalls = 0;
  auditOk = true;
  /** A rename or reparent edits the nodes of the asset it renames/reparents (a pin default changes), as Unreal's fixup does (default false). */
  opsEditNodes = false;
  /** Extra staged files that `staging_status` lists as changed (files no unit of the project owns). */
  extraChanged: string[] = [];
  /** `staging_status` lists no changed files at all (nothing is staged to publish). */
  hideChanged = false;
  /** A resync keeps the assets as they are (simulates re-syncing from a published mod that holds the built graphs). */
  keepAssetsOnSync = false;
  /** What `publish` returns; a test sets it to script a refusal. */
  publishResult: PublishResult = {
    ok: true,
    published: ["Content/Relay/BP_Relay.uasset"],
    refused: null,
    message: "published",
    backup: "backups/fake",
    route: "file-copy",
    compileErrors: [],
    conflicts: [],
    deleted: [],
    restored: null,
    editor: "closed",
    editorReason: null,
    reloadedInPlace: [],
    dirtyAfter: [],
    reloadedReferencers: [],
    skippedDirty: [],
    dirtyPublished: [],
    compileErrorsAfter: [],
    tagsRegistered: [],
    tagsUnregistered: [],
    tagsStrategy: null,
    tagsError: null,
    raw: {},
  };
  /** The arguments of every `publish` call (the `bp_publish` calls also appear in `calls`). */
  readonly publishCalls: Array<{ mod: string; assets: string[]; grant: PublishGrant; deleteRemoved?: boolean }> = [];
  /** Every `bp_asset_ops` call (the ops as sent), in order. */
  readonly assetOpsCalls: AssetOp[][] = [];
  /** The next `bp_asset_ops` call fails as a whole (nothing changes) with this error; cleared after use. */
  assetOpsError: string | null = null;
  /** The `bp_asset_ops` call whose number (1-based, counting from the first call of the run) equals this fails as a whole; cleared after use. */
  assetOpsFailCall: number | null = null;
  /** Files of the stage that are gone from it but still in the mod (deleted or renamed-away assets); `staging_status` lists them as `removed`. A resync forgets them. */
  readonly removedFiles = new Set<string>();
  /** Files `staging_status` lists as conflicts (the real mod changed since the sync); a resync (`discardChanges`) clears them. */
  stageConflicts: string[] = [];
  /** Files `staging_status` lists as stale (untouched in the stage, saved in the real mod since the sync); a resync clears them. */
  stageStale: string[] = [];
  /** The raw JSON of the audit result. */
  auditRaw: unknown = { audited_copy: "stage" };
  /** Pretend the server runs a warm session: read, apply and compile results say `warm: true` (`lastWarm`). */
  warm = false;
  lastWarm = false;
  /** Class of every class-manager row the fake stage holds (row asset path -> class path); a resync forgets them. */
  readonly rowClasses = new Map<string, string>();
  /** Scripts the `rows` of the next `bp_apply` results (instead of the rows derived from the specs); `null` = derive. */
  scriptedRows: Array<{ asset: string; created: boolean; changed: boolean }> | null = null;

  private readonly infoValue: BackendInfo;
  private readonly withUpdateTarget: boolean;
  private readonly options: FakeBackendOptions;
  private assets = new Map<string, FAsset>();
  private staged = false;
  private syncs = 0;
  private counter = 9000;
  private runs = 0;
  private changed = new Set<string>();
  /** The mod as published (set by `markPublished`): a resync restores this instead of the initial assets. */
  private published: Map<string, FAsset> | null = null;
  /** The class-manager rows of the published mod (set by `markPublished`), restored by a resync like the assets. */
  private publishedRows: Map<string, string> | null = null;

  constructor(o: FakeBackendOptions = {}) {
    const withInfo = o.backendInfo === true;
    this.withUpdateTarget = o.handMadeEvent !== false;
    this.options = o;
    this.root = mkdtempSync(join(tmpdir(), "abfc-fake-backend-"));
    const baseTools = withInfo ? ALL_TOOLS : ALL_TOOLS.filter((t) => t !== "backend_info");
    const tools = o.catalog !== undefined ? [...baseTools, "catalog"] : baseTools;
    const capabilities = capabilitiesFrom(tools, withInfo ? (fixInfo() as RawBackendInfo) : null, { features: EXT_FEATURES });
    capabilities.stdMacros = o.stdMacros ?? capabilities.stdMacros;
    capabilities.stageAudit = o.stageAudit === true;
    capabilities.selfEventCalls = o.selfEventCalls !== false || o.advertiseSelfEventCalls === true;
    capabilities.eventMeta = o.eventMeta === true;
    capabilities.classManagerRows = o.classManagerRows === true;
    capabilities.assetOps = o.assetOps === true ? [...ALL_ASSET_OPS] : Array.isArray(o.assetOps) ? [...o.assetOps] : [];
    capabilities.publishDeletes = o.publishDeletes === true;
    capabilities.gameplayTags = o.gameplayTags === true;
    capabilities.liveTags = o.liveTags === true;
    capabilities.reflectDefaults = o.reflectDefaults === true;
    capabilities.classManagerRowTag = o.classManagerRowTag === true && o.classManagerRows === true;
    capabilities.variableDefaults = o.variableDefaults === true;
    capabilities.functionGraphs = o.functionGraphs !== false;
    if (o.functionGraphs === false) capabilities.bpApplyFeatures = capabilities.bpApplyFeatures.filter((x) => x !== "function_graphs");
    if (o.structs === true) capabilities.createKinds = [...capabilities.createKinds, "UserDefinedStruct"];
    if (o.structs === true) capabilities.createKinds = [...capabilities.createKinds, "UserDefinedStruct"];
    this.infoValue = {
      id: "bp_apply",
      serverVersion: "fake-1",
      protocol: withInfo ? 1 : null,
      engineVersion: null,
      editorRoot: null,
      headlessDir: withInfo ? "C:\\abfc-headless" : null,
      documentsDir: withInfo ? "C:\\Users\\Jane\\Documents" : null,
      headlessDirHasSpace: false,
      extensions: EXT_FEATURES,
      capabilities,
    };
  }

  /** Updates the backend: it has (or loses) the bp_apply feature `event_meta` from the next session on. */
  setEventMeta(on: boolean): void {
    this.infoValue.capabilities.eventMeta = on;
  }

  /** Updates the backend: it has (or loses) the bp_apply node kind `std_macro` from the next session on. */
  setStdMacros(on: boolean): void {
    this.infoValue.capabilities.stdMacros = on;
  }

  /** Publishes the stage as it is now: the mod holds these assets from now on, and a resync restores them (published nodes survive it). */
  markPublished(): void {
    this.published = structuredClone(this.assets);
    this.publishedRows = new Map(this.rowClasses);
    this.changed.clear();
  }

  /** Paths of the Blueprint assets the stage holds. */
  stageAssets(): string[] {
    return [...this.assets.keys()];
  }

  /** The parent class path of a stage asset (set by create/reparent), or undefined. */
  parentOf(asset: string): string | undefined {
    return this.assets.get(asset)?.parent;
  }

  /** The recorded `bp_apply` labels, in order. */
  applyLabels(): string[] {
    return this.calls.filter((c) => c.tool === "bp_apply").map((c) => c.label ?? "");
  }

  tools(): string[] {
    return this.calls.map((c) => c.tool);
  }

  private editFirstPin(a: { nodes: FNode[] }): void {
    const p = a.nodes.flatMap((n) => n.pins).find((x) => x.dir === "in" && x.name !== "execute");
    if (p !== undefined) p.def = `${p.def ?? ""}7`;
  }

  /** Edits a pin default of a node in the stage, as a user would in the editor. */
  setPinDefault(asset: string, node: string, pin: string, value: string): void {
    const n = this.assets.get(asset)?.nodes.find((x) => x.name === node);
    const p = n?.pins.find((x) => x.name === pin);
    if (p === undefined) throw new Error(`fake stage: no pin ${node}.${pin} in ${asset}`);
    p.def = value;
  }

  /** Adds an asset by hand (as the Mod Editor would) whose only member is a variable of `type`. */
  addHandMadeReference(asset: string, referenced: string): void {
    const name = referenced.slice(referenced.lastIndexOf("/") + 1);
    this.assets.set(asset, { path: asset, variables: [{ name: "Ref", type: `object:${referenced}.${name}_C` }], nodes: [] });
    this.mirrorFiles();
  }

  /** Adds a member variable by hand (as the Mod Editor would). */
  /** Changes the type of an existing variable in the stage (the Mod Editor retyped it, for example after renaming the class it points at). */
  setVariableType(asset: string, name: string, type: string): void {
    const v = this.assets.get(asset)?.variables.find((x) => x.name === name);
    if (v === undefined) throw new Error(`fake stage: no variable ${name} in ${asset}`);
    v.type = type;
  }

  addHandMadeVariable(asset: string, name: string, type: string): void {
    const a = this.assets.get(asset);
    if (a === undefined) throw new Error(`fake stage: no asset ${asset}`);
    a.variables.push({ name, type });
  }

  /** Adds the second-level subobjects a real export has next to the graphs: a component tree, a widget tree and a timeline template (none of them graph nodes). */
  addNonGraphParts(asset: string): void {
    const a = this.assets.get(asset);
    if (a === undefined) throw new Error(`fake stage: no asset ${asset}`);
    const block = (cls: string, name: string, childCls: string, child: string): string[] => [
      `   Begin Object Class=${cls} Name="${name}" ExportPath="x"`,
      `      Begin Object Class=${childCls} Name="${child}" ExportPath="x"`,
      "      End Object",
      "   End Object",
    ];
    a.extraBlocks = [
      ...block("/Script/Engine.SimpleConstructionScript", "SimpleConstructionScript", "/Script/Engine.SCS_Node", "SCS_Node_0"),
      ...block("/Script/UMG.WidgetTree", "WidgetTree", "/Script/UMG.TextBlock", "NameText"),
      ...block("/Script/Engine.TimelineTemplate", "Fade_Template", "/Script/Engine.CurveFloat", "CurveFloat_0"),
    ];
  }

  /** Adds a function graph by hand: a function entry node in a graph of that name. */
  addHandMadeFunction(asset: string, graph: string): string {
    const a = this.assets.get(asset);
    if (a === undefined) throw new Error(`fake stage: no asset ${asset}`);
    const entry: FNode = { name: `K2Node_FunctionEntry_${++this.counter}`, cls: "/Script/BlueprintGraph.K2Node_FunctionEntry", graph, head: ["NodePosX=0", "NodePosY=0"], pins: [] };
    a.nodes.push(entry);
    return entry.name;
  }

  /**
   * Adds what Unreal itself leaves in an exported Blueprint next to the event graph: the intermediate stub graphs of the compiler
   * (`ReceiveBeginPlay`, `Bump`), each with a function entry and a call to the ubergraph, all flagged `bIsIntermediateNode=True`.
   * The two graphs hold nodes of the same name, as the real export does. Returns the graph names.
   */
  addIntermediateStubs(asset: string): string[] {
    const a = this.assets.get(asset);
    if (a === undefined) throw new Error(`fake stage: no asset ${asset}`);
    const inter = ["bIsIntermediateNode=True", "NodePosX=0", "NodePosY=0"];
    const graphs = ["ReceiveBeginPlay", "Bump"];
    for (const graph of graphs) {
      a.nodes.push(
        { name: "K2Node_FunctionEntry_0", cls: "/Script/BlueprintGraph.K2Node_FunctionEntry", graph, head: [...inter], pins: [] },
        { name: "K2Node_CallFunction_0", cls: CLS.callFunction, graph, head: [...inter, 'FunctionReference=(MemberName="ExecuteUbergraph_Stub",bSelfContext=True)'], pins: [] },
      );
    }
    return graphs;
  }

  /** Adds a custom event and a call node after it to the event graph by hand; returns both node names. */
  addHandMadeEvent(asset: string, eventName: string): string[] {
    const a = this.assets.get(asset);
    if (a === undefined) throw new Error(`fake stage: no asset ${asset}`);
    const idx = ++this.counter;
    const ev = handMade(`K2Node_CustomEvent_${idx}`, CLS.customEvent, [`CustomFunctionName="${eventName}"`], 0, 1200 + idx);
    const call = handMade(`K2Node_CallFunction_${idx}`, CLS.callFunction, ['FunctionReference=(MemberName="HideAll")'], 300, 1200 + idx);
    getPin(ev, "then", "out");
    getPin(call, "execute", "in");
    getPin(call, "then", "out");
    connect(ev, "then", call, "execute");
    a.nodes.push(ev, call);
    return [ev.name, call.name];
  }

  /** Names of the variables of an asset, in the stage. */
  variableNames(asset: string): string[] {
    return (this.assets.get(asset)?.variables ?? []).map((v) => v.name);
  }

  /** The default value text of a variable of an asset, in the stage (undefined: none). */
  variableDefault(asset: string, name: string): string | undefined {
    return this.assets.get(asset)?.variables.find((v) => v.name === name)?.default;
  }

  /** The type of a variable of an asset, in the stage. */
  variableType(asset: string, name: string): string {
    return this.assets.get(asset)?.variables.find((v) => v.name === name)?.type ?? "";
  }

  /** Names of the function graphs (graphs with a function entry node) of an asset, in the stage. */
  functionNames(asset: string): string[] {
    return (this.assets.get(asset)?.nodes ?? []).filter((n) => n.cls.endsWith("K2Node_FunctionEntry")).map((n) => n.graph);
  }

  /**
   * Adds a copy of the comment node `tag` with another `ir=` hash, as an older build left behind when it re-planned a unit.
   * Returns the new node's name.
   */
  addOrphanTag(asset: string, tag: string, ir: string): string {
    const stage = this.assets.get(asset);
    const src = stage?.nodes.find((x) => x.name === tag);
    if (stage === undefined || src === undefined) throw new Error(`fake stage: no node ${tag} in ${asset}`);
    const copy: FNode = { ...src, name: `${shortOf(src.cls)}_${++this.counter}`, head: src.head.map((h) => h.replace(/ ir=[0-9a-f]+/, ` ir=${ir}`)), pins: [] };
    stage.nodes.push(copy);
    return copy.name;
  }

  /** The raw body lines of a node of the stage (position, references, comment text). */
  nodeHead(asset: string, node: string): string[] {
    return this.assets.get(asset)?.nodes.find((x) => x.name === node)?.head ?? [];
  }

  /** Number of links of the pins with the given name on a node of the stage (in and out). */
  pinLinkCount(asset: string, node: string, pin: string): number {
    const n = this.assets.get(asset)?.nodes.find((x) => x.name === node);
    return (n?.pins ?? []).filter((p) => p.name === pin).reduce((sum, p) => sum + p.links.length, 0);
  }

  /** Real names of the nodes of an asset, in the stage. */
  nodeNames(asset: string): string[] {
    return (this.assets.get(asset)?.nodes ?? []).map((n) => n.name);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  async info(): Promise<BackendInfo> {
    if (this.infoValue.protocol !== null) this.calls.push({ tool: "backend_info" });
    return this.infoValue;
  }

  async stage(_modDir: string, o: { discardChanges: boolean }): Promise<StageReport> {
    this.calls.push({ tool: "staging_sync" });
    if (o.discardChanges && this.options.failResync === true) throw new Error("fake staging_sync failed");
    if (o.discardChanges) {
      this.resynced = true;
      this.stageConflicts = [];
      this.stageStale = [];
    }
    if (!this.staged || (o.discardChanges && !this.keepAssetsOnSync)) {
      this.assets =
        this.published !== null
          ? structuredClone(this.published)
          : new Map([
              [RELAY_ASSET, initialAsset(this.withUpdateTarget, this.options)],
              ...(this.options.emptyAssets ?? []).map((p): [string, FAsset] => [p, { path: p, variables: [], nodes: [] }]),
            ]);
      this.changed.clear();
      this.rowClasses.clear();
      for (const [k, v] of this.publishedRows ?? []) this.rowClasses.set(k, v);
      this.removedFiles.clear();
    }
    this.staged = true;
    this.syncs++;
    this.mirrorFiles();
    return { mod: "TestMod", files: this.assets.size, stagingPath: join(this.root, "stage") };
  }

  async stageStatus(mod: string): Promise<StageStatus | null> {
    this.calls.push({ tool: "staging_status" });
    if (!this.staged || mod !== "TestMod") return null; // the only mod of the fake machine
    // Tests edit the fake stage in memory between commands (as the editor would on disk): the files follow.
    this.mirrorFiles();
    return {
      mod,
      stagingPath: join(this.root, "stage"),
      syncedAt: `sync-${this.syncs}`,
      changed: this.hideChanged ? [] : [...this.changed, ...this.extraChanged],
      added: ["Content/_McpTmp/Scratch.uasset"],
      removed: [...this.removedFiles],
      conflicts: [...this.stageConflicts],
      stale: [...this.stageStale],
    };
  }

  async read(_mod: string, asset: string): Promise<AssetSnapshot> {
    this.calls.push({ tool: "bp_read" });
    if (this.failReadsAfterResync && this.resynced) throw new Error("fake bp_read failed");
    this.lastWarm = this.warm;
    const a = this.assets.get(asset);
    if (a === undefined) throw new Error(`fake stage: no asset ${asset}`);
    const run = this.newRun();
    writeFileSync(join(run, "export.t3d"), renderAsset(a), "utf8");
    return { asset, run, exportPath: join(run, "export.t3d"), structure: null, seconds: 0.2 };
  }

  async applySpecs(_mod: string, specs: unknown[], o: { label: string; cacheDir: string; keepOnError?: boolean }): Promise<BpApplyResult> {
    this.calls.push({ tool: "bp_apply", label: o.label, specs: specs as Array<Record<string, any>> });
    this.lastWarm = this.warm;
    const run = this.newRun();
    const work = new Map([...this.assets].map(([k, v]) => [k, structuredClone(v)]));
    const scripted: CompileMessage[] = [];
    const undetermined: CompileMessage[] = [];
    const assets: NonNullable<BpApplyResult["assets"]> = [];
    const castTyped = this.infoValue.capabilities.castObjectPin;
    let specError: string | null = null;

    // Class-manager rows run after all Blueprints (like the real backend): created when missing, class overwritten when it differs.
    const rowStage = new Map(this.rowClasses);
    const rows: BpApplyResult["rows"] = [];
    const tagsAdded: string[] = [];
    for (const spec of specs as Spec[]) {
      const row = spec.class_manager_row;
      if (row === undefined) continue;
      const before = rowStage.get(row.asset_path);
      const tag = (row as { gameplay_tag?: string }).gameplay_tag;
      const tagChanged = tag !== undefined && this.rowTags.get(row.asset_path) !== tag;
      rows.push({ asset: row.asset_path, created: before === undefined, changed: before !== row.class_path || tagChanged, ...(tag !== undefined ? { tag } : {}) });
      if (tag !== undefined && !this.tagIni.has(tag) && !tagsAdded.includes(tag)) tagsAdded.push(tag);
      rowStage.set(row.asset_path, row.class_path);
    }

    (specs as Spec[]).forEach((spec, i) => {
      // like Unreal: a class that a spec names must exist (created by an earlier spec of the call) or loading it fails
      if (specError === null) {
        const text = JSON.stringify(spec).toLowerCase();
        for (const later of (specs as Spec[]).slice(i + 1)) {
          if (later.create !== undefined && !work.has(later.asset) && text.includes(later.asset.toLowerCase() + ".")) {
            specError = `RuntimeError: class ${later.asset}.${later.asset.split("/").pop()}_C is None`;
          }
        }
      }
      if (!work.has(spec.asset) && spec.create !== undefined) {
        work.set(spec.asset, { path: spec.asset, variables: [], nodes: [], ...(spec.create.parent ? { parent: spec.create.parent } : {}) });
      }
      if (spec.create?.class === "UserDefinedStruct") {
        const st = work.get(spec.asset)!;
        st.structFields = (spec.struct_fields ?? []).map((f) => ({ name: f.name, type: f.type }));
        assets.push({ asset: spec.asset, node_ids: {} });
        return;
      }
      if (spec.create?.class === "UserDefinedStruct") {
        const st = work.get(spec.asset)!;
        st.structFields = (spec.struct_fields ?? []).map((f) => ({ name: f.name, type: f.type }));
        assets.push({ asset: spec.asset, node_ids: {} });
        writeFileSync(join(run, `final_${i}.t3d`), "", "utf8");
        return;
      }
      const a = work.get(spec.asset);
      if (a === undefined) {
        scripted.push({ asset: spec.asset, message: `asset ${spec.asset} does not exist in the stage` });
        assets.push({ asset: spec.asset, node_ids: {} });
        return;
      }
      // like the backend's set_vars: the removals first, then the additions (a retyped variable is removed and added in one spec)
      for (const name of spec.remove_variables ?? []) {
        if (!a.variables.some((x) => x.name === name)) scripted.push({ asset: spec.asset, message: `cannot remove variable ${name}: no such variable` });
        a.variables = a.variables.filter((x) => x.name !== name);
      }
      for (const v of spec.variables ?? []) {
        if (!a.variables.some((x) => x.name === v.name)) a.variables.push({ name: v.name, type: v.type, ...(v.default !== undefined ? { default: v.default } : {}) });
      }
      for (const [name, text] of Object.entries(spec.variable_defaults ?? {})) {
        const x = a.variables.find((y) => y.name === name);
        if (x === undefined) scripted.push({ asset: spec.asset, message: `cannot set the default of unknown variable ${name}` });
        else if (text === null) delete x.default;
        else x.default = text;
      }
      // a function graph is the nodes of that graph name in the fake
      for (const name of spec.remove_functions ?? []) {
        if (!a.nodes.some((n) => n.graph === name)) scripted.push({ asset: spec.asset, message: `cannot remove function ${name}: no such function graph` });
        a.nodes = a.nodes.filter((n) => n.graph !== name);
      }
      // like the backend's step 5: the signature creates the graph with its entry (and result) node; the body comes in `graphs`
      for (const fn of spec.functions ?? []) {
        if (a.nodes.some((n) => n.graph === fn.name)) {
          scripted.push({ asset: spec.asset, message: `function graph ${fn.name} already exists` });
          continue;
        }
        const flags = fn.access === "private" ? 201588736 : fn.access === "protected" ? 201850880 : 201457664;
        const perGraph = this.options.perGraphNames === true;
        a.nodes.push({ name: perGraph ? "K2Node_FunctionEntry_0" : `K2Node_FunctionEntry_${++this.counter}`, cls: "/Script/BlueprintGraph.K2Node_FunctionEntry", graph: fn.name, head: ["NodePosX=0", "NodePosY=0", `ExtraFlags=${flags}`], pins: [] });
        if ((fn.outputs ?? []).length > 0) {
          a.nodes.push({ name: perGraph ? "K2Node_FunctionResult_0" : `K2Node_FunctionResult_${++this.counter}`, cls: "/Script/BlueprintGraph.K2Node_FunctionResult", graph: fn.name, head: ["NodePosX=900", "NodePosY=0"], pins: [] });
        }
      }
      const nodeIds: Record<string, Record<string, string>> = {};
      if (this.options.selfEventCalls === false && specError === null) specError = this.zeroPinSelfCall(a, spec);
      (spec.graphs ?? []).forEach((g, k) => {
        nodeIds[`graph:${k}`] = this.applyGraph(a, g, castTyped, scripted);
      });
      for (const r of spec.raw ?? []) {
        if (r.kind === "python") {
          this.pythonCode.push({ asset: spec.asset, code: r.code });
          continue;
        }
        const wrapped = [
          'Begin Object Class=/Script/Engine.Blueprint Name="Raw"',
          `   Begin Object Name="${r.graph}"`,
          r.text,
          "   End Object",
          "End Object",
        ].join("\n");
        a.nodes = a.nodes.filter((n) => n.graph !== r.graph);
        for (const n of parseExport(wrapped).nodes.values()) a.nodes.push(fromT3d(n, r.graph));
      }
      for (const n of a.nodes) {
        for (const p of n.pins) {
          if (p.category === "wildcard") {
            undetermined.push({
              asset: spec.asset,
              message: `The type of ${p.name} is undetermined. Connect something to determine the type.`,
            });
          }
        }
      }
      assets.push({ asset: spec.asset, node_ids: nodeIds });
      writeFileSync(join(run, `final_${i}.t3d`), renderAsset(a, { reverseGraphs: this.options.perGraphNames === true }), "utf8");
    });

    // a spec error aborts the real apply before anything is compiled, so it comes with no compile messages
    const errors = specError === null ? [...undetermined, ...scripted] : [];
    const ok = errors.length === 0 && specError === null;
    if (ok) {
      this.assets = work;
      this.mirrorFiles();
      for (const a of (specs as Spec[]).map((s) => s.asset)) {
        this.changed.add(`Content/${a.split("/").slice(2).join("/")}.uasset`);
      }
      for (const t of tagsAdded) this.tagIni.add(t);
      if (tagsAdded.length > 0) this.changed.add("Config/Tags/TestModTags.ini");
      for (const r of rows) {
        if (typeof r.tag === "string") this.rowTags.set(r.asset, r.tag);
        this.rowClasses.set(r.asset, rowStage.get(r.asset)!);
        if (r.created || r.changed) this.changed.add(`Content/${r.asset.split("/").slice(2).join("/")}.uasset`);
      }
      this.mirrorFiles();
    }
    return {
      ok,
      rolledBack: !ok,
      run,
      seconds: 0.5,
      assets,
      compile: { errors, warnings: [] },
      rows: ok ? (this.scriptedRows ?? rows) : [],
      ...(ok && tagsAdded.length > 0 ? { tagsAdded } : {}),
      // like the real backend, a failed apply always carries `error`: the spec error, else a summary of the compile errors
      ...(ok ? {} : { error: specError ?? `${errors.length} compile error(s) in the edited assets` }),
    };
  }

  /** The stage folder holds one `Content/<path under /TestMod/>.uasset` file per asset (the CLI checks these to find assets it has to create). */
  private mirrorFiles(): void {
    const content = join(this.root, "stage", "Content");
    rmSync(content, { recursive: true, force: true });
    // The file holds what a read returns, so a changed asset has changed bytes (abfc's read cache keys on them).
    for (const path of [...this.assets.keys(), ...this.rowClasses.keys()]) {
      const file = join(content, ...path.split("/").slice(2)) + ".uasset";
      mkdirSync(dirname(file), { recursive: true });
      const a = this.assets.get(path);
      writeFileSync(file, a !== undefined ? renderAsset(a) : `row ${this.rowClasses.get(path) ?? ""}`, "utf8");
    }
  }

  /** The old backend templated a self call before the graph edit: for an event this spec adds the template had no pins. */
  private zeroPinSelfCall(a: FAsset, spec: Spec): string | null {
    for (const g of spec.graphs ?? []) {
      const added = new Set(g.add.filter((n) => n.k === "event" && n.name !== undefined).map((n) => n.name!));
      for (const n of g.add) {
        if (n.k !== "call" || n.class !== undefined || n.function === undefined || !added.has(n.function)) continue;
        const exists = a.nodes.some((x) => x.cls === CLS.customEvent && x.head.some((h) => h === `CustomFunctionName="${n.function}"`));
        if (!exists) return `[spec:${n.id}] no pin 'execute' on K2Node_CallFunction_9027`;
      }
    }
    return null;
  }

  async compile(_mod: string, _assets: string[]): Promise<CompileReport> {
    this.calls.push({ tool: "bp_compile_report" });
    this.lastWarm = this.warm;
    return { clean: this.reportMessages.length === 0, messages: this.reportMessages, run: "", seconds: 0.1, warm: this.warm };
  }

  /** Tags of the stage's tag ini and the tag each class-manager row holds (written by `gameplay_tag`). */
  readonly tagIni = new Set<string>();
  readonly rowTags = new Map<string, string>();

  async reflect(r?: ReflectRequest): Promise<ReflectResult> {
    if (this.options.reflectData === undefined || r === undefined) throw new Error("the fake backend does not reflect");
    this.calls.push({ tool: "reflect" });
    const run = join(this.root, "runs", "reflect");
    return {
      run,
      seconds: 0.1,
      file: "",
      data: this.options.reflectData(r),
      filter: { contentVersion: null, rules: [] },
    };
  }

  async catalog(_mod: string): Promise<CatalogResult> {
    if (this.options.catalog === undefined) throw new Error("the fake backend has no catalog");
    this.calls.push({ tool: "catalog" });
    return { run: join(this.root, "runs", "catalog"), seconds: 0.1, file: "", data: this.options.catalog };
  }

  async gameTest(_mod: string, steps: unknown[], _o: { timeoutSeconds: number }): Promise<GameTestReport> {
    this.calls.push({ tool: "bp_game_test" });
    this.lastWarm = false; // the game test always runs cold
    const failing = new Set(this.gameTestFailures[this.gameTestCalls++] ?? []);
    const report = steps.map((s, i) => {
      const op = String((s as { op?: unknown }).op ?? "step");
      return failing.has(i) ? { i, op, ok: false, value: "wrong" } : { i, op, ok: true, value: null };
    });
    return {
      ok: failing.size === 0,
      steps: report,
      passed: report.length - failing.size,
      failed: failing.size,
      complete: true,
      runtimeLog: [],
      run: "",
      seconds: 0.3,
      timedOut: false,
    };
  }

  async audit(_mod: string): Promise<AuditReport> {
    this.calls.push({ tool: "mod_audit" });
    this.lastWarm = false; // the audit always runs cold, on the staged copy
    return { ok: this.auditOk, raw: this.auditRaw, seconds: 0.2 };
  }

  async publish(mod: string, assets: string[], grant: PublishGrant, o?: { deleteRemoved?: boolean }): Promise<PublishResult> {
    this.calls.push({ tool: "bp_publish" });
    this.publishCalls.push({ mod, assets, grant, ...(o?.deleteRemoved === undefined ? {} : { deleteRemoved: o.deleteRemoved }) });
    this.lastWarm = false;
    if (this.publishResult.ok) this.changed.clear(); // what was published no longer differs from the mod
    if (this.publishResult.ok && o?.deleteRemoved === true) {
      // deletes the removed files of the requested assets (like the real backend), and forgets them
      const wanted = new Set(assets.map((a) => fileOfAsset(a)));
      const deleted = [...this.removedFiles].filter((f) => wanted.has(f));
      for (const d of deleted) this.removedFiles.delete(d);
      return { ...this.publishResult, deleted: [...this.publishResult.deleted, ...deleted] };
    }
    return this.publishResult;
  }

  /** `bp_asset_ops` on the in-memory stage: all-or-nothing; rename/delete leave the old file in `removedFiles`; a rename fixes up row referencers. */
  async assetOps(_mod: string, ops: AssetOp[]): Promise<AssetOpsResult> {
    this.calls.push({ tool: "bp_asset_ops" });
    this.assetOpsCalls.push(structuredClone(ops));
    this.lastWarm = false;
    const failWhole = (error: string, results: AssetOpsResult["results"] = []): AssetOpsResult => ({ ok: false, results, touched: [], error, rolledBack: true });
    if (ops.length > 20) return failWhole(`at most 20 ops per call (got ${ops.length})`);
    if (this.assetOpsError !== null) {
      const e = this.assetOpsError;
      this.assetOpsError = null;
      return failWhole(e);
    }
    if (this.assetOpsFailCall !== null && this.assetOpsCalls.length === this.assetOpsFailCall) {
      this.assetOpsFailCall = null;
      return failWhole("rename failed: forced by the test");
    }
    const supported = new Set(this.infoValue.capabilities.assetOps);
    const work = new Map([...this.assets].map(([k, v]) => [k, structuredClone(v)]));
    const rows = new Map(this.rowClasses);
    const removed = new Set(this.removedFiles);
    const touched: string[] = [];
    const results: AssetOpsResult["results"] = [];
    for (const op of ops) {
      const fail = (detail: string): AssetOpsResult => failWhole(`${op.op} failed: ${detail}`, [...results, { op: op.op, ok: false, detail }]);
      if (!supported.has(op.op)) return fail("operation not supported");
      if (op.op === "rename") {
        const a = work.get(op.from);
        if (a === undefined) return fail(`${op.from} does not exist`);
        if (work.has(op.to)) return fail(`${op.to} already exists`);
        work.delete(op.from);
        work.set(op.to, { ...a, path: op.to });
        removed.add(fileOfAsset(op.from));
        removed.delete(fileOfAsset(op.to));
        const oldName = op.from.slice(op.from.lastIndexOf("/") + 1);
        const newName = op.to.slice(op.to.lastIndexOf("/") + 1);
        for (const [row, cls] of rows) {
          if (cls === `${op.from}.${oldName}_C`) {
            rows.set(row, `${op.to}.${newName}_C`);
            touched.push(row);
          }
        }
        // Unreal's rename fixes up every referencer: variable types that name the old class follow (a referencer is saved too)
        for (const other of work.values()) {
          for (const v of other.variables) v.type = v.type.split(`${op.from}.${oldName}_C`).join(`${op.to}.${newName}_C`);
        }
        if (this.opsEditNodes) this.editFirstPin(work.get(op.to)!);
        results.push({ op: "rename", ok: true });
      } else if (op.op === "delete") {
        // Like the real backend: an asset that another asset (not deleted in this call) still references is not deleted.
        const name = op.asset.slice(op.asset.lastIndexOf("/") + 1);
        const deleting = new Set(ops.flatMap((o) => (o.op === "delete" ? [o.asset] : [])));
        const blocking = [...work.values()].filter((other) => other.path !== op.asset && !deleting.has(other.path) && other.variables.some((v) => v.type.includes(`${op.asset}.${name}_C`)));
        if (blocking.length > 0) return fail(`delete: ${op.asset} is still referenced by ${blocking.map((b) => b.path).join(", ")}`);
        const had = work.delete(op.asset);
        if (!rows.delete(op.asset) && !had) return fail(`${op.asset} does not exist`);
        removed.add(fileOfAsset(op.asset));
        results.push({ op: "delete", ok: true });
      } else if (op.op === "reparent") {
        const a = work.get(op.asset);
        if (a === undefined) return fail(`${op.asset} does not exist`);
        if (a.parent !== undefined && parentFamily(a.parent) !== parentFamily(op.parent)) {
          return fail(`cannot reparent across families (${parentFamily(a.parent)} -> ${parentFamily(op.parent)})`);
        }
        a.parent = op.parent;
        if (this.opsEditNodes) this.editFirstPin(a);
        results.push({ op: "reparent", ok: true });
      } else {
        // recreate: the stage loses the asset's files; a following apply `create` makes it again
        if (!work.delete(op.asset)) return fail(`${op.asset} does not exist`);
        results.push({ op: "recreate", ok: true });
      }
    }
    this.assets = work;
    this.rowClasses.clear();
    for (const [k, v] of rows) this.rowClasses.set(k, v);
    this.removedFiles.clear();
    for (const r of removed) this.removedFiles.add(r);
    for (const t of touched) this.changed.add(fileOfAsset(t));
    for (const op of ops) {
      if (op.op === "rename") this.changed.add(fileOfAsset(op.to));
      if (op.op === "reparent") this.changed.add(fileOfAsset(op.asset));
    }
    this.mirrorFiles();
    return { ok: true, results, touched, error: null };
  }

  async close(): Promise<void> {
    this.closed++;
  }

  private newRun(): string {
    const dir = join(this.root, `run-${++this.runs}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private nodeClass(s: SpecNode): string {
    switch (s.k) {
      case "call":
        return CLS.callFunction;
      case "get":
        return CLS.variableGet;
      case "set":
        return CLS.variableSet;
      case "event":
        return CLS.customEvent;
      case "override":
        return "/Script/BlueprintGraph.K2Node_Event";
      case "branch":
        return CLS.branch;
      case "cast":
        return CLS.dynamicCast;
      case "std_macro":
        return "/Script/BlueprintGraph.K2Node_MacroInstance";
      case "node":
        return s.class ?? "";
      default:
        return CLS.callFunction;
    }
  }

  private graphCounters = new Map<string, number>();

  /** A new node name: a global counter, or with `perGraphNames` a counter per asset, graph and class (from 9001), like Unreal. */
  private nodeName(asset: string, graph: string, cls: string): string {
    if (this.options.perGraphNames !== true) return `${shortOf(cls)}_${++this.counter}`;
    const k = `${asset}|${graph}|${shortOf(cls)}`;
    const n = (this.graphCounters.get(k) ?? 9000) + 1;
    this.graphCounters.set(k, n);
    return `${shortOf(cls)}_${n}`;
  }

  private makeNode(asset: string, s: SpecNode, graph: string, castTyped: boolean): FNode {
    const cls = this.nodeClass(s);
    const head = [`NodePosX=${Math.round(s.pos[0])}`, `NodePosY=${Math.round(s.pos[1])}`];
    if (s.k === "call") {
      head.push(`FunctionReference=(${s.class ? `MemberParent="${s.class}",` : ""}MemberName="${s.function ?? ""}")`);
    } else if (s.k === "get" || s.k === "set") {
      head.push(`VariableReference=(${s.class ? `MemberParent="${s.class}",` : ""}MemberName="${s.name ?? ""}")`);
    } else if (s.k === "override" && this.options.overrideAsCustomEvent === true && !(s.class ?? "").startsWith("/Script/")) {
      head.push(`CustomFunctionName="${s.function ?? ""}_1"`);
    } else if (s.k === "override") {
      head.push(`EventReference=(MemberParent="/Script/CoreUObject.Class'${s.class ?? ""}'",MemberName="${s.function ?? ""}")`, "bOverrideFunction=True");
    } else if (s.k === "event") {
      head.push(`CustomFunctionName="${s.name ?? ""}"`);
    } else if (s.k === "cast") {
      head.push(`TargetType="${s.target ?? ""}"`);
    } else if (s.k === "std_macro") {
      const asset = "/Engine/EditorBlueprintResources/StandardMacros.StandardMacros";
      head.push(`MacroGraphReference=(MacroGraph="/Script/Engine.EdGraph'${asset}:${s.name ?? ""}'",GraphBlueprint="/Script/Engine.Blueprint'${asset}'")`);
    } else {
      head.push(...(s.props ?? []));
    }
    const node: FNode = { name: this.nodeName(asset, graph, cls), cls, graph, head, pins: [] };
    for (const w of wildcardPins(cls)) wildcardPin(getPin(node, w.name, w.dir), w.container);
    if (s.k === "std_macro" && (s.name === "ForEachLoop" || s.name === "ForEachLoopWithBreak")) {
      wildcardPin(getPin(node, "Array", "in"), "Array");
      wildcardPin(getPin(node, "Array Element", "out"), "None");
    }
    if (cls === CLS.dynamicCast && castTyped) typePin(getPin(node, "Object", "in"), profile.castObjectPinType);
    for (const [pin, value] of Object.entries(s.set ?? {})) getPin(node, pin, "in").def = value;
    for (const [pin, path] of Object.entries(s.objects ?? {})) getPin(node, pin, "in").defObj = path;
    for (const [pin, type] of Object.entries(s.pin_types ?? {})) {
      const existing = node.pins.find((p) => p.name === pin);
      typePin(existing ?? getPin(node, pin, pin === "Output" || pin === "ReturnValue" ? "out" : "in"), type);
    }
    return node;
  }

  private applyGraph(a: FAsset, g: SpecGraph, castTyped: boolean, errors: CompileMessage[]): Record<string, string> {
    for (const r of g.remove ?? []) {
      const at = a.nodes.findIndex((n) => n.name === r && n.graph === g.graph);
      if (at < 0) {
        errors.push({ asset: a.path, message: `cannot remove ${r}: no such node in graph ${g.graph}` });
        continue;
      }
      a.nodes.splice(at, 1);
      for (const n of a.nodes) if (n.graph === g.graph) for (const p of n.pins) p.links = p.links.filter((l) => l.node !== r);
    }
    const ids: Record<string, string> = {};
    for (const s of g.add) {
      const node = this.makeNode(a.path, s, g.graph, castTyped);
      ids[s.id] = node.name;
      a.nodes.push(node);
      const ce = this.compileError;
      if (ce !== null && s.id === `${ce.unit ?? "UpdateTarget"}_${ce.irId}`) {
        errors.push({ asset: a.path, message: ce.message, node: node.name, graph: g.graph });
      }
    }
    const find = (end: string): { node: FNode; pin: string } => {
      const dot = end.indexOf(".");
      const id = end.slice(0, dot);
      // the reserved ends of a function graph: its own entry and result node
      const reserved = id === "entry" ? "K2Node_FunctionEntry" : id === "result" ? "K2Node_FunctionResult" : null;
      if (reserved !== null && ids[id] === undefined) {
        const own = a.nodes.find((n) => n.graph === g.graph && n.cls.endsWith(reserved));
        if (own === undefined) throw new Error(`fake stage: wire end ${end} names no ${reserved} in graph ${g.graph}`);
        return { node: own, pin: end.slice(dot + 1) };
      }
      const name = ids[id];
      const node = a.nodes.find((n) => n.name === name && n.graph === g.graph);
      if (node === undefined) throw new Error(`fake stage: wire end ${end} names no node of this spec`);
      return { node, pin: end.slice(dot + 1) };
    };
    for (const [from, to] of g.wires ?? []) {
      const f = find(from);
      const t = find(to);
      connect(f.node, f.pin, t.node, t.pin);
    }
    return ids;
  }
}
