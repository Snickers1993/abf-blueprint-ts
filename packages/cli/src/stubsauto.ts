// What the automatic stub set has to hold, decided from the catalog, the profile's default set, the config and the source imports.
// No class tables here: every list comes from those inputs. Used by `abfc generate` (commands/generate.ts) and by `abfc build` to decide,
// without opening the backend, whether stubs have to be generated first.
import { win32 } from "node:path";
import { sourceStubImports } from "@abfc/compiler";
import { sameEditorBuild } from "@abfc/env";
import { sha256 } from "@abfc/ir";
import type { StubImport } from "@abfc/compiler";
import { catalogLookup, readCatalog, readCoverage, readLock } from "@abfc/stubgen";
import type { Catalog } from "@abfc/stubgen";
import type { CliContext } from "./context.js";

/** `explicit`: `abfc generate`; `add`: `abfc generate --add ...`; `build`: generation at the start of build, test and publish. */
export type StubMode = "explicit" | "build" | "add";

export interface StubRequestInput {
  /** The class catalog of this editor build; null for a backend without the `catalog` tool. */
  catalog: Catalog | null;
  /** Classes (with members) and structs the stubs already hold. */
  reflected: ReadonlySet<string>;
  /** `reflected` plus cast-only classes and opaque types (an opaque enum counts as complete). */
  declared: ReadonlySet<string>;
  /** `profile.initScriptClasses`: always part of the set. */
  defaults: string[];
  configClasses: string[];
  configScriptClasses: string[];
  /** The widget classes of `stubs.widgetMembers`. */
  widgetClasses: string[];
  sourceImports: StubImport[];
  /** Earlier on-demand additions (`lock.auto.added`), kept in every run. */
  added: string[];
  /** The `--add` arguments of this run. */
  adds: string[];
  /** `lock.auto.failed`: classes skipped until `--add`, `--refresh` or a new editor build. */
  failed: string[];
  /** Placeholder classes and structs the source uses (program scan); generated and kept in added unless they failed before. */
  used: string[];
  /** Every game class of the catalog is wanted (no valid cache). */
  full: boolean;
}

export interface StubRequest {
  want: { classes: string[]; structs: string[] };
  /** `want` minus what is already reflected. */
  missing: { classes: string[]; structs: string[] };
  /** Imported or added enums that are not declared yet. */
  opaqueEnums: string[];
  /** Classes whose cast pin is worth a warning when it is missing: the config's and the imported or added /Game classes. */
  userClasses: string[];
  /** Earlier additions plus the ones of this run, sorted. */
  added: string[];
  /** `--add` arguments that stand for nothing in the catalog. */
  notFound: string[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(byText);

export function resolveStubRequest(i: StubRequestInput): StubRequest {
  const lookup = i.catalog === null ? null : catalogLookup(i.catalog);
  const classes = new Set<string>();
  const structs = new Set<string>();
  const enums = new Set<string>();
  const userGame = new Set<string>();
  const resolvedAdds = new Set<string>();
  const added = new Set<string>();
  const notFound: string[] = [];

  /** Puts a catalog path where its kind says (a path the catalog does not know counts as a class). */
  const place = (path: string, user: boolean): void => {
    const kind = lookup?.kindOf(path);
    if (kind === "struct") structs.add(path);
    else if (kind === "enum") enums.add(path);
    else {
      classes.add(path);
      if (user && path.startsWith("/Game/")) userGame.add(path);
    }
  };

  if (i.full && i.catalog !== null) for (const g of i.catalog.game) classes.add(g.path);
  for (const p of [...i.defaults, ...i.configClasses, ...i.configScriptClasses, ...i.widgetClasses]) classes.add(p);

  if (lookup !== null) {
    for (const imp of i.sourceImports) {
      if (imp.specifier.startsWith("/Script/")) {
        for (const name of imp.names) {
          const p = lookup.resolveImport(imp.specifier, name);
          if (p !== undefined) place(p, false);
        }
      } else if (imp.specifier.startsWith("/Game/")) {
        const paths =
          imp.names.length > 0
            ? imp.names.flatMap((name) => {
                const p = lookup.resolveImport(imp.specifier, name);
                return p === undefined ? [] : [p];
              })
            : lookup.gameClassesOf(imp.specifier);
        for (const p of paths) place(p, true);
      }
      // An import the catalog does not know is left to TypeScript, which reports it.
    }
  }

  for (const p of i.added) {
    if (lookup !== null && lookup.kindOf(p) === undefined) continue; // gone with an editor update
    place(p, true);
    added.add(p);
  }
  for (const arg of i.adds) {
    const paths = lookup === null ? [arg] : lookup.resolveAdd(arg);
    if (paths.length === 0) {
      notFound.push(arg);
      continue;
    }
    for (const p of paths) {
      place(p, true);
      resolvedAdds.add(p);
      added.add(p);
    }
  }

  const failedSet = new Set(i.failed);
  for (const p of i.used) {
    if (failedSet.has(p)) continue;
    if (lookup !== null && lookup.kindOf(p) === undefined) continue;
    place(p, false);
    added.add(p);
  }

  for (const p of i.failed) {
    if (resolvedAdds.has(p)) continue;
    classes.delete(p);
    structs.delete(p);
  }

  const wantClasses = sortedUnique(classes);
  const wantStructs = sortedUnique(structs);
  return {
    want: { classes: wantClasses, structs: wantStructs },
    missing: {
      classes: wantClasses.filter((p) => !i.reflected.has(p)),
      structs: wantStructs.filter((p) => !i.reflected.has(p)),
    },
    opaqueEnums: sortedUnique([...enums].filter((p) => !i.declared.has(p))),
    userClasses: sortedUnique([...i.configClasses, ...userGame]),
    added: sortedUnique(added),
    notFound,
  };
}

/** `Name` of `/Script/Pkg.Name` and `BP_X_C` of `/Game/a/BP_X.BP_X_C`, for messages. */
export const shortName = (path: string): string => path.slice(path.lastIndexOf(".") + 1);

/** Identifies the backend a lock's `auto.noCatalog` was recorded for (a digest of its folder, so no path is stored). */
export function backendIdOf(env: CliContext["env"]): string {
  return sha256(env.backendDir.value ?? "").slice(0, 16);
}

/**
 * The placeholder classes and structs (`used`, from the program scan) that still have to be generated, decided offline:
 * not failed before, not reflected yet, and known to the catalog of this editor build. Returns `[]` without a lock with `auto`
 * (the `stubsNeedWork` path handles the first generation), without a usable catalog, or when no catalog tool was found.
 */
export function usedPlaceholdersToGenerate(ctx: CliContext, used: readonly string[]): string[] {
  if (used.length === 0) return [];
  const { env, paths } = ctx;
  const profileDir = win32.join(paths.stubsDir, env.profile.id);
  const lock = readLock(profileDir);
  if (lock === null || lock.auto === undefined) return [];
  if (lock.auto.noCatalog !== undefined && lock.auto.noCatalog === backendIdOf(env)) return [];
  const failed = new Set(lock.auto.failed);
  const candidates = used.filter((p) => !failed.has(p));
  if (candidates.length === 0) return [];
  const coverage = readCoverage(profileDir);
  if (coverage === null) return [];
  const reflected = new Set(coverage.reflected);
  const open = candidates.filter((p) => !reflected.has(p));
  if (open.length === 0) return [];
  const catalog = readCatalog(profileDir);
  if (catalog === null || !sameEditorBuild(env, catalog.catalog.editorFingerprint)) return [];
  const lookup = catalogLookup(catalog.catalog);
  return sortedUnique(
    open.filter((p) => {
      const kind = lookup.kindOf(p);
      return kind === "class" || kind === "game" || kind === "struct";
    }),
  );
}

/**
 * Whether the stubs of this project have to be generated before a build, decided offline (lock, catalog, coverage and the source
 * imports only). Returns the reason, or null when the stubs are complete for this editor build and this source.
 */
export function stubsNeedWork(ctx: CliContext): string | null {
  const { env, config, paths, projectDir } = ctx;
  const profileDir = win32.join(paths.stubsDir, env.profile.id);
  const lock = readLock(profileDir);
  if (lock === null) return "no stubs yet";
  if (!sameEditorBuild(env, lock.editorFingerprint)) return "the Mod Editor build changed";
  // A backend without the catalog tool was found for these stubs: nothing can be generated automatically, so the build stays as it was.
  if (lock.auto?.noCatalog !== undefined && lock.auto.noCatalog === backendIdOf(env)) return null;
  if (lock.auto === undefined) return "the stubs do not cover every game class yet";
  const catalog = readCatalog(profileDir);
  if (catalog === null || !sameEditorBuild(env, catalog.catalog.editorFingerprint)) return "no class catalog for this editor build";
  const coverage = readCoverage(profileDir);
  if (coverage === null) return "the stub coverage file is missing";
  const req = resolveStubRequest({
    catalog: catalog.catalog,
    reflected: new Set(coverage.reflected),
    declared: new Set(coverage.declared),
    defaults: env.profile.initScriptClasses,
    configClasses: config.stubs.classes,
    configScriptClasses: config.stubs.scriptClasses,
    widgetClasses: Object.values(config.stubs.widgetMembers).flatMap((m) => Object.values(m)),
    sourceImports: sourceStubImports(projectDir, config.sourceRoot),
    added: lock.auto.added,
    adds: [],
    failed: lock.auto.failed,
    used: [],
    full: false,
  });
  const names = [...req.missing.classes, ...req.missing.structs, ...req.opaqueEnums];
  if (names.length === 0) return null;
  const shown = names.slice(0, 5).map(shortName).join(", ");
  return `missing stubs for ${shown}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
}
