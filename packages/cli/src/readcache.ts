// .abfc/cache/reads: the T3D export of each owned asset as `bp_read` last returned it, keyed by the bytes of the asset's files in the
// stage and of the mod packages the export references. A build after a re-sync (the Mod Editor saved any file of the mod, or a
// failed compile) reads every owned asset; with this cache only the assets whose files (or referenced files) differ go to the editor.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Bump when what a cached read means changes (the key or the stored text). */
export const READ_CACHE_VERSION = 1;
/** Entries kept per asset: the current file and a few earlier ones (a failed compile puts the stage back to an earlier file). */
const MAX_PER_ASSET = 4;

interface Entry {
  /** Hash of the backend, editor and stub identity the read was made with. */
  identity: string;
  /** Hash of the asset's own files in the stage (`<name>.uasset`, `.uexp`, `.ubulk`, ...). */
  files: string;
  /** Mod packages the export references -> hash of their files when read ("none" for a package the stage does not hold). */
  deps: Record<string, string>;
  /** sha256 of the export text (the file `<text>.t3d`). */
  text: string;
}

interface Index {
  version: number;
  assets: Record<string, Entry[]>;
}

export interface ReadCacheStats {
  hits: number;
  misses: number;
}

/** A key computed before the read: the read is stored under it, so a file that changed during the read never matches later. */
export interface ReadKey {
  asset: string;
  files: string;
}

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mod package paths an export names (`/<Mod>/Dir/Name`, as first spelled; one entry per path ignoring case), without `self`. */
export function referencedPackages(text: string, mod: string, self: string): string[] {
  const re = new RegExp(`/${escapeRe(mod)}/[A-Za-z0-9_\\-/]+`, "gi");
  const out = new Map<string, string>();
  const me = self.toLowerCase();
  for (const m of text.matchAll(re)) {
    const p = m[0].replace(/\/+$/, "");
    const k = p.toLowerCase();
    if (k !== me && p.split("/").length > 2 && !out.has(k)) out.set(k, p);
  }
  return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
}

export class ReadCache {
  readonly stats: ReadCacheStats = { hits: 0, misses: 0 };
  private readonly dir: string;
  private readonly indexFile: string;
  private index: Index;
  private readonly prefix: string;
  /** Dependency file hashes by `path|size|mtime` (an own file is always hashed in full). */
  private readonly depMemo = new Map<string, string>();

  constructor(
    cacheDir: string,
    private readonly stagingPath: string,
    private readonly mod: string,
    private readonly identity: string,
  ) {
    this.dir = join(cacheDir, "reads");
    this.indexFile = join(this.dir, "index.json");
    this.prefix = `/${mod}/`.toLowerCase();
    this.index = this.load();
  }

  private load(): Index {
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, "utf8")) as Index;
      if (parsed.version === READ_CACHE_VERSION && typeof parsed.assets === "object" && parsed.assets !== null) return parsed;
    } catch {
      // missing or damaged: an empty cache
    }
    return { version: READ_CACHE_VERSION, assets: {} };
  }

  /** The files of one package in the stage, sorted: every `Content/<path>.*` whose name matches (case-insensitive, like Unreal). */
  private packageFiles(pkg: string): string[] {
    if (this.stagingPath === "" || !pkg.toLowerCase().startsWith(this.prefix)) return [];
    const parts = pkg.slice(this.prefix.length).split("/");
    const name = parts.pop()!.toLowerCase();
    const folder = join(this.stagingPath, "Content", ...parts);
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return [];
    }
    return names
      .filter((f) => {
        const dot = f.lastIndexOf(".");
        return dot > 0 && f.slice(0, dot).toLowerCase() === name;
      })
      .sort()
      .map((f) => join(folder, f));
  }

  /** Hash of a package's files ("none" when the stage holds none); `memo` uses size and mtime for files read before. */
  private hashPackage(pkg: string, memo: boolean): string {
    const files = this.packageFiles(pkg);
    if (files.length === 0) return "none";
    const h = createHash("sha256");
    for (const f of files) {
      let fileHash: string;
      const st = statSync(f);
      const mk = `${f}|${st.size}|${st.mtimeMs}`;
      const known = memo ? this.depMemo.get(mk) : undefined;
      if (known !== undefined) fileHash = known;
      else {
        fileHash = sha(readFileSync(f));
        this.depMemo.set(mk, fileHash);
      }
      h.update(`${f.slice(f.lastIndexOf(".")).toLowerCase()}:${fileHash}\n`);
    }
    return h.digest("hex");
  }

  /** The key of an asset as its files stand now, or null when the stage holds no file for it (never cached). */
  key(asset: string): ReadKey | null {
    try {
      const files = this.hashPackage(asset, false);
      return files === "none" ? null : { asset, files };
    } catch {
      return null;
    }
  }

  /** The cached export of an asset whose own files and referenced packages are unchanged since it was read, else null. */
  get(key: ReadKey): string | null {
    const entries = this.index.assets[key.asset.toLowerCase()] ?? [];
    for (const e of entries) {
      if (e.identity !== this.identity || e.files !== key.files) continue;
      let same = true;
      try {
        for (const [pkg, h] of Object.entries(e.deps)) {
          if (this.hashPackage(pkg, true) !== h) {
            same = false;
            break;
          }
        }
      } catch {
        same = false;
      }
      if (!same) continue;
      const file = join(this.dir, `${e.text}.t3d`);
      try {
        const text = readFileSync(file, "utf8");
        if (sha(text) !== e.text) continue;
        this.stats.hits++;
        return text;
      } catch {
        continue;
      }
    }
    this.stats.misses++;
    return null;
  }

  /** Records a read made under `key`. Best effort: a write failure only means the next build reads again. */
  put(key: ReadKey, text: string): void {
    try {
      const deps: Record<string, string> = {};
      for (const pkg of referencedPackages(text, this.mod, key.asset)) deps[pkg] = this.hashPackage(pkg, true);
      const textHash = sha(text);
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${textHash}.t3d`);
      if (!existsSync(file)) writeFileSync(file, text, "utf8");
      const id = key.asset.toLowerCase();
      const entry: Entry = { identity: this.identity, files: key.files, deps, text: textHash };
      const rest = (this.index.assets[id] ?? []).filter((e) => !(e.identity === entry.identity && e.files === entry.files));
      this.index.assets[id] = [entry, ...rest].slice(0, MAX_PER_ASSET);
      this.save();
    } catch {
      // the cache is an optimisation only
    }
  }

  private save(): void {
    const tmp = `${this.indexFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.index), "utf8");
    renameSync(tmp, this.indexFile);
    // Text files no entry names any more are removed.
    const live = new Set(Object.values(this.index.assets).flatMap((es) => es.map((e) => `${e.text}.t3d`)));
    for (const f of readdirSync(this.dir)) if (f.endsWith(".t3d") && !live.has(f)) rmSync(join(this.dir, f), { force: true });
  }
}

/** The identity a cached read is valid for: the cache format, the backend (version and features) and the stub lock. */
export function readCacheIdentity(parts: unknown): string {
  return sha(JSON.stringify({ v: READ_CACHE_VERSION, parts }));
}
