// "Careless modder" scenarios on the fake backend: the regression tests of the live scenario runs (see docs/known-issues.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, readSourceMap } from "@abfc/compiler";
import { OPS, TA, addParentStubs, tally, tallyOnly, withRig } from "./rig.js";

const appliedSpecs = (r: { backend: { calls: Array<{ tool: string; specs?: Array<Record<string, any>> }> } }): Array<Record<string, any>> =>
  r.backend.calls.filter((c) => c.tool === "bp_apply").flatMap((c) => c.specs ?? []);

test("(S31) intermediate stub graphs are never swept", async () => {
  await withRig({}, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const stubs = r.backend.addIntermediateStubs(TA);
    const before = appliedSpecs(r).length;

    x = await r.run(["build", "--drift"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC5014/);
    for (const g of stubs) assert.doesNotMatch(x.out, new RegExp(g));
    const specs = appliedSpecs(r).slice(before);
    assert.ok(
      specs.every((s) => s.remove_functions === undefined && s.remove_variables === undefined),
      JSON.stringify(specs),
    );
    const removed = specs.flatMap((s) => (s.graphs ?? []).flatMap((g: any) => g.remove ?? []));
    assert.deepEqual(removed, []);
    const held = r.backend.nodeNames(TA);
    assert.ok(held.includes("K2Node_FunctionEntry_0") && held.includes("K2Node_CallFunction_0"), "the stub nodes are still on the stage");
  });
});

test("(S01) a new class is applied after the new class it references, whatever the file names sort like", async () => {
  await withRig({}, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(
      join(r.dir, "src", "BP_Alpha.ts"),
      [
        'import { blueprint } from "@abfc/runtime";',
        'import { Actor } from "/Script/FakeEngine";',
        'import { BP_Zed } from "./Tally.js";',
        "",
        "@blueprint()",
        "export class BP_Alpha extends Actor {",
        "  Other!: BP_Zed | null;",
        "}",
        "",
      ].join(String.fromCharCode(10)),
      "utf8",
    );
    const x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const order = appliedSpecs(r).filter((s) => s.create !== undefined).map((s) => s.asset);
    assert.ok(order.indexOf("/TestMod/BP_Zed") >= 0 && order.indexOf("/TestMod/BP_Zed") < order.indexOf("/TestMod/BP_Alpha"), order.join(","));
  });
});

const referencer = (target: string, file = "./Tally.js"): string =>
  [
    'import { blueprint } from "@abfc/runtime";',
    'import { Actor } from "/Script/FakeEngine";',
    `import { ${target} } from "${file}";`,
    "",
    "@blueprint()",
    "export class BP_Alpha extends Actor {",
    `  Other!: ${target} | null;`,
    "}",
    "",
  ].join(String.fromCharCode(10));

test("(S02) renaming a referenced class does not trip ABFC2047", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), referencer("BP_Zed"), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    // the class is renamed and the referencer follows; the backend's rename fixes the stage variable up
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Zed2"), "utf8");
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), referencer("BP_Zed2"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC2047/);
    assert.match(x.out, /renamed \/TestMod\/BP_Zed -> \/TestMod\/BP_Zed2/);
    const again = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.applyLabels().length, again, "the next build is up to date");
  });
});

test("(S02b) renaming a class and its file together is a rename, not a delete that a referencer blocks", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), referencer("BP_Zed"), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    rmSync(join(r.dir, "src", "Tally.ts"));
    writeFileSync(join(r.dir, "src", "Zed2.ts"), tally("BP_Zed2"), "utf8");
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), referencer("BP_Zed2", "./Zed2.js"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /renamed \/TestMod\/BP_Zed -> \/TestMod\/BP_Zed2/);
    assert.doesNotMatch(x.out, /ABFC5016|ABFC2047/);
    assert.deepEqual(r.backend.assetOpsCalls, [[{ op: "rename", from: "/TestMod/BP_Zed", to: "/TestMod/BP_Zed2" }]]);
    assert.deepEqual(r.backend.stageAssets().filter((a) => a.includes("Zed")), ["/TestMod/BP_Zed2"]);
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed"), null);
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed2")!.renamedFrom, "/TestMod/BP_Zed");
  });
});

test("(S02c) two new classes and one removed class in a folder are never paired up as a rename", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    rmSync(join(r.dir, "src", "Tally.ts"));
    writeFileSync(join(r.dir, "src", "One.ts"), tally("BP_One"), "utf8");
    writeFileSync(join(r.dir, "src", "Two.ts"), tally("BP_Two"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /renamed /);
    assert.deepEqual(r.backend.assetOpsCalls, [[{ op: "delete", asset: "/TestMod/BP_Zed" }]]);
  });
});

test("(S03) moving a class file keeps the source map's spans on the new file", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const files = (): string[] => {
      const sm = readSourceMap(r.dir, "/TestMod/BP_Zed")!;
      const out = new Set<string>();
      for (const u of Object.values(sm.units)) {
        out.add(u.span.file);
        for (const n of Object.values(u.nodes)) out.add(n.span.file);
      }
      return [...out];
    };
    assert.deepEqual(files(), ["src/Tally.ts"]);
    renameSync(join(r.dir, "src", "Tally.ts"), join(r.dir, "src", "Moved.ts"));
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.deepEqual(files(), ["src/Moved.ts"]);
  });
});

test("(S05) a rename or reparent that edits the asset's nodes is replaced without the ABFC5014 editor-edit warning", async () => {
  await withRig(OPS, async (r) => {
    addParentStubs(r.dir);
    tallyOnly(r.dir, tally("BP_Zed"));
    assert.equal((await r.run(["build"])).code, 0);
    r.backend.opsEditNodes = true;
    // renamed (class, same file): the fixup edits a node, the unit is re-applied, no warning blames the modder
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Zed2"), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /renamed \/TestMod\/BP_Zed -> \/TestMod\/BP_Zed2/);
    assert.doesNotMatch(x.out, /ABFC5014/);
    const afterRename = r.backend.applyLabels().length;
    // reparented
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Zed2", "Pawn"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /reparented /);
    assert.doesNotMatch(x.out, /ABFC5014/);
    assert.ok(r.backend.applyLabels().length > afterRename, "the units were applied again");
  });
});

test("(S25) a rename that edits the nodes of an asset without TypeScript changes leaves no editor-edit drift behind", async () => {
  await withRig(OPS, async (r) => {
    addParentStubs(r.dir);
    tallyOnly(r.dir, tally("BP_Zed"));
    assert.equal((await r.run(["build"])).code, 0);
    r.backend.opsEditNodes = true;
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Zed2"), "utf8");
    const x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /renamed \/TestMod\/BP_Zed -> \/TestMod\/BP_Zed2/);
    assert.doesNotMatch(x.out, /ABFC5014/);
    // the renamed asset was read and its drifted units replaced: nothing is left that reads as an editor edit
    const s = await r.run(["status"]);
    assert.doesNotMatch(s.out, /ABFC5001/, s.out);
    assert.doesNotMatch(s.out, / edited /, s.out);
  });
});

test("(S06) recreating a moved class keeps the old path to delete on publish", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    addParentStubs(r.dir);
    tallyOnly(r.dir, tally("BP_Tally"));
    assert.equal((await r.run(["build"])).code, 0);
    r.backend.markPublished();
    // moved into a folder, then the family changes before anything was published
    mkdirSync(join(r.dir, "src", "Sub"));
    renameSync(join(r.dir, "src", "Tally.ts"), join(r.dir, "src", "Sub", "Tally.ts"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /renamed \/TestMod\/BP_Tally -> \/TestMod\/Sub\/BP_Tally/);
    writeFileSync(join(r.dir, "src", "Sub", "Tally.ts"), tally("BP_Tally", "ActorComponent"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /recreating \/TestMod\/Sub\/BP_Tally/);
    assert.equal(readManifest(r.dir, "/TestMod/Sub/BP_Tally")!.renamedFrom, TA, "the recreated asset still knows the path it moved from");
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /deleted Content\/BP_Tally\.uasset/);
    assert.equal(r.backend.removedFiles.size, 0);
    assert.equal(readManifest(r.dir, "/TestMod/Sub/BP_Tally")!.renamedFrom, undefined);
  });
});

test("(S08) a second publish publishes nothing and keeps the manifests", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    assert.equal((await r.run(["build"])).code, 0);
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally2"), "utf8");
    assert.equal((await r.run(["build"])).code, 0);
    let x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.publishCalls.length, 1);
    const manifest = JSON.stringify(readManifest(r.dir, "/TestMod/BP_Tally2"));
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /nothing to publish/);
    assert.equal(r.backend.publishCalls.length, 1, "the second publish did not call the backend");
    assert.equal(JSON.stringify(readManifest(r.dir, "/TestMod/BP_Tally2")), manifest);
    assert.equal(readManifest(r.dir, "/TestMod/BP_Tally2")!.renamedFrom, undefined);
  });
});

const holder = (withTarget: boolean): string =>
  [
    'import { blueprint } from "@abfc/runtime";',
    'import type { int } from "@abfc/runtime";',
    'import { Actor } from "/Script/FakeEngine";',
    ...(withTarget ? ['import { BP_Zed } from "./Tally.js";'] : []),
    "",
    "@blueprint()",
    "export class BP_Alpha extends Actor {",
    "  Count!: int;",
    ...(withTarget ? ["  Other!: BP_Zed | null;"] : []),
    "}",
    "",
  ].join(String.fromCharCode(10));

test("(S07b) deleting a class and its last TS use in one build", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), holder(true), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    // the class and the field that uses it go in the same edit
    rmSync(join(r.dir, "src", "Tally.ts"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), holder(false), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC5016/);
    assert.match(x.out, /deleted \/TestMod\/BP_Zed/);
    assert.deepEqual(r.backend.stageAssets().filter((a) => a.includes("Zed")), []);
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed")!.deleted, true);
    assert.deepEqual(readManifest(r.dir, "/TestMod/BP_Alpha")!.variables.map((v) => v.name), ["Count"]);
    // the next build has nothing to do, and a publish deletes the file
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
  });
});

test("(S07c) a class that a hand-made asset still references is not deleted, and the stage is restored", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), holder(false), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    r.backend.addHandMadeReference("/TestMod/BP_Hand", "/TestMod/BP_Zed");
    rmSync(join(r.dir, "src", "Tally.ts"));
    x = await r.run(["build"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /ABFC5016/);
    assert.match(x.out, /still referenced by \/TestMod\/BP_Hand/);
    assert.ok(r.backend.stageAssets().includes("/TestMod/BP_Zed"), "the stage still has the class");
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed")!.deleted, undefined);
  });
});

test("(S10) an asset saved in the Mod Editor that the stage had not touched makes the next build re-sync the stage (ABFC4017)", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const syncs = r.backend.calls.filter((c) => c.tool === "staging_sync").length;
    r.backend.stageStale = ["Content/Relay/BP_Relay.uasset"];

    x = await r.run(["status"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4020/);
    assert.equal(r.backend.calls.filter((c) => c.tool === "staging_sync").length, syncs, "status never re-syncs");

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4017/);
    assert.match(x.out, /BP_Relay\.uasset/);
    assert.equal(r.backend.calls.filter((c) => c.tool === "staging_sync").length, syncs + 1);

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC4017/);
  });
});

test("(S13) unsaved-changes refusal then conflict re-sync publishes", async () => {
  await withRig({ ...OPS }, async (r) => {
    r.backend.keepAssetsOnSync = true;
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);

    // the editor holds an unsaved change: bp_publish refuses and copies nothing
    const ok = r.backend.publishResult;
    r.backend.publishResult = {
      ...ok,
      ok: false,
      published: [],
      refused: "editor refused",
      editorReason: "modified assets (unsaved changes)",
      message: "Refused by the open editor: /TestMod/BP_Tally (modified assets (unsaved changes)). Save or revert those assets, then publish again. Nothing was copied.",
    };
    x = await r.run(["publish"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC7005/);
    assert.match(x.out, /save or revert those assets/);
    assert.match(x.out, /BP_Tally/);
    assert.equal(r.backend.publishCalls.length, 1);

    // the modder saves the asset in the editor (with a hand-made function): the real file differs from the stage's baseline
    r.backend.addHandMadeFunction(TA, "HandFn");
    r.backend.stageConflicts = ["Content/BP_Tally.uasset"];
    r.backend.publishResult = ok;
    const syncs = r.backend.calls.filter((c) => c.tool === "staging_sync").length;
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4017/);
    assert.match(x.out, /BP_Tally\.uasset/);
    assert.equal(r.backend.calls.filter((c) => c.tool === "staging_sync").length, syncs + 1, "the stage was re-synced once");
    assert.match(x.out, /warning ABFC5014/);
    assert.deepEqual(r.backend.functionNames(TA), [], "the hand-made function is removed (TS wins)");
    assert.equal(r.backend.publishCalls.length, 2, "the second publish reached the backend");
    assert.equal(r.backend.stageConflicts.length, 0);

    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /nothing to publish/);
  });
});

test("(S16) Play In Editor running: publish is refused with a clear message, after stopping it publishes", async () => {
  await withRig({ ...OPS }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);

    const ok = r.backend.publishResult;
    r.backend.publishResult = {
      ...ok,
      ok: false,
      published: [],
      refused: "editor refused",
      editorReason: "Play In Editor is running",
      message: "Refused by the open editor: /TestMod/BP_Tally (Play In Editor is running). Stop Play In Editor, then publish again. Nothing was copied.",
    };
    x = await r.run(["publish"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC7005/);
    assert.match(x.out, /Stop Play In Editor/);
    assert.match(x.out, /fix: stop Play In Editor in the Mod Editor/);

    r.backend.publishResult = ok;
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /nothing to publish/);
  });
});

test("(S14) a field whose variable the Mod Editor retyped (renamed class) is recreated with the TS type", async () => {
  await withRig({ ...OPS }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const before = appliedSpecs(r).length;
    r.backend.setVariableType(TA, "Total", "float");
    r.backend.stageConflicts = ["Content/BP_Tally.uasset"];
    r.backend.keepAssetsOnSync = true;

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC2047/);
    assert.match(x.out, /warning ABFC5014: TypeScript wins: the variable Total had the type float/);
    const specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.ok(specs.some((s) => (s.remove_variables ?? []).includes("Total")), JSON.stringify(specs));
    assert.ok(specs.some((s) => (s.variables ?? []).some((v: any) => /Total/.test(JSON.stringify(v)))), JSON.stringify(specs));

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC5014/);
  });
});

test("(S20) a retyped field is recreated, its units are re-applied and the next build is up to date", async () => {
  await withRig({ ...OPS }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.backend.variableNames(TA).filter((n) => !n.startsWith("abfc_")), ["Total"]);
    const before = appliedSpecs(r).length;

    // Total: int -> float (the event parameter follows so the assignment type-checks)
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally").replace("import type { int }", "import type { int, float }").replace("Total!: int;", "Total!: float;").replace("Bump(by: int)", "Bump(by: float)"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC2047: .*changed the type of own field Total \(int -> float\): the variable is recreated/);
    const specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.ok(specs.some((s) => (s.remove_variables ?? []).includes("Total")), JSON.stringify(specs));
    assert.ok(specs.some((s) => (s.variables ?? []).some((v: any) => v.name === "Total" && /float|real|double/.test(v.type))), JSON.stringify(specs));
    assert.ok(specs.some((s) => (s.graphs ?? []).length > 0), "the unit is applied again");
    assert.equal(r.backend.variableType(TA, "Total").includes("int"), false);
    assert.equal(readManifest(r.dir, TA)?.variables.find((v) => v.name === "Total")?.type.includes("int"), false);

    const again = appliedSpecs(r).length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC2047/);
    assert.equal(appliedSpecs(r).length, again, "nothing is applied again");
  });
});

test("(S19) adding a field adds a variable; removing it removes the variable (ABFC5011) and the next build is up to date", async () => {
  await withRig({ ...OPS }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally").replace("  Total!: int;", "  Total!: int;\n  Armed!: boolean;"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.backend.variableNames(TA).filter((n) => !n.startsWith("abfc_")).sort(), ["Armed", "Total"]);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC5011: removed own field Armed/);
    assert.deepEqual(r.backend.variableNames(TA).filter((n) => !n.startsWith("abfc_")), ["Total"]);
    x = await r.run(["build"]);
    assert.doesNotMatch(x.out, /ABFC5011/);
    assert.match(x.out, /up to date/);

    // a field with a non-literal initializer is refused with a clear message and nothing is applied
    const before = appliedSpecs(r).length;
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally").replace("  Total!: int;", "  Total!: int;\n  Speed: int = 1 + 1;"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC2047: field Speed: the initializer must be a literal/);
    assert.equal(appliedSpecs(r).length, before);
  });
});

test("(S19b) a field initializer becomes the variable default; changing it updates the default in place; removing it clears it", async () => {
  await withRig({ ...OPS, variableDefaults: true }, async (r) => {
    const base = tally("BP_Tally").replace("import type { int }", "import type { int, float }");
    tallyOnly(r.dir, base);
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);

    const write = (fields: string): void =>
      writeFileSync(join(r.dir, "src", "Tally.ts"), base.replace("  Total!: int;", `  Total!: int;\n${fields}`), "utf8");

    write("  Speed: float = 2.5;\n  Armed: boolean = true;");
    let before = appliedSpecs(r).length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.variableDefault(TA, "Speed"), "2.5");
    assert.equal(r.backend.variableDefault(TA, "Armed"), "true");
    assert.equal(r.backend.variableDefault(TA, "Total"), undefined);
    const added = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.ok(added.some((s) => (s.variables ?? []).some((v: any) => v.name === "Speed" && v.default === "2.5")), JSON.stringify(added));
    assert.ok(added.some((s) => (s.variables ?? []).some((v: any) => v.name === "Armed" && v.default === "true")), JSON.stringify(added));
    assert.equal(readManifest(r.dir, TA)?.variables.find((v) => v.name === "Speed")?.default, "2.5");
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    write("  Speed: float = 4;\n  Armed: boolean = true;");
    before = appliedSpecs(r).length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    let specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.ok(specs.some((s) => s.variable_defaults?.Speed === "4"), JSON.stringify(specs));
    assert.ok(specs.every((s) => !(s.variables ?? []).some((v: any) => v.name === "Speed") && !(s.remove_variables ?? []).includes("Speed")), JSON.stringify(specs));
    assert.equal(r.backend.variableDefault(TA, "Speed"), "4");
    assert.equal(r.backend.variableDefault(TA, "Armed"), "true");
    assert.equal(readManifest(r.dir, TA)?.variables.find((v) => v.name === "Speed")?.default, "4");
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    write("  Speed!: float;\n  Armed: boolean = true;");
    before = appliedSpecs(r).length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.ok(specs.some((s) => s.variable_defaults?.Speed === null), JSON.stringify(specs));
    assert.equal(r.backend.variableDefault(TA, "Speed"), undefined);
    assert.equal("default" in (readManifest(r.dir, TA)?.variables.find((v) => v.name === "Speed") ?? {}), false);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);
  });
});

test("(S19c) a backend without variable_defaults warns ABFC2084 for a changed default and leaves it as it is", async () => {
  await withRig({ ...OPS }, async (r) => {
    const base = tally("BP_Tally").replace("import type { int }", "import type { int, float }");
    tallyOnly(r.dir, base);
    const write = (fields: string): void =>
      writeFileSync(join(r.dir, "src", "Tally.ts"), base.replace("  Total!: int;", `  Total!: int;\n${fields}`), "utf8");
    write("  Speed: float = 2.5;");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.variableDefault(TA, "Speed"), "2.5", "a new variable carries its default without the capability");
    write("  Speed: float = 4;");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC2084: .*Speed/);
    assert.equal(r.backend.variableDefault(TA, "Speed"), "2.5");
  });
});

const withDirector = (dir: string, row: string, tag?: string): void => {
  const file = join(dir, "src", "Relay.ts");
  const text = readFileSync(file, "utf8").replace(/@director\([^\n]*\)\n/, "");
  const withImport = text.includes("director") ? text : `import { director } from "@abfc/runtime";\n${text}`;
  const args = tag === undefined ? `"${row}"` : `"${row}", "${tag}"`;
  writeFileSync(file, withImport.replace("@blueprint(", `@director(${args})\n@blueprint(`), "utf8");
};
const defaultsPasses = (r: { backend: { calls: Array<{ tool: string; label?: string }> } }): number =>
  r.backend.calls.filter((c) => c.tool === "bp_apply" && c.label === "defaults").length;

test("(S12b) published class defaults are not applied again after a re-sync; unpublished ones are", async () => {
  await withRig({ handMadeEvent: false, classManagerRows: true }, async (r) => {
    withDirector(r.dir, "EntityDirector_Test");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(defaultsPasses(r), 1);

    // not published yet: the editor saves the asset, the re-sync drops the stage's defaults, so the pass runs again
    r.backend.stageStale = ["Content/Relay/BP_Relay.uasset"];
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4017/);
    assert.equal(defaultsPasses(r), 2, "unpublished defaults are re-applied after a re-sync");

    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    r.backend.markPublished();
    assert.equal(readManifest(r.dir, "/TestMod/Relay/BP_Relay")?.classDefaultsPublished, true);

    // published: an explicit re-sync does not say which assets the editor saved, so the TypeScript defaults are applied again (TypeScript wins)
    x = await r.run(["build", "--resync"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(defaultsPasses(r), 3, "an explicit re-sync applies the class defaults again");
    assert.equal(readManifest(r.dir, "/TestMod/Relay/BP_Relay")?.classDefaultsPublished, undefined);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);
    assert.equal(defaultsPasses(r), 3);
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    r.backend.markPublished();
    assert.equal(readManifest(r.dir, "/TestMod/Relay/BP_Relay")?.classDefaultsPublished, true);

    // a changed tag is a changed defaults state: the pass runs and the published flag is cleared until the next publish
    withDirector(r.dir, "EntityDirector_Test", "ClassManager.EntityDirector.Other");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(defaultsPasses(r), 4);
    assert.equal(readManifest(r.dir, "/TestMod/Relay/BP_Relay")?.classDefaultsPublished, undefined);
  });
});

test("(S12d) a failed Unreal compile does not keep the published flag of an asset whose defaults pass was planned", async () => {
  await withRig({ handMadeEvent: false, classManagerRows: true }, async (r) => {
    withDirector(r.dir, "EntityDirector_Test");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    r.backend.markPublished();
    assert.equal(readManifest(r.dir, "/TestMod/Relay/BP_Relay")?.classDefaultsPublished, true);
    const before = defaultsPasses(r);

    // the defaults pass is planned, the compile fails, the stage is re-synced from the mod (the editor may have saved other defaults there)
    withDirector(r.dir, "EntityDirector_Test", "ClassManager.EntityDirector.Other");
    r.backend.reportMessages = [{ severity: "error", asset: "/TestMod/Relay/BP_Relay", message: "boom" }];
    x = await r.run(["build"]);
    assert.equal(x.code, 1, x.out);
    assert.equal(readManifest(r.dir, "/TestMod/Relay/BP_Relay")?.classDefaultsPublished, undefined, "the flag does not survive a planned pass that failed");

    r.backend.reportMessages = [];
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(defaultsPasses(r) > before + 1, "the next build applies the defaults again");
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);
  });
});

const defaultsAssets = (r:{ backend: { calls: Array<{ tool: string; label?: string; specs?: Array<Record<string, any>> }> } }): string[] =>
  r.backend.calls.filter((c) => c.tool === "bp_apply" && c.label === "defaults").flatMap((c) => (c.specs ?? []).map((s) => String(s.asset)));

test("(S12c) class defaults of an asset saved in the Mod Editor are applied again; other assets are not", async () => {
  await withRig({ ...OPS }, async (r) => {
    const withTick = (cls: string): string => tally(cls).replace("@blueprint()", "@blueprint({ tickInterval: 0.5 })");
    tallyOnly(r.dir, withTick("BP_Zed"));
    writeFileSync(join(r.dir, "src", "Other.ts"), withTick("BP_Other"), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(defaultsAssets(r).sort(), ["/TestMod/BP_Other", "/TestMod/BP_Zed"]);
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    r.backend.markPublished();
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed")?.classDefaultsPublished, true);

    // the editor saved one asset: its class defaults may differ from the TypeScript, so they are applied again (TypeScript wins)
    r.backend.stageStale = ["Content/BP_Zed.uasset"];
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4017/);
    assert.deepEqual(defaultsAssets(r).sort(), ["/TestMod/BP_Other", "/TestMod/BP_Zed", "/TestMod/BP_Zed"], "only the saved asset gets its defaults again");
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed")?.classDefaultsPublished, undefined);
    assert.equal(readManifest(r.dir, "/TestMod/BP_Other")?.classDefaultsPublished, true);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);
    assert.equal(defaultsAssets(r).length, 3, "a rebuild applies nothing");
  });
});

test("(S24b) a struct whose TypeScript is gone warns once (ABFC5018) and stays", async () => {
  await withRig({ ...OPS, structs: true }, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(
      join(r.dir, "src", "Entry.ts"),
      `import { struct } from "@abfc/runtime";
import type { int } from "@abfc/runtime";

@struct({ path: "/TestMod/S_Entry" })
export class S_Entry {
  Count!: int;
}
`,
      "utf8",
    );
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(r.backend.stageAssets().includes("/TestMod/S_Entry"));
    assert.doesNotMatch(x.out, /ABFC5018/);

    rmSync(join(r.dir, "src", "Entry.ts"));
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(x.out.split("\n").filter((l) => /ABFC5018/.test(l) && /S_Entry/.test(l)).length, 1, x.out);
    assert.match(x.out, /abfc never deletes a struct/);
    assert.ok(r.backend.stageAssets().includes("/TestMod/S_Entry"), "the struct stays on the stage");
    assert.equal(readManifest(r.dir, "/TestMod/S_Entry")?.structRetired, true);

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC5018/);
    assert.ok(r.backend.stageAssets().includes("/TestMod/S_Entry"));

    // declared again: nothing to do; removing it once more is reported again
    writeFileSync(join(r.dir, "src", "Entry.ts"), `import { struct } from "@abfc/runtime";
import type { int } from "@abfc/runtime";

@struct({ path: "/TestMod/S_Entry" })
export class S_Entry {
  Count!: int;
}
`, "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC5018/);
    assert.equal(readManifest(r.dir, "/TestMod/S_Entry")?.structRetired, undefined);
    rmSync(join(r.dir, "src", "Entry.ts"));
    x = await r.run(["build"]);
    assert.match(x.out, /ABFC5018/);
  });
});

test("(S22) two classes with the same name in different folders are two assets; deleting one deletes only that one", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    tallyOnly(r.dir, tally("BP_Dup"));
    rmSync(join(r.dir, "src", "Tally.ts"));
    for (const f of ["A", "B"]) {
      mkdirSync(join(r.dir, "src", f), { recursive: true });
      writeFileSync(join(r.dir, "src", f, "BP_Dup.ts"), tally("BP_Dup"), "utf8");
    }
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.backend.stageAssets().filter((a) => a.includes("Dup")).sort(), ["/TestMod/A/BP_Dup", "/TestMod/B/BP_Dup"]);
    rmSync(join(r.dir, "src", "A", "BP_Dup.ts"));
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /deleted \/TestMod\/A\/BP_Dup/);
    assert.deepEqual(r.backend.stageAssets().filter((a) => a.includes("Dup")), ["/TestMod/B/BP_Dup"]);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);
  });
});

test("(S22b) a hand-made asset at a TypeScript class path is taken over (ABFC5014) and is not deleted with the file", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    r.backend.addHandMadeReference("/TestMod/BP_Hand", "/TestMod/BP_Zed");
    r.backend.addHandMadeFunction("/TestMod/BP_Hand", "HandFn");
    writeFileSync(join(r.dir, "src", "Hand.ts"), tally("BP_Hand"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /ABFC5014/);
    assert.match(x.out, /hand-made function HandFn/);
    assert.notEqual(readManifest(r.dir, "/TestMod/BP_Hand")!.created, true);
    rmSync(join(r.dir, "src", "Hand.ts"));
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(r.backend.stageAssets().includes("/TestMod/BP_Hand"), "abfc did not create it, so it does not delete it");
    assert.doesNotMatch(x.out, /deleted \/TestMod\/BP_Hand/);
    assert.match(x.out, /warning ABFC5017: \/TestMod\/BP_Hand was not created by abfc, so it was not deleted/);
    assert.match(x.out, /Delete it in the Mod Editor/);
    x = await r.run(["build"]);
    assert.doesNotMatch(x.out, /ABFC5017/, "the warning is shown once, by the build that removed the parts");
  });
});

test("(S24) a TypeScript enum used as a field or event parameter is a clear error that names the way out", async () => {
  await withRig(OPS, async (r) => {
    writeFileSync(
      join(r.dir, "src", "Enum.ts"),
      `import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

export enum E_Mode {
  A,
  B,
}

@blueprint()
export class BP_Enum extends Actor {
  Mode!: E_Mode;

  @event
  Go(mode: E_Mode): void {}
}
`,
      "utf8",
    );
    const x = await r.run(["check"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /field Mode: a TypeScript enum has no Blueprint equivalent/);
    assert.match(x.out, /parameter mode: a TypeScript enum has no Blueprint equivalent/);
    assert.match(x.out, /use an int or byte field, or an enum of the game or the engine/);
  });
});

const manyClasses = (r: { dir: string }, folder: string, n: number): void => {
  mkdirSync(join(r.dir, "src", folder), { recursive: true });
  for (let i = 0; i < n; i++) {
    const name = `BP_Many${String(i).padStart(2, "0")}`;
    writeFileSync(join(r.dir, "src", folder, `${name}.ts`), tally(name), "utf8");
  }
};

test("(S28) 21 classes moved to another folder are renamed in two calls", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    rmSync(join(r.dir, "src", "Tally.ts"));
    manyClasses(r, "Many", 21);
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.assetOpsCalls.length, 0);
    renameSync(join(r.dir, "src", "Many"), join(r.dir, "src", "Many2"));
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.backend.assetOpsCalls.map((c) => c.length), [20, 1]);
    assert.equal(x.out.split("\n").filter((l) => /renamed \/TestMod\/Many\//.test(l)).length, 21, x.out);
    assert.doesNotMatch(x.out, /ABFC5016/);
    assert.equal(r.backend.stageAssets().filter((a) => a.startsWith("/TestMod/Many2/")).length, 21);
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.assetOpsCalls.length, 2);
  });
});

test("(S28b) a failed second chunk keeps the first chunk's manifest moves and reports ABFC5016", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    rmSync(join(r.dir, "src", "Tally.ts"));
    manyClasses(r, "Many", 21);
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    renameSync(join(r.dir, "src", "Many"), join(r.dir, "src", "Many2"));
    r.backend.assetOpsFailCall = 2;
    x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /ABFC5016/);
    assert.match(x.out, /The 20 operation\(s\) before it were done and are kept/);
    assert.deepEqual(r.backend.assetOpsCalls.map((c) => c.length), [20, 1]);
    const moved = r.backend.assetOpsCalls[0]!.map((op) => (op.op === "rename" ? op.to : ""));
    const last = r.backend.assetOpsCalls[1]![0]!;
    assert.equal(last.op, "rename");
    for (const to of moved) {
      assert.notEqual(readManifest(r.dir, to), null, `manifest at ${to}`);
    }
    for (const op of r.backend.assetOpsCalls[0]!) {
      if (op.op === "rename") assert.equal(readManifest(r.dir, op.from), null, `no manifest at ${op.from}`);
    }
    if (last.op === "rename") {
      assert.notEqual(readManifest(r.dir, last.from), null, "the 21st class is still at the old path");
      assert.equal(readManifest(r.dir, last.to), null);
    }
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.assetOpsCalls.length, 3);
    assert.equal(r.backend.assetOpsCalls[2]!.length, 1, "only the 21st is renamed now");
    assert.equal(x.out.split("\n").filter((l) => /renamed \/TestMod\/Many\//.test(l)).length, 1, x.out);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);
  });
});

// ---- S27: edits of abf.config.json between builds ----

const setConfig = (dir: string, patch: Record<string, unknown>): void => {
  writeFileSync(
    join(dir, "abf.config.json"),
    JSON.stringify({ mod: { name: "TestMod" }, backend: { kind: "bp_apply", minProtocol: 1 }, ...patch }),
    "utf8",
  );
};

test("(S27a) an unknown mod name is ABFC1004 before anything is written to a stage", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const callsBefore = r.backend.calls.length;
    const assetsBefore = r.backend.stageAssets();
    setConfig(r.dir, { mod: { name: "NoSuchMod" } });
    x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /ABFC1004: mod folder of NoSuchMod not found/);
    const tools = r.backend.calls.slice(callsBefore).map((c) => c.tool);
    for (const t of ["staging_sync", "bp_apply", "bp_asset_ops", "bp_publish"]) assert.ok(!tools.includes(t), `${t} was called: ${tools.join()}`);
    assert.deepEqual(r.backend.stageAssets(), assetsBefore);
    assert.equal(r.backend.assetOpsCalls.length, 0);
    setConfig(r.dir, {});
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
  });
});

test("(S27b) mod.name in another case builds the same assets", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC1045/);
    const assets = r.backend.stageAssets();
    const manifest = readManifest(r.dir, "/TestMod/BP_Zed");
    assert.notEqual(manifest, null);
    setConfig(r.dir, { mod: { name: "testmod" } });
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC1045: mod\.name "testmod" differs in case from the mod's plugin "TestMod"; using "TestMod"/);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.assetOpsCalls.length, 0);
    assert.deepEqual(r.backend.stageAssets(), assets, "no asset was created or moved");
    assert.ok(r.backend.stageAssets().every((a) => a.startsWith("/TestMod/")), "the backend only saw TestMod");
    assert.deepEqual(readManifest(r.dir, "/TestMod/BP_Zed"), manifest);
    assert.equal(readManifest(r.dir, "/testmod/BP_Tally"), null);
  });
});

test("(S27c) a new sourceRoot with the same folders changes no asset path", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    mkdirSync(join(r.dir, "src", "Sub"), { recursive: true });
    writeFileSync(join(r.dir, "src", "Sub", "BP_Inner.ts"), tally("BP_Inner"), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const assets = r.backend.stageAssets();
    const before = readManifest(r.dir, "/TestMod/Sub/BP_Inner");
    assert.equal(before?.source?.file, "src/Sub/BP_Inner.ts");
    renameSync(join(r.dir, "src"), join(r.dir, "source"));
    writeFileSync(
      join(r.dir, "tsconfig.json"),
      readFileSync(join(r.dir, "tsconfig.json"), "utf8").replace('"include": ["src"]', '"include": ["source"]'),
      "utf8",
    );
    setConfig(r.dir, { sourceRoot: "source" });
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.assetOpsCalls.length, 0);
    assert.deepEqual(r.backend.stageAssets(), assets);
    const after = readManifest(r.dir, "/TestMod/Sub/BP_Inner");
    assert.equal(after?.source?.file, "source/Sub/BP_Inner.ts", "the manifest follows the new folder");
    const spans = Object.values(readSourceMap(r.dir, "/TestMod/Sub/BP_Inner")?.units ?? {}).map((u) => u.span.file.split("\\").join("/"));
    assert.ok(spans.length > 0 && spans.every((f) => f.endsWith("source/Sub/BP_Inner.ts")), spans.join());
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);
  });
});

test("(S27d) a deeper sourceRoot renames every class", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    rmSync(join(r.dir, "src", "Tally.ts"));
    mkdirSync(join(r.dir, "src", "Deep"), { recursive: true });
    for (const n of ["BP_Alpha", "BP_Beta", "BP_Gamma"]) writeFileSync(join(r.dir, "src", "Deep", `${n}.ts`), tally(n), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(r.backend.stageAssets().includes("/TestMod/Deep/BP_Alpha"));
    setConfig(r.dir, { sourceRoot: "src/Deep" });
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.backend.assetOpsCalls.map((c) => c.length), [3]);
    assert.equal(x.out.split("\n").filter((l) => /renamed \/TestMod\/Deep\//.test(l)).length, 3, x.out);
    for (const n of ["BP_Alpha", "BP_Beta", "BP_Gamma"]) {
      assert.ok(r.backend.stageAssets().includes(`/TestMod/${n}`), n);
      assert.ok(!r.backend.stageAssets().includes(`/TestMod/Deep/${n}`), n);
    }
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.assetOpsCalls.length, 1);
  });
});

const lockPath = (dir: string): string => join(dir, ".abfc", "lock.json");
const writeLockFile = (dir: string, pid: number, startedAt = "2026-01-02T03:00:00.000Z", command = "build"): void => {
  mkdirSync(join(dir, ".abfc"), { recursive: true });
  writeFileSync(lockPath(dir), JSON.stringify({ pid, command, startedAt }), "utf8");
};
/** The id of a process that has already ended. */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(r.pid !== undefined && r.pid > 0);
  return r.pid;
};

test("(S29) a second run while the lock is held is ABFC4019; a stale lock is replaced", async () => {
  await withRig({}, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    // A normal run takes the lock and removes it again (also when it fails).
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(!existsSync(lockPath(r.dir)), "the lock stays after a finished run");

    // Held by a live process (this one): the run stops before the backend starts and leaves the lock alone.
    const startedBefore = r.started.count;
    writeLockFile(r.dir, process.pid);
    for (const cmd of ["build", "status", "publish", "generate", "stubs", "adopt", "test"]) {
      x = await r.run([cmd]);
      assert.equal(x.code, 2, `${cmd}: ${x.out}`);
      assert.ok(
        x.out.includes(`ABFC4019: another abfc build is running in this project (process ${process.pid}, since 2026-01-02T03:00:00.000Z)`),
        `${cmd}: ${x.out}`,
      );
    }
    assert.equal(r.started.count, startedBefore, "the backend was started");
    assert.ok(existsSync(lockPath(r.dir)), "the lock of the other run was removed");
    // check and doctor do not take the lock.
    x = await r.run(["check"]);
    assert.equal(x.code, 0, x.out);

    // A dead process: the lock is replaced silently and the run works.
    writeLockFile(r.dir, deadPid());
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC4019/);
    assert.ok(!existsSync(lockPath(r.dir)));

    // A live id but a lock older than the age limit (a reused id after a crash) is stale too.
    writeLockFile(r.dir, process.pid);
    const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
    utimesSync(lockPath(r.dir), old, old);
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(!existsSync(lockPath(r.dir)));

    // An unreadable lock file: held while young, replaced when old.
    mkdirSync(join(r.dir, ".abfc"), { recursive: true });
    writeFileSync(lockPath(r.dir), "{ not json", "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 2, x.out);
    assert.match(x.out, /ABFC4019: another abfc run is running/);
    utimesSync(lockPath(r.dir), old, old);
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(!existsSync(lockPath(r.dir)));

    // A failing run removes its lock as well.
    setConfig(r.dir, { mod: { name: "NoSuchMod" } });
    x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.ok(!existsSync(lockPath(r.dir)), "the lock stays after a failed run");
  });
});

// ---- (S32) undecorated methods are Blueprint function graphs ----

const withFunction = (name: string, expr: string, call = name): string =>
  tally("BP_Tally")
    .replace("this.Total = by;", `this.Total = this.${call}(by);`)
    .replace(/\n\}\n$/, `\n\n  ${name}(x: int): int {\n    return ${expr};\n  }\n}\n`);

test("(S32) a function is created, recreated on a change (its caller applied again), renamed and removed; the next build is up to date", async () => {
  await withRig({ ...OPS }, async (r) => {
    tallyOnly(r.dir, withFunction("twice", "x + x"));
    let x = await r.run(["doctor"]);
    assert.match(x.out, /function graphs: yes/);

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    let specs = appliedSpecs(r).filter((s) => s.asset === TA);
    assert.deepEqual(specs.flatMap((s) => (s.functions ?? []).map((f: any) => f.name)), ["twice"]);
    assert.equal(specs.some((s) => s.remove_functions !== undefined), false);
    const fn = specs.flatMap((s) => s.functions ?? [])[0];
    assert.deepEqual(fn.outputs, [{ name: "ReturnValue", type: "int" }]);
    assert.equal(fn.access, "public");
    assert.deepEqual(r.backend.functionNames(TA), ["twice"]);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    // a changed body: the graph is recreated whole and the caller is applied again
    let before = appliedSpecs(r).length;
    writeFileSync(join(r.dir, "src", "Tally.ts"), withFunction("twice", "x * 2"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.deepEqual(specs.flatMap((s) => s.remove_functions ?? []), ["twice"]);
    assert.deepEqual(specs.flatMap((s) => (s.functions ?? []).map((f: any) => f.name)), ["twice"]);
    const graphs = specs.flatMap((s) => s.graphs ?? []);
    assert.equal(graphs.find((g: any) => g.graph === "twice").remove.length, 0);
    assert.ok(graphs.some((g: any) => g.graph === "EventGraph" && g.remove.length > 0), "the caller of the recreated function is applied again");
    assert.deepEqual(r.backend.functionNames(TA), ["twice"]);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    // a renamed function: the old graph goes, the new one is created
    before = appliedSpecs(r).length;
    writeFileSync(join(r.dir, "src", "Tally.ts"), withFunction("thrice", "x * 3"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.deepEqual(specs.flatMap((s) => s.remove_functions ?? []), ["twice"]);
    assert.deepEqual(specs.flatMap((s) => (s.functions ?? []).map((f: any) => f.name)), ["thrice"]);
    assert.deepEqual(r.backend.functionNames(TA), ["thrice"]);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    // the method is gone from the TS: the graph is removed
    before = appliedSpecs(r).length;
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.deepEqual(specs.flatMap((s) => s.remove_functions ?? []), ["thrice"]);
    assert.equal(specs.some((s) => s.functions !== undefined), false);
    assert.deepEqual(r.backend.functionNames(TA), []);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);
    assert.doesNotMatch(x.out, /ABFC5014/);
  });
});

test("(S32b) a backend without the function_graphs feature: a function is ABFC2044 and nothing is applied", async () => {
  await withRig({ ...OPS, functionGraphs: false }, async (r) => {
    tallyOnly(r.dir, withFunction("twice", "x + x"));
    let x = await r.run(["doctor"]);
    assert.match(x.out, /function graphs: no/);
    x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /ABFC2044/);
    assert.match(x.out, /function twice needs a backend with bp_apply feature function_graphs/);
    assert.equal(appliedSpecs(r).length, 0);

    // a class without functions still builds on that backend
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
  });
});

// ---- (S33) node names are unique per graph only (as in Unreal) ----

// different parameter names on purpose: the fake's pin ids derive from node name + pin name, so equal names would hide a wrong entry
// the functions read different members (Total, Other) that the EventGraph never reads: that variable-get node name exists only in the two function graphs, with different contents (the old per-name parse resolved it by graph order)
const withTwoFunctions = (bodyOne = "a + this.Total", extra = ""): string =>
  tally("BP_Tally")
    .replace("  Total!: int;", "  Total!: int;\n  Other!: int;")
    .replace("this.Total = by;", "this.Total = this.addOne(by) + this.addTwo(by);")
    .replace(/\n\}\n$/, `\n\n  addOne(a: int): int {\n    return ${bodyOne};\n  }\n\n  addTwo(b: int): int {\n    return b + this.Other;\n  }\n${extra}}\n`);

test("(S33) per-graph node names (as in Unreal): a class with functions has no drift right after its build, and keys stay stable when a function changes or is added", async () => {
  await withRig({ ...OPS, perGraphNames: true }, async (r) => {
    tallyOnly(r.dir, withTwoFunctions());
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    x = await r.run(["status"]);
    assert.doesNotMatch(x.out, /ABFC500[12]/, x.out);
    const units = readManifest(r.dir, TA)!.units;
    for (const u of units) {
      if (u.id.startsWith("function:")) {
        const n = u.id.slice("function:".length);
        assert.ok(u.nodes.length > 0, `${u.id} has nodes`);
        assert.ok(u.nodes.every((k) => k.startsWith(`${n}/`)), `${u.id} nodes are graph-scoped keys: ${u.nodes.join(", ")}`);
      } else {
        assert.ok(u.nodes.every((k) => !k.includes("/")), `${u.id} nodes are plain: ${u.nodes.join(", ")}`);
      }
    }
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    // a changed body: only that function is recreated, nothing drifts afterwards
    let before = appliedSpecs(r).length;
    writeFileSync(join(r.dir, "src", "Tally.ts"), withTwoFunctions("a + this.Total + 10"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    let specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.deepEqual(specs.flatMap((s) => (s.functions ?? []).map((f: any) => f.name)), ["addOne"]);
    x = await r.run(["status"]);
    assert.doesNotMatch(x.out, /ABFC500[12]/, x.out);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    // a third (uncalled) function: only it is created
    before = appliedSpecs(r).length;
    writeFileSync(join(r.dir, "src", "Tally.ts"), withTwoFunctions("a + this.Total + 10", "\n  addThree(c: int): int {\n    return c + 3;\n  }\n"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.deepEqual(specs.flatMap((s) => (s.functions ?? []).map((f: any) => f.name)), ["addThree"]);
    x = await r.run(["status"]);
    assert.doesNotMatch(x.out, /ABFC500[12]/, x.out);
  });
});

test("(S40) after a re-sync the build reads only assets whose files changed since an earlier read; --full reads every asset from the editor", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally"), "utf8"); // two owned assets: BP_Relay and BP_Tally
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    r.backend.markPublished();
    const reads = (): number => r.backend.calls.filter((c) => c.tool === "bp_read").length;
    // The Mod Editor saved some other file of the mod: the next build re-syncs and goes over every owned asset.
    r.backend.stageStale = ["Content/Rooms/M_SomeMaterial.uasset"];
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4017/);
    const first = reads();

    // The same again: nothing abfc owns changed, so every read comes from the cache.
    r.backend.stageStale = ["Content/Rooms/M_SomeMaterial.uasset"];
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4017/);
    assert.equal(reads(), first, "no bp_read after a re-sync that left the owned assets' files as they were");

    // An editor edit of an owned asset changes its file: only that asset is read from the editor (and the edit is found, TS wins).
    r.backend.stageStale = ["Content/Tally.uasset"];
    r.backend.addHandMadeVariable("/TestMod/BP_Tally", "HandMade", "bool");
    r.backend.markPublished();
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(reads() > first, "the edited asset is read again");
    assert.ok(reads() - first <= 2, `only the edited asset is read (twice at most: re-sync check and plan), got ${reads() - first}`);

    // --full: every owned asset from the editor.
    const beforeFull = reads();
    x = await r.run(["build", "--full"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(reads() - beforeFull >= 2, `--full reads every owned asset, got ${reads() - beforeFull}`);
  });
});

const GUN_STUB = [
  "// generated by abfc generate 0.1.0 for test; do not edit, never commit",
  'import type { Actor } from "/Script/FakeEngine";',
  "",
  "/**",
  " * @bpPath /Game/Fake/BP_FakeGun.BP_FakeGun_C",
  " * @bpMeta /Script/Engine.BlueprintGeneratedClass",
  " * @bpCastPin AsBPFakeGun",
  " */",
  "export declare class BP_FakeGun_C extends Actor {",
  "  /**",
  "   * Calls BP_FakeGun_C.GunStartFiring (Gun Start Firing).",
  "   * @bpPath /Game/Fake/BP_FakeGun.BP_FakeGun_C:GunStartFiring",
  "   */",
  "  GunStartFiring(): void;",
  "}",
  "",
].join(String.fromCharCode(10));

function gunProject(dir: string): void {
  writeFileSync(join(dir, ".abfc", "stubs", "test", "Game", "Fake", "BP_FakeGun.d.ts"), GUN_STUB, "utf8");
  tallyOnly(
    dir,
    [
      'import { blueprint, override } from "@abfc/runtime";',
      'import { BP_FakeGun_C } from "/Game/Fake/BP_FakeGun";',
      "",
      "@blueprint()",
      "export class BP_Hook extends BP_FakeGun_C {",
      "  Fired: boolean = false;",
      "  @override",
      "  override GunStartFiring(): void {",
      "    this.Fired = true;",
      "  }",
      "}",
      "",
    ].join(String.fromCharCode(10)),
  );
}

test("(S41) an @override of an event declared in a Blueprint class that comes out as a custom event fails the build (ABFC6003)", async () => {
  await withRig({ handMadeEvent: false, overrideAsCustomEvent: true }, async (r) => {
    gunProject(r.dir);
    const x = await r.run(["build"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /ABFC6003/);
    assert.match(x.out, /custom event GunStartFiring_1/);
  });
});

test("(S41b) the same override is fine when the backend keeps it an override event", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    gunProject(r.dir);
    const x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC6003/);
    const ov = appliedSpecs(r).flatMap((s) => (s.graphs ?? []).flatMap((g: any) => g.add ?? [])).find((n: any) => n.k === "override");
    assert.equal(ov?.class, "/Game/Fake/BP_FakeGun.BP_FakeGun_C");
    assert.equal(ov?.function, "GunStartFiring");
  });
});
