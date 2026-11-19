import type { Diagnostic, Profile } from "@abfc/ir";
import { loadProjectConfig, loadUserConfig } from "./config.js";
import type { ProjectConfig } from "./config.js";
import {
  checkHeadlessDir,
  checkNode,
  findBackendDir,
  findDocuments,
  findEditorRoot,
  findHeadlessDir,
  findModDir,
  findModsDir,
  findPython,
} from "./discover.js";
import type { Host } from "./discover.js";
import { AbfcError, envWarning } from "./errors.js";
import { editorFingerprints } from "./fingerprint.js";
import { loadProfile, profileForBuild } from "./profile.js";
import { assertNotInModFolder } from "./project.js";
import type { Resolved } from "./settings.js";

export type FlagName = "editorRoot" | "modsDir" | "modDir" | "backendDir" | "python" | "headlessDir";

export interface Environment {
  projectDir: string;
  config: ProjectConfig;
  userConfig: Partial<ProjectConfig> | null;
  profile: Profile;
  documents: Resolved<string>;
  editorRoot: Resolved<string>;
  modsDir: Resolved<string>;
  modDir: Resolved<string>;
  python: Resolved<string> & { version: string | null };
  backendDir: Resolved<string>;
  headlessDir: Resolved<string>;
  /** Epic manifest `AppVersionString` of the editor install, when known. */
  appVersion: string | null;
  fingerprint: string | null;
  /** Fingerprints earlier abfc versions recorded for the same editor build ({@link sameEditorBuild}). */
  fingerprintAliases: string[];
  /** Warnings and errors collected on the way; nothing is thrown except ABFC1020 and ABFC1021. */
  diagnostics: Diagnostic[];
}

function failed<T>(e: unknown, diagnostics: Diagnostic[]): Resolved<T> {
  if (e instanceof AbfcError) {
    diagnostics.push(e.diagnostic);
    return { value: null, source: "none", tried: e.diagnostic.tried ?? [] };
  }
  throw e;
}

export function resolveEnvironment(
  host: Host,
  opts: { projectDir: string; flags: Partial<Record<FlagName, string>> },
): Environment {
  const diagnostics: Diagnostic[] = [];
  const { flags } = opts;

  assertNotInModFolder(host, opts.projectDir);
  let config = loadProjectConfig(opts.projectDir, host);
  const userConfig = loadUserConfig(host.env, host);
  if (config.schemaVersion < 2) {
    diagnostics.push(envWarning(1031, "abf.config.json uses schema 1.", [], 'run "abfc init" in the project to upgrade it (a backup is kept).'));
  }

  const nodeDiag = checkNode(host);
  if (nodeDiag) diagnostics.push(nodeDiag);

  // The default profile drives discovery; the detected build then picks the real one.
  const defaultProfile = loadProfile();

  let documents: Resolved<string>;
  try {
    documents = findDocuments(host);
  } catch (e) {
    documents = failed<string>(e, diagnostics);
  }

  let editorRoot: Resolved<string>;
  let appVersion: string | null = null;
  try {
    const r = findEditorRoot(host, defaultProfile, flags.editorRoot, config.editor?.root, userConfig?.editor?.root);
    appVersion = r.appVersion;
    editorRoot = r;
  } catch (e) {
    editorRoot = failed<string>(e, diagnostics);
  }

  let profile = defaultProfile;
  const matched = profileForBuild(appVersion);
  if (matched) {
    profile = matched;
  } else if (appVersion !== null) {
    diagnostics.push({
      severity: "error",
      code: "ABFC3002",
      message: `no abfc profile for the detected editor build "${appVersion}".`,
      tried: [{ source: "profiles", detail: `known build tags: ${defaultProfile.buildTag}` }],
      fix: "update abfc, or run abfc doctor to see which editor build was detected.",
    });
  }

  let modsDir: Resolved<string>;
  try {
    modsDir = findModsDir(host, profile, documents, flags.modsDir, config.modsDir, userConfig?.modsDir);
  } catch (e) {
    modsDir = failed<string>(e, diagnostics);
  }

  let modDir: Resolved<string>;
  try {
    modDir = findModDir(host, modsDir.value, config.mod.name, flags.modDir, config.mod.dir, userConfig?.mod?.dir);
  } catch (e) {
    modDir = failed<string>(e, diagnostics);
  }

  // Windows finds the mod folder in any letter case, but the backend's stage folder, the Unreal mount paths and
  // abfc's manifests use the name as text: use the spelling of the mod's plugin file.
  if (modDir.value !== null) {
    let entries: string[] = [];
    try {
      entries = host.readDir(modDir.value);
    } catch {
      entries = [];
    }
    const wanted = `${config.mod.name}.uplugin`.toLowerCase();
    const plugin = entries.find((n) => n.toLowerCase() === wanted);
    if (plugin !== undefined) {
      const onDisk = plugin.slice(0, -".uplugin".length);
      if (onDisk !== config.mod.name) {
        diagnostics.push(
          envWarning(
            1045,
            `mod.name "${config.mod.name}" differs in case from the mod's plugin "${onDisk}"; using "${onDisk}".`,
            [],
            `write "mod": {"name": "${onDisk}"} in abf.config.json.`,
          ),
        );
        config = { ...config, mod: { ...config.mod, name: onDisk } };
      }
    }
  }

  let python: Resolved<string> & { version: string | null };
  try {
    python = findPython(host, flags.python, config.backend.python, userConfig?.backend?.python);
  } catch (e) {
    python = { ...failed<string>(e, diagnostics), version: null };
  }

  let backendDir: Resolved<string>;
  try {
    backendDir = findBackendDir(host, flags.backendDir, config.backend.serverDir, userConfig?.backend?.serverDir);
  } catch (e) {
    backendDir = failed<string>(e, diagnostics);
  }

  const headlessDir = findHeadlessDir(host, profile, flags.headlessDir, config.headlessDir, userConfig?.headlessDir);
  if (headlessDir.value !== null) {
    const d = checkHeadlessDir(headlessDir.value);
    if (d) diagnostics.push(d);
  }

  let fingerprint: string | null = null;
  let fingerprintAliases: string[] = [];
  if (editorRoot.value !== null) {
    try {
      [fingerprint, ...fingerprintAliases] = editorFingerprints(host, editorRoot.value, profile, appVersion) as [string, ...string[]];
    } catch (e) {
      failed<string>(e, diagnostics);
    }
  }

  if (config.stubs.scriptModules !== undefined && config.stubs.scriptModules.length > 0) {
    diagnostics.push(
      envWarning(
        3010,
        '"stubs.scriptModules" is ignored in Phase 1 (whole-module reflection is too slow); list classes in "stubs.scriptClasses".',
        [],
        'move the classes you need into "stubs.scriptClasses".',
      ),
    );
  }

  return {
    projectDir: opts.projectDir,
    config,
    userConfig,
    profile,
    documents,
    editorRoot,
    modsDir,
    modDir,
    python,
    backendDir,
    headlessDir,
    appVersion,
    fingerprint,
    fingerprintAliases,
    diagnostics,
  };
}
