import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { win32 } from "node:path";
import type { Backend, ReflectData } from "@abfc/backend";
import { libraryEntriesOf, loadProgram, ownedSets, placeholderTypesUsed, sourceStubImports } from "@abfc/compiler";
import type { LoadedProgram } from "@abfc/compiler";
import { AbfcError, runtimeLayout } from "@abfc/env";
import {
  classesWithoutSupers,
  COVERAGE_FILE,
  STUBGEN_VERSION,
  catalogFromBackend,
  catalogLookup,
  completionNamesOf,
  coverageOf,
  emitStubsWithIndex,
  manualFromExport,
  manualReferences,
  missingAncestors,
  missingStructs,
  newLock,
  readCatalog,
  readCoverage,
  readGameTags,
  readLock,
  readStubCache,
  sortedWidgetMembers,
  rulesFromPairs,
  writeFileAtomic,
  writeCatalog,
  writeGameTags,
  writeLock,
  writeStubSet,
  writeTsconfigPaths,
} from "@abfc/stubgen";
import type { Catalog, ManualAsset, StubCache } from "@abfc/stubgen";
import type { CliContext } from "../context.js";
import { SLOW_BACKEND_HINT } from "../progress.js";
import { reflectAll } from "../reflectchunks.js";
import { recordRun } from "../runs.js";
import { backendIdOf, resolveStubRequest, shortName, stubsNeedWork, usedPlaceholdersToGenerate } from "../stubsauto.js";
import type { StubMode } from "../stubsauto.js";
import { refreshTagsFile } from "../tags.js";
import { BackendSession, Recorder, backendStartOptions, pruneManifestsToStage, since } from "./common.js";
import { ensureStage } from "./stage.js";

/** Folders of the mod's Content that are never stubbed. */
const SKIPPED_FOLDERS = ["_McpTest", "_McpTmp"];

/** Upper bound of the reflect rounds that close parent chains and structs. */
const MAX_REFLECT_ROUNDS = 6;

/** The backend's refusal to read an asset of another class (`<asset> is not a Blueprint (<Class>)`, `<asset> is a <Class>, not a Blueprint`). */
const NOT_A_BLUEPRINT = /not a Blueprint/i;

/**
 * False only for a package that certainly holds no Blueprint: its name table lacks `BlueprintGeneratedClass` (which also
 * matches Widget and Anim Blueprints). Meshes, textures, materials and sounds are most of a mod, and each one read through
 * the backend costs a headless export (15-18 s), so they are skipped before the read. Unreadable files are kept.
 */
function mayBeBlueprint(host: CliContext["deps"]["host"], file: string): boolean {
  try {
    return host.readFile(file).includes("BlueprintGeneratedClass");
  } catch {
    return true;
  }
}

/** Every `*.uasset` below `<modDir>\Content` that may be a Blueprint, as `/<mod>/<path without extension>`. */
function listModAssets(ctx: CliContext, modDir: string): string[] {
  const host = ctx.deps.host;
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of host.readDir(dir)) {
      if (SKIPPED_FOLDERS.includes(name)) continue;
      if (name.toLowerCase().endsWith(".uasset")) {
        if (!mayBeBlueprint(host, win32.join(dir, name))) continue;
        out.push(`/${ctx.config.mod.name}/${rel}${name.slice(0, -".uasset".length)}`);
      } else if (!name.includes(".")) {
        walk(win32.join(dir, name), `${rel}${name}/`);
      }
    }
  };
  walk(win32.join(modDir, "Content"), "");
  return out.sort();
}

/** `.d.ts` next to a package entry point, as an absolute path (resolved from this package, never hardcoded). */
function declarationOf(spec: string): string {
  const req = createRequire(import.meta.url);
  return req.resolve(spec).replace(/\.js$/, ".d.ts");
}

function merge(into: ReflectData, add: ReflectData): void {
  into.engineVersion ??= add.engineVersion;
  for (const [k, v] of Object.entries(add.classes)) {
    const have = into.classes[k];
    if (have === undefined || (have.castOnly === true && v.castOnly !== true)) into.classes[k] = v;
  }
  for (const [k, v] of Object.entries(add.structs)) if (into.structs[k] === undefined) into.structs[k] = v;
  if (add.supers !== undefined) {
    const sup = (into.supers ??= {});
    for (const [k, v] of Object.entries(add.supers)) if (sup[k] === undefined) sup[k] = v;
  }
  // The cooked-class source counts as present only when every round that reflected Blueprint classes had it (a round whose reader
  // failed must not be hidden by another round's union).
  if (add.memberSources !== undefined) into.memberSources = [...new Set([...(into.memberSources ?? []), ...add.memberSources])];
  const reflectedGame = Object.entries(add.classes).some(([p, c]) => p.startsWith("/Game/") && c.castOnly !== true);
  if (reflectedGame && !(add.memberSources ?? []).includes("cookedClass")) cookedMissing.add(into);
  if (cookedMissing.has(into) && into.memberSources !== undefined) into.memberSources = into.memberSources.filter((s) => s !== "cookedClass");
  into.errors.push(...add.errors);
}

/** What one `abfc generate` run reflects and writes (decided by {@link generateStubs}). */
interface StubRun {
  mode: StubMode;
  /** Every game class of the catalog is reflected (no valid cache). */
  full: boolean;
  /** The cache of an earlier run: what it holds is not reflected again. */
  seed: StubCache | null;
  /** Read the mod's own assets (explicit runs and runs without a cache); otherwise they come from the seed. */
  readModAssets: boolean;
  classes: string[];
  structs: string[];
  /** The /Game entries of `classes`. */
  castTargets: string[];
  /** Every enum to declare even when no member references it (imported, added, or declared by an earlier run). */
  opaqueEnums: string[];
  /** Classes a missing cast pin is reported for. */
  userClasses: string[];
  catalog: { catalog: Catalog; sha256: string } | null;
  /** Classes an earlier run could not reflect and this run skipped. */
  failed: string[];
  added: string[];
  notFound: string[];
}

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** How many `reflect:` messages of the backend are printed one by one. */
const REFLECT_MESSAGES_SHOWN = 20;

/** What the code that runs inside a progress step needs of it (a no-op when the work needs no step). */
interface StepHandle {
  tick(count: number, total?: number): void;
  detail(text: string): void;
}
const NO_STEP: StepHandle = { tick: () => undefined, detail: () => undefined };

/** Merged reflect results that had a round without the cooked-class member source. */
const cookedMissing = new WeakSet<ReflectData>();

async function reflectAndRead(ctx: CliContext, backend: Backend, run: StubRun): Promise<number> {
  const { config, env, output, deps, paths } = ctx;
  const mod = config.mod.name;
  const at = (): string => deps.now().toISOString();
  const clock = (): number => performance.now();

  const info = await backend.info();
  if (config.stubs.scriptModules !== undefined && config.stubs.scriptModules.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC3010",
      message: "stubs.scriptModules is ignored in Phase 1; list the classes in stubs.scriptClasses instead.",
    });
  }

  // Mod assets first, so their struct references join the reflect closure.
  const modAssetsCfg = config.stubs.modAssets;
  const modDir = env.modDir.value;
  const assetList = modAssetsCfg === "all" ? (modDir === null ? [] : listModAssets(ctx, modDir)) : modAssetsCfg;
  const manual: ManualAsset[] = [];
  const owned = ownedSets(ctx.projectDir);
  const t0 = clock();
  if (!run.readModAssets) {
    manual.push(...run.seed!.manual);
  } else if (assetList.length > 0) {
    let skipped = 0;
    await ctx.progress.run(
      "Reading mod assets",
      async (s) => {
        for (const [i, asset] of assetList.entries()) {
          try {
            const snap = await backend.read(mod, asset);
            const text = deps.host.readFile(snap.exportPath);
            manual.push(manualFromExport(asset, text, snap.structure, owned[asset] ?? { units: [], variables: [] }));
          } catch (e) {
            if (e instanceof AbfcError && e.diagnostic.code !== "ABFC4002" && e.diagnostic.code !== "ABFC4100") throw e;
            skipped++;
            // The mod also holds assets that are not Blueprints (mod config, class-manager rows, structs, metadata): the backend says so, and they have no stub to make.
            if (e instanceof AbfcError && e.diagnostic.code === "ABFC4002" && NOT_A_BLUEPRINT.test(e.diagnostic.message)) continue;
            output.diag({
              severity: "warning",
              code: "ABFC4002",
              message: `could not read ${asset} for stubs, skipped: ${e instanceof Error ? e.message : String(e)}`,
            });
          } finally {
            s.tick(i + 1, assetList.length);
          }
        }
      },
      {
        total: assetList.length,
        slowHint: SLOW_BACKEND_HINT,
        done: () => `Read ${manual.length} mod asset(s)${skipped > 0 ? `, ${skipped} skipped` : ""}`,
      },
    );
  }
  recordRun(paths.runsFile, { at: at(), step: "stubs.read", seconds: (clock() - t0) / 1000, ok: true, units: manual.length, mode: "cold" });

  // Reflection: the configured classes, then every ancestor on their parent chains with members, the struct closure (depth 2) and the parent chains of the opaque types.
  const t1 = clock();
  const profileDir = win32.join(paths.stubsDir, env.profile.id);
  const reflectCount = run.classes.length + run.structs.length;
  const reflectBody = async (s: StepHandle) => {
    // (runs inside the "Reflecting" step when there is something to reflect)
    const first =
      reflectCount > 0
        ? await reflectAll(
            backend,
            {
              mod,
              classes: run.classes,
              structs: run.structs,
              castTargets: run.castTargets,
              ...(info.capabilities.gameplayTags ? { gameplayTags: true } : {}),
            },
            (l) => {
              output.info(l);
              // The fallback reflects in chunks ("stubs: reflect chunk 2/5 (500 classes)"): the finished chunks are the counter.
              const m = /reflect chunk (\d+)\/(\d+)/.exec(l);
              if (m !== null) s.tick(Number(m[1]) - 1, Number(m[2]));
            },
          )
        : null;
    // Nothing to reflect: the game's tags and the filter of the last run stay.
    const filter = first !== null ? first.result.filter : (run.seed?.filter ?? { contentVersion: null, rules: [] });
    const gameTags = first !== null ? (info.capabilities.gameplayTags ? (first.result.data.gameplayTags?.tags ?? []) : null) : readGameTags(profileDir);
    if (first !== null && gameTags === null) {
      output.diag({
        severity: "warning",
        code: "ABFC3012",
        message: "the backend cannot list the game's gameplay tags; .abfc/tags.d.ts holds only the mod's own tags.",
        fix: "update abf-mod-editor-mcp to 2.6.0 or newer, then run abfc generate again.",
      });
    }
    const data: ReflectData = { engineVersion: null, classes: {}, structs: {}, errors: [] };
    if (first !== null) merge(data, first.result.data);
    // The seed's old messages stay with the run that produced them: data.errors holds this run's messages only.
    if (run.seed !== null) merge(data, { ...run.seed.reflect, errors: [] });
    const manualRefs = manual.flatMap((m) => manualReferences(m));
    const manualParents = manual.map((m) => m.parent).filter((p): p is string => p !== null);
    const manualPaths = new Set(manual.map((m) => m.classPath));
    // Backends that report `supers` do so on every reflect call; with everything from the cache (nothing reflected now) the seed tells.
    const supersSupported = (first !== null ? first.result.data.supers : run.seed?.reflect.supers) !== undefined;
    const askedClasses = new Set<string>(run.classes);
    const askedSupers = new Set<string>();
    let structRounds = 0;
    for (let round = 0; round < MAX_REFLECT_ROUNDS; round++) {
      const needClasses = missingAncestors(data, manualParents, manualPaths).filter((p) => !askedClasses.has(p));
      const needStructs = structRounds < 2 ? missingStructs(data, manualRefs) : [];
      const needSupers = supersSupported ? classesWithoutSupers(data, manualRefs).filter((p) => !askedSupers.has(p) && !needClasses.includes(p)) : [];
      if (needClasses.length + needStructs.length + needSupers.length === 0) break;
      if (needStructs.length > 0) structRounds++;
      for (const p of needClasses) askedClasses.add(p);
      for (const p of needSupers) askedSupers.add(p);
      s.detail(`parents and structs, round ${round + 1}`);
      const more = await backend.reflect({ mod, classes: needClasses, structs: needStructs, castTargets: [], ...(needSupers.length > 0 ? { supersOf: needSupers } : {}) });
      merge(data, more.data);
    }
    return { first, filter, gameTags, data, supersSupported };
  };
  const { first, filter, gameTags, data, supersSupported } =
    reflectCount > 0
      ? await ctx.progress.run(`Reflecting ${reflectCount} class(es)`, reflectBody, {
          slowHint: SLOW_BACKEND_HINT,
          done: (r) => `Reflected ${Object.keys(r.data.classes).length} class(es), ${Object.keys(r.data.structs).length} struct(s)`,
        })
      : await reflectBody(NO_STEP);
  recordRun(paths.runsFile, {
    at: at(),
    step: "stubs.reflect",
    seconds: (clock() - t1) / 1000,
    ok: true,
    units: Object.keys(data.classes).length,
    mode: "cold",
  });
  for (const msg of data.errors.slice(0, REFLECT_MESSAGES_SHOWN)) {
    output.diag({ severity: "warning", code: "ABFC4002", message: `reflect: ${msg}` });
  }
  if (data.errors.length > REFLECT_MESSAGES_SHOWN) {
    output.diag({
      severity: "warning",
      code: "ABFC4002",
      message: `… and ${data.errors.length - REFLECT_MESSAGES_SHOWN} more reflect messages (see _coverage.json)`,
    });
  }
  for (const c of run.userClasses) {
    if (data.classes[c] !== undefined && data.classes[c].castPin === null) {
      output.diag({ severity: "warning", code: "ABFC3004", message: `no cast pin could be determined for ${c}; casts to it will be refused.` });
    }
  }
  // A requested class or struct the reflect result does not hold (or holds only as a cast target) is left out and not retried until --add, --refresh or a new editor build.
  const reflectedWithMembers = (c: string): boolean => (data.classes[c] !== undefined && data.classes[c].castOnly !== true) || data.structs[c] !== undefined;
  const failedNow = [...run.classes, ...run.structs].filter((c) => !reflectedWithMembers(c));
  if (failedNow.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC3023",
      message: `${failedNow.length} class(es) could not be reflected and are left out of the stubs: ${failedNow.slice(0, 10).map(shortName).join(", ")}${failedNow.length > 10 ? ", ..." : ""}`,
      fix: "abfc generate --add <path> retries one; abfc generate --refresh retries all.",
    });
  }

  // Emit and write.
  const t2 = clock();
  const { files, index } = await ctx.progress.run(
    "Generating stub declarations",
    () =>
      emitStubsWithIndex({
        profile: env.profile,
        reflect: data,
        filter: { rules: rulesFromPairs(filter.rules), contentVersion: filter.contentVersion },
        manual,
        widgetMembers: config.stubs.widgetMembers,
        mod,
        opaque: [],
        opaqueEnums: run.opaqueEnums,
      }),
    { done: (r) => `Generated ${r.files.size} stub file(s)` },
  );
  const firstFew = (list: string[]): string => `${list.slice(0, 5).join(", ")}${list.length > 5 ? ", ..." : ""}`;
  if (index.noSupers.length > 0 && supersSupported) {
    output.diag({
      severity: "warning",
      code: "ABFC3013",
      message: `the backend could not confirm the Blueprint parent chain of ${index.noSupers.length} class(es) (${firstFew(index.noSupers)}); they extend the nearest native class, so members declared on Blueprint parents are missing.`,
      fix: 'check the reflect warnings (ABFC4002) above for the parent that failed to load, then run "abfc generate" again.',
    });
  } else if (index.noSupers.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC3013",
      message: `the backend did not report the Blueprint parent classes of ${index.noSupers.length} class(es) (${firstFew(index.noSupers)}); their stubs extend the nearest native class, so members declared on Blueprint parents are missing.`,
      fix: 'update abf-mod-editor-mcp to a version whose reflect reports "supers" (see docs/backend.md), then run "abfc generate".',
    });
  }
  if (index.chainGaps.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC3013",
      message: `${index.chainGaps.length} stub class(es) inherit from a class without members: ${firstFew(index.chainGaps)}.`,
      fix: 'check the reflect warnings (ABFC4002) above and run "abfc generate" again; report the class if the warning stays.',
    });
  }
  // Members that class defaults cannot list (widgets, components, widget/component variables) come from the backend's member pass.
  const gameClasses = Object.entries(data.classes)
    .filter(([p, c]) => p.startsWith("/Game/") && c.castOnly !== true)
    .map(([p]) => p);
  const memberSources = data.memberSources ?? [];
  if (gameClasses.length > 0 && !memberSources.includes("cookedClass")) {
    const partial = memberSources.includes("widgetTree") && memberSources.includes("scs");
    output.diag({
      severity: "warning",
      code: "ABFC3014",
      message: partial
        ? `the backend found the designer widgets and components of ${gameClasses.length} Blueprint class(es) but could not list their other variables; plain variables of widget or component type are missing from the stubs.`
        : `the backend did not list the members that class defaults cannot show (widget and component variables) for ${gameClasses.length} Blueprint class(es); such members are missing from the stubs.`,
      fix: 'update abf-mod-editor-mcp (see docs/backend.md) and check the reflect warnings (ABFC4002) above, then run "abfc generate" again.',
    });
  }
  const discovered = new Set(index.discovered.map((d) => d.slice(0, d.lastIndexOf(" (")).toLowerCase()));
  for (const [cls, members] of Object.entries(config.stubs.widgetMembers)) {
    for (const [member, widget] of Object.entries(members)) {
      if (discovered.has(`${cls}:${member}`.toLowerCase())) continue;
      if (data.classes[widget] === undefined) {
        output.diag({
          severity: "warning",
          code: "ABFC3011",
          message: `stubs.widgetMembers: ${cls} ${member} is a ${widget}, which is not in the stubs; it is typed UObject.`,
          fix: `"${widget}" is requested automatically; check that it is a class of this editor build, then run "abfc generate --add ${widget}" to retry it.`,
        });
      }
    }
  }

  const widgetEntries = Object.entries(config.stubs.widgetMembers).flatMap(([cls, members]) => Object.keys(members).map((m) => ({ cls, member: m })));
  const found = widgetEntries.filter((e) => discovered.has(`${e.cls}:${e.member}`.toLowerCase()));
  for (const e of found) {
    output.diag({
      severity: "warning",
      code: "ABFC3015",
      message: `stubs.widgetMembers: ${e.cls} ${e.member} is found by abfc generate itself now; remove the entry (stubs.widgetMembers is deprecated).`,
    });
  }
  const kept = widgetEntries.filter((e) => !found.includes(e));
  if (kept.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC3015",
      message: `stubs.widgetMembers is deprecated; ${kept.length} entr${kept.length === 1 ? "y was" : "ies were"} not found by reflection and ${kept.length === 1 ? "is" : "are"} still taken from the config: ${firstFew(kept.map((e) => `${e.cls}:${e.member}`))}.`,
      fix: "report these members; the setting will be removed.",
    });
  }
  const failedFinal = sortedUnique([...run.failed, ...failedNow].filter((c) => !reflectedWithMembers(c)));
  const lock = newLock({
    profile: env.profile.id,
    engineVersion: data.engineVersion,
    modEditorVersion: env.profile.modEditorVersion,
    editorFingerprint: env.fingerprint ?? "",
    filterContentVersion: filter.contentVersion,
    classes: [...config.stubs.classes],
    scriptClasses: [...config.stubs.scriptClasses],
    modAssets: manual.map((m) => m.asset),
    widgetMembers: sortedWidgetMembers(config.stubs.widgetMembers),
    auto:
      run.catalog !== null
        ? { catalogSha256: run.catalog.sha256, gameClasses: run.catalog.catalog.game.length, failed: failedFinal, added: run.added }
        : // A backend without the catalog tool: builds do not start it again to look for the tool until the editor or the backend changes.
          { catalogSha256: "", gameClasses: 0, failed: failedFinal, added: run.added, noCatalog: backendIdOf(env) },
    createdAt: deps.now().toISOString(),
  });
  await ctx.progress.run(
    "Writing stub files",
    async () => {
    writeStubSet(profileDir, {
      files,
      index,
      lock,
      coverage: coverageOf(data, index.opaque, data.errors),
      cache: {
        version: 1,
        generator: STUBGEN_VERSION,
        editorFingerprint: env.fingerprint ?? "",
        reflect: data,
        filter: { contentVersion: filter.contentVersion, rules: filter.rules },
        manual,
      },
      library: { version: 1, entries: libraryEntriesOf(files) },
      names: run.catalog !== null ? completionNamesOf(run.catalog.catalog) : null,
      clearRetired: run.readModAssets,
    });
    if (first !== null && gameTags !== null) writeGameTags(profileDir, gameTags);
    mkdirSync(paths.abfcDir, { recursive: true });
    const layout = runtimeLayout();
    writeTsconfigPaths(
      paths.abfcDir,
      env.profile.id,
      mod,
      layout?.runtimeDts ?? declarationOf("@abfc/runtime"),
      layout?.testkitDts ?? declarationOf("@abfc/testkit"),
      layout?.irDts,
    );
    // The stage's own ini tags replace the old file's tags: a tag removed from the stage and the mod leaves tags.d.ts.
    const stageNow = await backend.stageStatus(mod).catch(() => null);
    refreshTagsFile(ctx, [], { stagingPath: stageNow?.stagingPath ?? null });
    },
    { done: () => `Wrote ${files.size} stub file(s)` },
  );
  recordRun(paths.runsFile, { at: at(), step: "stubs.emit", seconds: (clock() - t2) / 1000, ok: true, units: files.size, mode: "cold" });

  output.info(`stubs written to ${profileDir}`, "ok");
  output.info(`  ${files.size} file(s), ${index.members} member(s), ${index.deprecated.length} blocked, ${index.overridden.length} overridden, ${index.opaque.length} opaque`);
  output.info(`  ${index.discovered.length} member(s) beyond class defaults (widgets, components, widget/component variables)`);
  output.info(`  hand-made assets: ${manual.length}`);
  output.json({
    dir: profileDir,
    files: index.files,
    members: index.members,
    opaque: index.opaque,
    modAssets: manual.map((m) => m.asset),
    full: run.full,
    reflected: run.classes.length,
    catalog: run.catalog === null ? null : { game: run.catalog.catalog.game.length, scriptClasses: run.catalog.catalog.scriptClasses.length },
    added: run.added,
    failed: failedFinal,
    notFound: run.notFound,
  });
  // A build that generates its stubs first ends with its own summary.
  if (run.mode !== "build") ctx.progress.summary(true, "Stubs generated", profileDir);
  return 0;
}

/**
 * Decides what the stubs of this project still need (catalog, cache, source imports, `--add`), reflects it and writes
 * `.abfc/stubs/<profile>/`. `explicit` is `abfc generate`, `add` is `abfc generate --add`, `build` is the generation at the start of a build.
 */
export async function generateStubs(ctx: CliContext, backend: Backend, mode: StubMode, opts: { used?: string[] } = {}): Promise<number> {
  const { config, env, output, deps, paths, args } = ctx;
  const flags = args.flags;
  const mod = config.mod.name;
  const profileDir = win32.join(paths.stubsDir, env.profile.id);
  const fingerprint = env.fingerprint ?? "";
  const at = (): string => deps.now().toISOString();
  const clock = (): number => performance.now();

  const info = await backend.info();
  if (!info.capabilities.reflect) {
    throw new AbfcError({
      severity: "error",
      code: "ABFC4011",
      message: `the backend at ${env.backendDir.value ?? "?"} has no "reflect" tool; abfc generate needs the abfc-p1-backend branch of abf-mod-editor-mcp.`,
      fix: "point ABFC_BACKEND_DIR at a checkout that provides reflect (see docs/backend.md).",
    });
  }
  const { resynced } = await ensureStage(backend, env, config, {
    resync: mode === "explicit" ? flags.resync : false,
    warn: (d) => output.diag(d),
    progress: ctx.progress,
  });
  if (resynced) await pruneManifestsToStage(ctx, backend, mod);

  // The class catalog of this editor build: the file when it is current, else from the backend.
  let catalog: { catalog: Catalog; sha256: string } | null = flags.refresh ? null : readCatalog(profileDir);
  if (catalog !== null && catalog.catalog.editorFingerprint !== fingerprint) catalog = null;
  if (catalog === null) {
    if (info.capabilities.catalog) {
      const tc = clock();
      const res = await ctx.progress.run("Reading the class catalog", () => backend.catalog(mod), {
        slowHint: SLOW_BACKEND_HINT,
        done: () => "Class catalog read",
      });
      const c = catalogFromBackend(res.data, fingerprint, at());
      catalog = { catalog: c, sha256: writeCatalog(profileDir, c) };
      const seconds = (clock() - tc) / 1000;
      output.info(
        `catalog: ${c.game.length} game classes, ${c.scriptClasses.length} engine classes, ${c.scriptStructs.length} structs, ${c.scriptEnums.length} enums (${seconds.toFixed(1)} s)`,
      );
      recordRun(paths.runsFile, { at: at(), step: "stubs.catalog", seconds, ok: true, units: c.game.length, mode: "cold" });
    } else if (mode !== "build") {
      output.diag({
        severity: "warning",
        code: "ABFC3021",
        message: 'the backend has no "catalog" tool: only the classes in stubs.classes and stubs.scriptClasses (and the profile defaults) get stubs.',
        fix: "update abf-mod-editor-mcp to 2.6.0 or newer.",
      });
    }
  }

  // The cache of the last run: valid for this editor build and generator (a backend without a catalog always reflects everything it is asked for).
  const cache = flags.refresh || catalog === null ? null : readStubCache(profileDir);
  const seed = cache !== null && cache.editorFingerprint === fingerprint && cache.generator === STUBGEN_VERSION ? cache : null;
  const full = catalog !== null && seed === null;
  const storedCoverage = seed === null ? null : readCoverage(profileDir);
  const coverage = seed === null ? null : (storedCoverage ?? coverageOf(seed.reflect, [], []));
  const oldLock = readLock(profileDir);
  const failed = seed === null ? [] : (oldLock?.auto?.failed ?? []);
  const req = resolveStubRequest({
    catalog: catalog?.catalog ?? null,
    reflected: new Set(coverage?.reflected ?? []),
    declared: new Set(coverage?.declared ?? []),
    defaults: env.profile.initScriptClasses,
    configClasses: config.stubs.classes,
    configScriptClasses: config.stubs.scriptClasses,
    widgetClasses: Object.values(config.stubs.widgetMembers).flatMap((m) => Object.values(m)),
    sourceImports: sourceStubImports(ctx.projectDir, config.sourceRoot),
    added: oldLock?.auto?.added ?? [],
    adds: flags.add,
    failed,
    used: opts.used ?? [],
    full,
  });
  for (const arg of req.notFound) {
    output.diag({
      severity: "warning",
      code: "ABFC3022",
      message: `${arg} is not a class, struct or enum of this editor build; nothing generated`,
      fix: "check the path; run abfc generate --refresh after a game update.",
    });
  }
  const classes = mode === "explicit" || full ? req.want.classes : req.missing.classes;
  const structs = mode === "explicit" || full ? req.want.structs : req.missing.structs;
  // Enums an earlier run declared stay declared even when no member references them.
  const lookup = catalog === null ? null : catalogLookup(catalog.catalog);
  const keptEnums = (coverage?.declared ?? []).filter((p) => lookup?.kindOf(p) === "enum");

  if (mode !== "explicit" && seed !== null && classes.length + structs.length === 0 && req.opaqueEnums.length === 0) {
    // A missing or corrupt coverage file would make every build start the backend again: rewrite it from the cache.
    if (storedCoverage === null && coverage !== null) writeFileAtomic(win32.join(profileDir, COVERAGE_FILE), JSON.stringify(coverage, null, 2) + "\n");
    output.info("stubs are up to date");
    output.json({
      dir: profileDir,
      upToDate: true,
      full: false,
      reflected: 0,
      catalog: catalog === null ? null : { game: catalog.catalog.game.length, scriptClasses: catalog.catalog.scriptClasses.length },
      added: req.added,
      failed,
      notFound: req.notFound,
    });
    if (mode !== "build") ctx.progress.summary(true, "Nothing to generate", profileDir);
    return 0;
  }
  if (full) {
    output.info(
      `stubs: generating stubs for ${classes.length} classes (${classes.filter((c) => c.startsWith("/Game/")).length} game classes) and the types they use; this runs once per Mod Editor build and takes about 3-4 minutes`,
    );
  }
  const tg = clock();
  const code = await reflectAndRead(ctx, backend, {
    mode,
    full,
    seed,
    readModAssets: mode === "explicit" || seed === null,
    classes,
    structs,
    castTargets: classes.filter((c) => c.startsWith("/Game/")),
    opaqueEnums: sortedUnique([...req.opaqueEnums, ...keptEnums]),
    userClasses: req.userClasses,
    catalog,
    failed,
    added: req.added,
    notFound: req.notFound,
  });
  if (full) output.info(`stubs: done in ${((clock() - tg) / 1000).toFixed(1)} s`);
  return code;
}

/** `abfc generate`: reflects the game's classes and mod assets through the backend and writes `.abfc/stubs/<profile>/`. */
export async function generate(ctx: CliContext): Promise<number> {
  const backend = await ctx.progress.run("Starting backend", () => ctx.deps.startBackend(ctx.env, backendStartOptions(ctx)), {
    slowHint: SLOW_BACKEND_HINT,
    done: () => "Backend started",
  });
  try {
    const code = await generateStubs(ctx, backend, ctx.args.flags.add.length > 0 ? "add" : "explicit");
    if (code !== 0) return code;
    const first = ctx.output.resultSoFar() as Record<string, unknown> | undefined;
    const u = await generateUsedPlaceholders(ctx, async () => backend, loadProgram(ctx.projectDir));
    if (u.rounds > 0 && first !== undefined) {
      ctx.output.json({
        ...(ctx.output.resultSoFar() as object),
        notFound: first.notFound,
        reflected: (first.reflected as number) + u.reflected,
        used: u.generated,
      });
    } else if (first !== undefined) {
      ctx.output.json({ ...first, used: [] });
    }
    return code;
  } finally {
    await backend.close();
  }
}

/** Upper bound of the scan -> generate -> reload rounds that generate the placeholder types the source uses. */
const MAX_USED_ROUNDS = 3;

/**
 * Generates the engine classes and structs the source uses while the stubs hold them only as placeholders (`@bpOpaque`): scans the program,
 * generates what is missing, reloads the program and scans again (newly generated members can reveal more placeholders), at most
 * {@link MAX_USED_ROUNDS} times. Starts no backend when the source uses no placeholder that can be generated.
 */
export async function generateUsedPlaceholders(
  ctx: CliContext,
  backendOf: () => Promise<Backend | null>,
  loaded: LoadedProgram,
): Promise<{ loaded: LoadedProgram; generated: string[]; reflected: number; rounds: number }> {
  let cur = loaded;
  const generated: string[] = [];
  let reflected = 0;
  let rounds = 0;
  while (rounds < MAX_USED_ROUNDS) {
    const want = usedPlaceholdersToGenerate(ctx, placeholderTypesUsed(cur)).filter((p) => !generated.includes(p));
    if (want.length === 0) break;
    const backend = await backendOf();
    if (backend === null) break;
    const names = `${want.slice(0, 5).map(shortName).join(", ")}${want.length > 5 ? ` and ${want.length - 5} more` : ""}`;
    ctx.output.info(`stubs: the source uses ${names} without generated members; generating ${want.length === 1 ? "it" : "them"}`);
    await generateStubs(ctx, backend, "build", { used: want });
    reflected += (ctx.output.resultSoFar() as { reflected?: number } | undefined)?.reflected ?? 0;
    generated.push(...want);
    cur = loadProgram(ctx.projectDir);
    rounds++;
  }
  return { loaded: cur, generated, reflected, rounds };
}

/**
 * Start of `abfc build`, `test` and `publish`: generates the stubs the project needs when the offline check says so (first build, a new
 * Mod Editor build, a new import of an engine or game name). A backend that cannot do it, or a failure, is a warning ABFC3020: the build
 * continues with the stubs there are, and the lock check that follows still stops it when they are unusable.
 */
export async function ensureStubsForBuild(ctx: CliContext, session: BackendSession, rec: Recorder): Promise<void> {
  const reason = stubsNeedWork(ctx);
  if (reason === null) return;
  const t0 = performance.now();
  const warn = (e: unknown): void =>
    ctx.output.diag({
      severity: "warning",
      code: "ABFC3020",
      message: `could not generate stubs (${reason}): ${e instanceof Error ? e.message : String(e)}; the build continues with the existing stubs`,
      fix: 'run "abfc generate" once the Mod Editor backend works.',
    });
  let opened: Awaited<ReturnType<BackendSession["open"]>>;
  try {
    opened = await session.open();
  } catch (e) {
    warn(e);
    return;
  }
  if (!opened.info.capabilities.reflect || !opened.info.capabilities.catalog) {
    // Remember it in the lock: later builds stay quiet (and do not start the backend for this) until the editor build or the backend changes.
    const lock = readLock(win32.join(ctx.paths.stubsDir, ctx.env.profile.id));
    if (lock !== null && (ctx.env.fingerprint === null || lock.editorFingerprint === ctx.env.fingerprint)) {
      writeLock(win32.join(ctx.paths.stubsDir, ctx.env.profile.id), {
        ...lock,
        auto: { catalogSha256: "", gameClasses: 0, failed: lock.auto?.failed ?? [], added: lock.auto?.added ?? [], noCatalog: backendIdOf(ctx.env) },
      });
      ctx.output.diag({
        severity: "warning",
        code: "ABFC3021",
        message: 'the backend has no "catalog" tool: stubs for engine and game classes are generated only for the classes in stubs.classes and stubs.scriptClasses.',
        fix: "update abf-mod-editor-mcp to 2.6.0 or newer, then run abfc generate (this is reported once).",
      });
    }
    return;
  }
  ctx.output.info(`stubs: ${reason}; generating them`);
  let ok = false;
  try {
    await generateStubs(ctx, opened.backend, "build");
    ok = true;
  } catch (e) {
    warn(e);
  } finally {
    rec.record("build.stubs", since(t0), ok);
  }
}

/**
 * Start of `abfc build`, `test` and `publish`, after {@link ensureStubsForBuild}: loads the program, and when it uses placeholder types
 * (`@bpOpaque`) the stubs can generate, generates them (see {@link generateUsedPlaceholders}). Returns the current program, so the build
 * compiles what it loaded here. A backend that cannot do it, or a failure, is a warning ABFC3020.
 */
export async function ensureUsedStubsForBuild(ctx: CliContext, session: BackendSession, rec: Recorder): Promise<LoadedProgram> {
  const loaded = loadProgram(ctx.projectDir);
  const t0 = performance.now();
  const warn = (e: unknown): void =>
    ctx.output.diag({
      severity: "warning",
      code: "ABFC3020",
      message: `could not generate stubs (the source uses placeholder types): ${e instanceof Error ? e.message : String(e)}; the build continues with the existing stubs`,
      fix: 'run "abfc generate" once the Mod Editor backend works.',
    });
  const backendOf = async (): Promise<Backend | null> => {
    try {
      const opened = await session.open();
      if (!opened.info.capabilities.reflect || !opened.info.capabilities.catalog) return null;
      return opened.backend;
    } catch (e) {
      warn(e);
      return null;
    }
  };
  try {
    const u = await generateUsedPlaceholders(ctx, backendOf, loaded);
    if (u.rounds > 0) rec.record("build.usedStubs", since(t0), true);
    return u.loaded;
  } catch (e) {
    warn(e);
    rec.record("build.usedStubs", since(t0), false);
    // The stubs may have changed partially before the failure.
    return loadProgram(ctx.projectDir);
  }
}
