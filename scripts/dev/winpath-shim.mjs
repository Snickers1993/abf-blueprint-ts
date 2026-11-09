// Dev only: runs the Windows-path CLI tests on Linux. node --import ./scripts/dev/winpath-shim.mjs --test "packages/cli/dist/test/*.test.js"
// Maps win32-joined posix paths ("\\home\\user\\x") to posix before fs and path.posix calls. Not part of abfc.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const fix = (p) => (typeof p === "string" && p.startsWith("\\") ? p.replace(/\\/g, "/") : typeof p === "string" && /^\/[^\\]*\\/.test(p) ? p.replace(/\\/g, "/") : p);
const wrap = (obj) => {
  for (const k of Object.keys(obj)) {
    const f = obj[k];
    if (typeof f !== "function" || /^[A-Z]/.test(k)) continue;
    obj[k] = function (...a) { if (a.length > 0) a[0] = fix(a[0]); if (["renameSync","rename","copyFileSync","copyFile","cpSync","cp","symlinkSync","linkSync"].includes(k) && a.length > 1) a[1] = fix(a[1]); return f.apply(this, a); };
  }
};
wrap(fs); wrap(fsp);
syncBuiltinESMExports();
import path from "node:path";
const P = path.posix;
const bs = (x) => (typeof x === "string" && /^\\(?!\\)/.test(x) ? x.replace(/\\/g, "/") : x);
for (const k of ["join", "normalize", "resolve", "dirname", "basename", "extname", "relative", "isAbsolute", "parse"]) {
  const orig = P[k];
  P[k] = function (...a) { return orig.apply(P, a.map(bs)); };
}
syncBuiltinESMExports();
