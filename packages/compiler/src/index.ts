export * from "./hir.js";
export { SourceFileCache, TS_VERSION, loadProgram, loadedFromProgram, ownedManualFilter, tsDiagnostics } from "./frontend/program.js";
export type { LoadProgramOptions, LoadedProgram, TsProgram, TsSourceFile } from "./frontend/program.js";
export { stubDescriptionAt, tsQuickInfoAt } from "./frontend/hover.js";
export { defaultLibDir, useTypeScriptLibDir } from "./frontend/tslib.js";
export { checkProject, lowerChecked } from "./service.js";
export type { ProjectCheck } from "./service.js";
export { buildHir, checkSubset } from "./frontend/build.js";
export { compileTests } from "./frontend/tests.js";
export { assetPathOf, bindPathContext, modImportHints, pathContextOf } from "./frontend/assetpaths.js";
export type { AssetPathInfo, AssetPathProblem, CompilerProjectConfig, PathContext } from "./frontend/assetpaths.js";
export { blockedMemberHits } from "./frontend/blocked.js";
export { lower, formatLiteral, assignPositions } from "./lower/index.js";
export type { LowerOptions } from "./lower/index.js";
export { analyzeAdoption, adoptionDiagnostics, AdoptionError } from "./ownership/adopt.js";
export type { AdoptionAnalysis, AdoptOptions } from "./ownership/adopt.js";
export { builtGraphMatches, driftDiagnostics, engineNormalisedFunction, fingerprintUnit, rebaseStaleUnits, unitState } from "./ownership/drift.js";
export type { StageInfo, UnitFingerprint, UnitState } from "./ownership/drift.js";
export {
  assetFileStem,
  deleteManifest,
  listManifests,
  manifestPath,
  ownedSets,
  readManifest,
  readRetired,
  stringifySorted,
  writeManifest,
  writeRetired,
} from "./ownership/manifest.js";
export type { Manifest, ManifestUnit } from "./ownership/manifest.js";
export { matchOrphans, movedClassDiagnostics, movedDiagnostic, pairReason } from "./ownership/moved.js";
export type { OrphanMatch } from "./ownership/moved.js";
export { parentOps, planAssetOps, sameClassPath } from "./plan/assetops.js";
export type { AssetOpCaps, AssetOpsPlan, ParentPlan, PlannedAssetOp } from "./plan/assetops.js";
export { deleteSourceMap, mapCompileMessages, readSourceMap, sourceMapPath, writeSourceMap } from "./ownership/sourcemap.js";
export type { CompileMessageLike, SourceMapFile } from "./ownership/sourcemap.js";
export { assetsNeedingRead, planBuild } from "./plan/planner.js";
export type { PlanInput, PlanResult } from "./plan/planner.js";
export { featureGates } from "./plan/gates.js";
export type { GateCapabilities } from "./plan/gates.js";
export { udsGuid, udsMemberName } from "./frontend/structnames.js";
export { describeIrNode, irNodesAt } from "./explain.js";
export { addDirectorTagFix, directorFix, idivFix, keepPathFix, modImportFix, optionalChainFix, relativePathFix, removePathFix, useOverrideFix } from "./frontend/fixes.js";
export type { TextEdit } from "./frontend/fixes.js";
export { MIN_WORD_MATCH, buildCompletionIndex, buildLibraryIndex, completionIndexOf, completionsAt, displayNameFromDoc, libraryEntriesOf, matchName } from "./frontend/completions.js";
export type { AbfcCompletion, CatalogTypeEntry, CompletionIndex, CompletionItemSource, LibraryEntry, NameMatch } from "./frontend/completions.js";
export { PrefixIndex } from "./frontend/nameindex.js";
export type { NameHit } from "./frontend/nameindex.js";
export { sourceStubImports, stubImportAt } from "./frontend/stubimports.js";
export type { StubImport } from "./frontend/stubimports.js";
export { placeholderOfSymbol, placeholderReceiverAt, placeholderTypesUsed, placeholdersOfType } from "./frontend/opaqueuse.js";
export type { PlaceholderType } from "./frontend/opaqueuse.js";
