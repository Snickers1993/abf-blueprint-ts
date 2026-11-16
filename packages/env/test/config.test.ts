import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AbfcError,
  CONFIG_SCHEMA_VERSION,
  loadProjectConfig,
  loadUserConfig,
  resolveEnvironment,
  userConfigFile,
} from "../src/index.js";
import { fakeHost } from "./fakehost.js";

const dir = "D:\\p";

function load(cfg: unknown) {
  return loadProjectConfig(dir, fakeHost({ files: { [`${dir}\\abf.config.json`]: JSON.stringify(cfg) } }));
}

function code(fn: () => unknown): { code: string; message: string; tried: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof AbfcError) {
      return { code: e.diagnostic.code, message: e.diagnostic.message, tried: JSON.stringify(e.diagnostic.tried ?? []) };
    }
    throw e;
  }
  assert.fail("expected an AbfcError");
}

test("schema 2 is the current schema", () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 2);
});

test("defaults: schemaVersion 1 when absent, sourceRoot src, class-manager table", () => {
  const cfg = load({ mod: { name: "TestMod" } });
  assert.equal(cfg.schemaVersion, 1);
  assert.equal(cfg.sourceRoot, "src");
  assert.deepEqual(cfg.classManager, { table: "DataTables/DT_ClassManager" });
});

test("schema 2 values are read", () => {
  const cfg = load({ schemaVersion: 2, mod: { name: "TestMod" }, sourceRoot: "ts/classes", classManager: { table: "Data/CM" } });
  assert.equal(cfg.schemaVersion, 2);
  assert.equal(cfg.sourceRoot, "ts/classes");
  assert.deepEqual(cfg.classManager, { table: "Data/CM" });
});

test("schemaVersion must be a positive integer (ABFC1021)", () => {
  for (const bad of [0, -1, 1.5, "2", null]) {
    const e = code(() => load({ schemaVersion: bad, mod: { name: "TestMod" } }));
    assert.equal(e.code, "ABFC1021", String(bad));
    assert.match(e.message, /schemaVersion/);
  }
});

test("a newer schema is ABFC1022", () => {
  const e = code(() => load({ schemaVersion: 3, mod: { name: "TestMod" } }));
  assert.equal(e.code, "ABFC1022");
  assert.equal(e.message, "abf.config.json was written by a newer abfc (schema 3); this abfc reads schema 2 or older.");
});

test("sourceRoot rules", () => {
  for (const bad of ["C:\\x", "/abs", "..", "a/../b", "a\\..\\b", ""]) {
    const e = code(() => load({ schemaVersion: 2, mod: { name: "TestMod" }, sourceRoot: bad }));
    assert.equal(e.code, "ABFC1021", JSON.stringify(bad));
    assert.match(e.message, /sourceRoot/);
  }
  assert.equal(load({ mod: { name: "TestMod" }, sourceRoot: "src\\ts" }).sourceRoot, "src\\ts");
});

test("classManager.table must be a valid mod-relative path", () => {
  for (const bad of ["/Data/CM", "Data/CM/", "My Data/CM", "Data//CM"]) {
    const e = code(() => load({ mod: { name: "TestMod" }, classManager: { table: bad } }));
    assert.equal(e.code, "ABFC1021", bad);
    assert.match(e.message, /classManager\.table/);
  }
});

test("schema 2 classOnly: relative entries become /<mod>/X, a leading slash fails, absent stays absent", () => {
  const cfg = load({ schemaVersion: 2, mod: { name: "TestMod" }, stubs: { modAssets: [], classOnly: ["Rooms/BP_Section"] } });
  assert.deepEqual(cfg.stubs.classOnly, ["/TestMod/Rooms/BP_Section"]);
  assert.equal(load({ schemaVersion: 2, mod: { name: "TestMod" }, stubs: { modAssets: [] } }).stubs.classOnly, undefined);
  const e = code(() => load({ schemaVersion: 2, mod: { name: "TestMod" }, stubs: { classOnly: ["/TestMod/Rooms/BP_Section"] } }));
  assert.equal(e.code, "ABFC1021");
  assert.match(e.message, /stubs\.classOnly\[0\]/);
});

test("schema 2 modAssets: relative entries become /<mod>/X, a leading slash fails", () => {
  const cfg = load({ schemaVersion: 2, mod: { name: "TestMod" }, stubs: { modAssets: ["Relays/BP_X", "Y"] } });
  assert.deepEqual(cfg.stubs.modAssets, ["/TestMod/Relays/BP_X", "/TestMod/Y"]);

  const e = code(() => load({ schemaVersion: 2, mod: { name: "TestMod" }, stubs: { modAssets: ["Ok", "/TestMod/Relays/BP_X"] } }));
  assert.equal(e.code, "ABFC1021");
  assert.match(e.message, /stubs\.modAssets\[1\]/);
  assert.match(e.message, /write mod-relative paths such as "Relays\/BP_X"/);

  const bad = code(() => load({ schemaVersion: 2, mod: { name: "TestMod" }, stubs: { modAssets: ["My Relays/X"] } }));
  assert.equal(bad.code, "ABFC1021");
  assert.match(bad.message, /stubs\.modAssets\[0\]/);
});

test("schema 1 modAssets are kept as given; 'all' is untouched", () => {
  const cfg = load({ mod: { name: "TestMod" }, stubs: { modAssets: ["/TestMod/Relays/BP_X"] } });
  assert.deepEqual(cfg.stubs.modAssets, ["/TestMod/Relays/BP_X"]);
  assert.equal(load({ schemaVersion: 2, mod: { name: "TestMod" }, stubs: { modAssets: "all" } }).stubs.modAssets, "all");
});

test("resolveEnvironment warns ABFC1031 for schema 1 only", () => {
  const host = (cfg: unknown) => fakeHost({ files: { [`${dir}\\abf.config.json`]: JSON.stringify(cfg) } });
  const v1 = resolveEnvironment(host({ mod: { name: "TestMod" } }), { projectDir: dir, flags: {} });
  const w = v1.diagnostics.find((d) => d.code === "ABFC1031");
  assert.ok(w);
  assert.equal(w.severity, "warning");
  assert.equal(w.message, "abf.config.json uses schema 1.");
  const v2 = resolveEnvironment(host({ schemaVersion: 2, mod: { name: "TestMod" } }), { projectDir: dir, flags: {} });
  assert.equal(v2.diagnostics.some((d) => d.code === "ABFC1031"), false);
});

test("userConfigFile: ABFC_USER_CONFIG wins (any case), then APPDATA, else null", () => {
  assert.equal(userConfigFile({ ABFC_USER_CONFIG: "D:\\scratch\\u.json", APPDATA: "C:\\A" }), "D:\\scratch\\u.json");
  assert.equal(userConfigFile({ abfc_user_config: "D:\\scratch\\u.json" }), "D:\\scratch\\u.json");
  assert.equal(userConfigFile({ ABFC_USER_CONFIG: "", APPDATA: "C:\\A" }), "C:\\A\\abfc\\config.json");
  assert.equal(userConfigFile({ APPDATA: "C:\\A" }), "C:\\A\\abfc\\config.json");
  assert.equal(userConfigFile({}), null);
});

test("loadUserConfig reads the ABFC_USER_CONFIG file, accepts schemaVersion, defaults no project-only keys", () => {
  const file = "D:\\scratch\\u.json";
  const host = fakeHost({ files: { [file]: JSON.stringify({ schemaVersion: 2, modsDir: "D:\\Mods" }), "C:\\A\\abfc\\config.json": JSON.stringify({ modsDir: "D:\\Other" }) } });
  const u = loadUserConfig({ ABFC_USER_CONFIG: file, APPDATA: "C:\\A" }, host);
  assert.ok(u);
  assert.equal(u.schemaVersion, 2);
  assert.equal(u.modsDir, "D:\\Mods");
  assert.equal(u.sourceRoot, undefined);
  assert.equal(u.classManager, undefined);
  assert.equal(u.mod, undefined);

  const viaAppData = loadUserConfig({ APPDATA: "C:\\A" }, host);
  assert.equal(viaAppData?.modsDir, "D:\\Other");
  assert.equal(viaAppData?.schemaVersion, undefined);

  assert.equal(loadUserConfig({ ABFC_USER_CONFIG: "D:\\missing.json" }, host), null);
  assert.equal(loadUserConfig({}, host), null);

  const newer = fakeHost({ files: { [file]: JSON.stringify({ schemaVersion: 9 }) } });
  assert.equal(code(() => loadUserConfig({ ABFC_USER_CONFIG: file }, newer)).code, "ABFC1022");
});
