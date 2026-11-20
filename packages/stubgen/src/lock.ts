// stubs.lock.json: which editor build the stubs were generated for (design 5.3).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { profileForBuild, sameEditorBuild } from "@abfc/env";
import type { Environment, ProjectConfig } from "@abfc/env";
import type { Diagnostic } from "@abfc/ir";
import { STUBGEN_VERSION } from "./manual.js";
import { writeFileAtomic } from "./store.js";

/** What the automatic class set covers (`abfc generate` / the first build). Not part of `stubLockHashOf`. */
export interface AutoStubs {
  /** sha256 of `_catalog.json` the stubs were generated from. */
  catalogSha256: string;
  /** Number of game classes in the catalog. */
  gameClasses: number;
  /** Classes the backend could not reflect; skipped until `--add`, `--refresh` or a new editor build. */
  failed: string[];
  /** Classes added on demand (`--add`, quick fix) that stay in every later run. */
  added: string[];
  /**
   * Set when the backend that generated (or last looked at) these stubs has no `catalog` tool: the id of that backend. A build then
   * does not start the backend again to look for the tool until the editor build or the backend changes.
   */
  noCatalog?: string;
}

export interface StubsLock {
  generator: string;
  profile: string;
  engineVersion: string | null;
  modEditorVersion: string;
  editorFingerprint: string;
  filterContentVersion: string | null;
  classes: string[];
  scriptClasses: string[];
  modAssets: string[];
  /** `stubs.widgetMembers` the stubs were generated with (keys sorted). */
  widgetMembers?: Record<string, Record<string, string>>;
  /** Absent for stubs without a catalog (legacy locks, backends without the `catalog` tool). */
  auto?: AutoStubs;
  createdAt: string;
}

/** The config's `stubs.widgetMembers` with every key sorted, so equal configs compare and serialize equal. */
export function sortedWidgetMembers(m: Record<string, Record<string, string>> | undefined): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const cls of Object.keys(m ?? {}).sort()) {
    const inner: Record<string, string> = {};
    for (const k of Object.keys(m?.[cls] ?? {}).sort()) inner[k] = m![cls]![k]!;
    out[cls] = inner;
  }
  return out;
}

export const LOCK_FILE = "stubs.lock.json";

/** `stubsDir` is the profile folder, `.abfc/stubs/<profile>`. */
export function lockPath(stubsDir: string): string {
  return join(stubsDir, LOCK_FILE);
}

export function readLock(stubsDir: string): StubsLock | null {
  const file = lockPath(stubsDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as StubsLock;
  } catch {
    return null;
  }
}

export function writeLock(stubsDir: string, lock: StubsLock): void {
  mkdirSync(stubsDir, { recursive: true });
  writeFileAtomic(lockPath(stubsDir), JSON.stringify(lock, null, 2) + "\n");
}

export function newLock(
  fields: Omit<StubsLock, "generator" | "createdAt"> & { createdAt: string },
): StubsLock {
  return { generator: STUBGEN_VERSION, ...fields };
}

/**
 * Compares the lock with the installed editor and the config. `mode` decides the severity of a fingerprint change:
 * an error for `build`, a warning for `check`.
 */
export function checkLock(lock: StubsLock | null, env: Environment, config: ProjectConfig, mode: "check" | "build"): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (lock === null) {
    out.push({
      severity: "error",
      code: "ABFC3003",
      message: "stubs are missing: no stubs.lock.json for this editor build.",
      fix: 'run "abfc generate" (abfc build also generates them).',
    });
    return out;
  }
  const detected = env.appVersion;
  if (detected !== null && profileForBuild(detected) === null) {
    out.push({
      severity: "error",
      code: "ABFC3002",
      message: `abfc ${STUBGEN_VERSION} supports Mod Editor build ${env.profile.id} only; found ${detected}.`,
      fix: "update abfc, or wait for a release with a profile for this build.",
    });
  } else if (lock.profile !== env.profile.id) {
    out.push({
      severity: "error",
      code: "ABFC3002",
      message: `stubs were generated for profile ${lock.profile} but abfc uses ${env.profile.id}.`,
      fix: 'run "abfc generate" to regenerate.',
    });
  }
  if (!sameEditorBuild(env, lock.editorFingerprint)) {
    out.push({
      severity: mode === "build" ? "error" : "warning",
      code: "ABFC3001",
      message:
        `stubs were generated for Mod Editor ${lock.profile} (${lock.modEditorVersion}) but the installed editor is ` +
        `${detected ?? env.profile.id} (${env.profile.modEditorVersion}). Run "abfc generate" to regenerate.`,
      fix: 'run "abfc generate".',
    });
  }
  if (lock.generator !== STUBGEN_VERSION) {
    // Stubs of an older generator keep their old shapes (function defaults, the tags file, the tsconfig paths): a warning, never a block.
    out.push({
      severity: "warning",
      code: "ABFC3001",
      message: `the stubs were generated by abfc generate ${lock.generator ?? "an unknown version"} but this abfc generates ${STUBGEN_VERSION}; they may lack newer features (default arguments, gameplay tags). Run "abfc generate" to regenerate.`,
      fix: 'run "abfc generate".',
    });
  }
  const covered = new Set([...lock.classes, ...lock.scriptClasses]);
  const missing = [...config.stubs.classes, ...config.stubs.scriptClasses].filter((c) => !covered.has(c));
  if (missing.length > 0) {
    out.push({
      severity: "warning",
      code: "ABFC3003",
      message: `the stubs do not cover: ${missing.join(", ")}.`,
      fix: 'run "abfc generate" to regenerate.',
    });
  }
  if (JSON.stringify(sortedWidgetMembers(lock.widgetMembers)) !== JSON.stringify(sortedWidgetMembers(config.stubs.widgetMembers))) {
    out.push({
      severity: "warning",
      code: "ABFC3003",
      message: "stubs.widgetMembers changed since the stubs were generated.",
      fix: 'run "abfc generate" to regenerate.',
    });
  }
  return out;
}
