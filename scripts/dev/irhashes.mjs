// Dev only: prints the IR hash of every unit of an abfc project, to check that a compiler change re-plans nothing it should not.
// node scripts/dev/irhashes.mjs <packages/compiler/dist> <project dir> <profile json> > hashes.txt  (run before and after, then diff)
const [compilerDist, dir, profilePath] = process.argv.slice(2);
const { buildHir, loadProgram, lower } = await import(compilerDist + "/src/index.js");
const fs = await import("node:fs");
const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
const loaded = loadProgram(dir);
for (const d of loaded.diagnostics) console.error("LOAD", d.code, d.message, d.span?.file, d.span?.line);
const mod = JSON.parse(fs.readFileSync(dir + "/abf.config.json", "utf8").replace(/^\uFEFF/, "")).mod.name;
const hir = buildHir(loaded, { mod }, profile);
for (const d of hir.diagnostics) console.error("HIR", d.severity, d.code, d.message.slice(0, 140), d.span?.file, d.span?.line);
const ir = lower(hir, profile);
for (const a of ir.assets) for (const u of a.units) console.log(a.path, u.id, u.hash.slice(7, 19));
