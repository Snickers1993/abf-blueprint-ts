import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AbfcError, envError } from "@abfc/env";
import type { Environment } from "@abfc/env";
import type { BackendInfo } from "@abfc/ir";
import { capabilitiesFrom } from "./capabilities.js";
import type { RawBackendInfo } from "./capabilities.js";
import { McpStdioClient, spawnBackendServer } from "./mcp.js";
import type { PublishGrant } from "./safety.js";
import type {
  AssetSnapshot,
  AssetOp,
  AssetOpsResult,
  AuditReport,
  Backend,
  BpApplyResult,
  CatalogResult,
  CompileMessage,
  CompileReport,
  GameTestReport,
  PublishResult,
  ReflectData,
  ReflectRequest,
  ReflectResult,
  StageReport,
  StageStatus,
} from "./types.js";

type Json = Record<string, unknown>;

/** Tools abfc cannot work without (`backend_info` and the extensions are optional). */
export const CORE_TOOLS = [
  "staging_sync",
  "staging_status",
  "bp_apply",
  "bp_read",
  "bp_compile_report",
  "bp_game_test",
] as const;

const NOT_STAGED = /not staged|staging_sync|no staged/i;
const MEMSWAP_REFUSAL = /offset|Nodes array not found/;

export interface BpApplyBackendOptions {
  /** Folder of the abf-mod-editor-mcp checkout (named in ABFC4001). */
  serverDir?: string;
  now?: () => Date;
  /** The server was started with ABF_WARM_SESSION=1: start the warm session lazily before the first commandlet operation. */
  warm?: boolean;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];
}

/** Maps the raw `bp_publish` JSON (a success, "Nothing to publish", or a refusal with its extras) to a {@link PublishResult}. */
export function publishResultFrom(json: Record<string, unknown>): PublishResult {
  const published = strList(json.published);
  const deleted = strList(json.deleted);
  const refused = str(json.refused);
  const message = str(json.message) ?? str(json.error) ?? "";
  const compileErrors = (Array.isArray(json.compile_errors) ? json.compile_errors : []).map((item: unknown) => {
    const o = isObject(item) ? item : {};
    return { asset: str(o.asset), message: str(o.message) ?? JSON.stringify(item) };
  });
  const conflicts = (Array.isArray(json.conflicts) ? json.conflicts : []).map((item: unknown) => {
    if (typeof item === "string") return item;
    const o = isObject(item) ? item : {};
    return `${str(o.path) ?? JSON.stringify(item)}: ${str(o.reason) ?? "changed"}`;
  });
  return {
    // A publish that only deleted files (a renamed or removed class) copies nothing: `published` is empty but `deleted` is not.
    ok: refused === null && (published.length > 0 || deleted.length > 0 || message.startsWith("Nothing to publish")),
    published,
    refused,
    message,
    deleted,
    backup: str(json.backup),
    route: str(json.route),
    compileErrors,
    conflicts,
    restored: typeof json.restored === "boolean" ? json.restored : null,
    editor: str(json.editor),
    editorReason: isObject(json.editor_result) ? str(json.editor_result.reason) : null,
    reloadedInPlace: strList(json.reloaded_in_place),
    dirtyAfter: strList(json.dirty_after),
    reloadedReferencers: strList(json.reloaded_referencers),
    skippedDirty: strList(json.skipped_dirty),
    dirtyPublished: strList(json.dirty_published),
    compileErrorsAfter: (Array.isArray(json.compile_errors_after) ? json.compile_errors_after : []).map((item: unknown) => {
      const o = isObject(item) ? item : {};
      return { asset: str(o.asset), message: str(o.message) ?? JSON.stringify(item) };
    }),
    tagsRegistered: strList(json.tags_registered),
    tagsUnregistered: strList(json.tags_unregistered),
    tagsStrategy: str(json.tags_strategy),
    tagsError: str(json.tags_error),
    raw: json,
  };
}

function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function compileMessage(e: unknown): CompileMessage {
  const o = isObject(e) ? e : {};
  const m: CompileMessage = { asset: str(o.asset), message: str(o.message) ?? "" };
  const node = str(o.node);
  const graph = str(o.graph);
  if (node !== null) m.node = node;
  if (graph !== null) m.graph = graph;
  return m;
}

function compileList(v: unknown): CompileMessage[] {
  return Array.isArray(v) ? v.map(compileMessage) : [];
}

/** The top-level `rows` of a `bp_apply` result (class-manager rows, backend 2.5.0): `[{ asset, created, changed }]`; entries without an asset are dropped. */
function rowList(v: unknown): BpApplyResult["rows"] {
  if (!Array.isArray(v)) return [];
  const out: BpApplyResult["rows"] = [];
  for (const r of v) {
    if (!isObject(r)) continue;
    const asset = str(r.asset);
    if (asset === null || asset === "") continue;
    const row: BpApplyResult["rows"][number] = { asset, created: r.created === true, changed: r.changed === true };
    const tag = str(r.tag);
    if (tag !== null) row.tag = tag;
    out.push(row);
  }
  return out;
}

/**
 * Seconds the hidden mod audit may run. It reads every asset of the staged mod: 420 s was too short for a mod of about 900
 * assets (killed after 7 minutes, no verdict). `ABFC_AUDIT_TIMEOUT_SECONDS` overrides the default of 1800.
 */
export function auditTimeoutSeconds(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env["ABFC_AUDIT_TIMEOUT_SECONDS"]);
  return Number.isFinite(v) && v >= 60 ? Math.round(v) : 1800;
}

export class BpApplyBackend implements Backend {
  private readonly client: McpStdioClient;
  private readonly serverDir: string;
  private readonly now: () => Date;
  private readonly warmWanted: boolean;
  private warmAvailable = false;
  private warmStarted = false;
  private warmFailed = false;
  /** True when the most recent commandlet operation ran on the warm session. */
  lastWarm = false;

  constructor(client: McpStdioClient, o: BpApplyBackendOptions = {}) {
    this.warmWanted = o.warm === true;
    this.client = client;
    this.serverDir = o.serverDir ?? "<unknown>";
    this.now = o.now ?? ((): Date => new Date());
  }

  async info(): Promise<BackendInfo> {
    const tools = await this.client.listTools();
    const missing = CORE_TOOLS.filter((t) => !tools.includes(t));
    let raw: RawBackendInfo | null = null;
    if (tools.includes("backend_info")) {
      const r = await this.call("backend_info", {});
      raw = r.json as RawBackendInfo;
    }
    if (missing.length > 0) {
      throw new AbfcError({
        severity: "error",
        code: "ABFC4001",
        message: `abf-mod-editor-mcp at ${this.serverDir} lacks the tools abfc needs: ${missing.join(", ")}. abfc needs protocol >= 1.`,
        tried: [{ source: "tools/list", detail: tools.join(", ") }],
        fix: "update the backend checkout (see docs/backend.md).",
      });
    }
    let ext: { features?: string[] } | null = null;
    let extServerVersion: string | null = null;
    if (tools.includes("abfc_extensions")) {
      const r = await this.call("abfc_extensions", {});
      ext = { features: strList(r.json.features) };
      extServerVersion = str(r.json.serverVersion);
    }
    const capabilities = capabilitiesFrom(tools, raw, ext);
    this.warmAvailable = capabilities.warmSession;
    const headlessDir = str(raw?.headlessDir);
    return {
      id: "bp_apply",
      serverVersion: str(raw?.serverVersion) ?? extServerVersion ?? "unknown",
      protocol: raw === null ? null : typeof raw.protocol === "number" ? raw.protocol : null,
      engineVersion: str(raw?.engineVersion),
      editorRoot: str(raw?.editorRoot),
      headlessDir,
      documentsDir: str(raw?.documentsDir),
      headlessDirHasSpace: headlessDir?.includes(" ") ?? false,
      extensions: ext?.features ?? [],
      capabilities,
    };
  }

  async stage(modDir: string, o: { discardChanges: boolean }): Promise<StageReport> {
    const { json } = await this.call("staging_sync", { mod_dir: modDir, discard_changes: o.discardChanges });
    this.warmStarted = false; // staging_sync stops the warm session; the next commandlet operation starts a new one
    return {
      mod: str(json.mod) ?? "",
      files: num(json.files),
      stagingPath: str(json.staging_path) ?? "",
    };
  }

  async stageStatus(mod: string): Promise<StageStatus | null> {
    let json: Json;
    try {
      json = (await this.call("staging_status", { mod })).json;
    } catch (e) {
      if (e instanceof AbfcError && e.diagnostic.code === "ABFC4002" && NOT_STAGED.test(e.diagnostic.message)) return null;
      throw e;
    }
    return {
      mod: str(json.mod) ?? mod,
      stagingPath: str(json.staging_path) ?? "",
      syncedAt: str(json.synced_at),
      changed: strList(json.changed),
      added: strList(json.added),
      removed: strList(json.removed),
      // The backend lists a conflict as {path, reason}: the messages (ABFC4017) name the file only.
      conflicts: (Array.isArray(json.conflicts) ? json.conflicts : []).map((c: unknown) => (typeof c === "string" ? c : isObject(c) && str(c.path) !== null ? str(c.path)! : JSON.stringify(c))),
      stale: strList(json.stale),
    };
  }

  async read(mod: string, asset: string): Promise<AssetSnapshot> {
    await this.ensureWarm(mod);
    const { json } = await this.call("bp_read", { mod, asset_path: asset, include_pins: false, timeout_seconds: 300 });
    const run = str(json.run) ?? "";
    this.lastWarm = json.warm === true;
    return {
      asset,
      run,
      exportPath: join(run, "export.t3d"),
      structure: json,
      seconds: typeof json.seconds === "number" ? json.seconds : null,
      warm: this.lastWarm,
    };
  }

  async applySpecs(
    mod: string,
    specs: unknown[],
    o: { label: string; cacheDir: string; keepOnError?: boolean },
  ): Promise<BpApplyResult> {
    mkdirSync(o.cacheDir, { recursive: true });
    const safeLabel = o.label.replace(/[^A-Za-z0-9_.-]+/g, "_");
    const specFile = join(o.cacheDir, `apply-${stamp(this.now())}-${safeLabel}.json`);
    writeFileSync(specFile, JSON.stringify(specs, null, 2), "utf8");
    await this.ensureWarm(mod);
    const { json } = await this.call(
      "bp_apply",
      { mod, spec_file: specFile, timeout_seconds: 600, keep_on_error: o.keepOnError === true },
      { tolerate: (j) => typeof j.ok === "boolean" },
    );
    const compile = isObject(json.compile) ? json.compile : {};
    this.lastWarm = json.warm === true;
    const result: BpApplyResult = {
      warm: this.lastWarm,
      ok: json.ok === true,
      rolledBack: json.rolled_back === true,
      run: str(json.run) ?? "",
      seconds: num(json.seconds),
      assets: Array.isArray(json.assets)
        ? json.assets.map((a) => {
            const ao = isObject(a) ? a : {};
            const entry: NonNullable<BpApplyResult["assets"]>[number] = {
              asset: str(ao.asset) ?? "",
              node_ids: isObject(ao.node_ids) ? (ao.node_ids as Record<string, Record<string, string>>) : {},
            };
            const final = str(ao.final);
            if (final !== null) entry.final = final;
            return entry;
          })
        : null,
      compile: { errors: compileList(compile.errors), warnings: compileList(compile.warnings) },
      rows: rowList(json.rows),
    };
    const tagsAdded = strList(json.tags_added);
    if (tagsAdded.length > 0) result.tagsAdded = tagsAdded;
    let error = str(json.error);
    if (error === "invalid spec" && Array.isArray(json.problems) && json.problems.length > 0) {
      error = `invalid spec: ${JSON.stringify(json.problems)}`;
    }
    if (error !== null) result.error = error;
    const logTail = str(json.log_tail);
    if (logTail !== null) result.logTail = logTail;
    if (!result.ok && error !== null && MEMSWAP_REFUSAL.test(error)) {
      throw new AbfcError({
        severity: "error",
        code: "ABFC4100",
        message: `the backend refused the in-memory write of this asset graph: ${error} (run folder: ${result.run})`,
        fix: "this graph shape is not supported by the memory-swap writer yet; report it with the run folder.",
      });
    }
    return result;
  }

  async compile(mod: string, assets: string[]): Promise<CompileReport> {
    await this.ensureWarm(mod);
    const { json } = await this.call("bp_compile_report", { mod, asset_paths: assets, timeout_seconds: 600 });
    this.lastWarm = json.warm === true;
    const messages: CompileReport["messages"] = [];
    if (Array.isArray(json.messages)) {
      for (const m of json.messages) {
        const o = isObject(m) ? m : {};
        messages.push({ ...compileMessage(o), severity: o.severity === "warning" ? "warning" : "error" });
      }
    }
    return { clean: json.clean === true, messages, run: str(json.run) ?? "", seconds: num(json.seconds), warm: this.lastWarm };
  }

  async reflect(r: ReflectRequest): Promise<ReflectResult> {
    await this.ensureWarm(r.mod);
    const { json } = await this.call(
      "reflect",
      {
        mod: r.mod,
        classes: r.classes,
        structs: r.structs,
        cast_targets: r.castTargets,
        ...(r.gameplayTags === true ? { gameplay_tags: true } : {}),
        ...(r.supersOf !== undefined && r.supersOf.length > 0 ? { supers_of: r.supersOf } : {}),
        timeout_seconds: 900,
      },
      { timeoutMs: 960_000 },
    );
    this.lastWarm = json.warm === true;
    const file = str(json.file);
    if (file === null) {
      throw new AbfcError({
        severity: "error",
        code: "ABFC4002",
        message: `backend tool "reflect" returned no result file (run folder: ${str(json.run) ?? "unknown"}).`,
      });
    }
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Partial<ReflectData> & { gameplayTags?: unknown; supers?: unknown; memberSources?: unknown };
    const data: ReflectData = {
      engineVersion: parsed.engineVersion ?? null,
      classes: parsed.classes ?? {},
      structs: parsed.structs ?? {},
      errors: parsed.errors ?? [],
    };
    if (isObject(parsed.gameplayTags)) {
      data.gameplayTags = {
        tags: strList(parsed.gameplayTags.tags),
        sources: isObject(parsed.gameplayTags.sources) ? parsed.gameplayTags.sources : {},
      };
    }
    if (isObject(parsed.supers)) {
      data.supers = {};
      for (const [p, chain] of Object.entries(parsed.supers)) {
        if (Array.isArray(chain) && chain.every((x) => typeof x === "string")) data.supers[p] = chain as string[];
      }
    }
    if (Array.isArray(parsed.memberSources)) data.memberSources = parsed.memberSources.filter((x): x is string => typeof x === "string");
    const filter = isObject(json.filter) ? json.filter : {};
    const rules: Array<["Allow" | "Block", string]> = [];
    if (Array.isArray(filter.rules)) {
      for (const rule of filter.rules) {
        if (Array.isArray(rule) && typeof rule[1] === "string") rules.push([rule[0] === "Block" ? "Block" : "Allow", rule[1]]);
      }
    }
    return {
      run: str(json.run) ?? "",
      seconds: num(json.seconds),
      file,
      data,
      filter: { contentVersion: str(filter.content_version), rules },
    };
  }

  async catalog(mod: string): Promise<CatalogResult> {
    await this.ensureWarm(mod);
    const { json } = await this.call("catalog", { mod, timeout_seconds: 300 }, { timeoutMs: 360_000 });
    this.lastWarm = json.warm === true;
    const file = str(json.file);
    if (file === null) {
      throw new AbfcError({
        severity: "error",
        code: "ABFC4002",
        message: `backend tool "catalog" returned no result file (run folder: ${str(json.run) ?? "unknown"}).`,
      });
    }
    const data: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    return { run: str(json.run) ?? "", seconds: num(json.seconds), file, data, warm: this.lastWarm };
  }

  async gameTest(mod: string, steps: unknown[], o: { timeoutSeconds: number; map?: string }): Promise<GameTestReport> {
    this.warmStarted = false; // the game test runs cold and stops a running warm session first
    this.lastWarm = false;
    const { json } = await this.call(
      "bp_game_test",
      o.map === undefined ? { mod, steps, timeout_seconds: o.timeoutSeconds } : { mod, steps, timeout_seconds: o.timeoutSeconds, map: o.map },
      { tolerate: (j) => Array.isArray(j.steps) },
    );
    const stepList = Array.isArray(json.steps) ? json.steps : [];
    const report: GameTestReport = {
      ok: json.ok === true,
      steps: stepList.map((s, idx) => {
        const so = isObject(s) ? s : {};
        const step: GameTestReport["steps"][number] = {
          i: typeof so.i === "number" ? so.i : idx,
          op: str(so.op) ?? "",
          ok: so.ok === true,
          value: so.value,
        };
        const err = str(so.error);
        if (err !== null) step.error = err;
        return step;
      }),
      passed: num(json.passed),
      failed: num(json.failed),
      complete: json.complete === true,
      runtimeLog: Array.isArray(json.runtime_log)
        ? json.runtime_log.map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
        : [],
      run: str(json.run) ?? "",
      seconds: num(json.seconds),
      timedOut: json.timed_out === true,
    };
    const error = str(json.error);
    if (error !== null) report.error = error;
    return report;
  }

  async audit(mod: string): Promise<AuditReport> {
    this.warmStarted = false; // the audit runs cold and stops a running warm session first
    this.lastWarm = false;
    const { json } = await this.call(
      "mod_audit",
      { mod, timeout_seconds: auditTimeoutSeconds() },
      { tolerate: (j) => typeof j.ok === "boolean" },
    );
    return { ok: json.ok === true, raw: json, seconds: num(json.seconds) };
  }

  async assetOps(mod: string, ops: AssetOp[]): Promise<AssetOpsResult> {
    this.lastWarm = false; // asset ops run in the commandlet (and may stop a running warm session)
    this.warmStarted = false;
    const { json } = await this.call(
      "bp_asset_ops",
      { mod, ops, timeout_seconds: 600 },
      { timeoutMs: 720_000, tolerate: (j) => typeof j.ok === "boolean" },
    );
    const results = (Array.isArray(json.results) ? json.results : []).map((item: unknown) => {
      const o = isObject(item) ? item : {};
      const r: AssetOpsResult["results"][number] = { op: str(o.op) ?? "", ok: o.ok === true };
      const detail = str(o.detail) ?? str(o.error);
      if (detail !== null) r.detail = detail;
      return r;
    });
    let error = str(json.error);
    if (error === "invalid asset ops" && Array.isArray(json.problems) && json.problems.length > 0) {
      error = `invalid asset ops: ${json.problems.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("; ")}`;
    }
    const out: AssetOpsResult = { ok: json.ok === true, results, touched: strList(json.touched), error };
    if (typeof json.rolled_back === "boolean") out.rolledBack = json.rolled_back;
    const run = str(json.run);
    if (run !== null) out.run = run;
    return out;
  }

  async publish(mod: string, assets: string[], grant: PublishGrant, o?: { deleteRemoved?: boolean }): Promise<PublishResult> {
    // bp_publish's compile check runs on the warm session when one runs; the publish does not stop it, so close() still stops it
    this.lastWarm = false;
    const { json } = await this.call(
      "bp_publish",
      { mod, assets, ...(o?.deleteRemoved === true ? { delete_removed: true } : {}) },
      { timeoutMs: 900_000, publishGrant: grant, tolerate: (j) => Array.isArray(j.published) },
    );
    return publishResultFrom(json);
  }

  async close(): Promise<void> {
    if (this.warmStarted) {
      this.warmStarted = false;
      try {
        await this.call("warm_session", { action: "stop" });
      } catch {
        // the server stops its warm session when it exits anyway
      }
    }
    await this.client.close();
  }

  // ------------------------------------------------------------ internals

  /** Starts the warm session before the first commandlet operation (once; a failed start means every operation runs cold). */
  private async ensureWarm(mod: string): Promise<void> {
    if (!this.warmWanted || !this.warmAvailable || this.warmStarted || this.warmFailed) return;
    try {
      await this.call("warm_session", { action: "start", mod }, { timeoutMs: 300_000 });
      this.warmStarted = true;
    } catch {
      this.warmFailed = true;
    }
  }

  /**
   * Calls one tool and returns its JSON object. A tool-level error becomes ABFC4002 (or ABFC4100 for memory-swap refusals)
   * unless `tolerate` accepts the JSON (tools whose failure is a normal result: bp_apply, bp_game_test, mod_audit).
   */
  private async call(
    tool: string,
    args: Record<string, unknown>,
    o?: { timeoutMs?: number; tolerate?: (j: Json) => boolean; publishGrant?: PublishGrant },
  ): Promise<{ json: Json; text: string; wallSeconds: number }> {
    const callOpts: { timeoutMs?: number; publishGrant?: PublishGrant } = {};
    if (o?.timeoutMs !== undefined) callOpts.timeoutMs = o.timeoutMs;
    if (o?.publishGrant !== undefined) callOpts.publishGrant = o.publishGrant;
    const res = await this.client.callTool(tool, args, callOpts);
    const json = isObject(res.json) ? res.json : null;
    if (res.isError && !(json !== null && o?.tolerate?.(json) === true)) {
      const message = (json !== null ? str(json.error) : null) ?? res.text.trim().split(/\r?\n/).slice(-3).join(" | ");
      const run = json !== null ? str(json.run) : null;
      if (tool === "bp_apply" && MEMSWAP_REFUSAL.test(message)) {
        throw new AbfcError({
          severity: "error",
          code: "ABFC4100",
          message: `the backend refused the in-memory write of this asset graph: ${message}${run ? ` (run folder: ${run})` : ""}`,
          fix: "this graph shape is not supported by the memory-swap writer yet; report it with the run folder.",
        });
      }
      throw new AbfcError({
        severity: "error",
        code: "ABFC4002",
        message: `backend tool "${tool}" failed: ${message}${run ? ` (run folder: ${run})` : ""}`,
      });
    }
    if (json === null) {
      throw new AbfcError({
        severity: "error",
        code: "ABFC4002",
        message: `backend tool "${tool}" returned no JSON object: ${res.text.slice(0, 200)}`,
      });
    }
    return { json, text: res.text, wallSeconds: res.wallSeconds };
  }
}

/** Spawns the backend server for `env` and wraps it. Needs python, backend dir and headless dir to be resolved. */
export async function startBackend(
  env: Environment,
  o?: { cold?: boolean | undefined; onStderr?: ((line: string) => void) | undefined },
): Promise<BpApplyBackend> {
  const python = env.python.value;
  const backendDir = env.backendDir.value;
  const headlessDir = env.headlessDir.value;
  if (python === null || backendDir === null || headlessDir === null) {
    const what = python === null ? "Python" : backendDir === null ? "the backend folder" : "the headless folder";
    throw envError(
      4002,
      `cannot start the backend: ${what} is not resolved.`,
      [],
      "run abfc doctor and fix the errors it lists first.",
    );
  }
  const warm = o?.cold !== true;
  const client = await spawnBackendServer(
    { python, backendDir, headlessDir, editorRoot: env.editorRoot.value, warm },
    o?.onStderr !== undefined ? { onStderr: o.onStderr } : undefined,
  );
  return new BpApplyBackend(client, { serverDir: backendDir, warm });
}
