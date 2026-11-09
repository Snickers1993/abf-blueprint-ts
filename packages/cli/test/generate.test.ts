import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { AbfcError, loadProfile } from "@abfc/env";
import type { Backend, ReflectData, ReflectRequest, ReflectResult } from "@abfc/backend";
import { main } from "../src/index.js";
import { TSCONFIG_TEXT } from "../src/init/templates.js";
import { ALL_TOOLS, captureDeps, fakeEnvironmentFiles, fixInfo, scriptedBackend } from "./helpers.js";

const THING = "/Script/FakeEngine.Thing";
const VEC = "/Script/FakeEngine.FakeVec";
const EXT = { extProtocol: 1, serverVersion: "fake-1", python: "3.11.9", features: ["reflect"] };

const pin = (name: string, dir: "in" | "out", category: string, extra: Record<string, unknown> = {}) => ({
  name,
  dir,
  category,
  subCategory: "",
  subCategoryObject: null,
  objectMeta: null,
  container: "None",
  hidden: false,
  default: null,
  ...extra,
});

const firstData: ReflectData = {
  engineVersion: "5.4.4-fake",
  classes: {
    [THING]: {
      meta: "/Script/CoreUObject.Class",
      ancestors: ["/Script/CoreUObject.Object"],
      castPin: "AsThing",
      properties: [{ name: "Origin", pins: [pin("Origin", "out", "struct", { subCategoryObject: VEC })] }],
      functions: [],
    },
  },
  structs: {},
  errors: [],
};
const secondData: ReflectData = {
  engineVersion: "5.4.4-fake",
  classes: {},
  structs: { [VEC]: { fields: [pin("X", "out", "real", { subCategory: "double" })] } },
  errors: [],
};

const EXPORT = [
  "Begin Object Class=/Script/Engine.Blueprint Name=\"BP_Hand\" ExportPath=\"/Script/Engine.Blueprint'/TestMod/Items/BP_Hand.BP_Hand'\"",
  "   ParentClass=\"/Script/CoreUObject.Class'/Script/FakeEngine.Thing'\"",
  "   NewVariables(0)=(VarName=\"Hp\",VarType=(PinCategory=\"int\",PinSubCategory=\"\",PinSubCategoryObject=None,ContainerType=None),DefaultValue=\"0\")",
  "End Object",
].join("\n");
const EXPORT_PATH = "C:\\Runs\\r1\\export.t3d";

interface FakeOptions {
  /** The raw catalog the `catalog` tool returns; the tool exists only when this is set. */
  catalog?: unknown;
  /** Receives every `catalog` call. */
  catalogCalls?: string[];
  /** The staging copy the backend reports (default "C:\\Stage", which holds no files). */
  stagingPath?: string;
  /** Reflect data for the n-th call (1-based); may throw. Default: the fixed first/second data of the classic tests. */
  reflect?: (r: ReflectRequest, n: number) => ReflectData;
}

/** `opts` may be just the reflect responder (a function), as the tests of the parent-chain work pass it. */
async function fakeBackend(
  withReflect: boolean,
  calls: ReflectRequest[],
  reads: string[],
  gameTags?: string[],
  options: FakeOptions | FakeOptions["reflect"] = {},
): Promise<Backend> {
  const opts: FakeOptions = typeof options === "function" ? { reflect: options } : options;
  const baseTools = withReflect ? ALL_TOOLS : ALL_TOOLS.filter((t) => t !== "reflect");
  const tools = opts.catalog !== undefined ? [...baseTools, "catalog"] : baseTools;
  const real = scriptedBackend(tools, { backend_info: fixInfo(), abfc_extensions: EXT });
  const base = await real.info();
  const info = gameTags === undefined ? base : { ...base, capabilities: { ...base.capabilities, gameplayTags: true } };
  const result = (data: ReflectData): ReflectResult => ({
    run: "C:\\Runs\\r1",
    seconds: 0.1,
    file: "C:\\Runs\\r1\\reflect.json",
    data,
    filter: { contentVersion: "v1", rules: [["Block", `${THING} Hidden`]] },
  });
  return {
    info: async () => info,
    stage: async () => ({ mod: "TestMod", files: 1, stagingPath: opts.stagingPath ?? "C:\\Stage" }),
    stageStatus: async () => ({ mod: "TestMod", stagingPath: opts.stagingPath ?? "C:\\Stage", syncedAt: "t", changed: [], added: [], removed: [], conflicts: [], stale: [] }),
    read: async (_mod, asset) => {
      reads.push(asset);
      if (asset.endsWith("Missing")) throw new Error("read failed");
      if (asset.endsWith("Data")) {
        throw new AbfcError({ severity: "error", code: "ABFC4002", message: `backend tool "bp_read" failed: ${asset} is not a Blueprint (DataAsset)` });
      }
      return { asset, run: "C:\\Runs\\r1", exportPath: EXPORT_PATH, structure: { blueprint: { class: "Blueprint" }, functions: [] }, seconds: 1 };
    },
    applySpecs: async () => {
      throw new Error("unused");
    },
    compile: async () => {
      throw new Error("unused");
    },
    catalog: async (mod) => {
      if (opts.catalog === undefined) throw new Error("unused");
      opts.catalogCalls?.push(mod);
      return { run: "C:\\Runs\\c1", seconds: 0.1, file: "C:\\Runs\\c1\\catalog.json", data: opts.catalog };
    },
    reflect: async (r) => {
      calls.push(r);
      if (opts.reflect !== undefined) return result(opts.reflect(r, calls.length));
      return result(calls.length === 1 ? (gameTags === undefined ? firstData : { ...firstData, gameplayTags: { tags: gameTags, sources: {} } }) : secondData);
    },
    gameTest: async () => {
      throw new Error("unused");
    },
    audit: async () => {
      throw new Error("unused");
    },
    publish: async () => {
      throw new Error("unused");
    },
    assetOps: async () => {
      throw new Error("unused");
    },
    close: async () => {},
  };
}

function setup(tmp: string, modAssets: "all" | string[]) {
  const fake = fakeEnvironmentFiles({
    projectConfig: { stubs: { classes: ["/Game/Fake/BP_Fake.BP_Fake_C"], scriptClasses: [THING], modAssets } },
    extraFiles: {
      [join(tmp, "abf.config.json")]: JSON.stringify({
        mod: { name: "TestMod" },
        backend: { kind: "bp_apply", minProtocol: 1 },
        stubs: { classes: ["/Game/Fake/BP_Fake.BP_Fake_C"], scriptClasses: [THING], modAssets },
      }),
      [EXPORT_PATH]: EXPORT,
    },
  });
  // Mod assets on the (fake) disk: one real blueprint, one scratch folder entry that must be skipped, one that fails to read, one that is not a Blueprint.
  const content = `${fake.modDir}\\Content`;
  fake.files[`${content}\\Items\\BP_Hand.uasset`] = "x";
  fake.files[`${content}\\_McpTest\\BP_Scratch.uasset`] = "x";
  fake.files[`${content}\\Items\\Missing.uasset`] = "x";
  fake.files[`${content}\\Items\\Data.uasset`] = "x";
  return fake;
}

test("abfc generate: reflect closure, mod assets, files, lock, paths and timings", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-generate-"));
  try {
    const fake = setup(tmp, "all");
    const calls: ReflectRequest[] = [];
    const reads: string[] = [];
    const cap = captureDeps(fake, () => fakeBackend(true, calls, reads));
    cap.deps.cwd = tmp;
    const code = await main(["generate"], cap.deps);
    const out = cap.text();
    assert.equal(code, 0, out);

    assert.equal(calls.length, 2, "one reflect for the classes, one for the struct closure");
    // The profile's default script classes are part of every set now (abfc generate adds them), so the list is the sorted union, not just the config.
    assert.ok(calls[0]?.classes.includes("/Game/Fake/BP_Fake.BP_Fake_C") && calls[0]?.classes.includes(THING));
    assert.ok((calls[0]?.classes.length ?? 0) > 2);
    assert.deepEqual(calls[0]?.castTargets, ["/Game/Fake/BP_Fake.BP_Fake_C"]);
    assert.deepEqual(calls[1]?.structs, [VEC]);
    assert.deepEqual(reads, ["/TestMod/Items/BP_Hand", "/TestMod/Items/Data", "/TestMod/Items/Missing"]);
    assert.match(out, /warning ABFC4002: could not read \/TestMod\/Items\/Missing/);
    // An asset the backend says is not a Blueprint is skipped without a warning.
    assert.doesNotMatch(out, /Items\/Data/);
    assert.equal((out.match(/ABFC4002/g) ?? []).length, 1, out);

    const dir = join(tmp, ".abfc", "stubs", "ue5.4.4-1050002");
    const script = readFileSync(join(dir, "Script", "FakeEngine.d.ts"), "utf8");
    assert.match(script, /export declare class Thing extends UObject/);
    assert.match(script, /export declare interface FakeVec/);
    const hand = readFileSync(join(dir, "Mod", "TestMod", "Items", "BP_Hand.d.ts"), "utf8");
    assert.match(hand, /^ {2}Hp: int;$/m);
    assert.ok(existsSync(join(dir, "Script", "CoreUObject.d.ts")));

    const lock = JSON.parse(readFileSync(join(dir, "stubs.lock.json"), "utf8")) as Record<string, unknown>;
    assert.equal(lock.profile, "ue5.4.4-1050002");
    assert.equal(lock.engineVersion, "5.4.4-fake");
    assert.equal(lock.filterContentVersion, "v1");
    assert.deepEqual(lock.modAssets, ["/TestMod/Items/BP_Hand"]);
    const index = JSON.parse(readFileSync(join(dir, "_index.json"), "utf8")) as { files: string[]; opaque: string[] };
    assert.ok(index.files.includes("Script/FakeEngine.d.ts"));

    const paths = JSON.parse(readFileSync(join(tmp, ".abfc", "tsconfig.paths.json"), "utf8")) as { compilerOptions: { paths: Record<string, string[]> } };
    assert.deepEqual(paths.compilerOptions.paths["/Script/*"], ["./stubs/ue5.4.4-1050002/Script/*.js"]);
    assert.match(paths.compilerOptions.paths["@abfc/runtime"]?.[0] ?? "", /^[A-Za-z]:\/.*runtime\/dist\/src\/index\.d\.ts$/);

    const runs = readFileSync(join(tmp, ".abfc", "runs.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { step: string }).step);
    assert.deepEqual(runs, ["stubs.read", "stubs.reflect", "stubs.emit"]);

    // A second run rewrites everything, including the lock, under a different clock.
    const again = captureDeps(fake, () => fakeBackend(true, [], []));
    again.deps.cwd = tmp;
    again.deps.now = () => new Date(2027, 5, 6, 7, 8, 9);
    assert.equal(await main(["generate"], again.deps), 0, again.text());
    const lock2 = JSON.parse(readFileSync(join(dir, "stubs.lock.json"), "utf8")) as { createdAt: string };
    assert.notEqual(lock2.createdAt, (lock as { createdAt: string }).createdAt);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a backend without gameplayTags warns ABFC3012 and writes a tags file with the mod's ini tags only; with it the game list is requested, stored and written", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-generate-"));
  try {
    const fake = setup(tmp, []);
    fake.files[`${fake.modDir}\\Config\\Tags\\ExampleTags.ini`] = '[/Script/GameplayTags.GameplayTagsSettings]\r\n+GameplayTagList=(Tag="Mod.Own.Tag",DevComment="")\r\n';
    const cap = captureDeps(fake, () => fakeBackend(true, [], []));
    cap.deps.cwd = tmp;
    assert.equal(await main(["generate"], cap.deps), 0, cap.text());
    assert.match(cap.text(), /warning ABFC3012: the backend cannot list the game's gameplay tags/);
    const file = join(tmp, ".abfc", "tags.d.ts");
    assert.match(readFileSync(file, "utf8"), /"Mod.Own.Tag": true/);
    assert.doesNotMatch(readFileSync(file, "utf8"), /Game.Tag/);
    assert.equal((JSON.parse(readFileSync(join(tmp, ".abfc", "tsconfig.paths.json"), "utf8")) as { files: string[] }).files[0], "./tags.d.ts");

    const calls: ReflectRequest[] = [];
    const withTags = captureDeps(fake, () => fakeBackend(true, calls, [], ["Game.Tag.One"]));
    withTags.deps.cwd = tmp;
    assert.equal(await main(["generate"], withTags.deps), 0, withTags.text());
    assert.doesNotMatch(withTags.text(), /ABFC3012/);
    assert.equal(calls[0]?.gameplayTags, true);
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, ".abfc", "stubs", "ue5.4.4-1050002", "gameplay-tags.json"), "utf8")), ["Game.Tag.One"]);
    const text = readFileSync(file, "utf8");
    assert.match(text, /"Game.Tag.One": true/);
    assert.match(text, /"Mod.Own.Tag": true/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a stage-only tag comes from the stage's Config/Tags ini and leaves tags.d.ts once the stage no longer has it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-generate-"));
  try {
    const fake = setup(tmp, []);
    const stageIni = "C:\\Stage\\Config\\Tags\\StageTags.ini";
    fake.files[stageIni] = '[/Script/GameplayTags.GameplayTagsSettings]\r\n+GameplayTagList=(Tag="Stage.Only.Tag",DevComment="")\r\n';
    const first = captureDeps(fake, () => fakeBackend(true, [], []));
    first.deps.cwd = tmp;
    assert.equal(await main(["generate"], first.deps), 0, first.text());
    const file = join(tmp, ".abfc", "tags.d.ts");
    assert.match(readFileSync(file, "utf8"), /"Stage.Only.Tag": true/);
    delete fake.files[stageIni];
    const second = captureDeps(fake, () => fakeBackend(true, [], []));
    second.deps.cwd = tmp;
    assert.equal(await main(["generate"], second.deps), 0, second.text());
    assert.doesNotMatch(readFileSync(file, "utf8"), /Stage.Only.Tag/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: an explicit mod asset list reads only those assets; scriptModules warns ABFC3010", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-generate-"));
  try {
    const fake = setup(tmp, ["/TestMod/Items/BP_Hand"]);
    fake.files[join(tmp, "abf.config.json")] = JSON.stringify({
      mod: { name: "TestMod" },
      backend: { kind: "bp_apply", minProtocol: 1 },
      stubs: { classes: [], scriptClasses: [THING], modAssets: ["/TestMod/Items/BP_Hand"], scriptModules: ["/Script/Engine"] },
    });
    const reads: string[] = [];
    const cap = captureDeps(fake, () => fakeBackend(true, [], reads));
    cap.deps.cwd = tmp;
    const code = await main(["generate"], cap.deps);
    assert.equal(code, 0, cap.text());
    assert.deepEqual(reads, ["/TestMod/Items/BP_Hand"]);
    assert.match(cap.text(), /warning ABFC3010/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a backend without reflect is ABFC4011, exit 2, nothing written", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-generate-"));
  try {
    const fake = setup(tmp, []);
    const cap = captureDeps(fake, () => fakeBackend(false, [], []));
    cap.deps.cwd = tmp;
    const code = await main(["generate"], cap.deps);
    assert.equal(code, 2, cap.text());
    assert.match(cap.text(), /error ABFC4011/);
    assert.equal(existsSync(join(tmp, ".abfc", "stubs")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: stubs.widgetMembers are emitted on the class stub, recorded in the lock, and an unreflected widget class warns ABFC3011", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-generate-"));
  try {
    const fake = setup(tmp, []);
    const widgetMembers = { [THING]: { TitleText: "/Script/UMG.TextBlock" } };
    fake.files[join(tmp, "abf.config.json")] = JSON.stringify({
      mod: { name: "TestMod" },
      backend: { kind: "bp_apply", minProtocol: 1 },
      stubs: { classes: [], scriptClasses: [THING], modAssets: [], widgetMembers },
    });
    const calls: ReflectRequest[] = [];
    const cap = captureDeps(fake, () => fakeBackend(true, calls, []));
    cap.deps.cwd = tmp;
    const code = await main(["generate"], cap.deps);
    const out = cap.text();
    assert.equal(code, 0, out);
    assert.match(out, /warning ABFC3011: stubs\.widgetMembers: \/Script\/FakeEngine\.Thing TitleText is a \/Script\/UMG\.TextBlock, which is not in the stubs/);
    // The widget class is requested automatically; the fix is to retry it with --add, not to list it in the config.
    assert.match(out, /abfc generate --add \/Script\/UMG\.TextBlock/);
    assert.doesNotMatch(out, /add "[^"]*" to stubs\.scriptClasses/);
    assert.ok(calls.some((r) => r.classes.includes("/Script/UMG.TextBlock")), "the widget class is part of the reflect request");
    assert.match(out, /warning ABFC3015: stubs\.widgetMembers is deprecated; 1 entry was not found by reflection and is still taken from the config: \/Script\/FakeEngine\.Thing:TitleText/);
    assert.doesNotMatch(out, /ABFC3014/, "no Blueprint classes, nothing to discover");

    const dir = join(tmp, ".abfc", "stubs", "ue5.4.4-1050002");
    const script = readFileSync(join(dir, "Script", "FakeEngine.d.ts"), "utf8");
    assert.match(script, /@bpPath \/Script\/FakeEngine\.Thing:TitleText/);
    assert.match(script, /@bpType object:\/Script\/UMG\.TextBlock/);
    assert.match(script, /@bpWidget/);
    assert.match(script, /readonly TitleText: UObject;/);
    const lock = JSON.parse(readFileSync(join(dir, "stubs.lock.json"), "utf8")) as { widgetMembers: unknown };
    assert.deepEqual(lock.widgetMembers, widgetMembers);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- Automatic stubs: catalog, cache, --add, --refresh (steps 13-14) ----

const BP_FAKE = "/Game/Fake/BP_Fake.BP_Fake_C";
const BP_OTHER = "/Game/Fake/BP_Other.BP_Other_C";
const WBP_HUD = "/Game/Fake/WBP_Hud.WBP_Hud_C";
const OTHER_NATIVE = "/Script/FakeEngine.Other";
const PROFILE = "ue5.4.4-1050002";

const RAW_CATALOG = {
  version: 1,
  engineVersion: "5.4.4-fake",
  game: [
    { path: BP_FAKE, kind: "Blueprint", parent: THING, interface: false },
    { path: BP_OTHER, kind: "Blueprint", parent: THING, interface: false },
    { path: WBP_HUD, kind: "Widget", parent: null, interface: false },
  ],
  scriptClasses: [
    { path: THING, parent: null },
    { path: OTHER_NATIVE, parent: THING },
  ],
  scriptStructs: [VEC],
  scriptEnums: [],
};

/** Reflect data for exactly what was asked: every class with a cast pin, every struct empty. */
function plain(r: ReflectRequest): ReflectData {
  return {
    engineVersion: "5.4.4-fake",
    classes: Object.fromEntries(
      r.classes.map((c) => [
        c,
        { meta: "/Script/CoreUObject.Class", ancestors: ["/Script/CoreUObject.Object"], castPin: `As${c.slice(c.lastIndexOf(".") + 1)}`, properties: [], functions: [] },
      ]),
    ),
    structs: Object.fromEntries(r.structs.map((s) => [s, { fields: [] }])),
    errors: [],
  };
}

interface AutoRun {
  code: number;
  out: string;
  calls: ReflectRequest[];
  reads: string[];
  catalogCalls: string[];
}

/** One `abfc <argv>` over the project in `tmp` with a backend that has the catalog tool (unless `o.catalog` is passed as undefined). */
async function runAuto(fake: ReturnType<typeof setup>, tmp: string, argv: string[], o: FakeOptions = {}): Promise<AutoRun> {
  const calls: ReflectRequest[] = [];
  const reads: string[] = [];
  const catalogCalls: string[] = [];
  const opts: FakeOptions = { catalog: RAW_CATALOG, reflect: plain, catalogCalls, ...o };
  const cap = captureDeps(fake, () => fakeBackend(true, calls, reads, undefined, opts));
  cap.deps.cwd = tmp;
  const code = await main(argv, cap.deps);
  return { code, out: cap.text(), calls, reads, catalogCalls };
}

const profileDir = (tmp: string): string => join(tmp, ".abfc", "stubs", PROFILE);
const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

/** Every file below `dir`, relative, for loose existence checks. */
function readdirDeep(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  walk(dir, "");
  return out;
}

test("abfc generate: the first run fetches the catalog and reflects every game class, the defaults and the config in one call", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, "all");
    const r = await runAuto(fake, tmp, ["generate"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.catalogCalls.length, 1);
    assert.equal(r.calls.length, 1, "one reflect call for everything");
    for (const c of [BP_FAKE, BP_OTHER, WBP_HUD, THING]) assert.ok(r.calls[0]?.classes.includes(c), c);
    assert.ok((r.calls[0]?.classes.length ?? 0) > 4, "the profile's default script classes are part of the set");
    assert.deepEqual(r.calls[0]?.castTargets, [BP_FAKE, BP_OTHER, WBP_HUD].sort());
    assert.match(r.out, /catalog: 3 game classes, 2 engine classes, 1 structs, 0 enums/);
    assert.match(r.out, /generating stubs for \d+ classes \(3 game classes\).*3-4 minutes/);
    assert.match(r.out, /stubs: done in /);
    assert.deepEqual(r.reads, ["/TestMod/Items/BP_Hand", "/TestMod/Items/Data", "/TestMod/Items/Missing"]);

    const dir = profileDir(tmp);
    for (const f of ["_catalog.json", "_names.json", "_cache.json.gz", "_coverage.json", "_library.json", "_index.json", "stubs.lock.json"]) {
      assert.ok(existsSync(join(dir, f)), f);
    }
    assert.equal(readJson(join(dir, "_catalog.json")).game.length, 3);
    const names = readJson(join(dir, "_names.json")) as { types: Array<{ name: string }> };
    assert.ok(names.types.some((t) => t.name === "BP_Other_C"));
    const coverage = readJson(join(dir, "_coverage.json")) as { reflected: string[] };
    for (const c of [BP_FAKE, BP_OTHER, WBP_HUD, THING]) assert.ok(coverage.reflected.includes(c), c);
    assert.ok(readdirDeep(dir).some((f) => /BP_Other/.test(f)), "the other game class has a stub");
    assert.equal(readJson(join(dir, "_library.json")).version, 1);
    const lock = readJson(join(dir, "stubs.lock.json")) as { auto: { catalogSha256: string; gameClasses: number; failed: string[]; added: string[] } };
    assert.equal(lock.auto.gameClasses, 3);
    assert.match(lock.auto.catalogSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual([lock.auto.failed, lock.auto.added], [[], []]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: the second run reuses the catalog and the cache and reflects only the fresh set", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, "all");
    assert.equal((await runAuto(fake, tmp, ["generate"])).code, 0);
    const r = await runAuto(fake, tmp, ["generate"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.catalogCalls.length, 0, "the catalog file is current");
    assert.equal(r.calls.length, 1);
    assert.ok(r.calls[0]?.classes.includes(BP_FAKE) && r.calls[0]?.classes.includes(THING), "the config's classes are reflected again");
    assert.ok(!r.calls[0]?.classes.includes(BP_OTHER) && !r.calls[0]?.classes.includes(WBP_HUD), "the rest comes from the cache");
    assert.doesNotMatch(r.out, /generating stubs for/);
    // The cached classes are still in the stubs.
    const coverage = readJson(join(profileDir(tmp), "_coverage.json")) as { reflected: string[] };
    assert.ok(coverage.reflected.includes(BP_OTHER) && coverage.reflected.includes(WBP_HUD));
    // Mod assets are read again by an explicit run.
    assert.equal(r.reads.length, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a mod asset whose stage files are unchanged since the last generate is not read again; a new or changed one is", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  const stage = mkdtempSync(join(tmpdir(), "abfc-cli-stage-"));
  try {
    const list = ["/TestMod/Items/BP_Hand", "/TestMod/Items/BP_Rope", "/TestMod/Items/Data"];
    const fake = setup(tmp, list);
    fake.files[join(tmp, "abf.config.json")] = JSON.stringify({
      mod: { name: "TestMod" },
      backend: { kind: "bp_apply", minProtocol: 1 },
      stubs: { classes: [BP_FAKE], scriptClasses: [THING], modAssets: list },
    });
    const items = join(stage, "Content", "Items");
    mkdirSync(items, { recursive: true });
    writeFileSync(join(items, "BP_Hand.uasset"), "hand v1");
    writeFileSync(join(items, "Data.uasset"), "data");
    const o = { stagingPath: stage };
    let r = await runAuto(fake, tmp, ["generate"], o);
    assert.equal(r.code, 0, r.out);
    // BP_Rope has no file in the stage yet: read (and not recorded)
    assert.deepEqual(r.reads, list);

    r = await runAuto(fake, tmp, ["generate"], o);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.reads, ["/TestMod/Items/BP_Rope"], "BP_Hand and the non-Blueprint Data are unchanged");
    assert.match(r.out, /2 unchanged since the last generate/);

    // a new asset in the stage and an edited one are read; the unchanged one is not
    writeFileSync(join(items, "BP_Rope.uasset"), "rope");
    writeFileSync(join(items, "BP_Hand.uexp"), "hand v2 body");
    r = await runAuto(fake, tmp, ["generate"], o);
    assert.deepEqual(r.reads, ["/TestMod/Items/BP_Hand", "/TestMod/Items/BP_Rope"]);
    r = await runAuto(fake, tmp, ["generate"], o);
    assert.deepEqual(r.reads, []);
    assert.match(r.out, /hand-made assets: 2/);

    // --full reads every asset again
    r = await runAuto(fake, tmp, ["generate", "--full"], o);
    assert.deepEqual(r.reads, list);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

test("abfc generate --add: one reflect call with only that class, no mod-asset reads, recorded in lock.auto.added and kept by later runs", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, "all");
    assert.equal((await runAuto(fake, tmp, ["generate"])).code, 0);
    const r = await runAuto(fake, tmp, ["generate", "--add", OTHER_NATIVE]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.calls.length, 1, r.out);
    assert.deepEqual(r.calls[0]?.classes, [OTHER_NATIVE]);
    assert.deepEqual(r.reads, [], "the mod assets come from the cache");
    assert.equal(r.catalogCalls.length, 0);
    const lock = readJson(join(profileDir(tmp), "stubs.lock.json")) as { auto: { added: string[] } };
    assert.deepEqual(lock.auto.added, [OTHER_NATIVE]);
    assert.ok((readJson(join(profileDir(tmp), "_coverage.json")) as { reflected: string[] }).reflected.includes(OTHER_NATIVE));
    assert.ok(readFileSync(join(profileDir(tmp), "Script", "FakeEngine.d.ts"), "utf8").includes("class Other"));

    // Asking for it again changes nothing and calls nothing.
    const again = await runAuto(fake, tmp, ["generate", "--add", OTHER_NATIVE]);
    assert.equal(again.code, 0, again.out);
    assert.equal(again.calls.length, 0);
    assert.match(again.out, /stubs are up to date/);
    // A plain run keeps the addition in the set.
    const plainRun = await runAuto(fake, tmp, ["generate"]);
    assert.ok(plainRun.calls[0]?.classes.includes(OTHER_NATIVE));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: an up-to-date run rewrites a missing coverage file from the cache", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, "all");
    assert.equal((await runAuto(fake, tmp, ["generate"])).code, 0);
    assert.equal((await runAuto(fake, tmp, ["generate", "--add", OTHER_NATIVE])).code, 0);
    const file = join(profileDir(tmp), "_coverage.json");
    const before = readJson(file) as { reflected: string[] };
    rmSync(file);
    const r = await runAuto(fake, tmp, ["generate", "--add", OTHER_NATIVE]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.calls.length, 0);
    assert.match(r.out, /stubs are up to date/);
    assert.equal(existsSync(file), true, "the coverage file is back");
    assert.deepEqual((readJson(file) as { reflected: string[] }).reflected, before.reflected);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate --add of an unknown path: ABFC3022 warning, nothing reflected, nothing written", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, "all");
    assert.equal((await runAuto(fake, tmp, ["generate"])).code, 0);
    const dir = profileDir(tmp);
    const snapshot = (): Array<[string, string]> => readdirDeep(dir).map((f) => [f, readFileSync(join(dir, f)).toString("base64")]);
    const before = snapshot();
    const r = await runAuto(fake, tmp, ["generate", "--add", "/Script/FakeEngine.Nope"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /warning ABFC3022: \/Script\/FakeEngine\.Nope is not a class, struct or enum of this editor build; nothing generated/);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(snapshot(), before);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate --refresh: the catalog is fetched again and every game class is reflected again", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, "all");
    assert.equal((await runAuto(fake, tmp, ["generate"])).code, 0);
    const r = await runAuto(fake, tmp, ["generate", "--refresh"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.catalogCalls.length, 1);
    assert.equal(r.calls.length, 1);
    for (const c of [BP_FAKE, BP_OTHER, WBP_HUD]) assert.ok(r.calls[0]?.classes.includes(c), c);
    assert.match(r.out, /generating stubs for/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a changed editor fingerprint refetches the catalog and generates the full set again", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, "all");
    assert.equal((await runAuto(fake, tmp, ["generate"])).code, 0);
    const before = readJson(join(profileDir(tmp), "stubs.lock.json")) as { editorFingerprint: string };
    fake.files[win32.join(fake.editorRoot, loadProfile().exeRelPath)] = "exe of another build";
    const r = await runAuto(fake, tmp, ["generate"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.catalogCalls.length, 1, "the catalog of the old build is not used");
    for (const c of [BP_FAKE, BP_OTHER, WBP_HUD]) assert.ok(r.calls[0]?.classes.includes(c), c);
    const after = readJson(join(profileDir(tmp), "stubs.lock.json")) as { editorFingerprint: string };
    assert.notEqual(after.editorFingerprint, before.editorFingerprint);
    assert.equal(readJson(join(profileDir(tmp), "_catalog.json")).editorFingerprint, after.editorFingerprint);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a backend without the catalog tool warns ABFC3021, keeps to the configured classes and the defaults, and the lock remembers it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, []);
    const r = await runAuto(fake, tmp, ["generate"], { catalog: undefined });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /warning ABFC3021: the backend has no "catalog" tool/);
    assert.equal(r.catalogCalls.length, 0);
    assert.ok(r.calls[0]?.classes.includes(BP_FAKE) && r.calls[0]?.classes.includes(THING));
    assert.ok(!r.calls[0]?.classes.includes(BP_OTHER), "no catalog, no game classes beyond the config");
    assert.equal(existsSync(join(profileDir(tmp), "_catalog.json")), false);
    assert.equal(existsSync(join(profileDir(tmp), "_names.json")), false);
    // A build does not start the backend again to look for the tool.
    const lock = readJson(join(profileDir(tmp), "stubs.lock.json")) as { auto: { noCatalog?: string } };
    assert.match(lock.auto.noCatalog ?? "", /^[0-9a-f]{16}$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a class missing from the reflect result is ABFC3023, lands in lock.auto.failed, is skipped later and retried by --add", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, []);
    const without = (r: ReflectRequest): ReflectData => {
      const d = plain(r);
      delete d.classes[BP_OTHER];
      return d;
    };
    const r = await runAuto(fake, tmp, ["generate"], { reflect: without });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /warning ABFC3023: 1 class\(es\) could not be reflected and are left out of the stubs: BP_Other_C/);
    assert.match(r.out, /abfc generate --add <path> retries one/);
    const lock = readJson(join(profileDir(tmp), "stubs.lock.json")) as { auto: { failed: string[] } };
    assert.deepEqual(lock.auto.failed, [BP_OTHER]);
    assert.equal((readJson(join(profileDir(tmp), "_coverage.json")) as { reflected: string[] }).reflected.includes(BP_OTHER), false);

    // The next run does not ask for it again.
    const next = await runAuto(fake, tmp, ["generate"]);
    assert.equal(next.code, 0, next.out);
    assert.ok(!next.calls[0]?.classes.includes(BP_OTHER));
    assert.doesNotMatch(next.out, /ABFC3023/);

    // --add retries it (and now the backend can reflect it).
    const add = await runAuto(fake, tmp, ["generate", "--add", BP_OTHER]);
    assert.equal(add.code, 0, add.out);
    assert.deepEqual(add.calls[0]?.classes, [BP_OTHER]);
    const lock2 = readJson(join(profileDir(tmp), "stubs.lock.json")) as { auto: { failed: string[]; added: string[] } };
    assert.deepEqual([lock2.auto.failed, lock2.auto.added], [[], [BP_OTHER]]);
    assert.ok((readJson(join(profileDir(tmp), "_coverage.json")) as { reflected: string[] }).reflected.includes(BP_OTHER));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const OBJ = "/Script/CoreUObject.Object";
const FAKE_BP = "/Game/Fake/BP_Fake.BP_Fake_C";
const MID = "/Script/FakeEngine.Mid";
const OPAQ = "/Script/FakeEngine.Opaq";

const chainClass = (ancestors: string[], extra: Record<string, unknown> = {}): ReflectData["classes"][string] => ({
  meta: "/Script/CoreUObject.Class",
  ancestors,
  castPin: null,
  properties: [],
  functions: [],
  ...extra,
});

test("abfc generate: parent chains are closed with members and opaque types get their supers", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, []);
    const calls: ReflectRequest[] = [];
    const respond = (_r: ReflectRequest, n: number): ReflectData => {
      if (n === 1) {
        return {
          engineVersion: "5.4.4-fake",
          classes: {
            ...firstData.classes,
            [FAKE_BP]: chainClass([THING, OBJ], {
              meta: "/Script/Engine.BlueprintGeneratedClass",
              properties: [{ name: "Slot", pins: [pin("Slot", "out", "object", { subCategoryObject: OPAQ })] }],
            }),
          },
          structs: {},
          supers: { [FAKE_BP]: [MID, THING, OBJ] },
          memberSources: ["widgetTree", "scs", "cookedClass"],
          errors: [],
        };
      }
      return {
        engineVersion: "5.4.4-fake",
        classes: {
          [MID]: chainClass([THING, OBJ], {
            functions: [{ name: "MidCall", pins: [pin("self", "in", "object", { subCategoryObject: MID }), pin("ReturnValue", "out", "int")] }],
          }),
        },
        structs: secondData.structs,
        supers: { [OPAQ]: [THING, OBJ], [MID]: [THING, OBJ] },
        errors: [],
      };
    };
    const cap = captureDeps(fake, () => fakeBackend(true, calls, [], undefined, respond));
    cap.deps.cwd = tmp;
    const code = await main(["generate"], cap.deps);
    const out = cap.text();
    assert.equal(code, 0, out);

    assert.equal(calls.length, 2, "one round for the configured classes, one for the missing parent, structs and opaque supers");
    assert.deepEqual(calls[1]?.classes, [MID]);
    assert.deepEqual(calls[1]?.structs, [VEC]);
    assert.deepEqual(calls[1]?.supersOf, [OPAQ]);
    assert.doesNotMatch(out, /ABFC3013|ABFC3014/);

    const dir = join(tmp, ".abfc", "stubs", "ue5.4.4-1050002");
    const bp = readFileSync(join(dir, "Game", "Fake", "BP_Fake.d.ts"), "utf8");
    assert.match(bp, /export declare class BP_Fake_C extends Mid \{/);
    const script = readFileSync(join(dir, "Script", "FakeEngine.d.ts"), "utf8");
    assert.match(script, /export declare class Mid extends Thing \{/);
    assert.match(script, /MidCall\(\): int;/);
    assert.match(script, /export declare class Opaq extends Thing \{\}/);
    const index = JSON.parse(readFileSync(join(dir, "_index.json"), "utf8")) as { chainGaps: string[]; noSupers: string[]; opaqueNoParent: string[] };
    assert.deepEqual(index.chainGaps, []);
    assert.deepEqual(index.noSupers, []);
    assert.deepEqual(index.opaqueNoParent, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: when the one big reflect call throws, the classes are retried in chunks and the run recovers", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, []);
    const r = await runAuto(fake, tmp, ["generate"], {
      reflect: (req, n) => {
        if (n === 1) throw new Error("the editor ran out of memory");
        return plain(req);
      },
    });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.calls.length, 3, "the failed call and the two halves");
    assert.match(r.out, /stubs: reflect chunk 1\/2 \(\d+ classes\)/);
    assert.match(r.out, /stubs: reflect chunk 2\/2/);
    assert.doesNotMatch(r.out, /ABFC3023/);
    const coverage = readJson(join(profileDir(tmp), "_coverage.json")) as { reflected: string[] };
    for (const c of [BP_FAKE, BP_OTHER, WBP_HUD, THING]) assert.ok(coverage.reflected.includes(c), c);
    assert.deepEqual((readJson(join(profileDir(tmp), "stubs.lock.json")) as { auto: { failed: string[] } }).auto.failed, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: an old backend shape (no supers) warns ABFC3013 for Blueprint classes and never sends supersOf", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, []);
    const calls: ReflectRequest[] = [];
    const respond = (_r: ReflectRequest, n: number): ReflectData =>
      n === 1
        ? {
            engineVersion: "5.4.4-fake",
            classes: { ...firstData.classes, [FAKE_BP]: chainClass([THING, OBJ], { meta: "/Script/Engine.BlueprintGeneratedClass" }) },
            structs: {},
            errors: [],
          }
        : secondData;
    const cap = captureDeps(fake, () => fakeBackend(true, calls, [], undefined, respond));
    cap.deps.cwd = tmp;
    const code = await main(["generate"], cap.deps);
    const out = cap.text();
    assert.equal(code, 0, out);
    assert.match(out, /warning ABFC3013: the backend did not report the Blueprint parent classes of 1 class/);
    assert.ok(calls.every((c) => c.supersOf === undefined), "supersOf is only sent to backends that report supers");

    const dir = join(tmp, ".abfc", "stubs", "ue5.4.4-1050002");
    const bp = readFileSync(join(dir, "Game", "Fake", "BP_Fake.d.ts"), "utf8");
    assert.match(bp, /export declare class BP_Fake_C extends Thing \{/);
    const index = JSON.parse(readFileSync(join(dir, "_index.json"), "utf8")) as { noSupers: string[] };
    assert.deepEqual(index.noSupers, [FAKE_BP]);
    assert.doesNotMatch(out, /could not confirm/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a backend that reports supers but misses a class says the chain could not be confirmed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, []);
    const calls: ReflectRequest[] = [];
    const respond = (_r: ReflectRequest, n: number): ReflectData =>
      n === 1
        ? {
            engineVersion: "5.4.4-fake",
            classes: { ...firstData.classes, [FAKE_BP]: chainClass([THING, OBJ], { meta: "/Script/Engine.BlueprintGeneratedClass" }) },
            structs: {},
            supers: {},
            errors: [],
          }
        : secondData;
    const cap = captureDeps(fake, () => fakeBackend(true, calls, [], undefined, respond));
    cap.deps.cwd = tmp;
    const code = await main(["generate"], cap.deps);
    const out = cap.text();
    assert.equal(code, 0, out);
    assert.match(out, /warning ABFC3013: the backend could not confirm the Blueprint parent chain of 1 class/);
    assert.doesNotMatch(out, /update abf-mod-editor-mcp to a version whose reflect reports/);
    assert.doesNotMatch(out, /did not report the Blueprint parent classes/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const TEXT_BLOCK = "/Script/UMG.TextBlock";

function memberReflect(memberSources: string[] | undefined): (r: ReflectRequest, n: number) => ReflectData {
  return (_r, n) =>
    n === 1
      ? {
          engineVersion: "5.4.4-fake",
          classes: {
            ...firstData.classes,
            [FAKE_BP]: chainClass([THING, OBJ], {
              meta: "/Script/Engine.BlueprintGeneratedClass",
              properties: [{ name: "TitleText", kind: "widget", pins: [pin("TitleText", "out", "object", { subCategoryObject: TEXT_BLOCK })] }],
            }),
          },
          structs: {},
          supers: { [FAKE_BP]: [THING, OBJ] },
          ...(memberSources === undefined ? {} : { memberSources }),
          errors: [],
        }
      : secondData;
}

test("abfc generate: a discovered widget is emitted readonly with @bpWidget; widgetMembers entries warn ABFC3015 (found / still from config)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, []);
    fake.files[join(tmp, "abf.config.json")] = JSON.stringify({
      mod: { name: "TestMod" },
      backend: { kind: "bp_apply", minProtocol: 1 },
      stubs: { classes: [], scriptClasses: [THING], modAssets: [], widgetMembers: { [FAKE_BP]: { TitleText: TEXT_BLOCK, Missing: TEXT_BLOCK } } },
    });
    const calls: ReflectRequest[] = [];
    const cap = captureDeps(fake, () => fakeBackend(true, calls, [], undefined, memberReflect(["widgetTree", "scs", "cookedClass"])));
    cap.deps.cwd = tmp;
    const code = await main(["generate"], cap.deps);
    const out = cap.text();
    assert.equal(code, 0, out);
    assert.match(out, /warning ABFC3015: stubs\.widgetMembers: \/Game\/Fake\/BP_Fake\.BP_Fake_C TitleText is found by abfc generate itself now; remove the entry/);
    assert.match(out, /warning ABFC3015: stubs\.widgetMembers is deprecated; 1 entry was not found by reflection and is still taken from the config: \/Game\/Fake\/BP_Fake\.BP_Fake_C:Missing/);
    assert.doesNotMatch(out, /ABFC3014/);
    assert.doesNotMatch(out, /ABFC3011: stubs\.widgetMembers: \/Game\/Fake\/BP_Fake\.BP_Fake_C TitleText/, "a discovered member needs no scriptClasses hint");
    assert.match(out, /1 member\(s\) beyond class defaults/);

    const dir = join(tmp, ".abfc", "stubs", "ue5.4.4-1050002");
    const bp = readFileSync(join(dir, "Game", "Fake", "BP_Fake.d.ts"), "utf8");
    assert.match(bp, /readonly TitleText: /);
    assert.equal((bp.match(/TitleText:/g) ?? []).length, 1);
    assert.match(bp, /@bpWidget/);
    assert.match(bp, /readonly Missing: UObject;/);
    const index = JSON.parse(readFileSync(join(dir, "_index.json"), "utf8")) as { discovered: string[] };
    assert.deepEqual(index.discovered, [`${FAKE_BP}:TitleText (widget)`]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a backend without member discovery warns ABFC3014 for Blueprint classes; widgetTree and scs alone say variables are missing", async () => {
  const cases: Array<[string[] | undefined, RegExp]> = [
    [undefined, /warning ABFC3014: the backend did not list the members that class defaults cannot show \(widget and component variables\) for 1 Blueprint class/],
    [["widgetTree", "scs"], /warning ABFC3014: the backend found the designer widgets and components of 1 Blueprint class\(es\) but could not list their other variables/],
  ];
  for (const [sources, pattern] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
    try {
      const fake = setup(tmp, []);
      const cap = captureDeps(fake, () => fakeBackend(true, [], [], undefined, memberReflect(sources)));
      cap.deps.cwd = tmp;
      const code = await main(["generate"], cap.deps);
      const out = cap.text();
      assert.equal(code, 0, out);
      assert.match(out, pattern);
      assert.doesNotMatch(out, /ABFC3015/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

/** One `--json` run with stdout and stderr kept apart; the project lives in a fresh temp folder. */
async function runSeparately(command: "generate" | "stubs"): Promise<{ code: number; outLines: string[]; errLines: string[]; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-generate-"));
  const fake = setup(tmp, "all");
  const cap = captureDeps(fake, () => fakeBackend(true, [], []));
  cap.deps.cwd = tmp;
  const outLines: string[] = [];
  const errLines: string[] = [];
  cap.deps.stdout = (l) => outLines.push(l);
  cap.deps.stderr = (l) => errLines.push(l);
  const code = await main([command, "--json"], cap.deps);
  return { code, outLines, errLines, tmp };
}

test("abfc stubs (deprecated alias) behaves like generate and warns once on stderr", async () => {
  const alias = await runSeparately("stubs");
  let generated: { code: number; outLines: string[]; errLines: string[]; tmp: string } | null = null;
  try {
    assert.equal(alias.code, 0, alias.outLines.join("\n") + alias.errLines.join("\n"));
    assert.deepEqual(alias.errLines.filter((l) => /deprecated/.test(l)), ['abfc: warning: "abfc stubs" is deprecated; use "abfc generate"']);
    const aliasDoc = JSON.parse(alias.outLines.join("\n")) as { command: string; ok: boolean; result: unknown };
    assert.equal(aliasDoc.command, "stubs");
    assert.equal(aliasDoc.ok, true);
    assert.ok(existsSync(join(alias.tmp, ".abfc", "stubs", "ue5.4.4-1050002", "stubs.lock.json")));
    assert.ok(existsSync(join(alias.tmp, ".abfc", "tsconfig.paths.json")));

    generated = await runSeparately("generate");
    assert.equal(generated.code, 0, generated.outLines.join("\n") + generated.errLines.join("\n"));
    assert.deepEqual(generated.errLines.filter((l) => /deprecated/.test(l)), []);
    const doc = JSON.parse(generated.outLines.join("\n")) as { command: string; ok: boolean; result: unknown };
    assert.equal(doc.command, "generate");
    // The result names the temp project folder, which differs per run; everything else must be equal.
    const rel = (d: { result: unknown }, tmp: string): unknown => ({ ...(d.result as { dir: string }), dir: (d.result as { dir: string }).dir.slice(tmp.length) });
    assert.deepEqual(rel(doc, generated.tmp), rel(aliasDoc, alias.tmp));
  } finally {
    rmSync(alias.tmp, { recursive: true, force: true });
    if (generated !== null) rmSync(generated.tmp, { recursive: true, force: true });
  }
});

test("usage lists generate and not stubs", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-generate-"));
  try {
    const cap = captureDeps(setup(tmp, "all"), () => fakeBackend(true, [], []));
    const outLines: string[] = [];
    cap.deps.stdout = (l) => outLines.push(l);
    assert.equal(await main([], cap.deps), 0);
    const text = outLines.join("\n");
    assert.match(text, /commands: .*\bgenerate\b/);
    assert.doesNotMatch(text, /\bstubs\b/);
    assert.match(text, /--no-generate/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- Placeholder classes the source uses ----

const USE_SOURCE = `import type { Thing } from "/Script/FakeEngine";\nexport function f(t: Thing): unknown { return t.Other.Anything; }\n`;

/** `plain`, but Thing has a property `Other` of the object type OTHER_NATIVE (which stays a placeholder until it is reflected itself). */
function withOtherProperty(r: ReflectRequest): ReflectData {
  const d = plain(r);
  const thing = d.classes[THING];
  if (thing !== undefined) {
    thing.properties = [{ name: "Other", pins: [pin("Other", "out", "object", { subCategoryObject: OTHER_NATIVE })] }];
  }
  return d;
}

/** A project that uses a placeholder: tsconfig and one source file on the real disk next to the fake machine. */
function usedProject(tmp: string): ReturnType<typeof setup> {
  const fake = setup(tmp, []);
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(join(tmp, "tsconfig.json"), TSCONFIG_TEXT, "utf8");
  writeFileSync(join(tmp, "src", "Use.ts"), USE_SOURCE, "utf8");
  return fake;
}

/** One `abfc generate --json` run with the machine-readable result kept apart from the progress lines. */
async function runUsedJson(fake: ReturnType<typeof setup>, tmp: string, reflect: (r: ReflectRequest) => ReflectData): Promise<AutoRun & { result: any }> {
  const calls: ReflectRequest[] = [];
  const reads: string[] = [];
  const catalogCalls: string[] = [];
  const cap = captureDeps(fake, () => fakeBackend(true, calls, reads, undefined, { catalog: RAW_CATALOG, reflect, catalogCalls }));
  cap.deps.cwd = tmp;
  const outLines: string[] = [];
  const errLines: string[] = [];
  cap.deps.stdout = (l) => outLines.push(l);
  cap.deps.stderr = (l) => errLines.push(l);
  const code = await main(["generate", "--json"], cap.deps);
  const out = [...errLines, ...outLines].join("\n");
  let result: unknown = null;
  try {
    result = (JSON.parse(outLines.join("\n")) as { result: unknown }).result;
  } catch {
    // reported through the assertion on `out` by the caller
  }
  return { code, out, calls, reads, catalogCalls, result };
}

test("abfc generate: a placeholder class the source uses is generated, recorded in auto.added and not requested again", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-used-"));
  try {
    const fake = usedProject(tmp);
    const r = await runUsedJson(fake, tmp, withOtherProperty);
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.calls[0]?.classes.includes(OTHER_NATIVE), "the first run knows nothing about the class yet");
    assert.ok(
      r.calls.slice(1).some((c) => c.classes.includes(OTHER_NATIVE)),
      "a later round reflects the class the source uses",
    );
    assert.deepEqual(r.result?.used, [OTHER_NATIVE]);

    const lock = readJson(join(profileDir(tmp), "stubs.lock.json")) as { auto: { failed: string[]; added: string[] } };
    assert.deepEqual(lock.auto.added, [OTHER_NATIVE]);
    assert.deepEqual(lock.auto.failed, []);
    const script = readFileSync(join(profileDir(tmp), "Script", "FakeEngine.d.ts"), "utf8");
    const at = script.indexOf("export declare class Other ");
    assert.ok(at > 0, "the class is declared");
    assert.doesNotMatch(script.slice(script.lastIndexOf("/**", at), at), /@bpOpaque/);

    // The second run asks for it together with everything else and finds nothing more to generate.
    const again = await runUsedJson(fake, tmp, withOtherProperty);
    assert.equal(again.code, 0, again.out);
    assert.equal(again.calls.length, 1, again.out);
    assert.ok(again.calls[0]?.classes.includes(OTHER_NATIVE));
    assert.deepEqual(again.result?.used, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc generate: a used placeholder the backend cannot reflect is ABFC3023, lands in auto.failed and is not requested again", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-used-"));
  try {
    const fake = usedProject(tmp);
    const without = (r: ReflectRequest): ReflectData => {
      const d = withOtherProperty(r);
      delete d.classes[OTHER_NATIVE];
      return d;
    };
    const r = await runUsedJson(fake, tmp, without);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ABFC3023/);
    assert.equal(r.calls.filter((c) => c.classes.includes(OTHER_NATIVE)).length, 1, "asked for once in this run");
    const lock = readJson(join(profileDir(tmp), "stubs.lock.json")) as { auto: { failed: string[] } };
    assert.ok(lock.auto.failed.includes(OTHER_NATIVE));

    const again = await runUsedJson(fake, tmp, without);
    assert.equal(again.code, 0, again.out);
    assert.ok(again.calls.every((c) => !c.classes.includes(OTHER_NATIVE)), "a failed class never starts the backend again");
    assert.doesNotMatch(again.out, /ABFC3023/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
