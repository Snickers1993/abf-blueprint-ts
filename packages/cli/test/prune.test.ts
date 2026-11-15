import { test } from "node:test";
import assert from "node:assert/strict";
import type { ManifestUnit } from "@abfc/compiler";
import type { T3dNode } from "@abfc/ir";
import { unitsHeldByStage } from "../src/commands/common.js";

// What `--resync` keeps of a manifest (pruneManifestsToStage): the units the re-synced stage still holds.

function node(graph: string, name: string, cls: string): [string, T3dNode] {
  return [`${graph}/${name}`, { name, cls, graph, head: [], pins: [] }];
}

function unit(id: string, graph: string, nodes: string[]): ManifestUnit {
  return {
    id, graph, irHash: `sha256:${id}`, assetHash: "sha256:applied", nodes, nodeIds: {}, tag: null,
    stageSyncedAt: "2026-01-01T00:00:00", adopt: null,
  } as ManifestUnit;
}

const BREAK = "/Script/BlueprintGraph.K2Node_BreakStruct";
const CALL = "/Script/BlueprintGraph.K2Node_CallFunction";

test("resync prune: a published function whose only missing nodes are editor-rewritten struct breaks is kept", () => {
  const applied = unit("function:Fn", "Fn", ["Fn/K2Node_BreakStruct_9001", "Fn/K2Node_CallFunction_9001"]);
  // the published mod after the editor saved it: the break node came back as a native break call under another name
  const stage = new Map<string, T3dNode>([
    node("Fn", "K2Node_FunctionEntry_0", "/Script/BlueprintGraph.K2Node_FunctionEntry"),
    node("Fn", "K2Node_CallFunction_0", CALL),
    node("Fn", "K2Node_CallFunction_9001", CALL),
  ]);
  assert.deepEqual(unitsHeldByStage([applied], stage).map((u) => u.id), ["function:Fn"]);
});

test("resync prune: units the stage really lost are still dropped", () => {
  const stage = new Map<string, T3dNode>([node("Fn", "K2Node_CallFunction_0", CALL), node("Fn", "K2Node_BreakStruct_0", BREAK)]);
  // a missing node of another class: never published, dropped (the next build applies it again)
  const lostCall = unit("function:Fn", "Fn", ["Fn/K2Node_CallFunction_9001", "Fn/K2Node_CallFunction_0"]);
  // an event unit is never normalised, even when only a struct break is missing
  const event = unit("event:Ev", "EventGraph", ["EventGraph/K2Node_BreakStruct_9001"]);
  // a function graph that is gone altogether
  const gone = unit("function:Other", "Other", ["Other/K2Node_BreakStruct_9001"]);
  assert.deepEqual(unitsHeldByStage([lostCall, event, gone], stage), []);
});

test("resync prune: fully held units and adoptions are kept unchanged", () => {
  const stage = new Map<string, T3dNode>([node("Fn", "K2Node_CallFunction_9001", CALL)]);
  const held = unit("function:Fn", "Fn", ["Fn/K2Node_CallFunction_9001"]);
  const adopted = { ...unit("event:Hand", "EventGraph", ["EventGraph/K2Node_CustomEvent_9001"]), adopt: { entry: "EventGraph/K2Node_CustomEvent_1", nodes: [], hash: "sha256:x", recordedAt: "2026-01-01T00:00:00", stageSyncedAt: null } } as ManifestUnit;
  assert.deepEqual(unitsHeldByStage([held, adopted], stage), [held, adopted]);
});
