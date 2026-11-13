import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExport } from "@abfc/ir";
import type { Span, T3dNode } from "@abfc/ir";
import {
  adoptionDiagnostics, analyzeAdoption, deleteManifest, deleteSourceMap, driftDiagnostics, fingerprintUnit, listManifests, mapCompileMessages, manifestPath, ownedSets,
  readManifest, readSourceMap, rebaseStaleUnits, unitState, writeManifest, writeSourceMap,
} from "../src/index.js";
import { builtGraphMatches, engineNormalisedFunction } from "../src/index.js";
import type { Manifest, ManifestUnit, SourceMapFile } from "../src/index.js";

const BP = "/Fake/Mod/BP_Host.BP_Host";
const EXEC = 'PinType.PinCategory="exec",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None';
const DELEGATE = 'PinType.PinCategory="delegate",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None';
const DATA = 'PinType.PinCategory="int",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None';

interface PinSpec { id: string; name: string; out?: boolean; data?: boolean; delegate?: boolean; def?: string; links?: string[] }
interface NodeSpec { name: string; cls: string; head?: string[]; x?: number; pins: PinSpec[] }

const pinLine = (p: PinSpec): string =>
  `CustomProperties Pin (PinId=${p.id},PinName="${p.name}"${p.out ? ',Direction="EGPD_Output"' : ""},${p.delegate ? DELEGATE : p.data ? DATA : EXEC},` +
  "PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,PinType.bIsReference=False" +
  (p.def !== undefined ? `,DefaultValue="${p.def}"` : "") +
  (p.links && p.links.length > 0 ? `,LinkedTo=(${p.links.join(",")},)` : "") +
  ",PersistentGuid=00000000000000000000000000000000,bHidden=False,)";

function render(nodes: NodeSpec[]): string {
  const lines = [
    `Begin Object Class=/Script/Engine.Blueprint Name="BP_Host" ExportPath="/Script/Engine.Blueprint'${BP}'"`,
    `   Begin Object Class=/Script/Engine.EdGraph Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${BP}:EventGraph'"`,
    ...nodes.flatMap((n) => [
      `      Begin Object Class=${n.cls} Name="${n.name}" ExportPath="${n.cls}'${BP}:EventGraph.${n.name}'"`,
      "      End Object",
    ]),
    "   End Object",
    `   Begin Object Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${BP}:EventGraph'"`,
    ...nodes.flatMap((n) => [
      `      Begin Object Name="${n.name}" ExportPath="${n.cls}'${BP}:EventGraph.${n.name}'"`,
      ...(n.head ?? []).map((h) => `         ${h}`),
      `         NodePosX=${n.x ?? 0}`,
      "         NodePosY=0",
      ...n.pins.map((p) => `         ${pinLine(p)}`),
      "      End Object",
    ]),
    "   End Object",
    "End Object",
    "",
  ];
  return lines.join("\r\n");
}

const CALL = "/Script/BlueprintGraph.K2Node_CallFunction";
const EVENT = "/Script/BlueprintGraph.K2Node_CustomEvent";
const GET = "/Script/BlueprintGraph.K2Node_VariableGet";
const COMMENT = "/Script/UnrealEd.EdGraphNode_Comment";
const id = (n: number): string => n.toString(16).padStart(32, "0").toUpperCase();

interface Opts { def?: string; x?: number; shareCall2?: boolean; foreign?: boolean; dropPure?: boolean; extraLink?: boolean }

/** Event A -> Call_1 -> Call_2 (Call_1 fed by a pure getter); event B -> Call_3. */
function snapshot(o: Opts = {}): Map<string, T3dNode> {
  const nodes: NodeSpec[] = [
    { name: "Ev_A", cls: EVENT, head: ['CustomFunctionName="A"'], x: o.x ?? 0, pins: [{ id: id(1), name: "then", out: true, links: [`Call_1 ${id(10)}`] }] },
    {
      name: "Call_1", cls: CALL, head: ['FunctionReference=(MemberName="One",bSelfContext=True)'],
      pins: [
        { id: id(10), name: "execute", links: [`Ev_A ${id(1)}`, ...(o.foreign ? [`Ext_1 ${id(60)}`] : [])] },
        { id: id(11), name: "then", out: true, links: [`Call_2 ${id(20)}`] },
        { id: id(12), name: "arg", data: true, def: o.def ?? "0", links: o.dropPure ? [] : [`Pure_1 ${id(30)}`] },
      ],
    },
    {
      name: "Call_2", cls: CALL, head: ['FunctionReference=(MemberName="Two",bSelfContext=True)'],
      pins: [
        { id: id(20), name: "execute", links: [`Call_1 ${id(11)}`, ...(o.shareCall2 ? [`Ev_B ${id(40)}`] : [])] },
        { id: id(21), name: "then", out: true },
      ],
    },
    ...(o.dropPure ? [] : [{
      name: "Pure_1", cls: GET, head: ['VariableReference=(MemberName="V",bSelfContext=True)'],
      pins: [{ id: id(30), name: "V", out: true, data: true, links: [`Call_1 ${id(12)}`] }],
    }]),
    {
      name: "Ev_B", cls: EVENT, head: ['CustomFunctionName="B"'],
      pins: [{ id: id(40), name: "then", out: true, links: [`Call_3 ${id(50)}`, ...(o.shareCall2 ? [`Call_2 ${id(20)}`] : [])] }],
    },
    { name: "Call_3", cls: CALL, head: ['FunctionReference=(MemberName="Three",bSelfContext=True)'], pins: [{ id: id(50), name: "execute", links: [`Ev_B ${id(40)}`] }] },
    { name: "Cmt_1", cls: COMMENT, pins: [] },
    ...(o.foreign ? [{ name: "Ext_1", cls: CALL, head: ['FunctionReference=(MemberName="Ext",bSelfContext=True)'], pins: [{ id: id(60), name: "then", out: true, links: [`Call_1 ${id(10)}`] }] }] : []),
  ];
  return parseExport(render(nodes)).nodes;
}

test("adoption: owned, shared and foreign cases", () => {
  const clean = analyzeAdoption(snapshot(), "EventGraph", "A");
  assert.equal(clean.entry, "Ev_A");
  assert.deepEqual(clean.owned, ["Call_1", "Call_2", "Ev_A", "Pure_1"]);
  assert.deepEqual(clean.shared, []);
  assert.deepEqual(clean.foreignLinks, []);
  assert.deepEqual(adoptionDiagnostics(clean, "/Fake/Mod/BP_Host", "A"), []);

  const shared = analyzeAdoption(snapshot({ shareCall2: true }), "EventGraph", "A");
  assert.deepEqual(shared.shared, ["Call_2"]);
  assert.deepEqual(shared.owned, ["Call_1", "Ev_A", "Pure_1"]);
  assert.equal(adoptionDiagnostics(shared, "/Fake/Mod/BP_Host", "A")[0]?.code, "ABFC5005");

  const foreign = analyzeAdoption(snapshot({ foreign: true }), "EventGraph", "A");
  assert.deepEqual(foreign.foreignLinks, [{ node: "Ext_1", pin: "then", to: "Call_1" }]);
  assert.equal(adoptionDiagnostics(foreign, "/Fake/Mod/BP_Host", "A")[0]?.code, "ABFC5005");

  assert.throws(() => analyzeAdoption(snapshot(), "EventGraph", "Nope"), /ABFC5002/);
});

const asset = "/Fake/Mod/BP_Host";
const stage = { syncedAt: "2026-01-01T00:00:00Z" };

function manifestUnit(over: Partial<ManifestUnit> = {}): ManifestUnit {
  const names = ["Call_1", "Call_2", "Ev_A", "Pure_1"];
  const fp = fingerprintUnit(snapshot(), names);
  return {
    id: "event:A", graph: "EventGraph", irHash: "sha256:aa", assetHash: fp.assetHash, nodes: names, nodeIds: {}, tag: null,
    stageSyncedAt: stage.syncedAt, adopt: null, nodeHashes: fp.nodeHashes, links: fp.links, ...over,
  };
}

test("drift states", () => {
  const u = manifestUnit();
  assert.equal(unitState(u, snapshot(), stage), "clean");
  assert.equal(unitState(u, snapshot({ x: 500 }), stage), "clean", "moving a node is not an edit");
  assert.equal(unitState(u, snapshot({ def: "7" }), stage), "edited");
  assert.equal(unitState(u, snapshot({ dropPure: true }), stage), "missing");
  assert.equal(unitState(u, snapshot(), { syncedAt: "other" }), "staleStage");
  assert.equal(unitState(manifestUnit({ stageSyncedAt: null, assetHash: null, nodes: [] }), snapshot(), stage), "pendingApply");
  const adopt = { entry: "Ev_A", nodes: ["Call_1"], hash: "sha256:x", recordedAt: "now", stageSyncedAt: stage.syncedAt };
  assert.equal(unitState(manifestUnit({ stageSyncedAt: null, adopt }), snapshot(), stage), "pendingAdoption");
});

test("drift diagnostics: ABFC5001 with counts, ABFC5002, ABFC5004", () => {
  const spans = new Map<string, Span>([["event:A", { file: "src/H.ts", line: 3, col: 1, endLine: 9, endCol: 2 }]]);
  const u = manifestUnit();
  assert.deepEqual(driftDiagnostics(asset, [u], snapshot(), stage, spans), []);

  const edited = driftDiagnostics(asset, [u], snapshot({ def: "7", extraLink: true }), stage, spans);
  assert.equal(edited.length, 1);
  assert.equal(edited[0]!.code, "ABFC5001");
  assert.match(edited[0]!.message, /BP_Host event A was edited in the editor since the last build \(1 node changed, 0 links added, 0 links removed\)/);
  assert.equal(edited[0]!.span?.line, 3);

  const missing = driftDiagnostics(asset, [u], snapshot({ dropPure: true }), stage, spans);
  assert.equal(missing[0]!.code, "ABFC5002");
  assert.match(missing[0]!.message, /Pure_1/);

  const adopt = fingerprintUnit(snapshot(), ["Call_3"]);
  const ok = manifestUnit({ stageSyncedAt: null, adopt: { entry: "Ev_B", nodes: ["Call_3"], hash: adopt.assetHash, recordedAt: "now", stageSyncedAt: null } });
  assert.deepEqual(driftDiagnostics(asset, [ok], snapshot(), stage, spans), []);
  const changed = manifestUnit({ stageSyncedAt: null, adopt: { entry: "Ev_B", nodes: ["Call_3"], hash: "sha256:zzz", recordedAt: "now", stageSyncedAt: null } });
  assert.equal(driftDiagnostics(asset, [changed], snapshot(), stage, spans)[0]!.code, "ABFC5004");
});

test("drift diagnostics after a resync: built graph, hand-made graph, neither", () => {
  const spans = new Map<string, Span>();
  const resynced = { syncedAt: "2026-02-02T00:00:00Z" };
  const handMade = fingerprintUnit(snapshot(), ["Call_3"]);
  const adoptOf = (hash: string) => ({ entry: "Ev_B", nodes: ["Call_3"], hash, recordedAt: "now", stageSyncedAt: null });

  // The stage holds the abfc-built graph; the adopt hash is the old hand-made graph (no longer in the stage).
  const built = manifestUnit({ adopt: adoptOf("sha256:old-hand-made") });
  assert.equal(unitState(built, snapshot(), resynced), "staleStage");
  assert.deepEqual(driftDiagnostics(asset, [built], snapshot(), resynced, spans), []);

  // The stage was re-synced from a real mod that still holds the hand-made graph: built nodes differ, adopt hash matches.
  const stillHandMade = manifestUnit({ assetHash: "sha256:built-elsewhere", adopt: adoptOf(handMade.assetHash) });
  assert.deepEqual(driftDiagnostics(asset, [stillHandMade], snapshot(), resynced, spans), []);
  const builtGone = manifestUnit({ adopt: adoptOf(handMade.assetHash), nodes: ["Nope_1"] });
  assert.deepEqual(driftDiagnostics(asset, [builtGone], snapshot(), resynced, spans), []);

  // Neither matches.
  const neither = manifestUnit({ assetHash: "sha256:built-elsewhere", adopt: adoptOf("sha256:old-hand-made") });
  assert.equal(driftDiagnostics(asset, [neither], snapshot(), resynced, spans)[0]!.code, "ABFC5004");

  // No adopt record: built graph matches -> fine; edited -> ABFC5001; node missing -> ABFC5002.
  assert.deepEqual(driftDiagnostics(asset, [manifestUnit()], snapshot(), resynced, spans), []);
  assert.equal(driftDiagnostics(asset, [manifestUnit()], snapshot({ def: "7" }), resynced, spans)[0]!.code, "ABFC5001");
  assert.equal(driftDiagnostics(asset, [manifestUnit()], snapshot({ dropPure: true }), resynced, spans)[0]!.code, "ABFC5002");

  // rebaseStaleUnits moves only the matching units to the new sync time.
  const r = rebaseStaleUnits({ units: [built, neither] }, snapshot(), resynced);
  assert.equal(r.changed, true);
  assert.equal(r.manifest.units[0]!.stageSyncedAt, resynced.syncedAt);
  assert.equal(r.manifest.units[1]!.stageSyncedAt, stage.syncedAt);
  assert.equal(unitState(r.manifest.units[0]!, snapshot(), resynced), "clean");
  assert.equal(rebaseStaleUnits({ units: [neither] }, snapshot(), resynced).changed, false);
});

test("manifest and source map files", () => {
  const dir = mkdtempSync(join(tmpdir(), "abfc-own-"));
  try {
    const m: Manifest = { asset, compiler: "0.1.0", profile: "p", units: [manifestUnit()], variables: [{ name: "abfc_A_t0", type: "name", hash: "sha256:v" }] };
    assert.equal(readManifest(dir, asset), null);
    const file = writeManifest(dir, m);
    assert.equal(file, manifestPath(dir, asset));
    assert.match(file.replaceAll("\\", "/"), /\.abfc\/manifest\/Fake__Mod__BP_Host\.json$/);
    const text = readFileSync(file, "utf8");
    assert.ok(text.endsWith("}\n"));
    assert.ok(text.indexOf('"asset"') < text.indexOf('"compiler"') && text.indexOf('"compiler"') < text.indexOf('"profile"'));
    assert.deepEqual(readManifest(dir, asset), JSON.parse(JSON.stringify(m)));
    assert.deepEqual(ownedSets(dir), { [asset]: { units: ["event:A"], variables: ["abfc_A_t0"] } });

    const sm: SourceMapFile = { asset, units: { "event:A": { span: { file: "src/H.ts", line: 1, col: 1, endLine: 2, endCol: 1 }, nodes: {} } } };
    writeSourceMap(dir, sm);
    assert.deepEqual(readSourceMap(dir, asset), sm);
    assert.equal(readSourceMap(dir, "/Fake/Mod/Other"), null);

    // listing and deleting
    const other: Manifest = { asset: "/Fake/Mod/BP_Other", compiler: "0.1.0", profile: "p", units: [], variables: [], retiredUnpublished: ["event:Z"] };
    writeManifest(dir, other);
    assert.deepEqual(listManifests(dir).map((x) => x.asset), [asset, "/Fake/Mod/BP_Other"]);
    assert.deepEqual(listManifests(dir)[1]!.retiredUnpublished, ["event:Z"]);
    deleteManifest(dir, asset);
    deleteManifest(dir, asset);
    assert.equal(readManifest(dir, asset), null);
    assert.deepEqual(listManifests(dir).map((x) => x.asset), ["/Fake/Mod/BP_Other"]);
    deleteSourceMap(dir, asset);
    deleteSourceMap(dir, asset);
    assert.equal(readSourceMap(dir, asset), null);
    assert.deepEqual(listManifests(join(dir, "nowhere")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fingerprintUnit resolves links inside the graph of the linking node (graph-scoped keys)", () => {
  const pin = (id: string, name: string, dir: "in" | "out", links: Array<{ node: string; pinId: string }> = []): T3dNode["pins"][number] => ({
    id, name, dir, category: "int", subCategory: "", subCategoryObject: null, container: "None", valueType: null, hidden: false, defaultValue: null, defaultObject: null, links, raw: "",
  });
  const mk = (graph: string, name: string, cls: string, pins: T3dNode["pins"]): T3dNode => ({ name, cls, graph, head: [], pins });
  const ENTRY = "/Script/BlueprintGraph.K2Node_FunctionEntry";
  const snapshot = new Map<string, T3dNode>();
  for (const [g, p, pid] of [["FnA", "a", id(1)], ["FnB", "b", id(2)]] as const) {
    snapshot.set(`${g}/K2Node_FunctionEntry_0`, mk(g, "K2Node_FunctionEntry_0", ENTRY, [pin(pid, p, "out", [{ node: "K2Node_CallFunction_9001", pinId: id(10) }])]));
    snapshot.set(`${g}/K2Node_CallFunction_9001`, mk(g, "K2Node_CallFunction_9001", CALL, [pin(id(10), "execute", "in", [{ node: "K2Node_FunctionEntry_0", pinId: pid }])]));
  }
  snapshot.set("K2Node_CallFunction_9001", mk("EventGraph", "K2Node_CallFunction_9001", CALL, [pin(id(10), "execute", "in")]));
  const fp = fingerprintUnit(snapshot, ["FnA/K2Node_FunctionEntry_0", "FnA/K2Node_CallFunction_9001"]);
  assert.deepEqual(fp.links, ["FnA/K2Node_FunctionEntry_0.a > FnA/K2Node_CallFunction_9001.execute"]); // no foreign link: both ends are owned
  assert.deepEqual(Object.keys(fp.nodeHashes), ["FnA/K2Node_CallFunction_9001", "FnA/K2Node_FunctionEntry_0"]);
  const onlyCall = fingerprintUnit(snapshot, ["FnA/K2Node_CallFunction_9001"]);
  assert.deepEqual(onlyCall.links, ["FnA/K2Node_FunctionEntry_0.a > FnA/K2Node_CallFunction_9001.execute"]); // the entry is foreign here
});

test("compile messages are mapped by graph: the same node name in a function and the event graph", () => {
  const span = (line: number): Span => ({ file: "src/H.ts", line, col: 3, endLine: line, endCol: 9 });
  const real = "K2Node_CallFunction_9001";
  const sm: SourceMapFile = {
    asset,
    units: {
      "event:Go": { span: span(1), nodes: { call0: { span: span(5), real } } },
      "function:runTest": { span: span(10), nodes: { call0: { span: span(12), real } } },
    },
  };
  const at = (graph?: string) => mapCompileMessages(asset, [{ asset, message: "bad", node: real, ...(graph !== undefined ? { graph } : {}) }], sm, {})[0]!;
  assert.equal(at("runTest").span?.line, 12);
  assert.equal(at("EventGraph").span?.line, 5);
  assert.equal(at().span?.line, 5); // no graph: the EventGraph node
  assert.equal(at("Elsewhere").code, "ABFC6002");
  // no graph and no EventGraph node of that name: the only owned node of that name
  const fnOnly: SourceMapFile = { asset, units: { "function:runTest": sm.units["function:runTest"]! } };
  assert.equal(mapCompileMessages(asset, [{ asset, message: "bad", node: real }], fnOnly, {})[0]!.span?.line, 12);
  // nodeIds (real name -> unit/ir id) are keyed by the unit's graph as well
  const viaIds = mapCompileMessages(asset, [{ asset, message: "bad", node: "N_1", graph: "runTest" }], { asset, units: { "function:runTest": { span: span(10), nodes: { x: { span: span(13), real: null } } } } }, { N_1: "function:runTest/x" });
  assert.equal(viaIds[0]!.span?.line, 13);
});

test("compile messages map to owned nodes, hand-made nodes and units", () => {
  const span = (line: number): Span => ({ file: "src/H.ts", line, col: 3, endLine: line, endCol: 9 });
  const sm: SourceMapFile = {
    asset,
    units: { "event:A": { span: span(1), nodes: { call0: { span: span(5), real: "K2Node_CallFunction_9" }, get0: { span: span(6), real: null } } } },
  };
  const owned = mapCompileMessages(asset, [{ asset, message: "bad pin", node: "K2Node_CallFunction_9" }], sm, {});
  assert.equal(owned[0]!.code, "ABFC6001");
  assert.equal(owned[0]!.message, "[Unreal] bad pin");
  assert.equal(owned[0]!.span?.line, 5);

  const viaIds = mapCompileMessages(asset, [{ asset, message: "x", node: "K2Node_VariableGet_2" }], sm, { K2Node_VariableGet_2: "event:A/get0" });
  assert.equal(viaIds[0]!.code, "ABFC6001");
  assert.equal(viaIds[0]!.span?.line, 6);

  const manual = mapCompileMessages(asset, [{ asset, message: "oops", node: "K2Node_Other_1" }], sm, {});
  assert.equal(manual[0]!.code, "ABFC6002");
  assert.equal(manual[0]!.span, undefined);
  assert.match(manual[0]!.message, /\(K2Node_Other_1, hand-made\)$/);

  const unit = mapCompileMessages(asset, [{ asset, message: "oops" }], sm, {});
  assert.equal(unit[0]!.code, "ABFC6002");
  assert.equal(unit[0]!.span?.line, 1);
  assert.match(unit[0]!.message, /\(node not identified\)$/);

  const two: SourceMapFile = { asset, units: { ...sm.units, "event:B": { span: span(20), nodes: {} } } };
  const wide = mapCompileMessages(asset, [{ asset, message: "oops" }, { asset: "/Fake/Mod/Other", message: "skip" }], two, {});
  assert.equal(wide.length, 1);
  assert.equal(wide[0]!.span, undefined);
});

test("apply spec errors and unknown-function messages map to the call in TS", () => {
  const span = (line: number): Span => ({ file: "src/H.ts", line, col: 3, endLine: line, endCol: 9 });
  const sm: SourceMapFile = {
    asset,
    units: {
      "event:Caller": { span: span(1), nodes: { call1: { span: span(7), real: null } } },
      "event:Other": { span: span(20), nodes: { call1: { span: span(22), real: null } } },
    },
  };
  const specIds = { Caller_call1: "event:Caller/call1", Other_call1: "event:Other/call1" };
  const ownCalls = { StartNew: [span(7), span(22)] };

  // a SpecError about a planned node: located at that node, the prefix is not shown
  const spec = mapCompileMessages(asset, [{ asset: null, message: "[spec:Other_call1] no pin 'execute' on K2Node_CallFunction_9027" }], sm, {}, specIds, ownCalls);
  assert.equal(spec.length, 1);
  assert.equal(spec[0]!.code, "ABFC6001");
  assert.equal(spec[0]!.span?.line, 22);
  assert.equal(spec[0]!.message, "[Unreal] no pin 'execute' on K2Node_CallFunction_9027");

  // the exact unknown-function text of the failing run: one error per call of that function
  const msg = "Could not find a function named \"StartNew\" in 'BPC_Host_C'.";
  const calls = mapCompileMessages(asset, [{ asset, message: msg }], sm, {}, specIds, ownCalls);
  assert.deepEqual(calls.map((d) => [d.code, d.span?.line]), [["ABFC6001", 7], ["ABFC6001", 22]]);
  assert.equal(calls[0]!.message, "[Unreal] " + msg);

  // a function nobody calls from TS stays an unlocated ABFC6002
  const unknown = mapCompileMessages(asset, [{ asset, message: "Could not find a function named \"Elsewhere\" in 'BPC_Host_C'." }], sm, {}, specIds, ownCalls);
  assert.deepEqual(unknown.map((d) => [d.code, d.span]), [["ABFC6002", undefined]]);

  // scratch Blueprint messages of another asset are skipped; the raw apply error next to a located one is not reported twice
  const both = mapCompileMessages(
    asset,
    [
      { asset: "/Fake/Mod/_McpTmp/BP_BkScratch1", message: msg },
      { asset: null, message: "[spec:Caller_call1] no pin 'execute' on K2Node_CallFunction_9027" },
      { asset: null, message: "apply failed" },
    ],
    sm,
    {},
    specIds,
    ownCalls,
  );
  assert.deepEqual(both.map((d) => [d.code, d.span?.line]), [["ABFC6001", 7]]);

  // without maps the old behaviour stays
  const plain = mapCompileMessages(asset, [{ asset, message: msg }], sm, {});
  assert.deepEqual(plain.map((d) => [d.code, d.span]), [["ABFC6002", undefined]]);
});

// ---- Phase 2: delegate links, overrides, --remove-node ----

const EVENT_NODE = "/Script/BlueprintGraph.K2Node_Event";
const SELF = "/Script/BlueprintGraph.K2Node_Self";
const ref = (name: string): string => `EventReference=(MemberParent="/Script/CoreUObject.Class'/Script/Engine.Actor'",MemberName="${name}")`;

/** Start -> SetTimer(Delegate <- Scan.OutputDelegate); Scan -> Call_9; override ReceiveBeginPlay -> Call_8; disabled ReceiveTick; a comment and an unlinked Self. */
function delegateSnapshot(): Map<string, T3dNode> {
  const nodes: NodeSpec[] = [
    { name: "Ev_Start", cls: EVENT, head: ['CustomFunctionName="Start"'], pins: [{ id: id(1), name: "then", out: true, links: [`Timer_1 ${id(10)}`] }] },
    {
      name: "Timer_1", cls: CALL, head: ['FunctionReference=(MemberName="SetTimer",bSelfContext=True)'],
      pins: [
        { id: id(10), name: "execute", links: [`Ev_Start ${id(1)}`] },
        { id: id(11), name: "then", out: true },
        { id: id(12), name: "Delegate", delegate: true, links: [`Ev_Scan ${id(21)}`] },
      ],
    },
    {
      name: "Ev_Scan", cls: EVENT, head: ['CustomFunctionName="Scan"'],
      pins: [
        { id: id(20), name: "then", out: true, links: [`Call_9 ${id(30)}`] },
        { id: id(21), name: "OutputDelegate", out: true, delegate: true, links: [`Timer_1 ${id(12)}`] },
      ],
    },
    { name: "Call_9", cls: CALL, head: ['FunctionReference=(MemberName="Nine",bSelfContext=True)'], pins: [{ id: id(30), name: "execute", links: [`Ev_Scan ${id(20)}`] }] },
    { name: "Ev_Begin", cls: EVENT_NODE, head: [ref("ReceiveBeginPlay")], pins: [{ id: id(40), name: "then", out: true, links: [`Call_8 ${id(50)}`] }] },
    { name: "Call_8", cls: CALL, head: ['FunctionReference=(MemberName="Eight",bSelfContext=True)'], pins: [{ id: id(50), name: "execute", links: [`Ev_Begin ${id(40)}`] }] },
    { name: "Ev_Tick", cls: EVENT_NODE, head: [ref("ReceiveTick"), "EnabledState=Disabled"], pins: [{ id: id(60), name: "then", out: true }] },
    { name: "Cmt_A", cls: COMMENT, pins: [] },
    { name: "Self_0", cls: SELF, pins: [{ id: id(70), name: "self", out: true, data: true }] },
  ];
  return parseExport(render(nodes)).nodes;
}

test("adoption records delegate links to and from other entries", () => {
  const nodes = delegateSnapshot();
  const start = analyzeAdoption(nodes, "EventGraph", "Start");
  assert.deepEqual(start.owned, ["Ev_Start", "Timer_1"]);
  assert.deepEqual(start.crossLinks, [{ node: "Timer_1", pin: "Delegate", entry: "Ev_Scan", role: "uses" }]);
  assert.deepEqual(adoptionDiagnostics(start, "/Fake/Mod/BP_Host", "Start"), []);

  const scan = analyzeAdoption(nodes, "EventGraph", "Scan");
  assert.deepEqual(scan.owned, ["Call_9", "Ev_Scan"]);
  assert.deepEqual(scan.shared, []);
  assert.deepEqual(scan.foreignLinks, []);
  assert.deepEqual(scan.crossLinks, [{ node: "Timer_1", pin: "Delegate", entry: "Ev_Scan", role: "supplies" }]);
  assert.deepEqual(adoptionDiagnostics(scan, "/Fake/Mod/BP_Host", "Scan", new Set(["Timer_1"])), []);
});

test("a hand-made node that takes the adopted event as its delegate is refused unless another unit owns it (ABFC5005)", () => {
  const scan = analyzeAdoption(delegateSnapshot(), "EventGraph", "Scan");
  const refused = adoptionDiagnostics(scan, "/Fake/Mod/BP_Host", "Scan");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.code, "ABFC5005");
  assert.match(refused[0]!.message, /Timer_1.Delegate/);
  assert.equal(adoptionDiagnostics(scan, "/Fake/Mod/BP_Host", "Scan", new Set(["Other_Node"]))[0]?.code, "ABFC5005");
  assert.deepEqual(adoptionDiagnostics(scan, "/Fake/Mod/BP_Host", "Scan", new Set(["Timer_1"])), []);
});

test("an event parameter pin linked into an owned node is a foreign link, not a delegate cross link (ABFC5005)", () => {
  const nodes: NodeSpec[] = [
    { name: "Ev_Start", cls: EVENT, head: ['CustomFunctionName="Start"'], pins: [{ id: id(1), name: "then", out: true, links: [`Call_1 ${id(10)}`] }] },
    { name: "Call_1", cls: CALL, head: ['FunctionReference=(MemberName="One",bSelfContext=True)'], pins: [
      { id: id(10), name: "execute", links: [`Ev_Start ${id(1)}`] },
      { id: id(11), name: "Amount", data: true, links: [`Ev_Other ${id(21)}`] },
    ] },
    { name: "Ev_Other", cls: EVENT, head: ['CustomFunctionName="Other"'], pins: [
      { id: id(20), name: "then", out: true },
      { id: id(21), name: "DeltaSeconds", out: true, data: true, links: [`Call_1 ${id(11)}`] },
    ] },
  ];
  const a = analyzeAdoption(parseExport(render(nodes)).nodes, "EventGraph", "Start");
  assert.deepEqual(a.crossLinks, []);
  assert.deepEqual(a.foreignLinks, [{ node: "Ev_Other", pin: "DeltaSeconds", to: "Call_1" }]);
  assert.equal(adoptionDiagnostics(a, "/Fake/Mod/BP_Host", "Start")[0]?.code, "ABFC5005");
});

test("adoption of an engine override event; a disabled default node is not an override", () => {
  const nodes = delegateSnapshot();
  const begin = analyzeAdoption(nodes, "EventGraph", "ReceiveBeginPlay", { kind: "override" });
  assert.equal(begin.entry, "Ev_Begin");
  assert.deepEqual(begin.owned, ["Call_8", "Ev_Begin"]);
  assert.throws(() => analyzeAdoption(nodes, "EventGraph", "ReceiveTick", { kind: "override" }), /ABFC5002/);
  assert.throws(() => analyzeAdoption(nodes, "EventGraph", "ReceiveBeginPlay"), /ABFC5002/, "an override is not found as a custom event");
});

test("--remove-node: comment boxes and unlinked nodes only (ABFC5008)", () => {
  const nodes = delegateSnapshot();
  const a = analyzeAdoption(nodes, "EventGraph", "Scan", { extraNodes: ["Self_0", "Cmt_A", "Self_0"] });
  assert.deepEqual(a.extra, ["Cmt_A", "Self_0"]);
  assert.deepEqual(a.owned, ["Call_9", "Cmt_A", "Ev_Scan", "Self_0"]);
  assert.throws(() => analyzeAdoption(nodes, "EventGraph", "Start", { extraNodes: ["Call_9"] }), /ABFC5008.*linked pins/);
  assert.throws(() => analyzeAdoption(nodes, "EventGraph", "Start", { extraNodes: ["Nope"] }), /ABFC5008.*no node named/);
});

test("a resync that only shows the editor's rewrite of struct break/make nodes keeps an owned function clean", () => {
  // Function graph "Fn" as abfc applied it: entry -> call, a BreakStruct feeding the call. After a save and reload in the editor the
  // BreakStruct comes back as a native break call under another name; nothing else in the graph changed.
  const node = (graph: string, name: string, cls: string, pins: T3dNode["pins"]): [string, T3dNode] =>
    [`${graph}/${name}`, { name, cls, graph, head: [], pins }];
  const pin = (id: string, name: string, dir: "in" | "out", links: Array<{ node: string; pinId: string }> = []) =>
    ({ id, name, dir, category: "real", subCategory: "double", subCategoryObject: null, container: null, defaultValue: null, defaultObject: null, links }) as unknown as T3dNode["pins"][number];
  const built = new Map<string, T3dNode>([
    node("Fn", "K2Node_FunctionEntry_9001", "/Script/BlueprintGraph.K2Node_FunctionEntry", []),
    node("Fn", "K2Node_BreakStruct_9001", "/Script/BlueprintGraph.K2Node_BreakStruct", [pin("B1", "X", "out", [{ node: "K2Node_CallFunction_9001", pinId: "C1" }])]),
    node("Fn", "K2Node_CallFunction_9001", "/Script/BlueprintGraph.K2Node_CallFunction", [pin("C1", "A", "in", [{ node: "K2Node_BreakStruct_9001", pinId: "B1" }])]),
  ]);
  const names = [...built.keys()].sort();
  const fp = fingerprintUnit(built, names);
  const unit: ManifestUnit = {
    id: "function:Fn", graph: "Fn", irHash: "sha256:fn", assetHash: fp.assetHash, nodes: names, nodeIds: {}, tag: null,
    stageSyncedAt: "2026-01-01T00:00:00", adopt: null, nodeHashes: fp.nodeHashes, links: fp.links,
  };
  const resaved = new Map<string, T3dNode>([
    node("Fn", "K2Node_FunctionEntry_9001", "/Script/BlueprintGraph.K2Node_FunctionEntry", []),
    node("Fn", "K2Node_CallFunction_0", "/Script/BlueprintGraph.K2Node_CallFunction", [pin("N1", "X", "out", [{ node: "K2Node_CallFunction_9001", pinId: "C1" }])]),
    node("Fn", "K2Node_CallFunction_9001", "/Script/BlueprintGraph.K2Node_CallFunction", [pin("C1", "A", "in", [{ node: "K2Node_CallFunction_0", pinId: "N1" }])]),
    node("Fn", "EdGraphNode_Comment_9001", "/Script/UnrealEd.EdGraphNode_Comment", []), // the build's tag comment: never a unit node
  ]);
  const expected = [...resaved.keys()].filter((k) => !k.includes("Comment")).sort();
  const resynced = { syncedAt: "2026-02-02T00:00:00" };
  assert.equal(unitState(unit, resaved, resynced), "staleStage");
  assert.deepEqual(engineNormalisedFunction(unit, resaved), expected);
  assert.equal(builtGraphMatches(unit, resaved), true);
  // no ABFC5001/5002: the build leaves the function alone
  assert.deepEqual(driftDiagnostics("/Fake/Mod/BP_Fn", [unit], resaved, resynced, new Map()), []);
  const r = rebaseStaleUnits({ units: [unit] }, resaved, resynced);
  assert.equal(r.changed, true);
  assert.deepEqual(r.manifest.units[0]!.nodes, expected);
  assert.equal(unitState(r.manifest.units[0]!, resaved, resynced), "clean");

  // A missing node of any other class is real drift: no rebase, ABFC5002 stays.
  const lostCall = new Map(resaved);
  lostCall.delete("Fn/K2Node_CallFunction_9001");
  assert.equal(engineNormalisedFunction(unit, lostCall), null);
  assert.equal(builtGraphMatches(unit, lostCall), false);
  assert.equal(driftDiagnostics("/Fake/Mod/BP_Fn", [unit], lostCall, resynced, new Map())[0]!.code, "ABFC5002");
  // Only function units qualify (an event's nodes are not owned as a whole graph).
  assert.equal(engineNormalisedFunction({ ...unit, id: "event:Fn" }, resaved), null);
});
