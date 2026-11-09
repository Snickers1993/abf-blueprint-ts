import { existsSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { DEFAULT_CLASS_MANAGER_TABLE, DEFAULT_SOURCE_ROOT, joinModPath, modRelativeProblem } from "@abfc/ir";
import { getEnv } from "./discover.js";
import { envError } from "./errors.js";
import { USER_CONFIG_LABEL } from "./settings.js";

/** The config schema this abfc reads and writes (docs/design.md 18.4). */
export const CONFIG_SCHEMA_VERSION = 2;

export interface ProjectConfig {
  /** 1 when the file has no `schemaVersion`. */
  schemaVersion: number;
  mod: { name: string; dir?: string };
  /** Project-relative folder that holds the class files; asset paths derive from it. */
  sourceRoot: string;
  classManager: {
    /** Mod-relative package folder of the class-manager rows. */
    table: string;
  };
  stubs: {
    classes: string[];
    scriptClasses: string[];
    modAssets: "all" | string[];
    scriptModules?: string[];
    /**
     * Designer widgets of Widget Blueprints that cannot be read from an export (those under /Game): class path ->
     * { member name -> widget class path }, e.g. `{ "/Game/UI/W_Hud.W_Hud_C": { "TitleText": "/Script/UMG.TextBlock" } }`.
     *
     * @deprecated members are found by abfc generate; kept for old configs.
     */
    widgetMembers: Record<string, Record<string, string>>;
  };
  backend: { kind: "bp_apply"; minProtocol: number; serverDir?: string; python?: string };
  editor?: { root?: string };
  headlessDir?: string;
  modsDir?: string;
  /**
   * `true`: a build refuses (ABFC5019) to remove or replace what was made by hand in the Mod Editor (hand-made nodes, functions,
   * variables, events, and edits of abfc's own nodes) instead of replacing it with a warning (ABFC5014). `abfc build
   * --replace-editor-edits` lets one build replace them. Default false (TypeScript wins).
   */
  protectEditorEdits?: boolean;
}

export const PROJECT_CONFIG_FILE = "abf.config.json";

export interface ConfigFiles {
  exists(p: string): boolean;
  readFile(p: string): string;
}

const nodeFiles: ConfigFiles = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
};

type Obj = Record<string, unknown>;

function fail(file: string, path: string, problem: string): never {
  throw envError(
    1021,
    `${file} is invalid at ${path}: ${problem}.`,
    [{ source: file, detail: `${path}: ${problem}` }],
    `fix "${path}" in ${file} (UTF-8 JSON).`,
  );
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    return fail(file, "$", `not valid JSON (${(e as Error).message})`);
  }
}

function asObj(file: string, path: string, v: unknown): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(file, path, "expected an object");
  return v as Obj;
}

function optStr(file: string, o: Obj, key: string, path: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") return fail(file, `${path}${key}`, "expected a non-empty string");
  return v;
}

function strArray(file: string, o: Obj, key: string, path: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return fail(file, `${path}${key}`, "expected an array of strings");
  return v as string[];
}

const WIDGET_MEMBERS_SHAPE = "expected an object of class path -> { member: widget class path }";

function widgetMembers(file: string, v: unknown): Record<string, Record<string, string>> {
  if (v === undefined) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [cls, members] of Object.entries(asObjShape(file, v))) {
    const inner: Record<string, string> = {};
    for (const [member, widget] of Object.entries(asObjShape(file, members))) {
      if (typeof widget !== "string" || !widget.startsWith("/Script/")) return fail(file, `stubs.widgetMembers.${cls}.${member}`, 'expected a widget class path such as "/Script/UMG.TextBlock"');
      inner[member] = widget;
    }
    out[cls] = inner;
  }
  return out;
}

function asObjShape(file: string, v: unknown): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(file, "stubs.widgetMembers", WIDGET_MEMBERS_SHAPE);
  return v as Obj;
}

function parseConfig(file: string, raw: unknown, partial: boolean): Partial<ProjectConfig> {
  const root = asObj(file, "$", raw);
  const out: Partial<ProjectConfig> = {};

  let schemaVersion = 1;
  if (root.schemaVersion !== undefined) {
    const v = root.schemaVersion;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fail(file, "schemaVersion", "expected a positive integer");
    schemaVersion = v as number;
    if (schemaVersion > CONFIG_SCHEMA_VERSION) {
      throw envError(
        1022,
        `${file} was written by a newer abfc (schema ${schemaVersion}); this abfc reads schema ${CONFIG_SCHEMA_VERSION} or older.`,
        [{ source: file, detail: `schemaVersion = ${schemaVersion}` }],
        "update abfc.",
      );
    }
    out.schemaVersion = schemaVersion;
  } else if (!partial) {
    out.schemaVersion = 1;
  }

  if (root.mod !== undefined || !partial) {
    const m = asObj(file, "mod", root.mod);
    const name = m.name;
    // The user config may carry just `mod.dir`; the name is only required (and only read) from the project config.
    const nameOptional = partial && name === undefined;
    if (!nameOptional && (typeof name !== "string" || name === "")) fail(file, "mod.name", "expected a non-empty string");
    const mod = (nameOptional ? {} : { name: name as string }) as ProjectConfig["mod"];
    const dir = optStr(file, m, "dir", "mod.");
    if (dir !== undefined) mod.dir = dir;
    out.mod = mod;
  }

  if (root.sourceRoot !== undefined || !partial) {
    const sr = optStr(file, root, "sourceRoot", "") ?? DEFAULT_SOURCE_ROOT;
    if (win32.isAbsolute(sr) || sr.startsWith("/")) fail(file, "sourceRoot", "expected a project-relative folder, not an absolute path");
    if (sr.split(/[\\/]/).includes("..")) fail(file, "sourceRoot", 'a ".." segment is not allowed');
    out.sourceRoot = sr;
  }

  if (root.classManager !== undefined || !partial) {
    const cm = root.classManager === undefined ? {} : asObj(file, "classManager", root.classManager);
    const table = optStr(file, cm, "table", "classManager.") ?? DEFAULT_CLASS_MANAGER_TABLE;
    const problem = modRelativeProblem(table);
    if (problem !== null) fail(file, "classManager.table", problem);
    out.classManager = { table };
  }

  if (root.stubs !== undefined) {
    const s = asObj(file, "stubs", root.stubs);
    const modAssets = s.modAssets;
    if (modAssets !== undefined && modAssets !== "all" && (!Array.isArray(modAssets) || modAssets.some((x) => typeof x !== "string"))) {
      fail(file, "stubs.modAssets", 'expected "all" or an array of strings');
    }
    let modAssetList = modAssets as "all" | string[] | undefined;
    if (Array.isArray(modAssetList) && schemaVersion >= 2) {
      const modName = out.mod?.name;
      modAssetList = modAssetList.map((entry, i) => {
        if (entry.startsWith("/")) fail(file, `stubs.modAssets[${i}]`, 'write mod-relative paths such as "Relays/BP_X"');
        const problem = modRelativeProblem(entry);
        if (problem !== null) fail(file, `stubs.modAssets[${i}]`, problem);
        // The user config carries no mod name; its relative entries stay as written.
        return modName === undefined ? entry : joinModPath(modName, entry);
      });
    }
    const stubs: ProjectConfig["stubs"] = {
      classes: strArray(file, s, "classes", "stubs.") ?? [],
      scriptClasses: strArray(file, s, "scriptClasses", "stubs.") ?? [],
      modAssets: modAssetList ?? "all",
      widgetMembers: widgetMembers(file, s.widgetMembers),
    };
    const scriptModules = strArray(file, s, "scriptModules", "stubs.");
    if (scriptModules !== undefined) stubs.scriptModules = scriptModules;
    out.stubs = stubs;
  } else if (!partial) {
    out.stubs = { classes: [], scriptClasses: [], modAssets: "all", widgetMembers: {} };
  }

  if (root.backend !== undefined) {
    const b = asObj(file, "backend", root.backend);
    const kind = b.kind ?? "bp_apply";
    if (kind !== "bp_apply") fail(file, "backend.kind", 'only "bp_apply" is supported');
    const minProtocol = b.minProtocol ?? 1;
    if (typeof minProtocol !== "number" || !Number.isInteger(minProtocol) || minProtocol < 1) {
      fail(file, "backend.minProtocol", "expected a positive integer");
    }
    const backend: ProjectConfig["backend"] = { kind: "bp_apply", minProtocol: minProtocol as number };
    const serverDir = optStr(file, b, "serverDir", "backend.");
    if (serverDir !== undefined) backend.serverDir = serverDir;
    const python = optStr(file, b, "python", "backend.");
    if (python !== undefined) backend.python = python;
    out.backend = backend;
  } else if (!partial) {
    out.backend = { kind: "bp_apply", minProtocol: 1 };
  }

  if (root.editor !== undefined) {
    const e = asObj(file, "editor", root.editor);
    const editor: NonNullable<ProjectConfig["editor"]> = {};
    const r = optStr(file, e, "root", "editor.");
    if (r !== undefined) editor.root = r;
    out.editor = editor;
  }
  const headlessDir = optStr(file, root, "headlessDir", "");
  if (headlessDir !== undefined) out.headlessDir = headlessDir;
  const modsDir = optStr(file, root, "modsDir", "");
  if (modsDir !== undefined) out.modsDir = modsDir;
  if (root.protectEditorEdits !== undefined) {
    if (typeof root.protectEditorEdits !== "boolean") fail(file, "protectEditorEdits", "expected true or false");
    out.protectEditorEdits = root.protectEditorEdits as boolean;
  }
  return out;
}

/** Reads `<projectDir>/abf.config.json` (UTF-8, BOM tolerated). ABFC1021 when missing or invalid. */
export function loadProjectConfig(projectDir: string, files: ConfigFiles = nodeFiles): ProjectConfig {
  const file = join(projectDir, PROJECT_CONFIG_FILE);
  if (!files.exists(file)) {
    throw envError(
      1021,
      `${PROJECT_CONFIG_FILE} not found in ${projectDir}.`,
      [{ source: PROJECT_CONFIG_FILE, detail: `no file at ${file}` }],
      `create ${PROJECT_CONFIG_FILE} with at least {"mod": {"name": "<your mod>"}}.`,
    );
  }
  return parseConfig(PROJECT_CONFIG_FILE, parseJson(PROJECT_CONFIG_FILE, files.readFile(file)), false) as ProjectConfig;
}

/**
 * The user config file: a non-empty `ABFC_USER_CONFIG` wins, else `%APPDATA%\abfc\config.json`, else null.
 * The file need not exist.
 */
export function userConfigFile(env: NodeJS.ProcessEnv): string | null {
  const override = getEnv(env, "ABFC_USER_CONFIG");
  if (override !== undefined && override !== "") return override;
  const appData = getEnv(env, "APPDATA");
  if (appData === undefined || appData === "") return null;
  return join(appData, "abfc", "config.json");
}

/** Reads the user config ({@link userConfigFile}); null when there is none or the file does not exist. */
export function loadUserConfig(env: NodeJS.ProcessEnv, files: ConfigFiles = nodeFiles): Partial<ProjectConfig> | null {
  const file = userConfigFile(env);
  if (file === null) return null;
  if (!files.exists(file)) return null;
  const label = getEnv(env, "ABFC_USER_CONFIG") ? file : USER_CONFIG_LABEL;
  return parseConfig(label, parseJson(label, files.readFile(file)), true);
}

/** Machine-specific keys that should live in the user config, not the (committed) project config. */
export function machineKeysInProject(cfg: Partial<ProjectConfig>): string[] {
  const keys: string[] = [];
  if (cfg.editor?.root !== undefined) keys.push("editor.root");
  if (cfg.modsDir !== undefined) keys.push("modsDir");
  if (cfg.headlessDir !== undefined) keys.push("headlessDir");
  if (cfg.mod?.dir !== undefined) keys.push("mod.dir");
  if (cfg.backend?.serverDir !== undefined) keys.push("backend.serverDir");
  if (cfg.backend?.python !== undefined) keys.push("backend.python");
  return keys;
}
