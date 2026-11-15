import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadCache, classifyReferences, readCacheIdentity, referencedPackages } from "../src/readcache.js";

function rig(): { stage: string; cacheDir: string; write(rel: string, text: string): void; done(): void } {
  const root = mkdtempSync(join(tmpdir(), "abfc-readcache-"));
  const stage = join(root, "stage");
  const cacheDir = join(root, "cache");
  return {
    stage,
    cacheDir,
    write: (rel, text) => {
      const f = join(stage, "Content", ...rel.split("/"));
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, text, "utf8");
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const ID = readCacheIdentity({ server: "1" });
const A = "/Mod/Code/BP_A";
const exportOf = (body: string): string => `Begin Object Class=/Script/Engine.Blueprint Name="BP_A"\n${body}\nEnd Object\n`;

test("referencedPackages lists the mod packages an export names, without itself and without game paths", () => {
  const text = `ParentClass=/Script/Engine.Actor\nX="/Mod/Code/BP_B.BP_B_C" Y='/mod/Items/Thing.Thing' Z=/Game/Foo/Bar.Bar W=/Mod/Code/BP_A.BP_A_C V=/Mod/`;
  assert.deepEqual(referencedPackages(text, "Mod", A), ["/Mod/Code/BP_B", "/mod/Items/Thing"]);
});

test("a read is served again while the asset's files are unchanged, and not after they change", () => {
  const r = rig();
  try {
    r.write("Code/BP_A.uasset", "v1");
    r.write("Code/BP_A.uexp", "e1");
    const c = new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    const k = c.key(A)!;
    assert.equal(c.get(k), null);
    c.put(k, exportOf("one"));
    // a new cache object (the next build) finds it on disk
    const c2 = new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    assert.equal(c2.get(c2.key(A)!), exportOf("one"));
    r.write("Code/BP_A.uexp", "e2");
    assert.equal(c2.get(c2.key(A)!), null, "the .uexp changed");
    // the earlier file comes back (a failed compile re-synced the stage): the earlier read is still known
    r.write("Code/BP_A.uexp", "e1");
    assert.equal(c2.get(c2.key(A)!), exportOf("one"));
  } finally {
    r.done();
  }
});

test("a change to a mod package the export references invalidates the read (dependency-aware)", () => {
  const r = rig();
  try {
    r.write("Code/BP_A.uasset", "v1");
    r.write("Code/BP_B.uasset", "b1");
    const c = new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    c.put(c.key(A)!, exportOf(`Call=/Mod/Code/BP_B.BP_B_C`));
    const fresh = (): ReadCache => new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    assert.notEqual(fresh().get(fresh().key(A)!), null);
    r.write("Code/BP_B.uasset", "b2-longer");
    const c3 = fresh();
    assert.equal(c3.get(c3.key(A)!), null, "BP_B changed");
    // an unrelated package changing does not matter
    const c4 = fresh();
    c4.put(c4.key(A)!, exportOf(`Call=/Mod/Code/BP_B.BP_B_C`));
    r.write("Code/BP_Other.uasset", "o2");
    const c5 = fresh();
    assert.notEqual(c5.get(c5.key(A)!), null);
  } finally {
    r.done();
  }
});

test("another backend or stub identity never uses the read; an asset with no file in the stage is never cached", () => {
  const r = rig();
  try {
    r.write("Code/BP_A.uasset", "v1");
    const c = new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    c.put(c.key(A)!, exportOf("one"));
    const other = new ReadCache(r.cacheDir, r.stage, "Mod", readCacheIdentity({ server: "2" }));
    assert.equal(other.get(other.key(A)!), null);
    assert.equal(c.key("/Mod/Code/BP_Missing"), null);
  } finally {
    r.done();
  }
});

test("a package named only as a default value is kept by presence: re-saving it keeps the read, deleting it does not", () => {
  const r = rig();
  try {
    r.write("Code/BP_A.uasset", "v1");
    r.write("Rooms/BP_Section.uasset", "s1");
    r.write("Code/BP_B.uasset", "b1");
    const pin = (cls: string): string =>
      `CustomProperties Pin (PinId=1,PinName="Class",PinType.PinCategory="class",PinType.PinSubCategoryObject=/Script/CoreUObject.Class'/Script/Engine.Actor',DefaultObject="/Mod/Rooms/${cls}.${cls}_C",)`;
    const text = exportOf(`${pin("BP_Section")}\nFunctionReference=(MemberParent="/Script/Engine.BlueprintGeneratedClass'/Mod/Code/BP_B.BP_B_C'",MemberName="Go")`);
    const kinds = classifyReferences(text, "Mod", A);
    assert.deepEqual([...kinds], [["/Mod/Code/BP_B", "structure"], ["/Mod/Rooms/BP_Section", "value"]]);
    const c = new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    c.put(c.key(A)!, text);
    // a room bake saves the section again: the read stands
    r.write("Rooms/BP_Section.uasset", "s2-rebaked");
    const c2 = new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    assert.equal(c2.get(c2.key(A)!), text);
    // a change to a class whose member the export calls still re-reads, and says why
    r.write("Code/BP_B.uasset", "b2");
    const c3 = new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    assert.equal(c3.get(c3.key(A)!), null);
    assert.deepEqual(c3.missed, [{ asset: A, reason: "dep", dep: "/Mod/Code/BP_B" }]);
    r.write("Code/BP_B.uasset", "b1");
    // the section deleted: the read is not used
    rmSync(join(r.stage, "Content", "Rooms", "BP_Section.uasset"));
    const c4 = new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    assert.equal(c4.get(c4.key(A)!), null);
    assert.equal(c4.missed[0]?.reason, "dep");
  } finally {
    r.done();
  }
});

test("a mention that is both a default and a type counts as structure", () => {
  const text = `DefaultObject="/Mod/X/BP_S.BP_S_C"\nVarType=(PinCategory="object",PinSubCategoryObject="/Script/Engine.BlueprintGeneratedClass'/Mod/X/BP_S.BP_S_C'")`;
  assert.deepEqual([...classifyReferences(text, "Mod", A)], [["/Mod/X/BP_S", "structure"]]);
});

test("misses say why: never read, own files changed", () => {
  const r = rig();
  try {
    r.write("Code/BP_A.uasset", "v1");
    const c = new ReadCache(r.cacheDir, r.stage, "Mod", ID);
    assert.equal(c.get(c.key(A)!), null);
    c.put(c.key(A)!, exportOf("one"));
    r.write("Code/BP_A.uasset", "v2");
    assert.equal(c.get(c.key(A)!), null);
    assert.deepEqual(c.missed.map((m) => m.reason), ["new", "files"]);
  } finally {
    r.done();
  }
});
