import { AbfcError } from "@abfc/env";

/**
 * The backend tools abfc calls freely. Anything else is refused before a message is sent;
 * `bp_publish` is sent only with a {@link PublishGrant} (see {@link grantPublish}).
 */
export const ALLOWED_TOOLS = [
  "backend_info",
  "abfc_extensions",
  "reflect",
  "catalog",
  "warm_session",
  "staging_sync",
  "staging_status",
  "staging_refresh",
  "bp_apply",
  "bp_asset_ops",
  "bp_read",
  "bp_compile_report",
  "bp_game_test",
  "mod_audit",
] as const;

export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export function isAllowedTool(name: string): name is AllowedTool {
  return (ALLOWED_TOOLS as readonly string[]).includes(name);
}

/** Permission to send `bp_publish` for exactly one mod. Only {@link grantPublish} can mint one (membership in a private set, not shape, is the check). */
export interface PublishGrant {
  readonly mod: string;
}

const grants = new WeakSet<PublishGrant>();

/**
 * Mints a {@link PublishGrant} for `mod`. Every other tool abfc calls writes only the staged copy, and
 * `bp_publish` is the one tool that writes a mod folder. Keeping it off {@link ALLOWED_TOOLS} and binding it
 * to one mod means no other command path (build, test, adopt, or a bug in them) can write a mod folder,
 * and a grant cannot be used for another mod. Called only by `abfc publish`, with the project's `mod.name`.
 */
export function grantPublish(mod: string): PublishGrant {
  const grant: PublishGrant = Object.freeze({ mod });
  grants.add(grant);
  return grant;
}

/**
 * Throws ABFC4090 (exit 3) for a tool outside {@link ALLOWED_TOOLS}.
 * `bp_publish` passes only with a grant minted by {@link grantPublish} and `args.mod` equal to the grant's mod.
 */
export function assertToolAllowed(name: string, o?: { grant?: PublishGrant; args?: Record<string, unknown> }): void {
  if (isAllowedTool(name)) return;
  if (
    name === "bp_publish" &&
    o?.grant !== undefined &&
    grants.has(o.grant) &&
    o.args?.mod === o.grant.mod
  ) {
    return;
  }
  const message =
    name === "bp_publish"
      ? "abfc sends bp_publish only from abfc publish, for the project's own mod."
      : `the backend tool "${name}" is not on abfc's allowlist and was not called.`;
  throw new AbfcError(
    {
      severity: "error",
      code: "ABFC4090",
      message,
      tried: [{ source: "allowlist", detail: ALLOWED_TOOLS.join(", ") }],
      fix: name === "bp_publish" ? "run abfc publish." : "use one of the allowed tools.",
    },
    3,
  );
}
