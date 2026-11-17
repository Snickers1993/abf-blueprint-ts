import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AbfcError } from "@abfc/env";
import { BpApplyBackend, McpStdioClient, grantPublish, publishResultFrom } from "../src/index.js";
import { auditTimeoutSeconds } from "../src/bpapply-backend.js";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/fake-bpapply-server.mjs", import.meta.url));

type Call = { tool: string; args: Record<string, unknown> };

interface Ctx {
  backend: BpApplyBackend;
  dir: string;
  calls: () => Call[];
}

async function withBackend(config: Record<string, unknown>, fn: (c: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "abfc-backend-test-"));
  const logFile = join(dir, "calls.log");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [FIXTURE],
    cwd: dir,
    env: { ...env, FAKE_LOG: logFile, FAKE_CONFIG: JSON.stringify(config), FAKE_DIR: dir },
    requestTimeoutMs: 10_000,
    closeGraceMs: 5000,
  });
  const backend = new BpApplyBackend(client, { serverDir: "C:\\fake\\server", now: () => new Date(2026, 0, 2, 3, 4, 5) });
  const calls = (): Call[] => {
    try {
      return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
    } catch {
      return [];
    }
  };
  try {
    await fn({ backend, dir, calls });
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<AbfcError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AbfcError, `expected AbfcError, got ${String(e)}`);
    assert.equal(e.diagnostic.code, code);
    return e;
  }
  assert.fail(`expected ${code}`);
}

test("info with backend_info and abfc_extensions", async () => {
  await withBackend({}, async ({ backend }) => {
    const info = await backend.info();
    assert.equal(info.protocol, 1);
    assert.equal(info.serverVersion, "fake-2");
    assert.equal(info.headlessDir, "C:\\fake-headless");
    assert.equal(info.documentsDir, "C:\\fake-docs");
    assert.equal(info.headlessDirHasSpace, false);
    assert.deepEqual(info.extensions, ["reflect", "compile_node_refs", "bp_read_seconds"]);
    assert.equal(info.capabilities.pinTypes, true);
    assert.equal(info.capabilities.castObjectPin, true);
    assert.equal(info.capabilities.reflect, true);
    assert.equal(info.capabilities.compileErrorNodeRefs, true);
    assert.equal(info.capabilities.containerTypes.map, true);
    assert.equal(info.capabilities.backendContainerTypes?.map, true);
  });
});

test("info: engineVersion passes through from backend_info", async () => {
  const backendInfo = {
    protocol: 1,
    serverVersion: "2.4.0",
    engineVersion: "5.4.4",
    editorRoot: null,
    headlessDir: "C:\\fake-headless",
    documentsDir: "C:\\fake-docs",
    capabilities: { pinTypes: true },
    bpApply: { features: ["pin_types"], nodeKinds: ["call"] },
  };
  await withBackend({ backendInfo }, async ({ backend }) => {
    const info = await backend.info();
    assert.equal(info.engineVersion, "5.4.4");
    assert.equal(info.serverVersion, "2.4.0");
  });
  await withBackend({}, async ({ backend }) => {
    assert.equal((await backend.info()).engineVersion, null);
  });
});

test("info without backend_info: protocol null, no error, fallback capabilities", async () => {
  const tools = ["staging_sync", "staging_status", "bp_apply", "bp_read", "bp_compile_report", "bp_game_test", "mod_audit"];
  await withBackend({ tools }, async ({ backend, calls }) => {
    const info = await backend.info();
    assert.equal(info.protocol, null);
    assert.equal(info.headlessDir, null);
    assert.equal(info.headlessDirHasSpace, false);
    assert.deepEqual(info.extensions, []);
    assert.equal(info.capabilities.pinTypes, false);
    assert.equal(info.capabilities.reflect, false);
    assert.equal(info.capabilities.audit, true);
    assert.deepEqual(calls(), []); // nothing was called: neither backend_info nor abfc_extensions is listed
  });
});

test("info: a headless folder with a space is flagged", async () => {
  const backendInfo = {
    protocol: 1,
    headlessDir: "C:\\Users\\Jane Doe\\AppData\\Local\\headless",
    capabilities: { pinTypes: false },
    bpApply: { features: [] },
  };
  await withBackend({ backendInfo }, async ({ backend }) => {
    const info = await backend.info();
    assert.equal(info.headlessDirHasSpace, true);
    assert.equal(info.capabilities.pinTypes, false);
  });
});

test("info: missing core tool -> ABFC4001 naming the tool and the server dir", async () => {
  const tools = ["backend_info", "staging_sync", "staging_status", "bp_read", "bp_compile_report", "bp_game_test"];
  await withBackend({ tools }, async ({ backend }) => {
    const e = await rejectsWith(backend.info(), "ABFC4001");
    assert.match(e.diagnostic.message, /bp_apply/);
    assert.match(e.diagnostic.message, /C:\\fake\\server/);
    assert.equal(e.exitCode, 2);
  });
});

test("stage and stageStatus", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const rep = await backend.stage("C:\\mods\\TestMod", { discardChanges: true });
    assert.deepEqual(rep, { mod: "TestMod", files: 7, stagingPath: "C:\\fake\\stage\\TestMod" });
    assert.deepEqual(calls()[0], { tool: "staging_sync", args: { mod_dir: "C:\\mods\\TestMod", discard_changes: true } });
    const st = await backend.stageStatus("TestMod");
    assert.deepEqual(st, {
      mod: "TestMod",
      stagingPath: "C:\\fake\\stage\\TestMod",
      syncedAt: "2026-01-02T03:04:05Z",
      changed: ["Content/A.uasset"],
      added: [],
      removed: ["Content/B.uasset"],
      conflicts: [],
      stale: [],
    });
  });
});

test("(S13) stageStatus names a conflicting file by its path, not as JSON", async () => {
  await withBackend({}, async ({ backend }) => {
    const st = await backend.stageStatus("conflicted");
    assert.deepEqual(st?.conflicts, ["Content/C.uasset"]);
  });
});

test("stageStatus: 'not staged' is null, any other tool error is ABFC4002", async () => {
  await withBackend({}, async ({ backend }) => {
    assert.equal(await backend.stageStatus("ghost"), null);
    const e = await rejectsWith(backend.stageStatus("broken"), "ABFC4002");
    assert.match(e.diagnostic.message, /staging_status/);
    assert.match(e.diagnostic.message, /disk on fire/);
  });
});

test("read maps the export path and seconds", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const snap = await backend.read("TestMod", "/TestMod/BP_A");
    assert.equal(snap.asset, "/TestMod/BP_A");
    assert.equal(snap.run, "C:\\fake\\runs\\read-1");
    assert.equal(snap.exportPath, "C:\\fake\\runs\\read-1\\export.t3d");
    assert.equal(snap.seconds, 4.2);
    assert.deepEqual(calls()[0]?.args, { mod: "TestMod", asset_path: "/TestMod/BP_A", include_pins: false, timeout_seconds: 300 });
  });
});

test("applySpecs: writes the spec file and maps a successful result", async () => {
  await withBackend({}, async ({ backend, dir, calls }) => {
    const cacheDir = join(dir, "cache");
    const res = await backend.applySpecs("TestMod", [{ asset: "/TestMod/BP_A" }], { label: "unit one", cacheDir });
    assert.equal(res.ok, true);
    assert.equal(res.rolledBack, false);
    assert.equal(res.run, "C:\\fake\\runs\\apply-1");
    assert.equal(res.seconds, 9.25);
    assert.deepEqual(res.assets, [
      { asset: "/TestMod/BP_A", node_ids: { EventGraph: { ev: "K2Node_CustomEvent_0" } }, final: "final_0.t3d" },
    ]);
    assert.deepEqual(res.compile.warnings, [{ asset: "/TestMod/BP_A", message: "careful" }]);
    const files = readdirSync(cacheDir);
    assert.deepEqual(files, ["apply-20260102-030405-unit_one.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(cacheDir, files[0]!), "utf8")), [{ asset: "/TestMod/BP_A" }]);
    const args = calls()[0]?.args;
    assert.equal(args?.mod, "TestMod");
    assert.equal(args?.timeout_seconds, 600);
    assert.equal(args?.keep_on_error, false);
    assert.equal(args?.spec_file, join(cacheDir, files[0]!));
  });
});

test("applySpecs: a compile failure is a result with rolledBack, compile entries and node refs", async () => {
  await withBackend({}, async ({ backend, dir }) => {
    const res = await backend.applySpecs("failmod", [], { label: "x", cacheDir: dir, keepOnError: true });
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);
    assert.equal(res.assets, null);
    assert.equal(res.error, "2 compile error(s) in the edited assets");
    assert.equal(res.logTail, "tail line");
    assert.deepEqual(res.compile.errors, [
      { asset: "/TestMod/BP_A", message: "Bad pin", node: "K2Node_CallFunction_3", graph: "EventGraph" },
      { asset: "/TestMod/BP_A", message: "Plain error" },
    ]);
  });
});

test("applySpecs: invalid spec is a result; memory-swap refusal is ABFC4100; a traceback is ABFC4002", async () => {
  await withBackend({}, async ({ backend, dir }) => {
    const bad = await backend.applySpecs("badspec", [], { label: "x", cacheDir: dir });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /invalid spec: .*missing asset/);
    const e = await rejectsWith(backend.applySpecs("memswap", [], { label: "x", cacheDir: dir }), "ABFC4100");
    assert.match(e.diagnostic.message, /Nodes array not found/);
    assert.match(e.diagnostic.message, /apply-1/);
    const c = await rejectsWith(backend.applySpecs("crash", [], { label: "x", cacheDir: dir }), "ABFC4002");
    assert.match(c.diagnostic.message, /kaboom/);
  });
});

test("compile maps messages with node refs (null node/graph are omitted)", async () => {
  await withBackend({}, async ({ backend }) => {
    const rep = await backend.compile("TestMod", ["/TestMod/BP_A"]);
    assert.equal(rep.clean, false);
    assert.equal(rep.run, "C:\\fake\\runs\\compile-1");
    assert.equal(rep.seconds, 6);
    assert.deepEqual(rep.messages, [
      { severity: "error", asset: "/TestMod/BP_A", message: "Bad pin", node: "K2Node_CallFunction_3", graph: "EventGraph" },
      { severity: "warning", asset: "/TestMod/BP_A", message: "careful" },
    ]);
  });
});

test("reflect reads the result file (BOM tolerated) and maps the filter", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const res = await backend.reflect({ mod: "TestMod", classes: ["/Script/Fake.Widget"], structs: [], castTargets: ["/Script/Fake.Other"] });
    assert.equal(res.run, "C:\\fake\\runs\\reflect-1");
    assert.equal(res.seconds, 40.5);
    assert.equal(res.data.engineVersion, "5.4.4-fake");
    assert.equal(res.data.classes["/Script/Fake.Widget"]?.castPin, "AsWidget");
    assert.deepEqual(res.data.structs, {});
    assert.deepEqual(res.data.errors, ["one member failed"]);
    assert.deepEqual(res.data.memberSources, ["widgetTree", "scs", "cookedClass"]);
    assert.deepEqual(res.filter, { contentVersion: "v1", rules: [["Allow", "Fake.Widget"], ["Block", "Fake.Widget.Secret"]] });
    assert.deepEqual(calls()[0]?.args, {
      mod: "TestMod",
      classes: ["/Script/Fake.Widget"],
      structs: [],
      cast_targets: ["/Script/Fake.Other"],
      timeout_seconds: 900,
    });
  });
});

test("reflect asks for gameplay tags only when requested and parses them", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const plain = await backend.reflect({ mod: "TestMod", classes: [], structs: [], castTargets: [] });
    assert.equal(plain.data.gameplayTags, undefined);
    assert.equal("gameplay_tags" in (calls()[0]?.args ?? {}), false);
    const res = await backend.reflect({ mod: "TestMod", classes: [], structs: [], castTargets: [], gameplayTags: true });
    assert.equal(calls()[1]?.args.gameplay_tags, true);
    assert.deepEqual(res.data.gameplayTags, { tags: ["ClassManager.EntityDirector.Fake"], sources: { settings: 1 } });
  });
});

test("catalog reads the result file (BOM tolerated) and passes mod and timeout", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const res = await backend.catalog("TestMod");
    assert.equal(res.run, "C:\\fake\\runs\\catalog-1");
    assert.equal(res.seconds, 12.5);
    const data = res.data as { version: number; game: Array<{ path: string }>; scriptClasses: unknown[] };
    assert.equal(data.version, 1);
    assert.equal(data.game[0]?.path, "/Game/Fake/BP_Fake.BP_Fake_C");
    assert.equal(data.scriptClasses.length, 1);
    const call = calls().find((c) => c.tool === "catalog");
    assert.deepEqual(call?.args, { mod: "TestMod", timeout_seconds: 300 });
  });
});

test("catalog without a result file is ABFC4002", async () => {
  await withBackend({}, async ({ backend }) => {
    const e = await rejectsWith(backend.catalog("NoFile"), "ABFC4002");
    assert.match(e.diagnostic.message, /"catalog" returned no result file/);
  });
});

test("reflect passes supers_of only when given and parses supers", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const plain = await backend.reflect({ mod: "TestMod", classes: [], structs: [], castTargets: [] });
    assert.equal(plain.data.supers, undefined);
    assert.equal("supers_of" in (calls()[0]?.args ?? {}), false);
    const res = await backend.reflect({ mod: "TestMod", classes: [], structs: [], castTargets: [], supersOf: ["/Script/Fake.Other"] });
    assert.deepEqual(calls()[1]?.args.supers_of, ["/Script/Fake.Other"]);
    assert.deepEqual(res.data.supers, { "/Script/Fake.Widget": ["/Script/Fake.Base", "/Script/CoreUObject.Object"] });
  });
});

test("assetOps sends bp_asset_ops and maps the result; a refused op is a result, not an exception", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const ok = await backend.assetOps("TestMod", [{ op: "rename", from: "/TestMod/A", to: "/TestMod/B" }, { op: "recreate", asset: "/TestMod/C" }]);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.results, [{ op: "rename", ok: true }, { op: "recreate", ok: true }]);
    assert.deepEqual(ok.touched, ["/TestMod/Row"]);
    assert.equal(ok.error, null);
    assert.deepEqual(calls()[0]?.args.ops, [{ op: "rename", from: "/TestMod/A", to: "/TestMod/B" }, { op: "recreate", asset: "/TestMod/C" }]);
    assert.equal(calls()[0]?.args.mod, "TestMod");
    const bad = await backend.assetOps("TestMod", [{ op: "delete", asset: "/TestMod/Referenced" }]);
    assert.equal(bad.ok, false);
    assert.equal(bad.rolledBack, true);
    assert.ok((bad.error ?? "").includes("referenced by /TestMod/Other"));
    assert.equal(bad.results[0]?.detail, "referenced by /TestMod/Other");
  });
});

test("publish passes delete_removed only when asked and returns the deleted files", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const grant = grantPublish("TestMod");
    const plain = await backend.publish("TestMod", ["/TestMod/A"], grant);
    assert.deepEqual(plain.deleted, []);
    assert.equal("delete_removed" in (calls()[0]?.args ?? {}), false);
    const del = await backend.publish("TestMod", ["/TestMod/A"], grant, { deleteRemoved: true });
    assert.equal(calls()[1]?.args.delete_removed, true);
    assert.deepEqual(del.deleted, ["Content/Old.uasset"]);
  });
});

test("gameTest returns a failing report as a result", async () => {
  await withBackend({}, async ({ backend }) => {
    const rep = await backend.gameTest("TestMod", [{ op: "python" }], { timeoutSeconds: 120 });
    assert.equal(rep.ok, false);
    assert.equal(rep.passed, 1);
    assert.equal(rep.failed, 1);
    assert.equal(rep.complete, true);
    assert.equal(rep.timedOut, false);
    assert.equal(rep.error, "1 step(s) failed");
    assert.deepEqual(rep.steps[1], { i: 1, op: "assert", ok: false, value: "R=False", error: "expected True" });
    assert.deepEqual(rep.steps[0], { i: 0, op: "python", ok: true, value: "R=True" });
    assert.deepEqual(rep.runtimeLog, ["LogScript: Warning: something"]);
  });
});

test("audit", async () => {
  await withBackend({}, async ({ backend }) => {
    const rep = await backend.audit("TestMod");
    assert.equal(rep.ok, true);
    assert.equal(rep.seconds, 45);
  });
});

test("bp_publish is never callable through the backend client (allowlist), even though the server lists it", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const info = await backend.info();
    assert.equal(info.capabilities.publish, true); // descriptive only
    assert.ok(!calls().some((c) => c.tool === "bp_publish"));
  });
});

test("warm session: started once before the first commandlet op, results say warm, staging_sync restarts it, close stops it", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    // not wanted (cold): never started
    const cold = await backend.info();
    assert.equal(cold.capabilities.warmSession, true);
    assert.equal(cold.capabilities.stageAudit, true);
    const snap0 = await backend.read("TestMod", "/TestMod/A");
    assert.equal(snap0.warm, false);
    assert.equal(backend.lastWarm, false);
    assert.equal(calls().filter((c) => c.tool === "warm_session").length, 0);
  });
  const dir = mkdtempSync(join(tmpdir(), "abfc-backend-warm-"));
  const logFile = join(dir, "calls.log");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [FIXTURE],
    cwd: dir,
    env: { ...env, FAKE_LOG: logFile, FAKE_CONFIG: "{}", FAKE_DIR: dir },
    requestTimeoutMs: 10_000,
    closeGraceMs: 5000,
  });
  const backend = new BpApplyBackend(client, { serverDir: "C:\\fake\\server", warm: true });
  const log = (): Call[] => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
  const warmCalls = (): string[] => log().filter((c) => c.tool === "warm_session").map((c) => String(c.args.action));
  try {
    await backend.info();
    assert.deepEqual(warmCalls(), [], "not started before the first operation");
    const snap = await backend.read("TestMod", "/TestMod/A");
    assert.deepEqual(warmCalls(), ["start"]);
    assert.equal(snap.warm, true);
    assert.equal(backend.lastWarm, true);
    const report = await backend.compile("TestMod", ["/TestMod/A"]);
    assert.equal(report.warm, true);
    assert.deepEqual(warmCalls(), ["start"], "started once");
    await backend.stage("C:\\mods\\TestMod", { discardChanges: false });
    await backend.read("TestMod", "/TestMod/A");
    assert.deepEqual(warmCalls(), ["start", "start"], "restarted after staging_sync");
    await backend.close();
    assert.deepEqual(warmCalls(), ["start", "start", "stop"], "stopped on close");
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publishResultFrom maps bp_publish results", () => {
  const a = publishResultFrom({
    published: ["Content/A.uasset"],
    route: "file-copy",
    backup: "B",
    editor: "closed",
    message: "Copied 1",
  });
  assert.equal(a.ok, true);
  assert.equal(a.route, "file-copy");
  assert.deepEqual(a.published, ["Content/A.uasset"]);
  assert.equal(a.editorReason, null);
  assert.deepEqual(a.reloadedInPlace, []);
  assert.deepEqual(a.dirtyAfter, []);

  assert.equal(publishResultFrom({ published: [], message: "Nothing to publish: no changes" }).ok, true);
  // a publish that only deleted files (published stays empty) is a success, a refusal with deletions is not
  const onlyDeleted = publishResultFrom({ published: [], deleted: ["Content/Old.uasset"], message: "Copied 0 file(s)... Deleted 1 file(s)" });
  assert.equal(onlyDeleted.ok, true);
  assert.deepEqual(onlyDeleted.deleted, ["Content/Old.uasset"]);
  assert.equal(publishResultFrom({ published: [], deleted: ["Content/Old.uasset"], refused: "copy failed" }).ok, false);

  const c = publishResultFrom({
    published: [],
    refused: "compile errors",
    error: "Refused: 1",
    message: "Refused: 1",
    compile_errors: [{ asset: "/M/A", message: "bad pin" }],
  });
  assert.equal(c.ok, false);
  assert.deepEqual(c.compileErrors[0], { asset: "/M/A", message: "bad pin" });

  assert.deepEqual(
    publishResultFrom({ published: [], refused: "conflicts", conflicts: [{ path: "Content/A.uasset", reason: "changed" }] })
      .conflicts,
    ["Content/A.uasset: changed"],
  );
  assert.deepEqual(
    publishResultFrom({ published: [], refused: "conflicts", conflicts: ["Content/A.uasset (deleted in the real mod)"] })
      .conflicts,
    ["Content/A.uasset (deleted in the real mod)"],
  );

  const e = publishResultFrom({ published: [], refused: "copy failed", restored: false, backup: "B", message: "x" });
  assert.equal(e.ok, false);
  assert.equal(e.restored, false);
  assert.equal(e.backup, "B");
  assert.equal(e.editorReason, null);

  const f = publishResultFrom({
    published: [],
    refused: "editor refused",
    message: "m",
    editor: "open",
    editor_result: { refused: ["/M/A"], reason: "Play In Editor is running" },
  });
  assert.equal(f.editorReason, "Play In Editor is running");
  assert.equal(f.editor, "open");

  const g = publishResultFrom({
    published: ["Content/A.uasset"],
    route: "live-reload",
    editor: "open",
    message: "ok",
    reloaded_in_place: ["/M/A"],
    dirty_after: ["/M/B"],
    reloaded_referencers: ["/M/C"],
    skipped_dirty: ["/M/D"],
    dirty_published: ["/M/A"],
    compile_errors_after: [{ asset: "/M/C", message: "cannot connect" }, "plain"],
  });
  assert.deepEqual(g.reloadedInPlace, ["/M/A"]);
  assert.deepEqual(g.dirtyAfter, ["/M/B"]);
  assert.equal(g.editorReason, null);
  assert.deepEqual(g.reloadedReferencers, ["/M/C"]);
  assert.deepEqual(g.skippedDirty, ["/M/D"]);
  assert.deepEqual(g.dirtyPublished, ["/M/A"]);
  assert.deepEqual(g.compileErrorsAfter, [
    { asset: "/M/C", message: "cannot connect" },
    { asset: null, message: '"plain"' },
  ]);
  assert.deepEqual([g.tagsRegistered, g.tagsUnregistered, g.tagsStrategy, g.tagsError], [[], [], null, null]);
  const h = publishResultFrom({
    published: ["Content/A.uasset"],
    message: "ok",
    tags_registered: ["A.B"],
    tags_unregistered: ["C.D", "E.F"],
    tags_strategy: "settings",
    tags_error: "refresh: boom",
  });
  assert.deepEqual(h.tagsRegistered, ["A.B"]);
  assert.deepEqual(h.tagsUnregistered, ["C.D", "E.F"]);
  assert.equal(h.tagsStrategy, "settings");
  assert.equal(h.tagsError, "refresh: boom");
  assert.deepEqual(a.reloadedReferencers, []);
  assert.deepEqual(a.skippedDirty, []);
  assert.deepEqual(a.dirtyPublished, []);
  assert.deepEqual(a.compileErrorsAfter, []);
});

test("the mod audit gets 1800 s by default; ABFC_AUDIT_TIMEOUT_SECONDS overrides it (60 s or more)", () => {
  assert.equal(auditTimeoutSeconds({}), 1800);
  assert.equal(auditTimeoutSeconds({ ABFC_AUDIT_TIMEOUT_SECONDS: "3600" }), 3600);
  assert.equal(auditTimeoutSeconds({ ABFC_AUDIT_TIMEOUT_SECONDS: "5" }), 1800);
  assert.equal(auditTimeoutSeconds({ ABFC_AUDIT_TIMEOUT_SECONDS: "soon" }), 1800);
});
