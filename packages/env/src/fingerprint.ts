import { win32 } from "node:path";
import { sha256 } from "@abfc/ir";
import type { Profile } from "@abfc/ir";
import { envError } from "./errors.js";
import type { Host } from "./discover.js";

/**
 * `sha256(size|mtime|)` of the editor exe: the build abfc's stubs and caches were made with. The Epic manifest's `AppVersionString`
 * is not part of it: the launcher rewrites that manifest when the editor is opened, so the version can appear (or change its
 * spelling) without the editor changing, and every such change used to regenerate all stubs (about 50 minutes on one project).
 * An update of the editor changes the exe, and with it the fingerprint.
 */
export function editorFingerprint(host: Host, editorRoot: string, profile: Profile, _appVersion: string | null): string {
  return editorFingerprints(host, editorRoot, profile, _appVersion)[0]!;
}

/**
 * The fingerprint first, then the fingerprints earlier abfc versions recorded for the same exe: `sha256(size|mtime|appVersion)`
 * when a version is known. Stubs, catalogs and caches recorded under any of them belong to this editor build.
 */
export function editorFingerprints(host: Host, editorRoot: string, profile: Profile, appVersion: string | null): string[] {
  const exe = win32.join(editorRoot, profile.exeRelPath);
  const st = host.stat(exe);
  if (!st) {
    throw envError(
      1001,
      `${profile.editorDisplayName} executable not found.`,
      [{ source: "editor exe", detail: exe }],
      "reinstall the Mod Editor or fix the editor root.",
    );
  }
  const base = `${st.size}|${Math.trunc(st.mtimeMs)}|`;
  return appVersion !== null && appVersion !== "" ? [sha256(base), sha256(base + appVersion)] : [sha256(base)];
}

/** Whether a fingerprint recorded in a lock, catalog or cache belongs to the editor build `env` found (true when none was found). */
export function sameEditorBuild(env: { fingerprint: string | null; fingerprintAliases?: readonly string[] }, recorded: string | null | undefined): boolean {
  if (env.fingerprint === null) return true;
  return recorded === env.fingerprint || (recorded != null && (env.fingerprintAliases ?? []).includes(recorded));
}
