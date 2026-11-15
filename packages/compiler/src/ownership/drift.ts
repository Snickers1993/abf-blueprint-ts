// Drift detection (design 8.3): is an owned unit in the stage still what abfc applied?
import { t3dNodeKey, unitStateHash } from "@abfc/ir";
import type { Diagnostic, Span, T3dNode } from "@abfc/ir";
import type { ManifestUnit } from "./manifest.js";

/** The part of the backend's `StageStatus` the compiler needs. */
export interface StageInfo {
  syncedAt: string | null;
}

export type UnitState = "clean" | "edited" | "missing" | "pendingAdoption" | "pendingApply" | "staleStage";

export interface UnitFingerprint {
  assetHash: string;
  nodeHashes: Record<string, string>;
  /** Sorted `<node>.<pin> > <node>.<pin>` links of the owned nodes (owned -> any, and foreign -> owned). */
  links: string[];
}

function pinNameOf(nodes: Map<string, T3dNode>, node: string, pinId: string): string {
  return nodes.get(node)?.pins.find((p) => p.id === pinId)?.name ?? pinId;
}

/** Hash, per-node hashes and link list of the named nodes of a snapshot. */
export function fingerprintUnit(snapshot: Map<string, T3dNode>, names: string[]): UnitFingerprint {
  const owned = new Set(names);
  const nodeHashes: Record<string, string> = {};
  const links: string[] = [];
  for (const name of [...names].sort()) {
    nodeHashes[name] = unitStateHash(snapshot, [name]);
    const n = snapshot.get(name);
    if (!n) continue;
    for (const p of n.pins) {
      for (const l of p.links) {
        // a pin link never leaves its graph: the target is the node of that name in the linking node's graph
        const target = t3dNodeKey(n.graph, l.node);
        const other = `${target}.${pinNameOf(snapshot, target, l.pinId)}`;
        const mine = `${name}.${p.name}`;
        if (p.dir === "out") links.push(`${mine} > ${other}`);
        else if (!owned.has(target)) links.push(`${other} > ${mine}`);
      }
    }
  }
  links.sort();
  return { assetHash: unitStateHash(snapshot, names), nodeHashes, links };
}

export function unitState(unit: ManifestUnit, snapshot: Map<string, T3dNode>, stage: StageInfo): UnitState {
  if (unit.stageSyncedAt !== null && stage.syncedAt !== unit.stageSyncedAt) return "staleStage";
  if (unit.adopt !== null && unit.stageSyncedAt === null) return "pendingAdoption";
  if (unit.assetHash === null || unit.nodes.length === 0) return "pendingApply";
  if (unit.nodes.some((n) => !snapshot.has(n))) return "missing";
  return unitStateHash(snapshot, unit.nodes) === unit.assetHash ? "clean" : "edited";
}

/**
 * Was the unit applied by abfc and does the stage still hold exactly that applied graph? After a `--resync` from a published mod
 * the stage timestamp differs from the manifest, but the abfc-built nodes are what the stage holds.
 */
export function builtGraphMatches(unit: ManifestUnit, snapshot: Map<string, T3dNode>): boolean {
  if (unit.assetHash === null || unit.nodes.length === 0) return false;
  if (unit.nodes.some((n) => !snapshot.has(n))) return engineNormalisedFunction(unit, snapshot) !== null;
  return unitStateHash(snapshot, unit.nodes) === unit.assetHash;
}

/**
 * Node classes the editor itself rewrites when it saves and reloads a Blueprint: a struct break or make node on a struct with a
 * native break/make function (Vector, Rotator, Transform...) comes back as a different node (or under a new name). Graphs abfc built
 * hold these nodes; the published asset, read again after a `--resync`, does not.
 */
const ENGINE_REWRITTEN_NODE = /(^|\/)K2Node_(BreakStruct|MakeStruct)_\d+$/;
const NEVER_OWNED_IN_FUNCTION = /(K2Node_FunctionEntry|K2Node_FunctionResult|EdGraphNode_Comment)$/;

/**
 * A function unit whose graph is still in the stage and whose only missing nodes are of the classes the editor rewrites on save.
 * Says nothing about the rest of the graph: enough to keep the unit tracked across a re-sync (so the build either rebases it, when
 * engineNormalisedFunction accepts it, or replaces it as an owned unit), not enough to call it unchanged.
 */
export function missingOnlyEngineRewritten(unit: ManifestUnit, snapshot: Map<string, T3dNode>): boolean {
  if (!unit.id.startsWith("function:") || unit.assetHash === null || unit.nodes.length === 0) return false;
  const missing = unit.nodes.filter((n) => !snapshot.has(n));
  return missing.length > 0 && missing.length < unit.nodes.length && missing.every((n) => ENGINE_REWRITTEN_NODE.test(n));
}

/** A node the editor can leave in place of a struct break/make node: the same node class renamed, or a native Break... or Make... call. */
function isRewriteReplacement(n: T3dNode): boolean {
  if (/K2Node_(BreakStruct|MakeStruct)$/.test(n.cls)) return true;
  return n.cls.endsWith("K2Node_CallFunction") && n.head.some((h) => /MemberName="(Break|Make)\w+"/.test(h));
}

function linkMentions(link: string, keys: Set<string>): boolean {
  const [from = "", to = ""] = link.split(" > ");
  for (const k of keys) if (from.startsWith(`${k}.`) || to.startsWith(`${k}.`)) return true;
  return false;
}

/**
 * A function unit (owned whole: one function graph) whose stage graph differs from what abfc applied only in nodes the editor
 * rewrites on save. Returns the keys of the graph's current nodes (the unit's new node list), or null when the unit is not such a
 * case: not a function, nothing missing, a missing node of another class, or the function graph gone.
 *
 * Everything outside the rewrite must be what abfc applied, or the unit is real drift:
 * - each missing node has exactly one replacement in the graph, and every new node is such a replacement;
 * - a surviving node whose hash changed was linked to a rewritten node (its link target was renamed), no other node changed;
 * - the links that do not touch a rewritten or replacement node are the recorded ones.
 */
export function engineNormalisedFunction(unit: ManifestUnit, snapshot: Map<string, T3dNode>): string[] | null {
  if (!unit.id.startsWith("function:") || unit.assetHash === null || unit.nodes.length === 0) return null;
  const missing = unit.nodes.filter((n) => !snapshot.has(n));
  if (missing.length === 0 || !missing.every((n) => ENGINE_REWRITTEN_NODE.test(n))) return null;
  // the owned nodes still there, plus the graph's other nodes except those a function unit never owns (entry, result, comments/tags)
  const owned = new Set(unit.nodes);
  const inGraph = [...snapshot.entries()].filter(([, n]) => n.graph === unit.graph);
  const survivors = inGraph.filter(([k]) => owned.has(k)).map(([k]) => k);
  const added = inGraph.filter(([k, n]) => !owned.has(k) && !NEVER_OWNED_IN_FUNCTION.test(n.cls));
  if (survivors.length === 0) return null;
  if (added.length !== missing.length || !added.every(([, n]) => isRewriteReplacement(n))) return null;
  const now = [...survivors, ...added.map(([k]) => k)].sort();
  if (unit.nodeHashes && unit.links) {
    const gone = new Set(missing);
    const fresh = new Set(added.map(([k]) => k));
    const fp = fingerprintUnit(snapshot, now);
    for (const k of survivors) {
      if (fp.nodeHashes[k] === unit.nodeHashes[k]) continue;
      // a changed survivor is acceptable only as a neighbour of a rewritten node
      if (!unit.links.some((l) => (linkMentions(l, gone) || linkMentions(l, fresh)) && linkMentions(l, new Set([k])))) return null;
    }
    // The recorded links can already name the replacement nodes (the editor rewrites on compile, before the read-back), so drop those too.
    const was = unit.links.filter((l) => !linkMentions(l, gone) && !linkMentions(l, fresh)).sort();
    const is = fp.links.filter((l) => !linkMentions(l, fresh)).sort();
    if (was.length !== is.length || was.some((l, i) => l !== is[i])) return null;
  }
  return now;
}

/**
 * Same manifest units with `stageSyncedAt` moved to the current stage for the stale units whose built graph the stage still holds.
 * A function unit that differs only in nodes the editor rewrites on save (see engineNormalisedFunction) is rebased onto the stage's
 * graph as well: its node list, hashes and links become those of the stage, so the build treats it as clean and leaves it alone.
 */
export function rebaseStaleUnits<T extends { units: ManifestUnit[] }>(manifest: T, snapshot: Map<string, T3dNode>, stage: StageInfo): { manifest: T; changed: boolean } {
  let changed = false;
  const units = manifest.units.map((u) => {
    if (unitState(u, snapshot, stage) !== "staleStage" || !builtGraphMatches(u, snapshot)) return u;
    changed = true;
    const now = engineNormalisedFunction(u, snapshot);
    if (now === null) return { ...u, stageSyncedAt: stage.syncedAt };
    const fp = fingerprintUnit(snapshot, now);
    return { ...u, stageSyncedAt: stage.syncedAt, nodes: now, assetHash: fp.assetHash, nodeHashes: fp.nodeHashes, links: fp.links };
  });
  return { manifest: changed ? { ...manifest, units } : manifest, changed };
}

function unitLabel(asset: string, unitId: string): string {
  const short = asset.slice(asset.lastIndexOf("/") + 1);
  const colon = unitId.indexOf(":");
  const kind = colon < 0 ? "unit" : unitId.slice(0, colon);
  return `${short} ${kind} ${colon < 0 ? unitId : unitId.slice(colon + 1)}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** ABFC5001 / ABFC5002 / ABFC5004 for the units whose stage state forbids replacing them. */
export function driftDiagnostics(
  asset: string,
  units: ManifestUnit[],
  snapshot: Map<string, T3dNode>,
  stage: StageInfo,
  spans: Map<string, Span>,
  opts: { severity?: "error" | "warning" } = {},
): Diagnostic[] {
  // `abfc status` preview: a manifest unit never applied whose event name exists as a hand-made event (the next build replaces it).
  const handMadeEvents = new Set<string>();
  for (const n of snapshot.values()) {
    const m = n.cls.endsWith("K2Node_CustomEvent") ? n.head.map((h) => /^CustomFunctionName="([^"]+)"/.exec(h)?.[1]).find((x) => x !== undefined) : undefined;
    if (m !== undefined) handMadeEvents.add(m);
  }
  const out: Diagnostic[] = [];
  for (const unit of units) {
    const label = unitLabel(asset, unit.id);
    const base = { severity: opts.severity ?? ("error" as const), asset, ...(spans.has(unit.id) ? { span: spans.get(unit.id)! } : {}) };
    const state = unitState(unit, snapshot, stage);
    if (state === "pendingApply" && opts.severity === "warning" && unit.adopt === null && unit.id.startsWith("event:") && handMadeEvents.has(unit.id.slice("event:".length))) {
      out.push({
        ...base,
        code: "ABFC5003",
        message: `${label} is declared in TypeScript but already exists as a hand-made event. The next build replaces it (TypeScript wins).`,
        fix: "nothing to do: abfc build replaces the hand-made event; to keep it, move its logic into the .ts file first.",
      });
    }
    if (state === "missing") {
      const gone = unit.nodes.filter((n) => !snapshot.has(n));
      out.push({
        ...base,
        code: "ABFC5002",
        message: `${label}: ${plural(gone.length, "owned node")} missing in the asset (${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", ..." : ""}). abfc build --drift replaces it now (TypeScript wins); otherwise the next build that changes this class does.`,
        fix: "run abfc build --drift to apply the unit again now (a plain build skips an asset whose TypeScript did not change); to keep the editor version, move it into the .ts file first.",
      });
    } else if (state === "edited") {
      const fp = fingerprintUnit(snapshot, unit.nodes);
      let counts = "";
      if (unit.nodeHashes && unit.links) {
        const changed = unit.nodes.filter((n) => fp.nodeHashes[n] !== unit.nodeHashes![n]).length;
        const was = new Set(unit.links);
        const now = new Set(fp.links);
        const added = fp.links.filter((l) => !was.has(l)).length;
        const removed = unit.links.filter((l) => !now.has(l)).length;
        counts = ` (${plural(changed, "node")} changed, ${plural(added, "link")} added, ${plural(removed, "link")} removed)`;
      }
      out.push({
        ...base,
        code: "ABFC5001",
        message: `${label} was edited in the editor since the last build${counts}. abfc build --drift replaces it now (TypeScript wins); otherwise the next build that changes this class does.`,
        fix: "run abfc build --drift to replace the edited nodes now (a plain build skips an asset whose TypeScript did not change); to keep the edit, move it into the .ts file first.",
      });
    } else if (state === "staleStage" && builtGraphMatches(unit, snapshot)) {
      continue; // re-synced from a published mod that holds the abfc-built graph
    } else if (state === "staleStage" && unit.adopt === null) {
      const gone = unit.nodes.filter((n) => !snapshot.has(n));
      if (gone.length > 0) {
        out.push({
          ...base,
          code: "ABFC5002",
          message: `${label}: the stage was re-synced and ${plural(gone.length, "owned node")} ${gone.length === 1 ? "is" : "are"} missing in the asset (${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", ..." : ""}). The next build replaces it (TypeScript wins).`,
          fix: "nothing to do: abfc build applies the unit again.",
        });
      } else if (unit.assetHash !== null && unit.nodes.length > 0) {
        out.push({
          ...base,
          code: "ABFC5001",
          message: `${label} differs from what abfc applied (the stage was re-synced from the real mod). The next build replaces it (TypeScript wins).`,
          fix: "nothing to do: abfc build replaces it; to keep the change, move it into the .ts file first.",
        });
      }
    } else if ((state === "pendingAdoption" || state === "staleStage") && unit.adopt !== null) {
      if (unitStateHash(snapshot, unit.adopt.nodes) !== unit.adopt.hash) {
        out.push({
          ...base,
          code: "ABFC5004",
          message: `${label}: the hand-made unit adopted earlier changed in the real mod (the staged copy no longer matches the recorded adoption hash).`,
          fix: "nothing to do: abfc build replaces the hand-made unit with the TypeScript one.",
        });
      }
    }
  }
  return out;
}
