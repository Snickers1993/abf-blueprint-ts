import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { loadProfile } from "@abfc/env";
import type { Profile } from "@abfc/ir";
import { emitStubs, emitStubsWithIndex, rulesFromPairs, writeStubs, writeTsconfigPaths } from "../src/index.js";
import type { EmitInput, ReflectData, ReflectPin } from "../src/index.js";

type PinExtra = Partial<Omit<ReflectPin, "name" | "dir" | "category">>;
function pin(name: string, dir: "in" | "out", category: string, extra: PinExtra = {}): ReflectPin {
  return {
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
  };
}
const objectPin = (name: string, dir: "in" | "out", path: string, extra: PinExtra = {}): ReflectPin =>
  pin(name, dir, "object", { subCategoryObject: path, ...extra });
const selfPin = (hidden = false): ReflectPin => pin("self", "in", "object", { subCategoryObject: "/Script/FakeEngine.Thing", hidden });
const execIn = pin("execute", "in", "exec");
const execThen = pin("then", "out", "exec");

const THING = "/Script/FakeEngine.Thing";
const LIB = "/Script/FakeEngine.FakeLib";
const ARRAYS = "/Script/FakeEngine.KismetArrayLibrary";
const BP = "/Game/Fake/BP_Fake.BP_Fake_C";

function reflectData(): ReflectData {
  return {
    engineVersion: "5.4.4-fake",
    classes: {
      [THING]: {
        meta: "/Script/CoreUObject.Class",
        ancestors: ["/Script/CoreUObject.Object"],
        castPin: "AsThing",
        properties: [
          { name: "Count", pins: [selfPin(true), pin("Count", "out", "int")] },
          { name: "Owner", pins: [pin("Owner", "out", "object", { subCategoryObject: THING })] },
          { name: "Twin", pins: [pin("Twin", "out", "object", { subCategoryObject: "/Script/OtherMod.Thing" })] },
          { name: "Points", pins: [pin("Points", "out", "struct", { subCategoryObject: "/Script/FakeEngine.FakeVec", container: "Array" })] },
          { name: "Kind", pins: [pin("Kind", "out", "class", { subCategoryObject: "/Script/FakeEngine.Other" })] },
          { name: "Family", pins: [pin("Family", "out", "object", { subCategoryObject: THING, container: "Array" })] },
          { name: "Lookup", pins: [pin("Lookup", "out", "int", { container: "Map" })] },
        ],
        functions: [
          { name: "GetOwner", pins: [selfPin(), pin("ReturnValue", "out", "object", { subCategoryObject: THING })] },
          {
            name: "Resolve",
            pins: [
              execIn,
              selfPin(),
              pin("Valid", "out", "exec"),
              pin("NotValid", "out", "exec"),
              objectPin("Object", "in", THING),
              objectPin("Value", "out", THING),
            ],
          },
          { name: "BlockedCall", pins: [execIn, selfPin(), execThen] },
          { name: "OverrideCall", pins: [execIn, selfPin(), execThen] },
          {
            name: "Wait",
            pins: [
              execIn,
              selfPin(),
              execThen,
              pin("WorldContextObject", "in", "object", { subCategoryObject: "/Script/CoreUObject.Object", hidden: true }),
              pin("default", "in", "real", { subCategory: "double" }),
              pin("LatentInfo", "in", "struct", { subCategoryObject: "/Script/Engine.LatentActionInfo", hidden: true }),
            ],
          },
        ],
      },
      "/Script/OtherMod.Thing": {
        meta: "/Script/CoreUObject.Class",
        ancestors: [],
        castPin: null,
        properties: [{ name: "Id", pins: [pin("Id", "out", "int64")] }],
        functions: [],
      },
      [LIB]: {
        meta: "/Script/CoreUObject.Class",
        ancestors: ["/Script/CoreUObject.Object"],
        castPin: null,
        properties: [],
        functions: [
          {
            name: "Add",
            pins: [
              selfPin(true),
              pin("A", "in", "int"),
              pin("B", "in", "int"),
              pin("ReturnValue", "out", "int"),
            ],
          },
          {
            name: "Scale",
            pins: [selfPin(true), pin("V", "in", "real", { subCategory: "float" }), pin("ReturnValue", "out", "real", { subCategory: "double" })],
          },
        ],
      },
      [ARRAYS]: {
        meta: "/Script/CoreUObject.Class",
        ancestors: [],
        castPin: null,
        properties: [],
        functions: [
          {
            name: "Array_Length",
            pins: [selfPin(true), pin("TargetArray", "in", "wildcard", { container: "Array" }), pin("ReturnValue", "out", "int")],
          },
        ],
      },
      [BP]: {
        meta: "/Script/Engine.BlueprintGeneratedClass",
        ancestors: [THING, "/Script/CoreUObject.Object"],
        castPin: "AsBP_Fake",
        castOnly: true,
        properties: [],
        functions: [],
      },
    },
    structs: {
      "/Script/FakeEngine.FakeVec": {
        fields: [
          pin("X", "out", "real", { subCategory: "double" }),
          pin("Tags", "out", "name", { container: "Array" }),
          pin("Mode", "out", "byte", { subCategoryObject: "/Script/FakeEngine.EFakeMode" }),
        ],
      },
    },
    errors: [],
  };
}

function testProfile(): Profile {
  return {
    ...loadProfile(),
    filterOverrides: [
      { parent: THING, member: "OverrideCall", reason: "audited" },
      { cast: BP, reason: "audited cast" },
    ],
  };
}

function input(over: Partial<EmitInput> = {}): EmitInput {
  return {
    profile: testProfile(),
    reflect: reflectData(),
    filter: {
      contentVersion: "v1",
      rules: rulesFromPairs([
        ["Block", `${THING} BlockedCall`],
        ["Block", `${THING} OverrideCall`],
        ["Block", BP],
      ]),
    },
    manual: [],
    mod: "TestMod",
    opaque: [],
    ...over,
  };
}

test("class members: properties, pure, exec outputs, latent, renamed pins, containers", () => {
  const files = emitStubs(input());
  const text = files.get("Script/FakeEngine.d.ts") ?? "";
  assert.match(text, /^\/\/ generated by abfc generate 0.7.0 for ue5\.4\.4-1050002; do not edit, never commit/);
  assert.match(text, /import type \{ UObject \} from "\/Script\/CoreUObject";/);
  assert.match(text, /import type \{ Thing as OtherMod_Thing \} from "\/Script\/OtherMod";/);
  assert.match(text, /import type \{ TSubclassOf, byte, double, float, int, name \} from "@abfc\/runtime";/);
  assert.match(text, /export declare class Thing extends UObject \{/);
  assert.match(text, /@bpPath \/Script\/FakeEngine\.Thing:Count/);
  assert.match(text, /^ {2}Count: int;$/m);
  assert.match(text, /^ {2}Owner: Thing \| null;$/m);
  assert.match(text, /^ {2}Twin: OtherMod_Thing \| null;$/m);
  assert.match(text, /^ {2}Points: FakeVec\[\];$/m);
  assert.match(text, /^ {2}Kind: TSubclassOf<Other> \| null;$/m);
  assert.match(text, /^ {2}Family: \(Thing \| null\)\[\];$/m);
  assert.match(text, /@bpUnsupported int:Map/);
  assert.match(text, /^ {2}Lookup: unknown;$/m);
  assert.match(text, /^ {2}GetOwner\(\): Thing \| null;$/m);
  assert.match(text, / \* @bpPure/);
  assert.match(text, / \* @bpExecOutputs Valid,NotValid/);
  assert.match(text, /^ {2}Resolve\(Object: Thing \| null\): \{ exec: "Valid" \| "NotValid"; Value: Thing \| null; \};$/m);
  assert.match(text, / \* @bpLatent/);
  assert.match(text, / \* @bpWorldContext/);
  assert.match(text, / \* @bpPin default_ "default"/);
  assert.match(text, / \* @bpParam default real/);
  assert.match(text, /Wait\(default_: double\): void;/);
});

test("libraries become namespaces; array library calls carry the array node tag", () => {
  const text = emitStubs(input()).get("Script/FakeEngine.d.ts") ?? "";
  assert.match(text, /export declare namespace FakeLib \{/);
  assert.doesNotMatch(text, /export declare class FakeLib/);
  assert.match(text, /^ {2}function Add\(A: int, B: int\): int;$/m);
  assert.match(text, /^ {2}function Scale\(V: float\): double;$/m);
  assert.match(text, / \* @bpNode K2Node_CallArrayFunction/);
  assert.match(text, /function Array_Length\(TargetArray: unknown\[\]\): int;/);
});

test("filter tags: deprecated, override, cast filter", () => {
  const files = emitStubs(input());
  const text = files.get("Script/FakeEngine.d.ts") ?? "";
  assert.match(text, / \* @deprecated Blocked by Blueprint filter: Block \/Script\/FakeEngine\.Thing BlockedCall/);
  assert.match(text, / \* @bpFilterOverride Block \/Script\/FakeEngine\.Thing OverrideCall: audited/);
  assert.doesNotMatch(text, /@deprecated.*OverrideCall/);
  const bp = files.get("Game/Fake/BP_Fake.d.ts") ?? "";
  assert.match(bp, / \* @bpPath \/Game\/Fake\/BP_Fake\.BP_Fake_C/);
  assert.match(bp, / \* @bpMeta \/Script\/Engine\.BlueprintGeneratedClass/);
  assert.match(bp, / \* @bpCastPin AsBP_Fake/);
  assert.match(bp, / \* @bpCastFilter override Block \/Game\/Fake\/BP_Fake\.BP_Fake_C: audited cast/);
  assert.match(bp, /import type \{ Thing \} from "\/Script\/FakeEngine";/);
  assert.match(bp, /export declare class BP_Fake_C extends Thing \{\}/);
});

test("structs, enums and opaque types", () => {
  const { files, index } = emitStubsWithIndex(input({ opaque: ["/Script/FakeEngine.Extra"] }));
  const text = files.get("Script/FakeEngine.d.ts") ?? "";
  assert.match(text, /@bpKind struct/);
  assert.match(text, /export declare interface FakeVec \{/);
  assert.match(text, /^ {2}X: double;$/m);
  assert.match(text, /^ {2}Tags: name\[\];$/m);
  assert.match(text, /^ {2}Mode: EFakeMode;$/m);
  assert.match(text, /export type EFakeMode = byte & \{ readonly __bpEnum\?: "\/Script\/FakeEngine\.EFakeMode" \};/);
  assert.match(text, /@bpOpaque/);
  assert.match(text, /export declare class Other extends UObject \{\}/);
  assert.match(text, /export declare class Extra extends UObject \{\}/);
  assert.ok(files.get("Script/CoreUObject.d.ts")?.includes("export declare class UObject {}"));
  assert.ok(index.opaque.includes("/Script/FakeEngine.Other"));
  assert.ok(index.opaque.includes("/Script/FakeEngine.EFakeMode"));
  assert.deepEqual(index.deprecated, [`${THING}:BlockedCall`]);
  assert.deepEqual(index.overridden, [`${THING}:OverrideCall`]);
  assert.deepEqual(index.files, [...files.keys()].sort());
  assert.ok(index.members > 10);
});

test("opaqueEnums declares an unreferenced enum", () => {
  const { files, index } = emitStubsWithIndex(input({ opaqueEnums: ["/Script/FakeEngine.EFake"] }));
  const text = files.get("Script/FakeEngine.d.ts") ?? "";
  assert.match(text, /export type EFake = byte & \{ readonly __bpEnum\?: "\/Script\/FakeEngine\.EFake" \};/);
  assert.ok(index.opaque.includes("/Script/FakeEngine.EFake"));
});

test("enum, delegate and class parameters", () => {
  const TOOLS = "/Script/FakeEngine.Tools";
  const reflect = reflectData();
  reflect.classes[TOOLS] = {
    meta: "/Script/CoreUObject.Class",
    ancestors: ["/Script/CoreUObject.Object"],
    castPin: null,
    properties: [{ name: "Mode", pins: [pin("Mode", "out", "byte", { subCategoryObject: "/Script/FakeEngine.EFakeMode" })] }],
    functions: [
      {
        name: "Schedule",
        pins: [
          execIn,
          selfPin(),
          execThen,
          pin("Mode", "in", "byte", { subCategoryObject: "/Script/FakeEngine.EFakeMode" }),
          pin("Callback", "in", "delegate"),
          pin("Kind", "in", "class", { subCategoryObject: THING }),
          pin("Kinds", "in", "class", { subCategoryObject: THING, container: "Array" }),
          pin("ReturnValue", "out", "byte", { subCategoryObject: "/Script/FakeEngine.EFakeMode" }),
          pin("WorldContextObject", "in", "object", { subCategoryObject: "/Script/CoreUObject.Object", hidden: true }),
        ],
      },
    ],
  };
  const text = emitStubs(input({ reflect })).get("Script/FakeEngine.d.ts") ?? "";
  const mode = 'EnumText<"/Script/FakeEngine.EFakeMode">';
  const ctor = "TSubclassOf<Thing> | (abstract new (...a: never[]) => Thing)";
  assert.ok(/import type \{ DelegateRef, EnumText, TSubclassOf[^}]*\} from "@abfc\/runtime";/.test(text));
  assert.ok(text.includes(`  Mode: ${mode};\n`));
  assert.ok(
    text.includes(`Schedule(Mode: ${mode}, Callback: DelegateRef, Kind: ${ctor} | null, Kinds: (${ctor} | null)[]): ${mode};`),
    text,
  );
  assert.ok(!text.includes("WorldContextObject:"));
  assert.ok(text.includes("@bpWorldContext"));
  assert.ok(text.includes("@bpParam Callback unsupported:delegate"));
  assert.match(text, /^ {2}Mode: EFakeMode;$/m);
});

test("hand-made asset: variables, functions, events; owned members are left out", () => {
  const manual = {
    asset: "/TestMod/Items/BP_Hand",
    classPath: "/TestMod/Items/BP_Hand.BP_Hand_C",
    meta: "/Script/Engine.BlueprintGeneratedClass",
    parent: THING,
    variables: [
      { name: "Hp", type: "int" },
      { name: "Owned", type: "bool" },
      { name: "Target", type: `object:${THING}` },
    ],
    widgets: [],
    functions: [{ name: "Heal", inputs: [{ name: "Amount", type: "int" }], outputs: [{ name: "ReturnValue", type: "bool" }] }],
    events: [
      { name: "Ping", params: [{ name: "Who", type: `object:${THING}` }] },
      { name: "UpdateTarget", params: [] },
    ],
    owned: { units: ["event:UpdateTarget"], variables: ["Owned"] },
  };
  const files = emitStubs(input({ manual: [manual] }));
  const text = files.get("Mod/TestMod/Items/BP_Hand.d.ts") ?? "";
  assert.match(text, /import type \{ Thing \} from "\/Script\/FakeEngine";/);
  assert.match(text, /export interface BP_Hand_Manual \{/);
  assert.match(text, /^ {2}Hp: int;$/m);
  assert.match(text, /^ {2}Target: Thing \| null;$/m);
  assert.doesNotMatch(text, /Owned/);
  assert.doesNotMatch(text, /UpdateTarget/);
  assert.match(text, /^ {2}Heal\(Amount: int\): boolean;$/m);
  assert.match(text, /^ {2}Ping\(Who: Thing \| null\): void;$/m);
  assert.match(text, / \* @bpHandMade/);
  assert.match(text, / \* @bpPath \/TestMod\/Items\/BP_Hand\.BP_Hand_C:Hp/);
  assert.match(text, / \* @bpMeta \/Script\/Engine\.BlueprintGeneratedClass/);
  assert.match(text, /export declare class BP_Hand_C extends Thing \{\}/);
  assert.match(text, /export interface BP_Hand_C extends BP_Hand_Manual \{\}/);
});

function checkProgram(files: Map<string, string>, consumer: string, esm: boolean): string[] {
  const dir = mkdtempSync(join(tmpdir(), "abfc-stubgen-test-"));
  try {
    const abfcDir = join(dir, ".abfc");
    writeStubs(join(abfcDir, "stubs", "p1"), files);
    const req = createRequire(import.meta.url);
    const dts = (spec: string): string => req.resolve(spec).replace(/\.js$/, ".d.ts");
    writeTsconfigPaths(abfcDir, "p1", "TestMod", dts("@abfc/runtime"), dts("@abfc/ir"));
    if (esm) writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "consumer.ts"), consumer);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "./.abfc/tsconfig.paths.json",
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2023", strict: true, noEmit: true, types: [] },
        files: ["consumer.ts"],
      }),
    );
    const cfgPath = join(dir, "tsconfig.json");
    const parsed = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    });
    assert.ok(parsed, "tsconfig did not parse");
    assert.deepEqual(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    const all = [...ts.getPreEmitDiagnostics(program)];
    return all.map((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      const where = d.file ? `${d.file.fileName.replace(dir, "")}:${d.start ?? 0}` : "";
      return `TS${d.code} ${where} ${msg}`;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CONSUMER = `
import { Thing, FakeLib, KismetArrayLibrary } from "/Script/FakeEngine";
import type { FakeVec, EFakeMode } from "/Script/FakeEngine";
import type { BP_Fake_C } from "/Game/Fake/BP_Fake";
import type { BP_Hand_C } from "/TestMod/Items/BP_Hand";
import type { int } from "@abfc/ir";

declare const t: Thing;
declare const h: BP_Hand_C;
declare const bp: BP_Fake_C;
const n: number = FakeLib.Add(1, 2);
const owner: Thing | null = t.GetOwner();
const r = t.Resolve(t);
if (r.exec === "Valid") { const v: Thing | null = r.Value; void v; }
const c = t.Count;
const hp = h.Hp;
h.Ping(t);
const first: FakeVec | undefined = t.Points[0];
const len = KismetArrayLibrary.Array_Length([1, 2]);
const th: Thing = bp;
void [n, owner, c, hp, first, len, th];
export type _Unused = int | EFakeMode;
`;

test("emitted stubs type-check with zero diagnostics (CommonJS and ESM projects)", () => {
  const manual = {
    asset: "/TestMod/Items/BP_Hand",
    classPath: "/TestMod/Items/BP_Hand.BP_Hand_C",
    meta: "/Script/Engine.BlueprintGeneratedClass",
    parent: THING,
    variables: [{ name: "Hp", type: "int" }],
    widgets: [],
    functions: [],
    events: [{ name: "Ping", params: [{ name: "Who", type: `object:${THING}` }] }],
    owned: { units: [], variables: [] },
  };
  const files = emitStubs(input({ manual: [manual] }));
  assert.deepEqual(checkProgram(files, CONSUMER.replace('import type { int } from "@abfc/ir";', 'import type { int } from "@abfc/runtime";'), false), []);
  assert.deepEqual(checkProgram(files, CONSUMER.replace('import type { int } from "@abfc/ir";', 'import type { int } from "@abfc/runtime";'), true), []);
});

test("manual stub from a synthetic export with a custom event and a widget blueprint", async () => {
  const { manualFromExport, emitManual } = await import("../src/index.js");
  const body = [
    "Begin Object Class=/Script/Engine.Blueprint Name=\"BP_Panel\" ExportPath=\"/Script/Engine.Blueprint'/TestMod/UI/BP_Panel.BP_Panel'\"",
    "   Begin Object Class=/Script/Engine.EdGraph Name=\"EventGraph\" ExportPath=\"/Script/Engine.EdGraph'/TestMod/UI/BP_Panel.BP_Panel:EventGraph'\"",
    "   End Object",
    "End Object",
    "Begin Object Class=/Script/Engine.Blueprint Name=\"BP_Panel\" ExportPath=\"/Script/Engine.Blueprint'/TestMod/UI/BP_Panel.BP_Panel'\"",
    "   ParentClass=\"/Script/CoreUObject.Class'/Script/UMG.UserWidget'\"",
    "   NewVariables(0)=(VarName=\"Score\",VarType=(PinCategory=\"int\",PinSubCategory=\"\",PinSubCategoryObject=None,ContainerType=None),DefaultValue=\"0\")",
    "   Begin Object Class=/Script/Engine.EdGraph Name=\"EventGraph\" ExportPath=\"/Script/Engine.EdGraph'/TestMod/UI/BP_Panel.BP_Panel:EventGraph'\"",
    "      Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name=\"K2Node_CustomEvent_0\" ExportPath=\"/Script/BlueprintGraph.K2Node_CustomEvent'/TestMod/UI/BP_Panel.BP_Panel:EventGraph.K2Node_CustomEvent_0'\"",
    "         CustomFunctionName=\"Flash\"",
    "         CustomProperties UserDefinedPin (PinName=\"Times\",PinType=(PinCategory=\"int\",PinSubCategory=\"\",PinSubCategoryObject=None,ContainerType=None),DesiredPinDirection=EGPD_Output)",
    "      End Object",
    "   End Object",
    "End Object",
  ].join("\n");
  const m = manualFromExport(
    "/TestMod/UI/BP_Panel",
    body,
    { blueprint: { class: "WidgetBlueprint" }, functions: [{ name: "Reset", inputs: [], outputs: [{ name: "Done", type: "bool" }] }] },
    { units: [], variables: [] },
  );
  assert.equal(m.meta, "/Script/UMG.WidgetBlueprintGeneratedClass");
  assert.equal(m.classPath, "/TestMod/UI/BP_Panel.BP_Panel_C");
  assert.equal(m.parent, "/Script/UMG.UserWidget");
  assert.deepEqual(m.variables, [{ name: "Score", type: "int" }]);
  assert.deepEqual(m.events, [{ name: "Flash", params: [{ name: "Times", type: "int" }] }]);
  const f = emitManual(m);
  assert.equal(f.file, "Mod/TestMod/UI/BP_Panel.d.ts");
  assert.match(f.text, /^ {2}Score: int;$/m);
  assert.match(f.text, /^ {2}Flash\(Times: int\): void;$/m);
  assert.match(f.text, /^ {2}Reset\(\): \{ Done: boolean \};$/m);
  assert.match(f.text, / \* @bpMeta \/Script\/UMG\.WidgetBlueprintGeneratedClass/);
  assert.match(f.text, /import type \{ UserWidget \} from "\/Script\/UMG";/);
  assert.match(f.text, /export declare class BP_Panel_C extends UserWidget \{\}/);
});

test("designer widgets: variable widgets of an export become readonly @bpWidget members; non-variable ones and slots do not", async () => {
  const { manualFromExport, emitManual } = await import("../src/index.js");
  const bp = "/TestMod/UI/WBP_ExampleInfo";
  const body = [
    "Begin Object Class=/Script/UMG.WidgetBlueprint Name=\"WBP_ExampleInfo\"",
    "   Begin Object Class=/Script/UMG.WidgetTree Name=\"WidgetTree\"",
    `      Begin Object Class=/Script/UMG.TextBlock Name="NameText" ExportPath="/Script/UMG.TextBlock'${bp}.WBP_ExampleInfo:WidgetTree.NameText'"`,
    "      End Object",
    `      Begin Object Class=/Script/UMG.VerticalBox Name="Box" ExportPath="/Script/UMG.VerticalBox'${bp}.WBP_ExampleInfo:WidgetTree.Box'"`,
    "      End Object",
    `      Begin Object Class=/Script/UMG.VerticalBoxSlot Name="VerticalBoxSlot_0" ExportPath="/Script/UMG.VerticalBoxSlot'${bp}.WBP_ExampleInfo:WidgetTree.VerticalBoxSlot_0'"`,
    "      End Object",
    "   End Object",
    "   Begin Object Name=\"WidgetTree\"",
    `      Begin Object Name="NameText" ExportPath="/Script/UMG.TextBlock'${bp}.WBP_ExampleInfo:WidgetTree.NameText'"`,
    "         bIsVariable=True",
    "      End Object",
    `      Begin Object Name="Box" ExportPath="/Script/UMG.VerticalBox'${bp}.WBP_ExampleInfo:WidgetTree.Box'"`,
    "         Visibility=Visible",
    "      End Object",
    `      Begin Object Name="VerticalBoxSlot_0" ExportPath="/Script/UMG.VerticalBoxSlot'${bp}.WBP_ExampleInfo:WidgetTree.VerticalBoxSlot_0'"`,
    "         bIsVariable=True",
    "      End Object",
    "   End Object",
    "   ParentClass=\"/Script/CoreUObject.Class'/Script/UMG.UserWidget'\"",
    "End Object",
  ].join("\n");
  const m = manualFromExport(bp, body, { blueprint: { class: "WidgetBlueprint" } }, { units: [], variables: [] });
  assert.deepEqual(m.widgets, [{ name: "NameText", cls: "/Script/UMG.TextBlock" }]);
  const f = emitManual(m);
  assert.match(f.text, /^ {2}readonly NameText: TextBlock;$/m);
  assert.match(f.text, / \* @bpWidget/);
  assert.match(f.text, / \* @bpType object:\/Script\/UMG\.TextBlock/);
  assert.match(f.text, /import type \{ TextBlock, UserWidget \} from "\/Script\/UMG";/);
  assert.doesNotMatch(f.text, /Box|Slot/);
});

test("stubs.widgetMembers: a /Game class stub gets readonly @bpWidget members; an unreflected widget class is typed UObject", () => {
  const files = emitStubs(input({ widgetMembers: { [THING]: { TitleText: THING, Count: THING, Other: "/Script/UMG.TextBlock" } } }));
  const text = files.get("Script/FakeEngine.d.ts") ?? "";
  assert.match(text, /^ {2}readonly TitleText: Thing;$/m);
  assert.match(text, / \* @bpPath \/Script\/FakeEngine\.Thing:TitleText/);
  assert.match(text, / \* @bpWidget/);
  assert.match(text, /^ {2}readonly Other: UObject;$/m);
  assert.match(text, / \* @bpType object:\/Script\/UMG\.TextBlock/);
  assert.equal((text.match(/^ {2}Count: int;$/gm) ?? []).length, 1);
  assert.doesNotMatch(text, /readonly Count/);
});

test("stubs.widgetMembers: names that differ only in case from a property or from each other emit one property", () => {
  const files = emitStubs(input({ widgetMembers: { [THING]: { count: THING, COUNT: THING, titletext: THING, TitleText: THING } } }));
  const text = files.get("Script/FakeEngine.d.ts") ?? "";
  assert.equal((text.match(/^ {2}(readonly )?count: /gim) ?? []).length, 1);
  assert.equal((text.match(/^ {2}(readonly )?titletext: /gim) ?? []).length, 1);
});

const WIDGET = "/Script/UMG.Widget";
const PANEL_SLOT = "/Script/UMG.PanelSlot";

function widgetReflect(over: { slot?: boolean; panelSlot?: boolean } = {}): ReflectData {
  const base = reflectData();
  const widget: ReflectData["classes"][string] = {
    meta: "/Script/CoreUObject.Class",
    ancestors: ["/Script/CoreUObject.Object"],
    castPin: null,
    properties: over.slot ? [{ name: "Slot", pins: [pin("Slot", "out", "object", { subCategoryObject: PANEL_SLOT })] }] : [],
    functions: [],
  };
  const classes: ReflectData["classes"] = { ...base.classes, [WIDGET]: widget };
  if (over.panelSlot !== false) {
    classes[PANEL_SLOT] = { meta: "/Script/CoreUObject.Class", ancestors: ["/Script/CoreUObject.Object"], castPin: null, properties: [], functions: [] };
  }
  return { ...base, classes };
}

test("supplemental properties: Widget.Slot is emitted readonly and typed PanelSlot when the reflection lacks it", () => {
  const text = emitStubs(input({ reflect: widgetReflect() })).get("Script/UMG.d.ts") ?? "";
  assert.match(text, / \* @bpPath \/Script\/UMG\.Widget:Slot/);
  assert.match(text, / \* @bpType object:\/Script\/UMG\.PanelSlot/);
  assert.match(text, /^ {2}readonly Slot: PanelSlot \| null;$/m);
  assert.doesNotMatch(text, /@bpWidget|@bpHandMade/);
});

test("supplemental properties: a reflected Slot property wins and appears once", () => {
  const text = emitStubs(input({ reflect: widgetReflect({ slot: true }) })).get("Script/UMG.d.ts") ?? "";
  assert.equal((text.match(/^ {2}(readonly )?Slot: /gm) ?? []).length, 1);
  assert.match(text, /^ {2}Slot: PanelSlot \| null;$/m);
  assert.doesNotMatch(text, /readonly Slot/);
});

test("supplemental properties: without PanelSlot in the reflection Slot is typed UObject", () => {
  const text = emitStubs(input({ reflect: widgetReflect({ panelSlot: false }) })).get("Script/UMG.d.ts") ?? "";
  assert.match(text, /^ {2}readonly Slot: UObject \| null;$/m);
  assert.doesNotMatch(text, /PanelSlot/);
});

test("supplemental properties: classes without a supplement are unchanged", () => {
  const text = emitStubs(input()).get("Script/FakeEngine.d.ts") ?? "";
  assert.doesNotMatch(text, /Slot/);
});

test("map and set variables and event parameters of a hand-made asset keep their unsupported stub form", async () => {
  const { manualFromExport, emitManual } = await import("../src/index.js");
  const bp = "/TestMod/Core/BP_Host";
  const body = [
    `Begin Object Class=/Script/Engine.Blueprint Name="BP_Host" ExportPath="/Script/Engine.Blueprint'${bp}.BP_Host'"`,
    `   NewVariables(0)=(VarName="Counts",VarGuid=4F1E9FD0FD104258BE5D5D30A551C609,VarType=(PinCategory="name",PinValueType=(TerminalCategory="int"),ContainerType=Map),FriendlyName="Counts",PropertyFlags=5)`,
    `   NewVariables(1)=(VarName="Tags",VarGuid=4F1E9FD0FD104258BE5D5D30A551C60A,VarType=(PinCategory="name",ContainerType=Set),FriendlyName="Tags",PropertyFlags=5)`,
    "End Object",
  ].join("\n");
  const m = manualFromExport(bp, body, { blueprint: { class: "Blueprint" } }, { units: [], variables: [] });
  assert.deepEqual(m.variables, [{ name: "Counts", type: "unsupported:name:Map" }, { name: "Tags", type: "unsupported:name:Set" }]);
  const f = emitManual(m);
  assert.match(f.text, / \* @bpUnsupported name:Map/);
  assert.match(f.text, / \* @bpUnsupported name:Set/);
});

test("hand-made replicated variables and RPC custom events carry @bpReplicated, @bpRpc and @bpReliable", async () => {
  const { manualFromExport, emitManual } = await import("../src/index.js");
  const bp = "/TestMod/Core/BP_Net";
  const ev = (name: string, flags: string | null): string[] => [
    `      Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_${name}" ExportPath="/Script/BlueprintGraph.K2Node_CustomEvent'${bp}.BP_Net:EventGraph.K2Node_CustomEvent_${name}'"`,
    `         CustomFunctionName="${name}"`,
    ...(flags === null ? [] : [`         FunctionFlags=${flags}`]),
    "      End Object",
  ];
  const body = [
    `Begin Object Class=/Script/Engine.Blueprint Name="BP_Net" ExportPath="/Script/Engine.Blueprint'${bp}.BP_Net'"`,
    `   Begin Object Class=/Script/Engine.EdGraph Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${bp}.BP_Net:EventGraph'"`,
    "   End Object",
    "End Object",
    `Begin Object Class=/Script/Engine.Blueprint Name="BP_Net" ExportPath="/Script/Engine.Blueprint'${bp}.BP_Net'"`,
    `   NewVariables(0)=(VarName="Score",VarType=(PinCategory="int"),PropertyFlags=4611686018427387941)`,
    `   NewVariables(1)=(VarName="Local",VarType=(PinCategory="int"),PropertyFlags=4611686018427387909)`,
    `   NewVariables(2)=(VarName="Bare",VarType=(PinCategory="int"))`,
    `   Begin Object Class=/Script/Engine.EdGraph Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${bp}.BP_Net:EventGraph'"`,
    ...ev("AskServer", "2097344"),
    ...ev("AskServerLoose", "2097216"),
    ...ev("TellClient", "16777280"),
    ...ev("Shout", "16448"),
    ...ev("NotNet", "2097152"),
    ...ev("Plain", null),
    "   End Object",
    "End Object",
  ].join("\n");
  const m = manualFromExport(bp, body, { blueprint: { class: "Blueprint" } }, { units: [], variables: [] });
  assert.deepEqual(m.variables, [
    { name: "Score", type: "int", replicated: true },
    { name: "Local", type: "int" },
    { name: "Bare", type: "int" },
  ]);
  const net = Object.fromEntries(m.events.map((e) => [e.name, e.net ?? null]));
  assert.deepEqual(net, {
    AskServer: { kind: "server", reliable: true },
    AskServerLoose: { kind: "server", reliable: false },
    TellClient: { kind: "client", reliable: false },
    Shout: { kind: "multicast", reliable: false },
    NotNet: null,
    Plain: null,
  });
  const f = emitManual(m);
  const lines = f.text.split("\n");
  /** The JSDoc tag lines (without the comment frame) of the member whose declaration starts with `  <member>`. */
  const tagsOf = (member: string): string[] => {
    const at = lines.findIndex((l) => l.startsWith(`  ${member}`));
    assert.ok(at > 0, member);
    const start = lines.lastIndexOf("  /**", at);
    return lines.slice(start + 1, at - 1).map((l) => l.replace("   * ", "")).filter((l) => l.startsWith("@"));
  };
  assert.deepEqual(tagsOf("Score:"), [`@bpPath ${bp}.BP_Net_C:Score`, "@bpType int", "@bpReplicated", "@bpHandMade"]);
  assert.deepEqual(tagsOf("Local:"), [`@bpPath ${bp}.BP_Net_C:Local`, "@bpType int", "@bpHandMade"]);
  assert.deepEqual(tagsOf("AskServer("), [`@bpPath ${bp}.BP_Net_C:AskServer`, "@bpRpc server", "@bpReliable", "@bpHandMade"]);
  assert.deepEqual(tagsOf("AskServerLoose("), [`@bpPath ${bp}.BP_Net_C:AskServerLoose`, "@bpRpc server", "@bpHandMade"]);
  assert.deepEqual(tagsOf("TellClient("), [`@bpPath ${bp}.BP_Net_C:TellClient`, "@bpRpc client", "@bpHandMade"]);
  assert.deepEqual(tagsOf("Shout("), [`@bpPath ${bp}.BP_Net_C:Shout`, "@bpRpc multicast", "@bpHandMade"]);
  assert.deepEqual(tagsOf("NotNet("), [`@bpPath ${bp}.BP_Net_C:NotNet`, "@bpHandMade"]);
  assert.deepEqual(tagsOf("Plain("), [`@bpPath ${bp}.BP_Net_C:Plain`, "@bpHandMade"]);
  // the tags are readable as JSDoc tags of the member
  const sf = ts.createSourceFile("BP_Net.d.ts", f.text, ts.ScriptTarget.Latest, true);
  const tagNames: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isMethodSignature(n) && n.name.getText() === "AskServer") tagNames.push(...ts.getJSDocTags(n).map((t) => t.tagName.text));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.deepEqual(tagNames, ["bpPath", "bpRpc", "bpReliable", "bpHandMade"]);
});

test("meta.defaults through emit(): trailing defaulted pins are optional with @bpDefault, a middle default stays required, no meta is unchanged", () => {
  const data = reflectData();
  data.classes[LIB]!.functions.push(
    {
      name: "PrintLike",
      pins: [execIn, selfPin(true), execThen, pin("InString", "in", "string"), pin("bPrintToScreen", "in", "bool"), pin("bPrintToLog", "in", "bool")],
      meta: { defaults: { InString: "Hello", bPrintToScreen: "true", bPrintToLog: "true" } },
    },
    {
      name: "MiddleDefault",
      pins: [execIn, selfPin(true), execThen, pin("A", "in", "bool"), pin("B", "in", "bool"), pin("C", "in", "bool")],
      meta: { defaults: { B: "true" } },
    },
    {
      name: "NoMeta",
      pins: [execIn, selfPin(true), execThen, pin("A", "in", "bool")],
    },
  );
  const text = emitStubs(input({ reflect: data })).get("Script/FakeEngine.d.ts") ?? "";
  assert.match(text, /^ {2}function PrintLike\(InString\?: string, bPrintToScreen\?: boolean, bPrintToLog\?: boolean\): void;$/m);
  assert.match(text, / \* @bpDefault InString "Hello"/);
  assert.match(text, / \* @bpDefault bPrintToScreen "true"/);
  assert.match(text, /^ {2}function MiddleDefault\(A: boolean, B: boolean, C: boolean\): void;$/m);
  assert.doesNotMatch(text, /@bpDefault B /);
  assert.match(text, /^ {2}function NoMeta\(A: boolean\): void;$/m);
});

test("members without a kind keep the plain property form and add nothing to index.discovered", () => {
  const { files, index } = emitStubsWithIndex(input());
  assert.deepEqual(index.discovered, []);
  assert.doesNotMatch(files.get("Script/FakeEngine.d.ts") ?? "", /@bpComponent/);
});

test("components a hand-made actor adds itself become readonly @bpComponent members; inherited and native ones do not", async () => {
  const { manualFromExport, emitManual } = await import("../src/index.js");
  const bp = "/TestMod/Rooms/BP_Lift";
  const body = [
    `Begin Object Class=/Script/Engine.Blueprint Name="BP_Lift" ExportPath="/Script/Engine.Blueprint'${bp}.BP_Lift'"`,
    `   ParentClass="/Script/CoreUObject.Class'/Script/Engine.Actor'"`,
    `   NewVariables(0)=(VarName="Armed",VarType=(PinCategory="bool"),PropertyFlags=5)`,
    "End Object",
  ].join("\n");
  const row = (name: string, cls: string, more: Record<string, unknown> = {}) => ({ name, class: cls, parent: null, inherited: false, native: false, ...more });
  const structure = {
    blueprint: { class: "Blueprint" },
    components: [
      row("DefaultSceneRoot", "/Script/Engine.SceneComponent", { default_scene_root: true }),
      row("Car", "/Script/Engine.StaticMeshComponent"),
      row("RideBox", "/Script/Engine.BoxComponent"),
      row("Car", "/Script/Engine.StaticMeshComponent"),
      row("Inherited", "/Script/Engine.SceneComponent", { inherited: true }),
      row("None", "/Script/Engine.SceneComponent", { native: true }),
      row("Armed", "/Script/Engine.SceneComponent"),
    ],
  };
  const m = manualFromExport(bp, body, structure, { units: [], variables: [] });
  assert.deepEqual(m.components, [
    { name: "DefaultSceneRoot", cls: "/Script/Engine.SceneComponent" },
    { name: "Car", cls: "/Script/Engine.StaticMeshComponent" },
    { name: "RideBox", cls: "/Script/Engine.BoxComponent" },
  ]);
  const f = emitManual(m);
  assert.match(f.text, /@bpPath \/TestMod\/Rooms\/BP_Lift\.BP_Lift_C:Car\n {3}\* @bpType object:\/Script\/Engine\.StaticMeshComponent\n {3}\* @bpComponent\n {3}\* @bpHandMade/);
  assert.match(f.text, / {2}readonly RideBox: BoxComponent;/);
  assert.doesNotMatch(f.text, /Inherited|readonly None/);
  // no components at all: the field stays off the asset (old seeds compare equal)
  assert.equal(manualFromExport(bp, body, { blueprint: { class: "Blueprint" } }, { units: [], variables: [] }).components, undefined);
});
